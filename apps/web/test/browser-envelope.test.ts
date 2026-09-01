import { describe, expect, it } from "vitest";
import { normalizeBrowserSample } from "../src/browser-envelope.js";

describe("browser normalized envelope boundary", () => {
  it("binds payload, schema, time, channel, and epoch before display decoding", () => {
    const envelope = normalizeBrowserSample({
      channel: { schema: { name: "demo_msgs/msg/Value", capability: "schema-present", encoding: "ros2msg" }, messageEncoding: "cdr" },
      data: Uint8Array.of(1, 2, 3), logTimeNanos: 42n,
    }, {
      id: "topic-1", name: "/value", typeName: "demo_msgs/msg/Value", compatibility: "schema-backed-generic", schemaCapability: "schema-present", availableDisplays: ["raw"],
    }, 7, "recording:test");
    expect(envelope).toMatchObject({ version: 1, sourceId: "recording:test", channelId: "topic-1", sourceSequence: 42n, epoch: 7, schema: { typeName: "demo_msgs/msg/Value" } });
    expect([...envelope.payload.readBytes(envelope.epoch)]).toEqual([1, 2, 3]);
    envelope.payload.release();
    expect(() => envelope.payload.readBytes(envelope.epoch)).toThrow(/not valid/);
  });

  it("preserves a real source sequence and explicit header-derived TF query time", () => {
    const envelope = normalizeBrowserSample({
      channel: { schema: { name: "geometry_msgs/msg/PoseStamped", capability: "schema-present", encoding: "ros2msg" }, messageEncoding: "cdr" },
      data: Uint8Array.of(0), logTimeNanos: 100n, sourceSequence: 9n,
    }, {
      id: "pose", name: "/pose", typeName: "geometry_msgs/msg/PoseStamped", compatibility: "native", schemaCapability: "schema-present", availableDisplays: ["pose"],
    }, 4, "recording:test", 75n);
    expect(envelope.sourceSequence).toBe(9n);
    expect(envelope.schedulingTime).toMatchObject({ valueNanos: 100n, source: "record", epoch: 4 });
    expect(envelope.tfQueryTime).toMatchObject({ valueNanos: 75n, source: "header", epoch: 4 });
    envelope.payload.release();
  });
});
