import { availableDisplaysForSchema, LocalMcapDesktopRuntime } from "@ros-web-viewer/m1-integration";
import { McapSourceSession, type McapMessage } from "@ros-web-viewer/source-mcap";
import { Ros1BagSourceSession, type Ros1BagReader, type Ros1Message } from "@ros-web-viewer/source-ros1bag";
import {
  Ros2SqliteSourceSession,
  type Ros2BundleAccess,
  type Ros2SourceBundle,
  type Ros2SqliteMessage,
  type SourceEpochPort,
} from "@ros-web-viewer/source-ros2-sqlite";
import { BlobRangeSource, BoundedByteReader, SourceEpochController } from "@ros-web-viewer/worker-runtime";
import { decompress as decompressLz4 } from "lz4-lite";
import Bunzip from "seek-bzip";

import { BrowserSqliteQueryProvider } from "./browser-sqlite.js";
import type { DisplayKind, LocalMcapSelection, OpenLocalResult, SeekResult, TopicSummary } from "./shell.js";

export type BrowserSourceFormat = "mcap" | "ros1-bag" | "ros2-sqlite" | "unknown";

export interface BrowserSample {
  readonly channel: {
    readonly schema: { readonly name: string; readonly capability: "schema-present" | "opaque" };
    readonly messageEncoding: string;
  };
  readonly data: Uint8Array;
  readonly logTimeNanos: bigint;
}

export function detectBrowserSourceFormat(fileName: string): BrowserSourceFormat {
  const lower = fileName.toLocaleLowerCase();
  if (lower.endsWith(".mcap")) return "mcap";
  if (lower.endsWith(".bag")) return "ros1-bag";
  if (lower.endsWith(".db3") || lower.endsWith("metadata.yaml") || lower.endsWith("metadata.yml")) return "ros2-sqlite";
  return "unknown";
}

export function localFileVersion(file: Pick<File, "name" | "size" | "lastModified">): string {
  return `local:${encodeURIComponent(file.name)}:${file.size}:${file.lastModified}`;
}

const SAMPLE_LIMITS = {
  maxConcurrentReads: 2,
  maxQueuedReads: 8,
  maxSingleReadBytes: 8 * 1024 * 1024,
  maxBufferedBytes: 32 * 1024 * 1024,
  maxTotalReadBytes: 512n * 1024n * 1024n,
  maxDecompressedBytes: 64 * 1024 * 1024,
  maxDecompressionRatio: 100,
  maxCacheBytes: 16 * 1024 * 1024,
};

class BlobBagReader implements Ros1BagReader {
  constructor(private readonly blob: Blob) {}

  async size(): Promise<bigint> { return BigInt(this.blob.size); }

  async read(offset: bigint, size: bigint): Promise<Uint8Array> {
    if (offset < 0n || size < 0n || offset + size > BigInt(this.blob.size)) throw new Error("ROS1 bag range is outside the file");
    if (offset > BigInt(Number.MAX_SAFE_INTEGER) || size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ROS1 bag range exceeds browser limits");
    return new Uint8Array(await this.blob.slice(Number(offset), Number(offset + size)).arrayBuffer());
  }
}

export function decodeRos1Bzip(compressed: Uint8Array, declaredSize: number, signal: AbortSignal): Uint8Array {
  if (signal.aborted) throw new DOMException("BZip2 decode aborted", "AbortError");
  const output = new Uint8Array(declaredSize);
  let offset = 0;
  Bunzip.decode(compressed, {
    writeByte(value) {
      if (offset >= output.byteLength) throw new Error("BZip2 output exceeds its declared size");
      output[offset++] = value;
    },
    write(bytes, sourceOffset, length) {
      if (offset + length > output.byteLength) throw new Error("BZip2 output exceeds its declared size");
      for (let index = 0; index < length; index += 1) output[offset + index] = bytes[sourceOffset + index] ?? 0;
      offset += length;
      return length;
    },
  });
  if (offset !== declaredSize) throw new Error(`BZip2 decoded ${offset} bytes; expected ${declaredSize}`);
  if (signal.aborted) throw new DOMException("BZip2 decode aborted", "AbortError");
  return output;
}

export function decodeRos1Lz4(compressed: Uint8Array, declaredSize: number, signal: AbortSignal): Uint8Array {
  if (signal.aborted) throw new DOMException("LZ4 decode aborted", "AbortError");
  const output = decompressLz4(compressed, declaredSize);
  if (output.byteLength !== declaredSize) throw new Error(`LZ4 decoded ${output.byteLength} bytes; expected ${declaredSize}`);
  return output;
}

function displayKinds(typeName: string, capability: "schema-present" | "schema-resolvable" | "opaque"): readonly DisplayKind[] {
  if (capability === "opaque") return ["raw"];
  return availableDisplaysForSchema(typeName, "schema-present");
}

function topicSummary(id: string, name: string, typeName: string, capability: "schema-present" | "schema-resolvable" | "opaque"): TopicSummary {
  const availableDisplays = displayKinds(typeName, capability);
  return {
    id,
    name,
    typeName,
    schemaCapability: capability,
    availableDisplays,
    compatibility: availableDisplays.some((kind) => kind !== "raw")
      ? "native-display"
      : capability === "opaque" ? "opaque-inspectable" : "schema-backed-generic",
  };
}

class BrowserSourceEpoch implements SourceEpochPort {
  readonly #controller = new AbortController();
  constructor(readonly epoch: number) {}
  get signal(): AbortSignal { return this.#controller.signal; }
  abort(reason: string): void { this.#controller.abort(reason); }
}

function syntheticMetadata(paths: readonly string[]): Blob {
  const rows = paths.map((path) => `    - ${path}`).join("\n");
  return new Blob([`rosbag2_bagfile_information:
  version: 9
  storage_identifier: sqlite3
  message_count: 0
  topics_with_message_count:
  compression_format: ''
  compression_mode: ''
  relative_file_paths:
${rows}
`], { type: "text/yaml" });
}

function errorDetail(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && messages.length < 4) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" → ") || String(error);
}

/** Browser runtime for MCAP, ROS1 bag, and ROS2 SQLite bag bundles. */
export class BrowserRecordingRuntime {
  readonly #metadata = new LocalMcapDesktopRuntime();
  #kind?: "mcap" | "ros1-bag" | "ros2-sqlite";
  #mcapBlob?: Blob;
  #ros1?: Ros1BagSourceSession;
  #ros2?: Ros2SqliteSourceSession;
  #ros2Epoch?: BrowserSourceEpoch;
  #startTimeNanos = 0n;
  #epoch = 0;

  async open(selection: LocalMcapSelection): Promise<OpenLocalResult> {
    await this.#closeCurrent();
    const format = selection.format ?? detectBrowserSourceFormat(selection.name);
    if (format === "mcap") return this.#openMcap(selection);
    if (format === "ros1-bag") return this.#openRos1(selection);
    if (format === "ros2-sqlite") return this.#openRos2(selection);
    throw new Error("Unsupported recording. Choose an MCAP, ROS1 .bag, or ROS2 metadata.yaml/.db3 bundle.");
  }

  async #openMcap(selection: LocalMcapSelection): Promise<OpenLocalResult> {
    const result = await this.#metadata.openLocalMcap(selection);
    this.#kind = "mcap";
    this.#mcapBlob = selection.blob;
    this.#startTimeNanos = 0n;
    this.#epoch = result.epoch;
    return result;
  }

  async #openRos1(selection: LocalMcapSelection): Promise<OpenLocalResult> {
    if (!selection.blob) throw new Error("ROS1 bag selection is missing its local file bytes");
    const session = await Ros1BagSourceSession.open(new BlobBagReader(selection.blob), undefined, {
      decompressors: {
        bz2: decodeRos1Bzip,
        lz4: decodeRos1Lz4,
      },
    });
    const range = session.timeRange();
    this.#kind = "ros1-bag";
    this.#ros1 = session;
    this.#startTimeNanos = range?.startTimeNanos ?? 0n;
    this.#epoch += 1;
    const diagnostics = session.diagnostics();
    return {
      sourceLabel: selection.name,
      sourceHash: selection.immutableVersion,
      durationNanos: range ? range.endTimeNanos - range.startTimeNanos : 0n,
      epoch: this.#epoch,
      indexState: session.mode === "indexed" ? "indexed" : "sequential",
      topics: session.channels().map((channel) => topicSummary(String(channel.id), channel.topic, channel.typeName, channel.schema.capability)),
      diagnostic: [session.diagnostic, ...diagnostics].filter(Boolean).join(" · ") || undefined,
    };
  }

  async #openRos2(selection: LocalMcapSelection): Promise<OpenLocalResult> {
    const selected = [...(selection.files ?? [])];
    if (selected.length === 0 && selection.blob) {
      selected.push({ name: selection.name, relativePath: selection.name, sizeBytes: selection.sizeBytes, immutableVersion: selection.immutableVersion, blob: selection.blob });
    }
    const databaseFiles = selected.filter(({ relativePath }) => relativePath.toLocaleLowerCase().endsWith(".db3"));
    if (databaseFiles.length === 0) throw new Error("ROS2 bag selection must include at least one .db3 file");
    if (!selected.some(({ relativePath }) => /(^|\/)metadata\.ya?ml$/iu.test(relativePath))) {
      const metadata = syntheticMetadata(databaseFiles.map(({ relativePath }) => relativePath));
      selected.unshift({ name: "metadata.yaml", relativePath: "metadata.yaml", sizeBytes: metadata.size, immutableVersion: `${selection.immutableVersion}:synthetic-metadata`, blob: metadata });
    }
    const entries = selected.map((file, index) => ({
      entryId: `entry-${index}`,
      relativePath: file.relativePath.replaceAll("\\", "/").replace(/^\.\//u, ""),
      sizeBytes: BigInt(file.sizeBytes),
      immutableVersion: file.immutableVersion,
    }));
    const metadataEntry = entries.find(({ relativePath }) => /(^|\/)metadata\.ya?ml$/iu.test(relativePath));
    if (!metadataEntry) throw new Error("ROS2 metadata selection could not be normalized");
    const relations: Ros2SourceBundle["relations"] = entries
      .filter(({ relativePath }) => relativePath.toLocaleLowerCase().endsWith(".db3"))
      .map((entry) => ({ fromEntryId: metadataEntry.entryId, toEntryId: entry.entryId, kind: "metadata-for" as const }));
    const bundle: Ros2SourceBundle = { bundleId: selection.immutableVersion, version: 1, entries, relations };
    const filesById = new Map(entries.map((entry, index) => [entry.entryId, selected[index]!.blob]));
    const access: Ros2BundleAccess = {
      bundle,
      async readEntry(entryId, offset, length, signal) {
        if (signal.aborted) throw new DOMException("ROS2 bag read aborted", "AbortError");
        const blob = filesById.get(entryId);
        if (!blob) throw new Error(`ROS2 bag entry ${entryId} is unavailable`);
        if (offset < 0n || length < 0n || offset + length > BigInt(blob.size)) throw new Error("ROS2 bag range is outside the selected file");
        return new Uint8Array(await blob.slice(Number(offset), Number(offset + length)).arrayBuffer());
      },
    };
    const sourceEpoch = new BrowserSourceEpoch(this.#epoch + 1);
    let session: Ros2SqliteSourceSession;
    try {
      session = await Ros2SqliteSourceSession.open(access, new BrowserSqliteQueryProvider(), sourceEpoch);
    } catch (error) {
      throw new Error(errorDetail(error), { cause: error });
    }
    const range = session.timeRange();
    this.#kind = "ros2-sqlite";
    this.#ros2 = session;
    this.#ros2Epoch = sourceEpoch;
    this.#startTimeNanos = range?.startTimeNanos ?? 0n;
    this.#epoch = sourceEpoch.epoch;
    return {
      sourceLabel: selection.name,
      sourceHash: selection.immutableVersion,
      durationNanos: range ? range.endTimeNanos - range.startTimeNanos : 0n,
      epoch: this.#epoch,
      indexState: "indexed",
      topics: session.topics().map((topic, index) => topicSummary(String(index), topic.name, topic.type, topic.schema.capability)),
      diagnostic: session.diagnostics.join(" · ") || undefined,
    };
  }

  async seek(timeNanos: bigint): Promise<SeekResult> {
    if (this.#kind === "mcap") return this.#metadata.seek(timeNanos);
    this.#epoch += 1;
    return { epoch: this.#epoch, currentTimeNanos: timeNanos };
  }

  async sample(topic: string, relativeTimeNanos: bigint): Promise<BrowserSample> {
    if (this.#kind === "mcap") return this.#sampleMcap(topic, relativeTimeNanos);
    if (this.#kind === "ros1-bag") return this.#sampleRos1(topic, relativeTimeNanos);
    if (this.#kind === "ros2-sqlite") return this.#sampleRos2(topic, relativeTimeNanos);
    throw new Error("Open a recording before sampling a topic.");
  }

  async #sampleMcap(topic: string, relativeTimeNanos: bigint): Promise<BrowserSample> {
    if (!this.#mcapBlob) throw new Error("Open an MCAP recording before sampling a topic.");
    const epoch = new SourceEpochController();
    const reader = new BoundedByteReader(new BlobRangeSource(this.#mcapBlob), epoch, SAMPLE_LIMITS);
    const session = await McapSourceSession.open(reader);
    if (session.mode === "indexed") {
      const range = session.timeRange();
      const startTime = (range?.startTimeNanos ?? 0n) + relativeTimeNanos;
      for await (const message of session.readIndexed({ topics: [topic], startTime })) return this.#mcapSample(message);
      let previous;
      for await (const message of session.readIndexed({ topics: [topic], endTime: startTime })) previous = message;
      if (previous) return this.#mcapSample(previous);
    } else {
      for await (const event of session.scanUnindexed({ topics: [topic] })) if (event.kind === "message") return this.#mcapSample(event.message);
    }
    throw new Error(`No message was found for ${topic}.`);
  }

  #mcapSample(message: McapMessage): BrowserSample {
    return {
      channel: { schema: message.channel.schema, messageEncoding: message.channel.messageEncoding },
      data: message.data,
      logTimeNanos: message.logTimeNanos,
    };
  }

  async #sampleRos1(topic: string, relativeTimeNanos: bigint): Promise<BrowserSample> {
    if (!this.#ros1) throw new Error("Open a ROS1 bag before sampling a topic.");
    const absoluteTime = this.#startTimeNanos + relativeTimeNanos;
    let selected: Ros1Message | undefined;
    if (this.#ros1.mode === "indexed") {
      for await (const message of this.#ros1.readIndexed({ topics: [topic], startTime: absoluteTime })) { selected = message; break; }
      if (!selected) for await (const message of this.#ros1.readIndexed({ topics: [topic], endTime: absoluteTime })) selected = message;
    } else {
      for await (const event of this.#ros1.scanUnindexed({ topics: [topic] })) {
        if (event.kind !== "message") continue;
        selected = event.message;
        if (event.message.timeNanos >= absoluteTime) break;
      }
    }
    if (!selected) throw new Error(`No ROS1 message was found for ${topic}.`);
    return {
      channel: { schema: { name: selected.connection.typeName, capability: selected.connection.schema.capability }, messageEncoding: "ros1" },
      data: selected.data,
      logTimeNanos: selected.timeNanos,
    };
  }

  async #sampleRos2(topic: string, relativeTimeNanos: bigint): Promise<BrowserSample> {
    if (!this.#ros2) throw new Error("Open a ROS2 SQLite bag before sampling a topic.");
    const absoluteTime = this.#startTimeNanos + relativeTimeNanos;
    let selected: Ros2SqliteMessage | undefined;
    for await (const message of this.#ros2.readMessages({ startTimeNanos: absoluteTime, topics: [topic], limit: 1 })) selected = message;
    if (!selected) throw new Error(`No ROS2 message was found for ${topic} at or after the selected time.`);
    return {
      channel: {
        schema: { name: selected.topic.type, capability: selected.topic.schema.capability === "opaque" ? "opaque" : "schema-present" },
        messageEncoding: selected.topic.serializationFormat,
      },
      data: selected.data,
      logTimeNanos: selected.timestampNanos,
    };
  }

  async #closeCurrent(): Promise<void> {
    this.#ros1?.close();
    this.#ros1 = undefined;
    if (this.#ros2) await this.#ros2.close();
    this.#ros2 = undefined;
    this.#ros2Epoch?.abort("recording replaced");
    this.#ros2Epoch = undefined;
    this.#mcapBlob = undefined;
    this.#kind = undefined;
  }
}
