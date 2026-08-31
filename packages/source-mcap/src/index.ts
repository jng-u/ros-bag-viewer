import { McapIndexedReader, McapStreamReader, type DecompressHandlers, type IReadable, type TypedMcapRecords } from "@mcap/core";

export interface McapLimits {
  readonly sequentialReadBytes: number;
  readonly maxBufferedBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxDecompressionRatio: number;
  readonly maxMessageIndexCacheBytes: number;
}

export const DEFAULT_MCAP_LIMITS: McapLimits = {
  sequentialReadBytes: 256 * 1024,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxDecompressedBytes: 64 * 1024 * 1024,
  maxDecompressionRatio: 100,
  maxMessageIndexCacheBytes: 8 * 1024 * 1024,
};

export interface McapSchemaInfo {
  readonly capability: "schema-present" | "opaque";
  readonly name: string;
  readonly encoding?: string;
  readonly data?: Uint8Array;
  readonly diagnostic?: string;
}

export interface McapChannelInfo {
  readonly id: number;
  readonly topic: string;
  readonly messageEncoding: string;
  readonly schema: McapSchemaInfo;
}

export interface McapMessage {
  readonly channel: McapChannelInfo;
  readonly sequence: bigint;
  readonly logTimeNanos: bigint;
  readonly publishTimeNanos: bigint;
  readonly data: Uint8Array;
}

export interface McapTelemetry {
  readonly mode: "indexed" | "unindexed-degraded";
  readonly scannedBytes: bigint;
  readonly scanProgress: number;
  readonly messagesRead: number;
  readonly decompressedBytes: number;
  readonly peakBufferedBytes: number;
}

export interface McapTimeRange {
  readonly startTimeNanos: bigint;
  readonly endTimeNanos: bigint;
}

export type UnindexedScanEvent =
  | { readonly kind: "progress"; readonly scannedBytes: bigint; readonly totalBytes: bigint; readonly progress: number }
  | { readonly kind: "message"; readonly message: McapMessage };

export type Decompressor = (buffer: Uint8Array, decompressedSize: bigint) => Uint8Array;

interface MutableTelemetry {
  mode: "indexed" | "unindexed-degraded";
  scannedBytes: bigint;
  scanProgress: number;
  messagesRead: number;
  decompressedBytes: number;
  peakBufferedBytes: number;
}

function assertLimits(limits: McapLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0 || (name !== "maxMessageIndexCacheBytes" && value === 0)) {
      throw new Error(`invalid MCAP resource limit: ${name}`);
    }
  }
  if (limits.sequentialReadBytes > limits.maxBufferedBytes) {
    throw new Error("sequentialReadBytes cannot exceed maxBufferedBytes");
  }
}

function boundedDecompressHandlers(
  handlers: Readonly<Record<string, Decompressor>>,
  limits: McapLimits,
  telemetry: MutableTelemetry,
): DecompressHandlers {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      (buffer: Uint8Array, declaredSize: bigint): Uint8Array => {
        if (declaredSize > BigInt(limits.maxDecompressedBytes)) {
          throw new Error(`${name} chunk exceeds maxDecompressedBytes`);
        }
        const ratio = buffer.byteLength === 0 ? Number.POSITIVE_INFINITY : Number(declaredSize) / buffer.byteLength;
        if (ratio > limits.maxDecompressionRatio) throw new Error(`${name} chunk exceeds maxDecompressionRatio`);
        const output = handler(buffer, declaredSize);
        if (BigInt(output.byteLength) !== declaredSize) throw new Error(`${name} decompressor returned an unexpected byte count`);
        telemetry.decompressedBytes += output.byteLength;
        if (telemetry.decompressedBytes > limits.maxDecompressedBytes) {
          throw new Error("MCAP session exceeds maxDecompressedBytes");
        }
        return output;
      },
    ]),
  );
}

function schemaInfo(
  channel: TypedMcapRecords["Channel"],
  schemas: ReadonlyMap<number, TypedMcapRecords["Schema"]>,
): McapSchemaInfo {
  const schema = schemas.get(channel.schemaId);
  if (!schema) {
    return {
      capability: "opaque",
      name: "unknown",
      diagnostic: channel.schemaId === 0 ? "channel declares no schema" : `schema ${channel.schemaId} is missing`,
    };
  }
  return {
    capability: "schema-present",
    name: schema.name,
    encoding: schema.encoding,
    data: schema.data,
  };
}

function channelInfo(
  channel: TypedMcapRecords["Channel"],
  schemas: ReadonlyMap<number, TypedMcapRecords["Schema"]>,
): McapChannelInfo {
  return {
    id: channel.id,
    topic: channel.topic,
    messageEncoding: channel.messageEncoding,
    schema: schemaInfo(channel, schemas),
  };
}

function messageInfo(
  message: TypedMcapRecords["Message"],
  channels: ReadonlyMap<number, TypedMcapRecords["Channel"]>,
  schemas: ReadonlyMap<number, TypedMcapRecords["Schema"]>,
): McapMessage {
  const channel = channels.get(message.channelId);
  if (!channel) throw new Error(`message references unknown channel ${message.channelId}`);
  return {
    channel: channelInfo(channel, schemas),
    sequence: BigInt(message.sequence),
    logTimeNanos: message.logTime,
    publishTimeNanos: message.publishTime,
    data: message.data,
  };
}

export class McapSourceSession {
  readonly mode: "indexed" | "unindexed-degraded";
  readonly diagnostic?: string;
  readonly #readable: IReadable;
  readonly #indexed?: McapIndexedReader;
  readonly #limits: McapLimits;
  readonly #decompressHandlers: DecompressHandlers;
  readonly #telemetry: MutableTelemetry;

  private constructor(
    readable: IReadable,
    mode: "indexed" | "unindexed-degraded",
    indexed: McapIndexedReader | undefined,
    limits: McapLimits,
    decompressHandlers: DecompressHandlers,
    telemetry: MutableTelemetry,
    diagnostic?: string,
  ) {
    this.#readable = readable;
    this.mode = mode;
    this.#indexed = indexed;
    this.#limits = limits;
    this.#decompressHandlers = decompressHandlers;
    this.#telemetry = telemetry;
    this.diagnostic = diagnostic;
  }

  static async open(
    readable: IReadable,
    options: {
      readonly limits?: McapLimits;
      readonly decompressors?: Readonly<Record<string, Decompressor>>;
    } = {},
  ): Promise<McapSourceSession> {
    const limits = options.limits ?? DEFAULT_MCAP_LIMITS;
    assertLimits(limits);
    const telemetry: MutableTelemetry = {
      mode: "indexed",
      scannedBytes: 0n,
      scanProgress: 0,
      messagesRead: 0,
      decompressedBytes: 0,
      peakBufferedBytes: 0,
    };
    const decompressHandlers = boundedDecompressHandlers(options.decompressors ?? {}, limits, telemetry);
    let indexedDiagnostic = "MCAP summary indexes are unavailable";
    try {
      const indexed = await McapIndexedReader.Initialize({
        readable,
        decompressHandlers,
        messageIndexCacheSizeBytes: limits.maxMessageIndexCacheBytes,
      });
      if (indexed.chunkIndexes.length > 0) {
        return new McapSourceSession(readable, "indexed", indexed, limits, decompressHandlers, telemetry);
      }
    } catch (error) {
      indexedDiagnostic = `MCAP indexed initialization failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    telemetry.mode = "unindexed-degraded";
    return new McapSourceSession(
      readable,
      "unindexed-degraded",
      undefined,
      limits,
      decompressHandlers,
      telemetry,
      `${indexedDiagnostic}; sequential degraded scan is required`,
    );
  }

  channels(): readonly McapChannelInfo[] {
    if (!this.#indexed) return [];
    return [...this.#indexed.channelsById.values()]
      .sort((left, right) => left.id - right.id)
      .map((channel) => channelInfo(channel, this.#indexed?.schemasById ?? new Map()));
  }

  timeRange(): McapTimeRange | undefined {
    if (!this.#indexed) return undefined;
    const statistics = this.#indexed.statistics;
    if (statistics && statistics.messageCount > 0n) {
      return {
        startTimeNanos: statistics.messageStartTime,
        endTimeNanos: statistics.messageEndTime,
      };
    }
    const [first, ...rest] = this.#indexed.chunkIndexes;
    if (!first) return undefined;
    let startTimeNanos = first.messageStartTime;
    let endTimeNanos = first.messageEndTime;
    for (const chunk of rest) {
      if (chunk.messageStartTime < startTimeNanos) startTimeNanos = chunk.messageStartTime;
      if (chunk.messageEndTime > endTimeNanos) endTimeNanos = chunk.messageEndTime;
    }
    return { startTimeNanos, endTimeNanos };
  }

  async *readIndexed(options: {
    readonly topics?: readonly string[];
    readonly startTime?: bigint;
    readonly endTime?: bigint;
  } = {}): AsyncGenerator<McapMessage, void, void> {
    if (!this.#indexed) throw new Error("random seek is unavailable for an unindexed MCAP source");
    for await (const message of this.#indexed.readMessages(options)) {
      this.#telemetry.messagesRead += 1;
      yield messageInfo(message, this.#indexed.channelsById, this.#indexed.schemasById);
    }
  }

  async *scanUnindexed(options: { readonly topics?: readonly string[] } = {}): AsyncGenerator<UnindexedScanEvent, void, void> {
    if (this.#indexed) throw new Error("sequential degraded scan is only available for unindexed MCAP sources");
    const totalBytes = await this.#readable.size();
    const reader = new McapStreamReader({ decompressHandlers: this.#decompressHandlers });
    const channels = new Map<number, TypedMcapRecords["Channel"]>();
    const schemas = new Map<number, TypedMcapRecords["Schema"]>();
    const topicSet = options.topics ? new Set(options.topics) : undefined;
    let offset = 0n;
    while (offset < totalBytes) {
      const readLength = BigInt(Math.min(this.#limits.sequentialReadBytes, Number(totalBytes - offset)));
      const data = await this.#readable.read(offset, readLength);
      offset += readLength;
      reader.append(data);
      this.#telemetry.scannedBytes = offset;
      this.#telemetry.scanProgress = totalBytes === 0n ? 1 : Number(offset) / Number(totalBytes);
      this.#telemetry.peakBufferedBytes = Math.max(this.#telemetry.peakBufferedBytes, reader.bytesRemaining());
      if (reader.bytesRemaining() > this.#limits.maxBufferedBytes) throw new Error("MCAP stream exceeds maxBufferedBytes");
      for (let record = reader.nextRecord(); record; record = reader.nextRecord()) {
        if (record.type === "Schema") schemas.set(record.id, record);
        if (record.type === "Channel") channels.set(record.id, record);
        if (record.type === "Message") {
          const channel = channels.get(record.channelId);
          if (!channel) throw new Error(`message references unknown channel ${record.channelId}`);
          if (!topicSet || topicSet.has(channel.topic)) {
            this.#telemetry.messagesRead += 1;
            yield { kind: "message", message: messageInfo(record, channels, schemas) };
          }
        }
      }
      yield {
        kind: "progress",
        scannedBytes: offset,
        totalBytes,
        progress: this.#telemetry.scanProgress,
      };
    }
    if (!reader.done()) throw new Error("MCAP sequential scan ended before a valid footer");
  }

  telemetry(): McapTelemetry {
    return { ...this.#telemetry };
  }
}
