import { describe, expect, it, vi } from "vitest";

import { LIVE_PROTOCOL_VERSION, type EdgePlan, type EdgeReply, type RelayEdgeIdentity } from "@ros-web-viewer/protocol";

import {
  InMemorySessionAuthenticator,
  RelayDenied,
  SecureLiveRelay,
  type EdgeTransport,
  type RelayConfiguration,
} from "../src/index.js";

const topic = {
  topic: "/points",
  type: "sensor_msgs/msg/PointCloud2",
  maxRateHz: 10,
  maxMessageBytes: 1_024,
} as const;

class RecordingEdge implements EdgeTransport {
  readonly requests: { readonly identity: RelayEdgeIdentity; readonly plan: EdgePlan }[] = [];

  async request(identity: RelayEdgeIdentity, plan: EdgePlan): Promise<EdgeReply> {
    this.requests.push({ identity, plan });
    if (plan.operation === "discover") {
      return {
        version: LIVE_PROTOCOL_VERSION,
        kind: "discovery",
        topics: [topic, { ...topic, topic: "/private", type: "example_msgs/Private" }],
      };
    }
    return { version: LIVE_PROTOCOL_VERSION, kind: "ack", operation: plan.operation };
  }
}

function fixture(overrides: Partial<RelayConfiguration> = {}) {
  let now = 10_000;
  let nonce = 0;
  const edge = new RecordingEdge();
  const authenticator = new InMemorySessionAuthenticator([{
    credential: "browser-secret",
    grant: {
      principalId: "principal-1",
      sessionId: "session-1",
      allowedOrigins: ["https://viewer.example"],
      expiresAtMs: 20_000,
    },
  }]);
  const relay = new SecureLiveRelay({
    authenticator,
    allowedOrigins: ["https://viewer.example"],
    resolveSessionPolicy: () => ({ topics: [topic] }),
    edgeIdentity: { identityId: "relay-edge-1", credential: "edge-only-secret" },
    edgeTransport: edge,
    now: () => now,
    nonce: () => `nonce-${nonce++}`,
    limits: {
      maxConnectionsPerSession: 1,
      maxSubscriptionsPerSession: 1,
      maxRequestsPerWindow: 20,
      maxRequestBytesPerWindow: 16_384,
      maxQueueMessages: 3,
      maxQueueBytes: 1_000,
      maxDrainMessages: 3,
      maxDrainBytes: 1_000,
      edgePlanTtlMs: 500,
    },
    protocolLimits: { maxMessageBytes: 1_024 },
    ...overrides,
  });
  return { relay, edge, setNow: (value: number) => { now = value; } };
}

function frame(sequence: number, operation: "discover" | "health" = "health") {
  return {
    version: LIVE_PROTOCOL_VERSION,
    operation,
    sessionId: "session-1",
    sequence,
    requestId: `request-${sequence}`,
  } as const;
}

function connectRelay(relay: SecureLiveRelay, request: Record<string, unknown>) {
  return relay.connect(JSON.stringify(request));
}

function pushEdge(connection: Awaited<ReturnType<SecureLiveRelay["connect"]>>, message: {
  readonly subscriptionId: string;
  readonly sourceSequence: number;
  readonly timestampNanos: string;
  readonly payload: Uint8Array;
}) {
  return connection.pushFromEdge(JSON.stringify({
    subscriptionId: message.subscriptionId,
    sourceSequence: message.sourceSequence,
    timestampNanos: message.timestampNanos,
    payloadBase64: Buffer.from(message.payload).toString("base64url"),
  }));
}

function subscribe(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    ...frame(sequence),
    operation: "subscribe" as const,
    subscriptionId: "subscription-1",
    topic: topic.topic,
    type: topic.type,
    maxRateHz: topic.maxRateHz,
    maxMessageBytes: topic.maxMessageBytes,
    ...overrides,
  };
}

describe("secure live relay", () => {
  it("admits connect and edge messages only as bounded serialized text without caller traps", async () => {
    const authenticate = vi.fn(async () => undefined);
    const { relay } = fixture({ authenticator: { authenticate } });
    const get = vi.fn(() => "x");
    const getPrototypeOf = vi.fn(Reflect.getPrototypeOf);
    const ownKeys = vi.fn(Reflect.ownKeys);
    const hostile = new Proxy({}, { get, getPrototypeOf, ownKeys });
    await expect(relay.connect(hostile as unknown as string)).rejects.toMatchObject({ code: "unauthorized" });
    expect(get).not.toHaveBeenCalled();
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();

    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      await expect(relay.connect(JSON.stringify({
        credential: "x".repeat(5_000_000),
        origin: "https://viewer.example",
        sessionId: "session-1",
      }))).rejects.toMatchObject({ code: "unauthorized" });
      expect(authenticate).not.toHaveBeenCalled();
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }

    const connection = await connectRelay(fixture().relay, {
      credential: "browser-secret", origin: "https://viewer.example", sessionId: "session-1",
    });
    expect(connection.pushFromEdge(hostile as unknown as string)).toBe(false);
    expect(get).not.toHaveBeenCalled();
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it("fails connection auth closed with constant-shape denial for Origin, session, token, expiry, and quotas", async () => {
    const { relay, setNow } = fixture();
    const invalid = [
      { credential: "wrong", origin: "https://viewer.example", sessionId: "session-1" },
      { credential: "browser-secret", origin: "https://evil.example", sessionId: "session-1" },
      { credential: "browser-secret", origin: "https://viewer.example/path", sessionId: "session-1" },
      { credential: "browser-secret", origin: "https://viewer.example", sessionId: "session-2" },
    ];
    for (const request of invalid) {
      await expect(connectRelay(relay, request)).rejects.toMatchObject({
        name: "RelayDenied",
        code: "unauthorized",
        message: "connection is not authorized",
      });
    }

    const connection = await connectRelay(relay, {
      credential: "browser-secret",
      origin: "https://viewer.example",
      sessionId: "session-1",
      connectionId: "connection-1",
    });
    await expect(connectRelay(relay, {
      credential: "browser-secret",
      origin: "https://viewer.example",
      sessionId: "session-1",
    })).rejects.toBeInstanceOf(RelayDenied);
    await connection.close();
    setNow(20_000);
    await expect(connectRelay(relay, {
      credential: "browser-secret",
      origin: "https://viewer.example",
      sessionId: "session-1",
    })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("generates exact subscribe-only edge plans under a distinct relay identity and never forwards browser frames", async () => {
    const { relay, edge } = fixture();
    const connection = await connectRelay(relay, {
      credential: "browser-secret",
      origin: "https://viewer.example",
      sessionId: "session-1",
      connectionId: "connection-1",
    });

    const discovery = await connection.handle(JSON.stringify(frame(0, "discover")));
    expect(discovery).toMatchObject({ kind: "discovery", topics: [topic] });
    expect(edge.requests[0]).toMatchObject({
      identity: { identityId: "relay-edge-1", credential: "edge-only-secret" },
      plan: {
        version: 1,
        operation: "discover",
        sessionId: "session-1",
        connectionId: "connection-1",
        sequence: 0,
        nonce: "nonce-0",
        issuedAtMs: 10_000,
        expiresAtMs: 10_500,
        allowlistDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
    expect(JSON.stringify(edge.requests[0])).not.toContain("browser-secret");

    expect(await connection.handle(JSON.stringify(subscribe(1)))).toMatchObject({ kind: "ack", operation: "subscribe" });
    expect(edge.requests[1]!.plan).toMatchObject({
      operation: "subscribe",
      subscriptionId: "subscription-1",
      topic: topic.topic,
      type: topic.type,
      maxRateHz: topic.maxRateHz,
      maxMessageBytes: topic.maxMessageBytes,
    });

    const writes = ["publish", "call_service", "action", "set_parameter", "raw"];
    for (const operation of writes) {
      const response = await connection.handle(JSON.stringify({ ...frame(2), operation, payload: { dangerous: true } }));
      expect(response).toMatchObject({ kind: "error", code: "invalid-request", message: "request was rejected" });
    }
    expect(edge.requests).toHaveLength(2);

    const ownKeys = vi.fn(Reflect.ownKeys);
    const hostile = new Proxy(frame(3), { ownKeys });
    expect(await connection.handle(hostile as unknown as string)).toMatchObject({ kind: "error", code: "invalid-request" });
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it("enforces replay across reconnect, exact allowlists, subscription quota, expiry, and request quota", async () => {
    const { relay, edge, setNow } = fixture();
    const first = await connectRelay(relay, {
      credential: "browser-secret",
      origin: "https://viewer.example",
      sessionId: "session-1",
      connectionId: "connection-1",
    });
    expect(await first.handle(JSON.stringify(frame(4)))).toMatchObject({ kind: "health" });
    expect(await first.handle(JSON.stringify(frame(4)))).toMatchObject({ kind: "error", code: "replayed-request" });
    expect(await first.handle(JSON.stringify(subscribe(5, { topic: "/not-allowed" })))).toMatchObject({ kind: "error", code: "policy-denied" });
    expect(edge.requests).toHaveLength(0);
    await first.close();

    const second = await connectRelay(relay, {
      credential: "browser-secret",
      origin: "https://viewer.example",
      sessionId: "session-1",
      connectionId: "connection-2",
    });
    expect(second.connectionEpoch).toBe(2);
    expect(await second.handle(JSON.stringify(frame(3)))).toMatchObject({ kind: "error", code: "replayed-request" });
    setNow(20_000);
    expect(await second.handle(JSON.stringify(frame(6)))).toMatchObject({ kind: "error", code: "unauthorized" });
    expect(relay.telemetry()).toMatchObject({ replayedFrames: 2, edgeRequests: 0 });
  });

  it("enforces subscription, request-count, and request-byte quotas before additional edge work", async () => {
    const requestLimited = fixture({ limits: {
      maxConnectionsPerSession: 1,
      maxSubscriptionsPerSession: 1,
      maxRequestsPerWindow: 2,
      maxRequestBytesPerWindow: 1_000,
      maxQueueMessages: 3,
      maxQueueBytes: 1_000,
      maxDrainMessages: 3,
      maxDrainBytes: 1_000,
      edgePlanTtlMs: 500,
    } });
    const connection = await connectRelay(requestLimited.relay, {
      credential: "browser-secret",
      origin: "https://viewer.example",
      sessionId: "session-1",
    });
    expect(await connection.handle(JSON.stringify(frame(0)))).toMatchObject({ kind: "health" });
    expect(await connection.handle(JSON.stringify(frame(1)))).toMatchObject({ kind: "health" });
    expect(await connection.handle(JSON.stringify(frame(2)))).toMatchObject({ kind: "error", code: "quota-exceeded" });
    expect(requestLimited.edge.requests).toHaveLength(0);

    const subscriptionLimited = fixture();
    const second = await connectRelay(subscriptionLimited.relay, {
      credential: "browser-secret",
      origin: "https://viewer.example",
      sessionId: "session-1",
    });
    expect(await second.handle(JSON.stringify(subscribe(0)))).toMatchObject({ kind: "ack" });
    expect(await second.handle(JSON.stringify(subscribe(1, { subscriptionId: "subscription-2" })))).toMatchObject({
      kind: "error",
      code: "quota-exceeded",
    });
    expect(subscriptionLimited.edge.requests).toHaveLength(1);
  });

  it("keeps message queues bounded, drops oldest/over-rate/oversized data, and exposes only redacted telemetry", async () => {
    const { relay } = fixture();
    const connection = await connectRelay(relay, {
      credential: "browser-secret",
      origin: "https://viewer.example",
      sessionId: "session-1",
      connectionId: "connection-1",
    });
    expect(await connection.handle(JSON.stringify(subscribe(0, { maxRateHz: 4, maxMessageBytes: 300 })))).toMatchObject({ kind: "ack" });

    for (let sequence = 0; sequence < 6; sequence += 1) {
      pushEdge(connection, {
        subscriptionId: "subscription-1",
        sourceSequence: sequence,
        timestampNanos: String(sequence),
        payload: new Uint8Array(200).fill(sequence),
      });
    }
    expect(pushEdge(connection, {
      subscriptionId: "subscription-1",
      sourceSequence: 7,
      timestampNanos: "7",
      payload: new Uint8Array(301),
    })).toBe(false);

    const health = connection.health();
    expect(health.queueDepth).toBeLessThanOrEqual(3);
    expect(health.queueBytes).toBeLessThanOrEqual(1_000);
    expect(health.queueHighWaterMessages).toBeLessThanOrEqual(3);
    expect(health.queueHighWaterBytes).toBeLessThanOrEqual(1_000);
    expect(health.droppedMessages).toBeGreaterThanOrEqual(4);
    expect(connection.drain().map((event) => event.sourceSequence)).toEqual([1, 2, 3]);

    const serialized = JSON.stringify({ relay: relay.telemetry(), connection: connection.health() });
    expect(serialized).not.toContain("session-1");
    expect(serialized).not.toContain("/points");
    expect(serialized).not.toContain("browser-secret");
    expect(serialized).not.toContain("edge-only-secret");
  });
});
