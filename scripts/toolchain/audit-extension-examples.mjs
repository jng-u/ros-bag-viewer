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
const deniedRuntimeNames = new Set(["eval", "Function", "require", "globalThis", "Reflect"]);
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
  const rootScope = { parent: undefined, bindings: new Set() };
  const scopeByNode = new WeakMap();
  const declaredLocals = new Set();
  const bindName = (scope, name, local = false) => {
    if (ts.isIdentifier(name)) {
      scope.bindings.add(name.text);
      if (local) declaredLocals.add(name.text);
    }
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) if (ts.isBindingElement(element)) bindName(scope, element.name, local);
    }
  };
  const collectBindings = (node, scope) => {
    scopeByNode.set(node, scope);
    if ((ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) && node.name) bindName(scope, node.name);
    if (ts.isImportClause(node) && node.name) bindName(scope, node.name);
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      if (node.name) bindName(scope, node.name, !ts.isImportSpecifier(node));
    }
    if (ts.isFunctionDeclaration(node) && node.name) bindName(scope, node.name, true);
    if (ts.isFunctionLike(node)) {
      const functionScope = { parent: scope, bindings: new Set() };
      scopeByNode.set(node, functionScope);
      if (ts.isFunctionExpression(node) && node.name) bindName(functionScope, node.name, true);
      for (const parameter of node.parameters) collectBindings(parameter, functionScope);
      if (node.body) collectBindings(node.body, functionScope);
      return;
    }
    if (node !== file && (ts.isBlock(node) || ts.isCaseBlock(node) || ts.isCatchClause(node) || ts.isModuleBlock(node))) {
      const blockScope = { parent: scope, bindings: new Set() };
      scopeByNode.set(node, blockScope);
      ts.forEachChild(node, (child) => collectBindings(child, blockScope));
      return;
    }
    ts.forEachChild(node, (child) => collectBindings(child, scope));
  };
  collectBindings(file, rootScope);
  const isBoundAt = (node, name) => {
    let scope = scopeByNode.get(node);
    while (scope) {
      if (scope.bindings.has(name)) return true;
      scope = scope.parent;
    }
    return false;
  };
  const rootIdentifier = (expression) => {
    let current = expression;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
    while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
    return ts.isIdentifier(current) ? current.text : undefined;
  };
  let extensionApiImport = false;
  let extensionDefinitionExports = 0;
  const importedSymbols = new Map();
  const isDirectImportedCall = (expression, importedName) =>
    ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
    importedSymbols.get(expression.expression.text) === importedName;
  const returnedExpressions = (callback) => {
    if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return undefined;
    if (!ts.isBlock(callback.body)) return [callback.body];
    const returns = [];
    const collectReturns = (node) => {
      if (node !== callback && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) {
        if (!node.expression) return;
        returns.push(node.expression);
        return;
      }
      ts.forEachChild(node, collectReturns);
    };
    collectReturns(callback.body);
    return returns;
  };
  const isBoundExtensionDefinition = (initializer) => {
    if (!isDirectImportedCall(initializer, "defineTrustedExtension")) return false;
    const callback = initializer.arguments[1];
    if (!callback) return false;
    const returns = returnedExpressions(callback);
    return returns !== undefined && returns.length > 0 &&
      returns.every((expression) => isDirectImportedCall(expression, "defineTrustedLifecycle"));
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) fail(`${filename} has a non-literal module specifier`);
      assertModule(node.moduleSpecifier.text, filename, resolveRelative);
      if (ts.isExportDeclaration(node) && node.moduleSpecifier.text === allowedModule) fail(`${filename} must not re-export the host API`);
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === allowedModule) {
        const clause = node.importClause;
        if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
          fail(`${filename} must use exact named extension-api imports`);
        }
        for (const element of clause.namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (!allowedExtensionImports.has(imported)) fail(`${filename} imports unsupported extension-api symbol ${imported}`);
          if (importedSymbols.has(element.name.text)) fail(`${filename} duplicates extension-api binding ${element.name.text}`);
          importedSymbols.set(element.name.text, imported);
          if (["defineTrustedExtension", "defineTrustedLifecycle"].includes(imported) && (clause.isTypeOnly || element.isTypeOnly)) {
            fail(`${filename} imports runtime builder ${imported} as type-only`);
          }
        }
        extensionApiImport = true;
      }
    }
    if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (!ts.isExternalModuleReference(reference) || !reference.expression || !ts.isStringLiteral(reference.expression)) {
        fail(`${filename} uses denied import-equals syntax`);
      }
      assertModule(reference.expression.text, filename, resolveRelative);
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && !isBoundAt(node, node.expression.text) && !safeStandardGlobals.has(node.expression.text)) {
        fail(`${filename} calls unbound ambient ${node.expression.text}`);
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) fail(`${filename} uses dynamic import`);
      if (ts.isIdentifier(node.expression) && ["require", "eval", "Function"].includes(node.expression.text)) {
        fail(`${filename} calls ${node.expression.text}`);
      }
      if (ts.isPropertyAccessExpression(node.expression) &&
          ((ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "require") ||
           (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "module" && node.expression.name.text === "require"))) {
        fail(`${filename} uses a runtime module loader`);
      }
      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Reflect") {
        fail(`${filename} uses computed reflection`);
      }
      if (ts.isPropertyAccessExpression(node.expression) && deniedRuntimeProperties.has(node.expression.name.text)) {
        fail(`${filename} acquires a runtime descriptor`);
      }
    }
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && !isBoundAt(node, node.tag.text)) {
      fail(`${filename} calls unbound ambient tag ${node.tag.text}`);
    }
    if (ts.isNewExpression(node)) {
      if (!ts.isIdentifier(node.expression) || node.expression.text !== "Error") {
        fail(`${filename} constructs a non-approved runtime object`);
      }
    }
    if (ts.isPropertyAccessExpression(node) && deniedRuntimeProperties.has(node.name.text)) {
      fail(`${filename} accesses denied runtime property ${node.name.text}`);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const root = rootIdentifier(node);
      if (root !== undefined && !isBoundAt(node, root) && !safeStandardGlobals.has(root)) {
        fail(`${filename} references unbound ambient ${root}`);
      }
    }
    if (ts.isBindingElement(node) && node.propertyName !== undefined) {
      const property = constantString(node.propertyName);
      if (property === undefined || deniedRuntimeProperties.has(property)) fail(`${filename} destructures a denied or computed runtime property`);
    }
    if (ts.isIdentifier(node) && privilegedNames.has(node.text)) fail(`${filename} references privileged ${node.text}`);
    if (ts.isIdentifier(node) && deniedRuntimeNames.has(node.text)) fail(`${filename} references denied runtime ${node.text}`);
    if (ts.isElementAccessExpression(node)) {
      const property = node.argumentExpression === undefined ? undefined : constantString(node.argumentExpression);
      if (property === undefined) fail(`${filename} uses unresolved computed access`);
      if (deniedRuntimeProperties.has(property) || deniedRuntimeNames.has(property) || privilegedNames.has(property)) {
        fail(`${filename} accesses denied computed property ${property}`);
      }
    }
    const exported = node.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!filename.endsWith(".d.ts") && exported) {
      if (ts.isVariableStatement(node)) {
        if (node.declarationList.declarations.length !== 1) fail(`${filename} exports multiple runtime bindings`);
        const declaration = node.declarationList.declarations[0];
        if (declaration?.initializer && isBoundExtensionDefinition(declaration.initializer)) {
          extensionDefinitionExports += 1;
        } else fail(`${filename} must export a definition whose create callback directly returns the exact imported lifecycle builder result`);
      } else if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) {
        fail(`${filename} exports unsupported runtime declaration`);
      }
    }
    if (!filename.endsWith(".d.ts") && (ts.isExportAssignment(node) ||
        ts.isExportDeclaration(node) && node.moduleSpecifier === undefined)) {
      fail(`${filename} uses an unsupported runtime export`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if ([...importedSymbols.keys()].some((name) => declaredLocals.has(name))) {
    fail(`${filename} shadows an imported extension-api symbol`);
  }
  if (!filename.endsWith(".d.ts") && (!extensionApiImport || extensionDefinitionExports !== 1 ||
      ![...importedSymbols.values()].includes("defineTrustedExtension") || ![...importedSymbols.values()].includes("defineTrustedLifecycle"))) {
    fail(`${filename} must call the exact imported builders and export one defineTrustedExtension result`);
  }
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
