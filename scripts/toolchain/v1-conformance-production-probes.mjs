import { dirname } from "node:path";

export const V1_CONFORMANCE_DETERMINISTIC_REPORTER = "scripts/toolchain/deterministic-vitest-reporter.mjs";

const rows = [
  ["sources/local-mcap", "packages/source-mcap/test/index.test.ts", "MCAP adapter uses bounded official-reader range seeks for indexed MCAP", "pass"],
  ["sources/local-ros1-bag", "packages/source-ros1bag/test/index.test.ts", "ROS1 bag SourceBundle adapter uses bounded v2 header/index/chunk/message traversal with schema provenance", "pass"],
  ["sources/local-ros2-sqlite", "packages/source-ros2-sqlite/test/index.test.ts", "ROS2 SQLite SourceBundle adapter opens real multipart SQLite fixtures and merges seek results deterministically with bounded queries", "pass"],
  ["sources/hosted-source-bundle", "packages/source-hosted/test/index.test.ts", "hosted SourceBundle adapter verifies the signed manifest and preserves local MCAP schema, order, timeline, payload hashes, and diagnostics", "pass"],
  ["sources/ros1-live", "tests/m3-live/security-gate.test.ts", "M3 deterministic synthetic load evidence keeps ros1 point-cloud/image-like load bounded and reconnects by epoch", "pass"],
  ["sources/ros2-live", "tests/m3-live/security-gate.test.ts", "M3 deterministic synthetic load evidence keeps ros2 point-cloud/image-like load bounded and reconnects by epoch", "pass"],
  ["schemas/schema-present", "packages/source-mcap/test/index.test.ts", "MCAP adapter exposes embedded schema bytes as schema-present", "pass"],
  ["schemas/schema-resolvable", "packages/source-ros2-sqlite/test/index.test.ts", "ROS2 SQLite SourceBundle adapter parses versioned metadata and rejects unsupported capabilities explicitly", "pass"],
  ["schemas/opaque", "packages/displays-core/test/index.test.ts", "M2 raster and generic fallback displays keeps schema-backed trees bounded and opaque payloads byte-only", "pass"],
  ["timeTf/record-time", "packages/timeline/test/index.test.ts", "timeline normalization selects valid record timestamps exactly", "pass"],
  ["timeTf/header-time", "packages/timeline/test/index.test.ts", "timeline normalization selects valid header timestamps with diagnosed fallback", "pass"],
  ["timeTf/receipt-time", "packages/source-live/test/index.test.ts", "bounded live source normalizes schema/time envelopes and drains them in deterministic order", "pass"],
  ["timeTf/clock-time", "packages/timeline/test/index.test.ts", "timeline normalization selects valid clock timestamps with diagnosed fallback", "pass"],
  ["timeTf/source-epoch-invalidation", "packages/core-model/test/index.test.ts", "payload lease contract rejects stale epochs and invalidation", "pass"],
  ["timeTf/tf-interpolation", "packages/tf/test/index.test.ts", "TF buffer interpolates bracketing transforms without latest fallback", "pass"],
  ["timeTf/tf-missing", "packages/tf/test/index.test.ts", "TF buffer composes static chains and reports missing paths", "pass"],
  ["timeTf/tf-extrapolation", "packages/tf/test/index.test.ts", "TF buffer rejects extrapolation outside bracketing samples", "pass"],
  ["displayExtensionLifecycle/register", "packages/extension-api/test/index.test.ts", "TrustedExtensionHost conformance negotiates an exact immutable v1 capability set and snapshots registration", "pass"],
  ["displayExtensionLifecycle/instantiate", "packages/extension-api/test/index.test.ts", "TrustedExtensionHost conformance exposes only the frozen bounded host surface and validates lifecycle operations exactly", "pass"],
  ["displayExtensionLifecycle/configure", "packages/extension-api/test/index.test.ts", "TrustedExtensionHost conformance revokes retained context access and requires a successful configuration", "pass"],
  ["displayExtensionLifecycle/attach", "packages/extension-api/test/index.test.ts", "TrustedExtensionHost conformance rejects stale or rolled-back epochs before callbacks and invalidates old handles on advance", "pass"],
  ["displayExtensionLifecycle/update", "packages/extension-api/test/index.test.ts", "TrustedExtensionHost conformance captures exact descriptor-safe contracts and canonicalizes the complete message once", "pass"],
  ["displayExtensionLifecycle/render", "packages/extension-api/test/index.test.ts", "out-of-core range summary example renders through the v1 host with a bounded handle", "pass"],
  ["displayExtensionLifecycle/suspend", "packages/extension-api/test/index.test.ts", "TrustedExtensionHost conformance bounds resource handles and diagnostics and cleans up after callback failures", "pass"],
  ["displayExtensionLifecycle/error", "packages/extension-api/test/index.test.ts", "TrustedExtensionHost conformance surfaces both an operation failure and a failing error callback", "pass"],
  ["displayExtensionLifecycle/dispose", "packages/extension-api/test/index.test.ts", "out-of-core range summary example disposes its bounded handle idempotently", "pass"],
  ["rejections/unknown-version", "packages/protocol/test/conformance-v1.test.ts", "protocol/schema v1 conformance freeze rejects unknown fixture versions", "rejected"],
  ["rejections/extra-key", "packages/protocol/test/conformance-v1.test.ts", "protocol/schema v1 conformance freeze rejects extra fixture keys", "rejected"],
  ["rejections/operation-widening", "packages/protocol/test/conformance-v1.test.ts", "protocol/schema v1 conformance freeze rejects operation widening", "rejected"],
  ["rejections/capability-escalation", "packages/protocol/test/conformance-v1.test.ts", "protocol/schema v1 conformance freeze rejects capability escalation", "rejected"],
  ["rejections/schema-conflict", "packages/protocol/test/conformance-v1.test.ts", "protocol/schema v1 conformance freeze rejects schema conflicts", "rejected"],
  ["rejections/schema-oversize", "packages/protocol/test/conformance-v1.test.ts", "protocol/schema v1 conformance freeze rejects oversized schemas", "rejected"],
  ["rejections/schema-depth", "packages/protocol/test/conformance-v1.test.ts", "protocol/schema v1 conformance freeze rejects excessively deep schemas", "rejected"],
  ["rejections/lifetime-use-after-release", "packages/protocol/test/conformance-v1.test.ts", "protocol/schema v1 conformance freeze rejects payload lifetime use after release", "rejected"],
  ["rejections/lifetime-double-release", "packages/protocol/test/conformance-v1.test.ts", "protocol/schema v1 conformance freeze rejects payload lifetime double release", "rejected"],
  ["rejections/lifetime-stale-epoch", "packages/protocol/test/conformance-v1.test.ts", "protocol/schema v1 conformance freeze rejects payload lifetime stale epochs", "rejected"],
];

export const V1_CONFORMANCE_PRODUCTION_PROBES = Object.freeze(rows.map(([caseId, evidence, testName, observedResult]) =>
  Object.freeze({ caseId, evidence, testName, observedResult })));

const probesByCase = new Map(V1_CONFORMANCE_PRODUCTION_PROBES.map((probe) => [probe.caseId, probe]));

export function v1ConformanceProductionProbe(caseId) {
  const probe = probesByCase.get(caseId);
  if (!probe) throw new Error(`unknown v1 conformance production probe ${caseId}`);
  return probe;
}

function exactPattern(value) {
  return `^${value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`;
}

export function v1ConformanceProductionCommand(caseId) {
  const probe = v1ConformanceProductionProbe(caseId);
  return Object.freeze({
    cwd: ".",
    argv: Object.freeze([
      process.execPath,
      "node_modules/vitest/vitest.mjs",
      "run",
      probe.evidence,
      "-t",
      exactPattern(probe.testName),
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
      V1_CONFORMANCE_PROBE_CASE_ID: caseId,
    }),
  });
}
