import { describe, expect, it, vi } from "vitest";

import { emitV1SemanticEvent } from "../../../tests/support/v1-conformance-event.js";
import {
  BoundedLiveSource,
  type LiveRelayConnection,
  type LiveRelayFrame,
  type LiveRelaySubscription,
  type LiveRelayTransport,
} from "../src/index.js";

const topics = [
  { id: "points", name: "/points", schema: { typeName: "sensor_msgs/msg/PointCloud2", encoding: "cdr" } },
  { id: "path", name: "/path", schema: { typeName: "nav_msgs/msg/Path", encoding: "cdr" } },
] as const;

function harness(overrides: Partial<LiveRelayConnection> = {}): {
  transport: LiveRelayTransport;
  emit(frame: LiveRelayFrame): void;
  emitFrom(subscriptionIndex: number, frame: LiveRelayFrame): void;
  closeSubscription: ReturnType<typeof vi.fn>;
  closeConnection: ReturnType<typeof vi.fn>;
  subscribed: string[][];
} {
  const callbacks: Array<(frame: LiveRelayFrame) => void> = [];
  const subscribed: string[][] = [];
  const closeSubscription = vi.fn(async () => undefined);
  const closeConnection = vi.fn(async () => undefined);
  const subscription: LiveRelaySubscription = { close: closeSubscription };
  const connection: LiveRelayConnection = {
    binding: { browserOrigin: "https://viewer.example", sessionId: "session-1" },
    discoverTopics: async () => topics,
    async subscribe(topicIds, onFrame) {
      subscribed.push([...topicIds]);
      callbacks.push(onFrame);
      return subscription;
    },
    close: closeConnection,
    ...overrides,
  };
  return {
    transport: { connect: vi.fn(async () => connection) },
    emit(frame) {
      const callback = callbacks.at(-1);
      if (!callback) throw new Error("not subscribed");
      callback(frame);
    },
    emitFrom(subscriptionIndex, frame) {
      const callback = callbacks[subscriptionIndex];
      if (!callback) throw new Error("unknown subscription");
      callback(frame);
    },
    closeSubscription,
    closeConnection,
    subscribed,
  };
}

function frame(topicId: string, sequence: bigint, sourceTimeNanos: bigint, receivedAtMillis = 1_000): LiveRelayFrame {
  return {
    topicId,
    sequence,
    sourceTimeNanos,
    receiptTimeNanos: sourceTimeNanos + 10n,
    receivedAtMillis,
    payload: new Uint8Array([Number(sequence)]),
  };
}

describe("bounded live source", () => {
  it("authenticates with an origin-bound session and exposes only discovered explicit subscriptions", async () => {
    const relay = harness();
    const source = new BoundedLiveSource(relay.transport, {
      browserOrigin: "https://viewer.example",
      sessionToken: "opaque-session-token",
    });
    await expect(source.connect()).resolves.toEqual([topics[1], topics[0]]);
    await source.subscribe(["points"]);
    expect(relay.transport.connect).toHaveBeenCalledWith({
      browserOrigin: "https://viewer.example",
      sessionToken: "opaque-session-token",
    });
    expect(relay.subscribed).toEqual([["points"]]);
    await expect(source.subscribe(["*"])).rejects.toThrow(/wildcard/);
    await expect(source.subscribe(["not-discovered"])).rejects.toThrow(/discovered catalog/);
    expect("publish" in source).toBe(false);
    expect("callService" in source).toBe(false);
  });

  it("rejects an origin-confused relay session before discovery or subscription", async () => {
    const relay = harness({ binding: { browserOrigin: "https://attacker.example", sessionId: "session-1" } });
    const source = new BoundedLiveSource(relay.transport, {
      browserOrigin: "https://viewer.example",
      sessionToken: "token",
    });
    await expect(source.connect()).rejects.toThrow(/origin binding/);
    expect(relay.closeConnection).toHaveBeenCalledOnce();
    expect(source.telemetry.state).toBe("disconnected");
  });

  it("normalizes schema/time envelopes and drains them in deterministic order", async () => {
    const relay = harness();
    const source = new BoundedLiveSource(relay.transport, {
      browserOrigin: "https://viewer.example",
      sessionToken: "token",
    });
    await source.connect();
    await source.subscribe(["points", "path"]);
    relay.emit(frame("points", 2n, 30n));
    relay.emit(frame("path", 1n, 10n));
    relay.emit(frame("points", 1n, 10n));

    const drained = source.drain();
    expect(drained.map(({ topicId, sequence }) => `${topicId}:${sequence}`)).toEqual(["path:1", "points:1", "points:2"]);
    expect(drained[1]).toMatchObject({
      version: 1,
      sourceEpoch: 1,
      topicName: "/points",
      time: { sourceTimeNanos: 10n, receiptTimeNanos: 20n },
      schema: { typeName: "sensor_msgs/msg/PointCloud2", encoding: "cdr" },
    });
    expect(source.telemetry).toMatchObject({ acceptedMessages: 3, deliveredMessages: 3, queuedMessages: 0 });
    emitV1SemanticEvent({ schemaVersion: 1, domain: "time-tf", result: "pass", code: "receipt-time", facts: {
      deliveredMessages: drained.length, receiptTimeNanos: drained[1]?.time.receiptTimeNanos.toString() ?? "missing",
      sourceTimeNanos: drained[1]?.time.sourceTimeNanos.toString() ?? "missing",
    } });
  });

  it("bounds message size, rate, and queue pressure with truthful degrade telemetry", async () => {
    const relay = harness();
    const source = new BoundedLiveSource(
      relay.transport,
      { browserOrigin: "https://viewer.example", sessionToken: "token" },
      {
        maxTopicsPerSubscription: 2,
        maxMessageBytes: 2,
        maxMessagesPerSecond: 2,
        maxQueueMessages: 1,
        maxQueueBytes: 2,
      },
    );
    await source.connect();
    await source.subscribe(["points"]);
    relay.emit({ ...frame("points", 0n, 0n), payload: new Uint8Array(3) });
    relay.emit(frame("points", 1n, 1n));
    relay.emit(frame("points", 2n, 2n));
    relay.emit(frame("points", 3n, 3n));

    expect(source.telemetry).toMatchObject({
      state: "degraded",
      queuedMessages: 1,
      queuedBytes: 1,
      acceptedMessages: 2,
      droppedOversize: 1,
      droppedRateLimited: 1,
      droppedQueuePressure: 1,
    });
    expect(source.drain().map(({ sequence }) => sequence)).toEqual([2n]);
  });

  it("increments epochs on reconnect, restores explicit subscriptions, and rejects stale callbacks", async () => {
    const relay = harness();
    const source = new BoundedLiveSource(relay.transport, {
      browserOrigin: "https://viewer.example",
      sessionToken: "token",
    });
    await source.connect();
    await source.subscribe(["points"]);
    relay.emit(frame("points", 0n, 0n));
    await source.reconnect();
    relay.emitFrom(0, frame("points", 1n, 1n));

    expect(source.telemetry).toMatchObject({
      sourceEpoch: 2,
      reconnects: 1,
      rejectedProtocolFrames: 1,
      queuedMessages: 0,
    });
    expect(relay.subscribed).toEqual([["points"], ["points"]]);
    await source.close();
    expect(source.telemetry).toMatchObject({ state: "disconnected", queuedMessages: 0 });
  });
});
