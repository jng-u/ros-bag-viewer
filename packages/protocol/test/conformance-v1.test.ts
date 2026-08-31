import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ReferenceCountedPayloadLease, type SourceEpoch } from "../../core-model/src/index.js";
import {
  BROWSER_OPERATIONS,
  EDGE_OPERATIONS,
  V1ConformanceViolation,
  V1_FROZEN_BROWSER_OPERATIONS,
  V1_FROZEN_EDGE_OPERATIONS,
  V1_FROZEN_EXTENSION_OPERATIONS,
  V1_SCHEMA_LIMITS,
  freezeV1Conformance,
  parseBrowserFrame,
  parseV1ConformanceFixture,
  validateV1SchemaAdmission,
} from "../src/index.js";

const fixturePath = new URL("../fixtures/v1-conformance.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;

function cloneFixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
}

function validSchemaAdmission(): Record<string, unknown> {
  return {
    version: 1,
    typeName: "sensor_msgs/msg/Image",
    schema: { fields: [{ name: "data", type: "uint8[]" }] },
    providers: [
      {
        providerId: "embedded",
        providerVersion: "1",
        contentHash: `sha256:${"a".repeat(64)}`,
      },
    ],
  };
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
    }
  });

  it("locks the conformance operation snapshot to the implemented live protocol", () => {
    expect(BROWSER_OPERATIONS).toEqual(V1_FROZEN_BROWSER_OPERATIONS);
    expect(EDGE_OPERATIONS).toEqual(V1_FROZEN_EDGE_OPERATIONS);
    expect(parseV1ConformanceFixture(fixture).extensionOperations).toEqual(V1_FROZEN_EXTENSION_OPERATIONS);
  });

  it("rejects unknown versions, extra keys, incomplete results, and operation or capability widening", () => {
    expect(() => parseV1ConformanceFixture({ ...cloneFixture(), protocolVersion: 2 })).toThrowError(
      expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "unsupported-version" }),
    );
    expect(() => parseV1ConformanceFixture({ ...cloneFixture(), surprise: true })).toThrowError(
      expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "invalid-fixture" }),
    );

    const widenedOperations = cloneFixture();
    widenedOperations.browserOperations = [...V1_FROZEN_BROWSER_OPERATIONS, "publish"];
    expect(() => parseV1ConformanceFixture(widenedOperations)).toThrowError(
      expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "operation-widening" }),
    );

    const escalatedCapabilities = cloneFixture();
    escalatedCapabilities.extensionCapabilities = [
      ...(escalatedCapabilities.extensionCapabilities as string[]),
      "raw-webgl",
    ];
    expect(() => parseV1ConformanceFixture(escalatedCapabilities)).toThrowError(
      expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "capability-escalation" }),
    );

    const skipped = cloneFixture();
    (skipped.sources as Array<Record<string, unknown>>)[0]!.result = "skipped";
    expect(() => freezeV1Conformance(skipped)).toThrowError(
      expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "incomplete-conformance" }),
    );
  });

  it("keeps write/service/action/parameter/raw command widening denied by the executable parser", () => {
    const base = { version: 1, sessionId: "s", sequence: 0, requestId: "r" } as const;
    for (const operation of ["publish", "service", "action", "set_parameter", "raw-command"]) {
      expect(() => parseBrowserFrame({ ...base, operation })).toThrowError(/not permitted/);
    }
  });

  it("rejects schema conflicts, oversize, excessive depth, extra keys, and unknown versions", () => {
    expect(validateV1SchemaAdmission(validSchemaAdmission())).toMatchObject({ version: 1 });

    const conflict = validSchemaAdmission();
    conflict.providers = [
      ...(conflict.providers as object[]),
      { providerId: "schema-pack", providerVersion: "1", contentHash: `sha256:${"b".repeat(64)}` },
    ];
    expect(() => validateV1SchemaAdmission(conflict)).toThrowError(
      expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "schema-conflict" }),
    );
    expect(() => validateV1SchemaAdmission({ ...validSchemaAdmission(), schema: "x".repeat(V1_SCHEMA_LIMITS.maxBytes + 1) }))
      .toThrowError(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "schema-oversize" }));
    let deep: unknown = "leaf"; for (let index = 0; index <= V1_SCHEMA_LIMITS.maxDepth; index += 1) deep = { nested: deep };
    expect(() => validateV1SchemaAdmission({ ...validSchemaAdmission(), schema: deep }))
      .toThrowError(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "schema-depth" }));
    const oversizedProvider = validSchemaAdmission();
    oversizedProvider.providers = [{ providerId: "x".repeat(257), providerVersion: "1", contentHash: `sha256:${"a".repeat(64)}` }];
    expect(() => validateV1SchemaAdmission(oversizedProvider)).toThrowError(/provider/);
    expect(() => validateV1SchemaAdmission({ ...validSchemaAdmission(), version: 2 }))
      .toThrowError(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "unsupported-version" }));
    expect(() => validateV1SchemaAdmission({ ...validSchemaAdmission(), executable: "eval()" }))
      .toThrowError(expect.objectContaining<Partial<V1ConformanceViolation>>({ code: "invalid-fixture" }));
  });

  it("rejects payload lifetime use-after-release, double release, and stale epochs", () => {
    const epoch = 1 as SourceEpoch;
    const lease = new ReferenceCountedPayloadLease(epoch, 16);
    lease.release();
    expect(() => lease.assertUsable(epoch)).toThrow(/active source epoch/);
    expect(() => lease.release()).toThrow(/more than retained/);

    const stale = new ReferenceCountedPayloadLease(epoch, 16);
    expect(() => stale.assertUsable(2 as SourceEpoch)).toThrow(/active source epoch/);
  });
});
