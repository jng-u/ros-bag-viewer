import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextEncoder } from "node:util";

import { McapWriter } from "@mcap/core";

class MemoryWritable {
  chunks = [];
  offset = 0n;
  async write(buffer) { this.chunks.push(buffer.slice()); this.offset += BigInt(buffer.byteLength); }
  position() { return this.offset; }
  bytes() {
    const output = new Uint8Array(Number(this.offset));
    let offset = 0;
    for (const chunk of this.chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  }
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
  string(value) { const encoded = new TextEncoder().encode(value); this.uint32(encoded.byteLength + 1); this.bytes.set(encoded, this.offset); this.offset += encoded.byteLength; this.uint8(0); }
  sequence(value) { this.uint32(value.byteLength); this.bytes.set(value, this.offset); this.offset += value.byteLength; }
  header(frameId, seconds = 0) { this.int32(seconds); this.uint32(0); this.string(frameId); }
  finish() { return this.bytes.slice(0, this.offset); }
}

function pointCloudFrame(frame) {
  const count = 720;
  const writer = new CdrWriter();
  writer.header("map", frame);
  writer.uint32(1);
  writer.uint32(count);
  writer.uint32(3);
  for (const [name, offset] of [["x", 0], ["y", 4], ["z", 8]]) {
    writer.string(name); writer.uint32(offset); writer.uint8(7); writer.uint32(1);
  }
  writer.uint8(0);
  writer.uint32(12);
  writer.uint32(count * 12);
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
  writer.sequence(points);
  writer.uint8(1);
  return writer.finish();
}

function pathFrame(frame) {
  const writer = new CdrWriter();
  writer.header("map", frame);
  const poses = 96;
  writer.uint32(poses);
  for (let index = 0; index < poses; index += 1) {
    const t = index / (poses - 1);
    writer.header("map", frame);
    writer.float64((t - 0.5) * 7);
    writer.float64(Math.sin(t * Math.PI * 3 + frame * 0.08) * 1.3);
    writer.float64(Math.cos(t * Math.PI * 2) * 0.45);
    writer.float64(0); writer.float64(0); writer.float64(0); writer.float64(1);
  }
  return writer.finish();
}

const writable = new MemoryWritable();
const writer = new McapWriter({
  writable,
  useChunks: true,
  useStatistics: true,
  useSummaryOffsets: true,
  repeatSchemas: true,
  repeatChannels: true,
  useMessageIndex: true,
  useChunkIndex: true,
  useMetadataIndex: false,
  chunkSize: 64 * 1024,
});

await writer.start({ profile: "ros2", library: "ros-web-viewer-demo" });
const pointSchema = await writer.registerSchema({ name: "sensor_msgs/msg/PointCloud2", encoding: "ros2msg", data: new TextEncoder().encode("sensor_msgs/msg/PointCloud2") });
const pathSchema = await writer.registerSchema({ name: "nav_msgs/msg/Path", encoding: "ros2msg", data: new TextEncoder().encode("nav_msgs/msg/Path") });
const pointChannel = await writer.registerChannel({ schemaId: pointSchema, topic: "/demo/points", messageEncoding: "cdr", metadata: new Map() });
const pathChannel = await writer.registerChannel({ schemaId: pathSchema, topic: "/demo/path", messageEncoding: "cdr", metadata: new Map() });
for (let frame = 0; frame < 36; frame += 1) {
  const time = BigInt(frame) * 100_000_000n;
  await writer.addMessage({ channelId: pointChannel, sequence: frame, logTime: time, publishTime: time, data: pointCloudFrame(frame) });
  await writer.addMessage({ channelId: pathChannel, sequence: frame, logTime: time + 1n, publishTime: time + 1n, data: pathFrame(frame) });
}
await writer.end();

const output = resolve(dirname(fileURLToPath(import.meta.url)), "../public/demo.mcap");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, writable.bytes());
