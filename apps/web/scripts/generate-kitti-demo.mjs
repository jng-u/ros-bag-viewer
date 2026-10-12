import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TextEncoder } from "node:util";

import { McapWriter } from "@mcap/core";
import { compress as compressLz4 } from "lz4-lite";

const encoder = new TextEncoder();
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = resolve(scriptDirectory, "../public");
const archiveUrl = "https://s3.eu-central-1.amazonaws.com/avg-kitti/raw_data/2011_09_26_drive_0001/2011_09_26_drive_0001_sync.zip";
const sequence = "2011_09_26_drive_0001_sync";
const frameIndices = [0, 5, 10, 15, 20];
const prefix = `2011_09_26/${sequence}/`;
const pointCloudSchema = `std_msgs/Header header
uint32 height
uint32 width
sensor_msgs/PointField[] fields
bool is_bigendian
uint32 point_step
uint32 row_step
uint8[] data
bool is_dense
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
================================================================================
MSG: sensor_msgs/PointField
uint8 INT8=1
uint8 UINT8=2
uint8 INT16=3
uint8 UINT16=4
uint8 INT32=5
uint8 UINT32=6
uint8 FLOAT32=7
uint8 FLOAT64=8
string name
uint32 offset
uint8 datatype
uint32 count
`;
const compressedImageSchema = `std_msgs/Header header
string format
uint8[] data
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
`;

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
  bytes = new Uint8Array(1_048_576);
  view = new DataView(this.bytes.buffer);
  origin = 4;
  offset = 4;
  constructor() { this.view.setUint16(0, 1, false); this.view.setUint16(2, 0, false); }
  ensure(extra) {
    if (this.offset + extra <= this.bytes.byteLength) return;
    let size = this.bytes.byteLength;
    while (size < this.offset + extra) size *= 2;
    const grown = new Uint8Array(size); grown.set(this.bytes); this.bytes = grown; this.view = new DataView(grown.buffer);
  }
  align(size) { this.offset += (size - ((this.offset - this.origin) % size)) % size; }
  uint8(value) { this.ensure(1); this.view.setUint8(this.offset++, value); }
  uint32(value) { this.align(4); this.ensure(4); this.view.setUint32(this.offset, value, true); this.offset += 4; }
  int32(value) { this.align(4); this.ensure(4); this.view.setInt32(this.offset, value, true); this.offset += 4; }
  string(value) { const data = encoder.encode(value); this.uint32(data.byteLength + 1); this.ensure(data.byteLength + 1); this.bytes.set(data, this.offset); this.offset += data.byteLength; this.uint8(0); }
  sequence(value) { this.uint32(value.byteLength); this.ensure(value.byteLength); this.bytes.set(value, this.offset); this.offset += value.byteLength; }
  header(frameId, time) { this.int32(Number(time / 1_000_000_000n)); this.uint32(Number(time % 1_000_000_000n)); this.string(frameId); }
  finish() { return this.bytes.slice(0, this.offset); }
}

export function timestampNanos(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{9})$/u.exec(value);
  if (!match) throw new Error(`invalid KITTI timestamp: ${value}`);
  const [, year, month, day, hour, minute, second, fraction] = match;
  const millis = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return BigInt(millis) * 1_000_000n + BigInt(fraction);
}

export function pointCloudCdr(bytes, pointCount, time) {
  if (bytes.byteLength !== pointCount * 16) throw new Error("KITTI scan is not packed as x/y/z/intensity float32 tuples");
  const writer = new CdrWriter();
  writer.header("velodyne", time);
  writer.uint32(1); writer.uint32(pointCount); writer.uint32(4);
  for (const [name, offset] of [["x", 0], ["y", 4], ["z", 8], ["intensity", 12]]) {
    writer.string(name); writer.uint32(offset); writer.uint8(7); writer.uint32(1);
  }
  writer.uint8(0); writer.uint32(16); writer.uint32(bytes.byteLength); writer.sequence(bytes); writer.uint8(1);
  return writer.finish();
}

export function compressedImageCdr(bytes, time) {
  const writer = new CdrWriter();
  writer.header("camera_color_left", time);
  writer.string("rgb8; png compressed rgb8");
  writer.sequence(bytes);
  return writer.finish();
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)));
  });
}

export async function generateKittiDemo() {
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "ros-web-viewer-kitti-"));
  const frameNames = frameIndices.map((frame) => frame.toString().padStart(10, "0"));
  const members = [
    `${prefix}velodyne_points/timestamps.txt`,
    `${prefix}image_02/timestamps.txt`,
    ...frameNames.flatMap((name) => [`${prefix}velodyne_points/data/${name}.bin`, `${prefix}image_02/data/${name}.png`]),
  ];
  try {
    await mkdir(publicDirectory, { recursive: true });
    await run(process.env.PYTHON ?? "python3", [resolve(scriptDirectory, "fetch-kitti-members.py"), "--url", archiveUrl, "--output-dir", temporaryDirectory, ...members]);
    const lidarTimestamps = (await readFile(resolve(temporaryDirectory, `${prefix}velodyne_points/timestamps.txt`), "utf8")).trim().split(/\r?\n/u);
    const imageTimestamps = (await readFile(resolve(temporaryDirectory, `${prefix}image_02/timestamps.txt`), "utf8")).trim().split(/\r?\n/u);
    const origin = timestampNanos(lidarTimestamps[frameIndices[0]]);
    const writable = new MemoryWritable();
    const writer = new McapWriter({ writable, useChunks: true, useStatistics: true, useSummaryOffsets: true, repeatSchemas: true, repeatChannels: true, useMessageIndex: true, useChunkIndex: true, useMetadataIndex: false, chunkSize: 2 * 1024 * 1024, compressChunk: (data) => ({ compression: "lz4", compressedData: compressLz4(data) }) });
    await writer.start({ profile: "ros2", library: "ros-web-viewer-kitti-demo" });
    const pointsSchema = await writer.registerSchema({ name: "sensor_msgs/msg/PointCloud2", encoding: "ros2msg", data: encoder.encode(pointCloudSchema) });
    const imageSchema = await writer.registerSchema({ name: "sensor_msgs/msg/CompressedImage", encoding: "ros2msg", data: encoder.encode(compressedImageSchema) });
    const pointsChannel = await writer.registerChannel({ schemaId: pointsSchema, topic: "/kitti/velodyne_points", messageEncoding: "cdr", metadata: new Map() });
    const imageChannel = await writer.registerChannel({ schemaId: imageSchema, topic: "/kitti/camera_color_left/image_raw/compressed", messageEncoding: "cdr", metadata: new Map() });
    const frames = [];
    for (const [sequenceIndex, frameIndex] of frameIndices.entries()) {
      const name = frameNames[sequenceIndex];
      const pointBytes = new Uint8Array(await readFile(resolve(temporaryDirectory, `${prefix}velodyne_points/data/${name}.bin`)));
      const imageBytes = new Uint8Array(await readFile(resolve(temporaryDirectory, `${prefix}image_02/data/${name}.png`)));
      const lidarTime = timestampNanos(lidarTimestamps[frameIndex]) - origin;
      const imageTime = timestampNanos(imageTimestamps[frameIndex]) - origin;
      const pointCount = pointBytes.byteLength / 16;
      await writer.addMessage({ channelId: pointsChannel, sequence: sequenceIndex, logTime: lidarTime, publishTime: lidarTime, data: pointCloudCdr(pointBytes, pointCount, lidarTime) });
      await writer.addMessage({ channelId: imageChannel, sequence: sequenceIndex, logTime: imageTime, publishTime: imageTime, data: compressedImageCdr(imageBytes, imageTime) });
      frames.push({ frameIndex, lidarTimestamp: lidarTimestamps[frameIndex], imageTimestamp: imageTimestamps[frameIndex], lidarTimeNanos: lidarTime.toString(), imageTimeNanos: imageTime.toString(), pointCount, imageBytes: imageBytes.byteLength });
    }
    await writer.end();
    const mcap = writable.bytes();
    await writeFile(resolve(publicDirectory, "kitti-demo.mcap"), mcap);
    await writeFile(resolve(publicDirectory, "kitti-demo.json"), `${JSON.stringify({
      dataset: "KITTI Raw Data",
      sequence,
      sourcePage: "https://www.cvlibs.net/datasets/kitti/raw_data.php",
      sourceArchive: archiveUrl,
      license: { name: "Creative Commons Attribution-NonCommercial-ShareAlike 3.0", url: "https://creativecommons.org/licenses/by-nc-sa/3.0/" },
      attribution: "A. Geiger, P. Lenz and R. Urtasun, Are we ready for Autonomous Driving? The KITTI Vision Benchmark Suite, CVPR 2012.",
      selection: "Original synchronized frames 0, 5, 10, 15, and 20. LiDAR scans retain every x/y/z/intensity tuple; PNG images are unchanged.",
      timing: "KITTI timestamps do not declare a timezone. MCAP times are relative to the first selected LiDAR timestamp; original timestamp text and inter-sensor offsets are preserved below.",
      durationNanos: frames.at(-1).imageTimeNanos,
      frames,
      output: { bytes: mcap.byteLength, sha256: createHash("sha256").update(mcap).digest("hex") },
    }, null, 2)}\n`);
    console.log(`wrote kitti-demo.mcap (${mcap.byteLength} bytes)`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateKittiDemo();
