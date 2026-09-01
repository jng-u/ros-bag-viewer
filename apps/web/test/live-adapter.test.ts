import { describe, expect, it, vi } from "vitest";

import {
  BoundedLiveSource,
  type LiveRelayConnection,
  type LiveRelayFrame,
  type LiveRelayTransport,
  type LiveSourceLimits,
} from "../../../packages/source-live/src/index.js";
import type {
  DisplayLifecycle,
  DisplayState,
  NormalizedMessageEnvelope,
  PayloadLease,
  SourceEpoch,
} from "../../../packages/core-model/src/index.js";
import {
  createLiveDesktopShell,
  renderDesktopShell,
  type LiveAdapterTopic,
  type LiveDisplayLifecycleFactory,
} from "../src/index.js";

const catalog = [
  { id: "points", name: "/points", schema: { typeName: "sensor_msgs/msg/PointCloud2", encoding: "cdr" } },
  { id: "status", name: "/status", schema: { typeName: "example_msgs/msg/Status", encoding: "cdr" } },
] as const;

class FakeDisplayLifecycle implements DisplayLifecycle {
  state: DisplayState = "registered";
  readonly calls: string[] = [];
  readonly updates: Array<{
    readonly envelope: NormalizedMessageEnvelope;
    readonly bytes: readonly number[];
    readonly isolatedBytes: readonly number[];
    readonly lease: PayloadLease;
  }> = [];

  register(): void { this.calls.push("register"); this.state = "registered"; }
  instantiate(): void { this.calls.push("instantiate"); this.state = "instantiated"; }
  configure(): void { this.calls.push("configure"); this.state = "configured"; }
  attachSource(epoch: SourceEpoch): void { this.calls.push(`attach:${epoch}`); this.state = "attached"; }
  update(message: NormalizedMessageEnvelope): void {
    const bytes = message.payload.readBytes(message.epoch);
    const captured = [...bytes];
    bytes.fill(0);
    this.updates.push({
      envelope: message,
      bytes: captured,
      isolatedBytes: [...message.payload.readBytes(message.epoch)],
      lease: message.payload,
    });
    this.calls.push(`update:${message.nativeTypeMetadata.encoding}`);
  }
  render(): void { this.calls.push("render"); this.state = "rendering"; }
  suspend(): void { this.calls.push("suspend"); this.state = "suspended"; }
  handleError(error: Error): void { this.calls.push(`error:${error.message}`); this.state = "error"; }
  dispose(): void { this.calls.push("dispose"); this.state = "disposed"; }
}

function liveHarness(
  limits?: LiveSourceLimits,
  topics: readonly LiveAdapterTopic[] = catalog,
) {
  let onFrame: ((frame: LiveRelayFrame) => void) | undefined;
  const subscribed: string[][] = [];
  const displays = new Map<string, FakeDisplayLifecycle>();
  const displayFactory: LiveDisplayLifecycleFactory = (display) => {
    const lifecycle = new FakeDisplayLifecycle();
    displays.set(display.id, lifecycle);
    return lifecycle;
  };
  const connection: LiveRelayConnection = {
    binding: { browserOrigin: "https://viewer.example", sessionId: "bound-session" },
    discoverTopics: vi.fn(async () => topics),
    async subscribe(topicIds, callback) {
      subscribed.push([...topicIds]);
      onFrame = callback;
      return { close: vi.fn(async () => undefined) };
    },
    close: vi.fn(async () => undefined),
  };
  const transport: LiveRelayTransport = { connect: vi.fn(async () => connection) };
  const desktop = createLiveDesktopShell(
    (selection) => new BoundedLiveSource(transport, selection, limits),
    displayFactory,
  );
  return {
    ...desktop,
    transport,
    subscribed,
    displays,
    emit(frame: LiveRelayFrame) {
      if (!onFrame) throw new Error("not subscribed");
      onFrame(frame);
    },
  };
}

function frame(sequence: bigint, payload = new Uint8Array([1]), topicId = "points"): LiveRelayFrame {
  return {
    topicId,
    sequence,
    sourceTimeNanos: sequence * 100n,
    receiptTimeNanos: sequence * 100n + 5n,
    receivedAtMillis: 1_000,
    payload,
  };
}

describe("secure live desktop flow", () => {
  it("connects with browser/session binding, discovers topics, and offers display-only UI", async () => {
    const live = liveHarness();
    await live.controller.connectLive({ browserOrigin: "https://viewer.example", sessionToken: "session-token" });

    expect(live.transport.connect).toHaveBeenCalledWith({
      browserOrigin: "https://viewer.example",
      sessionToken: "session-token",
    });
    expect(live.controller.state).toMatchObject({
      phase: "ready",
      sourceMode: "live",
      liveState: "connected",
      sourceLabel: "Secure live relay",
      epoch: 1,
    });
    expect(live.controller.state.topics).toEqual([
      expect.objectContaining({ id: "points", compatibility: "native-display", availableDisplays: ["point-cloud", "raw"] }),
      expect.objectContaining({ id: "status", compatibility: "schema-backed-generic", availableDisplays: ["raw-inspector"] }),
    ]);

    const html = renderDesktopShell(live.controller);
    expect(html).toContain("Mode: secure live · read-only");
    expect(html).toContain("authenticated browser session");
    expect(html).not.toMatch(/edge address|publish|service call|action call|parameter|arbitrary command|wildcard/i);
    expect(html).not.toContain("session-token");
    expect(html).not.toContain("https://viewer.example");
  });

  it("subscribes explicit topics, drains deterministic envelopes, and updates live display time/telemetry", async () => {
    const live = liveHarness();
    await live.controller.connectLive({ browserOrigin: "https://viewer.example", sessionToken: "token" });
    await live.controller.subscribeLive(["points"]);
    live.controller.addDisplay("points", "point-cloud");
    live.emit(frame(2n));
    live.emit(frame(1n));

    const result = live.controller.pollLive();
    expect(live.subscribed).toEqual([["points"]]);
    expect(result).toMatchObject({
      epoch: 1,
      latestSourceTimeNanos: 200n,
      messageCount: 2,
      displayDeliveries: 2,
      displayErrors: 0,
      staleMessageCount: 0,
    });
    const display = live.displays.get("display-1");
    expect(display?.calls).toEqual(["register", "instantiate", "configure", "attach:1", "update:cdr", "render", "update:cdr", "render"]);
    expect(display?.updates.map(({ envelope }) => envelope.sourceSequence)).toEqual([1n, 2n]);
    expect(display?.updates[0]?.envelope).toMatchObject({
      sourceId: "secure-live",
      channelId: "points",
      schedulingTime: { valueNanos: 100n, source: "clock", epoch: 1 },
      schema: { capability: "schema-present", typeName: "sensor_msgs/msg/PointCloud2" },
      nativeTypeMetadata: { topicName: "/points", encoding: "cdr" },
    });
    expect(display?.updates[0]).toMatchObject({ bytes: [1], isolatedBytes: [1] });
    expect(display?.updates[0]?.lease.released).toBe(true);
    expect(() => display?.updates[0]?.lease.readBytes(1 as SourceEpoch)).toThrow(/active source epoch/);
    expect(live.controller.state).toMatchObject({ currentTimeNanos: 200n, phase: "ready" });
    const html = renderDesktopShell(live.controller);
    expect(html).toContain("Latest source time: 200 ns");
    expect(html).toContain("Queue: 0 messages / 0 bytes");
    expect(html).toContain("Dropped: 0");
    expect(html).not.toContain("Play recording");
    expect(html).not.toContain("Seek recording");
  });

  it("surfaces bounded degradation and supports epoch-changing reconnect/disconnect", async () => {
    const live = liveHarness({
      maxTopicsPerSubscription: 1,
      maxMessageBytes: 1,
      maxMessagesPerSecond: 1,
      maxQueueMessages: 1,
      maxQueueBytes: 1,
    });
    await live.controller.connectLive({ browserOrigin: "https://viewer.example", sessionToken: "token" });
    await live.controller.subscribeLive(["points"]);
    live.emit(frame(1n, new Uint8Array(2)));
    live.controller.pollLive();
    expect(live.controller.state).toMatchObject({ phase: "degraded", liveState: "degraded" });
    expect(renderDesktopShell(live.controller)).toContain("Dropped: 1");

    live.controller.addDisplay("points", "point-cloud");
    await live.controller.reconnectLive();
    expect(live.controller.state).toMatchObject({ phase: "ready", liveState: "connected", epoch: 2 });
    expect(live.displays.get("display-1")?.calls.slice(-2)).toEqual(["suspend", "attach:2"]);
    await live.controller.disconnectLive();
    expect(live.displays.get("display-1")?.calls.at(-1)).toBe("dispose");
    expect(live.controller.state).toMatchObject({ phase: "empty", liveState: "disconnected" });
  });

  it("routes ROS1 and ROS2 live envelopes through the same normalized display lifecycle", async () => {
    const dualCatalog = [
      { id: "ros1-points", name: "/ros1/points", schema: { typeName: "sensor_msgs/msg/PointCloud2", encoding: "ros1", definitionHash: "ros1-definition" } },
      { id: "ros2-points", name: "/ros2/points", schema: { typeName: "sensor_msgs/msg/PointCloud2", encoding: "cdr", definitionHash: "ros2-definition" } },
    ] as const;
    const live = liveHarness(undefined, dualCatalog);
    await live.controller.connectLive({ browserOrigin: "https://viewer.example", sessionToken: "token" });
    await live.controller.subscribeLive(["ros1-points", "ros2-points"]);
    live.controller.addDisplay("ros1-points", "point-cloud");
    live.controller.addDisplay("ros2-points", "point-cloud");
    live.emit(frame(1n, Uint8Array.of(0x11), "ros1-points"));
    live.emit(frame(2n, Uint8Array.of(0x22, 0x23), "ros2-points"));

    expect(live.controller.pollLive()).toMatchObject({
      messageCount: 2,
      displayDeliveries: 2,
      displayErrors: 0,
      staleMessageCount: 0,
    });
    const ros1 = live.displays.get("display-1")?.updates[0];
    const ros2 = live.displays.get("display-2")?.updates[0];
    expect(ros1).toMatchObject({
      bytes: [0x11],
      isolatedBytes: [0x11],
      envelope: {
        channelId: "ros1-points",
        sourceSequence: 1n,
        schema: { provenance: [{ providerId: "live-relay", providerVersion: "1", contentHash: "ros1-definition" }] },
        nativeTypeMetadata: { topicName: "/ros1/points", encoding: "ros1", definitionHash: "ros1-definition" },
      },
    });
    expect(ros2).toMatchObject({
      bytes: [0x22, 0x23],
      isolatedBytes: [0x22, 0x23],
      envelope: {
        channelId: "ros2-points",
        sourceSequence: 2n,
        nativeTypeMetadata: { topicName: "/ros2/points", encoding: "cdr", definitionHash: "ros2-definition" },
      },
    });
    expect(live.controller.state.notice).toBe("2 live display updates rendered from 2 messages.");
  });

  it("does not commit live display metadata without a lifecycle runtime", async () => {
    const withoutRuntime = createLiveDesktopShell((selection) => new BoundedLiveSource(
      { connect: async () => ({
        binding: { browserOrigin: selection.browserOrigin, sessionId: "bound" },
        discoverTopics: async () => catalog,
        subscribe: async () => ({ close: async () => undefined }),
        close: async () => undefined,
      }) },
      selection,
    ));
    await withoutRuntime.controller.connectLive({ browserOrigin: "https://viewer.example", sessionToken: "token" });
    expect(() => withoutRuntime.controller.addDisplay("points", "point-cloud")).toThrow(/runtime is unavailable/);
    expect(withoutRuntime.controller.state.displays).toEqual([]);
  });

  it("announces authentication failures without leaking credentials", async () => {
    const { controller } = createLiveDesktopShell(() => ({
      topics: [],
      telemetry: {
        state: "disconnected",
        sourceEpoch: 0,
        queuedMessages: 0,
        queuedBytes: 0,
        acceptedMessages: 0,
        deliveredMessages: 0,
        droppedOversize: 0,
        droppedRateLimited: 0,
        droppedQueuePressure: 0,
        rejectedProtocolFrames: 0,
      },
      connect: async () => {
        throw new Error("session rejected");
      },
      subscribe: async () => undefined,
      drain: () => [],
      reconnect: async () => [],
      close: async () => undefined,
    }));
    await controller.connectLive({ browserOrigin: "https://viewer.example", sessionToken: "super-secret" });
    const html = renderDesktopShell(controller);
    expect(controller.state.phase).toBe("error");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not connect secure live mode: session rejected");
    expect(html).not.toContain("super-secret");
  });
});
