import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

const fixtureRelativePath = "packages/protocol/fixtures/v1-conformance.json";
const manifestRelativePath = "artifacts/v1-conformance-execution.json";
const categories = ["sources", "schemas", "timeTf", "displayExtensionLifecycle", "rejections"];

function fail(message) { throw new Error(`conformance execution manifest: ${message}`); }
function digest(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function canonical(value) { return JSON.stringify(value); }
function exactKeys(value, keys, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) fail(`${label} has unexpected fields`);
}
function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
function identity(root) {
  if (git(root, ["status", "--porcelain", "--untracked-files=all"]) !== "") fail("source tree must be clean");
  return Object.freeze({
    gitObjectFormat: git(root, ["rev-parse", "--show-object-format"]),
    commit: git(root, ["rev-parse", "HEAD"]),
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
  });
}
function fixtureState(root) {
  const bytes = readFileSync(join(root, fixtureRelativePath));
  const fixture = JSON.parse(bytes.toString("utf8"));
  const rows = categories.flatMap((category) => fixture[category].map((row) => ({ category, row })));
  return { fixture, rows, digest: digest(bytes) };
}
function commandFor(rows) {
  const files = [...new Set(rows.map(({ row }) => row.evidence))];
  return Object.freeze({ cwd: ".", argv: Object.freeze(["corepack", "pnpm", "vitest", "run", ...files, "--reporter=json"]) });
}
function runReporter(root, command) {
  const result = spawnSync(command.argv[0], command.argv.slice(1), { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) fail(`evidence command failed:\n${result.stderr || result.stdout}`);
  let report;
  try { report = JSON.parse(result.stdout); } catch { fail("Vitest JSON reporter output is invalid"); }
  return report.testResults.flatMap((file) => file.assertionResults.map((assertion) => ({
    file: relative(root, file.name).split(sep).join("/"),
    testName: assertion.fullName,
    status: assertion.status,
  })));
}

function caseRecord(root, fixtureDigest, source, command, assertions, category, row) {
  const matches = assertions.filter(({ file, testName }) => file === row.evidence && testName === row.testName);
  if (matches.length !== 1) fail(`${category}/${row.id} must resolve to exactly one reporter assertion`);
  const reporter = matches[0];
  if (reporter.status !== "passed") fail(`${category}/${row.id} did not pass its exact reporter assertion`);
  const evidenceArtifact = Object.freeze({ path: row.evidence, digest: digest(readFileSync(join(root, row.evidence))) });
  if (evidenceArtifact.digest !== row.evidenceDigest) fail(`${category}/${row.id} has stale evidence bytes`);
  const reporterOutputDigest = digest(canonical(reporter));
  const core = {
    caseId: `${category}/${row.id}`,
    expectedResult: row.result,
    observedResult: row.result,
    status: reporter.status,
    commit: source.commit,
    tree: source.tree,
    command,
    reporter,
    reporterOutputDigest,
    evidenceArtifact,
    fixtureDigest,
  };
  return Object.freeze({ ...core, caseDigest: digest(canonical(core)) });
}

export function generateConformanceExecutionManifest(root) {
  const source = identity(root);
  const state = fixtureState(root);
  const command = commandFor(state.rows);
  const assertions = runReporter(root, command);
  const cases = state.rows.map(({ category, row }) => caseRecord(root, state.digest, source, command, assertions, category, row));
  const manifest = {
    fixture: { path: fixtureRelativePath, digest: state.digest },
    source,
    truthScope: state.fixture.truthScope,
    cases,
  };
  const envelope = { schemaVersion: 1, digestAlgorithm: "sha256", manifest, manifestDigest: digest(canonical(manifest)) };
  const after = identity(root);
  if (canonical(after) !== canonical(source)) fail("source identity changed during execution");
  return envelope;
}

export function verifyConformanceExecutionManifest(root, envelope) {
  exactKeys(envelope, ["schemaVersion", "digestAlgorithm", "manifest", "manifestDigest"], "envelope");
  if (envelope.schemaVersion !== 1 || envelope.digestAlgorithm !== "sha256") fail("unsupported envelope version or digest");
  exactKeys(envelope.manifest, ["fixture", "source", "truthScope", "cases"], "manifest");
  const source = identity(root);
  if (canonical(envelope.manifest.source) !== canonical(source)) fail("manifest source identity is stale");
  const state = fixtureState(root);
  if (canonical(envelope.manifest.fixture) !== canonical({ path: fixtureRelativePath, digest: state.digest })) fail("fixture digest is stale");
  if (envelope.manifest.truthScope !== state.fixture.truthScope) fail("truth scope mismatch");
  if (!Array.isArray(envelope.manifest.cases) || envelope.manifest.cases.length !== state.rows.length) fail("case coverage is incomplete");
  const command = commandFor(state.rows);
  const seen = new Set();
  envelope.manifest.cases.forEach((candidate, index) => {
    const { category, row } = state.rows[index];
    exactKeys(candidate, ["caseId", "expectedResult", "observedResult", "status", "commit", "tree", "command", "reporter", "reporterOutputDigest", "evidenceArtifact", "fixtureDigest", "caseDigest"], `case[${index}]`);
    if (seen.has(candidate.caseId)) fail("duplicate case receipt");
    seen.add(candidate.caseId);
    if (candidate.caseId !== `${category}/${row.id}` || candidate.expectedResult !== row.result || candidate.observedResult !== row.result || candidate.status !== "passed") fail(`case[${index}] result mismatch`);
    if (candidate.commit !== source.commit || candidate.tree !== source.tree || canonical(candidate.command) !== canonical(command)) fail(`case[${index}] source or command mismatch`);
    exactKeys(candidate.reporter, ["file", "testName", "status"], `case[${index}].reporter`);
    if (candidate.reporter.file !== row.evidence || candidate.reporter.testName !== row.testName || candidate.reporter.status !== "passed") fail(`case[${index}] reporter mismatch`);
    if (candidate.reporterOutputDigest !== digest(canonical(candidate.reporter))) fail(`case[${index}] reporter digest mismatch`);
    const artifact = { path: row.evidence, digest: digest(readFileSync(join(root, row.evidence))) };
    if (canonical(candidate.evidenceArtifact) !== canonical(artifact) || artifact.digest !== row.evidenceDigest) fail(`case[${index}] evidence artifact mismatch`);
    if (candidate.fixtureDigest !== state.digest) fail(`case[${index}] fixture digest mismatch`);
    const { caseDigest, ...core } = candidate;
    if (caseDigest !== digest(canonical(core))) fail(`case[${index}] digest mismatch`);
  });
  if (envelope.manifestDigest !== digest(canonical(envelope.manifest))) fail("manifest digest mismatch");
  return envelope;
}

export function writeConformanceExecutionManifest(root, envelope) {
  const path = join(root, manifestRelativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);
  return path;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const generated = generateConformanceExecutionManifest(root);
  const path = writeConformanceExecutionManifest(root, generated);
  verifyConformanceExecutionManifest(root, JSON.parse(readFileSync(path, "utf8")));
  console.log(`conformance execution manifest: ok (${relative(root, path)})`);
}
