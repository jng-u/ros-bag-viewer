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
  float32(value: number): void { this.align(4); this.view.setFloat32(this.offset, value, true); this.offset += 4; }
  float64(value: number): void { this.align(8); this.view.setFloat64(this.offset, value, true); this.offset += 8; }
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

function laserScanCdr(): Uint8Array {
  const writer = new CdrFixtureWriter();
  writer.header("laser");
  for (const value of [-1, 1, 1, 0, 0.1, 0.05, 30]) writer.float32(value);
  writer.uint32(3);
  writer.float32(1);
  writer.float32(Number.POSITIVE_INFINITY);
  writer.float32(2);
  writer.uint32(0);
  return writer.finish();
}

function laserScanRos1(): Uint8Array {
  const bytes = new Uint8Array(256);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const uint32 = (value: number) => { view.setUint32(offset, value, true); offset += 4; };
  const float32 = (value: number) => { view.setFloat32(offset, value, true); offset += 4; };
  uint32(0); // header sequence
  uint32(1); // stamp seconds
  uint32(2); // stamp nanoseconds
  const frame = encoder.encode("laser");
  uint32(frame.byteLength);
  bytes.set(frame, offset);
  offset += frame.byteLength;
  for (const value of [-1, 1, 1, 0, 0.1, 0.05, 30]) float32(value);
  uint32(3);
  float32(1);
  float32(Number.POSITIVE_INFINITY);
  float32(Number.NaN);
  uint32(2);
  float32(Number.NEGATIVE_INFINITY);
  float32(0.5);
  return bytes.slice(0, offset);
}

function currentMarkerArrayCdr(): Uint8Array {
  const writer = new CdrFixtureWriter();
  writer.uint32(1);
  writer.header("map");
  writer.string("poses");
  writer.int32(7);
  writer.int32(2); // SPHERE
  writer.int32(0); // ADD
  writer.float64(1); writer.float64(2); writer.float64(3);
  writer.float64(0); writer.float64(0); writer.float64(0); writer.float64(1);
  writer.float64(0.5); writer.float64(0.5); writer.float64(0.5);
  writer.float32(1); writer.float32(0); writer.float32(0); writer.float32(1);
  writer.int32(0); writer.uint32(0); // lifetime
  writer.uint8(0); // frame_locked
  writer.uint32(0); // points
  writer.uint32(0); // colors
  writer.string(""); // texture_resource
  writer.header("");
  writer.string(""); // texture format
  writer.sequence(new Uint8Array());
  writer.uint32(0); // uv coordinates
  writer.string(""); // text
  writer.string(""); // mesh_resource
  writer.string(""); // mesh_file filename
  writer.sequence(new Uint8Array());
  writer.uint8(0); // mesh_use_embedded_materials
  return writer.finish();
}

describe("semantic media decoding", () => {
  it("routes both ROS1 and ROS2 TFMessage names to the native frame tree", () => {
    expect(availableDisplaysForSchema("tf2_msgs/TFMessage")).toEqual(["frame-tree", "numeric-plot", "raw"]);
    expect(availableDisplaysForSchema("tf2_msgs/msg/TFMessage")).toEqual(["frame-tree", "numeric-plot", "raw"]);
  });

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
    expect(availableDisplaysForSchema("sensor_msgs/msg/Image")).toEqual(["image", "numeric-plot", "raw"]);
    expect(decodeSemanticMessage({
      channel: { schema: { name: "sensor_msgs/msg/Image", capability: "schema-present" }, messageEncoding: "cdr" },
      data: imageCdr(),
    })).toEqual({
      kind: "image",
      message: {
        frameId: "camera",
        stampNanos: 1_000_000_002n,
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
    expect(availableDisplaysForSchema("sensor_msgs/msg/CompressedImage")).toEqual(["image", "numeric-plot", "raw"]);
    expect(decodeSemanticMessage({
      channel: { schema: { name: "sensor_msgs/msg/CompressedImage", capability: "schema-present" }, messageEncoding: "cdr" },
      data: compressedImageCdr(),
    })).toEqual({
      kind: "compressed-image",
      message: { frameId: "camera", stampNanos: 1_000_000_002n, format: "rgb8; jpeg compressed bgr8", data: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9) },
    });
    const display = new ImageDisplay("compressed-image");
    display.configure({ maxInputBytes: 64, maxPixels: 16 });
    display.attachSource(1);
    expect(display.update({ frameId: "camera", format: "rgb8; jpeg compressed bgr8", data: Uint8Array.of(1) }, 1)).toMatchObject({
      details: { compressed: true, codec: "jpeg" },
    });
  });

  it("preserves LaserScan infinity sentinels for the display-level validity filter", () => {
    const decoded = decodeSemanticMessage({
      channel: { schema: { name: "sensor_msgs/msg/LaserScan", capability: "schema-present" }, messageEncoding: "cdr" },
      data: laserScanCdr(),
    });
    expect(decoded.kind).toBe("laser-scan");
    if (decoded.kind === "laser-scan") expect([...decoded.message.ranges]).toEqual([1, Number.POSITIVE_INFINITY, 2]);
  });

  it("preserves ROS1 LaserScan NaN and infinity sentinels for display-level filtering", () => {
    const decoded = decodeSemanticMessage({
      channel: { schema: { name: "sensor_msgs/LaserScan", capability: "schema-present" }, messageEncoding: "ros1" },
      data: laserScanRos1(),
    });
    expect(decoded.kind).toBe("laser-scan");
    if (decoded.kind === "laser-scan") {
      expect(decoded.message.ranges[0]).toBe(1);
      expect(decoded.message.ranges[1]).toBe(Number.POSITIVE_INFINITY);
      expect(Number.isNaN(decoded.message.ranges[2])).toBe(true);
    }
  });

  it("decodes the current ROS2 Marker extension fields and renders pose-only markers", () => {
    const data = currentMarkerArrayCdr();
    const decoded = decodeSemanticMessage({
      channel: {
        schema: {
          name: "visualization_msgs/msg/MarkerArray",
          capability: "schema-present",
          definition: "visualization_msgs/msg/Marker[] markers\n================================================================================\nMSG: visualization_msgs/msg/Marker\nstring texture_resource\nsensor_msgs/msg/CompressedImage texture\nUVCoordinate[] uv_coordinates\nMeshFile mesh_file\n",
        },
        messageEncoding: "cdr",
      },
      data,
    });
    expect(decoded.kind).toBe("marker");
    if (decoded.kind === "marker") expect(decoded.message.markers).toEqual([expect.objectContaining({
      frameId: "map",
      namespace: "poses",
      id: 7,
      action: "add",
      type: "pose-point",
      points: [{ x: 1, y: 2, z: 3 }],
    })]);
    expect(decodeSemanticMessage({
      channel: { schema: { name: "visualization_msgs/msg/MarkerArray", capability: "schema-present" }, messageEncoding: "cdr" },
      data,
    })).toEqual(decoded);
  });
});
