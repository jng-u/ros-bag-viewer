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

function cdrImu(): Uint8Array {
  const bytes = new Uint8Array(512);
  const view = new DataView(bytes.buffer);
  const encoder = new TextEncoder();
  let offset = 4;
  bytes[1] = 1;
  const align = (size: number) => { offset += (size - ((offset - 4) % size)) % size; };
  const uint32 = (value: number) => { align(4); view.setUint32(offset, value, true); offset += 4; };
  const int32 = (value: number) => { align(4); view.setInt32(offset, value, true); offset += 4; };
  const float64 = (value: number) => { align(8); view.setFloat64(offset, value, true); offset += 8; };
  const string = (value: string) => { const encoded = encoder.encode(value); uint32(encoded.length + 1); bytes.set(encoded, offset); offset += encoded.length; bytes[offset++] = 0; };
  int32(12); uint32(34); string("imu_link");
  [0.1, 0.2, 0.3, 0.9].forEach(float64);
  Array.from({ length: 9 }, (_, index) => index * 0.01).forEach(float64);
  [1.1, 1.2, 1.3].forEach(float64);
  Array.from({ length: 9 }, (_, index) => index * 0.02).forEach(float64);
  [9.7, 0.1, -0.2].forEach(float64);
  Array.from({ length: 9 }, (_, index) => index * 0.03).forEach(float64);
  return bytes.slice(0, offset);
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

  it("exposes every scalar IMU vector, quaternion, and covariance field for plotting", () => {
    const definition = `std_msgs/Header header
geometry_msgs/Quaternion orientation
float64[9] orientation_covariance
geometry_msgs/Vector3 angular_velocity
float64[9] angular_velocity_covariance
geometry_msgs/Vector3 linear_acceleration
float64[9] linear_acceleration_covariance
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: geometry_msgs/Quaternion
float64 x
float64 y
float64 z
float64 w
================================================================================
MSG: geometry_msgs/Vector3
float64 x
float64 y
float64 z
`;
    const decoded = decodeGenericRosMessage({
      typeName: "sensor_msgs/msg/Imu",
      messageEncoding: "cdr",
      schemaEncoding: "ros2msg",
      schemaDefinition: definition,
      data: cdrImu(),
    });
    expect(decoded.numericFields.map(({ path }) => path)).toEqual(expect.arrayContaining([
      "orientation.x", "orientation.y", "orientation.z", "orientation.w",
      "orientation_covariance[8]",
      "angular_velocity.x", "angular_velocity.y", "angular_velocity.z",
      "angular_velocity_covariance[8]",
      "linear_acceleration.x", "linear_acceleration.y", "linear_acceleration.z",
      "linear_acceleration_covariance[8]",
    ]));
    expect(decoded.numericFields).toHaveLength(39);
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
