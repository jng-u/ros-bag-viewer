import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_OPERATIONS,
  DEFAULT_PROTOCOL_LIMITS,
  EDGE_OPERATIONS,
  LIVE_PROTOCOL_VERSION,
  ProtocolViolation,
  parseBrowserFrame,
  parseBrowserFrameJson,
  validateEdgePlan,
  validateTopicDescriptor,
} from "../src/index.js";

const base = {
  version: LIVE_PROTOCOL_VERSION,
  sessionId: "session-1",
  sequence: 0,
  requestId: "request-1",
} as const;

describe("secure live protocol", () => {
  it("exposes only discovery, subscription lifecycle, and health browser operations", () => {
    expect(BROWSER_OPERATIONS).toEqual(["discover", "subscribe", "unsubscribe", "health"]);
    expect(EDGE_OPERATIONS).toEqual(["discover", "subscribe", "unsubscribe"]);

    for (const operation of ["publish", "call_service", "service", "action", "set_parameter", "raw", "advertise"]) {
      expect(() => parseBrowserFrame({ ...base, operation })).toThrowError(
        expect.objectContaining<Partial<ProtocolViolation>>({ code: "operation-denied" }),
      );
    }
  });

  it("strictly validates exact subscribe fields, topic/type names, and resource ceilings", () => {
    const valid = {
      ...base,
      operation: "subscribe",
      subscriptionId: "subscription-1",
      topic: "/camera/image",
      type: "sensor_msgs/msg/Image",
      maxRateHz: 30,
      maxMessageBytes: 1_000_000,
    } as const;
    expect(parseBrowserFrame(valid)).toEqual(valid);
    const canonical = parseBrowserFrame(valid);
    expect(canonical).not.toBe(valid);
    expect(Object.isFrozen(canonical)).toBe(true);

    expect(() => parseBrowserFrame({ ...valid, topic: "/camera/*" })).toThrow(/without wildcards/);
    expect(() => parseBrowserFrame({ ...valid, type: "not-a-type" })).toThrow(/exact ROS type/);
    expect(() => parseBrowserFrame({ ...valid, publish: { data: "arbitrary" } })).toThrow(/unexpected fields/);
    expect(() => parseBrowserFrame({ ...valid, maxRateHz: Number.POSITIVE_INFINITY })).toThrow(/allowed range|non-finite/);
    expect(() => parseBrowserFrame({ ...valid, maxMessageBytes: 16 * 1024 * 1024 + 1 })).toThrow(/allowed range/);
  });

  it("rejects accessors before execution and returns only host-owned canonical records", () => {
    const accessor = { ...base, operation: "health" } as Record<string, unknown>;
    const getter = vi.fn(() => 1);
    Object.defineProperty(accessor, "version", { enumerable: true, get: getter });
    expect(() => parseBrowserFrame(accessor)).toThrow(/hidden or accessor/);
    expect(getter).not.toHaveBeenCalled();

    const limits = { ...DEFAULT_PROTOCOL_LIMITS } as Record<string, unknown>;
    Object.defineProperty(limits, "maxFrameBytes", { enumerable: true, get: getter });
    expect(() => parseBrowserFrame({ ...base, operation: "health" }, limits as unknown as typeof DEFAULT_PROTOCOL_LIMITS))
      .toThrow(/hidden or accessor/);
    expect(getter).not.toHaveBeenCalled();

    const descriptor = validateTopicDescriptor({
      topic: "/x", type: "std_msgs/msg/String", maxRateHz: 1, maxMessageBytes: 1,
      schemaHash: `sha256:${"a".repeat(64)}`,
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(() => validateTopicDescriptor({ ...descriptor, schemaHash: "SHA256:bad" })).toThrow(/schemaHash/);
  });

  it("rejects duplicate JSON keys, protocol confusion, and oversized frames before dispatch", () => {
    expect(() => parseBrowserFrameJson('{"version":1,"version":1,"operation":"health","sessionId":"s","sequence":0,"requestId":"r"}'))
      .toThrowError(expect.objectContaining<Partial<ProtocolViolation>>({ code: "duplicate-key" }));
    expect(() => parseBrowserFrameJson("[]")).toThrow(/frame must be an object/);
    expect(() => parseBrowserFrameJson('{"version":2,"operation":"health","sessionId":"s","sequence":0,"requestId":"r"}'))
      .toThrowError(expect.objectContaining<Partial<ProtocolViolation>>({ code: "unsupported-version" }));
    expect(() => parseBrowserFrameJson(JSON.stringify({ ...base, operation: "health", padding: "x".repeat(512) }), {
      maxFrameBytes: 128,
      maxIdentifierBytes: 128,
      maxTopicBytes: 256,
      maxTypeBytes: 256,
      maxRateHz: 1_000,
      maxMessageBytes: 1_024,
    })).toThrowError(expect.objectContaining<Partial<ProtocolViolation>>({ code: "frame-too-large" }));
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      expect(() => parseBrowserFrameJson("x".repeat(1_000_000), { ...DEFAULT_PROTOCOL_LIMITS, maxFrameBytes: 128 }))
        .toThrowError(expect.objectContaining<Partial<ProtocolViolation>>({ code: "frame-too-large" }));
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it("binds exact edge plans to session, connection, nonce, expiry, allowlist, and bounded subscribe intent", () => {
    const plan = {
      version: LIVE_PROTOCOL_VERSION,
      operation: "subscribe",
      sessionId: "session-1",
      connectionId: "connection-1",
      sequence: 7,
      nonce: "nonce-1",
      issuedAtMs: 1_000,
      expiresAtMs: 1_500,
      allowlistDigest: `sha256:${"a".repeat(64)}`,
      subscriptionId: "subscription-1",
      topic: "/points",
      type: "sensor_msgs/msg/PointCloud2",
      maxRateHz: 10,
      maxMessageBytes: 1_000_000,
    } as const;

    expect(validateEdgePlan(plan, { nowMs: 1_100, maxTtlMs: 1_000 })).toEqual(plan);
    expect(() => validateEdgePlan({ ...plan, expiresAtMs: 1_000 }, { nowMs: 1_100, maxTtlMs: 1_000 }))
      .toThrowError(expect.objectContaining<Partial<ProtocolViolation>>({ code: "expired-plan" }));
    expect(() => validateEdgePlan({ ...plan, expiresAtMs: 3_000 }, { nowMs: 1_100, maxTtlMs: 1_000 }))
      .toThrowError(expect.objectContaining<Partial<ProtocolViolation>>({ code: "expired-plan" }));
    expect(() => validateEdgePlan({ ...plan, operation: "publish" }, { nowMs: 1_100, maxTtlMs: 1_000 }))
      .toThrowError(expect.objectContaining<Partial<ProtocolViolation>>({ code: "operation-denied" }));
  });
});
