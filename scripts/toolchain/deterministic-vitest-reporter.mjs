import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readBoundedBytes } from "./bounded-input.mjs";

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export default class DeterministicVitestReporter {
  assertions = [];

  onTestCaseResult(testCase) {
    const result = testCase.result();
    if (result.state === "skipped") return;
    this.assertions.push(Object.freeze({
      file: testCase.module.relativeModuleId.replaceAll("\\", "/"),
      testName: testCase.fullName.replaceAll(" > ", " "),
      status: result.state,
    }));
  }

  onTestRunEnd(_modules, errors, reason) {
    const report = {
      schemaVersion: 1,
      reason,
      unhandledErrors: errors.length,
      assertions: this.assertions,
    };
    const raw = Buffer.from(`${JSON.stringify(report)}\n`, "utf8");
    const receiptPath = process.env.V1_CONFORMANCE_PRODUCTION_RECEIPT_PATH;
    const eventPath = process.env.V1_CONFORMANCE_PRODUCTION_EVENT_PATH;
    const caseId = process.env.V1_CONFORMANCE_PROBE_CASE_ID;
    if (receiptPath !== undefined || eventPath !== undefined || caseId !== undefined) {
      if (receiptPath === undefined || eventPath === undefined || caseId === undefined || reason !== "passed" || errors.length !== 0 || this.assertions.length !== 1 || this.assertions[0].status !== "passed") {
        throw new Error("production conformance observation requires one exact passing assertion");
      }
      const assertion = this.assertions[0];
      const semanticEventRaw = readBoundedBytes(eventPath, 8 * 1024, "production semantic event");
      const receipt = Object.freeze({
        schemaVersion: 3,
        status: "passed",
        semanticEventRawBase64: semanticEventRaw.toString("base64"),
        semanticEventRawDigest: digest(semanticEventRaw),
        productionAssertion: assertion,
        productionAssertionDigest: digest(JSON.stringify(assertion)),
        productionReporterRawBase64: raw.toString("base64"),
        productionReporterRawDigest: digest(raw),
      });
      mkdirSync(dirname(receiptPath), { recursive: true });
      writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: "wx" });
    }
    process.stdout.write(raw);
  }
}
