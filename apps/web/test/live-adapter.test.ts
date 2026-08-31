import { describe, expect, it, vi } from "vitest";

import {
  BoundedLiveSource,
  type LiveRelayConnection,
  type LiveRelayFrame,
  type LiveRelayTransport,
  type LiveSourceLimits,
} from "../../../packages/source-live/src/index.js";
import { createLiveDesktopShell, renderDesktopShell } from "../src/index.js";

const catalog = [
  { id: "points", name: "/points", schema: { typeName: "sensor_msgs/msg/PointCloud2", encoding: "cdr" } },
  { id: "status", name: "/status", schema: { typeName: "example_msgs/msg/Status", encoding: "cdr" } },
] as const;

function liveHarness(limits?: LiveSourceLimits) {
  let onFrame: ((frame: LiveRelayFrame) => void) | undefined;
  const subscribed: string[][] = [];
  const connection: LiveRelayConnection = {
    binding: { browserOrigin: "https://viewer.example", sessionId: "bound-session" },
    discoverTopics: vi.fn(async () => catalog),
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
  );
  return {
    ...desktop,
    transport,
    subscribed,
    emit(frame: LiveRelayFrame) {
      if (!onFrame) throw new Error("not subscribed");
      onFrame(frame);
    },
  };
}

function frame(sequence: bigint, payload = new Uint8Array([1])): LiveRelayFrame {
  return {
    topicId: "points",
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
    expect(result).toMatchObject({ epoch: 1, latestSourceTimeNanos: 200n, messageCount: 2 });
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

    await live.controller.reconnectLive();
    expect(live.controller.state).toMatchObject({ phase: "ready", liveState: "connected", epoch: 2 });
    await live.controller.disconnectLive();
    expect(live.controller.state).toMatchObject({ phase: "empty", liveState: "disconnected" });
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
