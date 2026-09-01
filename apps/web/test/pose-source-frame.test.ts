import { describe, expect, it } from "vitest";

import { PoseDisplay, type GeometryInput, type GeometryRendererPort, type GeometryResource } from "@ros-web-viewer/displays-core";

import { poseSourceFrame } from "../src/pose-source-frame.js";

describe("headerless geometry_msgs/Pose display policy", () => {
  it("renders a raw Pose in the selected fixed frame", () => {
    const renderer: GeometryRendererPort = {
      upsert(input: GeometryInput): GeometryResource { return { id: input.id, vertexCount: input.positions.length / 3, disposed: false, draw() {}, dispose() {} }; },
      remove() {},
    };
    const display = new PoseDisplay("pose", renderer);
    display.configure({ axisLength: 1, maxInputBytes: 4096 });
    display.attachSource(1);
    expect(display.update({
      frameId: poseSourceFrame("", "map"),
      position: { x: 1, y: 2, z: 3 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    }, 1)).toMatchObject({ frameId: "map", displayKind: "pose", renderedVertices: 2 });
  });
});
