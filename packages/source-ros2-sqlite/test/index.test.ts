import { mkdtemp, open, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  Ros2SqliteSourceSession,
  Ros2SourceError,
  parseRos2MetadataYaml,
  type Ros2BundleAccess,
  type Ros2SourceBundle,
  type SourceEpochPort,
  type SqliteEntryContext,
  type SqliteQueryProvider,
  type SqliteReadonlyDatabase,
  type SqliteRow,
  type SqliteValue,
} from "../src/index.js";

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
    this.#controller.abort("fixture epoch advanced");
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
    if (signal.aborted) throw new Error("query aborted");
    const statement = this.#database.prepare(sql);
    statement.setReadBigInts(true);
    const rows = statement.all(...parameters.map((value): SQLInputValue => value)) as Array<Record<string, unknown>>;
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
        return [key, value];
      }
      if (value instanceof Uint8Array) return [key, new Uint8Array(value)];
      throw new Error(`unexpected node:sqlite value for ${key}`);
    })) as SqliteRow);
  }

  async close(): Promise<void> {
    this.#database.close();
  }
}

class NodeQueryProvider implements SqliteQueryProvider {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async open(entry: SqliteEntryContext, signal: AbortSignal): Promise<SqliteReadonlyDatabase> {
    if (signal.aborted) throw new Error("open aborted");
    return new NodeReadonlyDatabase(join(this.#directory, entry.relativePath));
  }
}

interface FixtureMessage {
  readonly timestamp: bigint;
  readonly data: readonly number[];
}

function createDatabase(path: string, messages: readonly FixtureMessage[], schemaVersion = 4): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE schema(schema_version INTEGER PRIMARY KEY, ros_distro TEXT NOT NULL);
    CREATE TABLE metadata(id INTEGER PRIMARY KEY, metadata_version INTEGER NOT NULL, metadata TEXT NOT NULL);
    CREATE TABLE topics(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      serialization_format TEXT NOT NULL,
      offered_qos_profiles TEXT NOT NULL,
      type_description_hash TEXT NOT NULL
    );
    CREATE TABLE message_definitions(
      id INTEGER PRIMARY KEY,
      topic_type TEXT NOT NULL,
      encoding TEXT NOT NULL,
      encoded_message_definition TEXT NOT NULL,
      type_description_hash TEXT NOT NULL
    );
    CREATE TABLE messages(id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL, timestamp INTEGER NOT NULL, data BLOB NOT NULL);
    CREATE INDEX timestamp_idx ON messages(timestamp ASC);
  `);
  database.prepare("INSERT INTO schema(schema_version, ros_distro) VALUES (?, ?)").run(schemaVersion, "humble");
  database.prepare(
    "INSERT INTO topics(id, name, type, serialization_format, offered_qos_profiles, type_description_hash) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(1, "/points", "example_msgs/msg/Point", "cdr", "", "RIHS01_fixture");
  database.prepare(
    "INSERT INTO message_definitions(id, topic_type, encoding, encoded_message_definition, type_description_hash) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "example_msgs/msg/Point", "ros2msg", "float64 x\n", "RIHS01_fixture");
  const insert = database.prepare("INSERT INTO messages(topic_id, timestamp, data) VALUES (?, ?, ?)");
  for (const message of messages) insert.run(1, message.timestamp, Uint8Array.from(message.data));
  database.close();
}

function metadata(paths: readonly string[], count: number, overrides: { version?: number; storage?: string; compression?: string } = {}): string {
  const files = paths.map((path) => `    - path: ${path}\n      starting_time:\n        nanoseconds_since_epoch: 10\n      duration:\n        nanoseconds: 10\n      message_count: 1`).join("\n");
  const relativePaths = paths.map((path) => `    - ${path}`).join("\n");
  return `rosbag2_bagfile_information:
  version: ${overrides.version ?? 9}
  storage_identifier: ${overrides.storage ?? "sqlite3"}
  duration:
    nanoseconds: 10
  starting_time:
    nanoseconds_since_epoch: 10
  message_count: ${count}
  topics_with_message_count:
    - topic_metadata:
        name: /points
        type: example_msgs/msg/Point
        serialization_format: cdr
        offered_qos_profiles: ''
        type_description_hash: RIHS01_fixture
      message_count: ${count}
  compression_format: ${overrides.compression ? overrides.compression : "''"}
  compression_mode: ${overrides.compression ? "file" : "''"}
  relative_file_paths:
${relativePaths}
  files:
${files}
`;
}

async function fixtureBundle(
  directory: string,
  paths: readonly string[],
  yaml: string,
  options: { omitPath?: string; orderedRelations?: boolean } = {},
): Promise<Ros2BundleAccess> {
  const metadataPath = join(directory, "metadata.yaml");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(metadataPath, yaml));
  const allPaths = ["metadata.yaml", ...paths.filter((path) => path !== options.omitPath)];
  const entries = await Promise.all(allPaths.map(async (relativePath, index) => ({
    entryId: `entry-${index}`,
    relativePath,
    sizeBytes: BigInt((await stat(join(directory, relativePath))).size),
    immutableVersion: "fixture-v1",
  })));
  const metadataEntry = entries[0]!;
  const partEntries = entries.slice(1);
  const relations: Ros2SourceBundle["relations"] = [
    ...partEntries.map((entry) => ({ fromEntryId: metadataEntry.entryId, toEntryId: entry.entryId, kind: "metadata-for" as const })),
    ...(options.orderedRelations === false ? [] : partEntries.map((entry, ordinal) => ({
      fromEntryId: metadataEntry.entryId,
      toEntryId: entry.entryId,
      kind: "ordered-part" as const,
      ordinal,
    }))),
  ];
  const bundle: Ros2SourceBundle = { bundleId: "fixture", version: 1, entries, relations };
  return {
    bundle,
    async readEntry(entryId, offset, length, signal) {
      if (signal.aborted) throw new Error("read aborted");
      const entry = entries.find((candidate) => candidate.entryId === entryId);
      if (!entry) throw new Error("unknown fixture entry");
      const handle = await open(join(directory, entry.relativePath), "r");
      try {
        const output = new Uint8Array(Number(length));
        const result = await handle.read(output, 0, output.byteLength, Number(offset));
        return output.subarray(0, result.bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}

async function makeDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ros2-sqlite-adapter-"));
}

describe("ROS2 SQLite SourceBundle adapter", () => {
  it("parses versioned metadata and rejects unsupported capabilities explicitly", () => {
    expect(parseRos2MetadataYaml(new TextEncoder().encode(metadata(["bag_0.db3"], 1)))).toMatchObject({
      version: 9,
      storageIdentifier: "sqlite3",
      relativeFilePaths: ["bag_0.db3"],
      topics: [{ name: "/points", type: "example_msgs/msg/Point" }],
    });
    expect(() => parseRos2MetadataYaml(new TextEncoder().encode(metadata(["bag_0.db3"], 1, { version: 10 })))).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_METADATA_VERSION" }),
    );
    expect(() => parseRos2MetadataYaml(new TextEncoder().encode(metadata(["bag_0.db3"], 1, { storage: "mcap" })))).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_STORAGE" }),
    );
    expect(() => parseRos2MetadataYaml(new TextEncoder().encode(metadata(["bag_0.db3.zstd"], 1, { compression: "zstd" })))).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_COMPRESSION" }),
    );
  });

  it("opens real multipart SQLite fixtures and merges seek results deterministically with bounded queries", async () => {
    const directory = await makeDirectory();
    createDatabase(join(directory, "bag_0.db3"), [
      { timestamp: 10n, data: [10] },
      { timestamp: 20n, data: [20] },
      { timestamp: 30n, data: [30] },
    ]);
    createDatabase(join(directory, "bag_1.db3"), [
      { timestamp: 15n, data: [15] },
      { timestamp: 20n, data: [21] },
      { timestamp: 35n, data: [35] },
    ]);
    const yaml = metadata(["bag_0.db3", "bag_1.db3"], 6);
    const access = await fixtureBundle(directory, ["bag_0.db3", "bag_1.db3"], yaml);
    const epoch = new TestEpoch();
    const session = await Ros2SqliteSourceSession.open(access, new NodeQueryProvider(directory), epoch, {
      limits: {
        maxMetadataBytes: 64 * 1024,
        metadataReadChunkBytes: 128,
        maxParts: 4,
        maxTopics: 16,
        maxSchemas: 16,
        maxQueryRows: 2,
        maxMessageBytes: 1024,
        maxMessagesPerRead: 100,
      },
    });

    expect(session.topics()).toMatchObject([{
      name: "/points",
      schema: {
        capability: "schema-present",
        encoding: "ros2msg",
        definition: "float64 x\n",
        provenance: [{ kind: "sqlite-message-definitions", databaseSchemaVersion: 4 }],
      },
    }]);
    expect(session.timeRange()).toEqual({ startTimeNanos: 10n, endTimeNanos: 35n, messageCount: 6n });
    const messages = [];
    for await (const message of session.seek(15n, { endTimeNanos: 30n, topics: ["/points"] })) messages.push(message);
    expect(messages.map((message) => [message.timestampNanos, message.partOrdinal, [...message.data]])).toEqual([
      [15n, 1, [15]],
      [20n, 0, [20]],
      [20n, 1, [21]],
      [30n, 0, [30]],
    ]);
    expect(session.telemetry()).toMatchObject({ partsOpened: 2, peakRowsBuffered: 2, messagesYielded: 4 });
    const totalDatabaseBytes = BigInt((await stat(join(directory, "bag_0.db3"))).size + (await stat(join(directory, "bag_1.db3"))).size);
    expect(session.telemetry().rangeBytesRead).toBeLessThan(totalDatabaseBytes);
    await session.close();
  });

  it("reports missing, corrupt, and unsupported-version parts without eager loading them", async () => {
    const missingDirectory = await makeDirectory();
    const missingAccess = await fixtureBundle(
      missingDirectory,
      ["missing.db3"],
      metadata(["missing.db3"], 0),
      { omitPath: "missing.db3" },
    );
    await expect(Ros2SqliteSourceSession.open(missingAccess, new NodeQueryProvider(missingDirectory), new TestEpoch())).rejects.toMatchObject({
      code: "MISSING_PART",
    });

    const corruptDirectory = await makeDirectory();
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(corruptDirectory, "bad.db3"), "not sqlite"));
    const corruptAccess = await fixtureBundle(corruptDirectory, ["bad.db3"], metadata(["bad.db3"], 0));
    await expect(Ros2SqliteSourceSession.open(corruptAccess, new NodeQueryProvider(corruptDirectory), new TestEpoch())).rejects.toMatchObject({
      code: "INVALID_SQLITE",
    });

    const futureDirectory = await makeDirectory();
    createDatabase(join(futureDirectory, "future.db3"), [], 99);
    const futureAccess = await fixtureBundle(futureDirectory, ["future.db3"], metadata(["future.db3"], 0));
    await expect(Ros2SqliteSourceSession.open(futureAccess, new NodeQueryProvider(futureDirectory), new TestEpoch())).rejects.toMatchObject({
      code: "UNSUPPORTED_DB_SCHEMA",
    });
  });

  it("cancels stale source epochs and enforces message byte ceilings", async () => {
    const directory = await makeDirectory();
    createDatabase(join(directory, "bag.db3"), [{ timestamp: 10n, data: [1, 2, 3, 4] }]);
    const access = await fixtureBundle(directory, ["bag.db3"], metadata(["bag.db3"], 1));
    const epoch = new TestEpoch();
    const session = await Ros2SqliteSourceSession.open(access, new NodeQueryProvider(directory), epoch, {
      limits: {
        maxMetadataBytes: 64 * 1024,
        metadataReadChunkBytes: 1024,
        maxParts: 4,
        maxTopics: 16,
        maxSchemas: 16,
        maxQueryRows: 16,
        maxMessageBytes: 3,
        maxMessagesPerRead: 10,
      },
    });
    await expect(session.readMessages().next()).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    epoch.advance();
    expect(() => session.readMessages()).toThrowError(expect.objectContaining({ code: "STALE_EPOCH" }));
    await session.close();
  });

  it("identifies missing relation evidence", async () => {
    const directory = await makeDirectory();
    createDatabase(join(directory, "bag.db3"), []);
    const access = await fixtureBundle(directory, ["bag.db3"], metadata(["bag.db3"], 0));
    const mutable = access.bundle as { relations: Ros2SourceBundle["relations"] };
    mutable.relations = [];
    await expect(Ros2SqliteSourceSession.open(access, new NodeQueryProvider(directory), new TestEpoch())).rejects.toBeInstanceOf(Ros2SourceError);
    await expect(Ros2SqliteSourceSession.open(access, new NodeQueryProvider(directory), new TestEpoch())).rejects.toMatchObject({
      code: "INVALID_RELATION",
    });
  });

  it("reads the generated metadata fixture bytes from disk", async () => {
    const directory = await makeDirectory();
    const yaml = metadata(["bag.db3"], 0);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(directory, "metadata.yaml"), yaml));
    const parsed = parseRos2MetadataYaml(await readFile(join(directory, "metadata.yaml")));
    expect(parsed.files).toEqual(["bag.db3"]);
  });
});
