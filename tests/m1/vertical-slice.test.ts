import { McapWriter, type IWritable } from "@mcap/core";
import { describe, expect, it } from "vitest";

import { ReferenceCountedPayloadLease, type SourceEpoch } from "../../packages/core-model/src/index.js";
import { PathDisplay, PointCloud2Display, type SemanticSceneSummary } from "../../packages/displays-core/src/index.js";
import {
  DEFAULT_SEMANTIC_DECODE_LIMITS,
  availableDisplaysForSchema,
  decodeRenderAndRelease,
  decodeSemanticMessage,
  type SemanticDecodeLimits,
} from "../../packages/m1-integration/src/index.js";
import { WebGl2Renderer, type CanvasContextSource } from "../../packages/render-core/src/index.js";
import { McapSourceSession, type McapMessage } from "../../packages/source-mcap/src/index.js";
import { BlobRangeSource, BoundedByteReader, SourceEpochController } from "../../packages/worker-runtime/src/index.js";

class CdrWriter {
  readonly #bytes = new Uint8Array(16 * 1024);
  readonly #view = new DataView(this.#bytes.buffer);
  readonly #origin = 4;
  #offset = 4;

  constructor() {
    this.#view.setUint16(0, 1, false);
    this.#view.setUint16(2, 0, false);
  }

  uint8(value: number): void {
    this.#view.setUint8(this.#offset++, value);
  }

  uint32(value: number): void {
    this.#align(4);
    this.#view.setUint32(this.#offset, value, true);
    this.#offset += 4;
  }

  int32(value: number): void {
    this.#align(4);
    this.#view.setInt32(this.#offset, value, true);
    this.#offset += 4;
  }

  float64(value: number): void {
    this.#align(8);
    this.#view.setFloat64(this.#offset, value, true);
    this.#offset += 8;
  }

  string(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.uint32(encoded.byteLength + 1);
    this.#bytes.set(encoded, this.#offset);
    this.#offset += encoded.byteLength;
    this.uint8(0);
  }

  byteSequence(value: Uint8Array): void {
    this.uint32(value.byteLength);
    this.#bytes.set(value, this.#offset);
    this.#offset += value.byteLength;
  }

  header(frameId: string): void {
    this.int32(1);
    this.uint32(2);
    this.string(frameId);
  }

  finish(): Uint8Array {
    return this.#bytes.slice(0, this.#offset);
  }

  #align(alignment: number): void {
    const relative = this.#offset - this.#origin;
    this.#offset += (alignment - (relative % alignment)) % alignment;
  }
}

function pointCloudCdr(): Uint8Array {
  const writer = new CdrWriter();
  writer.header("lidar");
  writer.uint32(1);
  writer.uint32(3);
  writer.uint32(3);
  for (const [name, offset] of [["x", 0], ["y", 4], ["z", 8]] as const) {
    writer.string(name);
    writer.uint32(offset);
    writer.uint8(7);
    writer.uint32(1);
  }
  writer.uint8(0);
  writer.uint32(12);
  writer.uint32(36);
  const points = new Uint8Array(36);
  const view = new DataView(points.buffer);
  [[0, 0, 0], [1, 2, 3], [4, 5, 6]].forEach((point, index) =>
    point.forEach((value, axis) => view.setFloat32(index * 12 + axis * 4, value, true)),
  );
  writer.byteSequence(points);
  writer.uint8(1);
  return writer.finish();
}

function pathCdr(): Uint8Array {
  const writer = new CdrWriter();
  writer.header("map");
  writer.uint32(3);
  for (const x of [0, 2, 4]) {
    writer.header("map");
    writer.float64(x);
    writer.float64(x + 1);
    writer.float64(0);
    writer.float64(0);
    writer.float64(0);
    writer.float64(0);
    writer.float64(1);
  }
  return writer.finish();
}

class FixtureWritable implements IWritable {
  readonly #chunks: Uint8Array[] = [];
  #position = 0n;

  async write(buffer: Uint8Array): Promise<void> {
    this.#chunks.push(buffer.slice());
    this.#position += BigInt(buffer.byteLength);
  }

  position(): bigint {
    return this.#position;
  }

  bytes(): Uint8Array {
    const output = new Uint8Array(Number(this.#position));
    let offset = 0;
    for (const chunk of this.#chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}

async function mcapFixture(indexed: boolean): Promise<Uint8Array> {
  const writable = new FixtureWritable();
  const writer = new McapWriter({
    writable,
    useChunks: indexed,
    useStatistics: indexed,
    useSummaryOffsets: indexed,
    repeatSchemas: indexed,
    repeatChannels: indexed,
    useMessageIndex: indexed,
    useChunkIndex: indexed,
    chunkSize: 128,
  });
  await writer.start({ profile: "ros2", library: "m1-vertical-slice-fixture" });
  for (const [topic, name, data] of [
    ["/points", "sensor_msgs/msg/PointCloud2", pointCloudCdr()],
    ["/path", "nav_msgs/msg/Path", pathCdr()],
  ] as const) {
    const schemaId = await writer.registerSchema({ name, encoding: "ros2msg", data: new TextEncoder().encode(name) });
    const channelId = await writer.registerChannel({ schemaId, topic, messageEncoding: "cdr", metadata: new Map() });
    await writer.addMessage({ channelId, sequence: 0, logTime: 10n, publishTime: 9n, data });
  }
  await writer.end();
  return writable.bytes();
}

class MockWebGl2 {
  readonly ARRAY_BUFFER = 0x8892;
  readonly DYNAMIC_DRAW = 0x88e8;
  readonly FLOAT = 0x1406;
  readonly VERTEX_SHADER = 0x8b31;
  readonly FRAGMENT_SHADER = 0x8b30;
  readonly COMPILE_STATUS = 0x8b81;
  readonly LINK_STATUS = 0x8b82;
  readonly POINTS = 0;
  readonly LINES = 1;
  readonly LINE_STRIP = 3;
  readonly draws: Array<{ mode: number; count: number }> = [];
  createBuffer(): WebGLBuffer { return {} as WebGLBuffer; }
  deleteBuffer(): void {}
  bindBuffer(): void {}
  bufferData(): void {}
  bufferSubData(): void {}
  createShader(): WebGLShader { return {} as WebGLShader; }
  shaderSource(): void {}
  compileShader(): void {}
  getShaderParameter(): boolean { return true; }
  getShaderInfoLog(): null { return null; }
  deleteShader(): void {}
  createProgram(): WebGLProgram { return {} as WebGLProgram; }
  attachShader(): void {}
  linkProgram(): void {}
  getProgramParameter(): boolean { return true; }
  getProgramInfoLog(): null { return null; }
  deleteProgram(): void {}
  getAttribLocation(): number { return 0; }
  getUniformLocation(): WebGLUniformLocation { return {} as WebGLUniformLocation; }
  useProgram(): void {}
  enableVertexAttribArray(): void {}
  vertexAttribPointer(): void {}
  uniformMatrix4fv(): void {}
  uniform4fv(): void {}
  drawArrays(mode: number, _first: number, count: number): void { this.draws.push({ mode, count }); }
}

async function sourceMessages(indexed: boolean): Promise<{
  readonly messages: McapMessage[];
  readonly peakInFlightBytes: number;
  readonly sourceBytes: number;
}> {
  const bytes = await mcapFixture(indexed);
  const blobBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const reader = new BoundedByteReader(
    new BlobRangeSource(new Blob([blobBytes])),
    new SourceEpochController(),
    {
      maxSingleReadBytes: 1024,
      maxTotalReadBytes: 64n * 1024n,
      maxConcurrentReads: 2,
      maxQueuedReads: 4,
      maxBufferedBytes: 2048,
      maxDecompressedBytes: 4096,
      maxDecompressionRatio: 16,
      maxCacheBytes: 1024,
    },
  );
  const session = await McapSourceSession.open(reader, {
    limits: {
      sequentialReadBytes: 128,
      maxBufferedBytes: 2048,
      maxDecompressedBytes: 4096,
      maxDecompressionRatio: 16,
      maxMessageIndexCacheBytes: 256,
    },
  });
  expect(session.mode).toBe(indexed ? "indexed" : "unindexed-degraded");
  const messages: McapMessage[] = [];
  if (indexed) {
    for await (const message of session.readIndexed()) messages.push(message);
  } else {
    for await (const event of session.scanUnindexed()) if (event.kind === "message") messages.push(event.message);
  }
  return { messages, peakInFlightBytes: reader.snapshotTelemetry().peakInFlightBytes, sourceBytes: bytes.byteLength };
}

describe("complete M1 MCAP vertical slice", () => {
  it("renders the same PointCloud2 and Path scenes from indexed and unindexed bounded sessions", async () => {
    const modeSummaries: SemanticSceneSummary[][] = [];
    for (const indexed of [true, false]) {
      const source = await sourceMessages(indexed);
      expect(source.messages).toHaveLength(2);
      expect(source.peakInFlightBytes).toBeLessThan(source.sourceBytes);
      const gl = new MockWebGl2();
      const renderer = new WebGl2Renderer({ getContext: () => gl } satisfies CanvasContextSource, {
        maxGpuBytes: 4096,
        maxBufferBytes: 1024,
        maxVerticesPerGeometry: 64,
        maxPooledBuffers: 2,
      });
      const summaries: SemanticSceneSummary[] = [];
      for (const message of source.messages) {
        const decoded = decodeSemanticMessage(message);
        const display = decoded.kind === "pointcloud2"
          ? new PointCloud2Display("cloud", renderer)
          : new PathDisplay("path", renderer);
        if (display.kind === "pointcloud2") display.configure({ maxPoints: 16, maxInputBytes: 1024 });
        else display.configure({ maxPoses: 16, maxInputBytes: 1024 });
        display.attachSource(1);
        const lease = new ReferenceCountedPayloadLease(1 as SourceEpoch, message.data.byteLength);
        summaries.push(decodeRenderAndRelease(message, 1, lease, display) as SemanticSceneSummary);
        expect(lease.released).toBe(true);
        display.dispose();
      }
      expect(gl.draws).toEqual([{ mode: gl.POINTS, count: 3 }, { mode: gl.LINE_STRIP, count: 3 }]);
      renderer.dispose();
      expect(renderer.telemetry()).toMatchObject({ liveGpuBytes: 0, pooledGpuBytes: 0, drawCalls: 2 });
      modeSummaries.push(summaries);
    }
    expect(modeSummaries[0]).toEqual(modeSummaries[1]);
    expect(modeSummaries[0]).toMatchObject([
      { displayKind: "pointcloud2", frameId: "lidar", renderedVertices: 3 },
      { displayKind: "path", frameId: "map", renderedVertices: 3 },
    ]);
  });

  it("maps only supported schemas into truthful shell display choices and fails bounded", () => {
    expect(availableDisplaysForSchema("sensor_msgs/msg/PointCloud2")).toEqual(["point-cloud", "raw"]);
    expect(availableDisplaysForSchema("nav_msgs/msg/Path")).toEqual(["path", "raw"]);
    expect(availableDisplaysForSchema("vendor_msgs/msg/Unknown")).toEqual(["raw"]);
    expect(availableDisplaysForSchema("vendor_msgs/msg/Unknown", "opaque")).toEqual([]);
    const oversized = { channel: { schema: { name: "nav_msgs/msg/Path", capability: "schema-present" as const } }, data: pathCdr() };
    expect(() => decodeSemanticMessage(oversized, {
      maxMessageBytes: 16 * 1024,
      maxStringBytes: 64,
      maxPointFields: 8,
      maxPointDataBytes: 1024,
      maxPoints: 16,
      maxPathPoses: 2,
    })).toThrow(/pose count exceeds limits/);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
    ["zero", 0],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects %s semantic limits before reading allocation counts", (_label, invalid) => {
    const input = {
      channel: { schema: { name: "nav_msgs/msg/Path", capability: "schema-present" as const } },
      data: pathCdr(),
    };
    for (const field of Object.keys(DEFAULT_SEMANTIC_DECODE_LIMITS) as Array<keyof typeof DEFAULT_SEMANTIC_DECODE_LIMITS>) {
      expect(() => decodeSemanticMessage(input, { ...DEFAULT_SEMANTIC_DECODE_LIMITS, [field]: invalid })).toThrow(
        new RegExp(`${field} must be a positive safe integer`),
      );
    }
  });

  it("rejects incoherent nested byte limits before decoding", () => {
    const input = {
      channel: { schema: { name: "nav_msgs/msg/Path", capability: "schema-present" as const } },
      data: pathCdr(),
    };
    expect(() => decodeSemanticMessage(input, {
      ...DEFAULT_SEMANTIC_DECODE_LIMITS,
      maxMessageBytes: 64,
      maxPointDataBytes: 65,
      maxStringBytes: 32,
    })).toThrow(/maxPointDataBytes cannot exceed maxMessageBytes/);
    expect(() => decodeSemanticMessage(input, {
      ...DEFAULT_SEMANTIC_DECODE_LIMITS,
      maxMessageBytes: 64,
      maxPointDataBytes: 32,
      maxStringBytes: 65,
    })).toThrow(/maxStringBytes cannot exceed maxMessageBytes/);
  });

  it("rejects missing fields and caller limits above hard allocation ceilings", () => {
    const input = {
      channel: { schema: { name: "nav_msgs/msg/Path", capability: "schema-present" as const } },
      data: pathCdr(),
    };
    const missing: Record<string, number> = { ...DEFAULT_SEMANTIC_DECODE_LIMITS };
    delete missing["maxPathPoses"];
    expect(() => decodeSemanticMessage(input, missing as unknown as SemanticDecodeLimits)).toThrow(
      /maxPathPoses must be a positive safe integer/,
    );
    for (const field of Object.keys(DEFAULT_SEMANTIC_DECODE_LIMITS) as Array<keyof SemanticDecodeLimits>) {
      expect(() => decodeSemanticMessage(input, {
        ...DEFAULT_SEMANTIC_DECODE_LIMITS,
        [field]: DEFAULT_SEMANTIC_DECODE_LIMITS[field] + 1,
      })).toThrow(new RegExp(`${field} cannot exceed the hard semantic decode limit`));
    }
  });
});
