import { describe, expect, it } from "vitest";

import {
  BlobRangeSource,
  BoundedByteReader,
  SourceEpochController,
  type WorkerResourceLimits,
} from "../../worker-runtime/src/index.js";
import {
  DEFAULT_ROS1_BAG_LIMITS,
  Ros1BagDiagnosticError,
  Ros1BagSourceSession,
  type Ros1SourceBundle,
} from "../src/index.js";

const encoder = new TextEncoder();

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function u8(value: number): Uint8Array {
  return Uint8Array.of(value);
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function time(nanos: bigint): Uint8Array {
  const seconds = nanos / 1_000_000_000n;
  const remainder = nanos % 1_000_000_000n;
  return concat(u32(Number(seconds)), u32(Number(remainder)));
}

function field(name: string, value: Uint8Array | string): Uint8Array {
  const encoded = concat(encoder.encode(`${name}=`), typeof value === "string" ? encoder.encode(value) : value);
  return concat(u32(encoded.byteLength), encoded);
}

function header(fields: readonly [string, Uint8Array | string][]): Uint8Array {
  return concat(...fields.map(([name, value]) => field(name, value)));
}

function record(fields: readonly [string, Uint8Array | string][], data: Uint8Array = new Uint8Array()): Uint8Array {
  const encodedHeader = header(fields);
  return concat(u32(encodedHeader.byteLength), encodedHeader, u32(data.byteLength), data);
}

function fixture(options: { indexed?: boolean; compression?: string } = {}): Uint8Array {
  const indexed = options.indexed ?? true;
  const compression = options.compression ?? "none";
  const connectionData = header([
    ["topic", "/points"],
    ["type", "example_msgs/Point"],
    ["md5sum", "4a842b65f413084dc2b10fb484ea7f17"],
    ["message_definition", "float64 x\nfloat64 y\nfloat64 z\n"],
    ["callerid", "/fixture_writer"],
    ["latching", "0"],
  ]);
  const connection = record(
    [
      ["op", u8(0x07)],
      ["conn", u32(0)],
      ["topic", "/points"],
    ],
    connectionData,
  );
  const message0 = record(
    [
      ["op", u8(0x02)],
      ["conn", u32(0)],
      ["time", time(1_000_000_010n)],
    ],
    Uint8Array.of(1, 2, 3),
  );
  const message1 = record(
    [
      ["op", u8(0x02)],
      ["conn", u32(0)],
      ["time", time(2_000_000_020n)],
    ],
    Uint8Array.of(4, 5, 6),
  );
  const message0Offset = connection.byteLength;
  const message1Offset = connection.byteLength + message0.byteLength;
  const chunkData = concat(connection, message0, message1);
  const chunk = record(
    [
      ["op", u8(0x05)],
      ["compression", compression],
      ["size", u32(chunkData.byteLength)],
    ],
    chunkData,
  );
  const index = record(
    [
      ["op", u8(0x04)],
      ["ver", u32(1)],
      ["conn", u32(0)],
      ["count", u32(2)],
    ],
    concat(time(1_000_000_010n), u32(message0Offset), time(2_000_000_020n), u32(message1Offset)),
  );
  const magic = encoder.encode("#ROSBAG V2.0\n");
  const fileHeaderData = new Uint8Array(4096);
  const provisionalHeader = record(
    [
      ["op", u8(0x03)],
      ["index_pos", u64(0n)],
      ["conn_count", u32(1)],
      ["chunk_count", u32(1)],
    ],
    fileHeaderData,
  );
  const chunkPosition = BigInt(magic.byteLength + provisionalHeader.byteLength);
  const dataSection = indexed ? concat(chunk, index) : chunk;
  const indexPosition = indexed ? BigInt(magic.byteLength + provisionalHeader.byteLength + dataSection.byteLength) : 0n;
  const fileHeader = record(
    [
      ["op", u8(0x03)],
      ["index_pos", u64(indexPosition)],
      ["conn_count", u32(1)],
      ["chunk_count", u32(1)],
    ],
    fileHeaderData,
  );
  if (!indexed) return concat(magic, fileHeader, dataSection);
  const chunkInfo = record(
    [
      ["op", u8(0x06)],
      ["ver", u32(1)],
      ["chunk_pos", u64(chunkPosition)],
      ["start_time", time(1_000_000_010n)],
      ["end_time", time(2_000_000_020n)],
      ["count", u32(1)],
    ],
    concat(u32(0), u32(2)),
  );
  return concat(magic, fileHeader, dataSection, connection, chunkInfo);
}

function boundedReader(bytes: Uint8Array, epoch = new SourceEpochController()): BoundedByteReader {
  const limits: WorkerResourceLimits = {
    maxSingleReadBytes: 2048,
    maxTotalReadBytes: 256n * 1024n,
    maxConcurrentReads: 2,
    maxQueuedReads: 8,
    maxBufferedBytes: 4096,
    maxDecompressedBytes: 16 * 1024,
    maxDecompressionRatio: 32,
    maxCacheBytes: 4096,
  };
  const blobBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new BoundedByteReader(new BlobRangeSource(new Blob([blobBytes])), epoch, limits);
}

describe("ROS1 bag SourceBundle adapter", () => {
  it("uses bounded v2 header/index/chunk/message traversal with schema provenance", async () => {
    const bytes = fixture();
    const epoch = new SourceEpochController();
    const reader = boundedReader(bytes, epoch);
    const entry = {
      entryId: "bag-0",
      relativePath: "recordings/small.bag",
      sizeBytes: BigInt(bytes.byteLength),
      immutableVersion: "sha256:fixture",
    };
    const bundle: Ros1SourceBundle = { bundleId: "fixture", version: 1, entries: [entry] };
    const session = await Ros1BagSourceSession.openBundle(bundle, () => reader, epoch);

    expect(session.mode).toBe("indexed");
    expect(session.channels()).toMatchObject([
      {
        id: 0,
        topic: "/points",
        typeName: "example_msgs/Point",
        schema: {
          capability: "schema-present",
          provenance: [{ providerId: "ros1-connection-definition", providerVersion: "1", sourceEntryId: "bag-0" }],
        },
      },
    ]);
    expect(session.channels()[0]!.schema.provenance[0]!.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(session.timeRange()).toEqual({ startTimeNanos: 1_000_000_010n, endTimeNanos: 2_000_000_020n });

    const messages = [];
    for await (const message of session.readIndexed({ startTime: 1_500_000_000n })) messages.push(message);
    expect(messages.map((message) => [message.sequence, message.timeNanos, [...message.data]])).toEqual([
      [0n, 2_000_000_020n, [4, 5, 6]],
    ]);
    expect(reader.snapshotTelemetry()).toMatchObject({ peakInFlightBytes: expect.any(Number) });
    expect(reader.snapshotTelemetry().readCalls).toBeGreaterThan(8);
    expect(reader.snapshotTelemetry().peakInFlightBytes).toBeLessThan(bytes.byteLength);
    expect(session.telemetry()).toMatchObject({ mode: "indexed", messagesRead: 1 });
  });

  it("exposes explicit sequential degraded behavior for an unfinalized bag", async () => {
    const bytes = fixture({ indexed: false });
    const session = await Ros1BagSourceSession.open(boundedReader(bytes));

    expect(session.mode).toBe("unindexed-degraded");
    expect(session.diagnostic).toMatch(/sequential degraded/);
    await expect(session.readIndexed().next()).rejects.toThrow(/random seek is unavailable/);
    const events = [];
    for await (const event of session.scanUnindexed()) events.push(event);
    const messages = events.filter((event) => event.kind === "message").map((event) => event.message);
    expect(messages.map((message) => [message.timeNanos, [...message.data]])).toEqual([
      [1_000_000_010n, [1, 2, 3]],
      [2_000_000_020n, [4, 5, 6]],
    ]);
    const progress = events.filter((event) => event.kind === "progress").map((event) => event.progress);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
    expect(session.channels()).toHaveLength(1);
  });

  it.each(["bz2", "lz4", "zstd"])("fails closed with an explicit unsupported %s codec diagnostic", async (codec) => {
    const session = await Ros1BagSourceSession.open(boundedReader(fixture({ compression: codec })));

    expect(session.diagnostics()).toEqual([expect.stringContaining(`codec "${codec}"`)]);
    await expect(session.readIndexed().next()).rejects.toMatchObject({
      code: "unsupported-codec",
      detail: codec,
      message: expect.stringContaining(codec),
    });
  });

  it("rejects corrupt, truncated, oversized, and multipart inputs deterministically", async () => {
    const bytes = fixture();
    const corrupt = bytes.slice();
    corrupt[0] = 0;
    await expect(Ros1BagSourceSession.open(boundedReader(corrupt))).rejects.toMatchObject({ code: "corrupt-bag" });
    await expect(Ros1BagSourceSession.open(boundedReader(bytes.subarray(0, bytes.byteLength - 1)))).rejects.toMatchObject({
      code: "corrupt-bag",
    });
    await expect(
      Ros1BagSourceSession.open(boundedReader(bytes), undefined, {
        limits: { ...DEFAULT_ROS1_BAG_LIMITS, maxHeaderBytes: 16 },
      }),
    ).rejects.toMatchObject({ code: "resource-limit" });
    const entries = ["one.bag", "two.bag"].map((relativePath, index) => ({
      entryId: `bag-${index}`,
      relativePath,
      sizeBytes: BigInt(bytes.byteLength),
      immutableVersion: `fixture-${index}`,
    }));
    await expect(
      Ros1BagSourceSession.openBundle({ bundleId: "multipart", version: 1, entries }, () => boundedReader(bytes)),
    ).rejects.toMatchObject({ code: "unsupported-codec", detail: "multipart" });
  });

  it("invalidates stale reads on seek, replacement, and close epochs", async () => {
    const epoch = new SourceEpochController();
    const session = await Ros1BagSourceSession.open(boundedReader(fixture(), epoch), epoch);
    expect(epoch.epoch).toBe(1);
    const seek = session.readIndexed({ endTime: 1_500_000_000n });
    expect((await seek.next()).done).toBe(false);
    expect((await seek.next()).done).toBe(true);
    expect(epoch.epoch).toBe(2);
    epoch.advance("source replaced");
    expect(() => session.channels()).toThrowError(Ros1BagDiagnosticError);
    const replacement = await Ros1BagSourceSession.open(boundedReader(fixture(), epoch), epoch);
    replacement.close();
    expect(() => replacement.channels()).toThrow(/stale source epoch/);
  });
});
