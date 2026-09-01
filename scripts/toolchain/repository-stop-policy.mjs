import ts from "typescript";

const infrastructureFiles = new Set(["pulumi.yaml", "serverless.yml", "serverless.yaml", "terraform.tfstate"]);
const credentialDirectories = new Set([".aws", ".azure", ".config/gcloud", "credentials", "secrets"]);
const generatedInfrastructureDirectories = new Set([
  "archive", "artifact", "artifacts", "build", "deploy", "deployment", "dist", "output", "outputs", "release",
]);
const infrastructurePackagePattern = /^(?:aws-cdk-lib|@aws-cdk\/|@cdktf\/|cdktf$|@pulumi\/|pulumi$|serverless$)/u;
const infrastructureModulePattern = /^(?:aws-cdk-lib(?:\/|$)|@aws-cdk\/|@cdktf\/|cdktf(?:\/|$)|@pulumi\/|pulumi(?:\/|$))/u;
const credentialKeyPattern = /^(?:access[_-]?token|api[_-]?key|auth(?:orization)?[_-]?token|authorization|client[_-]?secret|github[_-]?token|id[_-]?token|npm[_-]?token|password|private[_-]?key|refresh[_-]?token|secret[_-]?token|session[_-]?token|token)$/iu;

function contentText(content) {
  if (content === undefined) return "";
  return typeof content === "string" ? content : Buffer.from(content).toString("utf8");
}

function parsedJson(name, text) {
  if (!name.endsWith(".json")) return undefined;
  try { return JSON.parse(text); }
  catch { return undefined; }
}

function jsonContains(value, predicate) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => jsonContains(entry, predicate));
  return Object.entries(value).some(([key, nested]) => predicate(key, nested) || jsonContains(nested, predicate));
}

function jsonContainsKubernetesResource(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(jsonContainsKubernetesResource);
  const entries = Object.entries(value);
  const apiVersion = entries.some(([key, nested]) => normalizedCredentialKey(key) === "apiversion" && typeof nested === "string");
  const kind = entries.some(([key, nested]) => normalizedCredentialKey(key) === "kind" && typeof nested === "string");
  return apiVersion && kind || entries.some(([, nested]) => jsonContainsKubernetesResource(nested));
}

function stripYamlBlockScalars(text) {
  const lines = text.split(/\r?\n/u);
  const kept = [];
  let payloadIndent;
  let scalarHeaderIndent;
  for (const rawLine of lines) {
    const indentation = /^\s*/u.exec(rawLine)[0].length;
    if (scalarHeaderIndent !== undefined) {
      if (/^\s*$/u.test(rawLine)) continue;
      if (payloadIndent === undefined && indentation > scalarHeaderIndent) payloadIndent = indentation;
      if (payloadIndent !== undefined && indentation >= payloadIndent) continue;
      payloadIndent = undefined;
      scalarHeaderIndent = undefined;
    }
    const header = /^\s*(?:-\s+)?(?:[^:#]+:\s*)?[|>]((?:[1-9][+-]?)|(?:[+-][1-9]?))?\s*(?:#.*)?$/u.exec(rawLine);
    if (header) {
      // Determine the effective scalar indentation from its first payload line;
      // this preserves later sequence/mapping siblings at their own indentation.
      scalarHeaderIndent = indentation;
      const explicitIndent = header[1]?.match(/[1-9]/u)?.[0];
      payloadIndent = explicitIndent ? indentation + Number(explicitIndent) : undefined;
      kept.push(rawLine);
      continue;
    }
    kept.push(rawLine);
  }
  return kept.join("\n");
}

function yamlContainsKubernetesResource(text) {
  return text.split(/^\s*(?:---|\.\.\.)\s*$/gmu).some((document) => {
    const sanitized = stripYamlBlockScalars(document);
    if (/^\s*-\s+[^:#]+:\s*[|>].*\n(?:(?!^\s*-\s).)*^\s+apiVersion\s*:\s*[^#\s].*\n(?:(?!^\s*-\s).)*^\s+kind\s*:\s*[^#\s].*$/msu.test(sanitized)) return true;
    const flowResource = yamlFlowCollections(sanitized).some(jsonContainsKubernetesResource);
    if (flowResource) return true;
    const containers = new Map();
    const sequences = new Map();
    const keysByScope = new Map();
    let nextScope = 0;
    let blockScalarIndent;
    for (const rawLine of sanitized.split(/\r?\n/u)) {
      const indentation = /^\s*/u.exec(rawLine)[0].length;
      if (blockScalarIndent !== undefined) {
        if (/^\s*$/u.test(rawLine) || indentation > blockScalarIndent) continue;
        blockScalarIndent = undefined;
      }
      if (/^\s*(?:#|$)/u.test(rawLine)) continue;
      if (/^\s*(?:-\s+)?(?:["'][^"']+["']|[^:#]+):\s*[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$/u.test(rawLine)) {
        blockScalarIndent = indentation;
        continue;
      }
      const sequence = /^\s*-\s+/u.test(rawLine);
      for (const level of [...containers.keys()]) if (indentation <= level) containers.delete(level);
      for (const level of [...sequences.keys()]) if (indentation < level || !sequence && indentation === level) sequences.delete(level);
      if (sequence) {
        for (const level of [...containers.keys()]) if (level >= indentation) containers.delete(level);
        for (const level of [...sequences.keys()]) if (level >= indentation) sequences.delete(level);
        sequences.set(indentation, nextScope += 1);
      }
      const entry = /^\s*(?:-\s+)?["']?(apiVersion|kind)["']?\s*:\s*([^#\s][^#]*?)\s*(?:#.*)?$/u.exec(rawLine);
      const effectiveIndentation = indentation + (sequence ? 2 : 0);
      const scope = [...containers.entries(), ...sequences.entries()]
        .filter(([level]) => level < effectiveIndentation)
        .sort(([left], [right]) => left - right)
        .map(([, id]) => id)
        .join("/");
      if (entry) {
        const key = `${scope}:${effectiveIndentation}`;
        const fields = keysByScope.get(key) ?? new Set();
        fields.add(entry[1]);
        keysByScope.set(key, fields);
        if (fields.has("apiVersion") && fields.has("kind")) return true;
      } else {
        const mapping = /^\s*(?:-\s+)?[^:#]+:\s*(?:#.*)?$/u.exec(rawLine);
        if (mapping) containers.set(effectiveIndentation, nextScope += 1);
      }
    }
    return false;
  });
}

function yamlFlowCollections(text) {
  if (text.length > 65536) return [];
  const tokens = [];
  for (let index = 0; index < text.length && tokens.length < 8192;) {
    const character = text[index];
    if (/\s/u.test(character)) { index += 1; continue; }
    if (character === "#") {
      index = text.indexOf("\n", index);
      if (index < 0) break;
      continue;
    }
    if ("{}[],:".includes(character)) { tokens.push(character); index += 1; continue; }
    if (character === '"' || character === "'") {
      const quote = character;
      let value = character;
      index += 1;
      let escaped = false;
      while (index < text.length) {
        const next = text[index++];
        value += next;
        if (escaped) { escaped = false; continue; }
        if (next === "\\") { escaped = true; continue; }
        if (next === quote) break;
      }
      tokens.push(value);
      continue;
    }
    let end = index;
    while (end < text.length && !/[\s{}[\],:#]/u.test(text[end])) end += 1;
    if (end === index) { index += 1; continue; }
    tokens.push(text.slice(index, end));
    index = end;
  }

  const parse = (start, depth = 0) => {
    if (depth > 32) return undefined;
    const opening = tokens[start];
    if (opening !== "{" && opening !== "[") return undefined;
    const result = opening === "{" ? {} : [];
    let cursor = start + 1;
    while (cursor < tokens.length) {
      if (tokens[cursor] === (opening === "{" ? "}" : "]")) return { value: result, next: cursor + 1 };
      if (opening === "{") {
        const rawKey = tokens[cursor++];
        if (!rawKey || "{}[],:".includes(rawKey) || tokens[cursor++] !== ":") return undefined;
        const nested = parse(cursor, depth + 1);
        const rawValue = nested ? nested.value : tokens[cursor];
        if (rawValue === undefined || rawValue === "," || rawValue === "}" || rawValue === "]") return undefined;
        cursor = nested ? nested.next : cursor + 1;
        const key = decodeQuotedText(rawKey) ?? rawKey;
        result[key] = nested ? rawValue : decodeQuotedText(rawValue) ?? rawValue;
      } else {
        const nested = parse(cursor, depth + 1);
        const rawValue = nested ? nested.value : tokens[cursor];
        if (rawValue === undefined || rawValue === "," || rawValue === "}" || rawValue === "]") return undefined;
        cursor = nested ? nested.next : cursor + 1;
        result.push(nested ? rawValue : decodeQuotedText(rawValue) ?? rawValue);
      }
      if (tokens[cursor] === ",") { cursor += 1; continue; }
      if (tokens[cursor] !== (opening === "{" ? "}" : "]")) return undefined;
    }
    return undefined;
  };

  const collections = [];
  for (let index = 0; index < tokens.length && collections.length < 256; index += 1) {
    if (tokens[index] !== "{" && tokens[index] !== "[") continue;
    const parsed = parse(index);
    if (parsed) collections.push(parsed.value);
  }
  return collections;
}

function normalizedCredentialKey(key) { return key.normalize("NFKC").toLowerCase().replace(/[\s_-]/gu, ""); }
function hasCredentialKey(key) {
  return credentialKeyPattern.test(key) || new Set([
    "accesstoken", "apikey", "authorization", "authorizationtoken", "clientsecret", "credential",
    "githubtoken", "idtoken", "npmtoken", "password", "privatekey", "refreshtoken", "secret",
    "secrettoken", "sessiontoken", "token",
  ]).has(normalizedCredentialKey(key));
}

function looksHardCodedSecret(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (/^(?:identifier|keyword|literal|number|string|token|unknown)$/iu.test(trimmed) ||
    /(?:example|placeholder|documentation|not-a-secret|replace-me)/iu.test(trimmed)) return false;
  if (/^(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})$/u.test(trimmed)) return true;
  if (/^Bearer\s+\S{12,}$/u.test(trimmed)) return true;
  return trimmed.length >= 16 && !/\s/u.test(trimmed) &&
    (/[A-Z]/u.test(trimmed) && /[a-z]/u.test(trimmed) && /\d/u.test(trimmed) ||
      /(?:secret|token|private|credential)/iu.test(trimmed));
}

function looksHardCodedSourceSecret(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (/^(?:identifier|keyword|literal|number|string|token|unknown)$/iu.test(trimmed) ||
    /(?:example|placeholder|documentation|not-a-secret|replace-me)/iu.test(trimmed)) return false;
  return /^(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})$/u.test(trimmed) ||
    /^Bearer\s+\S{12,}$/u.test(trimmed) ||
    trimmed.length >= 16 && !/\s/u.test(trimmed) && /[A-Z]/u.test(trimmed) && /[a-z]/u.test(trimmed) && /\d/u.test(trimmed);
}

function typescriptContainsCredential(text, filename) {
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/u.test(text)) return true;
  const kind = filename.endsWith(".tsx") || filename.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, false, kind);
  let found = false;
  const inspect = (node) => {
    if (found) return;
    let key;
    let expression;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      key = node.name.text;
      expression = node.initializer;
    } else if (ts.isPropertyAssignment(node)) {
      key = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : undefined;
      expression = node.initializer;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isIdentifier(node.left) || ts.isPropertyAccessExpression(node.left))) {
      key = ts.isIdentifier(node.left) ? node.left.text : node.left.name.text;
      expression = node.right;
    }
    if (key && hasCredentialKey(key) &&
      [...typescriptStrings(expression, new Map())].some(looksHardCodedSourceSecret)) found = true;
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return found;
}

function pythonContainsCredential(text) {
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/u.test(text)) return true;
  return text.split(/\r?\n/u).some((line) => {
    const assignment = /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*(?:#.*)?$/u.exec(line);
    if (!assignment || !hasCredentialKey(assignment[1])) return false;
    return [...pythonStrings(assignment[2], new Map())].some(looksHardCodedSourceSecret);
  });
}

function typescriptStrings(node, constants, depth = 0) {
  node = transparentTypeScriptExpression(node);
  if (!node || depth > 16) return new Set();
  if (ts.isStringLiteralLike(node)) return new Set([node.text]);
  if (ts.isIdentifier(node)) return new Set(constants.get(node.text) ?? []);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const values = new Set();
    for (const left of typescriptStrings(node.left, constants, depth + 1)) {
      for (const right of typescriptStrings(node.right, constants, depth + 1)) {
        if (values.size >= 32) return values;
        values.add(left + right);
      }
    }
    return values;
  }
  if (ts.isTemplateExpression(node)) {
    let values = new Set([node.head.text]);
    for (const span of node.templateSpans) {
      const next = new Set();
      for (const prefix of values) {
        for (const expression of typescriptStrings(span.expression, constants, depth + 1)) {
          if (next.size >= 32) break;
          next.add(prefix + expression + span.literal.text);
        }
      }
      values = next;
    }
    return values;
  }
  return new Set();
}

function mergeTypeScriptConstants(...environments) {
  const merged = new Map();
  for (const environment of environments) {
    for (const [name, values] of environment) {
      const combined = merged.get(name) ?? new Set();
      for (const value of values) combined.add(value);
      merged.set(name, combined);
    }
  }
  return merged;
}

function replaceTypeScriptConstants(target, source) {
  target.clear();
  for (const [name, values] of source) target.set(name, new Set(values));
}

function copyTypeScriptEnvironment(environment) {
  return { constants: mergeTypeScriptConstants(environment.constants), loaders: new Set(environment.loaders) };
}

function mergeTypeScriptEnvironments(...environments) {
  return {
    constants: mergeTypeScriptConstants(...environments.map(({ constants }) => constants)),
    loaders: new Set(environments.flatMap(({ loaders }) => [...loaders])),
  };
}

function replaceTypeScriptEnvironment(target, source) {
  replaceTypeScriptConstants(target.constants, source.constants);
  target.loaders.clear();
  for (const loader of source.loaders) target.loaders.add(loader);
}

function transparentTypeScriptExpression(node) {
  let current = node;
  while (current) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isCommaListExpression(current)) current = current.elements.at(-1);
    else if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) current = current.right;
    else break;
  }
  return current;
}

function typescriptDeclaresInfrastructure(text, filename) {
  const kind = filename.endsWith(".tsx") || filename.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const virtualFilename = kind === ts.ScriptKind.TSX ? "repository-stop-input.tsx" : "repository-stop-input.ts";
  const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  const source = ts.createSourceFile(virtualFilename, text, ts.ScriptTarget.Latest, true, kind);
  const isVirtualFile = (requested) => requested === virtualFilename || requested.endsWith(`/${virtualFilename}`);
  host.getSourceFile = (requested) => isVirtualFile(requested) ? source : undefined;
  host.fileExists = isVirtualFile;
  host.readFile = (requested) => isVirtualFile(requested) ? text : undefined;
  const program = ts.createProgram([virtualFilename], options, host);
  const checker = program.getTypeChecker();
  const rootEnvironment = { constants: new Map(), loaders: new Set() };
  let found = false;

  const assign = (environment, name, expression, operator = ts.SyntaxKind.EqualsToken) => {
    const values = typescriptStrings(expression, environment);
    if (operator === ts.SyntaxKind.PlusEqualsToken) {
      const current = environment.get(name) ?? new Set();
      const combined = new Set();
      for (const left of current) for (const right of values) combined.add(left + right);
      if (combined.size > 0) environment.set(name, combined);
      else environment.delete(name);
    } else if (values.size === 0) environment.delete(name);
    else environment.set(name, values);
  };

  const isUnshadowed = (node, name) => {
    if (!ts.isIdentifier(node) || node.text !== name) return false;
    const symbol = checker.getSymbolAtLocation(node);
    return !symbol || !symbol.declarations || symbol.declarations.length === 0;
  };
  const propertyName = (node, environment) => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) return [...typescriptStrings(node.argumentExpression, environment.constants)][0];
    return undefined;
  };
  const loaderReference = (node, environment) => {
    node = transparentTypeScriptExpression(node);
    return Boolean(node && ts.isIdentifier(node) && (environment.loaders.has(node.text) || isUnshadowed(node, "require")));
  };
  const isLoaderAlias = (node, environment) => {
    node = transparentTypeScriptExpression(node);
    if (!node) return false;
    if (loaderReference(node, environment)) return true;
    if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const bind = transparentTypeScriptExpression(node.expression);
      if ((ts.isPropertyAccessExpression(bind) || ts.isElementAccessExpression(bind)) && propertyName(bind, environment) === "bind" &&
        loaderReference(bind.expression, environment)) return true;
    }
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isFunctionDeclaration(node) || node.parameters.length !== 1 ||
      !ts.isIdentifier(node.parameters[0].name) || !node.body) return false;
    const parameter = node.parameters[0].name.text;
    const expression = transparentTypeScriptExpression(ts.isBlock(node.body) ?
      node.body.statements.find(ts.isReturnStatement)?.expression : node.body);
    const callee = expression && ts.isCallExpression(expression) ? transparentTypeScriptExpression(expression.expression) : undefined;
    const argument = expression && ts.isCallExpression(expression) ? transparentTypeScriptExpression(expression.arguments[0]) : undefined;
    return Boolean(expression && ts.isCallExpression(expression) && callee &&
      (callee.kind === ts.SyntaxKind.ImportKeyword || loaderReference(callee, environment)) &&
      argument && ts.isIdentifier(argument) && argument.text === parameter);
  };

  const loaderModuleArgument = (node, environment) => {
    const callee = transparentTypeScriptExpression(node.expression);
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return node.arguments[0];
    if (isLoaderAlias(callee, environment)) return node.arguments[0];
    if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      ts.isIdentifier(callee.expression) && callee.expression.text === "Reflect" &&
      propertyName(callee, environment) === "apply" && isUnshadowed(callee.expression, "Reflect") && isLoaderAlias(node.arguments[0], environment)) {
      const args = transparentTypeScriptExpression(node.arguments[2]);
      return args && ts.isArrayLiteralExpression(args) ? args.elements[0] : undefined;
    }
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return undefined;
    const method = propertyName(callee, environment);
    // A bound loader carries its pre-bound arguments into the eventual call.
    // Preserve the first bound module name instead of discarding it.
    if (method === "bind" && loaderReference(callee.expression, environment)) {
      return node.arguments[1] ?? undefined;
    }
    const memberLoader = method === "require" && ts.isIdentifier(callee.expression) && callee.expression.text === "module" &&
      isUnshadowed(callee.expression, "module");
    if (memberLoader) return node.arguments[0];
    if ((!memberLoader && !loaderReference(callee.expression, environment)) || !["call", "apply"].includes(method)) return undefined;
    if (method === "call") return node.arguments[1];
    const args = transparentTypeScriptExpression(node.arguments[1]);
    return args && ts.isArrayLiteralExpression(args) ? args.elements[0] : undefined;
  };

  const bindingNames = (name, names = new Set()) => {
    if (!name) return names;
    if (ts.isIdentifier(name)) names.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) bindingNames(element.name, names);
      }
    }
    return names;
  };

  const inspectBlock = (node, environment) => {
    const before = copyTypeScriptEnvironment(environment);
    const declared = new Set();
    for (const statement of node.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          bindingNames(declaration.name, declared);
        }
      } else if (ts.isFunctionDeclaration(statement) && statement.name) declared.add(statement.name.text);
      inspect(statement, environment);
    }
    for (const name of declared) {
      if (before.constants.has(name)) environment.constants.set(name, new Set(before.constants.get(name)));
      else environment.constants.delete(name);
      if (before.loaders.has(name)) environment.loaders.add(name);
      else environment.loaders.delete(name);
    }
  };

  const collectFunctionBindings = (node, bindings = new Set()) => {
    node.forEachChild((child) => {
      if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name)) bindings.add(child.name.text);
      else if (ts.isFunctionDeclaration(child) && child.name) bindings.add(child.name.text);
      else if (!ts.isFunctionLike(child)) collectFunctionBindings(child, bindings);
    });
    return bindings;
  };

  const inspect = (node, environment = rootEnvironment) => {
    if (found) return;
    if (ts.isImportDeclaration(node)) {
      if ([...typescriptStrings(node.moduleSpecifier, environment.constants)].some((value) => infrastructureModulePattern.test(value))) found = true;
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if ([...typescriptStrings(node.moduleSpecifier, environment.constants)].some((value) => infrastructureModulePattern.test(value))) found = true;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer) inspect(node.initializer, environment);
      assign(environment.constants, node.name.text, node.initializer, ts.SyntaxKind.EqualsToken);
      if (isLoaderAlias(node.initializer, environment)) environment.loaders.add(node.name.text);
      else environment.loaders.delete(node.name.text);
      return;
    } else if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) &&
      [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken].includes(node.operatorToken.kind)) {
      inspect(node.right, environment);
      assign(environment.constants, node.left.text, node.right, node.operatorToken.kind);
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (isLoaderAlias(node.right, environment)) environment.loaders.add(node.left.text);
        else environment.loaders.delete(node.left.text);
      }
      return;
    } else if (ts.isIfStatement(node)) {
      inspect(node.expression, environment);
      const before = copyTypeScriptEnvironment(environment);
      const whenTrue = copyTypeScriptEnvironment(before);
      const whenFalse = copyTypeScriptEnvironment(before);
      inspect(node.thenStatement, whenTrue);
      if (node.elseStatement) inspect(node.elseStatement, whenFalse);
      replaceTypeScriptEnvironment(environment, mergeTypeScriptEnvironments(whenTrue, whenFalse));
      return;
    } else if (ts.isBlock(node)) {
      inspectBlock(node, environment);
      return;
    } else if (ts.isCallExpression(node)) {
      const moduleArgument = loaderModuleArgument(node, environment);
      if ([...typescriptStrings(moduleArgument, environment.constants)].some((value) => infrastructureModulePattern.test(value))) found = true;
    } else if (ts.isFunctionLike(node)) {
      const localEnvironment = copyTypeScriptEnvironment(environment);
      for (const binding of collectFunctionBindings(node.body ?? node)) {
        localEnvironment.constants.delete(binding);
        localEnvironment.loaders.delete(binding);
      }
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) {
          localEnvironment.constants.delete(parameter.name.text);
          localEnvironment.loaders.delete(parameter.name.text);
        }
      }
      if (node.body) inspect(node.body, localEnvironment);
      if (ts.isFunctionDeclaration(node) && node.name) {
        if (isLoaderAlias(node, environment)) environment.loaders.add(node.name.text);
        else environment.loaders.delete(node.name.text);
      }
      return;
    }
    node.forEachChild((child) => inspect(child, environment));
  };
  inspect(source);
  return found;
}

function decodeQuotedText(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed); }
    catch { return undefined; }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/\\(['\\])/gu, "$1");
  }
  return undefined;
}

function pythonStrings(expression, constants, depth = 0) {
  const trimmed = expression.trim();
  if (depth > 16) return new Set();
  if (/^[A-Za-z_]\w*$/u.test(trimmed)) return new Set(constants.get(trimmed) ?? []);
  const direct = decodeQuotedText(trimmed);
  if (direct !== undefined) return new Set([direct]);
  let quote;
  let escaped = false;
  let start = 0;
  const parts = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = undefined; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "+") { parts.push(trimmed.slice(start, index)); start = index + 1; }
  }
  if (quote || parts.length === 0) return new Set();
  parts.push(trimmed.slice(start));
  let values = new Set([""]);
  for (const part of parts) {
    const next = new Set();
    for (const prefix of values) for (const suffix of pythonStrings(part, constants, depth + 1)) next.add(prefix + suffix);
    values = next;
  }
  return values;
}

function pythonDeclaresInfrastructure(text) {
  let state = {
    constants: new Map(), importlibAliases: new Set(["importlib"]),
    importModuleAliases: new Set(), loaderAliases: new Set(["__import__", "builtins.__import__"]),
  };
  const copyState = (source) => ({
    constants: mergeTypeScriptConstants(source.constants), importlibAliases: new Set(source.importlibAliases),
    importModuleAliases: new Set(source.importModuleAliases), loaderAliases: new Set(source.loaderAliases),
  });
  const mergeStates = (...states) => ({
    constants: mergeTypeScriptConstants(...states.map(({ constants }) => constants)),
    importlibAliases: new Set(states.flatMap(({ importlibAliases }) => [...importlibAliases])),
    importModuleAliases: new Set(states.flatMap(({ importModuleAliases }) => [...importModuleAliases])),
    loaderAliases: new Set(states.flatMap(({ loaderAliases }) => [...loaderAliases])),
  });
  const normalizeLoaderExpression = (expression) => {
    let normalized = expression.trim();
    let changed = true;
    while (changed && normalized.startsWith("(") && normalized.endsWith(")")) {
      changed = false;
      let depth = 0;
      let quote;
      let escaped = false;
      for (let index = 0; index < normalized.length; index += 1) {
        const character = normalized[index];
        if (escaped) { escaped = false; continue; }
        if (character === "\\") { escaped = true; continue; }
        if (quote) { if (character === quote) quote = undefined; continue; }
        if (character === '"' || character === "'") { quote = character; continue; }
        if (character === "(") depth += 1;
        else if (character === ")") depth -= 1;
        if (depth === 0 && index < normalized.length - 1) break;
        if (index === normalized.length - 1 && depth === 0) {
          normalized = normalized.slice(1, -1).trim();
          changed = true;
        }
      }
    }
    const member = /^(.*?)\s*\.\s*import_module$/u.exec(normalized);
    if (member) {
      const receiver = normalizeLoaderExpression(member[1]);
      if (/^[A-Za-z_]\w*$/u.test(receiver)) return `${receiver}.import_module`;
    }
    const getattr = /^getattr\s*\(\s*(.+?)\s*,\s*(.+)\s*\)$/u.exec(normalized);
    if (getattr) {
      const receiver = normalizeLoaderExpression(getattr[1]);
      const attributes = pythonStrings(getattr[2].split(",", 1)[0], state.constants);
      if (/^[A-Za-z_]\w*$/u.test(receiver) && (attributes.has("import_module") || attributes.has("__import__"))) {
        return `${receiver}.${[...attributes][0]}`;
      }
    }
    const dictionary = /^(.*?)\s*\.\s*__dict__\s*(?:\[\s*(.+)\s*\]|\.get\s*\(\s*(.+)\s*\))$/u.exec(normalized);
    if (dictionary) {
      const receiver = normalizeLoaderExpression(dictionary[1]);
      const attributes = pythonStrings(dictionary[2] ?? dictionary[3], state.constants);
      if (/^[A-Za-z_]\w*$/u.test(receiver) && (attributes.has("import_module") || attributes.has("__import__"))) {
        return `${receiver}.${[...attributes][0]}`;
      }
    }
    return normalized;
  };
  const isLoaderExpression = (expression) => {
    const loader = normalizeLoaderExpression(expression);
    if (loader === "builtins.__import__" || state.loaderAliases.has(loader) || state.importModuleAliases.has(loader) ||
      [...state.importlibAliases].some((alias) => loader === `${alias}.import_module`)) return true;
    const lambda = /^lambda\s+([A-Za-z_]\w*)\s*:\s*(.+)\s*\(\s*\1\s*\)$/u.exec(loader);
    return Boolean(lambda && isLoaderExpression(lambda[2]));
  };
  const lines = text.split(/\r?\n/u);
  const contexts = [];
  const closeContext = () => {
    const context = contexts.pop();
    if (context.type === "function") {
      state = context.before;
      if (context.wrapper) state.loaderAliases.add(context.name);
    } else {
      context.branches.push(copyState(state));
      if (!context.hasElse) context.branches.push(context.before);
      state = mergeStates(...context.branches);
    }
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const indentation = /^\s*/u.exec(line)[0].length;
    const branch = /^\s*(elif\b.*|else)\s*:\s*(?:#.*)?$/u.exec(line);
    while (contexts.length > 0 && indentation <= contexts.at(-1).indentation &&
      !(branch && contexts.at(-1).type === "conditional" && indentation === contexts.at(-1).indentation)) {
      closeContext();
    }
    if (branch && contexts.at(-1)?.type === "conditional" && indentation === contexts.at(-1).indentation) {
      const conditional = contexts.at(-1);
      conditional.branches.push(copyState(state));
      state = copyState(conditional.before);
      if (branch[1] === "else") conditional.hasElse = true;
      continue;
    }
    if (/^\s*if\b.*:\s*(?:#.*)?$/u.test(line)) {
      contexts.push({ type: "conditional", indentation, before: copyState(state), branches: [], hasElse: false });
      continue;
    }
    const definition = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:\s*(?:#.*)?$/u.exec(line);
    if (definition) {
      const parameters = definition[2].split(",").map((parameter) => /^\s*\*{0,2}([A-Za-z_]\w*)/u.exec(parameter)?.[1]).filter(Boolean);
      const localBindings = new Set(parameters);
      for (let bodyIndex = lineIndex + 1; bodyIndex < lines.length; bodyIndex += 1) {
        const bodyLine = lines[bodyIndex];
        const bodyIndentation = /^\s*/u.exec(bodyLine)[0].length;
        if (bodyLine.trim() && bodyIndentation <= indentation) break;
        const assignmentBinding = /^\s*([A-Za-z_]\w*)\s*=/u.exec(bodyLine);
        if (assignmentBinding) localBindings.add(assignmentBinding[1]);
        const importBinding = /^\s*import\s+importlib(?:\s+as\s+([A-Za-z_]\w*))?/u.exec(bodyLine);
        if (importBinding) localBindings.add(importBinding[1] ?? "importlib");
        const fromBinding = /^\s*from\s+importlib\s+import\s+import_module(?:\s+as\s+([A-Za-z_]\w*))?/u.exec(bodyLine);
        if (fromBinding) localBindings.add(fromBinding[1] ?? "import_module");
      }
      contexts.push({ type: "function", indentation, before: copyState(state), name: definition[1], parameter: parameters[0], wrapper: false, localBindings });
      state = copyState(state);
      for (const binding of localBindings) {
        state.constants.delete(binding);
        state.loaderAliases.delete(binding);
        state.importlibAliases.delete(binding);
        state.importModuleAliases.delete(binding);
      }
      continue;
    }
    const importlib = /^\s*import\s+importlib(?:\s+as\s+([A-Za-z_]\w*))?\s*(?:#.*)?$/u.exec(line);
    if (importlib) state.importlibAliases.add(importlib[1] ?? "importlib");
    const importModule = /^\s*from\s+importlib\s+import\s+import_module(?:\s+as\s+([A-Za-z_]\w*))?/u.exec(line);
    if (importModule) {
      state.importModuleAliases.add(importModule[1] ?? "import_module");
      state.loaderAliases.add(importModule[1] ?? "import_module");
    }
    const directImport = /^\s*(?:from|import)\s+(aws_cdk|cdktf|pulumi(?:_[A-Za-z0-9_]+)?)(?:\b|\.)/u.exec(line);
    if (directImport) return true;
    const assignment = /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/u.exec(line);
    if (assignment) {
      const values = pythonStrings(assignment[2], state.constants);
      if (values.size > 0) state.constants.set(assignment[1], values);
      else state.constants.delete(assignment[1]);
      if (isLoaderExpression(assignment[2])) state.loaderAliases.add(assignment[1]);
      else state.loaderAliases.delete(assignment[1]);
      const assigned = normalizeLoaderExpression(assignment[2]);
      if (state.importlibAliases.has(assigned)) state.importlibAliases.add(assignment[1]);
      else state.importlibAliases.delete(assignment[1]);
      if (state.importModuleAliases.has(assigned)) state.importModuleAliases.add(assignment[1]);
      else state.importModuleAliases.delete(assignment[1]);
    }
    const returned = /^\s*return\s+(.+?)\s*\(\s*([A-Za-z_]\w*)\s*\)\s*(?:#.*)?$/u.exec(line);
    const activeFunction = [...contexts].reverse().find(({ type }) => type === "function");
    if (returned && activeFunction && returned[2] === activeFunction.parameter && isLoaderExpression(returned[1])) activeFunction.wrapper = true;
    const loaders = [...state.loaderAliases, ...state.importModuleAliases, ...[...state.importlibAliases].map((alias) => `${alias}.import_module`)]
      .map((loader) => loader.replace(".", "\\."))
      .join("|");
    const directBuiltin = /(?:builtins\.__dict__\s*\[\s*["']__import__["']\s*\]|getattr\s*\(\s*builtins\s*,\s*["']__import__["']\s*\))\s*\((.*)\)/u.exec(line);
    if (directBuiltin) {
      const values = pythonStrings(directBuiltin[1].split(",", 1)[0], state.constants);
      if ([...values].some((value) => /^(?:aws_cdk|cdktf|pulumi)(?:[._]|$)/u.test(value))) return true;
    }
    const calls = new RegExp(`(?:${loaders})\\s*\\(([^)]*)\\)`, "gu");
    for (const match of line.matchAll(calls)) {
      const rawArgs = match[1];
      // Accept structurally equivalent starred/keyword module arguments while
      // remaining bounded and conservative (only literal/constant strings).
      const first = rawArgs.split(",", 1)[0];
      const starred = /^\s*\*\s*(?:\[\s*)?(.+?)(?:\s*\])?\s*$/u.exec(first);
      const keyword = /(?:^|,)\s*(?:name|module)\s*=\s*([^,]+)/u.exec(rawArgs);
      const values = pythonStrings(starred?.[1] ?? keyword?.[1] ?? first, state.constants);
      if ([...values].some((value) => /^(?:aws_cdk|cdktf|pulumi)(?:[._]|$)/u.test(value))) return true;
    }
  }
  while (contexts.length > 0) closeContext();
  return false;
}

function decodedStructuredKey(rawKey) {
  const trimmed = rawKey.trim();
  const quoted = decodeQuotedText(trimmed);
  if (quoted !== undefined) return quoted;
  return trimmed.replace(/\\u\{([a-f0-9]+)\}|\\u([a-f0-9]{4})/giu, (_, braced, plain) =>
    String.fromCodePoint(Number.parseInt(braced ?? plain, 16)));
}

function structuredTextContainsCredential(name, text) {
  if (!/\.(?:conf|ini|toml|ya?ml)$/u.test(name)) return false;
  return text.split(/\r?\n/u).some((line) => {
    const entry = /^\s*-?\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^:=#;]+?))\s*[:=]\s*(.*?)\s*$/u.exec(line);
    if (!entry || !hasCredentialKey(decodedStructuredKey(entry[1]))) return false;
    const value = entry[2].replace(/\s+(?:#|;).*$/u, "").replace(/^['"]|['"]$/gu, "");
    return value.length >= 8;
  });
}

function packageDeclaresInfrastructure(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((field) => {
    const dependencies = manifest[field];
    return dependencies && typeof dependencies === "object" && !Array.isArray(dependencies) &&
      Object.keys(dependencies).some((name) => infrastructurePackagePattern.test(name));
  });
}

export function repositoryStopReason(filename, content) {
  const normalized = filename.replaceAll("\\", "/").toLowerCase();
  const name = normalized.split("/").at(-1);
  const segments = normalized.split("/");
  const text = contentText(content);
  const json = parsedJson(name, text);
  const workspaceBuildOutput = /^(?:apps|packages|examples)\/[a-z0-9-]+\/dist\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:js|d\.ts)$/u.test(normalized);
  const sourceCode = /\.(?:[cm]?[jt]sx?|py)$/u.test(name);
  if (/^licen[cs]e(?:$|[-_.])/u.test(name)) return "public-license";
  if (/^(?:copying|notice)(?:$|[-_.])/u.test(name)) return "public-license";
  if (name === "package.json" && json && typeof json === "object" && !Array.isArray(json) &&
      typeof json.license === "string" && json.license.length > 0) return "public-license";
  if (name === "package.json" && /["']license["']\s*:\s*["'][^"']+["']/iu.test(text)) return "public-license";
  if (/^\.env(?:$|\.)/u.test(name)) return "credentials";
  if (/^(?:credentials?|secrets?|service-account|client[-_]?secret)(?:$|[-_.])/u.test(name) ||
      /^service[-_]?account(?:$|[-_.])/u.test(name) ||
      /(?:^|[-_.])credentials?(?:$|[-_.])/u.test(name) ||
      /^(?:access|auth|github|npm)[-_]?tokens?(?:$|[-_.])/u.test(name) ||
      /^(?:bearer|oauth2?|refresh|session)(?:[-_](?:tokens?|credentials?|secrets?))?\.(?:conf|ini|json|toml|txt|ya?ml)$/u.test(name) ||
      /^id[-_](?:tokens?|credentials?|secrets?)(?:$|[-_.])/u.test(name) ||
      /^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[.])/u.test(name) ||
      [".npmrc", ".netrc", ".pypirc", ".git-credentials", "application_default_credentials.json", "kubeconfig"].includes(name) ||
      normalized === ".aws/config" || normalized.endsWith("/.aws/config") ||
      credentialDirectories.has(segments.slice(0, -1).join("/")) || segments.some((segment) => credentialDirectories.has(segment)) ||
      normalized.includes("/.config/gcloud/") || normalized.startsWith(".config/gcloud/") ||
      normalized === ".kube/config" || normalized.endsWith("/.kube/config") ||
      /^kube[-_]?config(?:$|[-_.])/u.test(name) || /(?:^|[-_.])kubeconfig(?:$|[-_.])/u.test(name) ||
      /(?:^|[-_.])private[-_]?key(?:$|[-_.])/u.test(name) ||
      (normalized === ".docker/config.json" || normalized.endsWith("/.docker/config.json")) ||
      /^private(?:[-_.].*)?\.pem$/u.test(name) ||
      /^(?:google|gcp|azure)[-_.].*credentials?(?:$|[-_.])/u.test(name) ||
      /\.(?:key|p12|pfx|jks|keystore)$/u.test(name)) return "credentials";
  if (jsonContains(json, (key, value) => hasCredentialKey(key) && looksHardCodedSecret(value))) return "credentials";
  if (/\.(?:[cm]?[jt]sx?)$/u.test(name) && typescriptContainsCredential(text, name) ||
      name.endsWith(".py") && pythonContainsCredential(text)) return "credentials";
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u.test(text) ||
      text.includes("-----BEGIN PGP " + "PRIVATE KEY BLOCK-----") ||
      /["']type["']\s*:\s*["']service_account["']/u.test(text) && /["']private_key["']\s*:/u.test(text) ||
      /["']private_key["']\s*:\s*["'][^"']{8,}["']/u.test(text) ||
      /(?:^|\n)\s*aws_(?:access_key_id|secret_access_key|session_token)\s*=\s*\S+/iu.test(text) ||
      /(?:^|\n)\s*(?:_auth|_authToken|\/\/.+?:_authToken)\s*=/u.test(text) ||
      /(?:^|\n)\s*clusters\s*:/u.test(text) && /(?:^|\n)\s*contexts\s*:/u.test(text) &&
        /(?:^|\n)\s*users\s*:/u.test(text) && /(?:^|\n)\s*current-context\s*:/u.test(text) &&
        /(?:token|client-key-data|client-certificate-data|password)\s*:/u.test(text) ||
      !sourceCode && !json && /(?:^|[,{\n]\s*)["']?(?:access[_-]?token|auth(?:orization)?[_-]?token|api[_-]?key|client[_-]?secret|github[_-]?token|id[_-]?token|npm[_-]?token|private[_-]?key|refresh[_-]?token|secret[_-]?token|session[_-]?token|password)["']?\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/iu.test(text) ||
      !sourceCode && !json && /(?:^|[,{\n]\s*)["']?(?:authorization|token)["']?\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/iu.test(text) ||
      /(?:^|\n)\s*authorization\s*:\s*bearer\s+\S+/iu.test(text) ||
      structuredTextContainsCredential(name, text)) return "credentials";
  const archiveName = /(?:\.tar\.(?:br|lz4|xz)|\.(?:zip|tar|tgz|gz|bz2|xz|zst|7z|rar|jar|war|whl|deb|rpm|apk|cab|dmg|iso|crate))$/u.test(name);
  const helmPath = segments.length === 1 || segments.some((segment) => ["chart", "charts", "helm"].includes(segment));
  const helmFile = name === "chart.lock" || /^(?:chart)\.ya?ml$/u.test(name) ||
    helmPath && /^(?:values(?:[-_.][a-z0-9-]+)?)\.ya?ml$/u.test(name);
  const k8sStructured = jsonContainsKubernetesResource(json);
  const k8sYaml = /\.(?:ya?ml)$/u.test(name) && yamlContainsKubernetesResource(text);
  const iacPath = segments.some((segment) => ["infra", "infrastructure", "deploy", "deployment"].includes(segment));
  const iacLoader = /\.(?:[cm]?[jt]sx?)$/u.test(name) ? typescriptDeclaresInfrastructure(text, name) :
    name.endsWith(".py") ? pythonDeclaresInfrastructure(text) : false;
  if (archiveName || helmFile || k8sStructured || k8sYaml || sourceCode && iacPath && iacLoader ||
    infrastructureFiles.has(name) || name.endsWith(".tf") || name.endsWith(".tf.json") ||
    name.endsWith(".bicep") || iacPath && name.endsWith(".hcl") ||
    archiveName ||
    !workspaceBuildOutput && segments.some((segment) => generatedInfrastructureDirectories.has(segment)) ||
    helmFile ||
    /^(?:pulumi|cdktf|serverless)[._-].*output.*$/u.test(name) ||
    segments.some((segment) => ["deploy", "deployment"].includes(segment)) && /\.(?:zip|tar|tgz|gz|7z)$/u.test(name) ||
    /\.(?:auto\.)?tfvars(?:\.json)?$/u.test(name) || /^terraform\.tfstate(?:\.|$)/u.test(name) ||
    [".terraformrc", "terraform.rc", ".terraform.lock.hcl", "terragrunt.hcl"].includes(name) ||
    /^pulumi(?:[._-].*)?\.(?:ya?ml|json)$/u.test(name) || normalized.split("/").includes(".pulumi") ||
    /^serverless(?:[._-].*)?\.(?:ya?ml|json|[cm]?[jt]s)$/u.test(name) || normalized.split("/").includes(".serverless") ||
    /^(?:dockerfile|containerfile)(?:$|[._-])/u.test(name) || /^(?:docker-)?compose(?:[._-].*)?\.ya?ml$/u.test(name) ||
    /^(?:cloudformation|cfn)(?:$|[._-])/u.test(name) || /^samconfig(?:[._-].*)?\.toml$/u.test(name) ||
    /^(?:sam-template|packaged|stack|template)(?:[._-].*)?\.(?:ya?ml|json)$/u.test(name) ||
    normalized.split("/").includes(".aws-sam") ||
    ["cdk.json", "cdk.context.json"].includes(name) || /^cdk[._-].*\.(?:json|[cm]?[jt]s)$/u.test(name) ||
    normalized.split("/").includes("cdk.out") ||
    segments.some((segment) => segment === ".terraform" || segment === ".terragrunt" || segment === ".cdktf") ||
    /^(?:deploy|deployment|cloudformation|terraform|cdktf)(?:[._-].*)?\.(?:json|ya?ml|[cm]?[jt]s)$/u.test(name) ||
    /\.(?:ya?ml|json)$/u.test(name) &&
      /(?:AWSTemplateFormatVersion|AWS::Serverless-2016-10-31)/u.test(text) ||
    /\.ya?ml$/u.test(name) && /(?:^|\n)\s*Type\s*:\s*AWS::[A-Za-z0-9:]+/u.test(text) ||
    /\.json$/u.test(name) && /["']Type["']\s*:\s*["']AWS::[A-Za-z0-9:]+["']/u.test(text) ||
    iacLoader ||
    name === "package.json" && (packageDeclaresInfrastructure(json) || /(?:"aws-cdk-lib"|"@aws-cdk\/|"@cdktf\/|"cdktf"|"@pulumi\/|"pulumi"|"serverless"|"npm:(?:aws-cdk-lib|@aws-cdk\/|@cdktf\/|cdktf)|\bcdk\b[^"\n]*\bdeploy\b)/u.test(text))
  ) return "infrastructure";
  return undefined;
}
