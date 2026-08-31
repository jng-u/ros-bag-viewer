import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { emitV1SemanticEvent } from "../../../tests/support/v1-conformance-event.js";
import { parseBoundedJsonBytes, readBoundedBytes } from "../../../scripts/toolchain/bounded-input.mjs";
import { describe, expect, it, vi } from "vitest";

import { ReferenceCountedPayloadLease, type SourceEpoch } from "../../core-model/src/index.js";
import {
  BROWSER_OPERATIONS,
  EDGE_OPERATIONS,
  V1ConformanceViolation,
  V1_FROZEN_BROWSER_OPERATIONS,
  V1_FROZEN_EDGE_OPERATIONS,
  V1_FROZEN_EXTENSION_OPERATIONS,
  V1_CONFORMANCE_TEST_NAME_MAX_BYTES,
  V1_CONFORMANCE_FIXTURE_MAX_BYTES,
  V1_SCHEMA_LIMITS,
  freezeV1Conformance,
  parseBrowserFrame,
  parseV1ConformanceFixture,
  validateV1SchemaAdmission,
} from "../src/index.js";
import { sha256 } from "../src/canonical.js";

const fixturePath = new URL("../fixtures/v1-conformance.json", import.meta.url);
const fixture = parseBoundedJsonBytes(
  readBoundedBytes(fixturePath, V1_CONFORMANCE_FIXTURE_MAX_BYTES, "v1 conformance fixture"),
  V1_CONFORMANCE_FIXTURE_MAX_BYTES,
  "v1 conformance fixture",
) as unknown;

function cloneFixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
}

function validSchemaAdmission(): Record<string, unknown> {
  return {
    version: 1,
    typeName: "sensor_msgs/msg/Image",
    providers: [
      {
        providerId: "embedded",
        providerVersion: "1",
        schema: { fields: [{ name: "data", type: "uint8[]" }] },
      },
    ],
  };
}

function captureError(run: () => unknown): Error & { readonly code?: string } {
  try { run(); } catch (error) { return error as Error & { readonly code?: string }; }
  throw new Error("expected operation to reject");
}

function emitRejection(code: string, error: Error & { readonly code?: string }): void {
  emitV1SemanticEvent({ schemaVersion: 1, domain: "rejection", result: "rejected", code, facts: {
    errorCode: error.code ?? error.name, message: error.message.slice(0, 256),
  } });
}

describe("protocol/schema v1 conformance freeze", () => {
  it("freezes only the exact complete fixture and keeps evidence claims scoped truthfully", () => {
    const frozen = freezeV1Conformance(fixture);

    expect(frozen.frozen).toBe(true);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.sources)).toBe(true);
    expect(frozen.truthScope).toMatch(/not browser, OS, ROS, network, or production certification/);
    expect(frozen.sources.map(({ id }) => id)).toEqual([
      "local-mcap",
      "local-ros1-bag",
      "local-ros2-sqlite",
      "hosted-source-bundle",
      "ros1-live",
      "ros2-live",
    ]);

    for (const entry of [
      ...frozen.sources,
      ...frozen.schemas,
      ...frozen.timeTf,
      ...frozen.displayExtensionLifecycle,
      ...frozen.rejections,
    ]) {
      expect(existsSync(resolve(entry.evidence)), entry.evidence).toBe(true);
      expect(`sha256:${createHash("sha256").update(readBoundedBytes(resolve(entry.evidence), 8 * 1024 * 1024, entry.evidence)).digest("hex")}`, entry.evidence)
        .toBe(entry.evidenceDigest);
    }
  });

  it("rejects accessor-driven freeze changes and executable schema serialization hooks", () => {
    const accessor = cloneFixture();
    Object.defineProperty(accessor, "protocolVersion", { enumerable: true, get: () => 1 });
    expect(() => freezeV1Conformance(accessor)).toThrow(/accessor/);
    const admission = validSchemaAdmission();
    admission.providers = [{ providerId: "x", providerVersion: "1", schema: { toJSON: () => ({ hidden: true }) } }];
    expect(() => validateV1SchemaAdmission(admission)).toThrow(/executable|unsupported/);
    const binary = validSchemaAdmission();
    binary.providers = [{ providerId: "x", providerVersion: "1", schema: new ArrayBuffer(2 * 1_024 * 1_024) }];
    expect(() => validateV1SchemaAdmission(binary)).toThrow(/plain data/);
    const hidden = cloneFixture();
    Object.defineProperty(hidden, "hidden", { value: true });
    expect(() => freezeV1Conformance(hidden)).toThrow(/hidden/);
    const symbol = cloneFixture();
    Object.defineProperty(symbol, Symbol("hidden"), { value: true, enumerable: true });
    expect(() => freezeV1Conformance(symbol)).toThrow(/symbols/);
    const arrayAccessor = cloneFixture();
    const getter = vi.fn(() => (arrayAccessor.sources as unknown[])[0]);
    Object.defineProperty(arrayAccessor.sources, "0", { enumerable: true, get: getter });
    expect(() => parseV1ConformanceFixture(arrayAccessor)).toThrow(/accessor/);
    expect(getter).not.toHaveBeenCalled();
    const proto = validSchemaAdmission();
    const malicious = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(malicious, "__proto__", { value: { polluted: true }, enumerable: true });
    proto.providers = [{ providerId: "x", providerVersion: "1", schema: malicious }];
    expect(() => validateV1SchemaAdmission(proto)).toThrow(/__proto__/);
  });

  it("derives canonical SHA-256 schema and exact case-result digests", () => {
    expect(sha256("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const first = validateV1SchemaAdmission(validSchemaAdmission());
    const reordered = validSchemaAdmission();
    reordered.providers = [{
      schema: { fields: [{ type: "uint8[]", name: "data" }] },
      providerVersion: "1",
      providerId: "embedded",
    }];
    const second = validateV1SchemaAdmission(reordered);
    expect(first.schemaDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(second.schemaDigest).toBe(first.schemaDigest);
    expect(first.providers[0]?.schemaDigest).toBe(first.schemaDigest);
    expect(first.bindingDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.provenanceDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const tampered = cloneFixture();
    (tampered.sources as Array<Record<string, unknown>>)[0]!.resultDigest = `sha256:${"0".repeat(64)}`;
    expect(() => freezeV1Conformance(tampered)).toThrow(/host-derived/);
  });

  it("locks the conformance operation snapshot to the implemented live protocol", () => {
    expect(BROWSER_OPERATIONS).toEqual(V1_FROZEN_BROWSER_OPERATIONS);
    expect(EDGE_OPERATIONS).toEqual(V1_FROZEN_EDGE_OPERATIONS);
    expect(parseV1ConformanceFixture(fixture).extensionOperations).toEqual(V1_FROZEN_EXTENSION_OPERATIONS);
  });

  it("rejects unknown fixture versions", () => {
    const error = captureError(() => parseV1ConformanceFixture({ ...cloneFixture(), protocolVersion: 2 }));
    expect(error).toEqual(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "unsupported-version" }));
    emitRejection("unknown-version", error);
  });

  it("rejects extra fixture keys", () => {
    const error = captureError(() => parseV1ConformanceFixture({ ...cloneFixture(), surprise: true }));
    expect(error).toEqual(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "invalid-fixture" }));
    const substitutedEvidence = cloneFixture();
    (substitutedEvidence.sources as Array<Record<string, unknown>>)[0]!.evidence = "packages/protocol/test/conformance-v1.test.ts";
    expect(() => parseV1ConformanceFixture(substitutedEvidence)).toThrow(/frozen case evidence/);

    const skipped = cloneFixture();
    (skipped.sources as Array<Record<string, unknown>>)[0]!.result = "skipped";
    expect(() => freezeV1Conformance(skipped)).toThrowError(
      expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "incomplete-conformance" }),
    );
    const oversizedTestName = cloneFixture();
    (oversizedTestName.sources as Array<Record<string, unknown>>)[0]!.testName = "x".repeat(V1_CONFORMANCE_TEST_NAME_MAX_BYTES + 1);
    expect(() => parseV1ConformanceFixture(oversizedTestName)).toThrow(/test name is oversized/);
    emitRejection("extra-key", error);
  });

  it("rejects operation widening", () => {
    const widenedOperations = cloneFixture();
    widenedOperations.browserOperations = [...V1_FROZEN_BROWSER_OPERATIONS, "publish"];
    const error = captureError(() => parseV1ConformanceFixture(widenedOperations));
    expect(error).toEqual(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "operation-widening" }));
    emitRejection("operation-widening", error);
  });

  it("rejects capability escalation", () => {
    const escalatedCapabilities = cloneFixture();
    escalatedCapabilities.extensionCapabilities = [
      ...(escalatedCapabilities.extensionCapabilities as string[]),
      "raw-webgl",
    ];
    const error = captureError(() => parseV1ConformanceFixture(escalatedCapabilities));
    expect(error).toEqual(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "capability-escalation" }));
    emitRejection("capability-escalation", error);
  });

  it("keeps write/service/action/parameter/raw command widening denied by the executable parser", () => {
    const base = { version: 1, sessionId: "s", sequence: 0, requestId: "r" } as const;
    for (const operation of ["publish", "service", "action", "set_parameter", "raw-command"]) {
      expect(() => parseBrowserFrame({ ...base, operation })).toThrowError(/not permitted/);
    }
  });

  it("rejects schema conflicts", () => {
    expect(validateV1SchemaAdmission(validSchemaAdmission())).toMatchObject({ version: 1 });
    const conflict = validSchemaAdmission();
    conflict.providers = [
      ...(conflict.providers as object[]),
      { providerId: "schema-pack", providerVersion: "1", schema: { fields: [{ name: "other", type: "string" }] } },
    ];
    const error = captureError(() => validateV1SchemaAdmission(conflict));
    expect(error).toEqual(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "schema-conflict" }));
    emitRejection("schema-conflict", error);
  });

  it("rejects oversized schemas", () => {
    const oversized = validSchemaAdmission(); oversized.providers = [{ providerId: "x", providerVersion: "1", schema: "x".repeat(V1_SCHEMA_LIMITS.maxBytes + 1) }];
    const error = captureError(() => validateV1SchemaAdmission(oversized));
    expect(error).toEqual(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "schema-oversize" }));
    emitRejection("schema-oversize", error);
  });

  it("rejects excessively deep schemas", () => {
    let deep: unknown = "leaf"; for (let index = 0; index <= V1_SCHEMA_LIMITS.maxDepth; index += 1) deep = { nested: deep };
    const tooDeep = validSchemaAdmission(); tooDeep.providers = [{ providerId: "x", providerVersion: "1", schema: deep }];
    const error = captureError(() => validateV1SchemaAdmission(tooDeep));
    expect(error).toEqual(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "schema-depth" }));
    emitRejection("schema-depth", error);
  });

  it("rejects noncanonical schema provider structures and versions", () => {
    const sparse = validSchemaAdmission(); sparse.providers = [{ providerId: "x", providerVersion: "1", schema: new Array(100_001) }];
    expect(() => validateV1SchemaAdmission(sparse))
      .toThrowError(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "invalid-fixture" }));
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const cyclic = validSchemaAdmission(); cyclic.providers = [{ providerId: "x", providerVersion: "1", schema: cycle }];
    expect(() => validateV1SchemaAdmission(cyclic))
      .toThrowError(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "invalid-fixture" }));
    const shared = { field: "x" };
    const repeated = validSchemaAdmission(); repeated.providers = [{ providerId: "x", providerVersion: "1", schema: { first: shared, second: shared } }];
    expect(() => validateV1SchemaAdmission(repeated))
      .toThrowError(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "invalid-fixture" }));
    const oversizedProvider = validSchemaAdmission();
    oversizedProvider.providers = [{ providerId: "x".repeat(257), providerVersion: "1", schema: {} }];
    expect(() => validateV1SchemaAdmission(oversizedProvider)).toThrowError(/provider/);
    expect(() => validateV1SchemaAdmission({ ...validSchemaAdmission(), version: 2 }))
      .toThrowError(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "unsupported-version" }));
    expect(() => validateV1SchemaAdmission({ ...validSchemaAdmission(), executable: "eval()" }))
      .toThrowError(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "invalid-fixture" }));
  });

  it("rejects payload lifetime use after release", () => {
    const epoch = 1 as SourceEpoch;
    const lease = new ReferenceCountedPayloadLease(epoch, 16);
    lease.release();
    const error = captureError(() => lease.assertUsable(epoch));
    expect(error.message).toMatch(/active source epoch/);
    emitRejection("lifetime-use-after-release", error);
  });

  it("rejects payload lifetime double release", () => {
    const lease = new ReferenceCountedPayloadLease(1 as SourceEpoch, 16);
    lease.release();
    const error = captureError(() => lease.release());
    expect(error.message).toMatch(/more than retained/);
    emitRejection("lifetime-double-release", error);
  });

  it("rejects payload lifetime stale epochs", () => {
    const stale = new ReferenceCountedPayloadLease(1 as SourceEpoch, 16);
    const error = captureError(() => stale.assertUsable(2 as SourceEpoch));
    expect(error.message).toMatch(/active source epoch/);
    emitRejection("lifetime-stale-epoch", error);
  });
});
