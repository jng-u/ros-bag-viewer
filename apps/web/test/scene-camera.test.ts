import { describe, expect, it } from "vitest";

import { OrbitCamera } from "../src/scene-camera.js";

describe("iridescence-style orbit camera", () => {
  it("frames combined scene bounds and returns a finite perspective view-projection", () => {
    const camera = new OrbitCamera();
    camera.frame({ min: [-4, -2, -1], max: [6, 8, 3] });
    expect(camera.snapshot().target).toEqual([1, 3, 1]);
    expect(camera.snapshot().distance).toBeGreaterThan(10);
    expect([...camera.viewProjection(16 / 9)].every(Number.isFinite)).toBe(true);
  });

  it("supports orbit, pan, zoom, and deterministic top/front presets", () => {
    const camera = new OrbitCamera();
    const before = camera.snapshot();
    camera.orbit(80, -30);
    camera.pan(20, 10, 900);
    camera.zoom(-120);
    expect(camera.snapshot()).not.toEqual(before);
    camera.preset("top");
    expect(camera.snapshot()).toMatchObject({ pitch: Math.PI / 2 - 0.001 });
    camera.preset("front");
    expect(camera.snapshot()).toMatchObject({ yaw: -Math.PI / 2, pitch: 0 });
  });
});
