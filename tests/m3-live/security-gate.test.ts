import { readFileSync } from "node:fs";

import { emitV1SemanticEvent } from "../support/v1-conformance-event.js";
import { describe, expect, it } from "vitest";

import {
  InMemorySessionAuthenticator,
  SecureLiveRelay,
  type EdgeTransport,
} from "../../apps/relay/src/index.js";
import { parseBrowserFrameJson } from "../../packages/protocol/src/index.js";
import {
  PrivateEdgeRuntime,
  computeAllowlistDigest,
  type EdgePlan,
  type EdgeReadPort,
  type EdgeReply,
  type RelayEdgeIdentity,
} from "../../packages/edge-runtime/src/index.js";
import { BoundedLiveSource } from "../../packages/source-live/src/index.js";
import {
  SyntheticLiveRelayTransport,
  createSyntheticFixture,
  liveTopics,
  runSyntheticLoadProof,
} from "./proof-harness.js";

class NoopPort implements EdgeReadPort {
  readonly calls: string[] = [];

  async discover(): Promise<readonly []> {
    this.calls.push("discover");
    return [];
  }

  async subscribe(): Promise<{ close(): void }> {
    this.calls.push("subscribe");
    return { close() {} };
  }
}

function edgePlan(overrides: Record<string, unknown> = {}): EdgePlan {
  return {
    version: 1,
    operation: "discover",
    sessionId: "m3-session",
    connectionId: "connection-1",
    sequence: 0,
    nonce: "nonce-1",
    issuedAtMs: 10_000,
    expiresAtMs: 10_500,
    allowlistDigest: computeAllowlistDigest(liveTopics),
    ...overrides,
  } as EdgePlan;
}

describe("M3 negative protocol and boundary proof", () => {
  it("rejects invalid Origin, browser credential, session binding, expiry, and connection quota with one public denial shape", async () => {
    let now = 10_000;
    const authenticator = new InMemorySessionAuthenticator([{
      credential: "browser-secret",
      grant: {
        principalId: "principal",
        sessionId: "session",
        allowedOrigins: ["https://viewer.example"],
        expiresAtMs: 11_000,
      },
    }]);
    const edge: EdgeTransport = {
      async request(_identity: RelayEdgeIdentity, plan: EdgePlan): Promise<EdgeReply> {
        return plan.operation === "discover"
          ? { version: 1, kind: "discovery", topics: [] }
          : { version: 1, kind: "ack", operation: plan.operation };
      },
    };
    const relay = new SecureLiveRelay({
      authenticator,
      allowedOrigins: ["https://viewer.example"],
      resolveSessionPolicy: () => ({ topics: liveTopics }),
      edgeIdentity: { identityId: "relay", credential: "edge-only" },
      edgeTransport: edge,
      now: () => now,
      limits: { maxConnectionsPerSession: 1 },
    });

    const invalid = [
      { credential: "wrong", origin: "https://viewer.example", sessionId: "session" },
      { credential: "browser-secret", origin: "https://evil.example", sessionId: "session" },
      { credential: "browser-secret", origin: "https://viewer.example/path", sessionId: "session" },
      { credential: "browser-secret", origin: "https://viewer.example", sessionId: "other" },
    ];
    for (const request of invalid) {
      await expect(relay.connect(request)).rejects.toMatchObject({
        code: "unauthorized",
        message: "connection is not authorized",
      });
    }
    const connection = await relay.connect({
      credential: "browser-secret",
      origin: "https://viewer.example",
      sessionId: "session",
    });
    await expect(relay.connect({
      credential: "browser-secret",
      origin: "https://viewer.example",
      sessionId: "session",
    })).rejects.toMatchObject({ code: "unauthorized" });
    await connection.close();
    now = 11_000;
    await expect(relay.connect({
      credential: "browser-secret",
      origin: "https://viewer.example",
      sessionId: "session",
    })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects duplicate keys, writes, replay, wildcard/topic/type/size escalation, and quotas before extra edge work", async () => {
    expect(() => parseBrowserFrameJson(
      '{"version":1,"operation":"health","sessionId":"m3-session","sequence":0,"sequence":1,"requestId":"r"}',
    )).toThrow(/duplicate key/);

    const fixture = createSyntheticFixture("ros2");
    const connection = await fixture.connect("negative-connection");
    const forbiddenOperations = ["publish", "call-service", "send-action", "set-parameter", "raw-command"];
    for (const [index, operation] of forbiddenOperations.entries()) {
      const response = await connection.handleHostFrame({
        version: 1,
        operation,
        sessionId: "m3-session",
        sequence: index,
        requestId: `forbidden-${index}`,
      });
      expect(response).toMatchObject({ kind: "error", code: "invalid-request" });
    }
    const deniedSubscriptions = [
      { topic: "/*", type: liveTopics[0]!.type, maxRateHz: 1, maxMessageBytes: 1 },
      { topic: "/not-allowed", type: liveTopics[0]!.type, maxRateHz: 1, maxMessageBytes: 1 },
      { topic: liveTopics[0]!.topic, type: "std_msgs/msg/String", maxRateHz: 1, maxMessageBytes: 1 },
      { topic: liveTopics[0]!.topic, type: liveTopics[0]!.type, maxRateHz: 1, maxMessageBytes: 513 },
    ];
    for (const [index, denied] of deniedSubscriptions.entries()) {
      const response = await connection.handleHostFrame({
        version: 1,
        operation: "subscribe",
        sessionId: "m3-session",
        sequence: forbiddenOperations.length + index,
        requestId: `denied-${index}`,
        subscriptionId: `denied-${index}`,
        ...denied,
      });
      expect(response).toMatchObject({ kind: "error" });
    }
    const replaySequence = forbiddenOperations.length + deniedSubscriptions.length;
    const health = {
      version: 1,
      operation: "health",
      sessionId: "m3-session",
      sequence: replaySequence,
      requestId: "health",
    } as const;
    expect(await connection.handleHostFrame(health)).toMatchObject({ kind: "health" });
    expect(await connection.handleHostFrame(health)).toMatchObject({ kind: "error", code: "replayed-request" });
    expect(await connection.handle("x".repeat(20_000))).toMatchObject({ kind: "error" });
    expect(fixture.relay.telemetry().edgeRequests).toBe(0);
  });

  it("bounds request and subscription quotas before additional edge operations", async () => {
    let edgeRequests = 0;
    const relay = new SecureLiveRelay({
      authenticator: new InMemorySessionAuthenticator([{
        credential: "browser-secret",
        grant: {
          principalId: "principal",
          sessionId: "m3-session",
          allowedOrigins: ["https://viewer.example"],
          expiresAtMs: 20_000,
        },
      }]),
      allowedOrigins: ["https://viewer.example"],
      resolveSessionPolicy: () => ({ topics: liveTopics }),
      edgeIdentity: { identityId: "relay", credential: "edge-secret" },
      edgeTransport: {
        async request(_identity, plan) {
          edgeRequests += 1;
          return { version: 1, kind: "ack", operation: plan.operation === "unsubscribe" ? "unsubscribe" : "subscribe" };
        },
      },
      now: () => 10_000,
      limits: {
        maxSubscriptionsPerSession: 1,
        maxRequestsPerWindow: 2,
        maxRequestBytesPerWindow: 16_384,
      },
    });
    const connection = await relay.connect({
      credential: "browser-secret",
      origin: "https://viewer.example",
      sessionId: "m3-session",
    });
    expect(await connection.handleHostFrame({
      version: 1,
      operation: "subscribe",
      sessionId: "m3-session",
      sequence: 0,
      requestId: "subscribe-0",
      subscriptionId: "subscription-0",
      ...liveTopics[0],
    })).toMatchObject({ kind: "ack" });
    expect(await connection.handleHostFrame({
      version: 1,
      operation: "subscribe",
      sessionId: "m3-session",
      sequence: 1,
      requestId: "subscribe-1",
      subscriptionId: "subscription-1",
      ...liveTopics[1],
    })).toMatchObject({ kind: "error", code: "quota-exceeded" });
    expect(await connection.handleHostFrame({
      version: 1,
      operation: "health",
      sessionId: "m3-session",
      sequence: 2,
      requestId: "health-2",
    })).toMatchObject({ kind: "error", code: "quota-exceeded" });
    expect(edgeRequests).toBe(1);
  });

  it("denies public/browser identity, expired/replayed/wrong-digest/write-shaped direct-edge plans before ROS access", async () => {
    const topic = liveTopics[0]!;
    const digest = computeAllowlistDigest(liveTopics);
    const edge = new PrivateEdgeRuntime({
      generation: "ros2",
      listener: { host: "127.0.0.1", port: 7442, tls: true },
      allowedRelayIds: ["m3-relay"],
      allowedTopics: liveTopics,
      allowlistDigest: digest,
      verifyRelayCredential: ({ credential }) => credential === "edge-secret",
    }, () => 10_000);
    const port = new NoopPort();
    const identities = [
      { sessionId: "browser", credential: "browser-secret" },
      { identityId: "public-client", credential: "edge-secret" },
      { identityId: "m3-relay", credential: "wrong" },
      { identityId: "m3-relay", credential: "edge-secret", browserSession: "must-not-cross" },
    ];
    for (const identity of identities) {
      await expect(edge.execute(identity, edgePlan(), port)).resolves.toEqual({ ok: false, code: "unauthenticated-relay" });
    }

    const relayIdentity = { identityId: "m3-relay", credential: "edge-secret" };
    const invalidPlans = [
      edgePlan({ issuedAtMs: 9_000, expiresAtMs: 10_000 }),
      edgePlan({ allowlistDigest: `sha256:${"0".repeat(64)}` }),
      edgePlan({ operation: "publish", topic: topic.topic, payload: [1] }),
      edgePlan({ operation: "subscribe", subscriptionId: "s", topic: "/*", type: topic.type, maxRateHz: 1, maxMessageBytes: 1 }),
      edgePlan({ operation: "subscribe", subscriptionId: "s", topic: topic.topic, type: "std_msgs/msg/String", maxRateHz: 1, maxMessageBytes: 1 }),
      edgePlan({ operation: "subscribe", subscriptionId: "s", topic: topic.topic, type: topic.type, maxRateHz: 1_001, maxMessageBytes: 1 }),
      edgePlan({ operation: "subscribe", subscriptionId: "s", topic: topic.topic, type: topic.type, maxRateHz: 1, maxMessageBytes: 16_777_217 }),
    ].map((plan, index) => ({ ...plan, sequence: index, nonce: `invalid-${index}` }));
    for (const plan of invalidPlans) {
      await expect(edge.execute(relayIdentity, plan, port)).resolves.toMatchObject({ ok: false });
    }
    const accepted = edgePlan({ sequence: 100, nonce: "accepted" });
    await expect(edge.execute(relayIdentity, accepted, port)).resolves.toMatchObject({ ok: true });
    await expect(edge.execute(relayIdentity, accepted, port)).resolves.toEqual({ ok: false, code: "replayed-plan" });
    expect(port.calls).toEqual(["discover"]);
    expect(Object.getOwnPropertyNames(PrivateEdgeRuntime.prototype)).toEqual([
      "constructor",
      "execute",
      "drainFrame",
      "close",
      "snapshotTelemetry",
    ]);
  });
});

describe("M3 deterministic synthetic load evidence", () => {
  it("feeds strict relay events into the bounded live source and advances reconnect epochs", async () => {
    const fixture = createSyntheticFixture("ros2");
    const transport = new SyntheticLiveRelayTransport(fixture);
    const source = new BoundedLiveSource(
      transport,
      { browserOrigin: "https://viewer.example", sessionToken: "browser-secret" },
      {
        maxTopicsPerSubscription: 2,
        maxMessageBytes: 2_048,
        maxMessagesPerSecond: 100,
        maxQueueMessages: 4,
        maxQueueBytes: 4_096,
      },
    );

    expect(await source.connect()).toMatchObject([
      { id: "/camera/image", name: "/camera/image", schema: { typeName: "sensor_msgs/msg/Image", encoding: "cdr" } },
      { id: "/points", name: "/points", schema: { typeName: "sensor_msgs/msg/PointCloud2", encoding: "cdr" } },
    ]);
    await source.subscribe(["/points"]);
    fixture.setNow(10_001);
    fixture.port.emit("/points", Uint8Array.of(1, 2, 3));
    expect(transport.flushFromEdge()).toBe(1);
    expect(source.drain()).toMatchObject([{
      version: 1,
      sourceEpoch: 1,
      topicId: "/points",
      topicName: "/points",
      sequence: 0n,
      schema: { typeName: "sensor_msgs/msg/PointCloud2", encoding: "cdr" },
      payload: Uint8Array.of(1, 2, 3),
    }]);
    expect(source.telemetry).toMatchObject({ acceptedMessages: 1, deliveredMessages: 1, sourceEpoch: 1 });

    expect(await source.reconnect()).toHaveLength(2);
    expect(source.telemetry).toMatchObject({ sourceEpoch: 2, reconnects: 1 });
    await source.close();
    await fixture.edge.close();
  });

  it.each(["ros1", "ros2"] as const)("keeps %s point-cloud/image-like load bounded and reconnects by epoch", async (generation) => {
    const proof = await runSyntheticLoadProof(generation);
    expect(proof.attemptedFrames).toBe(1_000);
    expect(proof.edge.acceptedFrames + proof.edge.droppedFrames).toBe(proof.attemptedFrames);
    expect(proof.edge.acceptedFrames).toBeGreaterThan(0);
    expect(proof.edge.droppedFrames).toBeGreaterThan(0);
    expect(proof.edge.telemetryEvents).toBeLessThanOrEqual(32);
    expect(proof.relay.queueDepth).toBeLessThanOrEqual(12);
    expect(proof.relay.queueBytes).toBeLessThanOrEqual(10_000);
    expect(proof.relay.queueHighWaterMessages).toBeLessThanOrEqual(12);
    expect(proof.relay.queueHighWaterBytes).toBeLessThanOrEqual(10_000);
    expect(proof.relay.droppedMessages).toBeGreaterThan(0);
    expect(proof.syntheticTransitLatencyNanos).toMatchObject({ maximum: 2_000_000, p95: 2_000_000 });
    expect(proof.reconnectEpochs).toEqual([1, 2]);
    expect(proof.noRosWriteSurface).toBe(true);
    emitV1SemanticEvent({ schemaVersion: 1, domain: "source", result: "pass", code: `${generation}-live-bounded`, facts: {
      acceptedFrames: proof.edge.acceptedFrames, droppedFrames: proof.edge.droppedFrames,
      generation, reconnectEpochs: proof.reconnectEpochs.join(","),
    } });
  });

  it("keeps the checked-in evidence equal to a fresh local synthetic run and scoped away from production claims", async () => {
    const artifact = JSON.parse(
      readFileSync(new URL("../../docs/evidence/m3-live.json", import.meta.url), "utf8"),
    ) as {
      evidenceKind: string;
      networkExecution: boolean;
      containerExecution: boolean;
      productionSecurityClaim: boolean;
      loadProfiles: unknown[];
      negativeCases: string[];
      limitations: string[];
    };
    const fresh = await Promise.all([runSyntheticLoadProof("ros1"), runSyntheticLoadProof("ros2")]);
    expect(artifact.loadProfiles).toEqual(fresh);
    expect(artifact).toMatchObject({
      evidenceKind: "deterministic-local-synthetic-contract",
      networkExecution: false,
      containerExecution: false,
      productionSecurityClaim: false,
    });
    expect(artifact.negativeCases).toEqual(expect.arrayContaining([
      "invalid-origin",
      "invalid-session",
      "invalid-relay-identity",
      "expiry",
      "replay",
      "write-operation",
      "topic-and-type-escalation",
      "size-and-quota",
      "public-direct-edge-identity",
    ]));
    expect(artifact.limitations.length).toBeGreaterThan(0);
  });
});
