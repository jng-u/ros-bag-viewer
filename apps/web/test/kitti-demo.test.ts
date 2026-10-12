import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { decodeSemanticMessage } from "@ros-web-viewer/m1-integration";
import { describe, expect, it } from "vitest";

import { BrowserRecordingRuntime } from "../src/browser-runtime.js";

const scriptUrl = new URL("../scripts/generate-kitti-demo.mjs", import.meta.url);
const artifactUrl = new URL("../public/kitti-demo.mcap", import.meta.url);
const manifestUrl = new URL("../public/kitti-demo.json", import.meta.url);

describe("KITTI demo generator serialization", () => {
  it("preserves x/y/z/intensity tuples in PointCloud2 CDR", async () => {
    const { pointCloudCdr } = await import(scriptUrl.href);
    const points = new Float32Array([1, 2, 3, 0.25, -4, -5, -6, 0.75]);
    const decoded = decodeSemanticMessage({
      channel: { schema: { name: "sensor_msgs/msg/PointCloud2", capability: "schema-present" }, messageEncoding: "cdr" },
      data: pointCloudCdr(new Uint8Array(points.buffer), 2, 123_456_789n),
    });
    expect(decoded.kind).toBe("pointcloud2");
    if (decoded.kind !== "pointcloud2") return;
    expect(decoded.message).toMatchObject({ frameId: "velodyne", stampNanos: 123_456_789n, height: 1, width: 2, pointStep: 16, rowStep: 32 });
    expect(decoded.message.fields).toEqual([
      { name: "x", offset: 0, datatype: 7, count: 1 },
      { name: "y", offset: 4, datatype: 7, count: 1 },
      { name: "z", offset: 8, datatype: 7, count: 1 },
      { name: "intensity", offset: 12, datatype: 7, count: 1 },
    ]);
    expect([...new Float32Array(decoded.message.data.buffer, decoded.message.data.byteOffset, 8)]).toEqual([...points]);
  });

  it("serializes original PNG bytes as CompressedImage and retains sensor offset timing", async () => {
    const { compressedImageCdr, timestampNanos } = await import(scriptUrl.href);
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    const lidar = timestampNanos("2011-09-26 13:02:25.951199337");
    const image = timestampNanos("2011-09-26 13:02:25.961661696");
    expect(image - lidar).toBe(10_462_359n);
    const decoded = decodeSemanticMessage({
      channel: { schema: { name: "sensor_msgs/msg/CompressedImage", capability: "schema-present" }, messageEncoding: "cdr" },
      data: compressedImageCdr(png, image - lidar),
    });
    expect(decoded).toEqual({
      kind: "compressed-image",
      message: { frameId: "camera_color_left", stampNanos: 10_462_359n, format: "rgb8; png compressed rgb8", data: png },
    });
  });
});

const describeGenerated = existsSync(artifactUrl) && existsSync(manifestUrl) ? describe : describe.skip;

describeGenerated("generated KITTI MCAP", () => {
  it("matches its manifest and decodes all original selected frames", async () => {
    const bytes = await readFile(artifactUrl);
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
    expect(bytes.byteLength).toBe(manifest.output.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.output.sha256);
    expect(manifest.frames.map((frame: { frameIndex: number }) => frame.frameIndex)).toEqual([0, 5, 10, 15, 20]);
    const runtime = new BrowserRecordingRuntime({ allowInlineWorkerFallback: true });
    const opened = await runtime.open({ format: "mcap", name: "kitti-demo.mcap", sizeBytes: bytes.byteLength, immutableVersion: manifest.output.sha256, blob: new Blob([bytes]) });
    expect(opened.topics.map(({ name }) => name).sort()).toEqual(["/kitti/camera_color_left/image_raw/compressed", "/kitti/velodyne_points"].sort());
    for (const frame of manifest.frames) {
      const pointSample = await runtime.messageAt("/kitti/velodyne_points", BigInt(frame.lidarTimeNanos));
      const points = decodeSemanticMessage({ channel: pointSample.channel, data: pointSample.data });
      expect(points.kind).toBe("pointcloud2");
      if (points.kind === "pointcloud2") {
        expect(points.message.width).toBe(frame.pointCount);
        expect(points.message.data.byteLength).toBe(frame.pointCount * 16);
        expect(points.message.fields.at(-1)?.name).toBe("intensity");
      }
      const imageSample = await runtime.messageAt("/kitti/camera_color_left/image_raw/compressed", BigInt(frame.imageTimeNanos));
      const image = decodeSemanticMessage({ channel: imageSample.channel, data: imageSample.data });
      expect(image.kind).toBe("compressed-image");
      if (image.kind === "compressed-image") {
        expect(image.message.data.byteLength).toBe(frame.imageBytes);
        expect([...image.message.data.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      }
    }
  });
});
