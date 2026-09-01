import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

import ts from "typescript";
import {
  decodeBoundedBase64,
  decodeBoundedUtf8,
  parseBoundedJsonText,
  readBoundedBytes,
  readBoundedJson,
  readBoundedText,
} from "./bounded-input.mjs";

const defaultRoot = fileURLToPath(new URL("../..", import.meta.url));
const allowedModule = "@ros-web-viewer/extension-api";
const sourceMaxBytes = 1024 * 1024;
const configMaxBytes = 256 * 1024;
const emittedMaxBytes = 2 * 1024 * 1024;
const allowedExtensionImports = new Set([
  "defineTrustedExtension", "defineTrustedLifecycle", "TrustedExtensionContext", "TrustedExtensionDefinition",
  "TrustedExtensionLifecycle", "TrustedResourceHandle", "TrustedExtensionCapability",
]);
const safeStandardGlobals = new Set(["Array", "Boolean", "Error", "JSON", "Map", "Math", "Number", "Object", "Set", "String", "undefined"]);
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const privilegedNames = new Set([
  "Worker", "WebSocket", "localStorage", "sessionStorage", "indexedDB", "fetch", "document", "window", "navigator",
  "WebGL2RenderingContext", "OffscreenCanvas", "SharedArrayBuffer", "process", "Deno", "Bun",
  "publish", "callService", "sendAction", "setParameter", "rawCommand",
  "global", "self", "WebAssembly", "Atomics",
  "XMLHttpRequest", "EventSource", "BroadcastChannel", "MessageChannel", "SharedWorker", "WorkerGlobalScope",
  "caches", "cookieStore", "location", "history", "crypto", "performance", "console",
  "Proxy", "Promise", "URL", "postMessage",
]);
const deniedRuntimeNames = new Set(["eval", "Function", "require", "globalThis", "Reflect", "constructor", "prototype", "__proto__", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors"]);
const deniedRuntimeProperties = new Set([
  "constructor", "prototype", "__proto__", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors",
  "defineProperty", "defineProperties", "setPrototypeOf", "getPrototypeOf",
]);

function fail(message) { throw new Error(`extension example audit: ${message}`); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }

function constantString(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return constantString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantString(node.left);
    const right = constantString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function assertModule(specifier, label, resolveRelative) {
  if (specifier === allowedModule) return;
  if (specifier.startsWith(".")) {
    if (!resolveRelative) fail(`${label} has an unresolved relative module ${specifier}`);
    resolveRelative(specifier);
    return;
  }
  fail(`${label} imports denied module ${specifier}`);
}

export function auditSourceText(source, filename = "probe.ts", resolveRelative) {
  const scriptKind = filename.endsWith(".tsx") ? ts.ScriptKind.TSX : filename.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKind);
  if (file.parseDiagnostics.length > 0) fail(`${filename} contains TypeScript parse errors`);
  const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, allowJs: true };
  const baseHost = ts.createCompilerHost(options);
  const host = { ...baseHost, getSourceFile: (name) => name === filename ? file : undefined,
    fileExists: (name) => name === filename, readFile: (name) => name === filename ? source : undefined };
  const checker = ts.createProgram([filename], options, host).getTypeChecker();
  const symbolAt = (node) => ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined;
  const importedSymbols = new Map();
  const importedLocalNames = new Set();
  let extensionApiImport = false;
  let extensionDefinitionExports = 0;
  const exportedTypes = new Map();
  let exportedDefinitionType;
  const resolvedSymbol = (symbol) => symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const isBuilderCall = (expression, name) => {
    const entry = ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) ? importedSymbols.get(expression.expression.text) : undefined;
    return !!entry && entry.name === name && symbolAt(expression.expression) === entry.symbol;
  };
  const pureCreateInitializer = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ||
        node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
      return pureCreateInitializer(node.expression);
    }
    if (ts.isPrefixUnaryExpression(node) && [
      ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.TildeToken,
    ].includes(node.operator)) return pureCreateInitializer(node.operand);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => !ts.isSpreadElement(element) && pureCreateInitializer(element));
    if (ts.isObjectLiteralExpression(node)) return node.properties.every((property) =>
      ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && pureCreateInitializer(property.initializer));
    return false;
  };
  const directLifecycleReturn = (callback) => {
    if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return undefined;
    if (callback.name || callback.asteriskToken || callback.typeParameters ||
        callback.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.AsyncKeyword) || callback.parameters.some((parameter) =>
      !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken ||
      ["defineTrustedExtension", "defineTrustedLifecycle"].includes(parameter.name.text))) return undefined;
    if (!ts.isBlock(callback.body)) return isBuilderCall(callback.body, "defineTrustedLifecycle") ? callback.body : undefined;
    const statements = [...callback.body.statements];
    const final = statements.at(-1);
    if (!final || !ts.isReturnStatement(final) || !final.expression || !isBuilderCall(final.expression, "defineTrustedLifecycle")) return undefined;
    for (const statement of statements.slice(0, -1)) {
      if (!ts.isVariableStatement(statement)) return undefined;
      if (statement.declarationList.flags & ts.NodeFlags.Using) return undefined;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || ["defineTrustedExtension", "defineTrustedLifecycle"].includes(declaration.name.text)) return undefined;
        if (declaration.initializer && !pureCreateInitializer(declaration.initializer)) return undefined;
      }
    }
    return final.expression;
  };
  const isInTypePosition = (node) => { let p = node.parent; while (p) { if (ts.isTypeNode(p)) return true; if (ts.isExpression(p) || ts.isStatement(p) || ts.isSourceFile(p)) return false; p = p.parent; } return false; };
  const declarationName = (node) => {
    if (!node || !node.name) return false;
    return (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name === node.parent?.name;
  };
  const isNonReferenceIdentifier = (node) => {
    const p = node.parent;
    return declarationName(p) || isInTypePosition(node) || (ts.isPropertyAccessExpression(p) && p.name === node) ||
      (ts.isPropertyAssignment(p) && p.name === node) || (ts.isMethodDeclaration(p) && p.name === node) ||
      (ts.isMethodSignature(p) && p.name === node) || (ts.isImportSpecifier(p) || ts.isNamespaceImport(p) || ts.isImportClause(p) || ts.isExportSpecifier(p)) ||
      (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p));
  };
  const runtimeBuilderCalls = { defineTrustedExtension: 0, defineTrustedLifecycle: 0 };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) fail(`${filename} has a non-literal module specifier`);
      assertModule(node.moduleSpecifier.text, filename, resolveRelative);
      if (ts.isExportDeclaration(node) && node.moduleSpecifier.text === allowedModule) fail(`${filename} must not re-export the host API`);
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === allowedModule) {
        const clause = node.importClause;
        if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) fail(`${filename} must use exact named extension-api imports`);
        for (const element of clause.namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (!allowedExtensionImports.has(imported)) fail(`${filename} imports unsupported extension-api symbol ${imported}`);
          if (element.propertyName) fail(`${filename} must not alias extension-api symbols`);
          if (importedSymbols.has(element.name.text)) fail(`${filename} duplicates extension-api binding ${element.name.text}`);
          importedSymbols.set(element.name.text, { name: imported, symbol: undefined }); importedLocalNames.add(element.name.text);
          if (["defineTrustedExtension", "defineTrustedLifecycle"].includes(imported) && (clause.isTypeOnly || element.isTypeOnly)) fail(`${filename} imports runtime builder ${imported} as type-only`);
          extensionApiImport = true;
        }
        for (const element of clause.namedBindings.elements) importedSymbols.get(element.name.text).symbol = symbolAt(element.name);
      }
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && ["require", "eval", "Function"].includes(node.expression.text)) fail(`${filename} calls ${node.expression.text}`);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) fail(`${filename} uses dynamic import`);
      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && (node.expression.expression.text === "require" || node.expression.expression.text === "Reflect")) fail(`${filename} uses a denied runtime loader/reflection`);
      if (ts.isPropertyAccessExpression(node.expression) && deniedRuntimeProperties.has(node.expression.name.text)) fail(`${filename} acquires a runtime descriptor`);
      if (ts.isIdentifier(node.expression) && importedSymbols.get(node.expression.text)?.name in runtimeBuilderCalls) runtimeBuilderCalls[importedSymbols.get(node.expression.text).name] += 1;
    }
    if (ts.isNewExpression(node) && (!ts.isIdentifier(node.expression) || node.expression.text !== "Error")) fail(`${filename} constructs a non-approved runtime object`);
    if (ts.isPropertyAccessExpression(node) && deniedRuntimeProperties.has(node.name.text)) fail(`${filename} accesses denied runtime property ${node.name.text}`);
    if (ts.isIdentifier(node) && !isNonReferenceIdentifier(node)) {
      if (privilegedNames.has(node.text)) fail(`${filename} references privileged ${node.text}`);
      if (deniedRuntimeNames.has(node.text)) fail(`${filename} references denied runtime ${node.text}`);
      const symbol = symbolAt(node);
      if (!symbol && !safeStandardGlobals.has(node.text)) fail(`${filename} references unbound ambient ${node.text}`);
    }
    if (ts.isElementAccessExpression(node)) { const property = node.argumentExpression === undefined ? undefined : constantString(node.argumentExpression); if (property === undefined || deniedRuntimeProperties.has(property) || deniedRuntimeNames.has(property) || privilegedNames.has(property)) fail(`${filename} accesses denied computed property`); }
    if (ts.isBindingElement(node)) {
      const property = node.propertyName;
      const propertyName = property === undefined && ts.isIdentifier(node.name) ? node.name.text :
        property && ts.isComputedPropertyName(property) ? constantString(property.expression) :
          property && (ts.isIdentifier(property) || ts.isStringLiteralLike(property) || ts.isNumericLiteral(property)) ? property.text : undefined;
      if (property && ts.isComputedPropertyName(property) && propertyName === undefined) {
        fail(`${filename} has an unresolved computed binding property`);
      }
      if (propertyName && (deniedRuntimeProperties.has(propertyName) || deniedRuntimeNames.has(propertyName))) {
        fail(`${filename} destructures a denied runtime property`);
      }
    }
    const exported = node.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!filename.endsWith(".d.ts") && exported) {
      if (ts.isVariableStatement(node)) {
        if (node.declarationList.declarations.length !== 1 || node.declarationList.flags & ts.NodeFlags.Let || node.declarationList.flags & ts.NodeFlags.Var) fail(`${filename} exported definition must be immutable const`);
        const declaration = node.declarationList.declarations[0];
        if (!declaration.initializer || !isBuilderCall(declaration.initializer, "defineTrustedExtension")) fail(`${filename} must export exact definition builder result`);
        const callback = declaration.initializer.arguments[1];
        if (!callback || !directLifecycleReturn(callback)) fail(`${filename} create callback must use only pure declarations before one exact lifecycle return`);
        extensionDefinitionExports += 1; exportedDefinitionType = declaration.type;
      } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
        const symbol = resolvedSymbol(symbolAt(node.name));
        if (!symbol) fail(`${filename} cannot resolve exported type ${node.name.text}`);
        exportedTypes.set(symbol, node.name.text);
      }
      else fail(`${filename} exports unsupported runtime declaration`);
    }
    if (!filename.endsWith(".d.ts") && (ts.isExportAssignment(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier === undefined))) fail(`${filename} uses an unsupported runtime export`);
    ts.forEachChild(node, visit);
  };
  // The module surface is declaration-only: no execution or helper declarations beyond the exact audited surface.
  if (!filename.endsWith(".d.ts")) {
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
      if (ts.isVariableStatement(statement) && statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) continue;
      fail(`${filename} has a non-approved top-level declaration or execution`);
    }
    const builderNames = new Set(["defineTrustedExtension", "defineTrustedLifecycle"]);
    const checkMutation = (node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left) && builderNames.has(node.left.text)) fail(`${filename} reassigns a trusted builder`);
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer) && builderNames.has(node.initializer.text)) fail(`${filename} aliases a trusted builder`);
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
          node.name && ts.isIdentifier(node.name) && builderNames.has(node.name.text)) {
        const entry = importedSymbols.get(node.name.text);
        if (!entry || symbolAt(node.name) !== entry.symbol) fail(`${filename} shadows a trusted builder`);
      }
      ts.forEachChild(node, checkMutation);
    };
    checkMutation(file);
  }
  visit(file);
  for (const entry of importedSymbols.values()) if (!entry.symbol) entry.symbol = checker.getSymbolsInScope(file, ts.SymbolFlags.Value).find((s) => s.name === entry.name);
  if (!filename.endsWith(".d.ts") && (!extensionApiImport || extensionDefinitionExports !== 1 || runtimeBuilderCalls.defineTrustedExtension !== 1 || runtimeBuilderCalls.defineTrustedLifecycle !== 1)) fail(`${filename} must contain exactly one exact imported extension/lifecycle builder path`);
  if (exportedTypes.size > 0 && !exportedDefinitionType) fail(`${filename} exported types must be referenced by the definition type surface`);
  if (exportedDefinitionType) {
    const used = new Set();
    const expanded = new Set();
    const collectTypeSymbols = (node) => {
      if (ts.isIdentifier(node)) {
        const symbol = resolvedSymbol(symbolAt(node));
        if (symbol) {
          if (exportedTypes.has(symbol)) used.add(symbol);
          if (!expanded.has(symbol)) {
            expanded.add(symbol);
            for (const declaration of symbol.declarations ?? []) {
              if (ts.isTypeAliasDeclaration(declaration)) collectTypeSymbols(declaration.type);
              if (ts.isInterfaceDeclaration(declaration)) {
                for (const heritage of declaration.heritageClauses ?? []) collectTypeSymbols(heritage);
                for (const member of declaration.members) collectTypeSymbols(member);
              }
            }
          }
        }
      }
      ts.forEachChild(node, collectTypeSymbols);
    };
    collectTypeSymbols(exportedDefinitionType);
    for (const [symbol, name] of exportedTypes) if (!used.has(symbol)) fail(`${filename} exports unused type ${name}`);
  }
}

// Bounded in-process batch seam for callers that need per-case diagnostics without
// paying a fresh Node/TypeScript startup for every source probe.
export function auditSourceBatch(probes) {
  if (!Array.isArray(probes) || probes.length > 256) fail("source probe batch exceeds bounded case limit");
  return probes.map(({ source, filename = "probe.ts" }) => {
    try {
      auditSourceText(source, filename);
      return { filename, ok: true, error: "" };
    } catch (error) {
      return { filename, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export function auditManifest(manifest, label = "package.json") {
  const exact = ["dependencies", "exports", "name", "private", "scripts", "type", "types"];
  if (Object.keys(manifest).sort().join("\0") !== exact.sort().join("\0")) fail(`${label} has unexpected package surfaces`);
  if (manifest.private !== true || manifest.type !== "module") fail(`${label} must be private ESM`);
  if (manifest.name !== "@ros-web-viewer/example-range-summary-extension") fail(`${label} has an unexpected package name`);
  if (JSON.stringify(manifest.dependencies) !== JSON.stringify({ [allowedModule]: "workspace:*" })) fail(`${label} has denied dependencies`);
  for (const key of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (manifest[key] !== undefined && Object.keys(manifest[key]).length !== 0) fail(`${label} has denied ${key}`);
  }
  for (const key of ["bundledDependencies", "bundleDependencies"]) {
    if (manifest[key] !== undefined && JSON.stringify(manifest[key]) !== "[]") fail(`${label} has denied ${key}`);
  }
  if (JSON.stringify(manifest.scripts) !== JSON.stringify({ build: "tsc -p tsconfig.json" })) fail(`${label} has denied scripts or lifecycle hooks`);
  if (manifest.bin !== undefined || manifest.imports !== undefined || manifest.main !== undefined || manifest.module !== undefined || manifest.browser !== undefined) {
    fail(`${label} exposes an alternate executable surface`);
  }
  if (manifest.exports !== "./dist/index.js" || manifest.types !== "./dist/index.d.ts") fail(`${label} has unexpected exports/types`);
}

function auditTsconfig(config, label) {
  const expected = {
    compilerOptions: {
      composite: true, outDir: "dist", rootDir: "src", strict: true, target: "ES2022",
      module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: true,
    },
    include: ["src"],
    references: [{ path: "../../packages/extension-api" }],
  };
  if (JSON.stringify(config) !== JSON.stringify(expected)) fail(`${label} does not match the exact audited compiler configuration`);
}

function trackedEntries(root) {
  const result = spawnSync("git", ["ls-files", "-s", "-z", "--", "examples/"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) fail(`git ls-files failed: ${result.stderr.trim()}`);
  return result.stdout.split("\0").filter(Boolean).map((entry) => {
    const match = /^(\d+) [0-9a-f]+ \d+\t(.+)$/u.exec(entry);
    if (!match) fail(`cannot parse tracked entry ${entry}`);
    return { mode: match[1], path: match[2] };
  });
}

function emittedFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? emittedFiles(path) : [path];
  });
}

function resolveEmittedModule(outputRoot, filename, specifier, available) {
  const requested = resolve(dirname(filename), specifier);
  const candidates = [requested];
  if ([".js", ".mjs", ".cjs"].includes(extname(requested))) {
    const base = requested.slice(0, -extname(requested).length);
    candidates.push(`${base}.d.ts`, `${base}.js`);
  }
  if (extname(requested) === "") {
    for (const extension of [".js", ".d.ts"]) candidates.push(`${requested}${extension}`, resolve(requested, `index${extension}`));
  }
  const target = candidates.find((candidate) => available.has(relative(outputRoot, candidate).split(sep).join("/")));
  if (!target || relative(outputRoot, target).startsWith(`..${sep}`)) fail(`${filename} has an unresolved emitted module ${specifier}`);
}

function emitAuditedPackage(packageRoot, configPath, manifest, auditedConfig) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "extension-example-audit-"));
  try {
    const outputRoot = join(temporaryRoot, "dist");
    const parsed = ts.parseJsonConfigFileContent(auditedConfig, ts.sys, packageRoot, {
      composite: false,
      declaration: true,
      declarationMap: false,
      incremental: false,
      outDir: outputRoot,
      sourceMap: false,
      tsBuildInfoFile: join(temporaryRoot, "build.tsbuildinfo"),
    }, configPath);
    if (parsed.errors.length > 0) fail(`${configPath} contains TypeScript configuration errors`);
    const host = ts.createCompilerHost(parsed.options);
    const defaultReadFile = host.readFile.bind(host);
    host.readFile = (filename) => {
      const packageRelative = relative(packageRoot, filename);
      const auditedPackageInput = (packageRelative === "" || !packageRelative.startsWith(`..${sep}`)) &&
        packageRelative !== "node_modules" && !packageRelative.startsWith(`node_modules${sep}`);
      return auditedPackageInput ? readBoundedText(filename, sourceMaxBytes, relative(defaultRoot, filename)) : defaultReadFile(filename);
    };
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences, host });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const emitted = program.emit();
    if (diagnostics.length > 0 || emitted.emitSkipped) fail(`${configPath} does not build without diagnostics`);
    const files = emittedFiles(outputRoot);
    const available = new Set(files.map((path) => relative(outputRoot, path).split(sep).join("/")));
    const expectedTargets = [manifest.exports, manifest.types].map((target) => {
      const prefix = "./dist/";
      if (typeof target !== "string" || !target.startsWith(prefix)) fail(`${packageRoot}/package.json has an unbound export target`);
      return target.slice(prefix.length);
    });
    for (const target of expectedTargets) {
      const path = resolve(outputRoot, target);
      if (!available.has(target) || !statSync(path).isFile()) fail(`${packageRoot}/package.json names missing emitted target ${target}`);
    }
    const artifactMap = files.map((path) => {
      const name = relative(outputRoot, path).split(sep).join("/");
      const bytes = readBoundedBytes(path, emittedMaxBytes, `${packageRoot}/dist/${name}`);
      if (sourceExtensions.has(extname(path)) || path.endsWith(".d.ts")) {
        auditSourceText(decodeBoundedUtf8(bytes, emittedMaxBytes, `${packageRoot}/dist/${name}`), `${packageRoot}/dist/${name}`, (specifier) => {
          resolveEmittedModule(outputRoot, path, specifier, available);
        });
      } else fail(`${packageRoot}/dist/${name} is an unaudited emitted artifact`);
      return `${name}\0${digest(bytes)}`;
    }).sort();
    return artifactMap;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function auditExtensionExamples(root = defaultRoot) {
  const entries = trackedEntries(root);
  if (entries.length === 0) fail("no tracked examples found");
  const tracked = new Set(entries.map(({ path }) => path));
  const packages = new Map();
  for (const entry of entries) {
    if (entry.mode !== "100644") fail(`${entry.path} has denied executable or symlink mode ${entry.mode}`);
    const parts = entry.path.split("/");
    if (parts.length < 3) fail(`${entry.path} is outside an example package`);
    const packageRoot = resolve(root, parts.slice(0, 2).join("/"));
    const packageState = packages.get(packageRoot) ?? {};
    packages.set(packageRoot, packageState);
    const path = resolve(root, entry.path);
    if (relative(packageRoot, path).startsWith(`..${sep}`)) fail(`${entry.path} escapes its package`);
    const name = parts.at(-1);
    if (name === "package.json") {
      packageState.manifest = readBoundedJson(path, configMaxBytes, entry.path);
      auditManifest(packageState.manifest, entry.path);
    } else if (name === "tsconfig.json") {
      packageState.configPath = path;
      packageState.config = readBoundedJson(path, configMaxBytes, entry.path);
      auditTsconfig(packageState.config, entry.path);
    }
    else if (sourceExtensions.has(extname(name))) auditSourceText(readBoundedText(path, sourceMaxBytes, entry.path), entry.path, (specifier) => {
      const requested = resolve(dirname(path), specifier);
      const candidates = [requested];
      if ([".js", ".mjs", ".cjs"].includes(extname(requested))) {
        const base = requested.slice(0, -extname(requested).length);
        candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`);
      }
      if (extname(requested) === "") {
        for (const extension of sourceExtensions) candidates.push(`${requested}${extension}`, resolve(requested, `index${extension}`));
      }
      const target = candidates.find((candidate) => {
        const rel = relative(root, candidate).split(sep).join("/");
        return tracked.has(rel);
      });
      if (!target || (relative(packageRoot, target) !== "" && relative(packageRoot, target).startsWith(`..${sep}`))) {
        fail(`${entry.path} has unresolved, untracked, or escaping module ${specifier}`);
      }
    });
    else fail(`${entry.path} is an unaudited executable/config surface`);
  }
  for (const [packageRoot, packageState] of packages) {
    if (!packageState.manifest || !packageState.configPath) fail(`${relative(root, packageRoot)} is missing its audited package/config surface`);
    const first = emitAuditedPackage(packageRoot, packageState.configPath, packageState.manifest, packageState.config);
    const second = emitAuditedPackage(packageRoot, packageState.configPath, packageState.manifest, packageState.config);
    if (JSON.stringify(first) !== JSON.stringify(second)) fail(`${relative(root, packageRoot)} does not emit reproducibly`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sourceProbe = process.argv.indexOf("--source-base64");
  const manifestProbe = process.argv.indexOf("--manifest-base64");
  if (sourceProbe >= 0) {
    const bytes = decodeBoundedBase64(process.argv[sourceProbe + 1] ?? "", sourceMaxBytes, "source probe");
    auditSourceText(decodeBoundedUtf8(bytes, sourceMaxBytes, "source probe"));
  } else if (manifestProbe >= 0) {
    const bytes = decodeBoundedBase64(process.argv[manifestProbe + 1] ?? "", configMaxBytes, "manifest probe");
    auditManifest(parseBoundedJsonText(decodeBoundedUtf8(bytes, configMaxBytes, "manifest probe"), configMaxBytes, "manifest probe"));
  }
  else auditExtensionExamples(process.argv[2] ? resolve(process.argv[2]) : defaultRoot);
  console.log("extension example audit: ok");
}
