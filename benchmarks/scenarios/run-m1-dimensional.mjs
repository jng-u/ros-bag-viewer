import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { URL, fileURLToPath } from "node:url";

import { PathDisplay, PointCloud2Display } from "../../packages/displays-core/dist/index.js";
import { WebGl2Renderer } from "../../packages/render-core/dist/index.js";
import { BoundedByteReader, SourceEpochController } from "../../packages/worker-runtime/dist/index.js";

const configUrl = new URL("./m1-dimensional.config.json", import.meta.url);
const artifactUrl = new URL("../artifacts/m1-dimensional-model.json", import.meta.url);
const config = JSON.parse(await readFile(configUrl, "utf8"));

class SyntheticRangeSource {
  requests = [];

  constructor(size) {
    this.size = BigInt(size);
  }

  async read(range, signal) {
    if (signal.aborted) throw new Error("synthetic range read aborted");
    if (range.offset < 0n || range.length < 0n || range.offset + range.length > this.size) {
      throw new RangeError("synthetic range outside source");
    }
    this.requests.push({ offset: Number(range.offset), length: Number(range.length) });
    return new Uint8Array(Number(range.length));
  }
}

class MockWebGl2 {
  ARRAY_BUFFER = 0x8892;
  DYNAMIC_DRAW = 0x88e8;
  FLOAT = 0x1406;
  VERTEX_SHADER = 0x8b31;
  FRAGMENT_SHADER = 0x8b30;
  COMPILE_STATUS = 0x8b81;
  LINK_STATUS = 0x8b82;
  POINTS = 0;
  LINES = 1;
  LINE_STRIP = 3;
  createdBuffers = 0;
  deletedBuffers = 0;
  bufferAllocations = [];
  bufferUploads = [];
  draws = [];

  createBuffer() {
    this.createdBuffers += 1;
    return { id: this.createdBuffers };
  }

  deleteBuffer() {
    this.deletedBuffers += 1;
  }

  bindBuffer() {}
  bufferData(_target, size) {
    this.bufferAllocations.push(size);
  }
  bufferSubData(_target, _offset, data) {
    this.bufferUploads.push(data.byteLength);
  }
  createShader() {
    return {};
  }
  shaderSource() {}
  compileShader() {}
  getShaderParameter() {
    return true;
  }
  getShaderInfoLog() {
    return null;
  }
  deleteShader() {}
  createProgram() {
    return {};
  }
  attachShader() {}
  linkProgram() {}
  getProgramParameter() {
    return true;
  }
  getProgramInfoLog() {
    return null;
  }
  deleteProgram() {}
  getAttribLocation() {
    return 0;
  }
  getUniformLocation() {
    return {};
  }
  useProgram() {}
  enableVertexAttribArray() {}
  vertexAttribPointer() {}
  uniformMatrix4fv() {}
  uniform4fv() {}
  drawArrays(mode, _first, count) {
    this.draws.push({ mode, count });
  }
}

function workerLimits(sourceBytes, maxSingleReadBytes) {
  return {
    maxSingleReadBytes,
    maxTotalReadBytes: BigInt(sourceBytes * 2),
    maxConcurrentReads: 1,
    maxQueuedReads: 2,
    maxBufferedBytes: maxSingleReadBytes,
    maxDecompressedBytes: 4 * 1024 * 1024,
    maxDecompressionRatio: 16,
    maxCacheBytes: 2 * 1024 * 1024,
  };
}

function telemetryJson(telemetry) {
  return {
    ...telemetry,
    requestedBytes: Number(telemetry.requestedBytes),
    completedBytes: Number(telemetry.completedBytes),
  };
}

function modeledReadMilliseconds(telemetry) {
  const throughputBytesPerMillisecond =
    (config.costModel.storageThroughputMiBPerSecond * 1024 * 1024) / 1000;
  return round(
    telemetry.readCalls * config.costModel.perReadOverheadMilliseconds +
      Number(telemetry.completedBytes) / throughputBytesPerMillisecond,
  );
}

async function sourceEvidence() {
  const { sourceBytes } = config.corpus;
  const maxSingleReadBytes = config.costModel.sequentialReadBytes;
  const indexedSource = new SyntheticRangeSource(sourceBytes);
  const indexed = new BoundedByteReader(
    indexedSource,
    new SourceEpochController(),
    workerLimits(sourceBytes, maxSingleReadBytes),
  );
  const indexedOffsets = [
    sourceBytes - 64,
    sourceBytes - 64 - 1024,
    1024 * 1024,
    2 * 1024 * 1024,
  ];
  for (const [index, length] of config.costModel.indexedReadLengths.entries()) {
    await indexed.read(BigInt(indexedOffsets[index]), BigInt(length));
  }
  const indexedTelemetry = indexed.snapshotTelemetry();

  const unindexedSource = new SyntheticRangeSource(sourceBytes);
  const unindexed = new BoundedByteReader(
    unindexedSource,
    new SourceEpochController(),
    workerLimits(sourceBytes, maxSingleReadBytes),
  );
  for (let offset = 0; offset < sourceBytes; offset += maxSingleReadBytes) {
    const length = Math.min(maxSingleReadBytes, sourceBytes - offset);
    await unindexed.read(BigInt(offset), BigInt(length));
  }
  const unindexedTelemetry = unindexed.snapshotTelemetry();

  return {
    indexedSeek: {
      operation: "indexed target-chunk range seek model",
      telemetry: telemetryJson(indexedTelemetry),
      rawRequests: indexedSource.requests,
      modeledMilliseconds: modeledReadMilliseconds(indexedTelemetry),
      boundedRangeProof:
        indexedSource.requests.every(({ length }) => length <= maxSingleReadBytes && length < sourceBytes) &&
        indexedTelemetry.completedBytes < BigInt(sourceBytes),
    },
    unindexedScan: {
      operation: "unindexed sequential degraded scan model",
      telemetry: telemetryJson(unindexedTelemetry),
      requestCount: unindexedSource.requests.length,
      firstRequest: unindexedSource.requests[0],
      lastRequest: unindexedSource.requests.at(-1),
      modeledMilliseconds: modeledReadMilliseconds(unindexedTelemetry),
      boundedRangeProof:
        unindexedSource.requests.every(({ length }) => length <= maxSingleReadBytes && length < sourceBytes) &&
        unindexedTelemetry.completedBytes === BigInt(sourceBytes) &&
        unindexedTelemetry.peakInFlightBytes <= maxSingleReadBytes,
    },
  };
}

function pointCloudMessage(pointCount) {
  const data = new Uint8Array(pointCount * 12);
  const view = new DataView(data.buffer);
  for (let index = 0; index < pointCount; index += 1) {
    const offset = index * 12;
    view.setFloat32(offset, index / 100, true);
    view.setFloat32(offset + 4, (index % 1000) / 10, true);
    view.setFloat32(offset + 8, (index % 31) / 31, true);
  }
  return {
    frameId: "lidar",
    width: pointCount,
    height: 1,
    pointStep: 12,
    rowStep: pointCount * 12,
    isBigEndian: false,
    fields: [
      { name: "x", offset: 0, datatype: 7, count: 1 },
      { name: "y", offset: 4, datatype: 7, count: 1 },
      { name: "z", offset: 8, datatype: 7, count: 1 },
    ],
    data,
  };
}

function pathMessage(poseCount) {
  return {
    frameId: "map",
    poses: Array.from({ length: poseCount }, (_, index) => ({
      position: { x: index / 10, y: Math.sin(index / 20), z: 0 },
    })),
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function nearestRank(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)];
}

function distribution(rawSamples) {
  return {
    p50Milliseconds: nearestRank(rawSamples, 50),
    p95Milliseconds: nearestRank(rawSamples, 95),
    p99Milliseconds: nearestRank(rawSamples, 99),
    maximumMilliseconds: Math.max(...rawSamples),
  };
}

function frameSamples(pointVertices, pathVertices) {
  return Array.from({ length: config.workload.repetitions }, (_, repetition) => {
    const deterministicJitter = ((repetition * 17) % 13) * 0.047;
    return round(1.4 + pointVertices * 0.00004 + pathVertices * 0.0002 + deterministicJitter);
  });
}

function renderEvidence(indexedSeek) {
  const gl = new MockWebGl2();
  const renderer = new WebGl2Renderer(
    { getContext: () => gl },
    {
      maxGpuBytes: 4 * 1024 * 1024,
      maxBufferBytes: 2 * 1024 * 1024,
      maxVerticesPerGeometry: config.workload.maxRenderedPoints,
      maxPooledBuffers: config.workload.activeDisplays,
    },
  );
  const pointCloud = new PointCloud2Display("cloud", renderer);
  pointCloud.configure({
    maxPoints: config.workload.maxRenderedPoints,
    maxInputBytes: config.workload.pointCount * 12,
  });
  pointCloud.attachSource(1);
  const pointSummary = pointCloud.update(pointCloudMessage(config.workload.pointCount), 1);
  pointCloud.render();

  const path = new PathDisplay("path", renderer);
  path.configure({
    maxPoses: config.workload.maxRenderedPathPoses,
    maxInputBytes: config.workload.pathPoseCount * 3 * Float64Array.BYTES_PER_ELEMENT,
  });
  path.attachSource(1);
  const pathSummary = path.update(pathMessage(config.workload.pathPoseCount), 1);
  path.render();

  const rendererBeforeDispose = renderer.telemetry();
  const rawFrameSamplesMilliseconds = frameSamples(pointSummary.renderedVertices, pathSummary.renderedVertices);
  const frameTime = distribution(rawFrameSamplesMilliseconds);
  const longTaskCount = rawFrameSamplesMilliseconds.filter(
    (value) => value > config.costModel.longTaskThresholdMilliseconds,
  ).length;
  const activeDecodedBytes =
    config.workload.pointCount * 12 +
    config.workload.pathPoseCount * 3 * Float64Array.BYTES_PER_ELEMENT;
  const gpuWorkingSetBytes = rendererBeforeDispose.liveGpuBytes + rendererBeforeDispose.pooledGpuBytes;
  const retainedJsBytes = activeDecodedBytes * 2 + config.costModel.fixedOverheadBytes;
  const workingSetBytes = activeDecodedBytes * 2 + gpuWorkingSetBytes + config.costModel.fixedOverheadBytes;
  const firstContentMilliseconds = round(
    indexedSeek.modeledMilliseconds +
      (config.workload.pointCount / 100_000) * config.costModel.decodeMillisecondsPer100kPoints +
      rawFrameSamplesMilliseconds[0],
  );
  const combinedTopicRate = config.workload.pointTopicRateHz + config.workload.pathTopicRateHz;
  const modeledRenderRateHz = 1000 / frameTime.p95Milliseconds;
  const maxQueueDepth = Math.min(config.workload.queueCapacity, Math.max(1, Math.ceil(combinedTopicRate / modeledRenderRateHz)));
  const droppedMessages = combinedTopicRate > modeledRenderRateHz * config.workload.queueCapacity ? 1 : 0;

  const semanticScenes = [pointSummary, pathSummary];
  const semanticDigest = createHash("sha256").update(JSON.stringify(semanticScenes)).digest("hex");
  const syntheticWrapperSamples = rawFrameSamplesMilliseconds.map((value) =>
    round(value + 0.8 + gpuWorkingSetBytes / (1024 * 1024) / 4),
  );

  pointCloud.dispose();
  path.dispose();
  renderer.dispose();

  return {
    semanticScenes,
    semanticDigest,
    thinWebGl2: {
      evidenceKind: "deterministic-operation-cost-model-with-mock-webgl2",
      hardwareMeasurement: false,
      firstContentMilliseconds,
      frameTime,
      rawFrameSamplesMilliseconds,
      longTaskThresholdMilliseconds: config.costModel.longTaskThresholdMilliseconds,
      longTaskCount,
      rendererTelemetryBeforeDispose: rendererBeforeDispose,
      rendererTelemetryAfterDispose: renderer.telemetry(),
      mockWebGlOperations: {
        bufferAllocations: gl.bufferAllocations,
        bufferUploads: gl.bufferUploads,
        drawCalls: gl.draws,
        createdBuffers: gl.createdBuffers,
        deletedBuffers: gl.deletedBuffers,
      },
      memoryEstimate: {
        formula: "2 × active decoded bytes + GPU working-set bytes + fixed overhead bytes",
        activeDecodedBytes,
        retainedJsBytes,
        retainedWasmBytes: 0,
        gpuWorkingSetBytes,
        fixedOverheadBytes: config.costModel.fixedOverheadBytes,
        workingSetBytes,
      },
      queue: {
        capacity: config.workload.queueCapacity,
        modeledMaximumDepth: maxQueueDepth,
        modeledDroppedMessagesPerSecond: droppedMessages,
      },
    },
    rejectedHeavyweightHelperBaseline: {
      evidenceKind: "synthetic-lower-bound-wrapper-model-not-a-library-measurement",
      libraryIdentity: null,
      installedOrExecutedLibrary: false,
      hardwareMeasurement: false,
      assumptions: [
        "one additional retained geometry copy",
        "one additional scene-wrapper boundary",
        "0.8 ms deterministic per-frame orchestration cost",
      ],
      frameTime: distribution(syntheticWrapperSamples),
      rawFrameSamplesMilliseconds: syntheticWrapperSamples,
      additionalRetainedJsBytes: gpuWorkingSetBytes,
    },
  };
}

const source = await sourceEvidence();
const render = renderEvidence(source.indexedSeek);
const artifact = {
  schemaVersion: 1,
  generatedBy: "benchmarks/scenarios/run-m1-dimensional.mjs",
  evidenceClassification: {
    kind: "deterministic-dimensional-and-operation-cost-model",
    productionHardwareResult: false,
    browserBenchmarkResult: false,
    disclaimer:
      "This artifact proves dimensions, bounded operations, semantic determinism, and model arithmetic. It is not a production browser or hardware performance result.",
  },
  scenario: config,
  source,
  render,
  rendererDecisionComparison: {
    thinWebGl2: {
      runtimeProductionDependencies: 0,
      resourceOwnership: "explicit allocation, pooling, telemetry, and disposal",
      semanticDisplayKinds: ["pointcloud2", "path"],
      measuredEvidence: "deterministic model and mock-WebGL2 operation trace above",
    },
    rejectedHeavyweightHelper: {
      runtimeProductionDependencies: "at least one if selected",
      resourceOwnership: "additional wrapper boundary in the synthetic lower-bound model",
      semanticDisplayKinds: "no additional M1 capability demonstrated",
      measuredEvidence: "no library result; only the explicitly labeled synthetic lower-bound model above",
    },
    conclusion:
      "Retain thin WebGL2 for M1 because it proves required semantics and bounded ownership without a production helper dependency. Do not claim library-level speed superiority from model evidence.",
  },
};

const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const existing = await readFile(artifactUrl, "utf8");
  if (existing !== serialized) throw new Error("M1 dimensional artifact is stale; regenerate it");
  console.log("M1 dimensional artifact is current");
} else {
  await mkdir(dirname(fileURLToPath(artifactUrl)), { recursive: true });
  await writeFile(artifactUrl, serialized, "utf8");
  console.log(`wrote ${fileURLToPath(artifactUrl)}`);
}
