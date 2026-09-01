import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { McapWriter, type IWritable } from "@mcap/core";

import { decodeSemanticMessage } from "@ros-web-viewer/m1-integration";
import { compress as compressLz4 } from "lz4-lite";
import {
  BrowserRecordingRuntime,
  decodeRos1Bzip,
  decodeRos1Lz4,
  detectBrowserSourceFormat,
  localFileVersion,
} from "../src/browser-runtime.js";

describe("browser recording entry", () => {
  it("detects visible local recording lanes without guessing unrelated files", () => {
    expect(detectBrowserSourceFormat("run.MCAP")).toBe("mcap");
    expect(detectBrowserSourceFormat("robot.bag")).toBe("ros1-bag");
    expect(detectBrowserSourceFormat("metadata.yaml")).toBe("ros2-sqlite");
    expect(detectBrowserSourceFormat("data_0.db3")).toBe("ros2-sqlite");
    expect(detectBrowserSourceFormat("notes.txt")).toBe("unknown");
  });

  it("builds a stable local-only version without reading the whole file", () => {
    expect(localFileVersion({ name: "run 1.mcap", size: 42, lastModified: 7 })).toBe("local:run%201.mcap:42:7");
  });

  it("decodes bounded ROS1 BZip2 and LZ4 chunk payloads", async () => {
    const expected = new TextEncoder().encode("ros-web-viewer-bzip-fixture");
    const bzip = Uint8Array.from(Buffer.from("QlpoOTFBWSZTWWm3ByUAAAkRgAACEyDf0CAAMUwAARDT0JmiO6wAUaFOSA97OZKda/i7kinChINNuDko", "base64"));
    const signal = new AbortController().signal;
    const scope = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
    const nodeBuffer = scope.Buffer;
    delete scope.Buffer;
    try {
      expect(await decodeRos1Bzip(bzip, expected.byteLength, signal)).toEqual(expected);
    } finally {
      scope.Buffer = nodeBuffer;
    }
    expect(decodeRos1Lz4(compressLz4(expected), expected.byteLength, signal)).toEqual(expected);
  });

  it("opens and reads the full dense deterministic ROS1 PointCloud2 bag", async () => {
    const bytes = await readFile(new URL("../public/demo-ros1.bag", import.meta.url));
    const blob = new Blob([bytes]);
    const runtime = new BrowserRecordingRuntime({ allowInlineWorkerFallback: true });
    const opened = await runtime.open({ format: "ros1-bag", name: "demo-ros1.bag", sizeBytes: blob.size, immutableVersion: "ros1-test", blob });
    const sample = await runtime.messageAt("/demo/points", 0n);
    const decoded = decodeSemanticMessage({ channel: sample.channel, data: sample.data });
    const imageSample = await runtime.messageAt("/demo/image", 0n);
    const image = decodeSemanticMessage({ channel: imageSample.channel, data: imageSample.data });
    expect(opened.topics.map(({ name }) => name)).toEqual([
      "/demo/points", "/demo/path", "/demo/image", "/demo/scan", "/demo/odom", "/demo/map", "/tf", "/demo/camera_info", "/demo/markers", "/demo/value", "/demo/custom_status",
    ]);
    expect(decoded.kind).toBe("pointcloud2");
    if (decoded.kind === "pointcloud2") expect(decoded.message.width * decoded.message.height).toBe(200_000);
    expect(image.kind).toBe("image");
    if (image.kind === "image") expect([image.message.width, image.message.height, image.message.encoding]).toEqual([1280, 720, "rgb8"]);
  });

  it("opens and reads the full dense deterministic ROS2 SQLite PointCloud2 bag through WASM", async () => {
    const files = await Promise.all(["metadata.yaml", "data_0.db3"].map(async (name) => {
      const bytes = await readFile(new URL(`../public/demo-ros2/${name}`, import.meta.url));
      const blob = new Blob([bytes]);
      return { name, relativePath: `demo-ros2/${name}`, sizeBytes: blob.size, immutableVersion: name, blob };
    }));
    const runtime = new BrowserRecordingRuntime({ allowInlineWorkerFallback: true });
    const opened = await runtime.open({
      format: "ros2-sqlite",
      name: "demo ROS2",
      sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
      immutableVersion: "ros2-test",
      blob: files[0]!.blob,
      files,
    });
    const sample = await runtime.messageAt("/demo/points", 0n);
    const decoded = decodeSemanticMessage({ channel: sample.channel, data: sample.data });
    const imageSample = await runtime.messageAt("/demo/image", 0n);
    const image = decodeSemanticMessage({ channel: imageSample.channel, data: imageSample.data });
    expect(opened.topics.map(({ name }) => name)).toEqual([
      "/demo/camera_info", "/demo/custom_status", "/demo/image", "/demo/map", "/demo/markers", "/demo/odom", "/demo/path", "/demo/points", "/demo/scan", "/demo/value", "/tf",
    ]);
    expect(decoded.kind).toBe("pointcloud2");
    if (decoded.kind === "pointcloud2") expect(decoded.message.width * decoded.message.height).toBe(200_000);
    expect(image.kind).toBe("image");
    if (image.kind === "image") expect([image.message.width, image.message.height, image.message.encoding]).toEqual([1280, 720, "rgb8"]);
  });

  it("selects the latest message at the requested time for sequential MCAP", async () => {
    class Writable implements IWritable {
      readonly chunks: Uint8Array[] = []; positionValue = 0n;
      async write(bytes: Uint8Array) { this.chunks.push(bytes.slice()); this.positionValue += BigInt(bytes.byteLength); }
      position() { return this.positionValue; }
    }
    const writable = new Writable();
    const writer = new McapWriter({ writable, useChunks: false, useStatistics: false, useSummaryOffsets: false, repeatSchemas: false, repeatChannels: false, useMessageIndex: false, useChunkIndex: false });
    await writer.start({ profile: "ros2", library: "browser-runtime-test" });
    const schemaId = await writer.registerSchema({ name: "demo_msgs/msg/Byte", encoding: "ros2msg", data: new TextEncoder().encode("uint8 data\n") });
    const channelId = await writer.registerChannel({ schemaId, topic: "/value", messageEncoding: "cdr", metadata: new Map() });
    await writer.addMessage({ channelId, sequence: 0, logTime: 10n, publishTime: 10n, data: Uint8Array.of(1) });
    await writer.addMessage({ channelId, sequence: 1, logTime: 20n, publishTime: 20n, data: Uint8Array.of(2) });
    await writer.addMessage({ channelId, sequence: 2, logTime: 30n, publishTime: 30n, data: Uint8Array.of(3) });
    await writer.end();
    const blob = new Blob(writable.chunks.map((bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
    const runtime = new BrowserRecordingRuntime({ allowInlineWorkerFallback: true });
    await runtime.open({ format: "mcap", name: "sequential.mcap", sizeBytes: blob.size, immutableVersion: "sequential", blob });
    expect([...await runtime.messageAt("/value", 0n).then((sample) => sample.data)]).toEqual([1]);
    expect([...await runtime.messageAt("/value", 15n).then((sample) => sample.data)]).toEqual([2]);
    expect([...await runtime.messageAt("/value", 25n).then((sample) => sample.data)]).toEqual([3]);
    const history = await runtime.messagesAround("/value", 15n);
    expect(history.samples.map(({ sourceSequence }) => sourceSequence)).toEqual([0n, 1n, 2n]);
    expect(history.samples.map(({ data }) => [...data])).toEqual([[1], [2], [3]]);
    expect(history.before).toBe(history.samples[1]);
    expect(history.after).toBe(history.samples[2]);
    expect(history.truncated).toBe(false);
  });

  it("retains 256 sequential MCAP static-TF messages and reports the 257th instead of hiding truncation", async () => {
    class Writable implements IWritable {
      readonly chunks: Uint8Array[] = []; positionValue = 0n;
      async write(bytes: Uint8Array) { this.chunks.push(bytes.slice()); this.positionValue += BigInt(bytes.byteLength); }
      position() { return this.positionValue; }
    }
    const writable = new Writable();
    const writer = new McapWriter({ writable, useChunks: false, useStatistics: false, useSummaryOffsets: false, repeatSchemas: false, repeatChannels: false, useMessageIndex: false, useChunkIndex: false });
    await writer.start({ profile: "ros2", library: "browser-runtime-static-prefix-test" });
    const schemaId = await writer.registerSchema({ name: "tf2_msgs/msg/TFMessage", encoding: "ros2msg", data: new TextEncoder().encode("geometry_msgs/TransformStamped[] transforms\n") });
    const channelId = await writer.registerChannel({ schemaId, topic: "/tf_static", messageEncoding: "cdr", metadata: new Map() });
    for (let sequence = 0; sequence < 257; sequence += 1) {
      await writer.addMessage({ channelId, sequence, logTime: 10n + BigInt(sequence), publishTime: 10n + BigInt(sequence), data: Uint8Array.of(sequence & 0xff) });
    }
    await writer.end();
    const blob = new Blob(writable.chunks.map((bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
    const runtime = new BrowserRecordingRuntime({ allowInlineWorkerFallback: true });
    await runtime.open({ format: "mcap", name: "static-prefix.mcap", sizeBytes: blob.size, immutableVersion: "static-prefix", blob });
    const history = await runtime.messagesAround("/tf_static", 256n);
    expect(history.truncated).toBe(true);
    expect(history.samples.slice(0, 256).map(({ sourceSequence }) => sourceSequence)).toEqual(Array.from({ length: 256 }, (_, index) => BigInt(index)));
    expect(history.before?.sourceSequence).toBe(256n);
  });
});
