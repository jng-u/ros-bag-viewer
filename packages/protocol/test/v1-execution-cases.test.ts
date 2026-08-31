import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  V1_CONFORMANCE_PRODUCTION_PROBES,
  v1ConformanceProductionCommand,
} from "../../../scripts/toolchain/v1-conformance-production-probes.mjs";

function executeProductionProbe(probe: (typeof V1_CONFORMANCE_PRODUCTION_PROBES)[number]) {
  const externalReceiptPath = process.env.V1_CONFORMANCE_RECEIPT_PATH;
  const receiptPath = externalReceiptPath ?? join(tmpdir(), `v1-conformance-${process.pid}-${probe.caseId.replaceAll("/", "-")}.json`);
  if (externalReceiptPath === undefined) rmSync(receiptPath, { force: true });
  const command = v1ConformanceProductionCommand(probe.caseId, receiptPath);
  const result = spawnSync(command.argv[0], command.argv.slice(1), {
    cwd: process.cwd(),
    env: command.env,
    maxBuffer: 1024 * 1024,
  });
  const reporterRaw = result.stdout;
  const reporterText = reporterRaw.toString("utf8");
  expect(result.status, result.stderr.toString("utf8") || reporterText).toBe(0);
  let report: unknown;
  expect(() => { report = JSON.parse(reporterText); }).not.toThrow();
  expect(report).toEqual({
    schemaVersion: 1,
    reason: "passed",
    unhandledErrors: 0,
    assertions: [{ file: probe.evidence, testName: probe.testName, status: "passed" }],
  });
  const receipt = JSON.parse(readFileSync(receiptPath!, "utf8")) as { caseId?: string; productionReporterRawBase64?: string };
  expect(receipt.caseId).toBe(probe.caseId);
  expect(Buffer.from(receipt.productionReporterRawBase64 ?? "", "base64")).toEqual(reporterRaw);
  if (externalReceiptPath === undefined) rmSync(receiptPath, { force: true });
}

describe("v1 execution receipts", () => {
  for (const probe of V1_CONFORMANCE_PRODUCTION_PROBES) {
    it(`observes ${probe.caseId}`, () => executeProductionProbe(probe), 30_000);
  }
});
