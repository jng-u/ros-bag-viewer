import { McapWriter, type IWritable } from "@mcap/core";
import { describe, expect, it } from "vitest";

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

async function fixture(indexed: boolean): Promise<Uint8Array> {
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
    const messages = [];
    for await (const message of session.readIndexed({ startTime: 15n, endTime: 25n })) messages.push(message);
    expect(messages.map((message) => [message.sequence, [...message.data]])).toEqual([[1n, [4, 5, 6]]]);
    const telemetry = reader.snapshotTelemetry();
    expect(telemetry.readCalls).toBeGreaterThan(1);
    expect(telemetry.peakInFlightBytes).toBeLessThan(bytes.byteLength);
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
});
