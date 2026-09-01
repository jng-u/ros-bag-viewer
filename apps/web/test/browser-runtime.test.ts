import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

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

  it("decodes bounded ROS1 BZip2 and LZ4 chunk payloads", () => {
    const expected = new TextEncoder().encode("ros-web-viewer-bzip-fixture");
    const bzip = Uint8Array.from(Buffer.from("QlpoOTFBWSZTWWm3ByUAAAkRgAACEyDf0CAAMUwAARDT0JmiO6wAUaFOSA97OZKda/i7kinChINNuDko", "base64"));
    const signal = new AbortController().signal;
    expect(decodeRos1Bzip(bzip, expected.byteLength, signal)).toEqual(expected);
    expect(decodeRos1Lz4(compressLz4(expected), expected.byteLength, signal)).toEqual(expected);
  });

  it("opens and samples the deterministic ROS1 PointCloud2 bag", async () => {
    const bytes = await readFile(new URL("../public/demo-ros1.bag", import.meta.url));
    const blob = new Blob([bytes]);
    const runtime = new BrowserRecordingRuntime();
    const opened = await runtime.open({ format: "ros1-bag", name: "demo-ros1.bag", sizeBytes: blob.size, immutableVersion: "ros1-test", blob });
    const sample = await runtime.sample("/demo/points", 0n);
    const decoded = decodeSemanticMessage({ channel: sample.channel, data: sample.data });
    const imageSample = await runtime.sample("/demo/image", 0n);
    const image = decodeSemanticMessage({ channel: imageSample.channel, data: imageSample.data });
    expect(opened.topics.map(({ name }) => name)).toEqual(["/demo/points", "/demo/path", "/demo/image"]);
    expect(decoded.kind).toBe("pointcloud2");
    if (decoded.kind === "pointcloud2") expect(decoded.message.width * decoded.message.height).toBe(720);
    expect(image.kind).toBe("image");
    if (image.kind === "image") expect([image.message.width, image.message.height, image.message.encoding]).toEqual([96, 64, "rgb8"]);
  });

  it("opens and samples the deterministic ROS2 SQLite PointCloud2 bag through WASM", async () => {
    const files = await Promise.all(["metadata.yaml", "data_0.db3"].map(async (name) => {
      const bytes = await readFile(new URL(`../public/demo-ros2/${name}`, import.meta.url));
      const blob = new Blob([bytes]);
      return { name, relativePath: `demo-ros2/${name}`, sizeBytes: blob.size, immutableVersion: name, blob };
    }));
    const runtime = new BrowserRecordingRuntime();
    const opened = await runtime.open({
      format: "ros2-sqlite",
      name: "demo ROS2",
      sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
      immutableVersion: "ros2-test",
      blob: files[0]!.blob,
      files,
    });
    const sample = await runtime.sample("/demo/points", 0n);
    const decoded = decodeSemanticMessage({ channel: sample.channel, data: sample.data });
    const imageSample = await runtime.sample("/demo/image", 0n);
    const image = decodeSemanticMessage({ channel: imageSample.channel, data: imageSample.data });
    expect(opened.topics.map(({ name }) => name)).toEqual(["/demo/image", "/demo/path", "/demo/points"]);
    expect(decoded.kind).toBe("pointcloud2");
    if (decoded.kind === "pointcloud2") expect(decoded.message.width * decoded.message.height).toBe(720);
    expect(image.kind).toBe("image");
    if (image.kind === "image") expect([image.message.width, image.message.height, image.message.encoding]).toEqual([96, 64, "rgb8"]);
  });
});
