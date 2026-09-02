import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserLiveRelay } from "../src/browser-live.js";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instance?: FakeWebSocket;
  static instances: FakeWebSocket[] = [];
  static discoveryTopics: readonly unknown[] = [{ id: "points", name: "/points", typeName: "sensor_msgs/msg/PointCloud2", encoding: "cdr" }];
  static discoveryPages?: readonly (readonly unknown[])[];
  static rejectOperation?: string;
  static throwOperation?: string;

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  readonly sent: unknown[] = [];
  closeCalls = 0;

  constructor(readonly url: string, readonly protocol: string) {
    super();
    FakeWebSocket.instance = this;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(serialized: string): void {
    const frame = JSON.parse(serialized) as { operation: string; requestId: string };
    if (FakeWebSocket.throwOperation === frame.operation) throw new Error("synchronous send failure");
    this.sent.push(frame);
    const response = FakeWebSocket.rejectOperation === frame.operation
      ? { version: 1, kind: "error", requestId: frame.requestId, message: "rejected" }
      : frame.operation === "authenticate"
      ? { version: 1, kind: "ready", requestId: frame.requestId, sessionId: "bound-session", expiresAtMs: Date.now() + 60_000 }
      : frame.operation === "discover"
        ? (() => {
            const cursor = (frame as unknown as { cursor?: number }).cursor ?? 0;
            const page = FakeWebSocket.discoveryPages?.[cursor] ?? FakeWebSocket.discoveryTopics;
            return { version: 1, kind: "discovery", requestId: frame.requestId, topics: page, ...(FakeWebSocket.discoveryPages && cursor + 1 < FakeWebSocket.discoveryPages.length ? { nextCursor: cursor + 1 } : {}) };
          })()
        : { version: 1, kind: "ack", requestId: frame.requestId };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(response) })));
  }

  emitMessage(frame: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

describe("browser live relay transport", () => {
  beforeEach(() => {
    FakeWebSocket.discoveryTopics = [{ id: "points", name: "/points", typeName: "sensor_msgs/msg/PointCloud2", encoding: "cdr" }];
    FakeWebSocket.discoveryPages = undefined;
    FakeWebSocket.rejectOperation = undefined;
    FakeWebSocket.throwOperation = undefined;
    FakeWebSocket.instances = [];
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("authenticates, discovers, subscribes, and emits bounded read-only samples", async () => {
    const samples: Array<{ readonly topicId: string; readonly bytes: readonly number[] }> = [];
    const relay = new BrowserLiveRelay((topicId, sample) => samples.push({ topicId, bytes: [...sample.data] }));
    relay.setEndpoint("ws://127.0.0.1:9999/viewer");
    const opened = await relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" });
    expect(opened.topics).toEqual([expect.objectContaining({ id: "points", availableDisplays: ["point-cloud", "numeric-plot", "raw"] })]);
    await relay.subscribeLive(["points"]);
    FakeWebSocket.instance?.emitMessage({
      version: 1,
      kind: "message",
      topicId: "points",
      sequence: "1",
      sourceTimeNanos: "100",
      receiptTimeNanos: "105",
      typeName: "sensor_msgs/msg/PointCloud2",
      encoding: "cdr",
      payloadBase64: btoa(String.fromCharCode(1, 2, 3)),
    });
    expect(samples).toEqual([{ topicId: "points", bytes: [1, 2, 3] }]);
    relay.recordDisplayResult(1, 0);
    expect(relay.pollLive()).toMatchObject({ messageCount: 1, latestSourceTimeNanos: 100n, displayDeliveries: 1, displayErrors: 0, telemetry: { acceptedMessages: 1, deliveredMessages: 1, droppedMessages: 0, latestRelayLatencyMs: 0.000005 } });
    expect(FakeWebSocket.instance?.sent).toEqual([
      expect.objectContaining({ operation: "authenticate", sessionToken: "secret" }),
      expect.objectContaining({ operation: "discover" }),
      expect.objectContaining({ operation: "subscribe", topicIds: ["points"] }),
    ]);
  });

  it("collects bounded multi-page discovery without losing custom schemas", async () => {
    FakeWebSocket.discoveryPages = [
      [{ id: "custom-a", name: "/custom/a", typeName: "demo_msgs/msg/A", encoding: "cdr", schemaEncoding: "ros2msg", schemaDefinition: "int32 value\n" }],
      [{ id: "custom-b", name: "/custom/b", typeName: "demo_msgs/msg/B", encoding: "cdr", schemaEncoding: "ros2msg", schemaDefinition: "float64 value\n" }],
    ];
    const relay = new BrowserLiveRelay(() => undefined);
    relay.setEndpoint("ws://localhost:9999/viewer");
    const opened = await relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" });
    expect(opened.topics.map(({ id, schemaCapability }) => [id, schemaCapability])).toEqual([
      ["custom-a", "schema-present"],
      ["custom-b", "schema-present"],
    ]);
    expect(FakeWebSocket.instance?.sent.filter((frame) => (frame as { operation?: string }).operation === "discover")).toEqual([
      expect.objectContaining({ cursor: 0 }),
      expect.objectContaining({ cursor: 1 }),
    ]);
  });

  it("rejects empty advancing discovery pages instead of requesting forever", async () => {
    FakeWebSocket.discoveryPages = [[], []];
    const relay = new BrowserLiveRelay(() => undefined);
    relay.setEndpoint("ws://localhost:9999/viewer");
    await expect(relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" })).rejects.toThrow(/empty advancing discovery page/);
    expect(FakeWebSocket.instance?.sent.filter((frame) => (frame as { operation?: string }).operation === "discover")).toHaveLength(1);
  });

  it("rejects discovery beyond the exact 32-topic live allowlist contract", async () => {
    FakeWebSocket.discoveryTopics = Array.from({ length: 33 }, (_, index) => ({
      id: `topic-${index}`,
      name: `/topic/${index}`,
      typeName: "std_msgs/msg/Float64",
      encoding: "cdr",
    }));
    const relay = new BrowserLiveRelay(() => undefined);
    relay.setEndpoint("ws://localhost:9999/viewer");
    await expect(relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" })).rejects.toThrow(/too many discovered topics/);
  });

  it("rejects insecure non-loopback endpoints and wildcard subscriptions", async () => {
    const relay = new BrowserLiveRelay(() => undefined);
    expect(() => relay.setEndpoint("ws://relay.example/viewer")).toThrow(/WSS/);
    relay.setEndpoint("ws://localhost:9999/viewer");
    await relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" });
    await expect(relay.subscribeLive(["*"])).rejects.toThrow(/wildcard/);
  });

  it("closes the exact socket when authentication or discovery fails", async () => {
    FakeWebSocket.rejectOperation = "authenticate";
    const relay = new BrowserLiveRelay(() => undefined);
    relay.setEndpoint("ws://localhost:9999/viewer");
    await expect(relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "bad" })).rejects.toThrow(/rejected/);
    expect(FakeWebSocket.instance?.closeCalls).toBe(1);
    expect(FakeWebSocket.instance?.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("keeps unknown live types opaque unless discovery supplies a bounded schema", async () => {
    FakeWebSocket.discoveryTopics = [{ id: "custom", name: "/custom", typeName: "demo_msgs/msg/Status", encoding: "cdr" }];
    const relay = new BrowserLiveRelay(() => undefined);
    relay.setEndpoint("ws://localhost:9999/viewer");
    const opened = await relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" });
    expect(opened.topics[0]).toMatchObject({ compatibility: "opaque-inspectable", schemaCapability: "opaque", availableDisplays: ["raw"] });
  });

  it("drops replayed and discovery-mismatched live messages", async () => {
    const relay = new BrowserLiveRelay(() => undefined);
    relay.setEndpoint("ws://localhost:9999/viewer");
    await relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" });
    await relay.subscribeLive(["points"]);
    const message = { version: 1, kind: "message", topicId: "points", sequence: "1", sourceTimeNanos: "100", receiptTimeNanos: "105", typeName: "sensor_msgs/msg/PointCloud2", encoding: "cdr", payloadBase64: btoa("x") };
    FakeWebSocket.instance?.emitMessage(message);
    FakeWebSocket.instance?.emitMessage(message);
    FakeWebSocket.instance?.emitMessage({ ...message, sequence: "2", typeName: "wrong/Type" });
    expect(relay.pollLive()).toMatchObject({ messageCount: 1, telemetry: { acceptedMessages: 1, droppedMessages: 2, state: "degraded" } });
  });

  it("surfaces monotonic relay-side rate and backpressure drops", async () => {
    const relay = new BrowserLiveRelay(() => undefined);
    relay.setEndpoint("ws://localhost:9999/viewer");
    await relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" });
    await relay.subscribeLive(["points"]);
    FakeWebSocket.instance?.emitMessage({
      version: 1,
      kind: "message",
      topicId: "points",
      sequence: "1",
      sourceTimeNanos: "100",
      receiptTimeNanos: "105",
      typeName: "sensor_msgs/msg/PointCloud2",
      encoding: "cdr",
      payloadBase64: btoa("x"),
      relayDroppedMessages: 4,
      relayDropReason: "topic-rate-limit",
    });
    expect(relay.pollLive()).toMatchObject({
      messageCount: 1,
      telemetry: {
        acceptedMessages: 1,
        droppedMessages: 4,
        state: "degraded",
        diagnostic: "Relay dropped 4 message(s): topic-rate-limit.",
      },
    });
  });

  it("surfaces a drop-only standalone relay telemetry event", async () => {
    const relay = new BrowserLiveRelay(() => undefined);
    relay.setEndpoint("ws://localhost:9999/viewer");
    await relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" });
    FakeWebSocket.instance?.emitMessage({
      version: 1,
      kind: "telemetry",
      relayDroppedMessages: 7,
      relayDropReason: "message-size-limit",
    });
    expect(relay.pollLive()).toMatchObject({
      messageCount: 0,
      telemetry: { state: "degraded", droppedMessages: 7, diagnostic: "Relay dropped 7 message(s): message-size-limit." },
    });
  });

  it("preserves the original display diagnostic while keeping the live transport fail-soft", async () => {
    const relay = new BrowserLiveRelay(() => undefined);
    relay.setEndpoint("ws://localhost:9999/viewer");
    await relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" });
    relay.recordDisplayResult(0, 1);
    relay.recordDiagnostic("Live TF decode failed for tf2_msgs/msg/TFMessage: malformed transform array");
    expect(relay.pollLive()).toMatchObject({
      displayErrors: 1,
      telemetry: {
        state: "degraded",
        diagnostic: "Live TF decode failed for tf2_msgs/msg/TFMessage: malformed transform array",
        droppedMessages: 0,
      },
    });
  });

  it("ignores delayed frames and close events from a replaced socket", async () => {
    const samples: string[] = [];
    const relay = new BrowserLiveRelay((topicId) => samples.push(topicId));
    relay.setEndpoint("ws://localhost:9999/viewer");
    await relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "first" });
    const oldSocket = FakeWebSocket.instances[0]!;
    await relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "second" });
    const currentSocket = FakeWebSocket.instances[1]!;
    await relay.subscribeLive(["points"]);
    const frame = { version: 1, kind: "message", topicId: "points", sequence: "1", sourceTimeNanos: "100", receiptTimeNanos: "105", typeName: "sensor_msgs/msg/PointCloud2", encoding: "cdr", payloadBase64: btoa("x") };
    oldSocket.emitMessage(frame);
    oldSocket.dispatchEvent(new Event("close"));
    currentSocket.emitMessage(frame);
    expect(samples).toEqual(["points"]);
    expect(relay.pollLive()).toMatchObject({ messageCount: 1, telemetry: { state: "connected", acceptedMessages: 1 } });
  });

  it("cleans up a pending request when WebSocket.send throws synchronously", async () => {
    FakeWebSocket.throwOperation = "authenticate";
    const relay = new BrowserLiveRelay(() => undefined);
    relay.setEndpoint("ws://localhost:9999/viewer");
    await expect(relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" })).rejects.toThrow(/synchronous send failure/);
    expect(FakeWebSocket.instance?.closeCalls).toBe(1);
  });

  it("rejects discovered messages that were not explicitly subscribed", async () => {
    const samples: string[] = [];
    const relay = new BrowserLiveRelay((topicId) => samples.push(topicId));
    relay.setEndpoint("ws://localhost:9999/viewer");
    await relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" });
    FakeWebSocket.instance?.emitMessage({
      version: 1,
      kind: "message",
      topicId: "points",
      sequence: "1",
      sourceTimeNanos: "100",
      receiptTimeNanos: "105",
      typeName: "sensor_msgs/msg/PointCloud2",
      encoding: "cdr",
      payloadBase64: btoa("x"),
    });
    expect(samples).toEqual([]);
    expect(relay.pollLive()).toMatchObject({ messageCount: 0, telemetry: { acceptedMessages: 0, droppedMessages: 1, state: "degraded" } });
  });

  it("keeps in-flight async work inside the live queue budget until delivery settles", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const relay = new BrowserLiveRelay(() => blocked);
    relay.setEndpoint("ws://localhost:9999/viewer");
    await relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" });
    await relay.subscribeLive(["points"]);
    const socket = FakeWebSocket.instance!;
    for (let sequence = 1; sequence <= 257; sequence += 1) {
      socket.emitMessage({
        version: 1,
        kind: "message",
        topicId: "points",
        sequence: String(sequence),
        sourceTimeNanos: String(sequence),
        receiptTimeNanos: String(sequence),
        typeName: "sensor_msgs/msg/PointCloud2",
        encoding: "cdr",
        payloadBase64: btoa("x"),
      });
    }
    expect(relay.pollLive()).toMatchObject({ messageCount: 0, telemetry: { queuedMessages: 256, queuedBytes: 256, acceptedMessages: 256, deliveredMessages: 0, droppedMessages: 1 } });
    release();
    await vi.waitFor(() => expect(relay.pollLive()).toMatchObject({ telemetry: { queuedMessages: 0, queuedBytes: 0, deliveredMessages: 256 } }));
  });

  it("replaces the exact subscription and sends explicit unsubscribe operations", async () => {
    FakeWebSocket.discoveryTopics = [
      { id: "points", name: "/points", typeName: "sensor_msgs/msg/PointCloud2", encoding: "cdr" },
      { id: "scan", name: "/scan", typeName: "sensor_msgs/msg/LaserScan", encoding: "cdr" },
    ];
    const relay = new BrowserLiveRelay(() => undefined);
    relay.setEndpoint("ws://localhost:9999/viewer");
    await relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" });
    await relay.subscribeLive(["points"]);
    await relay.subscribeLive(["scan"]);
    await relay.subscribeLive([]);
    expect(FakeWebSocket.instance?.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "unsubscribe", topicIds: ["points"] }),
      expect.objectContaining({ operation: "subscribe", topicIds: ["scan"] }),
      expect.objectContaining({ operation: "unsubscribe", topicIds: ["scan"] }),
    ]));
  });

  it("notifies the UI for rejected-only frames and transport close", async () => {
    let stateChanges = 0;
    const relay = new BrowserLiveRelay(() => undefined, () => { stateChanges += 1; });
    relay.setEndpoint("ws://localhost:9999/viewer");
    await relay.connectLive({ browserOrigin: "http://localhost:8080", sessionToken: "secret" });
    const afterConnect = stateChanges;
    FakeWebSocket.instance?.emitMessage({ version: 1, kind: "message", topicId: "points", payloadBase64: btoa("x") });
    expect(stateChanges).toBeGreaterThan(afterConnect);
    expect(relay.pollLive().telemetry).toMatchObject({ state: "degraded", droppedMessages: 1 });
    const afterDrop = stateChanges;
    FakeWebSocket.instance?.dispatchEvent(new Event("close"));
    expect(stateChanges).toBeGreaterThan(afterDrop);
    expect(relay.pollLive().telemetry).toMatchObject({ state: "disconnected" });
  });
});
