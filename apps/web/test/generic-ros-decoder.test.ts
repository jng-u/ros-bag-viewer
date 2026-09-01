import { describe, expect, it } from "vitest";

import { decodeGenericRosMessage } from "../src/generic-ros-decoder.js";

function cdrCustom(): Uint8Array {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  bytes[1] = 1;
  view.setFloat64(4, 12.5, true);
  view.setInt32(12, 7, true);
  view.setUint32(16, 3, true);
  bytes.set(new TextEncoder().encode("ok\0"), 20);
  view.setUint32(24, 3, true);
  view.setFloat32(28, 1.25, true);
  view.setFloat32(32, 2.5, true);
  view.setFloat32(36, 5, true);
  return bytes;
}

describe("generic ROS schema decoder", () => {
  it("decodes a ROS2 custom schema and exposes selectable numeric paths", () => {
    const decoded = decodeGenericRosMessage({
      typeName: "demo_msgs/msg/Status",
      messageEncoding: "cdr",
      schemaEncoding: "ros2msg",
      schemaDefinition: "float64 score\nint32 inliers\nstring<=8 label\nfloat32[<=4] residuals\n",
      data: cdrCustom(),
    });
    expect(decoded.value).toEqual({ score: 12.5, inliers: 7, label: "ok", residuals: [1.25, 2.5, 5] });
    expect(decoded.numericFields).toEqual([
      { path: "score", value: 12.5 },
      { path: "inliers", value: 7 },
      { path: "residuals[0]", value: 1.25 },
      { path: "residuals[1]", value: 2.5 },
      { path: "residuals[2]", value: 5 },
    ]);
  });

  it("enforces ROS2 bounded sequence declarations", () => {
    expect(() => decodeGenericRosMessage({
      typeName: "demo_msgs/msg/Status",
      messageEncoding: "cdr",
      schemaEncoding: "ros2msg",
      schemaDefinition: "float64 score\nint32 inliers\nstring<=8 label\nfloat32[<=2] residuals\n",
      data: cdrCustom(),
    })).toThrow(/array exceeds its schema bound/);
  });

  it("decodes a bounded ROS2 wstring", () => {
    const bytes = new Uint8Array(16);
    bytes[1] = 1;
    const view = new DataView(bytes.buffer);
    view.setUint32(4, 2, true);
    view.setUint32(8, 0x03bb, true);
    view.setUint32(12, 0, true);
    expect(decodeGenericRosMessage({
      typeName: "demo_msgs/msg/Label",
      messageEncoding: "cdr",
      schemaEncoding: "ros2msg",
      schemaDefinition: "wstring<=1 label\n",
      data: bytes,
    }).value).toEqual({ label: "λ" });
  });

  it("decodes nested ROS1 custom messages", () => {
    const bytes = new Uint8Array(12);
    const view = new DataView(bytes.buffer);
    view.setFloat32(0, 1.5, true);
    view.setFloat32(4, -2, true);
    view.setUint32(8, 9, true);
    const decoded = decodeGenericRosMessage({
      typeName: "demo_msgs/Estimate",
      messageEncoding: "ros1",
      schemaDefinition: "demo_msgs/Pair pair\nuint32 iteration\n================================================================================\nMSG: demo_msgs/Pair\nfloat32 x\nfloat32 y\n",
      data: bytes,
    });
    expect(decoded.value).toEqual({ pair: { x: 1.5, y: -2 }, iteration: 9 });
    expect(decoded.numericFields.map(({ path }) => path)).toEqual(["pair.x", "pair.y", "iteration"]);
  });

  it("refuses schema and payload encodings that are not explicitly supported", () => {
    expect(() => decodeGenericRosMessage({
      typeName: "demo_msgs/Status",
      messageEncoding: "json",
      schemaEncoding: "ros2msg",
      schemaDefinition: "float64 score\n",
      data: new Uint8Array(),
    })).toThrow(/message encoding/);
    expect(() => decodeGenericRosMessage({
      typeName: "demo_msgs/Status",
      messageEncoding: "cdr",
      schemaEncoding: "omgidl",
      schemaDefinition: "float64 score\n",
      data: cdrCustom(),
    })).toThrow(/schema encoding/);
  });

  it("rejects hostile decoded-value counts before allocating the array", () => {
    const bytes = new Uint8Array(8);
    bytes[1] = 1;
    new DataView(bytes.buffer).setUint32(4, 200_001, true);
    expect(() => decodeGenericRosMessage({
      typeName: "demo_msgs/Values",
      messageEncoding: "cdr",
      schemaEncoding: "ros2msg",
      schemaDefinition: "float32[] values\n",
      data: bytes,
    })).toThrow(/value limit/);
  });

  it("fails closed on malformed declarations, wrong roots, and oversized schemas", () => {
    const base = { typeName: "demo_msgs/Status", messageEncoding: "cdr", schemaEncoding: "ros2msg", data: cdrCustom() } as const;
    expect(() => decodeGenericRosMessage({ ...base, schemaDefinition: "float64 score\nthis is not a ROS field\n" })).toThrow(/Unsupported message schema declaration/);
    expect(() => decodeGenericRosMessage({ ...base, schemaDefinition: "MSG: demo_msgs/Other\nfloat64 score\n" })).toThrow(/root type/);
    expect(() => decodeGenericRosMessage({ ...base, schemaDefinition: `#${"x".repeat(4 * 1024 * 1024)}\n` })).toThrow(/schema byte limit/);
  });
});
