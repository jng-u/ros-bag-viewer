import { describe, expect, it } from "vitest";

import { ImageDisplay } from "@ros-web-viewer/displays-core";
import { availableDisplaysForSchema, decodeSemanticMessage } from "@ros-web-viewer/m1-integration";

const encoder = new TextEncoder();

class CdrFixtureWriter {
  readonly bytes = new Uint8Array(4096);
  readonly view = new DataView(this.bytes.buffer);
  readonly origin = 4;
  offset = 4;

  constructor() {
    this.view.setUint16(0, 1, false);
  }

  align(size: number): void { this.offset += (size - ((this.offset - this.origin) % size)) % size; }
  uint8(value: number): void { this.view.setUint8(this.offset++, value); }
  uint32(value: number): void { this.align(4); this.view.setUint32(this.offset, value, true); this.offset += 4; }
  int32(value: number): void { this.align(4); this.view.setInt32(this.offset, value, true); this.offset += 4; }
  string(value: string): void {
    const data = encoder.encode(value);
    this.uint32(data.byteLength + 1);
    this.bytes.set(data, this.offset);
    this.offset += data.byteLength;
    this.uint8(0);
  }
  sequence(value: Uint8Array): void {
    this.uint32(value.byteLength);
    this.bytes.set(value, this.offset);
    this.offset += value.byteLength;
  }
  header(frameId: string): void { this.int32(1); this.uint32(2); this.string(frameId); }
  finish(extra = new Uint8Array()): Uint8Array {
    const output = new Uint8Array(this.offset + extra.byteLength);
    output.set(this.bytes.subarray(0, this.offset));
    output.set(extra, this.offset);
    return output;
  }
}

function pointCloudCdr(trailing = new Uint8Array()): Uint8Array {
  const writer = new CdrFixtureWriter();
  writer.header("lidar");
  writer.uint32(1);
  writer.uint32(1);
  writer.uint32(3);
  for (const [name, offset] of [["x", 0], ["y", 4], ["z", 8]] as const) {
    writer.string(name);
    writer.uint32(offset);
    writer.uint8(7);
    writer.uint32(1);
  }
  writer.uint8(0);
  writer.uint32(12);
  writer.uint32(12);
  writer.sequence(new Uint8Array(12));
  writer.uint8(1);
  return writer.finish(trailing);
}

function imageCdr(): Uint8Array {
  const writer = new CdrFixtureWriter();
  writer.header("camera");
  writer.uint32(1);
  writer.uint32(2);
  writer.string("rgb8");
  writer.uint8(0);
  writer.uint32(6);
  writer.sequence(Uint8Array.of(255, 0, 0, 0, 255, 0));
  return writer.finish();
}

function compressedImageCdr(): Uint8Array {
  const writer = new CdrFixtureWriter();
  writer.header("camera");
  writer.string("rgb8; jpeg compressed bgr8");
  writer.sequence(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9));
  return writer.finish();
}

describe("semantic media decoding", () => {
  it("accepts up to three transport-alignment octets after a complete CDR PointCloud2", () => {
    const decoded = decodeSemanticMessage({
      channel: { schema: { name: "sensor_msgs/msg/PointCloud2", capability: "schema-present" }, messageEncoding: "cdr" },
      data: pointCloudCdr(Uint8Array.of(0xaa, 0xbb, 0xcc)),
    });
    expect(decoded.kind).toBe("pointcloud2");
  });

  it("still rejects data beyond the bounded CDR transport-alignment allowance", () => {
    expect(() => decodeSemanticMessage({
      channel: { schema: { name: "sensor_msgs/msg/PointCloud2", capability: "schema-present" }, messageEncoding: "cdr" },
      data: pointCloudCdr(Uint8Array.of(0, 0, 0, 0)),
    })).toThrow("unexpected trailing bytes");
  });

  it("decodes ROS2 sensor_msgs/Image and exposes image plus raw displays", () => {
    expect(availableDisplaysForSchema("sensor_msgs/msg/Image")).toEqual(["image", "raw"]);
    expect(decodeSemanticMessage({
      channel: { schema: { name: "sensor_msgs/msg/Image", capability: "schema-present" }, messageEncoding: "cdr" },
      data: imageCdr(),
    })).toEqual({
      kind: "image",
      message: {
        frameId: "camera",
        width: 2,
        height: 1,
        encoding: "rgb8",
        step: 6,
        isBigEndian: false,
        data: Uint8Array.of(255, 0, 0, 0, 255, 0),
      },
    });
  });

  it("decodes the standard ROS2 CompressedImage format without treating the original pixel format as the codec", () => {
    expect(availableDisplaysForSchema("sensor_msgs/msg/CompressedImage")).toEqual(["image", "raw"]);
    expect(decodeSemanticMessage({
      channel: { schema: { name: "sensor_msgs/msg/CompressedImage", capability: "schema-present" }, messageEncoding: "cdr" },
      data: compressedImageCdr(),
    })).toEqual({
      kind: "compressed-image",
      message: { frameId: "camera", format: "rgb8; jpeg compressed bgr8", data: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9) },
    });
    const display = new ImageDisplay("compressed-image");
    display.configure({ maxInputBytes: 64, maxPixels: 16 });
    display.attachSource(1);
    expect(display.update({ frameId: "camera", format: "rgb8; jpeg compressed bgr8", data: Uint8Array.of(1) }, 1)).toMatchObject({
      details: { compressed: true, codec: "jpeg" },
    });
  });
});
