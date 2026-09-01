import { describe, expect, it } from "vitest";

import { FrameTreeDisplay, type GeometryInput, type GeometryRendererPort, type GeometryResource } from "@ros-web-viewer/displays-core";

class CaptureRenderer implements GeometryRendererPort {
  latest?: GeometryInput;
  upsert(input: GeometryInput): GeometryResource {
    this.latest = input;
    return { id: input.id, vertexCount: input.positions.length / 3, disposed: false, draw() {}, dispose() {} };
  }
  remove(): void {}
}

describe("frame-tree fixed-frame re-rooting", () => {
  it("renders both ancestors and descendants when the fixed frame is not the root", () => {
    const renderer = new CaptureRenderer();
    const display = new FrameTreeDisplay("tf", renderer);
    display.configure({ fixedFrame: "odom", maxTransforms: 8, maxInputBytes: 1024 });
    display.attachSource(1);
    expect(display.update({ transforms: [
      { parentFrameId: "map", childFrameId: "odom", translation: { x: 1, y: 0, z: 0 } },
      { parentFrameId: "odom", childFrameId: "base", translation: { x: 0, y: 2, z: 0 } },
    ] }, 1)).toMatchObject({ frameId: "odom", renderedVertices: 4 });
    expect(renderer.latest?.positions).toEqual(new Float32Array([
      -1, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 2, 0,
    ]));
  });
});
