import { McapWriter, type IWritable } from "@mcap/core";
import { describe, expect, it } from "vitest";

import { emitV1SemanticEvent } from "../../../tests/support/v1-conformance-event.js";
import { BlobRangeSource, BoundedByteReader, SourceEpochController, type WorkerResourceLimits } from "../../worker-runtime/src/index.js";
import { McapSourceSession } from "../src/index.js";

class FixtureWritable implements IWritable {
  readonly chunks: Uint8Array[] = [];
  #position = 0n;

  async write(buffer: Uint8Array): Promise<void> {
    this.chunks.push(buffer.slice());
    this.#position += BigInt(buffer.byteLength);
  }

  position(): bigint {
    return this.#position;
  }

  bytes(): Uint8Array {
    const output = new Uint8Array(Number(this.#position));
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}

async function fixture(indexed: boolean, compressed = false): Promise<Uint8Array> {
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
    chunkSize: 32,
    ...(compressed ? { compressChunk: (chunkData: Uint8Array) => ({ compression: "test", compressedData: chunkData }) } : {}),
  });
  await writer.start({ profile: "ros2", library: "ros-web-viewer deterministic fixture" });
  const schemaId = await writer.registerSchema({
    name: "example_msgs/msg/Point",
    encoding: "ros2msg",
    data: new TextEncoder().encode("float64 x\n"),
  });
  const channelId = await writer.registerChannel({
    schemaId,
    topic: "/points",
    messageEncoding: "cdr",
    metadata: new Map(),
  });
  await writer.addMessage({ channelId, sequence: 0, logTime: 10n, publishTime: 9n, data: Uint8Array.of(1, 2, 3) });
  await writer.addMessage({ channelId, sequence: 1, logTime: 20n, publishTime: 19n, data: Uint8Array.of(4, 5, 6) });
  await writer.end();
  return writable.bytes();
}

function boundedReader(bytes: Uint8Array): BoundedByteReader {
  const limits: WorkerResourceLimits = {
    maxSingleReadBytes: 1024,
    maxTotalReadBytes: 64n * 1024n,
    maxConcurrentReads: 2,
    maxQueuedReads: 4,
    maxBufferedBytes: 2048,
    maxDecompressedBytes: 4096,
    maxDecompressionRatio: 16,
    maxCacheBytes: 2048,
  };
  const blobBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new BoundedByteReader(new BlobRangeSource(new Blob([blobBytes])), new SourceEpochController(), limits);
}

describe("MCAP adapter", () => {
  it("uses bounded official-reader range seeks for indexed MCAP", async () => {
    const bytes = await fixture(true);
    const reader = boundedReader(bytes);
    const session = await McapSourceSession.open(reader, {
      limits: {
        sequentialReadBytes: 64,
        maxBufferedBytes: 2048,
        maxDecompressedBytes: 4096,
        maxDecompressionRatio: 16,
        maxMessageIndexCacheBytes: 256,
      },
    });

    expect(session.mode).toBe("indexed");
    expect(session.channels()).toMatchObject([
      { topic: "/points", schema: { capability: "schema-present", name: "example_msgs/msg/Point" } },
    ]);
    expect(session.timeRange()).toEqual({ startTimeNanos: 10n, endTimeNanos: 20n });
    const messages = [];
    for await (const message of session.readIndexed({ startTime: 15n, endTime: 25n })) messages.push(message);
    expect(messages.map((message) => [message.sequence, [...message.data]])).toEqual([[1n, [4, 5, 6]]]);
    const latest = [];
    for await (const message of session.readIndexed({ endTime: 20n, reverse: true })) latest.push(message);
    expect(latest.map((message) => message.sequence)).toEqual([1n, 0n]);
    const telemetry = reader.snapshotTelemetry();
    expect(telemetry.readCalls).toBeGreaterThan(1);
    expect(telemetry.peakInFlightBytes).toBeLessThan(bytes.byteLength);
    emitV1SemanticEvent({ schemaVersion: 1, domain: "source", result: "pass", code: "local-mcap-indexed", facts: {
      mode: session.mode, messages: messages.length, readCalls: telemetry.readCalls,
    } });
  });

  it("exposes embedded schema bytes as schema-present", async () => {
    const bytes = await fixture(true);
    const session = await McapSourceSession.open(boundedReader(bytes), {
      limits: {
        sequentialReadBytes: 64,
        maxBufferedBytes: 2048,
        maxDecompressedBytes: 4096,
        maxDecompressionRatio: 16,
        maxMessageIndexCacheBytes: 256,
      },
    });
    const schema = session.channels()[0]?.schema;
    expect(schema).toMatchObject({
      capability: "schema-present",
      name: "example_msgs/msg/Point",
      encoding: "ros2msg",
    });
    expect(schema?.data).toEqual(new TextEncoder().encode("float64 x\n"));
    emitV1SemanticEvent({ schemaVersion: 1, domain: "schema", result: "pass", code: "schema-present", facts: {
      capability: schema?.capability ?? "missing", schemaBytes: schema?.data?.byteLength ?? 0,
    } });
  });

  it("exposes explicit degraded sequential progress for unindexed MCAP", async () => {
    const bytes = await fixture(false);
    const reader = boundedReader(bytes);
    const session = await McapSourceSession.open(reader, {
      limits: {
        sequentialReadBytes: 32,
        maxBufferedBytes: 1024,
        maxDecompressedBytes: 4096,
        maxDecompressionRatio: 16,
        maxMessageIndexCacheBytes: 0,
      },
    });

    expect(session.mode).toBe("unindexed-degraded");
    expect(session.diagnostic).toMatch(/sequential degraded/);
    await expect(session.readIndexed().next()).rejects.toThrow(/random seek is unavailable/);
    const events = [];
    for await (const event of session.scanUnindexed()) events.push(event);
    expect(events.filter((event) => event.kind === "message")).toHaveLength(2);
    const progress = events.filter((event) => event.kind === "progress").map((event) => event.progress);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
    expect(session.telemetry()).toMatchObject({ mode: "unindexed-degraded", messagesRead: 2, scanProgress: 1 });
    expect(reader.snapshotTelemetry().peakInFlightBytes).toBeLessThan(bytes.byteLength);
  });

  it("propagates corrupt indexed summaries instead of misclassifying them as unindexed", async () => {
    const bytes = await fixture(true);
    const footerLength = 37;
    const footerCrcOffset = bytes.byteLength - footerLength + 25;
    bytes[footerCrcOffset] = (bytes[footerCrcOffset] ?? 0) ^ 1;
    await expect(McapSourceSession.open(boundedReader(bytes))).rejects.toThrow(/indexed initialization failed.*summary CRC/);
  });

  it("supports bounded compressed chunks without a lifetime-work kill switch", async () => {
    const bytes = await fixture(true, true);
    const session = await McapSourceSession.open(boundedReader(bytes), {
      limits: {
        sequentialReadBytes: 64,
        maxBufferedBytes: 2048,
        maxDecompressedBytes: 256,
        maxDecompressionRatio: 16,
        maxMessageIndexCacheBytes: 256,
      },
      decompressors: { test: (buffer) => buffer },
    });
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const messages = [];
      for await (const message of session.readIndexed()) messages.push(message);
      expect(messages).toHaveLength(2);
    }
    expect(session.telemetry().decompressedBytes).toBeGreaterThan(256);
  });
});
