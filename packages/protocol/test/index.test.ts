import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_OPERATIONS,
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
      expect(() => parseBrowserFrame(JSON.stringify({ ...base, operation }))).toThrowError(
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
    expect(parseBrowserFrame(JSON.stringify(valid))).toEqual(valid);
    const canonical = parseBrowserFrame(JSON.stringify(valid));
    expect(canonical).not.toBe(valid);
    expect(Object.isFrozen(canonical)).toBe(true);

    expect(() => parseBrowserFrame(JSON.stringify({ ...valid, topic: "/camera/*" }))).toThrow(/without wildcards/);
    expect(() => parseBrowserFrame(JSON.stringify({ ...valid, type: "not-a-type" }))).toThrow(/exact ROS type/);
    expect(() => parseBrowserFrame(JSON.stringify({ ...valid, publish: { data: "arbitrary" } }))).toThrow(/unexpected fields/);
    expect(() => parseBrowserFrame(JSON.stringify({ ...valid, maxRateHz: Number.POSITIVE_INFINITY }))).toThrow(/allowed range|non-finite/);
    expect(() => parseBrowserFrame(JSON.stringify({ ...valid, maxMessageBytes: 16 * 1024 * 1024 + 1 }))).toThrow(/allowed range/);
  });

  it("admits only serialized frames and returns host-owned canonical records", () => {
    const getter = vi.fn(() => 1);
    const ownKeys = vi.fn(Reflect.ownKeys);
    const getPrototypeOf = vi.fn(Reflect.getPrototypeOf);
    const hostile = new Proxy({ ...base, operation: "health" }, { get: getter, getPrototypeOf, ownKeys });
    expect(() => parseBrowserFrame(hostile as unknown as string)).toThrow(/serialized JSON text/);
    expect(getter).not.toHaveBeenCalled();
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();

    expect(parseBrowserFrame.length).toBe(1);

    const descriptor = validateTopicDescriptor(JSON.stringify({
      topic: "/x", type: "std_msgs/msg/String", maxRateHz: 1, maxMessageBytes: 1,
      schemaHash: `sha256:${"a".repeat(64)}`,
    }));
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(() => validateTopicDescriptor(JSON.stringify({ ...descriptor, schemaHash: "SHA256:bad" }))).toThrow(/schemaHash/);
    expect(() => validateTopicDescriptor(hostile as unknown as string)).toThrow(/serialized JSON text/);
    expect(() => validateEdgePlan(hostile as unknown as string, 0, 1)).toThrow(/serialized JSON text/);
    expect(getter).not.toHaveBeenCalled();
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it("rejects duplicate JSON keys, protocol confusion, and oversized frames before dispatch", () => {
    expect(() => parseBrowserFrameJson('{"version":1,"version":1,"operation":"health","sessionId":"s","sequence":0,"requestId":"r"}'))
      .toThrowError(expect.objectContaining<Partial<ProtocolViolation>>({ code: "duplicate-key" }));
    expect(() => parseBrowserFrameJson("[]")).toThrow(/frame must be an object/);
    expect(() => parseBrowserFrameJson('{"version":2,"operation":"health","sessionId":"s","sequence":0,"requestId":"r"}'))
      .toThrowError(expect.objectContaining<Partial<ProtocolViolation>>({ code: "unsupported-version" }));
    expect(() => parseBrowserFrameJson(JSON.stringify({ ...base, operation: "health", padding: "x".repeat(32_000) })))
      .toThrowError(expect.objectContaining<Partial<ProtocolViolation>>({ code: "frame-too-large" }));
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      expect(() => parseBrowserFrameJson("x".repeat(1_000_000)))
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

    expect(validateEdgePlan(JSON.stringify(plan), 1_100, 1_000)).toEqual(plan);
    expect(() => validateEdgePlan(JSON.stringify({ ...plan, expiresAtMs: 1_000 }), 1_100, 1_000))
      .toThrowError(expect.objectContaining<Partial<ProtocolViolation>>({ code: "expired-plan" }));
    expect(() => validateEdgePlan(JSON.stringify({ ...plan, expiresAtMs: 3_000 }), 1_100, 1_000))
      .toThrowError(expect.objectContaining<Partial<ProtocolViolation>>({ code: "expired-plan" }));
    expect(() => validateEdgePlan(JSON.stringify({ ...plan, operation: "publish" }), 1_100, 1_000))
      .toThrowError(expect.objectContaining<Partial<ProtocolViolation>>({ code: "operation-denied" }));
  });
});
