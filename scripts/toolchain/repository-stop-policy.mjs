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

function yamlContainsKubernetesResource(text) {
  return text.split(/^\s*(?:---|\.\.\.)\s*$/gmu).some((document) => {
    const flowResource = document.includes("{") && [...document.matchAll(/\{([^{}]{0,65536})/gu)]
      .some(([, object]) => /(?:^|,)\s*["']?apiVersion["']?\s*:/u.test(object) &&
        /(?:^|,)\s*["']?kind["']?\s*:/u.test(object));
    if (flowResource) return true;
    const containers = new Map();
    const sequences = new Map();
    const keysByScope = new Map();
    let nextScope = 0;
    for (const rawLine of document.split(/\r?\n/u)) {
      if (/^\s*(?:#|$)/u.test(rawLine)) continue;
      const indentation = /^\s*/u.exec(rawLine)[0].length;
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
      [...typescriptStrings(expression, new Map())].some(looksHardCodedSecret)) found = true;
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
    return [...pythonStrings(assignment[2], new Map())].some(looksHardCodedSecret);
  });
}

function typescriptStrings(node, constants, depth = 0) {
  if (!node || depth > 16) return new Set();
  if (ts.isStringLiteralLike(node)) return new Set([node.text]);
  if (ts.isIdentifier(node)) return new Set(constants.get(node.text) ?? []);
  if (ts.isParenthesizedExpression(node)) return typescriptStrings(node.expression, constants, depth + 1);
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

function typescriptDeclaresInfrastructure(text, filename) {
  const kind = filename.endsWith(".tsx") || filename.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, false, kind);
  const constants = new Map();
  const loaderAliases = new Set();
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

  const isLoaderAlias = (node) => {
    if (!node) return false;
    if (ts.isIdentifier(node)) return node.text === "require" || loaderAliases.has(node.text);
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) || node.parameters.length !== 1 ||
      !ts.isIdentifier(node.parameters[0].name)) return false;
    const parameter = node.parameters[0].name.text;
    const expression = ts.isBlock(node.body) ? node.body.statements.find(ts.isReturnStatement)?.expression : node.body;
    return Boolean(expression && ts.isCallExpression(expression) &&
      (expression.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(expression.expression) && expression.expression.text === "require") &&
      ts.isIdentifier(expression.arguments[0]) && expression.arguments[0].text === parameter);
  };

  const inspect = (node, environment = constants) => {
    if (found) return;
    if (ts.isImportDeclaration(node)) {
      if ([...typescriptStrings(node.moduleSpecifier, environment)].some((value) => infrastructureModulePattern.test(value))) found = true;
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if ([...typescriptStrings(node.moduleSpecifier, environment)].some((value) => infrastructureModulePattern.test(value))) found = true;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer) inspect(node.initializer, environment);
      assign(environment, node.name.text, node.initializer, ts.SyntaxKind.EqualsToken);
      if (isLoaderAlias(node.initializer)) loaderAliases.add(node.name.text);
      else loaderAliases.delete(node.name.text);
      return;
    } else if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) &&
      [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken].includes(node.operatorToken.kind)) {
      inspect(node.right, environment);
      assign(environment, node.left.text, node.right, node.operatorToken.kind);
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (isLoaderAlias(node.right)) loaderAliases.add(node.left.text);
        else loaderAliases.delete(node.left.text);
      }
      return;
    } else if (ts.isIfStatement(node)) {
      inspect(node.expression, environment);
      const before = mergeTypeScriptConstants(environment);
      const whenTrue = mergeTypeScriptConstants(before);
      const whenFalse = mergeTypeScriptConstants(before);
      inspect(node.thenStatement, whenTrue);
      if (node.elseStatement) inspect(node.elseStatement, whenFalse);
      replaceTypeScriptConstants(environment, mergeTypeScriptConstants(whenTrue, whenFalse));
      return;
    } else if (ts.isCallExpression(node)) {
      const loader = node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && (node.expression.text === "require" || loaderAliases.has(node.expression.text));
      if (loader) {
        if ([...typescriptStrings(node.arguments[0], environment)].some((value) => infrastructureModulePattern.test(value))) found = true;
      }
    } else if (ts.isFunctionLike(node)) {
      const localConstants = new Map(environment);
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) localConstants.delete(parameter.name.text);
      }
      if (node.body) inspect(node.body, localConstants);
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
  const constants = new Map();
  const importlibAliases = new Set(["importlib"]);
  const importModuleAliases = new Set();
  const loaderAliases = new Set(["__import__"]);
  const lines = text.split(/\r?\n/u);
  const conditionals = [];
  for (const line of lines) {
    const indentation = /^\s*/u.exec(line)[0].length;
    while (conditionals.length > 0 && indentation <= conditionals.at(-1).indentation && !/^\s*(?:elif|else)\b/u.test(line)) {
      const conditional = conditionals.pop();
      replaceTypeScriptConstants(constants, mergeTypeScriptConstants(conditional.before, constants));
    }
    if (/^\s*(?:if|elif)\b.*:\s*(?:#.*)?$/u.test(line)) {
      conditionals.push({ indentation, before: mergeTypeScriptConstants(constants) });
      continue;
    }
    const importlib = /^\s*import\s+importlib(?:\s+as\s+([A-Za-z_]\w*))?\s*(?:#.*)?$/u.exec(line);
    if (importlib) importlibAliases.add(importlib[1] ?? "importlib");
    const importModule = /^\s*from\s+importlib\s+import\s+import_module(?:\s+as\s+([A-Za-z_]\w*))?/u.exec(line);
    if (importModule) {
      importModuleAliases.add(importModule[1] ?? "import_module");
      loaderAliases.add(importModule[1] ?? "import_module");
    }
    const directImport = /^\s*(?:from|import)\s+(aws_cdk|cdktf|pulumi(?:_[A-Za-z0-9_]+)?)(?:\b|\.)/u.exec(line);
    if (directImport) return true;
    const assignment = /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/u.exec(line);
    if (assignment) {
      const values = pythonStrings(assignment[2], constants);
      if (values.size > 0) constants.set(assignment[1], values);
      else constants.delete(assignment[1]);
      const loader = assignment[2].trim();
      if (loaderAliases.has(loader) || importModuleAliases.has(loader) ||
        [...importlibAliases].some((alias) => loader === `${alias}.import_module`)) loaderAliases.add(assignment[1]);
      else loaderAliases.delete(assignment[1]);
    }
    const loaders = [...loaderAliases, ...importModuleAliases, ...[...importlibAliases].map((alias) => `${alias}.import_module`)]
      .map((loader) => loader.replace(".", "\\."))
      .join("|");
    const calls = new RegExp(`(?:${loaders})\\s*\\(([^)]*)\\)`, "gu");
    for (const match of line.matchAll(calls)) {
      const values = pythonStrings(match[1].split(",", 1)[0], constants);
      if ([...values].some((value) => /^(?:aws_cdk|cdktf|pulumi)(?:[._]|$)/u.test(value))) return true;
    }
  }
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
    /\.ya?ml$/u.test(name) && /(?:^|\n)\s*apiVersion\s*:\s*[^\n]+\n(?:.|\n)*?\s*kind\s*:\s*(?:Deployment|StatefulSet|DaemonSet|Service|Ingress|Secret|Job|CronJob|ConfigMap|Pod|Namespace|Role|ClusterRole)\b/u.test(text) ||
    iacLoader ||
    name === "package.json" && (packageDeclaresInfrastructure(json) || /(?:"aws-cdk-lib"|"@aws-cdk\/|"@cdktf\/|"cdktf"|"@pulumi\/|"pulumi"|"serverless"|"npm:(?:aws-cdk-lib|@aws-cdk\/|@cdktf\/|cdktf)|\bcdk\b[^"\n]*\bdeploy\b)/u.test(text))
  ) return "infrastructure";
  return undefined;
}
