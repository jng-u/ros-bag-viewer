import { describe, expect, it } from "vitest";

import { preparePointCloud2, type PointCloud2Message } from "../src/index.js";

describe("PointCloud2 color preparation", () => {
  it("prepares intensity, RGB, and axis per-point colors with explicit point size", () => {
    const data = new Uint8Array(40);
    const view = new DataView(data.buffer);
    const values = [
      { xyz: [0, 0, 0], intensity: 0, rgb: 0xff0000 },
      { xyz: [0, 0, 10], intensity: 100, rgb: 0x00ff00 },
    ] as const;
    values.forEach(({ xyz, intensity, rgb }, index) => {
      const offset = index * 20;
      xyz.forEach((value, axis) => view.setFloat32(offset + axis * 4, value, true));
      view.setFloat32(offset + 12, intensity, true);
      view.setUint32(offset + 16, rgb, true);
    });
    const message: PointCloud2Message = {
      frameId: "lidar", width: 2, height: 1, pointStep: 20, rowStep: 40, isBigEndian: false, data,
      fields: [
        { name: "x", offset: 0, datatype: 7, count: 1 }, { name: "y", offset: 4, datatype: 7, count: 1 },
        { name: "z", offset: 8, datatype: 7, count: 1 }, { name: "intensity", offset: 12, datatype: 7, count: 1 },
        { name: "rgb", offset: 16, datatype: 7, count: 1 },
      ],
    };
    const base = { maxPoints: 2, maxInputBytes: 1024, pointSize: 7 } as const;
    const intensity = preparePointCloud2(message, { ...base, colorMode: "intensity" });
    const rgb = preparePointCloud2(message, { ...base, colorMode: "rgb" });
    const axis = preparePointCloud2(message, { ...base, colorMode: "axis", colorAxis: "z" });
    expect(intensity.pointSize).toBe(7);
    expect(intensity.colors).toHaveLength(8);
    expect(axis.colors).toEqual(intensity.colors);
    expect([...rgb.colors!]).toEqual([1, 0, 0, 1, 0, 1, 0, 1]);
  });
});
