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
      const entry = /^\s*(?:-\s+)?(apiVersion|kind)\s*:\s*([^#\s][^#]*?)\s*(?:#.*)?$/u.exec(rawLine);
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

function typescriptString(node, constants, depth = 0) {
  if (!node || depth > 16) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text);
  if (ts.isParenthesizedExpression(node)) return typescriptString(node.expression, constants, depth + 1);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = typescriptString(node.left, constants, depth + 1);
    const right = typescriptString(node.right, constants, depth + 1);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = typescriptString(span.expression, constants, depth + 1);
      if (expression === undefined) return undefined;
      value += expression + span.literal.text;
    }
    return value;
  }
  return undefined;
}

function typescriptDeclaresInfrastructure(text, filename) {
  const kind = filename.endsWith(".tsx") || filename.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, false, kind);
  const constants = new Map();
  let found = false;

  const assign = (environment, name, expression, operator = ts.SyntaxKind.EqualsToken) => {
    const value = typescriptString(expression, environment);
    if (operator === ts.SyntaxKind.PlusEqualsToken) {
      const current = environment.get(name);
      if (current !== undefined && value !== undefined) environment.set(name, current + value);
      else environment.delete(name);
    } else if (value === undefined) environment.delete(name);
    else environment.set(name, value);
  };

  const inspect = (node, environment = constants) => {
    if (found) return;
    if (ts.isImportDeclaration(node)) {
      const value = typescriptString(node.moduleSpecifier, environment);
      if (value !== undefined && infrastructureModulePattern.test(value)) found = true;
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const value = typescriptString(node.moduleSpecifier, environment);
      if (value !== undefined && infrastructureModulePattern.test(value)) found = true;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer) inspect(node.initializer, environment);
      assign(environment, node.name.text, node.initializer, ts.SyntaxKind.EqualsToken);
      return;
    } else if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) &&
      [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken].includes(node.operatorToken.kind)) {
      inspect(node.right, environment);
      assign(environment, node.left.text, node.right, node.operatorToken.kind);
      return;
    } else if (ts.isCallExpression(node)) {
      const loader = node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (loader) {
        const value = typescriptString(node.arguments[0], environment);
        if (value !== undefined && infrastructureModulePattern.test(value)) found = true;
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

function pythonString(expression, constants, depth = 0) {
  const trimmed = expression.trim();
  if (depth > 16) return undefined;
  if (/^[A-Za-z_]\w*$/u.test(trimmed)) return constants.get(trimmed);
  const direct = decodeQuotedText(trimmed);
  if (direct !== undefined) return direct;
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
  if (quote || parts.length === 0) return undefined;
  parts.push(trimmed.slice(start));
  const values = parts.map((part) => pythonString(part, constants, depth + 1));
  return values.some((value) => value === undefined) ? undefined : values.join("");
}

function pythonDeclaresInfrastructure(text) {
  const constants = new Map();
  const importlibAliases = new Set(["importlib"]);
  const importModuleAliases = new Set();
  const lines = text.split(/\r?\n/u);
  for (let pass = 0; pass < 4; pass += 1) {
    for (const line of lines) {
      const assignment = /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/u.exec(line);
      if (!assignment) continue;
      const value = pythonString(assignment[2], constants);
      if (value !== undefined) constants.set(assignment[1], value);
    }
  }
  for (const line of lines) {
    const importlib = /^\s*import\s+importlib(?:\s+as\s+([A-Za-z_]\w*))?\s*(?:#.*)?$/u.exec(line);
    if (importlib) importlibAliases.add(importlib[1] ?? "importlib");
    const importModule = /^\s*from\s+importlib\s+import\s+import_module(?:\s+as\s+([A-Za-z_]\w*))?/u.exec(line);
    if (importModule) importModuleAliases.add(importModule[1] ?? "import_module");
    const directImport = /^\s*(?:from|import)\s+(aws_cdk|cdktf|pulumi(?:_[A-Za-z0-9_]+)?)(?:\b|\.)/u.exec(line);
    if (directImport) return true;
  }
  const loaders = ["__import__", ...importModuleAliases, ...[...importlibAliases].map((alias) => `${alias}.import_module`)]
    .map((loader) => loader.replace(".", "\\."))
    .join("|");
  const calls = new RegExp(`(?:${loaders})\\s*\\(([^)]*)\\)`, "gu");
  for (const match of text.matchAll(calls)) {
    const value = pythonString(match[1].split(",", 1)[0], constants);
    if (value !== undefined && /^(?:aws_cdk|cdktf|pulumi)(?:[._]|$)/u.test(value)) return true;
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
      /^id_[a-z0-9][a-z0-9._-]*$/u.test(name) ||
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
  if (jsonContains(json, (key, value) => hasCredentialKey(key) &&
      (typeof value === "string" ? value.length >= 8 : value !== undefined && value !== null))) return "credentials";
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u.test(text) ||
      text.includes("-----BEGIN PGP " + "PRIVATE KEY BLOCK-----") ||
      /["']type["']\s*:\s*["']service_account["']/u.test(text) && /["']private_key["']\s*:/u.test(text) ||
      /["']private_key["']\s*:\s*["'][^"']{8,}["']/u.test(text) ||
      /(?:^|\n)\s*aws_(?:access_key_id|secret_access_key|session_token)\s*=\s*\S+/iu.test(text) ||
      /(?:^|\n)\s*(?:_auth|_authToken|\/\/.+?:_authToken)\s*=/u.test(text) ||
      /(?:^|\n)\s*clusters\s*:/u.test(text) && /(?:^|\n)\s*contexts\s*:/u.test(text) &&
        /(?:^|\n)\s*users\s*:/u.test(text) && /(?:^|\n)\s*current-context\s*:/u.test(text) &&
        /(?:token|client-key-data|client-certificate-data|password)\s*:/u.test(text) ||
      !sourceCode && /(?:^|[,{\n]\s*)["']?(?:access[_-]?token|auth(?:orization)?[_-]?token|api[_-]?key|client[_-]?secret|github[_-]?token|id[_-]?token|npm[_-]?token|private[_-]?key|refresh[_-]?token|secret[_-]?token|session[_-]?token|password)["']?\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/iu.test(text) ||
      !sourceCode && /(?:^|[,{\n]\s*)["']?(?:authorization|token)["']?\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/iu.test(text) ||
      /(?:^|\n)\s*authorization\s*:\s*bearer\s+\S+/iu.test(text) ||
      structuredTextContainsCredential(name, text)) return "credentials";
  const archiveName = /(?:\.tar\.(?:br|xz)|\.(?:zip|tar|tgz|gz|bz2|xz|zst|7z|rar|jar|war|whl|deb))$/u.test(name);
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
