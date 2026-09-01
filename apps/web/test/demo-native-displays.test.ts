import { readFile } from "node:fs/promises";

import { decodeSemanticMessage } from "@ros-web-viewer/m1-integration";
import { describe, expect, it } from "vitest";

import { BrowserRecordingRuntime } from "../src/browser-runtime.js";
import { decodeGenericRosMessage } from "../src/generic-ros-decoder.js";

const expectedKinds = new Map<string, string>([
  ["/demo/points", "pointcloud2"],
  ["/demo/path", "path"],
  ["/demo/image", "image"],
  ["/demo/scan", "laser-scan"],
  ["/demo/odom", "odometry"],
  ["/demo/map", "occupancy-grid"],
  ["/tf", "frame-tree"],
  ["/demo/camera_info", "camera-info"],
  ["/demo/markers", "marker"],
  ["/demo/value", "numeric"],
]);

async function openDemo(name: "demo.mcap" | "demo-ros1.bag", format: "mcap" | "ros1-bag") {
  const bytes = await readFile(new URL(`../public/${name}`, import.meta.url));
  const runtime = new BrowserRecordingRuntime({ allowInlineWorkerFallback: true });
  const result = await runtime.open({
    format,
    name,
    sizeBytes: bytes.byteLength,
    immutableVersion: `test:${name}`,
    blob: new Blob([bytes]),
  });
  return { result, runtime };
}

describe("shipped deterministic demos", () => {
  for (const [name, format] of [["demo.mcap", "mcap"], ["demo-ros1.bag", "ros1-bag"]] as const) {
    it(`decodes every native ${format} demo topic through the browser runtime`, async () => {
      const { result, runtime } = await openDemo(name, format);
      expect(result.topics.map(({ name: topic }) => topic).sort()).toEqual([...expectedKinds.keys(), "/demo/custom_status"].sort());
      for (const [topic, expectedKind] of expectedKinds) {
        const sample = await runtime.messageAt(topic, 0n);
        const decoded = decodeSemanticMessage({ channel: sample.channel, data: sample.data });
        expect(decoded.kind, `${format} ${topic}`).toBe(expectedKind);
      }
      const custom = await runtime.messageAt("/demo/custom_status", 0n);
      const generic = decodeGenericRosMessage({
        typeName: custom.channel.schema.name,
        messageEncoding: custom.channel.messageEncoding,
        schemaEncoding: custom.channel.schema.encoding,
        schemaDefinition: custom.channel.schema.definition,
        schemaData: custom.channel.schema.data,
        data: custom.data,
      });
      expect(generic.value).toMatchObject({ score: 0.5, inliers: 120, state: "tracking" });
      expect(generic.numericFields.map(({ path }) => path)).toContain("residuals[2]");
    });
  }
});
