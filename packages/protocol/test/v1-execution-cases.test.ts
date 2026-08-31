import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import {
  V1_CONFORMANCE_PRODUCTION_PROBES,
  v1ConformanceProductionCommand,
} from "../../../scripts/toolchain/v1-conformance-production-probes.mjs";

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function executeProductionProbe(probe: (typeof V1_CONFORMANCE_PRODUCTION_PROBES)[number]) {
  const command = v1ConformanceProductionCommand(probe.caseId);
  const result = spawnSync(command.argv[0], command.argv.slice(1), {
    cwd: process.cwd(),
    encoding: "utf8",
    env: command.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  let report: unknown;
  expect(() => { report = JSON.parse(result.stdout); }).not.toThrow();
  expect(report).toEqual({
    schemaVersion: 1,
    reason: "passed",
    unhandledErrors: 0,
    assertions: [{ file: probe.evidence, testName: probe.testName, status: "passed" }],
  });
  const assertion = (report as { assertions: Array<{ file: string; testName: string; status: string }> }).assertions[0]!;
  const diagnostic = `production assertion passed: ${assertion.file}#${assertion.testName}`;
  expect(new TextEncoder().encode(diagnostic).byteLength).toBeLessThanOrEqual(512);
  return Object.freeze({
    schemaVersion: 1,
    caseId: probe.caseId,
    observedResult: probe.observedResult,
    diagnostic,
    productionCommand: command,
    productionAssertion: assertion,
    productionReporterRaw: result.stdout,
    productionReporterRawDigest: digest(result.stdout),
    productionAssertionDigest: digest(JSON.stringify(assertion)),
  });
}

function writeReceipt(receipt: ReturnType<typeof executeProductionProbe>): void {
  const path = process.env.V1_CONFORMANCE_RECEIPT_PATH;
  if (path === undefined) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt)}\n`, { flag: "wx" });
}

describe("v1 execution receipts", () => {
  for (const probe of V1_CONFORMANCE_PRODUCTION_PROBES) {
    it(`observes ${probe.caseId}`, () => writeReceipt(executeProductionProbe(probe)), 30_000);
  }
});
