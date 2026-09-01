import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { TextEncoder } from "node:util";

import { McapWriter } from "@mcap/core";

const encoder = new TextEncoder();
const publicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const frameCount = 36;

function concat(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

function u8(value) { return Uint8Array.of(value); }
function u32(value) { const output = new Uint8Array(4); new DataView(output.buffer).setUint32(0, value, true); return output; }
function u64(value) { const output = new Uint8Array(8); new DataView(output.buffer).setBigUint64(0, value, true); return output; }
function rosTime(nanos) { return concat(u32(Number(nanos / 1_000_000_000n)), u32(Number(nanos % 1_000_000_000n))); }

function pointCount(frame) { return frame % 10 === 0 ? 200_000 : 720; }
function imageDimensions(frame) { return frame % 10 === 0 ? { width: 1280, height: 720 } : { width: 96, height: 64 }; }

function pointBytes(frame) {
  const count = pointCount(frame);
  const points = new Uint8Array(count * 12);
  const view = new DataView(points.buffer);
  for (let index = 0; index < count; index += 1) {
    const angle = index * 0.13 + frame * 0.12;
    const band = (index % 36) / 36;
    const radius = 2.4 + Math.sin(index * 0.037 + frame * 0.08) * 0.45;
    view.setFloat32(index * 12, Math.cos(angle) * radius, true);
    view.setFloat32(index * 12 + 4, Math.sin(angle) * radius, true);
    view.setFloat32(index * 12 + 8, (band - 0.5) * 4 + Math.sin(angle * 0.4) * 0.35, true);
  }
  return points;
}

function imageBytes(frame) {
  const { width, height } = imageDimensions(frame);
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 2 + frame * 7) % 256;
      pixels[offset + 1] = (y * 4 + frame * 3) % 256;
      pixels[offset + 2] = ((x + y) * 2 + frame * 11) % 256;
    }
  }
  return pixels;
}

class MemoryWritable {
  chunks = [];
  offset = 0n;
  async write(buffer) { this.chunks.push(buffer.slice()); this.offset += BigInt(buffer.byteLength); }
  position() { return this.offset; }
  bytes() { return concat(...this.chunks); }
}

class CdrWriter {
  bytes = new Uint8Array(256 * 1024);
  view = new DataView(this.bytes.buffer);
  origin = 4;
  offset = 4;
  constructor() { this.view.setUint16(0, 1, false); this.view.setUint16(2, 0, false); }
  ensure(extra) { if (this.offset + extra <= this.bytes.byteLength) return; let size = this.bytes.byteLength; while (size < this.offset + extra) size *= 2; const grown = new Uint8Array(size); grown.set(this.bytes); this.bytes = grown; this.view = new DataView(grown.buffer); }
  align(size) { const relative = this.offset - this.origin; this.offset += (size - (relative % size)) % size; }
  uint8(value) { this.view.setUint8(this.offset++, value); }
  uint32(value) { this.align(4); this.view.setUint32(this.offset, value, true); this.offset += 4; }
  int32(value) { this.align(4); this.view.setInt32(this.offset, value, true); this.offset += 4; }
  float32(value) { this.align(4); this.view.setFloat32(this.offset, value, true); this.offset += 4; }
  float64(value) { this.align(8); this.view.setFloat64(this.offset, value, true); this.offset += 8; }
  string(value) { const encoded = encoder.encode(value); this.uint32(encoded.byteLength + 1); this.bytes.set(encoded, this.offset); this.offset += encoded.byteLength; this.uint8(0); }
  sequence(value) { this.uint32(value.byteLength); this.ensure(value.byteLength); this.bytes.set(value, this.offset); this.offset += value.byteLength; }
  float32Sequence(values) { this.uint32(values.length); for (const value of values) this.float32(value); }
  float64Sequence(values) { this.uint32(values.length); for (const value of values) this.float64(value); }
  header(frameId, seconds = 0) { this.int32(seconds); this.uint32(0); this.string(frameId); }
  finish(alignment = 1) {
    const padding = (alignment - ((this.offset - this.origin) % alignment)) % alignment;
    return this.bytes.slice(0, this.offset + padding);
  }
}

class Ros1Writer {
  bytes = new Uint8Array(256 * 1024);
  view = new DataView(this.bytes.buffer);
  offset = 0;
  ensure(extra) { if (this.offset + extra <= this.bytes.byteLength) return; let size = this.bytes.byteLength; while (size < this.offset + extra) size *= 2; const grown = new Uint8Array(size); grown.set(this.bytes); this.bytes = grown; this.view = new DataView(grown.buffer); }
  uint8(value) { this.view.setUint8(this.offset++, value); }
  uint32(value) { this.view.setUint32(this.offset, value, true); this.offset += 4; }
  int32(value) { this.view.setInt32(this.offset, value, true); this.offset += 4; }
  float32(value) { this.view.setFloat32(this.offset, value, true); this.offset += 4; }
  float64(value) { this.view.setFloat64(this.offset, value, true); this.offset += 8; }
  string(value) { const encoded = encoder.encode(value); this.uint32(encoded.byteLength); this.bytes.set(encoded, this.offset); this.offset += encoded.byteLength; }
  sequence(value) { this.uint32(value.byteLength); this.ensure(value.byteLength); this.bytes.set(value, this.offset); this.offset += value.byteLength; }
  float32Sequence(values) { this.uint32(values.length); for (const value of values) this.float32(value); }
  float64Sequence(values) { this.uint32(values.length); for (const value of values) this.float64(value); }
  header(frameId, seconds = 0) { this.uint32(seconds); this.uint32(seconds); this.uint32(0); this.string(frameId); }
  finish() { return this.bytes.slice(0, this.offset); }
}

function pointCloudCdr(frame) {
  const writer = new CdrWriter();
  const count = pointCount(frame);
  writer.header("map", frame);
  writer.uint32(1); writer.uint32(count); writer.uint32(3);
  for (const [name, offset] of [["x", 0], ["y", 4], ["z", 8]]) {
    writer.string(name); writer.uint32(offset); writer.uint8(7); writer.uint32(1);
  }
  writer.uint8(0); writer.uint32(12); writer.uint32(count * 12); writer.sequence(pointBytes(frame)); writer.uint8(1);
  return writer.finish(4);
}

function imageCdr(frame) {
  const writer = new CdrWriter();
  const { width, height } = imageDimensions(frame);
  writer.header("camera", frame);
  writer.uint32(height); writer.uint32(width); writer.string("rgb8"); writer.uint8(0); writer.uint32(width * 3); writer.sequence(imageBytes(frame));
  return writer.finish();
}

function pathCdr(frame) {
  const writer = new CdrWriter();
  writer.header("map", frame);
  const poses = 96;
  writer.uint32(poses);
  for (let index = 0; index < poses; index += 1) {
    const t = index / (poses - 1);
    writer.header("map", frame);
    writer.float64((t - 0.5) * 7); writer.float64(Math.sin(t * Math.PI * 3 + frame * 0.08) * 1.3); writer.float64(Math.cos(t * Math.PI * 2) * 0.45);
    writer.float64(0); writer.float64(0); writer.float64(0); writer.float64(1);
  }
  return writer.finish();
}

function pointCloudRos1(frame) {
  const writer = new Ros1Writer();
  const count = pointCount(frame);
  writer.header("map", frame);
  writer.uint32(1); writer.uint32(count); writer.uint32(3);
  for (const [name, offset] of [["x", 0], ["y", 4], ["z", 8]]) {
    writer.string(name); writer.uint32(offset); writer.uint8(7); writer.uint32(1);
  }
  writer.uint8(0); writer.uint32(12); writer.uint32(count * 12); writer.sequence(pointBytes(frame)); writer.uint8(1);
  return writer.finish();
}

function imageRos1(frame) {
  const writer = new Ros1Writer();
  const { width, height } = imageDimensions(frame);
  writer.header("camera", frame);
  writer.uint32(height); writer.uint32(width); writer.string("rgb8"); writer.uint8(0); writer.uint32(width * 3); writer.sequence(imageBytes(frame));
  return writer.finish();
}

function pathRos1(frame) {
  const writer = new Ros1Writer();
  writer.header("map", frame);
  const poses = 96;
  writer.uint32(poses);
  for (let index = 0; index < poses; index += 1) {
    const t = index / (poses - 1);
    writer.header("map", frame);
    writer.float64((t - 0.5) * 7); writer.float64(Math.sin(t * Math.PI * 3 + frame * 0.08) * 1.3); writer.float64(Math.cos(t * Math.PI * 2) * 0.45);
    writer.float64(0); writer.float64(0); writer.float64(0); writer.float64(1);
  }
  return writer.finish();
}

function writePose(writer, x, y, z = 0) {
  writer.float64(x); writer.float64(y); writer.float64(z);
  writer.float64(0); writer.float64(0); writer.float64(0); writer.float64(1);
}

function laserScan(writer, frame) {
  writer.header("lidar", frame);
  const count = 360;
  const increment = Math.PI * 2 / count;
  writer.float32(-Math.PI); writer.float32(Math.PI - increment); writer.float32(increment);
  writer.float32(0); writer.float32(0.1); writer.float32(0.2); writer.float32(20);
  const ranges = Array.from({ length: count }, (_, index) => 4 + Math.sin(index * 0.08 + frame * 0.12) * 0.7);
  writer.float32Sequence(ranges);
  writer.float32Sequence([]);
  return writer.finish(4);
}

function odometry(writer, frame) {
  writer.header("map", frame);
  writer.string("base_link");
  writePose(writer, frame * 0.08 - 1.4, Math.sin(frame * 0.12) * 0.8);
  for (let index = 0; index < 36; index += 1) writer.float64(index % 7 === 0 ? 0.01 : 0);
  for (let index = 0; index < 6; index += 1) writer.float64(index === 0 ? 0.8 : 0);
  for (let index = 0; index < 36; index += 1) writer.float64(index % 7 === 0 ? 0.02 : 0);
  return writer.finish(4);
}

function occupancyGrid(writer, frame) {
  writer.header("map", frame);
  writer.int32(0); writer.uint32(0);
  writer.float32(0.2); writer.uint32(40); writer.uint32(40);
  writePose(writer, -4, -4, -0.05);
  const cells = new Uint8Array(40 * 40);
  for (let row = 0; row < 40; row += 1) for (let column = 0; column < 40; column += 1) {
    const edge = row === 0 || column === 0 || row === 39 || column === 39;
    const movingWall = column === (12 + frame % 12) && row > 8 && row < 32;
    cells[row * 40 + column] = edge || movingWall ? 100 : row > 35 && column < 8 ? 255 : 0;
  }
  writer.sequence(cells);
  return writer.finish(4);
}

function tfMessage(writer, frame) {
  writer.uint32(4);
  writer.header("map", frame); writer.string("odom");
  writer.float64(0); writer.float64(0); writer.float64(0); writer.float64(0); writer.float64(0); writer.float64(0); writer.float64(1);
  writer.header("odom", frame); writer.string("base_link");
  writer.float64(frame * 0.08 - 1.4); writer.float64(Math.sin(frame * 0.12) * 0.8); writer.float64(0);
  writer.float64(0); writer.float64(0); writer.float64(0); writer.float64(1);
  writer.header("base_link", frame); writer.string("lidar");
  writer.float64(0.35); writer.float64(0); writer.float64(0.55);
  writer.float64(0); writer.float64(0); writer.float64(0); writer.float64(1);
  writer.header("base_link", frame); writer.string("camera");
  writer.float64(0.2); writer.float64(0); writer.float64(0.8);
  writer.float64(0); writer.float64(0); writer.float64(0); writer.float64(1);
  return writer.finish(4);
}

function cameraInfo(writer, frame) {
  writer.header("camera", frame); writer.uint32(64); writer.uint32(96); writer.string("plumb_bob");
  writer.float64Sequence([0.01, -0.02, 0, 0, 0]);
  for (const value of [80, 0, 48, 0, 80, 32, 0, 0, 1]) writer.float64(value);
  for (const value of [1, 0, 0, 0, 1, 0, 0, 0, 1]) writer.float64(value);
  for (const value of [80, 0, 48, 0, 0, 80, 32, 0, 0, 0, 1, 0]) writer.float64(value);
  writer.uint32(0); writer.uint32(0);
  writer.uint32(0); writer.uint32(0); writer.uint32(0); writer.uint32(0); writer.uint8(0);
  return writer.finish(4);
}

function marker(writer, frame) {
  writer.header("map", frame); writer.string("demo"); writer.int32(1); writer.int32(8); writer.int32(0);
  writePose(writer, 0, 0, 0);
  writer.float64(0.08); writer.float64(0.08); writer.float64(0.08);
  writer.float32(1); writer.float32(0.3); writer.float32(0.1); writer.float32(1);
  writer.int32(0); writer.uint32(0); writer.uint8(0);
  const count = 64; writer.uint32(count);
  for (let index = 0; index < count; index += 1) {
    const angle = index / count * Math.PI * 2 + frame * 0.03;
    writer.float64(Math.cos(angle) * 1.2); writer.float64(Math.sin(angle) * 1.2); writer.float64(1.5 + Math.sin(angle * 3) * 0.2);
  }
  writer.uint32(0); writer.string(""); writer.string(""); writer.uint8(0);
  return writer.finish(4);
}

function numeric(writer, frame) {
  writer.float64(Math.sin(frame * 0.22) * 2 + Math.cos(frame * 0.07));
  return writer.finish(4);
}

function customStatus(writer, frame) {
  writer.float64(0.5 + Math.sin(frame * 0.17) * 0.4);
  writer.int32(120 + frame * 3);
  writer.string(frame % 3 === 0 ? "tracking" : "mapping");
  writer.float32Sequence([0.01 + frame * 0.001, 0.02 + frame * 0.0015, 0.04 + frame * 0.002]);
  return writer.finish(4);
}

const demoTopics = [
  { topic: "/demo/points", type: "sensor_msgs/PointCloud2", ros2Type: "sensor_msgs/msg/PointCloud2", md5: "1158d486dd51d683ce2f1be655c3c181", definition: "std_msgs/Header header\nuint32 height\nuint32 width\nsensor_msgs/PointField[] fields\nbool is_bigendian\nuint32 point_step\nuint32 row_step\nuint8[] data\nbool is_dense\n", cdr: pointCloudCdr, ros1: pointCloudRos1 },
  { topic: "/demo/path", type: "nav_msgs/Path", ros2Type: "nav_msgs/msg/Path", md5: "6227e2b7e9cce15051f669a5e197bbf7", definition: "std_msgs/Header header\ngeometry_msgs/PoseStamped[] poses\n", cdr: pathCdr, ros1: pathRos1 },
  { topic: "/demo/image", type: "sensor_msgs/Image", ros2Type: "sensor_msgs/msg/Image", md5: "060021388200f6f0f447d0fcd9c64743", definition: "std_msgs/Header header\nuint32 height\nuint32 width\nstring encoding\nuint8 is_bigendian\nuint32 step\nuint8[] data\n", cdr: imageCdr, ros1: imageRos1 },
  { topic: "/demo/scan", type: "sensor_msgs/LaserScan", ros2Type: "sensor_msgs/msg/LaserScan", md5: "90c7ef2dc6895d81024acba2ac42f369", definition: "std_msgs/Header header\nfloat32 angle_min\nfloat32 angle_max\nfloat32 angle_increment\nfloat32 time_increment\nfloat32 scan_time\nfloat32 range_min\nfloat32 range_max\nfloat32[] ranges\nfloat32[] intensities\n", cdr: (frame) => laserScan(new CdrWriter(), frame), ros1: (frame) => laserScan(new Ros1Writer(), frame) },
  { topic: "/demo/odom", type: "nav_msgs/Odometry", ros2Type: "nav_msgs/msg/Odometry", md5: "cd5e73d190d741a2f92e81eda573aca7", definition: "std_msgs/Header header\nstring child_frame_id\ngeometry_msgs/PoseWithCovariance pose\ngeometry_msgs/TwistWithCovariance twist\n", cdr: (frame) => odometry(new CdrWriter(), frame), ros1: (frame) => odometry(new Ros1Writer(), frame) },
  { topic: "/demo/map", type: "nav_msgs/OccupancyGrid", ros2Type: "nav_msgs/msg/OccupancyGrid", md5: "3381f2d731d4076ec5c71b0759edbe4e", definition: "std_msgs/Header header\nnav_msgs/MapMetaData info\nint8[] data\n", cdr: (frame) => occupancyGrid(new CdrWriter(), frame), ros1: (frame) => occupancyGrid(new Ros1Writer(), frame) },
  { topic: "/tf", type: "tf2_msgs/TFMessage", ros2Type: "tf2_msgs/msg/TFMessage", md5: "94810edda583a504dfda3829e70d7eec", definition: "geometry_msgs/TransformStamped[] transforms\n", cdr: (frame) => tfMessage(new CdrWriter(), frame), ros1: (frame) => tfMessage(new Ros1Writer(), frame) },
  { topic: "/demo/camera_info", type: "sensor_msgs/CameraInfo", ros2Type: "sensor_msgs/msg/CameraInfo", md5: "c9a58c1b0b154e0e6da7578cb991d214", definition: "std_msgs/Header header\nuint32 height\nuint32 width\nstring distortion_model\nfloat64[] D\nfloat64[9] K\nfloat64[9] R\nfloat64[12] P\nuint32 binning_x\nuint32 binning_y\nsensor_msgs/RegionOfInterest roi\n", cdr: (frame) => cameraInfo(new CdrWriter(), frame), ros1: (frame) => cameraInfo(new Ros1Writer(), frame) },
  { topic: "/demo/markers", type: "visualization_msgs/Marker", ros2Type: "visualization_msgs/msg/Marker", md5: "4048c9de2a16f4ae8e0538085ebf1b97", definition: "std_msgs/Header header\nstring ns\nint32 id\nint32 type\nint32 action\ngeometry_msgs/Pose pose\ngeometry_msgs/Vector3 scale\nstd_msgs/ColorRGBA color\nduration lifetime\nbool frame_locked\ngeometry_msgs/Point[] points\nstd_msgs/ColorRGBA[] colors\nstring text\nstring mesh_resource\nbool mesh_use_embedded_materials\n", cdr: (frame) => marker(new CdrWriter(), frame), ros1: (frame) => marker(new Ros1Writer(), frame) },
  { topic: "/demo/value", type: "std_msgs/Float64", ros2Type: "std_msgs/msg/Float64", md5: "fdb28210bfa9d7c91146260178d9a584", definition: "float64 data\n", cdr: (frame) => numeric(new CdrWriter(), frame), ros1: (frame) => numeric(new Ros1Writer(), frame) },
  { topic: "/demo/custom_status", type: "demo_msgs/Status", ros2Type: "demo_msgs/msg/Status", md5: "demo-status-schema-v1", definition: "float64 score\nint32 inliers\nstring state\nfloat32[] residuals\n", cdr: (frame) => customStatus(new CdrWriter(), frame), ros1: (frame) => customStatus(new Ros1Writer(), frame) },
];

async function generateMcap() {
  const writable = new MemoryWritable();
  const writer = new McapWriter({ writable, useChunks: true, useStatistics: true, useSummaryOffsets: true, repeatSchemas: true, repeatChannels: true, useMessageIndex: true, useChunkIndex: true, useMetadataIndex: false, chunkSize: 64 * 1024 });
  await writer.start({ profile: "ros2", library: "ros-web-viewer-demo" });
  const channels = [];
  for (const topic of demoTopics) {
    const schema = await writer.registerSchema({ name: topic.ros2Type, encoding: "ros2msg", data: encoder.encode(topic.definition) });
    channels.push(await writer.registerChannel({ schemaId: schema, topic: topic.topic, messageEncoding: "cdr", metadata: new Map() }));
  }
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = BigInt(frame) * 100_000_000n;
    for (let index = 0; index < demoTopics.length; index += 1) {
      const messageTime = time + BigInt(index);
      await writer.addMessage({ channelId: channels[index], sequence: frame, logTime: messageTime, publishTime: messageTime, data: demoTopics[index].cdr(frame) });
    }
  }
  await writer.end();
  await writeFile(resolve(publicDirectory, "demo.mcap"), writable.bytes());
}

function bagField(name, value) {
  const encoded = concat(encoder.encode(`${name}=`), typeof value === "string" ? encoder.encode(value) : value);
  return concat(u32(encoded.byteLength), encoded);
}
function bagHeader(fields) { return concat(...fields.map(([name, value]) => bagField(name, value))); }
function bagRecord(fields, data = new Uint8Array()) { const header = bagHeader(fields); return concat(u32(header.byteLength), header, u32(data.byteLength), data); }

function bagConnection(id, topic, type, md5sum, definition) {
  const data = bagHeader([["topic", topic], ["type", type], ["md5sum", md5sum], ["message_definition", definition]]);
  return bagRecord([["op", u8(0x07)], ["conn", u32(id)], ["topic", topic]], data);
}

async function generateRos1Bag() {
  const connections = demoTopics.map((topic, index) => bagConnection(index, topic.topic, topic.type, topic.md5, topic.definition));
  const chunkParts = [...connections];
  const indexes = demoTopics.map(() => []);
  let chunkOffset = connections.reduce((total, bytes) => total + bytes.byteLength, 0);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const base = 1_000_000_000n + BigInt(frame) * 100_000_000n;
    const messages = demoTopics.map((topic, index) => {
      const time = base + BigInt(index);
      const message = bagRecord([["op", u8(0x02)], ["conn", u32(index)], ["time", rosTime(time)]], topic.ros1(frame));
      indexes[index].push(concat(rosTime(time), u32(chunkOffset)));
      chunkOffset += message.byteLength;
      return message;
    });
    chunkParts.push(...messages);
  }
  const chunkData = concat(...chunkParts);
  const chunk = bagRecord([["op", u8(0x05)], ["compression", "none"], ["size", u32(chunkData.byteLength)]], chunkData);
  const indexRecords = indexes.map((rows, id) => bagRecord([["op", u8(0x04)], ["ver", u32(1)], ["conn", u32(id)], ["count", u32(rows.length)]], concat(...rows)));
  const magic = encoder.encode("#ROSBAG V2.0\n");
  const padding = new Uint8Array(4096);
  const provisional = bagRecord([["op", u8(0x03)], ["index_pos", u64(0n)], ["conn_count", u32(demoTopics.length)], ["chunk_count", u32(1)]], padding);
  const chunkPosition = BigInt(magic.byteLength + provisional.byteLength);
  const indexPosition = BigInt(magic.byteLength + provisional.byteLength + chunk.byteLength + indexRecords.reduce((total, row) => total + row.byteLength, 0));
  const header = bagRecord([["op", u8(0x03)], ["index_pos", u64(indexPosition)], ["conn_count", u32(demoTopics.length)], ["chunk_count", u32(1)]], padding);
  const chunkInfo = bagRecord([
    ["op", u8(0x06)], ["ver", u32(1)], ["chunk_pos", u64(chunkPosition)],
    ["start_time", rosTime(1_000_000_000n)], ["end_time", rosTime(1_000_000_000n + BigInt(frameCount - 1) * 100_000_000n + BigInt(demoTopics.length - 1))], ["count", u32(demoTopics.length)],
  ], concat(...demoTopics.map((_topic, index) => concat(u32(index), u32(frameCount)))));
  await writeFile(resolve(publicDirectory, "demo-ros1.bag"), concat(magic, header, chunk, ...indexRecords, ...connections, chunkInfo));
}

function metadataYaml() {
  return `rosbag2_bagfile_information:
  version: 9
  storage_identifier: sqlite3
  message_count: ${frameCount * demoTopics.length}
  topics_with_message_count:
${demoTopics.map((topic) => `    - topic_metadata:
        name: ${topic.topic}
        type: ${topic.ros2Type}
        serialization_format: cdr
      message_count: ${frameCount}`).join("\n")}
  compression_format: ''
  compression_mode: ''
  relative_file_paths:
    - data_0.db3
  files:
    - path: data_0.db3
`;
}

async function generateRos2Bag() {
  const directory = resolve(publicDirectory, "demo-ros2");
  const databasePath = resolve(directory, "data_0.db3");
  await mkdir(directory, { recursive: true });
  await rm(databasePath, { force: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE schema(schema_version INTEGER PRIMARY KEY, ros_distro TEXT NOT NULL);
    CREATE TABLE topics(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, serialization_format TEXT NOT NULL, offered_qos_profiles TEXT NOT NULL, type_description_hash TEXT NOT NULL);
    CREATE TABLE message_definitions(id INTEGER PRIMARY KEY, topic_type TEXT NOT NULL, encoding TEXT NOT NULL, encoded_message_definition TEXT NOT NULL, type_description_hash TEXT NOT NULL);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL, timestamp INTEGER NOT NULL, data BLOB NOT NULL);
    CREATE INDEX timestamp_idx ON messages(timestamp ASC);
  `);
  database.prepare("INSERT INTO schema VALUES (?, ?)").run(4, "humble");
  const insertTopic = database.prepare("INSERT INTO topics VALUES (?, ?, ?, ?, ?, ?)");
  const insertDefinition = database.prepare("INSERT INTO message_definitions VALUES (?, ?, ?, ?, ?)");
  demoTopics.forEach((topic, index) => {
    const id = index + 1;
    const hash = `RIHS01_demo_${index}`;
    insertTopic.run(id, topic.topic, topic.ros2Type, "cdr", "", hash);
    insertDefinition.run(id, topic.ros2Type, "ros2msg", topic.definition, hash);
  });
  const insert = database.prepare("INSERT INTO messages(topic_id, timestamp, data) VALUES (?, ?, ?)");
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = 2_000_000_000n + BigInt(frame) * 100_000_000n;
    demoTopics.forEach((topic, index) => insert.run(index + 1, time + BigInt(index), topic.cdr(frame)));
  }
  database.close();
  await writeFile(resolve(directory, "metadata.yaml"), metadataYaml());
}

await mkdir(publicDirectory, { recursive: true });
await Promise.all([generateMcap(), generateRos1Bag(), generateRos2Bag()]);
