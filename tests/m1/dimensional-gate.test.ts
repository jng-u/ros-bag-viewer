import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PathDisplay,
  PointCloud2Display,
  type GeometryInput,
  type GeometryRendererPort,
  type GeometryResource,
} from "../../packages/displays-core/src/index.js";
import { TfBuffer } from "../../packages/tf/src/index.js";
import { BoundedTimelineQueue, normalizeSchedulingTime } from "../../packages/timeline/src/index.js";
import {
  BoundedByteReader,
  SourceEpochController,
  type ByteRange,
  type RangeSource,
  type WorkerResourceLimits,
} from "../../packages/worker-runtime/src/index.js";

interface Artifact {
  generatedBy: string;
  evidenceClassification: {
    kind: string;
    productionHardwareResult: boolean;
    browserBenchmarkResult: boolean;
    disclaimer: string;
  };
  scenario: {
    corpus: { sourceBytes: number; indexingModes: string[] };
    environment: {
      observedMachine: boolean;
      browserExecuted: boolean;
      viewportCssPixels: [number, number];
      devicePixelRatio: number;
      cacheState: string;
    };
    workload: {
      activeDisplays: number;
      repetitions: number;
      pointCount: number;
      pathPoseCount: number;
      rendererMaxGpuBytes: number;
      rendererMaxBufferBytes: number;
    };
    costModel: { sequentialReadBytes: number; percentileMethod: string; fixedOverheadBytes: number };
  };
  source: {
    indexedSeek: {
      telemetry: { readCalls: number; completedBytes: number; peakInFlightBytes: number };
      rawRequests: Array<{ offset: number; length: number }>;
      modeledMilliseconds: number;
      boundedRangeProof: boolean;
    };
    unindexedScan: {
      telemetry: { readCalls: number; completedBytes: number; peakInFlightBytes: number };
      requestCount: number;
      modeledMilliseconds: number;
      boundedRangeProof: boolean;
    };
  };
  render: {
    semanticScenes: Array<{
      displayKind: string;
      primitive: string;
      inputVertices: number;
      renderedVertices: number;
      droppedVertices: number;
    }>;
    semanticDigest: string;
    thinWebGl2: {
      evidenceKind: string;
      hardwareMeasurement: boolean;
      firstContentMilliseconds: number;
      frameTime: Record<string, number>;
      rawFrameSamplesMilliseconds: number[];
      longTaskCount: number;
      rendererTelemetryBeforeDispose: {
        liveGpuBytes: number;
        peakGpuBytes: number;
        drawCalls: number;
        rejectedAllocations: number;
      };
      rendererTelemetryAfterDispose: {
        liveBuffers: number;
        liveGpuBytes: number;
        pooledBuffers: number;
        pooledGpuBytes: number;
      };
      mockWebGlOperations: {
        bufferAllocations: number[];
        bufferUploads: number[];
        drawCalls: Array<{ mode: number; count: number }>;
        createdBuffers: number;
        deletedBuffers: number;
      };
      memoryEstimate: {
        formula: string;
        activeDecodedBytes: number;
        retainedJsBytes: number;
        retainedWasmBytes: number;
        gpuWorkingSetBytes: number;
        fixedOverheadBytes: number;
        workingSetBytes: number;
      };
      queue: { capacity: number; modeledMaximumDepth: number; modeledDroppedMessagesPerSecond: number };
    };
    rejectedHeavyweightHelperBaseline: {
      evidenceKind: string;
      libraryIdentity: null;
      installedOrExecutedLibrary: boolean;
      hardwareMeasurement: boolean;
      frameTime: Record<string, number>;
      rawFrameSamplesMilliseconds: number[];
    };
  };
  rendererDecisionComparison: {
    conclusion: string;
  };
}

const artifact = JSON.parse(
  readFileSync(new URL("../../benchmarks/artifacts/m1-dimensional-model.json", import.meta.url), "utf8"),
) as Artifact;

function nearestRank(values: readonly number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)] ?? Number.NaN;
}

class FixedRangeSource implements RangeSource {
  readonly size = 1024n;
  readonly requests: ByteRange[] = [];

  async read(range: ByteRange, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) throw new Error("aborted");
    this.requests.push(range);
    return new Uint8Array(Number(range.length));
  }
}

class CapturingRenderer implements GeometryRendererPort {
  readonly inputs: GeometryInput[] = [];
  readonly resources = new Map<string, GeometryResource>();

  upsert(input: GeometryInput): GeometryResource {
    this.inputs.push(input);
    let disposed = false;
    const resource: GeometryResource = {
      id: input.id,
      vertexCount: input.positions.length / 3,
      get disposed() {
        return disposed;
      },
      draw: () => undefined,
      dispose: () => {
        disposed = true;
        this.resources.delete(input.id);
      },
    };
    this.resources.set(input.id, resource);
    return resource;
  }

  remove(id: string): void {
    this.resources.get(id)?.dispose();
  }
}

function pointCloud(points: readonly [number, number, number][]) {
  const data = new Uint8Array(points.length * 12);
  const view = new DataView(data.buffer);
  points.forEach(([x, y, z], index) => {
    view.setFloat32(index * 12, x, true);
    view.setFloat32(index * 12 + 4, y, true);
    view.setFloat32(index * 12 + 8, z, true);
  });
  return {
    frameId: "lidar",
    width: points.length,
    height: 1,
    pointStep: 12,
    rowStep: points.length * 12,
    isBigEndian: false,
    fields: [
      { name: "x", offset: 0, datatype: 7, count: 1 },
      { name: "y", offset: 4, datatype: 7, count: 1 },
      { name: "z", offset: 8, datatype: 7, count: 1 },
    ],
    data,
  };
}

describe("M1 dimensional evidence gate", () => {
  it("keeps model evidence distinct from browser and production hardware results", () => {
    expect(artifact.generatedBy).toBe("benchmarks/scenarios/run-m1-dimensional.mjs");
    expect(artifact.evidenceClassification).toMatchObject({
      kind: "deterministic-dimensional-and-operation-cost-model",
      productionHardwareResult: false,
      browserBenchmarkResult: false,
    });
    expect(artifact.evidenceClassification.disclaimer).toMatch(/not a production browser or hardware/i);
    expect(artifact.scenario.environment).toMatchObject({
      observedMachine: false,
      browserExecuted: false,
      viewportCssPixels: [1440, 900],
      devicePixelRatio: 1,
      cacheState: "cold-model",
    });
    expect(artifact.render.thinWebGl2.hardwareMeasurement).toBe(false);
    expect(artifact.render.rejectedHeavyweightHelperBaseline).toMatchObject({
      libraryIdentity: null,
      installedOrExecutedLibrary: false,
      hardwareMeasurement: false,
    });
    expect(artifact.rendererDecisionComparison.conclusion).toMatch(/Do not claim library-level speed superiority/i);
  });

  it("proves bounded indexed ranges separately from a bounded sequential degraded scan", () => {
    const { sourceBytes } = artifact.scenario.corpus;
    const { sequentialReadBytes } = artifact.scenario.costModel;
    const { indexedSeek, unindexedScan } = artifact.source;

    expect(artifact.scenario.corpus.indexingModes).toEqual(["indexed", "unindexed-sequential"]);
    expect(indexedSeek.boundedRangeProof).toBe(true);
    expect(indexedSeek.telemetry.completedBytes).toBeLessThan(sourceBytes);
    expect(indexedSeek.rawRequests.every(({ length }) => length <= sequentialReadBytes && length < sourceBytes)).toBe(true);
    expect(unindexedScan.boundedRangeProof).toBe(true);
    expect(unindexedScan.telemetry.completedBytes).toBe(sourceBytes);
    expect(unindexedScan.telemetry.peakInFlightBytes).toBeLessThan(sourceBytes);
    expect(unindexedScan.telemetry.peakInFlightBytes).toBeLessThanOrEqual(sequentialReadBytes);
    expect(unindexedScan.requestCount).toBeGreaterThan(1);
    expect(indexedSeek.modeledMilliseconds).toBeLessThan(unindexedScan.modeledMilliseconds);
  });

  it("recomputes p50/p95/p99 and the dimensional working-set formula from raw values", () => {
    const thin = artifact.render.thinWebGl2;
    expect(thin.rawFrameSamplesMilliseconds).toHaveLength(artifact.scenario.workload.repetitions);
    expect(thin.frameTime).toMatchObject({
      p50Milliseconds: nearestRank(thin.rawFrameSamplesMilliseconds, 50),
      p95Milliseconds: nearestRank(thin.rawFrameSamplesMilliseconds, 95),
      p99Milliseconds: nearestRank(thin.rawFrameSamplesMilliseconds, 99),
    });
    expect(thin.frameTime.p50Milliseconds).toBeLessThanOrEqual(thin.frameTime.p95Milliseconds);
    expect(thin.frameTime.p95Milliseconds).toBeLessThanOrEqual(thin.frameTime.p99Milliseconds);
    expect(thin.firstContentMilliseconds).toBeGreaterThan(artifact.source.indexedSeek.modeledMilliseconds);
    expect(thin.longTaskCount).toBe(0);
    expect(thin.queue.modeledMaximumDepth).toBeLessThanOrEqual(thin.queue.capacity);

    const memory = thin.memoryEstimate;
    expect(memory.formula).toBe("2 × active decoded bytes + GPU working-set bytes + fixed overhead bytes");
    expect(memory.retainedJsBytes).toBe(memory.activeDecodedBytes * 2 + memory.fixedOverheadBytes);
    expect(memory.workingSetBytes).toBe(
      memory.activeDecodedBytes * 2 + memory.gpuWorkingSetBytes + memory.fixedOverheadBytes,
    );
    expect(memory.retainedWasmBytes).toBe(0);
  });

  it("locks semantic PointCloud2/Path summaries, logical GPU accounting, and full disposal", () => {
    expect(artifact.render.semanticScenes).toMatchObject([
      {
        displayKind: "pointcloud2",
        primitive: "points",
        inputVertices: 120000,
        renderedVertices: 60000,
        droppedVertices: 60000,
      },
      {
        displayKind: "path",
        primitive: "line-strip",
        inputVertices: 2000,
        renderedVertices: 2000,
        droppedVertices: 0,
      },
    ]);
    expect(createHash("sha256").update(JSON.stringify(artifact.render.semanticScenes)).digest("hex")).toBe(
      artifact.render.semanticDigest,
    );
    expect(artifact.render.thinWebGl2.rendererTelemetryBeforeDispose).toMatchObject({
      liveGpuBytes: artifact.render.thinWebGl2.memoryEstimate.gpuWorkingSetBytes,
      peakGpuBytes: artifact.render.thinWebGl2.memoryEstimate.gpuWorkingSetBytes,
      drawCalls: 2,
      rejectedAllocations: 0,
    });
    expect(artifact.render.thinWebGl2.rendererTelemetryAfterDispose).toEqual({
      liveBuffers: 0,
      liveGpuBytes: 0,
      pooledBuffers: 0,
      pooledGpuBytes: 0,
      peakGpuBytes: 744000,
      drawCalls: 2,
      disposedBuffers: 2,
      rejectedAllocations: 0,
      decimatedVertices: 0,
    });
    expect(artifact.render.thinWebGl2.mockWebGlOperations.drawCalls.map(({ mode }) => mode)).toEqual([0, 3]);
    expect(
      artifact.render.thinWebGl2.mockWebGlOperations.bufferAllocations.every(
        (byteLength) => byteLength <= artifact.scenario.workload.rendererMaxBufferBytes,
      ),
    ).toBe(true);
    expect(artifact.render.thinWebGl2.mockWebGlOperations.createdBuffers).toBe(
      artifact.render.thinWebGl2.mockWebGlOperations.deletedBuffers,
    );
  });

  it("connects bounded reads, normalized time, TF, queue, and both semantic displays", async () => {
    const source = new FixedRangeSource();
    const limits: WorkerResourceLimits = {
      maxSingleReadBytes: 128,
      maxTotalReadBytes: 512n,
      maxConcurrentReads: 1,
      maxQueuedReads: 2,
      maxBufferedBytes: 128,
      maxDecompressedBytes: 512,
      maxDecompressionRatio: 8,
      maxCacheBytes: 256,
    };
    const reader = new BoundedByteReader(source, new SourceEpochController(), limits);
    await reader.read(0n, 64n);
    await reader.read(512n, 128n);
    expect(reader.snapshotTelemetry()).toMatchObject({ readCalls: 2, completedBytes: 192n, peakInFlightBytes: 128 });
    expect(source.requests.every(({ length }) => length <= 128n)).toBe(true);

    const scheduling = normalizeSchedulingTime([
      { source: "record", valueNanos: 5n },
      { source: "header", valueNanos: 4n },
    ]);
    const queue = new BoundedTimelineQueue(1, 2, 256);
    queue.push({
      epoch: 1,
      payloadBytes: 64,
      valueNanos: scheduling.valueNanos,
      sourceId: "source",
      channelId: "points",
      sourceSequence: 1n,
    });
    expect(queue.telemetry()).toMatchObject({ messages: 1, payloadBytes: 64, droppedMessages: 0 });

    const tf = new TfBuffer(1, 4);
    for (const [timeNanos, x] of [
      [0n, 0],
      [10n, 10],
    ] as const) {
      tf.add({
        parentFrame: "map",
        childFrame: "lidar",
        timeNanos,
        epoch: 1,
        isStatic: false,
        translation: { x, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      });
    }
    expect(tf.lookup("map", "lidar", 5n, 1)).toMatchObject({
      ok: true,
      interpolated: true,
      transform: { translation: { x: 5, y: 0, z: 0 } },
    });

    const renderer = new CapturingRenderer();
    const cloud = new PointCloud2Display("cloud", renderer);
    cloud.configure({ maxPoints: 2, maxInputBytes: 48 });
    cloud.attachSource(1);
    expect(
      cloud.update(
        pointCloud([
          [0, 0, 0],
          [1, 1, 1],
          [2, 2, 2],
          [3, 3, 3],
        ]),
        1,
      ),
    ).toMatchObject({ displayKind: "pointcloud2", primitive: "points", renderedVertices: 2, droppedVertices: 2 });

    const path = new PathDisplay("path", renderer);
    path.configure({ maxPoses: 3, maxInputBytes: 72 });
    path.attachSource(1);
    expect(
      path.update(
        {
          frameId: "map",
          poses: [0, 1, 2].map((x) => ({ position: { x, y: 0, z: 0 } })),
        },
        1,
      ),
    ).toMatchObject({ displayKind: "path", primitive: "line-strip", renderedVertices: 3, droppedVertices: 0 });
    expect(renderer.inputs.map(({ topology }) => topology)).toEqual(["points", "line-strip"]);
  });

  it("documents every required dimension and the non-claim boundary", () => {
    const benchmark = readFileSync(new URL("../../docs/benchmark.md", import.meta.url), "utf8");
    const adr = readFileSync(new URL("../../docs/adr/0004-m1-thin-webgl2-renderer.md", import.meta.url), "utf8");
    for (const pattern of [
      /fixed scenario/i,
      /pointcloud2/i,
      /topic rate/i,
      /active displays/i,
      /cache/i,
      /repetitions/i,
      /p50.*p95.*p99/i,
      /long.task/i,
      /queue.*drop/i,
      /retained JS/i,
      /retained WASM/i,
      /GPU working set/i,
      /indexed seek/i,
      /unindexed/i,
      /not measured/i,
      /not a library measurement/i,
    ]) {
      expect(benchmark).toMatch(pattern);
    }
    expect(adr).toMatch(/Accepted for the private M1 implementation baseline/i);
    expect(adr).toMatch(/does not prove speed superiority/i);
    expect(adr).toMatch(/explicit.*disposal/i);
  });
});
