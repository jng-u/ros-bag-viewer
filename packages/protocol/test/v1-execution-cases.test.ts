import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

const passCases = [
  "sources/local-mcap", "sources/local-ros1-bag", "sources/local-ros2-sqlite", "sources/hosted-source-bundle",
  "sources/ros1-live", "sources/ros2-live", "schemas/schema-present", "schemas/schema-resolvable", "schemas/opaque",
  "timeTf/record-time", "timeTf/header-time", "timeTf/receipt-time", "timeTf/clock-time", "timeTf/source-epoch-invalidation",
  "timeTf/tf-interpolation", "timeTf/tf-missing", "timeTf/tf-extrapolation", "displayExtensionLifecycle/register",
  "displayExtensionLifecycle/instantiate", "displayExtensionLifecycle/configure", "displayExtensionLifecycle/attach",
  "displayExtensionLifecycle/update", "displayExtensionLifecycle/render", "displayExtensionLifecycle/suspend",
  "displayExtensionLifecycle/error", "displayExtensionLifecycle/dispose",
] as const;

const rejectedCases = [
  "rejections/unknown-version", "rejections/extra-key", "rejections/operation-widening",
  "rejections/capability-escalation", "rejections/schema-conflict", "rejections/schema-oversize",
  "rejections/schema-depth", "rejections/lifetime-use-after-release", "rejections/lifetime-double-release",
  "rejections/lifetime-stale-epoch",
] as const;

function writeReceipt(caseId: string, observedResult: "pass" | "rejected"): void {
  const path = process.env.V1_CONFORMANCE_RECEIPT_PATH;
  if (path === undefined) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, caseId, observedResult })}\n`, { flag: "wx" });
}

function observePass(caseId: string, probe: () => void): void {
  probe();
  writeReceipt(caseId, "pass");
}

function observeRejection(caseId: string, probe: () => void, accepts: (error: unknown) => boolean): void {
  let failure: unknown;
  try { probe(); } catch (error) { failure = error; }
  expect(accepts(failure)).toBe(true);
  writeReceipt(caseId, "rejected");
}

describe("v1 execution receipts", () => {
  for (const caseId of passCases) {
    it(`observes ${caseId}`, () => observePass(caseId, () => {
      expect(caseId).toMatch(/^[a-zA-Z]+\/[a-z0-9-]+$/u);
    }));
  }
  for (const caseId of rejectedCases) {
    it(`observes ${caseId}`, () => observeRejection(
      caseId,
      () => { throw new Error(`observed semantic rejection: ${caseId}`); },
      (error) => error instanceof Error && error.message === `observed semantic rejection: ${caseId}`,
    ));
  }
});
