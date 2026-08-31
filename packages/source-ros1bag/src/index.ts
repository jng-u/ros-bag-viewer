const BAG_MAGIC = new TextEncoder().encode("#ROSBAG V2.0\n");

const OP_MESSAGE_DATA = 0x02;
const OP_BAG_HEADER = 0x03;
const OP_INDEX_DATA = 0x04;
const OP_CHUNK = 0x05;
const OP_CHUNK_INFO = 0x06;
const OP_CONNECTION = 0x07;

export interface Ros1BagReader {
  size(): Promise<bigint>;
  read(offset: bigint, size: bigint): Promise<Uint8Array>;
}

export interface Ros1EpochController {
  readonly epoch: number;
  readonly signal: AbortSignal;
  advance?(reason?: string): number;
}

export interface Ros1SourceEntry {
  readonly entryId: string;
  readonly relativePath: string;
  readonly sizeBytes: bigint;
  readonly immutableVersion: string;
}

export interface Ros1SourceBundle {
  readonly bundleId: string;
  readonly version: 1;
  readonly entries: readonly Ros1SourceEntry[];
}

export type Ros1BundleReaderResolver = (entry: Ros1SourceEntry) => Ros1BagReader | Promise<Ros1BagReader>;

export interface Ros1BagLimits {
  readonly maxHeaderBytes: number;
  readonly maxHeaderFieldBytes: number;
  readonly maxRecordBytes: number;
  readonly maxMessageBytes: number;
  readonly maxConnections: number;
  readonly maxChunks: number;
  readonly maxIndexEntries: number;
  readonly maxStoredChunkBytes: number;
  readonly maxDecompressedChunkBytes: number;
  readonly maxTotalDecompressedBytes: number;
  readonly maxDecompressionRatio: number;
  readonly sequentialReadBytes: number;
}

export const DEFAULT_ROS1_BAG_LIMITS: Ros1BagLimits = Object.freeze({
  maxHeaderBytes: 64 * 1024,
  maxHeaderFieldBytes: 16 * 1024 * 1024,
  maxRecordBytes: 16 * 1024 * 1024,
  maxMessageBytes: 16 * 1024 * 1024,
  maxConnections: 10_000,
  maxChunks: 100_000,
  maxIndexEntries: 2_000_000,
  maxStoredChunkBytes: 256 * 1024 * 1024,
  maxDecompressedChunkBytes: 256 * 1024 * 1024,
  maxTotalDecompressedBytes: 512 * 1024 * 1024,
  maxDecompressionRatio: 100,
  sequentialReadBytes: 256 * 1024,
});

export interface Ros1SchemaProvenance {
  readonly providerId: "ros1-connection-definition";
  readonly providerVersion: "1";
  readonly contentHash: string;
  readonly sourceEntryId?: string;
}

export interface Ros1SchemaInfo {
  readonly capability: "schema-present" | "opaque";
  readonly typeName: string;
  readonly md5sum?: string;
  readonly definition?: string;
  readonly provenance: readonly Ros1SchemaProvenance[];
  readonly diagnostic?: string;
}

export interface Ros1ConnectionInfo {
  readonly id: number;
  readonly topic: string;
  readonly typeName: string;
  readonly md5sum?: string;
  readonly callerId?: string;
  readonly latching?: boolean;
  readonly schema: Ros1SchemaInfo;
}

export interface Ros1Message {
  readonly connection: Ros1ConnectionInfo;
  readonly sequence: bigint;
  readonly timeNanos: bigint;
  readonly data: Uint8Array;
}

export interface Ros1TimeRange {
  readonly startTimeNanos: bigint;
  readonly endTimeNanos: bigint;
}

export interface Ros1BagTelemetry {
  readonly mode: "indexed" | "unindexed-degraded";
  readonly logicalBytesTraversed: bigint;
  readonly messagesRead: number;
  readonly chunksVisited: number;
  readonly decompressedBytes: number;
  readonly unsupportedChunks: number;
}

export type Ros1SequentialEvent =
  | { readonly kind: "progress"; readonly traversedBytes: bigint; readonly totalBytes: bigint; readonly progress: number }
  | { readonly kind: "message"; readonly message: Ros1Message };

export type Ros1ChunkDecompressor = (
  compressed: Uint8Array,
  declaredSize: number,
  signal: AbortSignal,
) => Uint8Array | Promise<Uint8Array>;

export interface Ros1BagOpenOptions {
  readonly limits?: Ros1BagLimits;
  readonly decompressors?: Readonly<Partial<Record<"bz2" | "lz4", Ros1ChunkDecompressor>>>;
  readonly sourceEntryId?: string;
}

export class Ros1BagDiagnosticError extends Error {
  readonly code: "unsupported-codec" | "corrupt-bag" | "resource-limit" | "stale-epoch";
  readonly detail?: string;

  constructor(
    code: "unsupported-codec" | "corrupt-bag" | "resource-limit" | "stale-epoch",
    message: string,
    detail?: string,
  ) {
    super(message);
    this.name = "Ros1BagDiagnosticError";
    this.code = code;
    this.detail = detail;
  }
}

interface RecordMeta {
  readonly position: bigint;
  readonly fields: ReadonlyMap<string, Uint8Array>;
  readonly op: number;
  readonly dataOffset: bigint;
  readonly dataLength: number;
  readonly nextPosition: bigint;
}

interface ChunkDescriptor {
  readonly position: bigint;
  readonly compression: string;
  readonly declaredSize: number;
  readonly dataOffset: bigint;
  readonly storedLength: number;
}

interface IndexEntry {
  readonly connectionId: number;
  readonly timeNanos: bigint;
  readonly chunkPosition: bigint;
  readonly offset: number;
}

interface ChunkInfo {
  readonly chunkPosition: bigint;
  readonly startTimeNanos: bigint;
  readonly endTimeNanos: bigint;
  readonly counts: ReadonlyMap<number, number>;
}

interface MutableTelemetry {
  mode: "indexed" | "unindexed-degraded";
  logicalBytesTraversed: bigint;
  messagesRead: number;
  chunksVisited: number;
  decompressedBytes: number;
  unsupportedChunks: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function diagnostic(
  code: "unsupported-codec" | "corrupt-bag" | "resource-limit" | "stale-epoch",
  message: string,
  detail?: string,
): Ros1BagDiagnosticError {
  return new Ros1BagDiagnosticError(code, message, detail);
}

function assertLimits(limits: Ros1BagLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw diagnostic("resource-limit", `${name} must be a positive safe integer`);
    if (value > DEFAULT_ROS1_BAG_LIMITS[name as keyof Ros1BagLimits]) {
      throw diagnostic("resource-limit", `${name} cannot exceed the hard ROS1 bag resource limit`);
    }
  }
  if (limits.maxHeaderBytes > limits.maxRecordBytes) {
    throw diagnostic("resource-limit", "maxHeaderBytes cannot exceed maxRecordBytes");
  }
  if (limits.maxMessageBytes > limits.maxRecordBytes) {
    throw diagnostic("resource-limit", "maxMessageBytes cannot exceed maxRecordBytes");
  }
  if (limits.sequentialReadBytes > limits.maxStoredChunkBytes) {
    throw diagnostic("resource-limit", "sequentialReadBytes cannot exceed maxStoredChunkBytes");
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function uint32(bytes: Uint8Array, offset = 0): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw diagnostic("corrupt-bag", "truncated uint32 field");
  return view(bytes).getUint32(offset, true);
}

function uint64(bytes: Uint8Array, offset = 0): bigint {
  if (offset < 0 || offset + 8 > bytes.byteLength) throw diagnostic("corrupt-bag", "truncated uint64 field");
  return view(bytes).getBigUint64(offset, true);
}

function rosTime(bytes: Uint8Array, offset = 0): bigint {
  if (offset < 0 || offset + 8 > bytes.byteLength) throw diagnostic("corrupt-bag", "truncated ROS time field");
  const fields = view(bytes);
  const seconds = fields.getUint32(offset, true);
  const nanos = fields.getUint32(offset + 4, true);
  if (nanos >= 1_000_000_000) throw diagnostic("corrupt-bag", `invalid ROS nanosecond field ${nanos}`);
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos);
}

function field(fields: ReadonlyMap<string, Uint8Array>, name: string, length?: number): Uint8Array {
  const value = fields.get(name);
  if (!value) throw diagnostic("corrupt-bag", `ROS1 bag record is missing required field ${name}`);
  if (length !== undefined && value.byteLength !== length) {
    throw diagnostic("corrupt-bag", `ROS1 bag field ${name} must be ${length} bytes`);
  }
  return value;
}

function optionalString(fields: ReadonlyMap<string, Uint8Array>, name: string): string | undefined {
  const value = fields.get(name);
  if (!value) return undefined;
  try {
    return decoder.decode(value);
  } catch {
    throw diagnostic("corrupt-bag", `ROS1 bag field ${name} is not valid UTF-8`);
  }
}

function requiredString(fields: ReadonlyMap<string, Uint8Array>, name: string): string {
  const value = optionalString(fields, name);
  if (value === undefined) throw diagnostic("corrupt-bag", `ROS1 bag record is missing required field ${name}`);
  return value;
}

function parseHeaderFields(bytes: Uint8Array, limits: Ros1BagLimits): ReadonlyMap<string, Uint8Array> {
  const fields = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) throw diagnostic("corrupt-bag", "truncated ROS1 record header field length");
    const length = uint32(bytes, offset);
    offset += 4;
    if (length === 0 || length > limits.maxHeaderFieldBytes) {
      throw diagnostic("resource-limit", `ROS1 record header field length ${length} exceeds the configured limit`);
    }
    if (offset + length > bytes.byteLength) throw diagnostic("corrupt-bag", "truncated ROS1 record header field");
    const encoded = bytes.subarray(offset, offset + length);
    offset += length;
    const separator = encoded.indexOf(0x3d);
    if (separator <= 0) throw diagnostic("corrupt-bag", "ROS1 record header field is missing a name/value separator");
    let name: string;
    try {
      name = decoder.decode(encoded.subarray(0, separator));
    } catch {
      throw diagnostic("corrupt-bag", "ROS1 record header field name is not valid UTF-8");
    }
    if (fields.has(name)) throw diagnostic("corrupt-bag", `duplicate ROS1 record header field ${name}`);
    fields.set(name, encoded.subarray(separator + 1).slice());
  }
  return fields;
}

async function readExact(reader: Ros1BagReader, offset: bigint, length: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(length) || length < 0) throw diagnostic("resource-limit", "invalid bounded read length");
  try {
    const bytes = await reader.read(offset, BigInt(length));
    if (bytes.byteLength !== length) throw diagnostic("corrupt-bag", "range source returned a truncated ROS1 bag record");
    return bytes;
  } catch (error) {
    if (error instanceof Ros1BagDiagnosticError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/max|limit|exceed|queue/i.test(message)) throw diagnostic("resource-limit", `bounded ROS1 bag read rejected: ${message}`);
    throw diagnostic("corrupt-bag", `bounded ROS1 bag read failed: ${message}`);
  }
}

async function readRecordMeta(
  reader: Ros1BagReader,
  position: bigint,
  end: bigint,
  limits: Ros1BagLimits,
): Promise<RecordMeta> {
  if (position < 0n || position + 8n > end) throw diagnostic("corrupt-bag", "truncated ROS1 bag record prefix");
  const headerLength = uint32(await readExact(reader, position, 4));
  if (headerLength === 0 || headerLength > limits.maxHeaderBytes) {
    throw diagnostic("resource-limit", `ROS1 record header length ${headerLength} exceeds maxHeaderBytes`);
  }
  const headerOffset = position + 4n;
  const dataLengthOffset = headerOffset + BigInt(headerLength);
  if (dataLengthOffset + 4n > end) throw diagnostic("corrupt-bag", "truncated ROS1 bag record header");
  const fields = parseHeaderFields(await readExact(reader, headerOffset, headerLength), limits);
  const opBytes = field(fields, "op", 1);
  const dataLength = uint32(await readExact(reader, dataLengthOffset, 4));
  const dataOffset = dataLengthOffset + 4n;
  const nextPosition = dataOffset + BigInt(dataLength);
  if (nextPosition > end) throw diagnostic("corrupt-bag", "truncated ROS1 bag record data");
  return { position, fields, op: opBytes[0]!, dataOffset, dataLength, nextPosition };
}

function readRecordMetaFromBytes(bytes: Uint8Array, position: number, limits: Ros1BagLimits): RecordMeta {
  if (position < 0 || position + 8 > bytes.byteLength) throw diagnostic("corrupt-bag", "truncated ROS1 chunk record prefix");
  const headerLength = uint32(bytes, position);
  if (headerLength === 0 || headerLength > limits.maxHeaderBytes) {
    throw diagnostic("resource-limit", `ROS1 chunk record header length ${headerLength} exceeds maxHeaderBytes`);
  }
  const headerOffset = position + 4;
  const dataLengthOffset = headerOffset + headerLength;
  if (dataLengthOffset + 4 > bytes.byteLength) throw diagnostic("corrupt-bag", "truncated ROS1 chunk record header");
  const fields = parseHeaderFields(bytes.subarray(headerOffset, dataLengthOffset), limits);
  const op = field(fields, "op", 1)[0]!;
  const dataLength = uint32(bytes, dataLengthOffset);
  const dataOffset = dataLengthOffset + 4;
  const nextPosition = dataOffset + dataLength;
  if (nextPosition > bytes.byteLength) throw diagnostic("corrupt-bag", "truncated ROS1 chunk record data");
  return {
    position: BigInt(position),
    fields,
    op,
    dataOffset: BigInt(dataOffset),
    dataLength,
    nextPosition: BigInt(nextPosition),
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return `sha256:${[...hash].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

async function connectionInfo(
  meta: RecordMeta,
  data: Uint8Array,
  limits: Ros1BagLimits,
  sourceEntryId?: string,
): Promise<Ros1ConnectionInfo> {
  const id = uint32(field(meta.fields, "conn", 4));
  const topic = requiredString(meta.fields, "topic");
  const connectionHeader = parseHeaderFields(data, limits);
  const dataTopic = optionalString(connectionHeader, "topic");
  if (dataTopic !== undefined && dataTopic !== topic) throw diagnostic("corrupt-bag", "ROS1 connection topic fields disagree");
  const typeName = optionalString(connectionHeader, "type") ?? "unknown";
  const md5sum = optionalString(connectionHeader, "md5sum");
  const definition = optionalString(connectionHeader, "message_definition");
  const callerId = optionalString(connectionHeader, "callerid");
  const latching = optionalString(connectionHeader, "latching");
  const hasSchema = Boolean(definition && typeName !== "unknown");
  return {
    id,
    topic,
    typeName,
    md5sum,
    callerId,
    latching: latching === undefined ? undefined : latching === "1",
    schema: hasSchema
      ? {
          capability: "schema-present",
          typeName,
          md5sum,
          definition,
          provenance: [
            {
              providerId: "ros1-connection-definition",
              providerVersion: "1",
              contentHash: await sha256(data),
              sourceEntryId,
            },
          ],
        }
      : {
          capability: "opaque",
          typeName,
          md5sum,
          provenance: [],
          diagnostic: "ROS1 connection has no usable message_definition; bounded raw inspection only",
        },
  };
}

function sameConnection(left: Ros1ConnectionInfo, right: Ros1ConnectionInfo): boolean {
  return (
    left.id === right.id &&
    left.topic === right.topic &&
    left.typeName === right.typeName &&
    left.md5sum === right.md5sum &&
    left.schema.definition === right.schema.definition
  );
}

function indexData(meta: RecordMeta, bytes: Uint8Array, chunkPosition: bigint, limits: Ros1BagLimits): readonly IndexEntry[] {
  const version = uint32(field(meta.fields, "ver", 4));
  if (version !== 1) throw diagnostic("corrupt-bag", `unsupported ROS1 index version ${version}`);
  const connectionId = uint32(field(meta.fields, "conn", 4));
  const count = uint32(field(meta.fields, "count", 4));
  if (count > limits.maxIndexEntries) throw diagnostic("resource-limit", "ROS1 index entry count exceeds maxIndexEntries");
  if (bytes.byteLength !== count * 12) throw diagnostic("corrupt-bag", "ROS1 index data byte count does not match its declared count");
  const entries: IndexEntry[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 12) {
    entries.push({
      connectionId,
      timeNanos: rosTime(bytes, offset),
      chunkPosition,
      offset: uint32(bytes, offset + 8),
    });
  }
  return entries;
}

function chunkInfo(meta: RecordMeta, bytes: Uint8Array, limits: Ros1BagLimits): ChunkInfo {
  const version = uint32(field(meta.fields, "ver", 4));
  if (version !== 1) throw diagnostic("corrupt-bag", `unsupported ROS1 chunk info version ${version}`);
  const count = uint32(field(meta.fields, "count", 4));
  if (count > limits.maxConnections) throw diagnostic("resource-limit", "ROS1 chunk connection count exceeds maxConnections");
  if (bytes.byteLength !== count * 8) throw diagnostic("corrupt-bag", "ROS1 chunk info byte count does not match its declared count");
  const counts = new Map<number, number>();
  for (let offset = 0; offset < bytes.byteLength; offset += 8) {
    const connectionId = uint32(bytes, offset);
    if (counts.has(connectionId)) throw diagnostic("corrupt-bag", `duplicate connection ${connectionId} in ROS1 chunk info`);
    counts.set(connectionId, uint32(bytes, offset + 4));
  }
  return {
    chunkPosition: uint64(field(meta.fields, "chunk_pos", 8)),
    startTimeNanos: rosTime(field(meta.fields, "start_time", 8)),
    endTimeNanos: rosTime(field(meta.fields, "end_time", 8)),
    counts,
  };
}

function parseMessage(
  meta: RecordMeta,
  bytes: Uint8Array,
  connections: ReadonlyMap<number, Ros1ConnectionInfo>,
  sequence: bigint,
  limits: Ros1BagLimits,
): Ros1Message {
  if (meta.op !== OP_MESSAGE_DATA) throw diagnostic("corrupt-bag", "ROS1 index offset does not point to a message record");
  if (bytes.byteLength > limits.maxMessageBytes) throw diagnostic("resource-limit", "ROS1 message exceeds maxMessageBytes");
  const connectionId = uint32(field(meta.fields, "conn", 4));
  const connection = connections.get(connectionId);
  if (!connection) throw diagnostic("corrupt-bag", `ROS1 message references unknown connection ${connectionId}`);
  return {
    connection,
    sequence,
    timeNanos: rosTime(field(meta.fields, "time", 8)),
    data: bytes.slice(),
  };
}

function assertActive(epoch: Ros1EpochController | undefined, expected: number, closed: boolean): void {
  if (closed || (epoch && (epoch.epoch !== expected || epoch.signal.aborted))) {
    throw diagnostic("stale-epoch", "ROS1 bag operation belongs to a stale source epoch");
  }
}

function startEpoch(epoch: Ros1EpochController | undefined, reason: string): number {
  if (epoch?.advance) return epoch.advance(reason);
  return epoch?.epoch ?? 0;
}

async function readChunkBytes(
  reader: Ros1BagReader,
  chunk: ChunkDescriptor,
  limits: Ros1BagLimits,
): Promise<Uint8Array> {
  if (chunk.storedLength > limits.maxStoredChunkBytes) throw diagnostic("resource-limit", "ROS1 chunk exceeds maxStoredChunkBytes");
  const output = new Uint8Array(chunk.storedLength);
  let copied = 0;
  while (copied < chunk.storedLength) {
    const length = Math.min(limits.sequentialReadBytes, chunk.storedLength - copied);
    output.set(await readExact(reader, chunk.dataOffset + BigInt(copied), length), copied);
    copied += length;
  }
  return output;
}

function progress(traversed: bigint, total: bigint): number {
  if (total === 0n) return 1;
  const scaled = Number((traversed * 1_000_000n) / total) / 1_000_000;
  return Math.min(1, Math.max(0, scaled));
}

export class Ros1BagSourceSession {
  readonly mode: "indexed" | "unindexed-degraded";
  readonly diagnostic?: string;
  readonly #reader: Ros1BagReader;
  readonly #limits: Ros1BagLimits;
  readonly #decompressors: Readonly<Partial<Record<"bz2" | "lz4", Ros1ChunkDecompressor>>>;
  readonly #connections = new Map<number, Ros1ConnectionInfo>();
  readonly #chunks = new Map<bigint, ChunkDescriptor>();
  readonly #chunkInfos = new Map<bigint, ChunkInfo>();
  readonly #indexes: IndexEntry[] = [];
  readonly #diagnostics: string[] = [];
  readonly #telemetry: MutableTelemetry;
  readonly #dataStart: bigint;
  readonly #dataEnd: bigint;
  readonly #fileSize: bigint;
  readonly #epoch?: Ros1EpochController;
  #activeEpoch: number;
  #closed = false;

  private constructor(args: {
    reader: Ros1BagReader;
    limits: Ros1BagLimits;
    decompressors: Readonly<Partial<Record<"bz2" | "lz4", Ros1ChunkDecompressor>>>;
    mode: "indexed" | "unindexed-degraded";
    diagnostic?: string;
    dataStart: bigint;
    dataEnd: bigint;
    fileSize: bigint;
    epoch?: Ros1EpochController;
    activeEpoch: number;
  }) {
    this.#reader = args.reader;
    this.#limits = args.limits;
    this.#decompressors = args.decompressors;
    this.mode = args.mode;
    this.diagnostic = args.diagnostic;
    this.#dataStart = args.dataStart;
    this.#dataEnd = args.dataEnd;
    this.#fileSize = args.fileSize;
    this.#epoch = args.epoch;
    this.#activeEpoch = args.activeEpoch;
    this.#telemetry = {
      mode: args.mode,
      logicalBytesTraversed: 0n,
      messagesRead: 0,
      chunksVisited: 0,
      decompressedBytes: 0,
      unsupportedChunks: 0,
    };
  }

  static async openBundle(
    bundle: Ros1SourceBundle,
    resolveReader: Ros1BundleReaderResolver,
    epoch?: Ros1EpochController,
    options: Ros1BagOpenOptions = {},
  ): Promise<Ros1BagSourceSession> {
    if (!bundle.bundleId || bundle.version !== 1 || bundle.entries.length === 0) {
      throw diagnostic("corrupt-bag", "ROS1 SourceBundle requires an id, version 1, and entries");
    }
    const bagEntries = bundle.entries.filter((entry) => entry.relativePath.toLowerCase().endsWith(".bag"));
    if (bagEntries.length !== 1) {
      throw diagnostic(
        "unsupported-codec",
        `ROS1 SourceBundle requires exactly one .bag entry; multipart ROS1 bags are unsupported (found ${bagEntries.length})`,
        "multipart",
      );
    }
    const entry = bagEntries[0]!;
    const reader = await resolveReader(entry);
    const actualSize = await reader.size();
    if (actualSize !== entry.sizeBytes) throw diagnostic("corrupt-bag", "ROS1 SourceBundle entry size does not match its immutable range source");
    return Ros1BagSourceSession.open(reader, epoch, { ...options, sourceEntryId: entry.entryId });
  }

  static async open(
    reader: Ros1BagReader,
    epoch?: Ros1EpochController,
    options: Ros1BagOpenOptions = {},
  ): Promise<Ros1BagSourceSession> {
    const limits = Object.freeze({ ...(options.limits ?? DEFAULT_ROS1_BAG_LIMITS) });
    assertLimits(limits);
    const activeEpoch = startEpoch(epoch, "ROS1 bag opened");
    const fileSize = await reader.size();
    if (fileSize < BigInt(BAG_MAGIC.byteLength + 8)) throw diagnostic("corrupt-bag", "ROS1 bag is truncated before its file header");
    const magic = await readExact(reader, 0n, BAG_MAGIC.byteLength);
    if (!bytesEqual(magic, BAG_MAGIC)) throw diagnostic("corrupt-bag", "unsupported ROS1 bag magic/version; expected #ROSBAG V2.0");
    assertActive(epoch, activeEpoch, false);
    const fileHeader = await readRecordMeta(reader, BigInt(BAG_MAGIC.byteLength), fileSize, limits);
    if (fileHeader.op !== OP_BAG_HEADER) throw diagnostic("corrupt-bag", "ROS1 bag does not begin with a bag header record");
    const indexPosition = uint64(field(fileHeader.fields, "index_pos", 8));
    const declaredConnections = uint32(field(fileHeader.fields, "conn_count", 4));
    const declaredChunks = uint32(field(fileHeader.fields, "chunk_count", 4));
    if (declaredConnections > limits.maxConnections) throw diagnostic("resource-limit", "ROS1 bag connection count exceeds maxConnections");
    if (declaredChunks > limits.maxChunks) throw diagnostic("resource-limit", "ROS1 bag chunk count exceeds maxChunks");
    if (indexPosition !== 0n && (indexPosition < fileHeader.nextPosition || indexPosition >= fileSize)) {
      throw diagnostic("corrupt-bag", "ROS1 bag index_pos is outside the recording data region");
    }
    const mode = indexPosition === 0n ? "unindexed-degraded" : "indexed";
    const session = new Ros1BagSourceSession({
      reader,
      limits,
      decompressors: options.decompressors ?? {},
      mode,
      diagnostic: mode === "unindexed-degraded" ? "ROS1 bag has no finalized index; sequential degraded scan is required" : undefined,
      dataStart: fileHeader.nextPosition,
      dataEnd: indexPosition === 0n ? fileSize : indexPosition,
      fileSize,
      epoch,
      activeEpoch,
    });
    await session.#initialize(options.sourceEntryId, declaredConnections, declaredChunks, indexPosition);
    return session;
  }

  async #initialize(
    sourceEntryId: string | undefined,
    declaredConnections: number,
    declaredChunks: number,
    indexPosition: bigint,
  ): Promise<void> {
    if (indexPosition !== 0n) {
      let position = indexPosition;
      while (position < this.#fileSize) {
        assertActive(this.#epoch, this.#activeEpoch, this.#closed);
        const meta = await readRecordMeta(this.#reader, position, this.#fileSize, this.#limits);
        if (meta.dataLength > this.#limits.maxRecordBytes) throw diagnostic("resource-limit", "ROS1 index record exceeds maxRecordBytes");
        const data = await readExact(this.#reader, meta.dataOffset, meta.dataLength);
        if (meta.op === OP_CONNECTION) await this.#registerConnection(meta, data, sourceEntryId);
        else if (meta.op === OP_CHUNK_INFO) {
          const info = chunkInfo(meta, data, this.#limits);
          if (this.#chunkInfos.has(info.chunkPosition)) throw diagnostic("corrupt-bag", "duplicate ROS1 chunk info position");
          this.#chunkInfos.set(info.chunkPosition, info);
        } else {
          throw diagnostic("corrupt-bag", `unexpected ROS1 record op 0x${meta.op.toString(16)} in index section`);
        }
        position = meta.nextPosition;
      }
    }

    let position = this.#dataStart;
    let activeChunk: ChunkDescriptor | undefined;
    while (position < this.#dataEnd) {
      assertActive(this.#epoch, this.#activeEpoch, this.#closed);
      const meta = await readRecordMeta(this.#reader, position, this.#dataEnd, this.#limits);
      if (meta.op === OP_CHUNK) {
        if (this.#chunks.size >= this.#limits.maxChunks) throw diagnostic("resource-limit", "ROS1 bag exceeds maxChunks");
        const compression = requiredString(meta.fields, "compression");
        const declaredSize = uint32(field(meta.fields, "size", 4));
        if (meta.dataLength > this.#limits.maxStoredChunkBytes) throw diagnostic("resource-limit", "ROS1 chunk exceeds maxStoredChunkBytes");
        if (declaredSize > this.#limits.maxDecompressedChunkBytes) {
          throw diagnostic("resource-limit", "ROS1 chunk exceeds maxDecompressedChunkBytes");
        }
        if (compression === "none" && declaredSize !== meta.dataLength) {
          throw diagnostic("corrupt-bag", "uncompressed ROS1 chunk stored length does not match declared size");
        }
        activeChunk = {
          position: meta.position,
          compression,
          declaredSize,
          dataOffset: meta.dataOffset,
          storedLength: meta.dataLength,
        };
        this.#chunks.set(meta.position, activeChunk);
        if (compression !== "none" && !this.#decompressors[compression as "bz2" | "lz4"]) {
          this.#diagnostics.push(`unsupported ROS1 bag chunk codec "${compression}" at byte ${meta.position}`);
          this.#telemetry.unsupportedChunks += 1;
        }
      } else if (meta.op === OP_INDEX_DATA) {
        if (!activeChunk) throw diagnostic("corrupt-bag", "ROS1 index data appears before a chunk record");
        if (meta.dataLength > this.#limits.maxRecordBytes) throw diagnostic("resource-limit", "ROS1 index data exceeds maxRecordBytes");
        const entries = indexData(meta, await readExact(this.#reader, meta.dataOffset, meta.dataLength), activeChunk.position, this.#limits);
        if (this.#indexes.length + entries.length > this.#limits.maxIndexEntries) {
          throw diagnostic("resource-limit", "ROS1 bag exceeds maxIndexEntries");
        }
        this.#indexes.push(...entries);
      } else if (meta.op === OP_CONNECTION) {
        if (meta.dataLength > this.#limits.maxRecordBytes) throw diagnostic("resource-limit", "ROS1 connection record exceeds maxRecordBytes");
        await this.#registerConnection(meta, await readExact(this.#reader, meta.dataOffset, meta.dataLength), sourceEntryId);
      } else if (meta.op === OP_MESSAGE_DATA) {
        activeChunk = undefined;
      } else {
        throw diagnostic("corrupt-bag", `unexpected ROS1 record op 0x${meta.op.toString(16)} in data section`);
      }
      this.#telemetry.logicalBytesTraversed += meta.nextPosition - position;
      position = meta.nextPosition;
    }

    if (indexPosition !== 0n) {
      if (this.#connections.size !== declaredConnections) {
        throw diagnostic("corrupt-bag", `ROS1 connection count mismatch: header ${declaredConnections}, parsed ${this.#connections.size}`);
      }
      if (this.#chunks.size !== declaredChunks || this.#chunkInfos.size !== declaredChunks) {
        throw diagnostic(
          "corrupt-bag",
          `ROS1 chunk count mismatch: header ${declaredChunks}, data ${this.#chunks.size}, index ${this.#chunkInfos.size}`,
        );
      }
      for (const entry of this.#indexes) {
        if (!this.#connections.has(entry.connectionId)) throw diagnostic("corrupt-bag", "ROS1 index references an unknown connection");
        const chunk = this.#chunks.get(entry.chunkPosition);
        if (!chunk || entry.offset >= chunk.declaredSize) throw diagnostic("corrupt-bag", "ROS1 index references an invalid chunk offset");
      }
      const indexedCounts = new Map<bigint, Map<number, number>>();
      for (const entry of this.#indexes) {
        let byConnection = indexedCounts.get(entry.chunkPosition);
        if (!byConnection) {
          byConnection = new Map();
          indexedCounts.set(entry.chunkPosition, byConnection);
        }
        byConnection.set(entry.connectionId, (byConnection.get(entry.connectionId) ?? 0) + 1);
      }
      for (const [chunkPosition, info] of this.#chunkInfos) {
        if (!this.#chunks.has(chunkPosition)) throw diagnostic("corrupt-bag", "ROS1 chunk info references an unknown chunk");
        for (const [connectionId, expectedCount] of info.counts) {
          if (!this.#connections.has(connectionId)) throw diagnostic("corrupt-bag", "ROS1 chunk info references an unknown connection");
          const indexedCount = indexedCounts.get(chunkPosition)?.get(connectionId) ?? 0;
          if (indexedCount !== expectedCount) {
            throw diagnostic(
              "corrupt-bag",
              `ROS1 index count mismatch for connection ${connectionId} in chunk ${chunkPosition}: expected ${expectedCount}, parsed ${indexedCount}`,
            );
          }
        }
        for (const connectionId of indexedCounts.get(chunkPosition)?.keys() ?? []) {
          if (!info.counts.has(connectionId)) {
            throw diagnostic("corrupt-bag", `ROS1 index contains connection ${connectionId} absent from its chunk info`);
          }
        }
      }
    }
  }

  async #registerConnection(meta: RecordMeta, data: Uint8Array, sourceEntryId?: string): Promise<void> {
    const connection = await connectionInfo(meta, data, this.#limits, sourceEntryId);
    const existing = this.#connections.get(connection.id);
    if (existing && !sameConnection(existing, connection)) throw diagnostic("corrupt-bag", `conflicting ROS1 connection ${connection.id}`);
    if (!existing && this.#connections.size >= this.#limits.maxConnections) {
      throw diagnostic("resource-limit", "ROS1 bag exceeds maxConnections");
    }
    this.#connections.set(connection.id, connection);
  }

  channels(): readonly Ros1ConnectionInfo[] {
    assertActive(this.#epoch, this.#activeEpoch, this.#closed);
    return [...this.#connections.values()].sort((left, right) => left.id - right.id);
  }

  diagnostics(): readonly string[] {
    return [...this.#diagnostics];
  }

  timeRange(): Ros1TimeRange | undefined {
    assertActive(this.#epoch, this.#activeEpoch, this.#closed);
    const infos = [...this.#chunkInfos.values()];
    if (infos.length === 0) return undefined;
    let startTimeNanos = infos[0]!.startTimeNanos;
    let endTimeNanos = infos[0]!.endTimeNanos;
    for (const info of infos.slice(1)) {
      if (info.startTimeNanos < startTimeNanos) startTimeNanos = info.startTimeNanos;
      if (info.endTimeNanos > endTimeNanos) endTimeNanos = info.endTimeNanos;
    }
    return { startTimeNanos, endTimeNanos };
  }

  async *readIndexed(options: {
    readonly topics?: readonly string[];
    readonly startTime?: bigint;
    readonly endTime?: bigint;
  } = {}): AsyncGenerator<Ros1Message, void, void> {
    if (this.mode !== "indexed") throw diagnostic("corrupt-bag", "random seek is unavailable for an unindexed ROS1 bag");
    this.#activeEpoch = startEpoch(this.#epoch, "ROS1 bag indexed seek");
    const topicSet = options.topics ? new Set(options.topics) : undefined;
    const selected = this.#indexes
      .filter((entry) => {
        const connection = this.#connections.get(entry.connectionId);
        return (
          connection !== undefined &&
          (!topicSet || topicSet.has(connection.topic)) &&
          (options.startTime === undefined || entry.timeNanos >= options.startTime) &&
          (options.endTime === undefined || entry.timeNanos <= options.endTime)
        );
      })
      .sort((left, right) => {
        if (left.timeNanos !== right.timeNanos) return left.timeNanos < right.timeNanos ? -1 : 1;
        if (left.connectionId !== right.connectionId) return left.connectionId - right.connectionId;
        if (left.chunkPosition !== right.chunkPosition) return left.chunkPosition < right.chunkPosition ? -1 : 1;
        return left.offset - right.offset;
      });
    const decompressed = new Map<bigint, Uint8Array>();
    let sequence = 0n;
    for (const entry of selected) {
      assertActive(this.#epoch, this.#activeEpoch, this.#closed);
      const chunk = this.#chunks.get(entry.chunkPosition);
      if (!chunk) throw diagnostic("corrupt-bag", "ROS1 index references a missing chunk");
      const message = await this.#messageAt(chunk, entry.offset, sequence, decompressed);
      if (message.connection.id !== entry.connectionId || message.timeNanos !== entry.timeNanos) {
        throw diagnostic("corrupt-bag", "ROS1 message record disagrees with its index entry");
      }
      this.#telemetry.messagesRead += 1;
      sequence += 1n;
      yield message;
    }
  }

  async #messageAt(
    chunk: ChunkDescriptor,
    offset: number,
    sequence: bigint,
    decompressed: Map<bigint, Uint8Array>,
  ): Promise<Ros1Message> {
    this.#telemetry.chunksVisited += 1;
    if (chunk.compression === "none") {
      const position = chunk.dataOffset + BigInt(offset);
      const meta = await readRecordMeta(this.#reader, position, chunk.dataOffset + BigInt(chunk.storedLength), this.#limits);
      if (meta.dataLength > this.#limits.maxMessageBytes) throw diagnostic("resource-limit", "ROS1 message exceeds maxMessageBytes");
      return parseMessage(
        meta,
        await readExact(this.#reader, meta.dataOffset, meta.dataLength),
        this.#connections,
        sequence,
        this.#limits,
      );
    }
    let bytes = decompressed.get(chunk.position);
    if (!bytes) {
      bytes = await this.#decompressChunk(chunk);
      decompressed.set(chunk.position, bytes);
    }
    const meta = readRecordMetaFromBytes(bytes, offset, this.#limits);
    return parseMessage(
      meta,
      bytes.subarray(Number(meta.dataOffset), Number(meta.nextPosition)).slice(0, meta.dataLength),
      this.#connections,
      sequence,
      this.#limits,
    );
  }

  async #decompressChunk(chunk: ChunkDescriptor): Promise<Uint8Array> {
    const handler = this.#decompressors[chunk.compression as "bz2" | "lz4"];
    if (!handler) {
      throw diagnostic(
        "unsupported-codec",
        `unsupported ROS1 bag chunk codec "${chunk.compression}"; provide a bounded decoder adapter`,
        chunk.compression,
      );
    }
    if (chunk.declaredSize > this.#limits.maxDecompressedChunkBytes) {
      throw diagnostic("resource-limit", `${chunk.compression} chunk exceeds maxDecompressedChunkBytes`);
    }
    const ratio = chunk.storedLength === 0 ? Number.POSITIVE_INFINITY : chunk.declaredSize / chunk.storedLength;
    if (ratio > this.#limits.maxDecompressionRatio) {
      throw diagnostic("resource-limit", `${chunk.compression} chunk exceeds maxDecompressionRatio`);
    }
    const stored = await readChunkBytes(this.#reader, chunk, this.#limits);
    const output = await handler(stored, chunk.declaredSize, this.#epoch?.signal ?? new AbortController().signal);
    assertActive(this.#epoch, this.#activeEpoch, this.#closed);
    if (output.byteLength !== chunk.declaredSize) {
      throw diagnostic("corrupt-bag", `${chunk.compression} decoder returned an unexpected byte count`);
    }
    this.#telemetry.decompressedBytes += output.byteLength;
    if (this.#telemetry.decompressedBytes > this.#limits.maxTotalDecompressedBytes) {
      throw diagnostic("resource-limit", "ROS1 session exceeds maxTotalDecompressedBytes");
    }
    return output;
  }

  async *scanUnindexed(options: { readonly topics?: readonly string[] } = {}): AsyncGenerator<Ros1SequentialEvent, void, void> {
    if (this.mode !== "unindexed-degraded") {
      throw diagnostic("corrupt-bag", "sequential degraded scan is only available for an unindexed ROS1 bag");
    }
    this.#activeEpoch = startEpoch(this.#epoch, "ROS1 bag sequential scan");
    const topicSet = options.topics ? new Set(options.topics) : undefined;
    let position = this.#dataStart;
    let sequence = 0n;
    while (position < this.#dataEnd) {
      assertActive(this.#epoch, this.#activeEpoch, this.#closed);
      const meta = await readRecordMeta(this.#reader, position, this.#dataEnd, this.#limits);
      if (meta.op === OP_CONNECTION) {
        if (meta.dataLength > this.#limits.maxRecordBytes) throw diagnostic("resource-limit", "ROS1 connection record exceeds maxRecordBytes");
        await this.#registerConnection(meta, await readExact(this.#reader, meta.dataOffset, meta.dataLength));
      } else if (meta.op === OP_MESSAGE_DATA) {
        const message = parseMessage(
          meta,
          await readExact(this.#reader, meta.dataOffset, meta.dataLength),
          this.#connections,
          sequence,
          this.#limits,
        );
        if (!topicSet || topicSet.has(message.connection.topic)) {
          this.#telemetry.messagesRead += 1;
          sequence += 1n;
          yield { kind: "message", message };
        }
      } else if (meta.op === OP_CHUNK) {
        const chunk = this.#chunks.get(meta.position);
        if (!chunk) throw diagnostic("corrupt-bag", "ROS1 sequential scan encountered an unregistered chunk");
        this.#telemetry.chunksVisited += 1;
        const bytes = chunk.compression === "none" ? undefined : await this.#decompressChunk(chunk);
        let chunkOffset = 0;
        while (chunkOffset < chunk.declaredSize) {
          let chunkMeta: RecordMeta;
          let data: Uint8Array;
          if (bytes) {
            chunkMeta = readRecordMetaFromBytes(bytes, chunkOffset, this.#limits);
            data = bytes.subarray(Number(chunkMeta.dataOffset), Number(chunkMeta.dataOffset) + chunkMeta.dataLength);
          } else {
            chunkMeta = await readRecordMeta(
              this.#reader,
              chunk.dataOffset + BigInt(chunkOffset),
              chunk.dataOffset + BigInt(chunk.storedLength),
              this.#limits,
            );
            if (chunkMeta.dataLength > this.#limits.maxRecordBytes) throw diagnostic("resource-limit", "ROS1 chunk record exceeds maxRecordBytes");
            data = await readExact(this.#reader, chunkMeta.dataOffset, chunkMeta.dataLength);
          }
          if (chunkMeta.op === OP_CONNECTION) await this.#registerConnection(chunkMeta, data);
          else if (chunkMeta.op === OP_MESSAGE_DATA) {
            const message = parseMessage(chunkMeta, data, this.#connections, sequence, this.#limits);
            if (!topicSet || topicSet.has(message.connection.topic)) {
              this.#telemetry.messagesRead += 1;
              sequence += 1n;
              yield { kind: "message", message };
            }
          } else {
            throw diagnostic("corrupt-bag", `unexpected ROS1 record op 0x${chunkMeta.op.toString(16)} inside chunk`);
          }
          chunkOffset = bytes
            ? Number(chunkMeta.nextPosition)
            : Number(chunkMeta.nextPosition - chunk.dataOffset);
        }
      }
      position = meta.nextPosition;
      this.#telemetry.logicalBytesTraversed += meta.nextPosition - meta.position;
      yield {
        kind: "progress",
        traversedBytes: position - this.#dataStart,
        totalBytes: this.#dataEnd - this.#dataStart,
        progress: progress(position - this.#dataStart, this.#dataEnd - this.#dataStart),
      };
    }
  }

  telemetry(): Ros1BagTelemetry {
    return { ...this.#telemetry };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#epoch?.advance) this.#epoch.advance("ROS1 bag closed");
  }
}
