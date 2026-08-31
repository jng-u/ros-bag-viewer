import { describe, expect, it } from "vitest";

import {
  BROWSER_OPERATIONS,
  EDGE_OPERATIONS,
  LIVE_PROTOCOL_VERSION,
  ProtocolViolation,
  parseBrowserFrame,
  parseBrowserFrameJson,
  validateEdgePlan,
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

    expect(() => parseBrowserFrame({ ...valid, topic: "/camera/*" })).toThrow(/without wildcards/);
    expect(() => parseBrowserFrame({ ...valid, type: "not-a-type" })).toThrow(/exact ROS type/);
    expect(() => parseBrowserFrame({ ...valid, publish: { data: "arbitrary" } })).toThrow(/unexpected fields/);
    expect(() => parseBrowserFrame({ ...valid, maxRateHz: Number.POSITIVE_INFINITY })).toThrow(/allowed range/);
    expect(() => parseBrowserFrame({ ...valid, maxMessageBytes: 16 * 1024 * 1024 + 1 })).toThrow(/allowed range/);
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
