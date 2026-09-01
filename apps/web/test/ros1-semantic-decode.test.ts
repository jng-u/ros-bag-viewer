import { describe, expect, it } from "vitest";

import { decodeSemanticMessage } from "@ros-web-viewer/m1-integration";

class Ros1Writer {
  readonly bytes = new Uint8Array(512);
  readonly view = new DataView(this.bytes.buffer);
  offset = 0;
  uint8(value: number): void { this.view.setUint8(this.offset++, value); }
  uint32(value: number): void { this.view.setUint32(this.offset, value, true); this.offset += 4; }
  float64(value: number): void { this.view.setFloat64(this.offset, value, true); this.offset += 8; }
  string(value: string): void { const encoded = new TextEncoder().encode(value); this.uint32(encoded.byteLength); this.bytes.set(encoded, this.offset); this.offset += encoded.byteLength; }
  header(frameId: string): void { this.uint32(7); this.uint32(1); this.uint32(2); this.string(frameId); }
  finish(): Uint8Array { return this.bytes.slice(0, this.offset); }
}

describe("ROS1 semantic decoding", () => {
  it("decodes ROS1 Path serialization instead of treating it as CDR", () => {
    const writer = new Ros1Writer();
    writer.header("map");
    writer.uint32(1);
    writer.header("map");
    writer.float64(1.25); writer.float64(-2.5); writer.float64(3.75);
    writer.float64(0); writer.float64(0); writer.float64(0); writer.float64(1);

    expect(decodeSemanticMessage({
      channel: { schema: { name: "nav_msgs/Path", capability: "schema-present" }, messageEncoding: "ros1" },
      data: writer.finish(),
    })).toEqual({
      kind: "path",
      message: { frameId: "map", stampNanos: 1_000_000_002n, poses: [{ position: { x: 1.25, y: -2.5, z: 3.75 } }] },
    });
  });
});
