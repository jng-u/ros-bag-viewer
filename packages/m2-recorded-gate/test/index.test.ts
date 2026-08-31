import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  NumericPlotDisplay,
  RawInspectorDisplay,
  createDefaultDisplayRegistry,
  extractNumericValue,
  inspectRawMessage,
} from "../../displays-core/src/index.js";
import {
  Ros1BagSourceSession,
  type Ros1SourceBundle,
} from "../../source-ros1bag/src/index.js";
import {
  Ros2SqliteSourceSession,
  parseRos2MetadataYaml,
  type Ros2BundleAccess,
  type Ros2SourceBundle,
  type SourceEpochPort,
  type SqliteEntryContext,
  type SqliteQueryProvider,
  type SqliteReadonlyDatabase,
  type SqliteRow,
  type SqliteValue,
} from "../../source-ros2-sqlite/src/index.js";
import { TfBuffer } from "../../tf/src/index.js";
import {
  BlobRangeSource,
  BoundedByteReader,
  GrantedRangeSource,
  SourceEpochController,
  type RangeSource,
  type WorkerResourceLimits,
} from "../../worker-runtime/src/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const workerLimits: WorkerResourceLimits = {
  maxSingleReadBytes: 8 * 1024,
  maxTotalReadBytes: 2n * 1024n * 1024n,
  maxConcurrentReads: 2,
  maxQueuedReads: 8,
  maxBufferedBytes: 16 * 1024,
  maxDecompressedBytes: 64 * 1024,
  maxDecompressionRatio: 32,
  maxCacheBytes: 16 * 1024,
};

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
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
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, true);
  return output;
}

function u64(value: bigint): Uint8Array {
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, value, true);
  return output;
}

function rosTime(nanos: bigint): Uint8Array {
  return concat(u32(Number(nanos / 1_000_000_000n)), u32(Number(nanos % 1_000_000_000n)));
}

function bagField(name: string, value: Uint8Array | string): Uint8Array {
  const encoded = concat(encoder.encode(`${name}=`), typeof value === "string" ? encoder.encode(value) : value);
  return concat(u32(encoded.byteLength), encoded);
}

function bagHeader(fields: readonly [string, Uint8Array | string][]): Uint8Array {
  return concat(...fields.map(([name, value]) => bagField(name, value)));
}

function bagRecord(fields: readonly [string, Uint8Array | string][], data: Uint8Array = new Uint8Array()): Uint8Array {
  const header = bagHeader(fields);
  return concat(u32(header.byteLength), header, u32(data.byteLength), data);
}

function ros1Fixture(compression = "none"): Uint8Array {
  const connectionData = bagHeader([
    ["topic", "/value"],
    ["type", "example_msgs/Value"],
    ["md5sum", "d2775f0551a4547ff5e490e1009d7d4c"],
    ["message_definition", "uint8 value\n"],
  ]);
  const connection = bagRecord([["op", u8(0x07)], ["conn", u32(0)], ["topic", "/value"]], connectionData);
  const first = bagRecord([["op", u8(0x02)], ["conn", u32(0)], ["time", rosTime(10n)]], Uint8Array.of(10));
  const second = bagRecord([["op", u8(0x02)], ["conn", u32(0)], ["time", rosTime(20n)]], Uint8Array.of(20));
  const chunkData = concat(connection, first, second);
  const chunk = bagRecord(
    [["op", u8(0x05)], ["compression", compression], ["size", u32(chunkData.byteLength)]],
    chunkData,
  );
  const index = bagRecord(
    [["op", u8(0x04)], ["ver", u32(1)], ["conn", u32(0)], ["count", u32(2)]],
    concat(rosTime(10n), u32(connection.byteLength), rosTime(20n), u32(connection.byteLength + first.byteLength)),
  );
  const magic = encoder.encode("#ROSBAG V2.0\n");
  const padding = new Uint8Array(4096);
  const provisional = bagRecord(
    [["op", u8(0x03)], ["index_pos", u64(0n)], ["conn_count", u32(1)], ["chunk_count", u32(1)]],
    padding,
  );
  const chunkPosition = BigInt(magic.byteLength + provisional.byteLength);
  const indexPosition = BigInt(magic.byteLength + provisional.byteLength + chunk.byteLength + index.byteLength);
  const header = bagRecord(
    [["op", u8(0x03)], ["index_pos", u64(indexPosition)], ["conn_count", u32(1)], ["chunk_count", u32(1)]],
    padding,
  );
  const chunkInfo = bagRecord(
    [
      ["op", u8(0x06)],
      ["ver", u32(1)],
      ["chunk_pos", u64(chunkPosition)],
      ["start_time", rosTime(10n)],
      ["end_time", rosTime(20n)],
      ["count", u32(1)],
    ],
    concat(u32(0), u32(2)),
  );
  return concat(magic, header, chunk, index, connection, chunkInfo);
}

interface RangeEvidence {
  calls: number;
  maxBytes: number;
  totalBytes: number;
}

function exactBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function rangeSource(bytes: Uint8Array, mode: "local" | "granted", evidence: RangeEvidence): RangeSource {
  if (mode === "local") return new BlobRangeSource(new Blob([exactBytes(bytes)]));
  return new GrantedRangeSource(BigInt(bytes.byteLength), "sha256:fixture", async (range, signal) => {
    if (signal.aborted) throw new Error("granted range aborted");
    const offset = Number(range.offset);
    const length = Number(range.length);
    evidence.calls += 1;
    evidence.maxBytes = Math.max(evidence.maxBytes, length);
    evidence.totalBytes += length;
    return bytes.slice(offset, offset + length);
  });
}

function rawAndNumeric(data: Uint8Array) {
  const value = { value: data[0] };
  const rawDisplay = new RawInspectorDisplay("raw-equivalence");
  rawDisplay.configure({ maxInputBytes: 64, maxDepth: 4, maxFields: 8, maxArrayLength: 8, maxStringBytes: 32, maxPreviewBytes: 8 });
  rawDisplay.attachSource(1);
  const numericDisplay = new NumericPlotDisplay("numeric-equivalence");
  numericDisplay.configure({ fieldPath: "value", maxSamples: 4, maxInputBytes: 64 });
  numericDisplay.attachSource(1);
  return {
    raw: rawDisplay.update({ typeName: "example_msgs/Value", schemaCapability: "schema-present", value }, 1),
    numeric: numericDisplay.update({ timestampNanos: 0n, value }, 1),
  };
}

function tfSummary() {
  const tf = new TfBuffer(1, 4);
  tf.add({
    parentFrame: "map",
    childFrame: "sensor",
    timeNanos: 0n,
    isStatic: true,
    epoch: 1,
    translation: { x: 1, y: 2, z: 3 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  });
  return tf.lookup("map", "sensor", 20n, 1);
}

async function ros1Snapshot(bytes: Uint8Array, mode: "local" | "granted") {
  const epoch = new SourceEpochController();
  const evidence: RangeEvidence = { calls: 0, maxBytes: 0, totalBytes: 0 };
  const reader = new BoundedByteReader(rangeSource(bytes, mode, evidence), epoch, workerLimits);
  const entry = {
    entryId: "bag",
    relativePath: "fixture.bag",
    sizeBytes: BigInt(bytes.byteLength),
    immutableVersion: "sha256:fixture",
  };
  const bundle: Ros1SourceBundle = { bundleId: "ros1-equivalence", version: 1, entries: [entry] };
  const session = await Ros1BagSourceSession.openBundle(bundle, () => reader, epoch);
  const messages = [];
  for await (const message of session.readIndexed()) {
    messages.push({
      topic: message.connection.topic,
      timeNanos: message.timeNanos,
      data: [...message.data],
      displays: rawAndNumeric(message.data),
    });
  }
  const snapshot = {
    channels: session.channels(),
    timeRange: session.timeRange(),
    messages,
    tf: tfSummary(),
    telemetry: session.telemetry(),
  };
  const readTelemetry = reader.snapshotTelemetry();
  session.close();
  return { snapshot, readTelemetry, evidence, epoch: epoch.epoch };
}

class TestEpoch implements SourceEpochPort {
  #epoch = 0;
  #controller = new AbortController();

  get epoch(): number {
    return this.#epoch;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  advance(): void {
    this.#controller.abort("test epoch advanced");
    this.#epoch += 1;
    this.#controller = new AbortController();
  }
}

class NodeReadonlyDatabase implements SqliteReadonlyDatabase {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path, { readOnly: true });
  }

  async query(sql: string, parameters: readonly SqliteValue[], signal: AbortSignal): Promise<readonly SqliteRow[]> {
    if (signal.aborted) throw new Error("SQLite query aborted");
    const statement = this.#database.prepare(sql);
    statement.setReadBigInts(true);
    const rows = statement.all(...parameters.map((value): SQLInputValue => value)) as Array<Record<string, unknown>>;
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") return [key, value];
      if (value instanceof Uint8Array) return [key, new Uint8Array(value)];
      throw new Error(`unexpected SQLite value for ${key}`);
    })) as SqliteRow);
  }

  async close(): Promise<void> {
    this.#database.close();
  }
}

class RangeMaterializingProvider implements SqliteQueryProvider {
  readonly #directory: string;
  readonly #chunkBytes: number;
  #index = 0;

  constructor(directory: string, chunkBytes = 4096) {
    this.#directory = directory;
    this.#chunkBytes = chunkBytes;
  }

  async open(entry: SqliteEntryContext, signal: AbortSignal): Promise<SqliteReadonlyDatabase> {
    const output = new Uint8Array(Number(entry.sizeBytes));
    let offset = 0;
    while (offset < output.byteLength) {
      const length = Math.min(this.#chunkBytes, output.byteLength - offset);
      const part = await entry.read(BigInt(offset), BigInt(length), signal);
      if (part.byteLength !== length) throw new Error("SQLite range was truncated");
      output.set(part, offset);
      offset += length;
    }
    const path = join(this.#directory, `materialized-${this.#index++}.db3`);
    await writeFile(path, output);
    return new NodeReadonlyDatabase(path);
  }
}

function createDatabase(path: string, values: readonly [bigint, number][]): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE schema(schema_version INTEGER PRIMARY KEY, ros_distro TEXT NOT NULL);
    CREATE TABLE topics(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, serialization_format TEXT NOT NULL, offered_qos_profiles TEXT NOT NULL, type_description_hash TEXT NOT NULL);
    CREATE TABLE message_definitions(id INTEGER PRIMARY KEY, topic_type TEXT NOT NULL, encoding TEXT NOT NULL, encoded_message_definition TEXT NOT NULL, type_description_hash TEXT NOT NULL);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL, timestamp INTEGER NOT NULL, data BLOB NOT NULL);
    CREATE INDEX timestamp_idx ON messages(timestamp ASC);
  `);
  database.prepare("INSERT INTO schema(schema_version, ros_distro) VALUES (?, ?)").run(4, "humble");
  database.prepare("INSERT INTO topics VALUES (?, ?, ?, ?, ?, ?)").run(1, "/value", "example_msgs/msg/Value", "cdr", "", "RIHS01_fixture");
  database.prepare("INSERT INTO message_definitions VALUES (?, ?, ?, ?, ?)").run(1, "example_msgs/msg/Value", "ros2msg", "uint8 value\n", "RIHS01_fixture");
  const insert = database.prepare("INSERT INTO messages(topic_id, timestamp, data) VALUES (?, ?, ?)");
  for (const [timestamp, value] of values) insert.run(1, timestamp, Uint8Array.of(value));
  database.close();
}

function ros2Metadata(paths: readonly string[], count: number, storage = "sqlite3", compression = ""): string {
  return `rosbag2_bagfile_information:
  version: 9
  storage_identifier: ${storage}
  duration:
    nanoseconds: 30
  starting_time:
    nanoseconds_since_epoch: 10
  message_count: ${count}
  topics_with_message_count:
    - topic_metadata:
        name: /value
        type: example_msgs/msg/Value
        serialization_format: cdr
        offered_qos_profiles: ''
        type_description_hash: RIHS01_fixture
      message_count: ${count}
  compression_format: ${compression ? compression : "''"}
  compression_mode: ${compression ? "file" : "''"}
  relative_file_paths:
${paths.map((path) => `    - ${path}`).join("\n")}
  files:
${paths.map((path) => `    - path: ${path}\n      starting_time:\n        nanoseconds_since_epoch: 10\n      duration:\n        nanoseconds: 30\n      message_count: 1`).join("\n")}
`;
}

interface Ros2Fixture {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly bundle: Ros2SourceBundle;
}

async function ros2Fixture(directory: string): Promise<Ros2Fixture> {
  const paths = ["bag_0.db3", "bag_1.db3"];
  createDatabase(join(directory, paths[0]!), [[10n, 10], [20n, 20]]);
  createDatabase(join(directory, paths[1]!), [[15n, 15], [20n, 21]]);
  const files = new Map<string, Uint8Array>();
  const metadataBytes = encoder.encode(ros2Metadata(paths, 4));
  await writeFile(join(directory, "metadata.yaml"), metadataBytes);
  files.set("metadata.yaml", metadataBytes);
  for (const path of paths) files.set(path, new Uint8Array(await readFile(join(directory, path))));
  const entries = [...files].map(([relativePath, bytes], index) => ({
    entryId: `entry-${index}`,
    relativePath,
    sizeBytes: BigInt(bytes.byteLength),
    immutableVersion: "sha256:fixture",
  }));
  const metadataEntry = entries[0]!;
  const relations: Ros2SourceBundle["relations"] = entries.slice(1).flatMap((entry, ordinal) => [
    { fromEntryId: metadataEntry.entryId, toEntryId: entry.entryId, kind: "metadata-for" as const },
    { fromEntryId: metadataEntry.entryId, toEntryId: entry.entryId, kind: "ordered-part" as const, ordinal },
  ]);
  return { files, bundle: { bundleId: "ros2-equivalence", version: 1, entries, relations } };
}

function ros2Access(
  fixture: Ros2Fixture,
  mode: "local" | "granted",
  evidence: RangeEvidence,
  directory?: string,
): Ros2BundleAccess {
  const grantedSources = new Map(fixture.bundle.entries.map((entry) => {
    const bytes = fixture.files.get(entry.relativePath);
    if (!bytes) throw new Error(`missing fixture bytes for ${entry.relativePath}`);
    return [entry.entryId, rangeSource(bytes, "granted", evidence)] as const;
  }));
  return {
    bundle: fixture.bundle,
    async readEntry(entryId, offset, length, signal) {
      const entry = fixture.bundle.entries.find((candidate) => candidate.entryId === entryId);
      if (!entry) throw new Error(`unknown entry ${entryId}`);
      if (mode === "local") {
        if (directory === undefined) throw new Error("local ROS2 access requires a directory");
        if (signal.aborted) throw new Error("local directory read aborted");
        const handle = await open(join(directory, entry.relativePath), "r");
        try {
          const output = new Uint8Array(Number(length));
          const result = await handle.read(output, 0, output.byteLength, Number(offset));
          return output.subarray(0, result.bytesRead);
        } finally {
          await handle.close();
        }
      }
      const source = grantedSources.get(entryId);
      if (!source) throw new Error(`unknown entry ${entryId}`);
      return source.read({ offset, length }, signal);
    },
  };
}

async function ros2Snapshot(fixture: Ros2Fixture, mode: "local" | "granted", directory: string) {
  const evidence: RangeEvidence = { calls: 0, maxBytes: 0, totalBytes: 0 };
  const epoch = new TestEpoch();
  const session = await Ros2SqliteSourceSession.open(
    ros2Access(fixture, mode, evidence, directory),
    new RangeMaterializingProvider(directory),
    epoch,
    {
      limits: {
        maxMetadataBytes: 64 * 1024,
        metadataReadChunkBytes: 128,
        maxParts: 4,
        maxTopics: 8,
        maxSchemas: 8,
        maxQueryRows: 2,
        maxMessageBytes: 64,
        maxMessagesPerRead: 16,
      },
    },
  );
  const messages = [];
  for await (const message of session.seek(10n)) {
    messages.push({
      timestampNanos: message.timestampNanos,
      partOrdinal: message.partOrdinal,
      topic: message.topic.name,
      data: [...message.data],
      displays: rawAndNumeric(message.data),
    });
  }
  const snapshot = {
    topics: session.topics(),
    schemas: session.schemas(),
    timeRange: session.timeRange(),
    messages,
    tf: tfSummary(),
    telemetry: session.telemetry(),
  };
  epoch.advance();
  expect(() => session.readMessages()).toThrow(/source epoch is stale/);
  await session.close();
  return { snapshot, evidence };
}

const expectedDisplayKinds = [
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
] as const;

describe("G003 M2 recorded-source equivalence and diagnostic gate", () => {
  it("keeps ROS1 local Blob and immutable granted-range snapshots equivalent and bounded", async () => {
    const bytes = ros1Fixture();
    const local = await ros1Snapshot(bytes, "local");
    const granted = await ros1Snapshot(bytes, "granted");

    expect(granted.snapshot).toEqual(local.snapshot);
    expect(granted.epoch).toBe(local.epoch);
    expect(granted.evidence.calls).toBeGreaterThan(8);
    expect(granted.evidence.maxBytes).toBeLessThan(bytes.byteLength);
    expect(granted.readTelemetry.peakInFlightBytes).toBeLessThan(bytes.byteLength);

    const corrupt = bytes.slice();
    corrupt[0] = 0;
    await expect(ros1Snapshot(corrupt, "granted")).rejects.toMatchObject({ code: "corrupt-bag" });
    const unsupported = await Ros1BagSourceSession.open(
      new BoundedByteReader(rangeSource(ros1Fixture("zstd"), "local", { calls: 0, maxBytes: 0, totalBytes: 0 }), new SourceEpochController(), workerLimits),
    );
    await expect(unsupported.readIndexed().next()).rejects.toMatchObject({ code: "unsupported-codec", detail: "zstd" });
  });

  it("keeps ROS2 local directory and immutable granted-range multipart snapshots equivalent and bounded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "m2-recorded-gate-"));
    try {
      const fixture = await ros2Fixture(directory);
      const local = await ros2Snapshot(fixture, "local", directory);
      const granted = await ros2Snapshot(fixture, "granted", directory);
      expect(granted.snapshot).toEqual(local.snapshot);
      expect(granted.evidence.calls).toBeGreaterThan(8);
      expect(granted.evidence.maxBytes).toBeLessThan(Math.max(...[...fixture.files.values()].map((bytes) => bytes.byteLength)));

      expect(() => parseRos2MetadataYaml(encoder.encode(ros2Metadata(["bag.db3"], 0, "mcap")))).toThrowError(
        expect.objectContaining({ code: "UNSUPPORTED_STORAGE" }),
      );
      expect(() => parseRos2MetadataYaml(encoder.encode(ros2Metadata(["bag.db3.zstd"], 0, "sqlite3", "zstd")))).toThrowError(
        expect.objectContaining({ code: "UNSUPPORTED_COMPRESSION" }),
      );

      const metadataOnly: Ros2Fixture = {
        files: new Map([["metadata.yaml", fixture.files.get("metadata.yaml")!]]),
        bundle: {
          ...fixture.bundle,
          entries: fixture.bundle.entries.slice(0, 1),
          relations: [],
        },
      };
      await expect(
        Ros2SqliteSourceSession.open(
          ros2Access(metadataOnly, "granted", { calls: 0, maxBytes: 0, totalBytes: 0 }),
          new RangeMaterializingProvider(directory),
          new TestEpoch(),
        ),
      ).rejects.toMatchObject({ code: "MISSING_PART" });

      const wrongOrder: Ros2Fixture = {
        files: fixture.files,
        bundle: {
          ...fixture.bundle,
          relations: fixture.bundle.relations.map((relation) => relation.kind === "ordered-part"
            ? { ...relation, ordinal: relation.ordinal === 0 ? 1 : 0 }
            : relation),
        },
      };
      await expect(
        Ros2SqliteSourceSession.open(
          ros2Access(wrongOrder, "local", { calls: 0, maxBytes: 0, totalBytes: 0 }, directory),
          new RangeMaterializingProvider(directory),
          new TestEpoch(),
        ),
      ).rejects.toMatchObject({ code: "INVALID_RELATION" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("locks all native groups, generic/opaque fallback, and explicit TF failure semantics", () => {
    expect(createDefaultDisplayRegistry().kinds()).toEqual(expectedDisplayKinds);
    expect(
      inspectRawMessage(
        { typeName: "custom/Opaque", schemaCapability: "opaque", bytes: Uint8Array.of(1, 2, 3, 4) },
        { maxInputBytes: 8, maxDepth: 2, maxFields: 4, maxArrayLength: 4, maxStringBytes: 8, maxPreviewBytes: 2 },
      ),
    ).toMatchObject({
      capability: "opaque",
      bytePreview: [1, 2],
      truncated: true,
      diagnostics: [expect.stringContaining("schema pack"), expect.stringContaining("truncated")],
    });
    expect(extractNumericValue({ nested: { values: [1, 2] } }, "nested.values", 1)).toBe(2);
    expect(extractNumericValue({ nested: { value: Number.NaN } }, "nested.value")).toBeUndefined();

    const tf = new TfBuffer(1, 8);
    expect(tf.lookup("map", "base", 10n, 1)).toMatchObject({ ok: false, reason: "missing" });
    tf.add({
      parentFrame: "map",
      childFrame: "base",
      timeNanos: 10n,
      isStatic: false,
      epoch: 1,
      translation: { x: 1, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
    expect(tf.lookup("map", "base", 9n, 1)).toMatchObject({ ok: false, reason: "extrapolation" });
    tf.advanceEpoch(2);
    expect(tf.lookup("map", "base", 10n, 1)).toMatchObject({ ok: false, reason: "stale-epoch" });
  });

  it("keeps machine-readable M2 evidence scoped to synthetic fixtures rather than claiming public support", async () => {
    const path = join(process.cwd(), "docs/evidence/m2-recorded-source.json");
    const evidence = JSON.parse(decoder.decode(await readFile(path))) as {
      schemaVersion: number;
      milestone: string;
      evidenceClass: string;
      promotedToPublicSupport: boolean;
      displayKinds: string[];
      gates: Record<string, string>;
    };
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      milestone: "G003-M2-recorded-source",
      evidenceClass: "deterministic-synthetic-fixture",
      promotedToPublicSupport: false,
    });
    expect(evidence.displayKinds).toEqual(expectedDisplayKinds);
    expect(Object.values(evidence.gates).every((status) => status === "pass")).toBe(true);
  });
});
