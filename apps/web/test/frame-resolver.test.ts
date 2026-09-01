import { describe, expect, it } from "vitest";
import { TfBuffer } from "@ros-web-viewer/tf";
import { FrameResolver, HistoricalFrameResolver, transformBounds } from "../src/frame-resolver.js";

describe("FrameResolver", () => {
  it("composes parent rotation and translation into the fixed frame", () => {
    const resolver = new FrameResolver("map", [
      { parentFrameId: "map", childFrameId: "base", translation: { x: 1, y: 2, z: 0 }, rotation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 } },
      { parentFrameId: "base", childFrameId: "lidar", translation: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    ]);
    const matrix = resolver.matrixFromFixed("/lidar/");
    expect(Array.from(matrix.slice(12, 15))).toEqual([1, 4, 0]);
    const bounds = transformBounds({ min: [0, 0, 0], max: [1, 0, 0] }, matrix);
    expect(bounds.min[0]).toBeCloseTo(1);
    expect(bounds.min[1]).toBeCloseTo(4);
    expect(bounds.max[0]).toBeCloseTo(1);
    expect(bounds.max[1]).toBeCloseTo(5);
  });

  it("rejects disconnected, ambiguous, and cyclic trees explicitly", () => {
    expect(() => new FrameResolver("map", []).matrixFromFixed("lidar")).toThrow(/disconnected/);
    expect(() => new FrameResolver("map", [
      { parentFrameId: "map", childFrameId: "x", translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      { parentFrameId: "map", childFrameId: "x", translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    ])).toThrow(/ambiguous/);
    expect(() => new FrameResolver("map", [
      { parentFrameId: "b", childFrameId: "a", translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      { parentFrameId: "a", childFrameId: "b", translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    ]).matrixFromFixed("a")).toThrow(/cycle/);
  });

  it("resolves a drawable with TF interpolated at the message header time", () => {
    const buffer = new TfBuffer(4, 16);
    for (const [timeNanos, x] of [[10n, 0], [20n, 10]] as const) buffer.add({
      parentFrame: "map", childFrame: "lidar", timeNanos, isStatic: false, epoch: 4,
      translation: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
    const matrix = new HistoricalFrameResolver("map", 4, buffer).matrixFromFixed("/lidar", 15n);
    expect(matrix[12]).toBeCloseTo(5);
  });

  it("surfaces missing query time and extrapolation rather than using latest TF", () => {
    const buffer = new TfBuffer(2, 8);
    buffer.add({ parentFrame: "map", childFrame: "base", timeNanos: 10n, isStatic: false, epoch: 2, translation: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } });
    const resolver = new HistoricalFrameResolver("map", 2, buffer);
    expect(() => resolver.matrixFromFixed("base")).toThrow(/query time is required/);
    expect(() => resolver.matrixFromFixed("base", 11n)).toThrow(/extrapolation/);
  });

  it("retains interleaved broadcasters and bounds live history globally", () => {
    const buffer = new TfBuffer(6, 4, 30n, 30n);
    for (const [childFrame, timeNanos, x] of [
      ["odom", 10n, 1], ["base", 10n, 2], ["odom", 20n, 3], ["base", 20n, 4],
    ] as const) buffer.add({
      parentFrame: childFrame === "odom" ? "map" : "odom", childFrame, timeNanos, isStatic: false, epoch: 6,
      translation: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
    const resolver = new HistoricalFrameResolver("map", 6, buffer);
    expect(resolver.matrixFromFixed("base", 15n)[12]).toBeCloseTo(5);

    buffer.add({ parentFrame: "map", childFrame: "camera", timeNanos: 30n, isStatic: false, epoch: 6, translation: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } });
    expect(() => resolver.matrixFromFixed("odom", 15n)).toThrow(/bracketing/);
  });

  it("does not discard a bounded recorded window solely because header and log clocks differ", () => {
    const buffer = new TfBuffer(8, 16, 30_000_000_000n, (1n << 63n) - 1n);
    for (const timeNanos of [0n, 35_000_000_000n]) buffer.add({
      parentFrame: "map", childFrame: "lidar", timeNanos, isStatic: false, epoch: 8,
      translation: { x: Number(timeNanos / 1_000_000_000n), y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
    const result = buffer.lookup("map", "lidar", 0n, 8);
    expect(result).toMatchObject({ ok: true, interpolated: false, transform: { translation: { x: 0 } } });
  });
});
