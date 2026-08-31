import { describe, expect, it } from "vitest";

import {
  PathDisplay,
  PointCloud2Display,
  createDefaultDisplayRegistry,
  type GeometryInput,
  type GeometryRendererPort,
  type GeometryResource,
  type PathMessage,
  type PointCloud2Message,
} from "../src/index.js";

class MockGeometry implements GeometryResource {
  disposed = false;
  draws = 0;

  constructor(
    readonly id: string,
    readonly vertexCount: number,
  ) {}

  draw(): void {
    if (this.disposed) throw new Error("disposed");
    this.draws += 1;
  }

  dispose(): void {
    this.disposed = true;
  }
}

class MockRenderer implements GeometryRendererPort {
  readonly inputs: GeometryInput[] = [];
  readonly resources = new Map<string, MockGeometry>();

  upsert(input: GeometryInput): GeometryResource {
    this.inputs.push({ ...input, positions: input.positions.slice() });
    const resource = new MockGeometry(input.id, input.positions.length / 3);
    this.resources.set(input.id, resource);
    return resource;
  }

  remove(id: string): void {
    this.resources.get(id)?.dispose();
    this.resources.delete(id);
  }
}

function pointCloud(points: ReadonlyArray<readonly [number, number, number]>): PointCloud2Message {
  const pointStep = 12;
  const data = new Uint8Array(points.length * pointStep);
  const view = new DataView(data.buffer);
  points.forEach(([x, y, z], index) => {
    const offset = index * pointStep;
    view.setFloat32(offset, x, true);
    view.setFloat32(offset + 4, y, true);
    view.setFloat32(offset + 8, z, true);
  });
  return {
    frameId: "map",
    width: points.length,
    height: 1,
    pointStep,
    rowStep: data.byteLength,
    isBigEndian: false,
    fields: [
      { name: "x", offset: 0, datatype: 7, count: 1 },
      { name: "y", offset: 4, datatype: 7, count: 1 },
      { name: "z", offset: 8, datatype: 7, count: 1 },
    ],
    data,
  };
}

function path(count: number): PathMessage {
  return {
    frameId: "map",
    poses: Array.from({ length: count }, (_, index) => ({ position: { x: index, y: index * 2, z: 0 } })),
  };
}

describe("PointCloud2Display", () => {
  it("dogfoods lifecycle transitions and emits a deterministic bounded scene", () => {
    const renderer = new MockRenderer();
    const display = new PointCloud2Display("cloud", renderer);
    display.configure({ maxPoints: 3, maxInputBytes: 1024, color: [1, 0, 0, 1] });
    display.attachSource(4);

    const summary = display.update(
      pointCloud([
        [0, 0, 0],
        [1, 1, 1],
        [2, 2, 2],
        [3, 3, 3],
        [4, 4, 4],
      ]),
      4,
    );
    display.render();

    expect(summary).toEqual({
      displayKind: "pointcloud2",
      frameId: "map",
      primitive: "points",
      inputVertices: 5,
      renderedVertices: 3,
      droppedVertices: 2,
      bounds: { min: [0, 0, 0], max: [4, 4, 4] },
    });
    expect(renderer.inputs[0]?.positions).toEqual(new Float32Array([0, 0, 0, 2, 2, 2, 4, 4, 4]));
    expect(renderer.inputs[0]?.topology).toBe("points");
    expect(display.telemetry()).toMatchObject({
      state: "rendering",
      updates: 1,
      renders: 1,
      decimatedVertices: 2,
    });

    display.dispose();
    expect(display.state).toBe("disposed");
    expect(renderer.resources.has("cloud")).toBe(false);
  });

  it("rejects stale epochs and oversized inputs without allocating geometry", () => {
    const renderer = new MockRenderer();
    const display = new PointCloud2Display("cloud", renderer);
    display.configure({ maxPoints: 2, maxInputBytes: 12 });
    display.attachSource(1);

    expect(() => display.update(pointCloud([[0, 0, 0]]), 2)).toThrow(/stale source epoch/);
    expect(() => display.update(pointCloud([[0, 0, 0], [1, 1, 1]]), 1)).toThrow(/byte budget exceeded/);
    expect(renderer.inputs).toHaveLength(0);
    expect(display.telemetry()).toMatchObject({ state: "error", rejectedMessages: 1 });
  });

  it("rejects unbounded field metadata before parsing payloads", () => {
    const renderer = new MockRenderer();
    const display = new PointCloud2Display("cloud", renderer);
    display.configure({ maxPoints: 2, maxInputBytes: 1024 });
    display.attachSource(1);
    const message = pointCloud([[0, 0, 0]]);

    expect(() =>
      display.update(
        {
          ...message,
          fields: Array.from({ length: 65 }, (_, index) => ({
            name: index === 0 ? "x" : `field-${index}`,
            offset: 0,
            datatype: 7,
            count: 1,
          })),
        },
        1,
      ),
    ).toThrow(/field count exceeds limit/);
    expect(renderer.inputs).toHaveLength(0);
  });
});

describe("PathDisplay", () => {
  it("decimates a path into a line strip with bounded semantic evidence", () => {
    const renderer = new MockRenderer();
    const display = new PathDisplay("path", renderer);
    display.configure({ maxPoses: 2, maxInputBytes: 1024 });
    display.attachSource(7);

    const summary = display.update(path(5), 7);
    display.render();

    expect(summary).toEqual({
      displayKind: "path",
      frameId: "map",
      primitive: "line-strip",
      inputVertices: 5,
      renderedVertices: 2,
      droppedVertices: 3,
      bounds: { min: [0, 0, 0], max: [3, 6, 0] },
    });
    expect(renderer.inputs[0]?.positions).toEqual(new Float32Array([0, 0, 0, 3, 6, 0]));
    expect(renderer.resources.get("path")?.draws).toBe(1);
  });
});

describe("DisplayRegistry", () => {
  it("registers the two internal display families without exposing WebGL", () => {
    const registry = createDefaultDisplayRegistry();
    const renderer = new MockRenderer();

    expect(registry.kinds()).toEqual(["path", "pointcloud2"]);
    expect(registry.create("pointcloud2", "cloud", renderer)).toBeInstanceOf(PointCloud2Display);
    expect(registry.create("path", "path", renderer)).toBeInstanceOf(PathDisplay);
  });
});
