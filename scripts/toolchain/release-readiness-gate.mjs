import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { repositoryStopReason } from "./repository-stop-policy.mjs";
import {
  generateConformanceExecutionManifest,
  verifyConformanceExecutionManifest,
  writeConformanceExecutionManifest,
} from "./conformance-execution-manifest.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const evidencePath = join(root, "docs/evidence/m5-release-readiness.json");

function fail(message) {
  throw new Error(`release readiness gate: ${message}`);
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", "node_modules", "coverage"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function requireNonEmptyStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || value.length === 0)) {
    fail(`${label} must be a non-empty string list`);
  }
}

function validateEvidence(evidence) {
  if (evidence.schemaVersion !== 1) fail("unsupported evidence schema");
  if (evidence.releaseDecision !== "blocked") fail("release must remain blocked while AC-15/16 exceptions and AC-17 authorization are unresolved");
  if (evidence.evidenceBoundary?.browserOsRosNetworkProductionCertified !== false) fail("production certification boundary must remain false");
  if (evidence.protocolSchemaV1?.status !== "pass-local-synthetic" || evidence.protocolSchemaV1?.frozen !== true) {
    fail("protocol/schema v1 must reference the passing exact local conformance fixture before freeze");
  }
  if (evidence.protocolSchemaV1?.productionCertification !== false) fail("protocol/schema v1 fixture must not claim production certification");
  if (evidence.protocolSchemaV1?.executionManifest !== "artifacts/v1-conformance-execution.json" ||
      evidence.protocolSchemaV1?.generatedAndVerifiedBy !== "corepack pnpm release:readiness:full") {
    fail("protocol/schema v1 must bind its generated execution manifest verifier");
  }

  const expectedIds = Array.from({ length: 17 }, (_, index) => `AC-${String(index + 1).padStart(2, "0")}`);
  const criteria = evidence.acceptanceCriteria;
  if (!Array.isArray(criteria) || criteria.map(({ id }) => id).join(",") !== expectedIds.join(",")) {
    fail("AC-01 through AC-17 must appear exactly once and in order");
  }

  for (const criterion of criteria) {
    if (typeof criterion.status !== "string" || criterion.status.length === 0) fail(`${criterion.id} is missing status`);
    if (typeof criterion.evidenceClass !== "string" || criterion.evidenceClass.length === 0) fail(`${criterion.id} is missing evidence class`);
    requireNonEmptyStrings(criterion.commands, `${criterion.id}.commands`);
    requireNonEmptyStrings(criterion.artifacts, `${criterion.id}.artifacts`);
    if (typeof criterion.limitation !== "string" || criterion.limitation.length === 0) fail(`${criterion.id} must state its limitation`);
    for (const artifact of criterion.artifacts) {
      if (!existsSync(join(root, artifact))) fail(`${criterion.id} references missing artifact ${artifact}`);
    }
  }

  for (const criterion of criteria.slice(0, 14)) {
    if (!criterion.status.startsWith("pass-")) fail(`${criterion.id} must pass its explicitly classified repository gate`);
  }

  for (const id of ["AC-15", "AC-16"]) {
    const criterion = criteria.find((entry) => entry.id === id);
    if (criterion.status.startsWith("pass-")) continue;
    if (criterion.status !== "release-blocking-exception") fail(`${id} must pass or carry a release-blocking exception`);
    const exception = criterion.exception;
    if (!exception || exception.effect !== "blocks-release" || !exception.owner || !/^\d{4}-\d{2}-\d{2}$/.test(exception.expiresOn)) {
      fail(`${id} exception must name an owner, concrete expiry, and blocks-release effect`);
    }
    if (exception.expiresOn <= evidence.recordedAt) fail(`${id} exception expiry must be later than the evidence date`);
  }

  const ac17 = criteria.find(({ id }) => id === "AC-17");
  if (ac17.status !== "unauthorized") fail("AC-17 must remain explicitly unauthorized");
  const requiredStops = [
    "public-name-selection",
    "license-selection",
    "package-publication",
    "repository-publication",
    "paid-infrastructure",
    "credential-provisioning",
    "external-deployment",
    "production-deployment",
  ];
  if (ac17.prohibitedActions?.join(",") !== requiredStops.join(",")) fail("AC-17 stop actions are incomplete or reordered");

  if (evidence.browserCompatibility?.classification !== "target-matrix-not-certified") fail("browser matrix must remain non-certified until exact executions exist");
  if (!evidence.browserCompatibility.rows?.every(({ status }) => status === "not-executed")) fail("target browser rows cannot imply execution");
  requireNonEmptyStrings(evidence.browserCompatibility.requiredEnvironmentFields, "browserCompatibility.requiredEnvironmentFields");

  const recoveryScenarios = new Set(evidence.failureRecovery?.map(({ scenario }) => scenario));
  for (const required of ["webgl-context-loss", "parser-or-source-failure", "relay-or-edge-disconnect", "hosted-expiry-revocation-deletion", "resource-cleanup"]) {
    if (!recoveryScenarios.has(required)) fail(`missing failure-recovery scenario ${required}`);
  }
  if (evidence.failureRecovery.find(({ scenario }) => scenario === "webgl-context-loss")?.status !== "release-blocked-not-browser-tested") {
    fail("WebGL context-loss evidence must remain blocked until a real browser test exists");
  }

  if (evidence.accessibility?.manualBrowserReviewStatus !== "missing-release-blocker") fail("manual browser accessibility evidence cannot be waived");
  if (evidence.security?.productionCertification !== false) fail("security evidence must not claim production certification");
  if (evidence.supplyChain?.publicationLicenseSelected !== false) fail("supply-chain inventory must not select a public license");
  if (evidence.benchmark?.browserBenchmarkResult !== false || evidence.benchmark?.productionHardwareResult !== false) {
    fail("deterministic benchmark must not claim browser or production hardware results");
  }
  if (evidence.cleanTreeReproducibility?.required !== true) fail("clean-tree reproducibility must be mandatory");
}

function validateRepositoryStops() {
  for (const path of listFiles(root)) {
    const repositoryPath = relative(root, path);
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    const stopReason = repositoryStopReason(repositoryPath);
    if (stopReason !== undefined) fail(`unauthorized ${stopReason} file ${repositoryPath}`);
    if (name !== "package.json") continue;
    const packageJson = JSON.parse(readFileSync(path, "utf8"));
    if (packageJson.private !== true) fail(`${relative(root, path)} must remain private`);
    if (packageJson.publishConfig !== undefined || packageJson.homepage !== undefined) fail(`${relative(root, path)} configures unauthorized publication`);
  }

  if (!existsSync(join(root, "pnpm-lock.yaml"))) fail("frozen lockfile is missing");
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(rootPackage.packageManager ?? "")) fail("packageManager must pin an exact pnpm version");
  run(process.execPath, ["scripts/toolchain/audit-extension-examples.mjs"]);
}

function validateGeneratedSupplyChainArtifacts() {
  const licenses = JSON.parse(readFileSync(join(root, "artifacts/licenses.json"), "utf8"));
  if (licenses.schemaVersion !== 1 || !Array.isArray(licenses.packages) || licenses.packages.length === 0) fail("generated license inventory is incomplete");
  if (licenses.packages.some(({ name, version, license }) => !name || !version || !license)) fail("generated license inventory contains an incomplete package");

  const sbom = JSON.parse(readFileSync(join(root, "artifacts/sbom.cdx.json"), "utf8"));
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5" || !Array.isArray(sbom.components) || sbom.components.length === 0) {
    fail("generated CycloneDX SBOM is incomplete");
  }
}

function checkCleanTree() {
  const command = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  if (command.status !== 0) fail(`git status failed: ${command.stderr.trim()}`);
  if (command.stdout.trim().length > 0) fail(`tree is dirty:\n${command.stdout.trim()}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
}

function checkReproducibility() {
  run(process.execPath, ["benchmarks/scenarios/run-m1-dimensional.mjs", "--check"]);

  for (const { generator, artifact } of [
    { generator: "scripts/toolchain/licenses-report.mjs", artifact: "artifacts/licenses.json" },
    { generator: "scripts/toolchain/sbom-report.mjs", artifact: "artifacts/sbom.cdx.json" },
  ]) {
    run(process.execPath, [generator]);
    const first = readFileSync(join(root, artifact), "utf8");
    run(process.execPath, [generator]);
    const second = readFileSync(join(root, artifact), "utf8");
    if (first !== second) fail(`${artifact} is not byte-for-byte deterministic across consecutive generations`);
  }
}

function validateProtocolSchemaV1() {
  const fixture = JSON.parse(readFileSync(join(root, "packages/protocol/fixtures/v1-conformance.json"), "utf8"));
  const rows = ["sources", "schemas", "timeTf", "displayExtensionLifecycle", "rejections"]
    .flatMap((key) => fixture[key]);
  for (const row of rows) {
    const evidenceBytes = readFileSync(join(root, row.evidence));
    const evidenceDigest = `sha256:${createHash("sha256").update(evidenceBytes).digest("hex")}`;
    if (row.evidenceDigest !== evidenceDigest) fail(`stale conformance evidence digest for ${row.id}`);
    const resultDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify([row.id, row.result, row.evidence, row.testName, evidenceDigest]))
      .digest("hex")}`;
    if (row.resultDigest !== resultDigest) fail(`invalid conformance result digest for ${row.id}`);
  }
  const generated = generateConformanceExecutionManifest(root);
  const path = writeConformanceExecutionManifest(root, generated);
  const consumed = JSON.parse(readFileSync(path, "utf8"));
  verifyConformanceExecutionManifest(root, consumed);
  if (process.argv.includes("--check-reproducibility")) {
    const repeated = generateConformanceExecutionManifest(root);
    if (JSON.stringify(repeated) !== JSON.stringify(generated)) fail("conformance execution manifest is not deterministic");
  }
}

const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
validateEvidence(evidence);
validateRepositoryStops();
validateProtocolSchemaV1();
if (process.argv.includes("--check-reproducibility")) {
  checkReproducibility();
  validateGeneratedSupplyChainArtifacts();
}
if (process.argv.includes("--check-clean-tree")) checkCleanTree();
console.log(`release readiness gate: ok (${evidence.releaseDecision}; production certification=false)`);
