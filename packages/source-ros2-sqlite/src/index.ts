const SQLITE_MAGIC = "SQLite format 3\0";
const CURRENT_METADATA_VERSION = 9;
const CURRENT_DB_SCHEMA_VERSION = 4;

export interface Ros2SqliteLimits {
  readonly maxMetadataBytes: number;
  readonly metadataReadChunkBytes: number;
  readonly maxParts: number;
  readonly maxTopics: number;
  readonly maxSchemas: number;
  readonly maxQueryRows: number;
  readonly maxMessageBytes: number;
  readonly maxMessagesPerRead: number;
}

export const DEFAULT_ROS2_SQLITE_LIMITS: Ros2SqliteLimits = Object.freeze({
  maxMetadataBytes: 4 * 1024 * 1024,
  metadataReadChunkBytes: 64 * 1024,
  maxParts: 256,
  maxTopics: 16_384,
  maxSchemas: 16_384,
  maxQueryRows: 512,
  maxMessageBytes: 64 * 1024 * 1024,
  maxMessagesPerRead: 1_000_000,
});

export type Ros2SourceErrorCode =
  | "MISSING_METADATA"
  | "INVALID_METADATA"
  | "UNSUPPORTED_METADATA_VERSION"
  | "UNSUPPORTED_STORAGE"
  | "UNSUPPORTED_COMPRESSION"
  | "MISSING_PART"
  | "INVALID_RELATION"
  | "INVALID_SQLITE"
  | "UNSUPPORTED_DB_SCHEMA"
  | "CORRUPT_SQLITE"
  | "RESOURCE_LIMIT"
  | "STALE_EPOCH"
  | "PROVIDER_FAILURE";

export class Ros2SourceError extends Error {
  readonly code: Ros2SourceErrorCode;

  constructor(code: Ros2SourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "Ros2SourceError";
    this.code = code;
  }
}

export interface Ros2BundleEntry {
  readonly entryId: string;
  readonly relativePath: string;
  readonly sizeBytes: bigint;
  readonly immutableVersion: string;
}

export interface Ros2BundleRelation {
  readonly fromEntryId: string;
  readonly toEntryId: string;
  readonly kind: "metadata-for" | "ordered-part" | "sidecar-index";
  readonly ordinal?: number;
}

export interface Ros2SourceBundle {
  readonly bundleId: string;
  readonly version: 1;
  readonly entries: readonly Ros2BundleEntry[];
  readonly relations: readonly Ros2BundleRelation[];
}

export interface Ros2BundleAccess {
  readonly bundle: Ros2SourceBundle;
  readEntry(
    entryId: string,
    offset: bigint,
    length: bigint,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

export interface SourceEpochPort {
  readonly epoch: number;
  readonly signal: AbortSignal;
  advance?(reason?: string): number | void;
}

export type SqliteValue = null | number | bigint | string | Uint8Array;
export type SqliteRow = Readonly<Record<string, SqliteValue>>;

/**
 * Browser-safe query surface. A browser implementation can back this with an
 * OPFS/HTTP-range SQLite VFS; Node tests use node:sqlite in strict read-only mode.
 */
export interface SqliteReadonlyDatabase {
  query(
    sql: string,
    parameters: readonly SqliteValue[],
    signal: AbortSignal,
  ): Promise<readonly SqliteRow[]>;
  close(): Promise<void>;
}

export interface SqliteEntryContext {
  readonly entryId: string;
  readonly relativePath: string;
  readonly sizeBytes: bigint;
  readonly immutableVersion: string;
  read(offset: bigint, length: bigint, signal: AbortSignal): Promise<Uint8Array>;
}

export interface SqliteQueryProvider {
  open(entry: SqliteEntryContext, signal: AbortSignal): Promise<SqliteReadonlyDatabase>;
}

export interface Ros2TopicMetadata {
  readonly name: string;
  readonly type: string;
  readonly serializationFormat: string;
  readonly offeredQosProfiles?: string;
  readonly typeDescriptionHash?: string;
  readonly messageCount?: bigint;
}

export interface Ros2BagMetadata {
  readonly version: number;
  readonly storageIdentifier: string;
  readonly relativeFilePaths: readonly string[];
  readonly files: readonly string[];
  readonly messageCount?: bigint;
  readonly compressionFormat: string;
  readonly compressionMode: string;
  readonly topics: readonly Ros2TopicMetadata[];
}

export interface Ros2SchemaInfo {
  readonly capability: "schema-present" | "schema-resolvable" | "opaque";
  readonly name: string;
  readonly encoding?: string;
  readonly definition?: string;
  readonly typeDescriptionHash?: string;
  readonly provenance: readonly {
    readonly kind: "sqlite-message-definitions" | "metadata-yaml";
    readonly partPath?: string;
    readonly metadataVersion: number;
    readonly databaseSchemaVersion?: number;
  }[];
  readonly diagnostic?: string;
}

export interface Ros2TopicInfo {
  readonly name: string;
  readonly type: string;
  readonly serializationFormat: string;
  readonly offeredQosProfiles?: string;
  readonly typeDescriptionHash?: string;
  readonly schema: Ros2SchemaInfo;
  readonly messageCount?: bigint;
}

export interface Ros2SqliteMessage {
  readonly partOrdinal: number;
  readonly partPath: string;
  readonly rowId: bigint;
  readonly timestampNanos: bigint;
  readonly topic: Ros2TopicInfo;
  readonly data: Uint8Array;
  readonly epoch: number;
}

export interface Ros2TimeRange {
  readonly startTimeNanos: bigint;
  readonly endTimeNanos: bigint;
  readonly messageCount: bigint;
}

export interface Ros2SqliteTelemetry {
  readonly metadataBytesRead: bigint;
  readonly rangeReadCalls: number;
  readonly rangeBytesRead: bigint;
  readonly partsOpened: number;
  readonly queries: number;
  readonly rowsReturned: number;
  readonly peakRowsBuffered: number;
  readonly messagesYielded: number;
}

interface MutableTelemetry {
  metadataBytesRead: bigint;
  rangeReadCalls: number;
  rangeBytesRead: bigint;
  partsOpened: number;
  queries: number;
  rowsReturned: number;
  peakRowsBuffered: number;
  messagesYielded: number;
}

interface OpenPart {
  readonly ordinal: number;
  readonly entry: Ros2BundleEntry;
  readonly database: SqliteReadonlyDatabase;
  readonly schemaVersion: number;
  readonly topicColumns: ReadonlySet<string>;
  readonly tables: ReadonlySet<string>;
  readonly timeRange?: Ros2TimeRange;
}

interface DefinitionRecord {
  readonly name: string;
  readonly encoding: string;
  readonly definition: string;
  readonly typeDescriptionHash?: string;
  readonly partPath: string;
  readonly databaseSchemaVersion: number;
}

interface InternalMessageRow {
  readonly rowId: bigint;
  readonly timestampNanos: bigint;
  readonly topicName: string;
  readonly topicType: string;
  readonly serializationFormat: string;
  readonly data: Uint8Array;
}

function fail(code: Ros2SourceErrorCode, message: string, cause?: unknown): never {
  throw new Ros2SourceError(code, message, cause === undefined ? undefined : { cause });
}

function assertLimits(limits: Ros2SqliteLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) fail("RESOURCE_LIMIT", `${name} must be a positive safe integer`);
  }
  if (limits.metadataReadChunkBytes > limits.maxMetadataBytes) {
    fail("RESOURCE_LIMIT", "metadataReadChunkBytes cannot exceed maxMetadataBytes");
  }
  if (limits.maxQueryRows > 4096) fail("RESOURCE_LIMIT", "maxQueryRows cannot exceed the hard limit of 4096");
  if (limits.maxParts > 4096) fail("RESOURCE_LIMIT", "maxParts cannot exceed the hard limit of 4096");
}

function abortError(reason?: unknown): Ros2SourceError {
  return new Ros2SourceError(
    "STALE_EPOCH",
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "source epoch is stale",
  );
}

function assertActive(epoch: SourceEpochPort, expectedEpoch: number): void {
  if (epoch.signal.aborted || epoch.epoch !== expectedEpoch) throw abortError(epoch.signal.reason);
}

function normalizedPath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    fail("INVALID_METADATA", `invalid relative path: ${path || "<empty>"}`);
  }
  const output: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (output.length === 0) fail("INVALID_METADATA", `relative path escapes the bundle: ${path}`);
      output.pop();
    } else {
      output.push(segment);
    }
  }
  if (output.length === 0) fail("INVALID_METADATA", `invalid relative path: ${path}`);
  return output.join("/");
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function resolveRelative(baseFile: string, relative: string): string {
  const base = dirname(baseFile);
  return normalizedPath(base ? `${base}/${relative}` : relative);
}

function scalar(rawInput: string): string {
  let raw = rawInput.trim();
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'")) fail("INVALID_METADATA", "unterminated single-quoted YAML scalar");
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch (error) {
      fail("INVALID_METADATA", "invalid double-quoted YAML scalar", error);
    }
  }
  const comment = raw.search(/\s#/);
  if (comment >= 0) raw = raw.slice(0, comment).trimEnd();
  if (/^[&*!>|[{]/.test(raw)) fail("INVALID_METADATA", "unsupported YAML construct in metadata.yaml");
  return raw;
}

function integer(raw: string, field: string): number {
  if (!/^-?\d+$/.test(raw)) fail("INVALID_METADATA", `${field} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail("INVALID_METADATA", `${field} exceeds the safe integer range`);
  return value;
}

function bigintValue(raw: string, field: string): bigint {
  if (!/^\d+$/.test(raw)) fail("INVALID_METADATA", `${field} must be a non-negative integer`);
  return BigInt(raw);
}

/** Parses the bounded, deterministic subset emitted by rosbag2 MetadataIo. */
export function parseRos2MetadataYaml(bytes: Uint8Array): Ros2BagMetadata {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail("INVALID_METADATA", "metadata.yaml is not valid UTF-8", error);
  }
  const lines = text.split(/\r?\n/);
  if (lines.length > 100_000) fail("RESOURCE_LIMIT", "metadata.yaml exceeds the line limit");

  let sawRoot = false;
  let section = "";
  let version: number | undefined;
  let storageIdentifier: string | undefined;
  let messageCount: bigint | undefined;
  let compressionFormat = "";
  let compressionMode = "";
  const relativeFilePaths: string[] = [];
  const files: string[] = [];
  const topics: Array<{
    name?: string;
    type?: string;
    serializationFormat?: string;
    offeredQosProfiles?: string;
    typeDescriptionHash?: string;
    messageCount?: bigint;
  }> = [];
  let currentTopic: (typeof topics)[number] | undefined;

  for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
    const original = lines[lineNumber - 1] ?? "";
    if (!original.trim() || original.trimStart().startsWith("#")) continue;
    if (original.includes("\t")) fail("INVALID_METADATA", `metadata.yaml line ${lineNumber} contains a tab`);
    const indent = original.length - original.trimStart().length;
    if (indent % 2 !== 0) fail("INVALID_METADATA", `metadata.yaml line ${lineNumber} has invalid indentation`);
    const content = original.trim();

    if (!sawRoot) {
      if (indent !== 0 || content !== "rosbag2_bagfile_information:") {
        fail("INVALID_METADATA", "metadata.yaml must contain the rosbag2_bagfile_information root");
      }
      sawRoot = true;
      continue;
    }

    const keyMatch = content.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/);
    if (indent === 2 && keyMatch) {
      const [, key = "", raw = ""] = keyMatch;
      section = key;
      currentTopic = undefined;
      if (raw) {
        const value = scalar(raw);
        if (key === "version") version = integer(value, "version");
        else if (key === "storage_identifier") storageIdentifier = value;
        else if (key === "message_count") messageCount = bigintValue(value, "message_count");
        else if (key === "compression_format") compressionFormat = value;
        else if (key === "compression_mode") compressionMode = value;
      }
      continue;
    }

    if (section === "relative_file_paths" && indent === 4 && content.startsWith("- ")) {
      relativeFilePaths.push(normalizedPath(scalar(content.slice(2))));
      continue;
    }
    if (section === "files") {
      const pathMatch = content.match(/^(?:-\s+)?path:\s*(.*)$/);
      if (pathMatch) files.push(normalizedPath(scalar(pathMatch[1] ?? "")));
      continue;
    }
    if (section === "topics_with_message_count") {
      if (/^-\s+topic_metadata:\s*$/.test(content)) {
        currentTopic = {};
        topics.push(currentTopic);
        continue;
      }
      if (!currentTopic) continue;
      const topicMatch = content.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!topicMatch) continue;
      const key = topicMatch[1] ?? "";
      const value = scalar(topicMatch[2] ?? "");
      if (key === "name") currentTopic.name = value;
      else if (key === "type") currentTopic.type = value;
      else if (key === "serialization_format") currentTopic.serializationFormat = value;
      else if (key === "offered_qos_profiles" && value) currentTopic.offeredQosProfiles = value;
      else if (key === "type_description_hash" && value) currentTopic.typeDescriptionHash = value;
      else if (key === "message_count") currentTopic.messageCount = bigintValue(value, "topic message_count");
    }
  }

  if (!sawRoot || version === undefined || storageIdentifier === undefined || relativeFilePaths.length === 0) {
    fail("INVALID_METADATA", "metadata.yaml is missing version, storage_identifier, or relative_file_paths");
  }
  if (version < 1 || version > CURRENT_METADATA_VERSION) {
    fail(
      "UNSUPPORTED_METADATA_VERSION",
      `unsupported ROS2 metadata version ${version}; supported versions are 1-${CURRENT_METADATA_VERSION}`,
    );
  }
  if (storageIdentifier !== "sqlite3") {
    fail("UNSUPPORTED_STORAGE", `unsupported ROS2 storage identifier: ${storageIdentifier}`);
  }
  if (new Set(relativeFilePaths).size !== relativeFilePaths.length) {
    fail("INVALID_METADATA", "metadata.yaml contains duplicate relative_file_paths");
  }
  if (files.length > 0 && (files.length !== relativeFilePaths.length || files.some((path, index) => path !== relativeFilePaths[index]))) {
    fail("INVALID_METADATA", "metadata files[] order does not match relative_file_paths");
  }
  const normalizedFormat = compressionFormat.toLowerCase();
  const normalizedMode = compressionMode.toLowerCase();
  if ((normalizedFormat && normalizedFormat !== "none") || (normalizedMode && normalizedMode !== "none")) {
    fail(
      "UNSUPPORTED_COMPRESSION",
      `unsupported ROS2 compression: mode=${compressionMode || "<empty>"}, format=${compressionFormat || "<empty>"}`,
    );
  }
  const parsedTopics = topics.map((topic, index): Ros2TopicMetadata => {
    if (!topic.name || !topic.type || !topic.serializationFormat) {
      fail("INVALID_METADATA", `topic metadata entry ${index} is incomplete`);
    }
    return {
      name: topic.name,
      type: topic.type,
      serializationFormat: topic.serializationFormat,
      offeredQosProfiles: topic.offeredQosProfiles,
      typeDescriptionHash: topic.typeDescriptionHash,
      messageCount: topic.messageCount,
    };
  });
  return {
    version,
    storageIdentifier,
    relativeFilePaths,
    files,
    messageCount,
    compressionFormat,
    compressionMode,
    topics: parsedTopics,
  };
}

function rowValue(row: SqliteRow, key: string): SqliteValue {
  const value = row[key];
  if (value === undefined) fail("CORRUPT_SQLITE", `SQLite query omitted required column ${key}`);
  return value;
}

function asString(value: SqliteValue, field: string): string {
  if (typeof value !== "string") fail("CORRUPT_SQLITE", `${field} must be text`);
  return value;
}

function asBigInt(value: SqliteValue, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  fail("CORRUPT_SQLITE", `${field} must be an exact integer`);
}

function asBytes(value: SqliteValue, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) fail("CORRUPT_SQLITE", `${field} must be a blob`);
  return value;
}

async function safeClose(databases: readonly SqliteReadonlyDatabase[]): Promise<void> {
  await Promise.allSettled(databases.map(async (database) => database.close()));
}

export class Ros2SqliteSourceSession {
  readonly metadata: Ros2BagMetadata;
  readonly diagnostics: readonly string[];
  readonly #limits: Ros2SqliteLimits;
  readonly #epoch: SourceEpochPort;
  #openedEpoch: number;
  readonly #parts: readonly OpenPart[];
  readonly #topics: readonly Ros2TopicInfo[];
  readonly #topicsByName: ReadonlyMap<string, Ros2TopicInfo>;
  readonly #schemas: readonly Ros2SchemaInfo[];
  readonly #timeRange?: Ros2TimeRange;
  readonly #telemetry: MutableTelemetry;
  #closed = false;

  private constructor(options: {
    metadata: Ros2BagMetadata;
    diagnostics: readonly string[];
    limits: Ros2SqliteLimits;
    epoch: SourceEpochPort;
    openedEpoch: number;
    parts: readonly OpenPart[];
    topics: readonly Ros2TopicInfo[];
    schemas: readonly Ros2SchemaInfo[];
    timeRange?: Ros2TimeRange;
    telemetry: MutableTelemetry;
  }) {
    this.metadata = options.metadata;
    this.diagnostics = options.diagnostics;
    this.#limits = options.limits;
    this.#epoch = options.epoch;
    this.#openedEpoch = options.openedEpoch;
    this.#parts = options.parts;
    this.#topics = options.topics;
    this.#topicsByName = new Map(options.topics.map((topic) => [topic.name, topic]));
    this.#schemas = options.schemas;
    this.#timeRange = options.timeRange;
    this.#telemetry = options.telemetry;
  }

  static async open(
    access: Ros2BundleAccess,
    provider: SqliteQueryProvider,
    epoch: SourceEpochPort,
    options: { readonly limits?: Ros2SqliteLimits } = {},
  ): Promise<Ros2SqliteSourceSession> {
    const limits = Object.freeze({ ...(options.limits ?? DEFAULT_ROS2_SQLITE_LIMITS) });
    assertLimits(limits);
    const openedEpoch = epoch.epoch;
    assertActive(epoch, openedEpoch);
    const telemetry: MutableTelemetry = {
      metadataBytesRead: 0n,
      rangeReadCalls: 0,
      rangeBytesRead: 0n,
      partsOpened: 0,
      queries: 0,
      rowsReturned: 0,
      peakRowsBuffered: 0,
      messagesYielded: 0,
    };
    const entries = access.bundle.entries;
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!entry.entryId || ids.has(entry.entryId)) fail("INVALID_RELATION", "bundle contains a duplicate or empty entry id");
      ids.add(entry.entryId);
      normalizedPath(entry.relativePath);
      if (entry.sizeBytes < 0n || !entry.immutableVersion) fail("INVALID_RELATION", `invalid bundle entry ${entry.entryId}`);
    }
    const metadataEntries = entries.filter((entry) => entry.relativePath.split("/").at(-1) === "metadata.yaml");
    if (metadataEntries.length !== 1) {
      fail("MISSING_METADATA", `ROS2 SQLite bundle requires exactly one metadata.yaml entry; found ${metadataEntries.length}`);
    }
    const metadataEntry = metadataEntries[0] as Ros2BundleEntry;
    if (metadataEntry.sizeBytes > BigInt(limits.maxMetadataBytes)) {
      fail("RESOURCE_LIMIT", "metadata.yaml exceeds maxMetadataBytes");
    }

    const readEntry = async (entry: Ros2BundleEntry, offset: bigint, length: bigint): Promise<Uint8Array> => {
      assertActive(epoch, openedEpoch);
      if (offset < 0n || length < 0n || offset + length > entry.sizeBytes) {
        fail("CORRUPT_SQLITE", `range is outside ${entry.relativePath}`);
      }
      telemetry.rangeReadCalls += 1;
      telemetry.rangeBytesRead += length;
      let bytes: Uint8Array;
      try {
        bytes = await access.readEntry(entry.entryId, offset, length, epoch.signal);
      } catch (error) {
        if (epoch.signal.aborted || epoch.epoch !== openedEpoch) throw abortError(epoch.signal.reason);
        fail("PROVIDER_FAILURE", `failed to read ${entry.relativePath}`, error);
      }
      assertActive(epoch, openedEpoch);
      if (BigInt(bytes.byteLength) !== length) fail("CORRUPT_SQLITE", `short range read from ${entry.relativePath}`);
      return bytes;
    };

    const metadataChunks: Uint8Array[] = [];
    let metadataOffset = 0n;
    while (metadataOffset < metadataEntry.sizeBytes) {
      const length = BigInt(Math.min(limits.metadataReadChunkBytes, Number(metadataEntry.sizeBytes - metadataOffset)));
      const chunk = await readEntry(metadataEntry, metadataOffset, length);
      metadataChunks.push(chunk);
      metadataOffset += length;
      telemetry.metadataBytesRead += length;
    }
    const metadataBytes = new Uint8Array(Number(metadataEntry.sizeBytes));
    let targetOffset = 0;
    for (const chunk of metadataChunks) {
      metadataBytes.set(chunk, targetOffset);
      targetOffset += chunk.byteLength;
    }
    const metadata = parseRos2MetadataYaml(metadataBytes);
    if (metadata.relativeFilePaths.length > limits.maxParts) fail("RESOURCE_LIMIT", "ROS2 bag exceeds maxParts");

    const parts = metadata.relativeFilePaths.map((path, ordinal) => {
      if (!path.endsWith(".db3")) fail("UNSUPPORTED_COMPRESSION", `ROS2 SQLite part is not an uncompressed .db3 file: ${path}`);
      const resolved = resolveRelative(metadataEntry.relativePath, path);
      const entry = entries.find((candidate) => candidate.relativePath === resolved);
      if (!entry) fail("MISSING_PART", `metadata.yaml references missing SQLite part ${path}`);
      return { ordinal, entry };
    });

    const metadataRelations = access.bundle.relations.filter((relation) => relation.kind === "metadata-for");
    for (const { entry } of parts) {
      if (!metadataRelations.some((relation) =>
        (relation.fromEntryId === metadataEntry.entryId && relation.toEntryId === entry.entryId) ||
        (relation.toEntryId === metadataEntry.entryId && relation.fromEntryId === entry.entryId))) {
        fail("INVALID_RELATION", `bundle is missing metadata-for relation for ${entry.relativePath}`);
      }
    }
    const orderedRelations = access.bundle.relations.filter((relation) => relation.kind === "ordered-part");
    if (orderedRelations.length > 0) {
      if (orderedRelations.length !== parts.length) fail("INVALID_RELATION", "ordered-part relation count does not match metadata parts");
      for (const { ordinal, entry } of parts) {
        if (!orderedRelations.some((relation) => relation.toEntryId === entry.entryId && relation.ordinal === ordinal)) {
          fail("INVALID_RELATION", `ordered-part relation does not match metadata order for ${entry.relativePath}`);
        }
      }
    }

    const opened: OpenPart[] = [];
    const acquiredDatabases: SqliteReadonlyDatabase[] = [];
    const definitions = new Map<string, DefinitionRecord>();
    const topicRecords = new Map<string, Omit<Ros2TopicInfo, "schema">>();
    const diagnostics: string[] = [];
    if (orderedRelations.length === 0 && parts.length > 1) {
      diagnostics.push("multipart order derived from metadata.yaml relative_file_paths; ordered-part relations were absent");
    }

    const query = async (
      database: SqliteReadonlyDatabase,
      sql: string,
      parameters: readonly SqliteValue[] = [],
    ): Promise<readonly SqliteRow[]> => {
      assertActive(epoch, openedEpoch);
      let rows: readonly SqliteRow[];
      try {
        rows = await database.query(sql, parameters, epoch.signal);
      } catch (error) {
        if (epoch.signal.aborted || epoch.epoch !== openedEpoch) throw abortError(epoch.signal.reason);
        fail("CORRUPT_SQLITE", `SQLite query failed: ${error instanceof Error ? error.message : String(error)}`, error);
      }
      assertActive(epoch, openedEpoch);
      telemetry.queries += 1;
      telemetry.rowsReturned += rows.length;
      telemetry.peakRowsBuffered = Math.max(telemetry.peakRowsBuffered, rows.length);
      if (rows.length > limits.maxQueryRows) fail("RESOURCE_LIMIT", "SQLite provider exceeded maxQueryRows");
      return rows;
    };

    try {
      for (const { ordinal, entry } of parts) {
        assertActive(epoch, openedEpoch);
        if (entry.sizeBytes < BigInt(SQLITE_MAGIC.length)) fail("INVALID_SQLITE", `${entry.relativePath} is truncated`);
        const magic = await readEntry(entry, 0n, BigInt(SQLITE_MAGIC.length));
        if (new TextDecoder().decode(magic) !== SQLITE_MAGIC) fail("INVALID_SQLITE", `${entry.relativePath} has invalid SQLite magic`);
        const context: SqliteEntryContext = {
          ...entry,
          read: async (offset, length, signal) => {
            if (signal !== epoch.signal) fail("PROVIDER_FAILURE", "SQLite provider used an unexpected abort signal");
            return readEntry(entry, offset, length);
          },
        };
        let database: SqliteReadonlyDatabase;
        try {
          database = await provider.open(context, epoch.signal);
        } catch (error) {
          fail("PROVIDER_FAILURE", `failed to open ${entry.relativePath} read-only`, error);
        }
        acquiredDatabases.push(database);
        telemetry.partsOpened += 1;

        const collectNames = async (sql: string, field: string): Promise<Set<string>> => {
          const names = new Set<string>();
          let offset = 0;
          for (;;) {
            const rows = await query(database, sql, [limits.maxQueryRows, offset]);
            for (const row of rows) {
              names.add(asString(rowValue(row, "name"), field));
              if (names.size > limits.maxSchemas) fail("RESOURCE_LIMIT", "SQLite catalog exceeds maxSchemas");
            }
            offset += rows.length;
            if (rows.length < limits.maxQueryRows) return names;
          }
        };
        const tables = await collectNames(
          "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name LIMIT ? OFFSET ?",
          "sqlite_schema.name",
        );
        if (!tables.has("topics") || !tables.has("messages")) {
          await database.close();
          fail("INVALID_SQLITE", `${entry.relativePath} is missing the topics or messages table`);
        }
        const topicColumns = await collectNames(
          "SELECT name FROM pragma_table_info('topics') ORDER BY cid LIMIT ? OFFSET ?",
          "table_info.name",
        );
        for (const required of ["id", "name", "type", "serialization_format"]) {
          if (!topicColumns.has(required)) fail("INVALID_SQLITE", `${entry.relativePath} topics table is missing ${required}`);
        }
        const messageColumns = await collectNames(
          "SELECT name FROM pragma_table_info('messages') ORDER BY cid LIMIT ? OFFSET ?",
          "table_info.name",
        );
        for (const required of ["id", "topic_id", "timestamp", "data"]) {
          if (!messageColumns.has(required)) fail("INVALID_SQLITE", `${entry.relativePath} messages table is missing ${required}`);
        }

        let schemaVersion = topicColumns.has("offered_qos_profiles") ? 2 : 1;
        if (tables.has("schema")) {
          const versionRows = await query(database, "SELECT schema_version FROM schema ORDER BY schema_version DESC LIMIT 2");
          if (versionRows.length !== 1) fail("CORRUPT_SQLITE", `${entry.relativePath} has invalid schema version metadata`);
          schemaVersion = Number(asBigInt(rowValue(versionRows[0] as SqliteRow, "schema_version"), "schema_version"));
        }
        if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > CURRENT_DB_SCHEMA_VERSION) {
          await database.close();
          fail(
            "UNSUPPORTED_DB_SCHEMA",
            `unsupported ROS2 SQLite schema version ${schemaVersion} in ${entry.relativePath}; supported versions are 1-${CURRENT_DB_SCHEMA_VERSION}`,
          );
        }

        const timeRows = await query(
          database,
          "SELECT MIN(timestamp) AS min_timestamp, MAX(timestamp) AS max_timestamp, COUNT(*) AS message_count FROM messages",
        );
        if (timeRows.length !== 1) fail("CORRUPT_SQLITE", `${entry.relativePath} did not return aggregate metadata`);
        const timeRow = timeRows[0] as SqliteRow;
        const count = asBigInt(rowValue(timeRow, "message_count"), "message_count");
        let partTimeRange: Ros2TimeRange | undefined;
        if (count > 0n) {
          partTimeRange = {
            startTimeNanos: asBigInt(rowValue(timeRow, "min_timestamp"), "min_timestamp"),
            endTimeNanos: asBigInt(rowValue(timeRow, "max_timestamp"), "max_timestamp"),
            messageCount: count,
          };
        }

        const optionalTopicColumns = ["offered_qos_profiles", "type_description_hash"].filter((column) => topicColumns.has(column));
        const topicSelect = ["id", "name", "type", "serialization_format", ...optionalTopicColumns].join(", ");
        let topicOffset = 0;
        for (;;) {
          const rows = await query(database, `SELECT ${topicSelect} FROM topics ORDER BY id LIMIT ? OFFSET ?`, [limits.maxQueryRows, topicOffset]);
          for (const row of rows) {
            const name = asString(rowValue(row, "name"), "topics.name");
            const record: Omit<Ros2TopicInfo, "schema"> = {
              name,
              type: asString(rowValue(row, "type"), "topics.type"),
              serializationFormat: asString(rowValue(row, "serialization_format"), "topics.serialization_format"),
              offeredQosProfiles: topicColumns.has("offered_qos_profiles")
                ? asString(rowValue(row, "offered_qos_profiles"), "topics.offered_qos_profiles") || undefined
                : undefined,
              typeDescriptionHash: topicColumns.has("type_description_hash")
                ? asString(rowValue(row, "type_description_hash"), "topics.type_description_hash") || undefined
                : undefined,
            };
            const previous = topicRecords.get(name);
            if (previous && (previous.type !== record.type || previous.serializationFormat !== record.serializationFormat)) {
              fail("CORRUPT_SQLITE", `multipart topic ${name} has inconsistent type or serialization format`);
            }
            topicRecords.set(name, previous ?? record);
            if (topicRecords.size > limits.maxTopics) fail("RESOURCE_LIMIT", "ROS2 bag exceeds maxTopics");
          }
          topicOffset += rows.length;
          if (rows.length < limits.maxQueryRows) break;
        }

        if (tables.has("message_definitions")) {
          let definitionOffset = 0;
          for (;;) {
            const rows = await query(
              database,
              "SELECT topic_type, encoding, encoded_message_definition, type_description_hash FROM message_definitions ORDER BY id LIMIT ? OFFSET ?",
              [limits.maxQueryRows, definitionOffset],
            );
            for (const row of rows) {
              const record: DefinitionRecord = {
                name: asString(rowValue(row, "topic_type"), "message_definitions.topic_type"),
                encoding: asString(rowValue(row, "encoding"), "message_definitions.encoding"),
                definition: asString(rowValue(row, "encoded_message_definition"), "message_definitions.encoded_message_definition"),
                typeDescriptionHash: asString(rowValue(row, "type_description_hash"), "message_definitions.type_description_hash") || undefined,
                partPath: entry.relativePath,
                databaseSchemaVersion: schemaVersion,
              };
              const previous = definitions.get(record.name);
              if (previous && (previous.encoding !== record.encoding || previous.definition !== record.definition || previous.typeDescriptionHash !== record.typeDescriptionHash)) {
                fail("CORRUPT_SQLITE", `multipart schema ${record.name} is inconsistent across parts`);
              }
              definitions.set(record.name, previous ?? record);
              if (definitions.size > limits.maxSchemas) fail("RESOURCE_LIMIT", "ROS2 bag exceeds maxSchemas");
            }
            definitionOffset += rows.length;
            if (rows.length < limits.maxQueryRows) break;
          }
        }

        opened.push({ ordinal, entry, database, schemaVersion, topicColumns, tables, timeRange: partTimeRange });
      }
    } catch (error) {
      await safeClose(acquiredDatabases);
      throw error;
    }

    for (const metadataTopic of metadata.topics) {
      const databaseTopic = topicRecords.get(metadataTopic.name);
      if (databaseTopic && (databaseTopic.type !== metadataTopic.type || databaseTopic.serializationFormat !== metadataTopic.serializationFormat)) {
        await safeClose(opened.map((part) => part.database));
        fail("CORRUPT_SQLITE", `metadata.yaml topic ${metadataTopic.name} disagrees with SQLite`);
      }
      if (!databaseTopic) {
        topicRecords.set(metadataTopic.name, {
          name: metadataTopic.name,
          type: metadataTopic.type,
          serializationFormat: metadataTopic.serializationFormat,
          offeredQosProfiles: metadataTopic.offeredQosProfiles,
          typeDescriptionHash: metadataTopic.typeDescriptionHash,
        });
      }
    }

    const schemasByName = new Map<string, Ros2SchemaInfo>();
    const metadataTopicsByName = new Map(metadata.topics.map((topic) => [topic.name, topic]));
    const topics = [...topicRecords.values()].sort((left, right) => left.name.localeCompare(right.name)).map((topic): Ros2TopicInfo => {
      const definition = definitions.get(topic.type);
      let schema = schemasByName.get(topic.type);
      if (!schema) {
        schema = definition
          ? {
              capability: "schema-present",
              name: topic.type,
              encoding: definition.encoding,
              definition: definition.definition,
              typeDescriptionHash: definition.typeDescriptionHash || topic.typeDescriptionHash,
              provenance: [{
                kind: "sqlite-message-definitions",
                partPath: definition.partPath,
                metadataVersion: metadata.version,
                databaseSchemaVersion: definition.databaseSchemaVersion,
              }],
            }
          : {
              capability: topic.type ? "schema-resolvable" : "opaque",
              name: topic.type || "unknown",
              typeDescriptionHash: topic.typeDescriptionHash,
              provenance: [{ kind: "metadata-yaml", metadataVersion: metadata.version }],
              diagnostic: "SQLite bag does not embed this message definition; an external schema provider is required",
            };
        schemasByName.set(topic.type, schema);
      }
      const metadataTopic = metadataTopicsByName.get(topic.name);
      return { ...topic, schema, ...(metadataTopic?.messageCount === undefined ? {} : { messageCount: metadataTopic.messageCount }) };
    });

    let timeRange: Ros2TimeRange | undefined;
    for (const part of opened) {
      const range = part.timeRange;
      if (!range) continue;
      timeRange = timeRange
        ? {
            startTimeNanos: range.startTimeNanos < timeRange.startTimeNanos ? range.startTimeNanos : timeRange.startTimeNanos,
            endTimeNanos: range.endTimeNanos > timeRange.endTimeNanos ? range.endTimeNanos : timeRange.endTimeNanos,
            messageCount: timeRange.messageCount + range.messageCount,
          }
        : range;
    }
    if (metadata.messageCount !== undefined && metadata.messageCount !== (timeRange?.messageCount ?? 0n)) {
      diagnostics.push(`metadata message_count ${metadata.messageCount} differs from SQLite count ${timeRange?.messageCount ?? 0n}`);
    }
    return new Ros2SqliteSourceSession({
      metadata,
      diagnostics,
      limits,
      epoch,
      openedEpoch,
      parts: opened,
      topics,
      schemas: [...schemasByName.values()].sort((left, right) => left.name.localeCompare(right.name)),
      timeRange,
      telemetry,
    });
  }

  advanceEpoch(reason = "ROS2 SQLite source epoch advanced"): number {
    if (this.#closed) throw abortError("ROS2 SQLite source is closed");
    if (!this.#epoch.advance) throw new Error("ROS2 SQLite epoch controller cannot advance");
    this.#openedEpoch = this.#epoch.advance(reason) ?? this.#epoch.epoch;
    return this.#openedEpoch;
  }

  topics(): readonly Ros2TopicInfo[] {
    this.#assertOpen();
    return this.#topics;
  }

  schemas(): readonly Ros2SchemaInfo[] {
    this.#assertOpen();
    return this.#schemas;
  }

  timeRange(): Ros2TimeRange | undefined {
    this.#assertOpen();
    return this.#timeRange;
  }

  telemetry(): Ros2SqliteTelemetry {
    return { ...this.#telemetry };
  }

  readMessages(options: {
    readonly startTimeNanos?: bigint;
    readonly endTimeNanos?: bigint;
    readonly topics?: readonly string[];
    readonly limit?: number;
    readonly order?: "ascending" | "descending";
  } = {}): AsyncGenerator<Ros2SqliteMessage, void, void> {
    this.#assertOpen();
    const startTime = options.startTimeNanos ?? this.#timeRange?.startTimeNanos ?? 0n;
    const endTime = options.endTimeNanos ?? this.#timeRange?.endTimeNanos ?? startTime;
    if (endTime < startTime) fail("RESOURCE_LIMIT", "endTimeNanos cannot precede startTimeNanos");
    const limit = options.limit ?? this.#limits.maxMessagesPerRead;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > this.#limits.maxMessagesPerRead) {
      fail("RESOURCE_LIMIT", "message read limit exceeds maxMessagesPerRead");
    }
    const topicFilter = options.topics ? [...new Set(options.topics)] : undefined;
    if (topicFilter && topicFilter.length > this.#limits.maxTopics) fail("RESOURCE_LIMIT", "topic filter exceeds maxTopics");
    return this.#iterateMessages(startTime, endTime, topicFilter, limit, options.order ?? "ascending");
  }

  seek(
    timestampNanos: bigint,
    options: {
      readonly endTimeNanos?: bigint;
      readonly topics?: readonly string[];
      readonly limit?: number;
      readonly order?: "ascending" | "descending";
    } = {},
  ): AsyncGenerator<Ros2SqliteMessage, void, void> {
    return this.readMessages({ ...options, startTimeNanos: timestampNanos });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await safeClose(this.#parts.map((part) => part.database));
  }

  #assertOpen(): void {
    if (this.#closed) fail("PROVIDER_FAILURE", "ROS2 SQLite session is closed");
    assertActive(this.#epoch, this.#openedEpoch);
  }

  async #query(part: OpenPart, sql: string, parameters: readonly SqliteValue[]): Promise<readonly SqliteRow[]> {
    this.#assertOpen();
    let rows: readonly SqliteRow[];
    try {
      rows = await part.database.query(sql, parameters, this.#epoch.signal);
    } catch (error) {
      if (this.#epoch.signal.aborted || this.#epoch.epoch !== this.#openedEpoch) throw abortError(this.#epoch.signal.reason);
      fail("CORRUPT_SQLITE", `SQLite query failed for ${part.entry.relativePath}`, error);
    }
    this.#assertOpen();
    this.#telemetry.queries += 1;
    this.#telemetry.rowsReturned += rows.length;
    this.#telemetry.peakRowsBuffered = Math.max(this.#telemetry.peakRowsBuffered, rows.length);
    if (rows.length > this.#limits.maxQueryRows) fail("RESOURCE_LIMIT", "SQLite provider exceeded maxQueryRows");
    return rows;
  }

  async *#iterateMessages(
    startTime: bigint,
    endTime: bigint,
    topics: readonly string[] | undefined,
    limit: number,
    order: "ascending" | "descending",
  ): AsyncGenerator<Ros2SqliteMessage, void, void> {
    type Cursor = {
      part: OpenPart;
      rows: InternalMessageRow[];
      index: number;
      exhausted: boolean;
      after?: { timestamp: bigint; id: bigint };
    };
    const cursors: Cursor[] = this.#parts.map((part) => ({ part, rows: [], index: 0, exhausted: false }));

    const refill = async (cursor: Cursor): Promise<void> => {
      if (cursor.exhausted || cursor.index < cursor.rows.length) return;
      const conditions = ["messages.timestamp >= ?", "messages.timestamp <= ?"];
      const parameters: SqliteValue[] = [startTime, endTime];
      if (cursor.after) {
        const comparison = order === "ascending" ? ">" : "<";
        conditions.push(`(messages.timestamp ${comparison} ? OR (messages.timestamp = ? AND messages.id ${comparison} ?))`);
        parameters.push(cursor.after.timestamp, cursor.after.timestamp, cursor.after.id);
      }
      if (topics && topics.length > 0) {
        conditions.push(`topics.name IN (${topics.map(() => "?").join(", ")})`);
        parameters.push(...topics);
      }
      parameters.push(this.#limits.maxQueryRows);
      const rows = await this.#query(
        cursor.part,
        `SELECT messages.id AS message_id, messages.timestamp AS timestamp, messages.data AS data, ` +
          `topics.name AS topic_name, topics.type AS topic_type, topics.serialization_format AS serialization_format ` +
          `FROM messages JOIN topics ON messages.topic_id = topics.id WHERE ${conditions.join(" AND ")} ` +
          `ORDER BY messages.timestamp ${order === "ascending" ? "ASC" : "DESC"}, ` +
          `messages.id ${order === "ascending" ? "ASC" : "DESC"} LIMIT ?`,
        parameters,
      );
      cursor.rows = rows.map((row): InternalMessageRow => {
        const data = asBytes(rowValue(row, "data"), "messages.data");
        if (data.byteLength > this.#limits.maxMessageBytes) fail("RESOURCE_LIMIT", "ROS2 message exceeds maxMessageBytes");
        return {
          rowId: asBigInt(rowValue(row, "message_id"), "messages.id"),
          timestampNanos: asBigInt(rowValue(row, "timestamp"), "messages.timestamp"),
          topicName: asString(rowValue(row, "topic_name"), "topics.name"),
          topicType: asString(rowValue(row, "topic_type"), "topics.type"),
          serializationFormat: asString(rowValue(row, "serialization_format"), "topics.serialization_format"),
          data,
        };
      });
      cursor.index = 0;
      cursor.exhausted = rows.length === 0;
    };

    let yielded = 0;
    while (yielded < limit) {
      this.#assertOpen();
      await Promise.all(cursors.map(refill));
      let selected: Cursor | undefined;
      for (const cursor of cursors) {
        const row = cursor.rows[cursor.index];
        const selectedRow = selected?.rows[selected.index];
        const selectedOrdinal = selected?.part.ordinal;
        if (!row) continue;
        const beforeSelected = selectedRow === undefined || (order === "ascending"
          ? row.timestampNanos < selectedRow.timestampNanos ||
            (row.timestampNanos === selectedRow.timestampNanos && selectedOrdinal !== undefined && cursor.part.ordinal < selectedOrdinal) ||
            (row.timestampNanos === selectedRow.timestampNanos && cursor.part.ordinal === selectedOrdinal && row.rowId < selectedRow.rowId)
          : row.timestampNanos > selectedRow.timestampNanos ||
            (row.timestampNanos === selectedRow.timestampNanos && selectedOrdinal !== undefined && cursor.part.ordinal > selectedOrdinal) ||
            (row.timestampNanos === selectedRow.timestampNanos && cursor.part.ordinal === selectedOrdinal && row.rowId > selectedRow.rowId));
        if (beforeSelected) {
          selected = cursor;
        }
      }
      if (!selected) break;
      const row = selected.rows[selected.index] as InternalMessageRow;
      selected.index += 1;
      selected.after = { timestamp: row.timestampNanos, id: row.rowId };
      const topic = this.#topicsByName.get(row.topicName);
      if (!topic || topic.type !== row.topicType || topic.serializationFormat !== row.serializationFormat) {
        fail("CORRUPT_SQLITE", `message references inconsistent topic ${row.topicName}`);
      }
      yielded += 1;
      this.#telemetry.messagesYielded += 1;
      yield {
        partOrdinal: selected.part.ordinal,
        partPath: selected.part.entry.relativePath,
        rowId: row.rowId,
        timestampNanos: row.timestampNanos,
        topic,
        data: row.data,
        epoch: this.#openedEpoch,
      };
    }
  }
}
