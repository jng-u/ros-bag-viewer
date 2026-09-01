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

function pointBytes(frame) {
  const count = 720;
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
  const width = 96;
  const height = 64;
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
  align(size) { const relative = this.offset - this.origin; this.offset += (size - (relative % size)) % size; }
  uint8(value) { this.view.setUint8(this.offset++, value); }
  uint32(value) { this.align(4); this.view.setUint32(this.offset, value, true); this.offset += 4; }
  int32(value) { this.align(4); this.view.setInt32(this.offset, value, true); this.offset += 4; }
  float64(value) { this.align(8); this.view.setFloat64(this.offset, value, true); this.offset += 8; }
  string(value) { const encoded = encoder.encode(value); this.uint32(encoded.byteLength + 1); this.bytes.set(encoded, this.offset); this.offset += encoded.byteLength; this.uint8(0); }
  sequence(value) { this.uint32(value.byteLength); this.bytes.set(value, this.offset); this.offset += value.byteLength; }
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
  uint8(value) { this.view.setUint8(this.offset++, value); }
  uint32(value) { this.view.setUint32(this.offset, value, true); this.offset += 4; }
  float64(value) { this.view.setFloat64(this.offset, value, true); this.offset += 8; }
  string(value) { const encoded = encoder.encode(value); this.uint32(encoded.byteLength); this.bytes.set(encoded, this.offset); this.offset += encoded.byteLength; }
  sequence(value) { this.uint32(value.byteLength); this.bytes.set(value, this.offset); this.offset += value.byteLength; }
  header(frameId, seconds = 0) { this.uint32(seconds); this.uint32(seconds); this.uint32(0); this.string(frameId); }
  finish() { return this.bytes.slice(0, this.offset); }
}

function pointCloudCdr(frame) {
  const writer = new CdrWriter();
  writer.header("map", frame);
  writer.uint32(1); writer.uint32(720); writer.uint32(3);
  for (const [name, offset] of [["x", 0], ["y", 4], ["z", 8]]) {
    writer.string(name); writer.uint32(offset); writer.uint8(7); writer.uint32(1);
  }
  writer.uint8(0); writer.uint32(12); writer.uint32(720 * 12); writer.sequence(pointBytes(frame)); writer.uint8(1);
  return writer.finish(4);
}

function imageCdr(frame) {
  const writer = new CdrWriter();
  writer.header("camera", frame);
  writer.uint32(64); writer.uint32(96); writer.string("rgb8"); writer.uint8(0); writer.uint32(96 * 3); writer.sequence(imageBytes(frame));
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
  writer.header("map", frame);
  writer.uint32(1); writer.uint32(720); writer.uint32(3);
  for (const [name, offset] of [["x", 0], ["y", 4], ["z", 8]]) {
    writer.string(name); writer.uint32(offset); writer.uint8(7); writer.uint32(1);
  }
  writer.uint8(0); writer.uint32(12); writer.uint32(720 * 12); writer.sequence(pointBytes(frame)); writer.uint8(1);
  return writer.finish();
}

function imageRos1(frame) {
  const writer = new Ros1Writer();
  writer.header("camera", frame);
  writer.uint32(64); writer.uint32(96); writer.string("rgb8"); writer.uint8(0); writer.uint32(96 * 3); writer.sequence(imageBytes(frame));
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

async function generateMcap() {
  const writable = new MemoryWritable();
  const writer = new McapWriter({ writable, useChunks: true, useStatistics: true, useSummaryOffsets: true, repeatSchemas: true, repeatChannels: true, useMessageIndex: true, useChunkIndex: true, useMetadataIndex: false, chunkSize: 64 * 1024 });
  await writer.start({ profile: "ros2", library: "ros-web-viewer-demo" });
  const pointSchema = await writer.registerSchema({ name: "sensor_msgs/msg/PointCloud2", encoding: "ros2msg", data: encoder.encode("sensor_msgs/msg/PointCloud2") });
  const pathSchema = await writer.registerSchema({ name: "nav_msgs/msg/Path", encoding: "ros2msg", data: encoder.encode("nav_msgs/msg/Path") });
  const imageSchema = await writer.registerSchema({ name: "sensor_msgs/msg/Image", encoding: "ros2msg", data: encoder.encode("sensor_msgs/msg/Image") });
  const pointChannel = await writer.registerChannel({ schemaId: pointSchema, topic: "/demo/points", messageEncoding: "cdr", metadata: new Map() });
  const pathChannel = await writer.registerChannel({ schemaId: pathSchema, topic: "/demo/path", messageEncoding: "cdr", metadata: new Map() });
  const imageChannel = await writer.registerChannel({ schemaId: imageSchema, topic: "/demo/image", messageEncoding: "cdr", metadata: new Map() });
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = BigInt(frame) * 100_000_000n;
    await writer.addMessage({ channelId: pointChannel, sequence: frame, logTime: time, publishTime: time, data: pointCloudCdr(frame) });
    await writer.addMessage({ channelId: pathChannel, sequence: frame, logTime: time + 1n, publishTime: time + 1n, data: pathCdr(frame) });
    await writer.addMessage({ channelId: imageChannel, sequence: frame, logTime: time + 2n, publishTime: time + 2n, data: imageCdr(frame) });
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
  const connections = [
    bagConnection(0, "/demo/points", "sensor_msgs/PointCloud2", "1158d486dd51d683ce2f1be655c3c181", "std_msgs/Header header\nuint32 height\nuint32 width\nsensor_msgs/PointField[] fields\nbool is_bigendian\nuint32 point_step\nuint32 row_step\nuint8[] data\nbool is_dense\n"),
    bagConnection(1, "/demo/path", "nav_msgs/Path", "6227e2b7e9cce15051f669a5e197bbf7", "std_msgs/Header header\ngeometry_msgs/PoseStamped[] poses\n"),
    bagConnection(2, "/demo/image", "sensor_msgs/Image", "060021388200f6f0f447d0fcd9c64743", "std_msgs/Header header\nuint32 height\nuint32 width\nstring encoding\nuint8 is_bigendian\nuint32 step\nuint8[] data\n"),
  ];
  const chunkParts = [...connections];
  const indexes = [[], [], []];
  let chunkOffset = connections.reduce((total, bytes) => total + bytes.byteLength, 0);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const base = 1_000_000_000n + BigInt(frame) * 100_000_000n;
    const messages = [
      bagRecord([["op", u8(0x02)], ["conn", u32(0)], ["time", rosTime(base)]], pointCloudRos1(frame)),
      bagRecord([["op", u8(0x02)], ["conn", u32(1)], ["time", rosTime(base + 1n)]], pathRos1(frame)),
      bagRecord([["op", u8(0x02)], ["conn", u32(2)], ["time", rosTime(base + 2n)]], imageRos1(frame)),
    ];
    indexes[0].push(concat(rosTime(base), u32(chunkOffset))); chunkOffset += messages[0].byteLength;
    indexes[1].push(concat(rosTime(base + 1n), u32(chunkOffset))); chunkOffset += messages[1].byteLength;
    indexes[2].push(concat(rosTime(base + 2n), u32(chunkOffset))); chunkOffset += messages[2].byteLength;
    chunkParts.push(...messages);
  }
  const chunkData = concat(...chunkParts);
  const chunk = bagRecord([["op", u8(0x05)], ["compression", "none"], ["size", u32(chunkData.byteLength)]], chunkData);
  const indexRecords = indexes.map((rows, id) => bagRecord([["op", u8(0x04)], ["ver", u32(1)], ["conn", u32(id)], ["count", u32(rows.length)]], concat(...rows)));
  const magic = encoder.encode("#ROSBAG V2.0\n");
  const padding = new Uint8Array(4096);
  const provisional = bagRecord([["op", u8(0x03)], ["index_pos", u64(0n)], ["conn_count", u32(3)], ["chunk_count", u32(1)]], padding);
  const chunkPosition = BigInt(magic.byteLength + provisional.byteLength);
  const indexPosition = BigInt(magic.byteLength + provisional.byteLength + chunk.byteLength + indexRecords.reduce((total, row) => total + row.byteLength, 0));
  const header = bagRecord([["op", u8(0x03)], ["index_pos", u64(indexPosition)], ["conn_count", u32(3)], ["chunk_count", u32(1)]], padding);
  const chunkInfo = bagRecord([
    ["op", u8(0x06)], ["ver", u32(1)], ["chunk_pos", u64(chunkPosition)],
    ["start_time", rosTime(1_000_000_000n)], ["end_time", rosTime(1_000_000_000n + BigInt(frameCount - 1) * 100_000_000n + 2n)], ["count", u32(3)],
  ], concat(u32(0), u32(frameCount), u32(1), u32(frameCount), u32(2), u32(frameCount)));
  await writeFile(resolve(publicDirectory, "demo-ros1.bag"), concat(magic, header, chunk, ...indexRecords, ...connections, chunkInfo));
}

function metadataYaml() {
  return `rosbag2_bagfile_information:
  version: 9
  storage_identifier: sqlite3
  message_count: ${frameCount * 3}
  topics_with_message_count:
    - topic_metadata:
        name: /demo/points
        type: sensor_msgs/msg/PointCloud2
        serialization_format: cdr
      message_count: ${frameCount}
    - topic_metadata:
        name: /demo/path
        type: nav_msgs/msg/Path
        serialization_format: cdr
      message_count: ${frameCount}
    - topic_metadata:
        name: /demo/image
        type: sensor_msgs/msg/Image
        serialization_format: cdr
      message_count: ${frameCount}
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
  database.prepare("INSERT INTO topics VALUES (?, ?, ?, ?, ?, ?)").run(1, "/demo/points", "sensor_msgs/msg/PointCloud2", "cdr", "", "RIHS01_demo_points");
  database.prepare("INSERT INTO topics VALUES (?, ?, ?, ?, ?, ?)").run(2, "/demo/path", "nav_msgs/msg/Path", "cdr", "", "RIHS01_demo_path");
  database.prepare("INSERT INTO topics VALUES (?, ?, ?, ?, ?, ?)").run(3, "/demo/image", "sensor_msgs/msg/Image", "cdr", "", "RIHS01_demo_image");
  database.prepare("INSERT INTO message_definitions VALUES (?, ?, ?, ?, ?)").run(1, "sensor_msgs/msg/PointCloud2", "ros2msg", "sensor_msgs/msg/PointCloud2", "RIHS01_demo_points");
  database.prepare("INSERT INTO message_definitions VALUES (?, ?, ?, ?, ?)").run(2, "nav_msgs/msg/Path", "ros2msg", "nav_msgs/msg/Path", "RIHS01_demo_path");
  database.prepare("INSERT INTO message_definitions VALUES (?, ?, ?, ?, ?)").run(3, "sensor_msgs/msg/Image", "ros2msg", "sensor_msgs/msg/Image", "RIHS01_demo_image");
  const insert = database.prepare("INSERT INTO messages(topic_id, timestamp, data) VALUES (?, ?, ?)");
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = 2_000_000_000n + BigInt(frame) * 100_000_000n;
    insert.run(1, time, pointCloudCdr(frame));
    insert.run(2, time + 1n, pathCdr(frame));
    insert.run(3, time + 2n, imageCdr(frame));
  }
  database.close();
  await writeFile(resolve(directory, "metadata.yaml"), metadataYaml());
}

await mkdir(publicDirectory, { recursive: true });
await Promise.all([generateMcap(), generateRos1Bag(), generateRos2Bag()]);
