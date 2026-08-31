import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";

import {
  V1_CONFORMANCE_DETERMINISTIC_REPORTER,
  V1_CONFORMANCE_PRODUCTION_PROBES,
  v1ConformanceProductionCommand,
  v1ConformanceProductionProbe,
} from "./v1-conformance-production-probes.mjs";

const fixtureRelativePath = "packages/protocol/fixtures/v1-conformance.json";
const manifestRelativePath = "artifacts/v1-conformance-execution.json";
const executionEvidence = "packages/protocol/test/v1-execution-cases.test.ts";
const registryRelativePath = "scripts/toolchain/v1-conformance-production-probes.mjs";
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
function executionTestName(caseId) { return `v1 execution receipts observes ${caseId}`; }
function exactPattern(value) { return `^${value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`; }
function commandForCase(caseId) {
  const receipt = `artifacts/v1-conformance-receipts/${digest(caseId).slice("sha256:".length)}.json`;
  return Object.freeze({
    cwd: ".",
    argv: Object.freeze([
      process.execPath,
      "node_modules/vitest/vitest.mjs",
      "run",
      executionEvidence,
      "-t",
      exactPattern(executionTestName(caseId)),
      `--reporter=./${V1_CONFORMANCE_DETERMINISTIC_REPORTER}`,
      "--maxWorkers=1",
    ]),
    env: Object.freeze({
      CI: "1",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NODE_OPTIONS: "",
      NO_COLOR: "1",
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      TZ: "UTC",
      V1_CONFORMANCE_CASE_ID: caseId,
      V1_CONFORMANCE_RECEIPT_PATH: receipt,
    }),
  });
}
function normalizedReport(raw, label) {
  let report;
  try { report = JSON.parse(raw); } catch { fail(`${label} is invalid JSON`); }
  exactKeys(report, ["schemaVersion", "reason", "unhandledErrors", "assertions"], label);
  if (report.schemaVersion !== 1 || report.reason !== "passed" || report.unhandledErrors !== 0 ||
      !Array.isArray(report.assertions) || report.assertions.length !== 1) fail(`${label} is not one passing assertion`);
  exactKeys(report.assertions[0], ["file", "testName", "status"], `${label}.assertions[0]`);
  if (report.assertions[0].status !== "passed") fail(`${label} assertion did not pass`);
  return { report, assertion: report.assertions[0] };
}
function runReporter(root, command) {
  const receiptPath = join(root, command.env.V1_CONFORMANCE_RECEIPT_PATH);
  rmSync(receiptPath, { force: true });
  const result = spawnSync(command.argv[0], command.argv.slice(1), {
    cwd: join(root, command.cwd),
    maxBuffer: 64 * 1024 * 1024,
    env: command.env,
  });
  const reporterRaw = result.stdout.toString("utf8");
  if (result.status !== 0) fail(`evidence command failed:\n${result.stderr.toString("utf8") || reporterRaw}`);
  const { assertion } = normalizedReport(reporterRaw, "outer reporter output");
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptPath, "utf8")); } catch { fail("case command did not emit one semantic receipt"); }
  return { reporterRaw, assertion, receipt };
}
function artifact(root, path) { return Object.freeze({ path, digest: digest(readFileSync(join(root, path))) }); }
function executionArtifacts(root) {
  return Object.freeze([
    artifact(root, executionEvidence),
    artifact(root, registryRelativePath),
    artifact(root, V1_CONFORMANCE_DETERMINISTIC_REPORTER),
  ]);
}
function validateSemanticReceipt(receipt, caseId) {
  exactKeys(receipt, [
    "schemaVersion", "caseId", "observedResult", "diagnostic", "productionCommand", "productionAssertion",
    "productionReporterRaw", "productionReporterRawDigest", "productionAssertionDigest",
  ], `${caseId} semantic receipt`);
  const probe = v1ConformanceProductionProbe(caseId);
  if (receipt.schemaVersion !== 1 || receipt.caseId !== caseId || receipt.observedResult !== probe.observedResult) {
    fail(`${caseId} emitted an invalid independently observed result`);
  }
  if (typeof receipt.diagnostic !== "string" || receipt.diagnostic.length === 0 ||
      Buffer.byteLength(receipt.diagnostic, "utf8") > 512) fail(`${caseId} diagnostic is invalid or oversized`);
  if (canonical(receipt.productionCommand) !== canonical(v1ConformanceProductionCommand(caseId))) {
    fail(`${caseId} production command mismatch`);
  }
  const { assertion } = normalizedReport(receipt.productionReporterRaw, `${caseId} production reporter output`);
  if (canonical(assertion) !== canonical(receipt.productionAssertion) ||
      assertion.file !== probe.evidence || assertion.testName !== probe.testName || assertion.status !== "passed") {
    fail(`${caseId} production assertion mismatch`);
  }
  if (receipt.productionReporterRawDigest !== digest(receipt.productionReporterRaw) ||
      receipt.productionAssertionDigest !== digest(canonical(receipt.productionAssertion))) {
    fail(`${caseId} production reporter or assertion digest mismatch`);
  }
  return probe;
}
function validateRegistry(state) {
  const fixtureIds = state.rows.map(({ category, row }) => `${category}/${row.id}`);
  const registryIds = V1_CONFORMANCE_PRODUCTION_PROBES.map(({ caseId }) => caseId);
  if (new Set(fixtureIds).size !== fixtureIds.length || new Set(registryIds).size !== registryIds.length ||
      canonical(registryIds) !== canonical(fixtureIds)) fail("fixture and production registry must be bijective and ordered");
  const assertions = new Set();
  state.rows.forEach(({ category, row }, index) => {
    const probe = V1_CONFORMANCE_PRODUCTION_PROBES[index];
    const caseId = `${category}/${row.id}`;
    if (probe.caseId !== caseId || probe.evidence !== row.evidence || probe.testName !== row.testName) {
      fail(`${caseId} production probe identity is stale`);
    }
    const assertion = `${probe.evidence}\0${probe.testName}`;
    if (assertions.has(assertion)) fail(`${caseId} reuses a production assertion`);
    assertions.add(assertion);
  });
}
function caseRecord(root, fixtureDigest, source, category, row) {
  const caseId = `${category}/${row.id}`;
  const command = commandForCase(caseId);
  const { reporterRaw, assertion, receipt } = runReporter(root, command);
  if (assertion.file !== executionEvidence || assertion.testName !== executionTestName(caseId)) fail(`${caseId} outer reporter identity mismatch`);
  const probe = validateSemanticReceipt(receipt, caseId);
  if (receipt.observedResult !== row.result) fail(`${caseId} observed result does not match the fixture expectation`);
  const evidenceArtifact = artifact(root, row.evidence);
  if (evidenceArtifact.digest !== row.evidenceDigest) fail(`${caseId} has stale evidence bytes`);
  const core = {
    caseId,
    expectedResult: row.result,
    observedResult: receipt.observedResult,
    status: assertion.status,
    commit: source.commit,
    tree: source.tree,
    command,
    executionEnvironmentDigest: digest(canonical(command.env)),
    reporterRaw,
    reporterRawDigest: digest(reporterRaw),
    reporter: assertion,
    normalizedAssertionDigest: digest(canonical(assertion)),
    semanticReceipt: receipt,
    semanticReceiptDigest: digest(canonical(receipt)),
    productionProbe: probe,
    evidenceArtifact,
    executionArtifacts: executionArtifacts(root),
    fixtureDigest,
  };
  return Object.freeze({ ...core, caseDigest: digest(canonical(core)) });
}

export function generateConformanceExecutionManifest(root) {
  const source = identity(root);
  const state = fixtureState(root);
  validateRegistry(state);
  const commands = state.rows.map(({ category, row }) => canonical(commandForCase(`${category}/${row.id}`)));
  if (new Set(commands).size !== commands.length) fail("case commands must be bijective");
  const cases = state.rows.map(({ category, row }) => caseRecord(root, state.digest, source, category, row));
  const manifest = {
    fixture: { path: fixtureRelativePath, digest: state.digest },
    source,
    truthScope: state.fixture.truthScope,
    cases,
  };
  const envelope = { schemaVersion: 1, digestAlgorithm: "sha256", manifest, manifestDigest: digest(canonical(manifest)) };
  if (canonical(identity(root)) !== canonical(source)) fail("source identity changed during execution");
  return envelope;
}

export function verifyConformanceExecutionManifest(root, envelope) {
  exactKeys(envelope, ["schemaVersion", "digestAlgorithm", "manifest", "manifestDigest"], "envelope");
  if (envelope.schemaVersion !== 1 || envelope.digestAlgorithm !== "sha256") fail("unsupported envelope version or digest");
  exactKeys(envelope.manifest, ["fixture", "source", "truthScope", "cases"], "manifest");
  const source = identity(root);
  if (canonical(envelope.manifest.source) !== canonical(source)) fail("manifest source identity is stale");
  const state = fixtureState(root);
  validateRegistry(state);
  if (canonical(envelope.manifest.fixture) !== canonical({ path: fixtureRelativePath, digest: state.digest })) fail("fixture digest is stale");
  if (envelope.manifest.truthScope !== state.fixture.truthScope) fail("truth scope mismatch");
  if (!Array.isArray(envelope.manifest.cases) || envelope.manifest.cases.length !== state.rows.length) fail("case coverage is incomplete");
  const commands = new Set();
  const reporters = new Set();
  const receipts = new Set();
  envelope.manifest.cases.forEach((candidate, index) => {
    const { category, row } = state.rows[index];
    const caseId = `${category}/${row.id}`;
    exactKeys(candidate, [
      "caseId", "expectedResult", "observedResult", "status", "commit", "tree", "command", "executionEnvironmentDigest",
      "reporterRaw", "reporterRawDigest", "reporter", "normalizedAssertionDigest", "semanticReceipt", "semanticReceiptDigest",
      "productionProbe", "evidenceArtifact", "executionArtifacts", "fixtureDigest", "caseDigest",
    ], `case[${index}]`);
    if (candidate.caseId !== caseId || candidate.expectedResult !== row.result || candidate.observedResult !== row.result || candidate.status !== "passed") {
      fail(`case[${index}] result mismatch`);
    }
    const command = commandForCase(caseId);
    if (candidate.commit !== source.commit || candidate.tree !== source.tree || canonical(candidate.command) !== canonical(command)) {
      fail(`case[${index}] source or command mismatch`);
    }
    if (commands.has(canonical(candidate.command))) fail("duplicate case command");
    commands.add(canonical(candidate.command));
    if (candidate.executionEnvironmentDigest !== digest(canonical(command.env))) fail(`case[${index}] environment digest mismatch`);
    const { assertion } = normalizedReport(candidate.reporterRaw, `case[${index}] reporter output`);
    if (candidate.reporterRawDigest !== digest(candidate.reporterRaw) || canonical(candidate.reporter) !== canonical(assertion) ||
        candidate.normalizedAssertionDigest !== digest(canonical(assertion)) || assertion.file !== executionEvidence ||
        assertion.testName !== executionTestName(caseId)) fail(`case[${index}] reporter binding mismatch`);
    if (reporters.has(canonical(assertion))) fail("duplicate reporter assertion");
    reporters.add(canonical(assertion));
    const probe = validateSemanticReceipt(candidate.semanticReceipt, caseId);
    if (candidate.semanticReceiptDigest !== digest(canonical(candidate.semanticReceipt)) ||
        candidate.observedResult !== candidate.semanticReceipt.observedResult || canonical(candidate.productionProbe) !== canonical(probe)) {
      fail(`case[${index}] semantic receipt mismatch`);
    }
    if (receipts.has(candidate.semanticReceipt.caseId)) fail("duplicate semantic receipt");
    receipts.add(candidate.semanticReceipt.caseId);
    const evidenceArtifact = artifact(root, row.evidence);
    if (canonical(candidate.evidenceArtifact) !== canonical(evidenceArtifact) || evidenceArtifact.digest !== row.evidenceDigest) {
      fail(`case[${index}] evidence artifact mismatch`);
    }
    if (canonical(candidate.executionArtifacts) !== canonical(executionArtifacts(root))) fail(`case[${index}] execution artifacts mismatch`);
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
