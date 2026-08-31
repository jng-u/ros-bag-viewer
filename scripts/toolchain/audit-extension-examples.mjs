import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

import ts from "typescript";

const defaultRoot = fileURLToPath(new URL("../..", import.meta.url));
const allowedModule = "@ros-web-viewer/extension-api";
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const privilegedNames = new Set([
  "Worker", "WebSocket", "localStorage", "sessionStorage", "indexedDB", "fetch", "document", "window", "navigator",
  "WebGL2RenderingContext", "OffscreenCanvas", "SharedArrayBuffer", "process", "Deno", "Bun",
  "publish", "callService", "sendAction", "setParameter", "rawCommand",
  "global", "self", "WebAssembly", "Atomics",
]);
const deniedRuntimeNames = new Set(["eval", "Function", "require", "globalThis", "Reflect", "constructor", "prototype", "__proto__"]);

function fail(message) { throw new Error(`extension example audit: ${message}`); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }

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
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) fail(`${filename} has a non-literal module specifier`);
      assertModule(node.moduleSpecifier.text, filename, resolveRelative);
    }
    if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (!ts.isExternalModuleReference(reference) || !reference.expression || !ts.isStringLiteral(reference.expression)) {
        fail(`${filename} uses denied import-equals syntax`);
      }
      assertModule(reference.expression.text, filename, resolveRelative);
    }
    if (ts.isCallExpression(node)) {
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
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "getOwnPropertyDescriptor") {
        fail(`${filename} acquires a runtime descriptor`);
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      fail(`${filename} constructs Function`);
    }
    if (ts.isPropertyAccessExpression(node) && ["constructor", "prototype", "__proto__"].includes(node.name.text)) {
      fail(`${filename} accesses denied runtime property ${node.name.text}`);
    }
    if (ts.isIdentifier(node) && privilegedNames.has(node.text)) fail(`${filename} references privileged ${node.text}`);
    if (ts.isIdentifier(node) && deniedRuntimeNames.has(node.text)) fail(`${filename} references denied runtime ${node.text}`);
    if (ts.isElementAccessExpression(node)) fail(`${filename} uses computed ambient access`);
    ts.forEachChild(node, visit);
  };
  visit(file);
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

function emitAuditedPackage(packageRoot, configPath, manifest) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "extension-example-audit-"));
  try {
    const outputRoot = join(temporaryRoot, "dist");
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) fail(`${configPath} cannot be read by TypeScript`);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, packageRoot, {
      composite: false,
      declaration: true,
      declarationMap: false,
      incremental: false,
      outDir: outputRoot,
      sourceMap: false,
      tsBuildInfoFile: join(temporaryRoot, "build.tsbuildinfo"),
    }, configPath);
    if (parsed.errors.length > 0) fail(`${configPath} contains TypeScript configuration errors`);
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
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
      const bytes = readFileSync(path);
      if (sourceExtensions.has(extname(path)) || path.endsWith(".d.ts")) {
        auditSourceText(bytes.toString("utf8"), `${packageRoot}/dist/${name}`, (specifier) => {
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
      packageState.manifest = JSON.parse(readFileSync(path, "utf8"));
      auditManifest(packageState.manifest, entry.path);
    } else if (name === "tsconfig.json") {
      packageState.configPath = path;
      auditTsconfig(JSON.parse(readFileSync(path, "utf8")), entry.path);
    }
    else if (sourceExtensions.has(extname(name))) auditSourceText(readFileSync(path, "utf8"), entry.path, (specifier) => {
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
    const first = emitAuditedPackage(packageRoot, packageState.configPath, packageState.manifest);
    const second = emitAuditedPackage(packageRoot, packageState.configPath, packageState.manifest);
    if (JSON.stringify(first) !== JSON.stringify(second)) fail(`${relative(root, packageRoot)} does not emit reproducibly`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sourceProbe = process.argv.indexOf("--source-base64");
  const manifestProbe = process.argv.indexOf("--manifest-base64");
  if (sourceProbe >= 0) auditSourceText(Buffer.from(process.argv[sourceProbe + 1] ?? "", "base64").toString("utf8"));
  else if (manifestProbe >= 0) auditManifest(JSON.parse(Buffer.from(process.argv[manifestProbe + 1] ?? "", "base64").toString("utf8")));
  else auditExtensionExamples(process.argv[2] ? resolve(process.argv[2]) : defaultRoot);
  console.log("extension example audit: ok");
}
