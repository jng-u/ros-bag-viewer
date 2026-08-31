import { McapSourceSession, type McapChannelInfo, type McapLimits } from "@ros-web-viewer/source-mcap";
import {
  BlobRangeSource,
  BoundedByteReader,
  DEFAULT_WORKER_LIMITS,
  SourceEpochController,
  type ReadTelemetry,
  type WorkerResourceLimits,
} from "@ros-web-viewer/worker-runtime";

export interface SemanticDecodeLimits {
  readonly maxMessageBytes: number;
  readonly maxStringBytes: number;
  readonly maxPointFields: number;
  readonly maxPointDataBytes: number;
  readonly maxPoints: number;
  readonly maxPathPoses: number;
}

export const DEFAULT_SEMANTIC_DECODE_LIMITS: SemanticDecodeLimits = {
  maxMessageBytes: 16 * 1024 * 1024,
  maxStringBytes: 64 * 1024,
  maxPointFields: 64,
  maxPointDataBytes: 16 * 1024 * 1024,
  maxPoints: 1_000_000,
  maxPathPoses: 100_000,
};

export interface SemanticMcapMessage {
  readonly channel: {
    readonly schema: { readonly name: string; readonly capability: "schema-present" | "opaque" };
  };
  readonly data: Uint8Array;
}

export interface DecodedPointCloud2 {
  readonly kind: "pointcloud2";
  readonly message: {
    readonly frameId: string;
    readonly width: number;
    readonly height: number;
    readonly pointStep: number;
    readonly rowStep: number;
    readonly isBigEndian: boolean;
    readonly fields: readonly { readonly name: string; readonly offset: number; readonly datatype: number; readonly count: number }[];
    readonly data: Uint8Array;
  };
}

export interface DecodedPath {
  readonly kind: "path";
  readonly message: {
    readonly frameId: string;
    readonly poses: readonly { readonly position: { readonly x: number; readonly y: number; readonly z: number } }[];
  };
}

export type DecodedSemanticMessage = DecodedPointCloud2 | DecodedPath;

export type SemanticDisplayPort =
  | {
      readonly kind: "pointcloud2";
      update(message: DecodedPointCloud2["message"], epoch: number): unknown;
      render(): void;
    }
  | {
      readonly kind: "path";
      update(message: DecodedPath["message"], epoch: number): unknown;
      render(): void;
    };

export interface PayloadLeasePort {
  assertUsable(epoch: number): void;
  release(): void;
}

function assertSemanticDecodeLimits(limits: SemanticDecodeLimits): void {
  const names = [
    "maxMessageBytes",
    "maxStringBytes",
    "maxPointFields",
    "maxPointDataBytes",
    "maxPoints",
    "maxPathPoses",
  ] as const;
  for (const name of names) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
    if (value > DEFAULT_SEMANTIC_DECODE_LIMITS[name]) {
      throw new Error(`${name} cannot exceed the hard semantic decode limit`);
    }
  }
  if (limits.maxStringBytes > limits.maxMessageBytes) {
    throw new Error("maxStringBytes cannot exceed maxMessageBytes");
  }
  if (limits.maxPointDataBytes > limits.maxMessageBytes) {
    throw new Error("maxPointDataBytes cannot exceed maxMessageBytes");
  }
}

class CdrReader {
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  readonly #littleEndian: boolean;
  readonly #origin = 4;
  readonly #limits: SemanticDecodeLimits;
  #offset = 4;

  constructor(bytes: Uint8Array, limits: SemanticDecodeLimits) {
    if (bytes.byteLength > limits.maxMessageBytes) throw new Error("CDR message exceeds maxMessageBytes");
    if (bytes.byteLength < 4) throw new Error("CDR message is missing the encapsulation header");
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const representation = this.#view.getUint16(0, false);
    if (representation !== 0 && representation !== 1) throw new Error(`unsupported CDR representation ${representation}`);
    this.#littleEndian = representation === 1;
    this.#limits = limits;
  }

  uint8(): number {
    this.#require(1);
    return this.#view.getUint8(this.#offset++);
  }

  uint32(): number {
    this.#align(4);
    this.#require(4);
    const value = this.#view.getUint32(this.#offset, this.#littleEndian);
    this.#offset += 4;
    return value;
  }

  int32(): number {
    this.#align(4);
    this.#require(4);
    const value = this.#view.getInt32(this.#offset, this.#littleEndian);
    this.#offset += 4;
    return value;
  }

  float64(): number {
    this.#align(8);
    this.#require(8);
    const value = this.#view.getFloat64(this.#offset, this.#littleEndian);
    this.#offset += 8;
    if (!Number.isFinite(value)) throw new Error("CDR geometry contains a non-finite value");
    return value;
  }

  string(): string {
    const length = this.uint32();
    if (length < 1 || length > this.#limits.maxStringBytes) throw new Error("CDR string length exceeds limits");
    this.#require(length);
    if (this.#bytes[this.#offset + length - 1] !== 0) throw new Error("CDR string is not null terminated");
    const value = new TextDecoder("utf-8", { fatal: true }).decode(this.#bytes.subarray(this.#offset, this.#offset + length - 1));
    this.#offset += length;
    return value;
  }

  byteSequence(maxBytes: number): Uint8Array {
    const length = this.uint32();
    if (length > maxBytes) throw new Error("CDR byte sequence exceeds limits");
    this.#require(length);
    const value = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  header(): { readonly frameId: string; readonly stampNanos: bigint } {
    const seconds = this.int32();
    const nanoseconds = this.uint32();
    if (nanoseconds >= 1_000_000_000) throw new Error("ROS header nanoseconds are invalid");
    return { frameId: this.string(), stampNanos: BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds) };
  }

  ensureConsumed(): void {
    if (this.#offset !== this.#bytes.byteLength) throw new Error("CDR message has unexpected trailing bytes");
  }

  #align(alignment: number): void {
    const relative = this.#offset - this.#origin;
    this.#offset += (alignment - (relative % alignment)) % alignment;
  }

  #require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.#offset + length > this.#bytes.byteLength) {
      throw new Error("CDR message is truncated");
    }
  }
}

function normalizedSchemaName(name: string): string {
  return name.replace("/msg/", "/");
}

export function availableDisplaysForSchema(
  schemaName: string,
  capability: "schema-present" | "opaque" = "schema-present",
): readonly ("point-cloud" | "path" | "raw")[] {
  if (capability === "opaque") return [];
  switch (normalizedSchemaName(schemaName)) {
    case "sensor_msgs/PointCloud2":
      return ["point-cloud", "raw"];
    case "nav_msgs/Path":
      return ["path", "raw"];
    default:
      return ["raw"];
  }
}

export function decodeSemanticMessage(
  input: SemanticMcapMessage,
  limits: SemanticDecodeLimits = DEFAULT_SEMANTIC_DECODE_LIMITS,
): DecodedSemanticMessage {
  assertSemanticDecodeLimits(limits);
  if (input.channel.schema.capability !== "schema-present") throw new Error("semantic decoding requires a present schema");
  const reader = new CdrReader(input.data, limits);
  const schema = normalizedSchemaName(input.channel.schema.name);
  if (schema === "sensor_msgs/PointCloud2") {
    const header = reader.header();
    const height = reader.uint32();
    const width = reader.uint32();
    const pointCount = height * width;
    if (!Number.isSafeInteger(pointCount) || pointCount > limits.maxPoints) throw new Error("PointCloud2 point count exceeds limits");
    const fieldCount = reader.uint32();
    if (fieldCount > limits.maxPointFields) throw new Error("PointCloud2 field count exceeds limits");
    const fields = Array.from({ length: fieldCount }, () => ({
      name: reader.string(),
      offset: reader.uint32(),
      datatype: reader.uint8(),
      count: reader.uint32(),
    }));
    const isBigEndian = reader.uint8() !== 0;
    const pointStep = reader.uint32();
    const rowStep = reader.uint32();
    const data = reader.byteSequence(limits.maxPointDataBytes);
    reader.uint8(); // is_dense is display-irrelevant but must be consumed.
    reader.ensureConsumed();
    if (rowStep * height !== data.byteLength || pointStep * width > rowStep) {
      throw new Error("PointCloud2 dimensions do not match its bounded data sequence");
    }
    return {
      kind: "pointcloud2",
      message: { frameId: header.frameId, width, height, pointStep, rowStep, isBigEndian, fields, data },
    };
  }
  if (schema === "nav_msgs/Path") {
    const header = reader.header();
    const poseCount = reader.uint32();
    if (poseCount > limits.maxPathPoses) throw new Error("Path pose count exceeds limits");
    const poses = Array.from({ length: poseCount }, () => {
      reader.header();
      const position = { x: reader.float64(), y: reader.float64(), z: reader.float64() };
      reader.float64();
      reader.float64();
      reader.float64();
      reader.float64();
      return { position };
    });
    reader.ensureConsumed();
    return { kind: "path", message: { frameId: header.frameId, poses } };
  }
  throw new Error(`no native semantic decoder for ${input.channel.schema.name}`);
}

export function decodeRenderAndRelease(
  input: SemanticMcapMessage,
  epoch: number,
  lease: PayloadLeasePort,
  display: SemanticDisplayPort,
  limits: SemanticDecodeLimits = DEFAULT_SEMANTIC_DECODE_LIMITS,
): unknown {
  lease.assertUsable(epoch);
  try {
    const decoded = decodeSemanticMessage(input, limits);
    let summary: unknown;
    if (decoded.kind === "pointcloud2") {
      if (display.kind !== "pointcloud2") throw new Error("decoded pointcloud2 cannot update path display");
      summary = display.update(decoded.message, epoch);
    } else {
      if (display.kind !== "path") throw new Error("decoded path cannot update pointcloud2 display");
      summary = display.update(decoded.message, epoch);
    }
    display.render();
    return summary;
  } finally {
    lease.release();
  }
}

export interface LocalMcapSelection {
  readonly name: string;
  readonly sizeBytes: number;
  readonly immutableVersion: string;
  readonly blob?: Blob;
}

export interface LocalMcapTopicSummary {
  readonly id: string;
  readonly name: string;
  readonly typeName: string;
  readonly compatibility: "native-display" | "schema-backed-generic" | "opaque-inspectable";
  readonly schemaCapability: "schema-present" | "opaque";
  readonly availableDisplays: readonly ("point-cloud" | "path" | "raw")[];
}

export interface LocalMcapOpenResult {
  readonly sourceLabel: string;
  readonly sourceHash: string;
  readonly durationNanos: bigint;
  readonly epoch: number;
  readonly indexState: "indexed" | "sequential";
  readonly topics: readonly LocalMcapTopicSummary[];
  readonly diagnostic?: string;
}

export interface LocalMcapSeekResult {
  readonly epoch: number;
  readonly currentTimeNanos: bigint;
  readonly diagnostic?: string;
}

const DEFAULT_DESKTOP_MCAP_LIMITS: McapLimits = {
  sequentialReadBytes: 256 * 1024,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxDecompressedBytes: 64 * 1024 * 1024,
  maxDecompressionRatio: 100,
  maxMessageIndexCacheBytes: 8 * 1024 * 1024,
};

function topicSummary(channel: McapChannelInfo): LocalMcapTopicSummary {
  const displays = availableDisplaysForSchema(channel.schema.name, channel.schema.capability);
  return {
    id: String(channel.id),
    name: channel.topic,
    typeName: channel.schema.name,
    compatibility:
      displays.some((display) => display !== "raw")
        ? "native-display"
        : channel.schema.capability === "schema-present"
          ? "schema-backed-generic"
          : "opaque-inspectable",
    schemaCapability: channel.schema.capability,
    availableDisplays: displays,
  };
}

export class LocalMcapDesktopRuntime {
  readonly #epoch = new SourceEpochController();
  readonly #workerLimits: WorkerResourceLimits;
  readonly #mcapLimits: McapLimits;
  #blob?: Blob;
  #mode?: "indexed" | "unindexed-degraded";
  #startTime = 0n;
  #duration = 0n;
  #lastReadTelemetry?: Readonly<ReadTelemetry>;

  constructor(
    workerLimits: WorkerResourceLimits = DEFAULT_WORKER_LIMITS,
    mcapLimits: McapLimits = DEFAULT_DESKTOP_MCAP_LIMITS,
  ) {
    this.#workerLimits = workerLimits;
    this.#mcapLimits = mcapLimits;
  }

  async openLocalMcap(selection: LocalMcapSelection): Promise<LocalMcapOpenResult> {
    if (selection.name.trim().length === 0) throw new Error("local MCAP selection name cannot be empty");
    if (selection.immutableVersion.trim().length === 0) {
      throw new Error("local MCAP selection immutable version cannot be empty");
    }
    if (!Number.isSafeInteger(selection.sizeBytes) || selection.sizeBytes < 0) {
      throw new Error("local MCAP selection size must be a non-negative safe integer");
    }
    if (!selection.blob) throw new Error("local MCAP selection is missing its Blob handle");
    if (selection.sizeBytes !== selection.blob.size) throw new Error("local MCAP selection size does not match its Blob");
    this.#epoch.advance("local MCAP opened");
    this.#blob = undefined;
    this.#mode = undefined;
    this.#startTime = 0n;
    this.#duration = 0n;
    this.#lastReadTelemetry = undefined;
    const { reader, session } = await this.#openSession(selection.blob);
    const channels = new Map<number, McapChannelInfo>();
    for (const channel of session.channels()) channels.set(channel.id, channel);
    let minimumTime: bigint | undefined;
    let maximumTime: bigint | undefined;
    const accept = (logTimeNanos: bigint, channel: McapChannelInfo): void => {
      channels.set(channel.id, channel);
      minimumTime = minimumTime === undefined || logTimeNanos < minimumTime ? logTimeNanos : minimumTime;
      maximumTime = maximumTime === undefined || logTimeNanos > maximumTime ? logTimeNanos : maximumTime;
    };
    if (session.mode === "indexed") {
      const range = session.timeRange();
      if (range) {
        minimumTime = range.startTimeNanos;
        maximumTime = range.endTimeNanos;
      }
      if (channels.size === 0) {
        for await (const message of session.readIndexed()) accept(message.logTimeNanos, message.channel);
      }
    } else {
      for await (const event of session.scanUnindexed()) {
        if (event.kind === "message") accept(event.message.logTimeNanos, event.message.channel);
      }
    }
    this.#lastReadTelemetry = reader.snapshotTelemetry();
    this.#startTime = minimumTime ?? 0n;
    this.#duration = minimumTime === undefined || maximumTime === undefined ? 0n : maximumTime - minimumTime;
    this.#blob = selection.blob;
    this.#mode = session.mode;
    return {
      sourceLabel: selection.name,
      sourceHash: selection.immutableVersion,
      durationNanos: this.#duration,
      epoch: this.#epoch.epoch,
      indexState: session.mode === "indexed" ? "indexed" : "sequential",
      topics: [...channels.values()].sort((left, right) => left.id - right.id).map(topicSummary),
      ...(session.diagnostic === undefined ? {} : { diagnostic: session.diagnostic }),
    };
  }

  async seek(timeNanos: bigint): Promise<LocalMcapSeekResult> {
    if (!this.#blob || !this.#mode) throw new Error("open a local MCAP source before seeking");
    const boundedTime = timeNanos < 0n ? 0n : timeNanos > this.#duration ? this.#duration : timeNanos;
    this.#epoch.advance("local MCAP seek");
    const { reader, session } = await this.#openSession(this.#blob);
    this.#lastReadTelemetry = reader.snapshotTelemetry();
    if (this.#mode === "unindexed-degraded" || session.mode !== "indexed") {
      return {
        epoch: this.#epoch.epoch,
        currentTimeNanos: 0n,
        diagnostic: "Unindexed MCAP remains in sequential degraded mode; random seek is unavailable.",
      };
    }
    const absolute = this.#startTime + boundedTime;
    await session.readIndexed({ startTime: absolute, endTime: absolute + 1n }).next();
    this.#lastReadTelemetry = reader.snapshotTelemetry();
    return { epoch: this.#epoch.epoch, currentTimeNanos: boundedTime };
  }

  readTelemetry(): Readonly<ReadTelemetry> | undefined {
    return this.#lastReadTelemetry;
  }

  async #openSession(blob: Blob): Promise<{ readonly reader: BoundedByteReader; readonly session: McapSourceSession }> {
    const reader = new BoundedByteReader(new BlobRangeSource(blob), this.#epoch, this.#workerLimits);
    const session = await McapSourceSession.open(reader, { limits: this.#mcapLimits });
    return { reader, session };
  }
}
