import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createRos1PrivateEdgeAdapter } from "../../../bridges/ros1/src/index.js";
import { createRos2PrivateEdgeAdapter } from "../../../bridges/ros2/src/index.js";
import {
  PrivateEdgeRuntime,
  assertPrivateListener,
  computeAllowlistDigest,
  type EdgePlan,
  type EdgeReadPort,
  type EdgeRuntimeLimits,
  type TopicDescriptor,
} from "../src/index.js";

const topicPolicy: TopicDescriptor = {
  topic: "/allowed",
  type: "sensor_msgs/msg/PointCloud2",
  maxRateHz: 10,
  maxMessageBytes: 4,
};
const allowlistDigest = computeAllowlistDigest([topicPolicy]);

const limits: EdgeRuntimeLimits = {
  maxCommandBytes: 1024,
  maxCommandsPerWindow: 20,
  commandWindowMs: 1000,
  maxPlanTtlMs: 1000,
  maxTrackedConnections: 2,
  maxSubscriptions: 1,
  maxFrameBytes: 4,
  maxQueuedFramesPerSubscription: 1,
  maxBufferedBytes: 4,
  maxTelemetryEvents: 3,
};

const relayIdentity = { identityId: "relay-a", credential: "edge-secret" } as const;

let sequence = 0;
function plan(operation: EdgePlan["operation"], extra: Record<string, unknown> = {}): EdgePlan {
  sequence += 1;
  return {
    version: 1,
    operation,
    sessionId: "session-a",
    connectionId: "connection-a",
    sequence,
    nonce: `nonce-${sequence}`,
    issuedAtMs: 900,
    expiresAtMs: 1500,
    allowlistDigest,
    ...extra,
  } as EdgePlan;
}

class FakeReadPort implements EdgeReadPort {
  readonly subscribe = vi.fn(async (_topic: string, _type: string, onFrame: (payload: Uint8Array) => void) => {
    this.onFrame = onFrame;
    return { close: this.close };
  });
  readonly close = vi.fn();
  readonly discover = vi.fn(async () => [
    { topic: "/allowed", type: "sensor_msgs/msg/PointCloud2" },
    { topic: "/secret", type: "std_msgs/msg/String" },
  ]);
  onFrame?: (payload: Uint8Array) => void;
}

function runtime(overrides: Partial<EdgeRuntimeLimits> = {}, clock: () => number = () => 1000): PrivateEdgeRuntime {
  return new PrivateEdgeRuntime({
    generation: "ros2",
    listener: { host: "127.0.0.1", port: 7442, tls: true },
    allowedRelayIds: ["relay-a"],
    allowedTopics: [topicPolicy],
    allowlistDigest,
    verifyRelayCredential: ({ identityId, credential }) => identityId === "relay-a" && credential === "edge-secret",
    limits: { ...limits, ...overrides },
  }, clock);
}

describe("private edge boundary", () => {
  it("rejects public, wildcard, non-TLS, and invalid listeners", () => {
    expect(() => assertPrivateListener({ host: "8.8.8.8", port: 7442, tls: true })).toThrow(/private or loopback/);
    expect(() => assertPrivateListener({ host: "0.0.0.0", port: 7442, tls: true })).toThrow(/private or loopback/);
    expect(() => assertPrivateListener({ host: "::", port: 7442, tls: true })).toThrow(/private or loopback/);
    expect(() => assertPrivateListener({ host: "fc:", port: 7442, tls: true })).toThrow(/private or loopback/);
    expect(() => assertPrivateListener({ host: "127.0.0.1", port: 0, tls: true })).toThrow(/port/);
    expect(() => assertPrivateListener({ host: "127.0.0.1", port: 7442, tls: false as true })).toThrow(/TLS/);
    expect(() => assertPrivateListener({ host: "10.1.2.3", port: 7442, tls: true })).not.toThrow();
  });

  it("admits only exact authenticated relay transport identities and never browser credentials", async () => {
    const edge = runtime();
    const port = new FakeReadPort();
    for (const identity of [
      { sessionId: "browser-session", credential: "browser-secret" },
      { identityId: "relay-a", credential: "wrong" },
      { identityId: "other-relay", credential: "edge-secret" },
      { identityId: "relay-a", credential: "x".repeat(1025) },
      { ...relayIdentity, browserCredential: "must-not-cross-edge" },
    ]) {
      await expect(edge.execute(identity, plan("discover"), port)).resolves.toEqual({
        ok: false,
        code: "unauthenticated-relay",
      });
    }
    expect(port.discover).not.toHaveBeenCalled();
  });

  it("strictly exposes protocol discovery, subscribe, and unsubscribe plans while denying write shapes", async () => {
    const edge = runtime();
    const port = new FakeReadPort();
    await expect(edge.execute(relayIdentity, plan("discover"), port)).resolves.toEqual({
      ok: true,
      reply: { version: 1, kind: "discovery", topics: [topicPolicy] },
    });
    for (const operation of ["publish", "call-service", "send-action", "set-parameter", "get-parameter"] as const) {
      await expect(edge.execute(relayIdentity, { ...plan("discover"), operation, topic: "/allowed" }, port)).resolves.toEqual({
        ok: false,
        code: "invalid-plan",
      });
    }
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(edge))).toEqual([
      "constructor",
      "execute",
      "drainFrame",
      "close",
      "snapshotTelemetry",
    ]);
  });

  it("enforces allowlist digest, type, per-plan rate/message ceilings, expiry, and replay protection", async () => {
    const edge = runtime();
    const port = new FakeReadPort();
    const deniedPlans = [
      plan("subscribe", { subscriptionId: "s-digest", topic: "/allowed", type: topicPolicy.type, maxRateHz: 1, maxMessageBytes: 1, allowlistDigest: `sha256:${"0".repeat(64)}` }),
      plan("subscribe", { subscriptionId: "s-topic", topic: "/secret", type: topicPolicy.type, maxRateHz: 1, maxMessageBytes: 1 }),
      plan("subscribe", { subscriptionId: "s-type", topic: "/allowed", type: "std_msgs/msg/String", maxRateHz: 1, maxMessageBytes: 1 }),
      plan("subscribe", { subscriptionId: "s-rate", topic: "/allowed", type: topicPolicy.type, maxRateHz: 11, maxMessageBytes: 1 }),
      plan("subscribe", { subscriptionId: "s-size", topic: "/allowed", type: topicPolicy.type, maxRateHz: 1, maxMessageBytes: 5 }),
    ];
    for (const denied of deniedPlans) {
      await expect(edge.execute(relayIdentity, denied, port)).resolves.toMatchObject({ ok: false, code: "topic-denied" });
    }
    const expired = { ...plan("discover"), issuedAtMs: 100, expiresAtMs: 999 };
    await expect(edge.execute(relayIdentity, expired, port)).resolves.toEqual({ ok: false, code: "invalid-plan" });
    const accepted = plan("discover");
    await expect(edge.execute(relayIdentity, accepted, port)).resolves.toMatchObject({ ok: true });
    await expect(edge.execute(relayIdentity, accepted, port)).resolves.toEqual({ ok: false, code: "replayed-plan" });
  });

  it("enforces subscription, frame-size, queue, byte, frame-rate, and command-rate limits with bounded telemetry", async () => {
    let now = 1000;
    const edge = runtime({}, () => now);
    const port = new FakeReadPort();
    await expect(edge.execute(relayIdentity, plan("subscribe", {
      subscriptionId: "subscription-a",
      topic: "/allowed",
      type: topicPolicy.type,
      maxRateHz: 10,
      maxMessageBytes: 4,
    }), port)).resolves.toEqual({ ok: true, reply: { version: 1, kind: "ack", operation: "subscribe" } });
    port.onFrame?.(Uint8Array.of(1, 2, 3, 4));
    port.onFrame?.(Uint8Array.of(5));
    now += 100;
    port.onFrame?.(Uint8Array.of(1, 2, 3, 4, 5));
    expect(edge.drainFrame("subscription-a")?.payload).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(edge.snapshotTelemetry()).toMatchObject({
      acceptedCommands: 1,
      acceptedFrames: 1,
      droppedFrames: 2,
      bufferedBytes: 0,
    });
    expect(edge.snapshotTelemetry().recentEvents.length).toBeLessThanOrEqual(limits.maxTelemetryEvents);

    const rateLimited = runtime({ maxCommandsPerWindow: 2 });
    await expect(rateLimited.execute(relayIdentity, plan("discover"), port)).resolves.toMatchObject({ ok: true });
    await expect(rateLimited.execute(relayIdentity, plan("discover"), port)).resolves.toMatchObject({ ok: true });
    await expect(rateLimited.execute(relayIdentity, plan("discover"), port)).resolves.toEqual({ ok: false, code: "rate-limited" });
  });

  it("closes only connection-owned subscriptions and fails closed without leaking backend errors", async () => {
    const edge = runtime();
    const port = new FakeReadPort();
    await edge.execute(relayIdentity, plan("subscribe", {
      subscriptionId: "subscription-a",
      topic: "/allowed",
      type: topicPolicy.type,
      maxRateHz: 1,
      maxMessageBytes: 1,
    }), port);
    await expect(edge.execute(relayIdentity, plan("unsubscribe", {
      subscriptionId: "subscription-a",
      connectionId: "other-connection",
    }), port)).resolves.toEqual({ ok: false, code: "unknown-subscription" });
    await expect(edge.execute(relayIdentity, plan("unsubscribe", { subscriptionId: "subscription-a" }), port)).resolves.toEqual({
      ok: true,
      reply: { version: 1, kind: "ack", operation: "unsubscribe" },
    });
    expect(port.close).toHaveBeenCalledOnce();

    const failing = runtime();
    const failingPort = new FakeReadPort();
    failingPort.discover.mockRejectedValueOnce(new Error("sensitive ROS backend detail"));
    await expect(failing.execute(relayIdentity, plan("discover"), failingPort)).resolves.toEqual({
      ok: false,
      code: "edge-failure",
    });
  });
});

describe("generation-specific reference adapters", () => {
  const common = {
    listener: { host: "127.0.0.1", port: 7441, tls: true } as const,
    allowedRelayIds: ["relay-a"],
    allowedTopics: [topicPolicy],
    allowlistDigest,
    verifyRelayCredential: ({ credential }: { credential: string }) => credential === "edge-secret",
  };

  it("locks ROS1 EOL into a separate read-only non-root process without browser or ROS2 access", () => {
    expect(() => createRos1PrivateEdgeAdapter({
      ...common,
      eolIsolation: {
        lifecycle: "separate-process",
        filesystem: "read-only",
        processUser: "non-root",
        browserIngress: false,
        ros2DomainAccess: false,
      },
    })).not.toThrow();
    expect(() => createRos1PrivateEdgeAdapter({
      ...common,
      eolIsolation: {
        lifecycle: "separate-process",
        filesystem: "read-only",
        processUser: "non-root",
        browserIngress: true as false,
        ros2DomainAccess: false,
      },
    })).toThrow(/isolation profile/);
  });

  it("locks ROS2 discovery to a valid local domain", () => {
    expect(createRos2PrivateEdgeAdapter({ ...common, domainId: 0, localhostOnly: true }).generation).toBe("ros2");
    expect(() => createRos2PrivateEdgeAdapter({ ...common, domainId: 233, localhostOnly: true })).toThrow(/domainId/);
  });

  it("keeps checked-in configs local-only, private, TLS, allowlisted, secret-free, and scope-neutral", () => {
    for (const url of [
      new URL("../../../bridges/ros1/config/private-reference.json", import.meta.url),
      new URL("../../../bridges/ros2/config/private-reference.json", import.meta.url),
    ]) {
      const config = JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
      expect(config.deployment).toBe("local-reference-only");
      expect(config.listener).toMatchObject({ host: "127.0.0.1", tls: true });
      expect(config.allowedRelayIds).toEqual(["local-relay"]);
      expect(config.allowedTopics).toEqual(expect.arrayContaining([expect.objectContaining({ topic: "/tf" }), expect.objectContaining({ topic: "/points" })]));
      expect(config).not.toHaveProperty("credential");
      expect(JSON.stringify(config)).not.toMatch(/public|mobile|VR|collaboration|enterprise|paid|license|brand/i);
    }
  });
});
