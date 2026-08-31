import { describe, expect, it } from "vitest";

import { emitV1SemanticEvent } from "../../../tests/support/v1-conformance-event.js";
import {
  CameraInfoDisplay,
  FrameTreeDisplay,
  GridDisplay,
  ImageDisplay,
  LaserScanDisplay,
  MarkerDisplay,
  MarkerStore,
  NumericPlotDisplay,
  OccupancyGridDisplay,
  OdometryDisplay,
  PathDisplay,
  PoseDisplay,
  PointCloud2Display,
  RawInspectorDisplay,
  createDefaultDisplayRegistry,
  extractNumericValue,
  inspectRawMessage,
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
  it("registers every M2 display family without exposing WebGL", () => {
    const registry = createDefaultDisplayRegistry();
    const renderer = new MockRenderer();

    expect(registry.kinds()).toEqual([
      "camera-info",
      "frame-tree",
      "grid",
      "image",
      "laser-scan",
      "marker",
      "numeric-plot",
      "occupancy-grid",
      "odometry",
      "path",
      "pointcloud2",
      "pose",
      "raw-inspector",
    ]);
    expect(registry.create("pointcloud2", "cloud", renderer)).toBeInstanceOf(PointCloud2Display);
    expect(registry.create("path", "path", renderer)).toBeInstanceOf(PathDisplay);
    expect(registry.create("raw-inspector", "raw", renderer)).toBeInstanceOf(RawInspectorDisplay);
  });
});

describe("M2 geometry displays", () => {
  it("converts LaserScan angles deterministically and drops invalid ranges", () => {
    const renderer = new MockRenderer();
    const display = new LaserScanDisplay("scan", renderer);
    display.configure({ maxRanges: 8, maxInputBytes: 64 });
    display.attachSource(2);

    expect(
      display.update(
        {
          frameId: "laser",
          angleMin: 0,
          angleIncrement: Math.PI / 2,
          rangeMin: 0.1,
          rangeMax: 10,
          ranges: [1, Number.NaN, 2, 20],
        },
        2,
      ),
    ).toMatchObject({
      displayKind: "laser-scan",
      frameId: "laser",
      inputVertices: 4,
      renderedVertices: 2,
      droppedVertices: 2,
    });
    expect([...(renderer.inputs[0]?.positions ?? [])]).toEqual([
      1,
      0,
      0,
      -2,
      expect.closeTo(0, 6),
      0,
    ]);
  });

  it("builds fixed-frame TF lines, rejects cycles, and creates a bounded grid", () => {
    const renderer = new MockRenderer();
    const tf = new FrameTreeDisplay("tf", renderer);
    tf.configure({ fixedFrame: "map", maxTransforms: 8, maxInputBytes: 1024 });
    tf.attachSource(3);
    expect(
      tf.update(
        {
          transforms: [
            { parentFrameId: "map", childFrameId: "odom", translation: { x: 1, y: 0, z: 0 } },
            { parentFrameId: "odom", childFrameId: "base", translation: { x: 0, y: 2, z: 0 } },
          ],
        },
        3,
      ),
    ).toMatchObject({ displayKind: "frame-tree", renderedVertices: 4, details: { frames: 3, transforms: 2 } });
    expect(renderer.inputs[0]?.positions).toEqual(new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 2, 0]));

    tf.attachSource(4);
    expect(() =>
      tf.update(
        {
          transforms: [
            { parentFrameId: "b", childFrameId: "a", translation: { x: 0, y: 0, z: 0 } },
            { parentFrameId: "a", childFrameId: "b", translation: { x: 0, y: 0, z: 0 } },
          ],
        },
        4,
      ),
    ).toThrow(/cycle/);

    const grid = new GridDisplay("grid", renderer);
    grid.configure({ halfExtent: 2, divisions: 2, maxInputBytes: 1024 });
    grid.attachSource(1);
    expect(grid.update({ frameId: "map" }, 1)).toMatchObject({ displayKind: "grid", renderedVertices: 12 });
  });

  it("renders pose/odometry axes and validates covariance", () => {
    const renderer = new MockRenderer();
    const pose = new PoseDisplay("pose", renderer);
    pose.configure({ axisLength: 2, maxInputBytes: 128 });
    pose.attachSource(1);
    expect(
      pose.update(
        { frameId: "map", position: { x: 1, y: 2, z: 3 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
        1,
      ),
    ).toMatchObject({ displayKind: "pose", bounds: { min: [1, 2, 3], max: [3, 2, 3] } });

    const odometry = new OdometryDisplay("odom", renderer);
    odometry.configure({ axisLength: 1, maxInputBytes: 512 });
    odometry.attachSource(1);
    expect(() =>
      odometry.update(
        {
          frameId: "odom",
          childFrameId: "base",
          pose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
          poseCovariance: [1, 2],
        },
        1,
      ),
    ).toThrow(/36 finite values/);
  });

  it("bounds Marker arrays and OccupancyGrid cell conversion", () => {
    const renderer = new MockRenderer();
    const marker = new MarkerDisplay("marker", renderer);
    marker.configure({ maxMarkers: 2, maxPoints: 2, maxInputBytes: 1024 });
    marker.attachSource(1);
    expect(
      marker.update(
        {
          frameId: "map",
          namespace: "route",
          id: 1,
          action: "add",
          type: "line-strip",
          points: [
            { x: 0, y: 0, z: 0 },
            { x: 1, y: 0, z: 0 },
            { x: 2, y: 0, z: 0 },
          ],
        },
        1,
      ),
    ).toMatchObject({ displayKind: "marker", renderedVertices: 2, droppedVertices: 1 });
    marker.attachSource(2);
    expect(() =>
      marker.update(
        { frameId: "map", namespace: "mesh", id: 2, action: "add", type: "mesh-resource", points: [{ x: 0, y: 0, z: 0 }] },
        2,
      ),
    ).toThrow(/unsupported marker type/);

    const map = new OccupancyGridDisplay("map", renderer);
    map.configure({ occupiedThreshold: 50, maxCells: 2, maxInputBytes: 16 });
    map.attachSource(1);
    expect(
      map.update(
        {
          frameId: "map",
          width: 2,
          height: 2,
          resolution: 0.5,
          origin: { x: 1, y: 2, z: 0 },
          data: Int8Array.from([0, 100, -1, 60]),
        },
        1,
      ),
    ).toMatchObject({
      displayKind: "occupancy-grid",
      renderedVertices: 2,
      details: { width: 2, height: 2, resolution: 0.5, unknownCells: 1 },
    });
  });

  it("applies marker namespace/id replacement, deletion, and lifetime deterministically", () => {
    const store = new MarkerStore();
    const marker = {
      frameId: "map",
      namespace: "route",
      id: 1,
      action: "add" as const,
      type: "points",
      points: [{ x: 0, y: 0, z: 0 }],
      stampNanos: 10n,
      lifetimeNanos: 5n,
    };
    expect(store.apply(marker, 10n)).toHaveLength(1);
    expect(store.active(14n)).toHaveLength(1);
    expect(store.active(15n)).toHaveLength(0);
    store.apply({ ...marker, stampNanos: 20n, lifetimeNanos: 0n }, 20n);
    expect(store.apply({ ...marker, action: "delete", stampNanos: 21n }, 21n)).toHaveLength(0);
    store.apply({ ...marker, stampNanos: 22n, lifetimeNanos: 0n }, 22n);
    expect(store.apply({ ...marker, action: "delete-all", stampNanos: 23n }, 23n)).toHaveLength(0);
  });
});

describe("M2 raster and generic fallback displays", () => {
  it("validates raw/compressed images and reports unsupported codecs truthfully", () => {
    const image = new ImageDisplay("image");
    image.configure({ maxInputBytes: 64, maxPixels: 16 });
    image.attachSource(1);
    expect(
      image.update(
        { frameId: "camera", width: 2, height: 1, encoding: "rgb8", step: 6, data: Uint8Array.from([1, 2, 3, 4, 5, 6]) },
        1,
      ),
    ).toMatchObject({ displayKind: "image", details: { compressed: false, encoding: "rgb8", width: 2, height: 1 } });
    image.attachSource(2);
    expect(() => image.update({ frameId: "camera", format: "h264", data: Uint8Array.of(1) }, 2)).toThrow(
      /unsupported compressed image codec/,
    );

    const camera = new CameraInfoDisplay("camera-info");
    camera.configure({ maxInputBytes: 512, supportedDistortionModels: ["plumb_bob"] });
    camera.attachSource(1);
    expect(
      camera.update(
        {
          frameId: "camera",
          width: 640,
          height: 480,
          distortionModel: "custom",
          d: [],
          k: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          r: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          p: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
        },
        1,
      ).diagnostics,
    ).toEqual(["unsupported CameraInfo distortion model: custom"]);
  });

  it("extracts bounded numeric leaves with gap behavior and resets on epochs", () => {
    expect(extractNumericValue({ pose: { covariance: [1, 2, 3] } }, "pose.covariance", 1)).toBe(2);
    const plot = new NumericPlotDisplay("plot");
    plot.configure({ fieldPath: "metrics.score", maxSamples: 2, maxInputBytes: 128 });
    plot.attachSource(1);
    expect(plot.update({ timestampNanos: 1n, value: { metrics: { score: 4 } } }, 1)).toMatchObject({ renderedVertices: 1 });
    expect(plot.update({ timestampNanos: 2n, value: { metrics: { score: Number.NaN } } }, 1)).toMatchObject({
      renderedVertices: 0,
      droppedVertices: 1,
    });
    expect(plot.samples()).toEqual([
      { timestampNanos: 1n, value: 4, gap: false },
      { timestampNanos: 2n, gap: true },
    ]);
    plot.attachSource(2);
    expect(plot.samples()).toEqual([]);
  });

  it("keeps schema-backed trees bounded and opaque payloads byte-only", () => {
    const limits = {
      maxInputBytes: 128,
      maxDepth: 2,
      maxFields: 3,
      maxArrayLength: 2,
      maxStringBytes: 4,
      maxPreviewBytes: 3,
    };
    expect(
      inspectRawMessage(
        { typeName: "custom/State", schemaCapability: "opaque", bytes: Uint8Array.from([1, 2, 3, 4, 5]) },
        limits,
      ),
    ).toEqual({
      capability: "opaque",
      typeName: "custom/State",
      bytePreview: [1, 2, 3],
      fieldsVisited: 0,
      truncated: true,
      diagnostics: [
        "schema unavailable; import a bounded schema pack to decode typed fields",
        "opaque byte preview truncated",
      ],
    });

    const raw = new RawInspectorDisplay("raw");
    raw.configure(limits);
    raw.attachSource(8);
    expect(raw.update({ typeName: "custom/State", schemaCapability: "schema-present", value: { z: 1, a: [1, 2, 3] } }, 8)).toMatchObject({
      displayKind: "raw-inspector",
      details: { capability: "schema-present", typeName: "custom/State", truncated: true },
    });
    const inspection = raw.inspection();
    expect(inspection?.tree).toEqual({ a: [1, 2], z: 1 });
    emitV1SemanticEvent({ schemaVersion: 1, domain: "schema", result: "pass", code: "schema-opaque-fallback", facts: {
      capability: inspection?.capability ?? "missing", fieldsVisited: inspection?.fieldsVisited ?? 0,
      truncated: inspection?.truncated ?? false,
    } });
  });
});
