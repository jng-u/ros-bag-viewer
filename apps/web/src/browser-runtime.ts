import { availableDisplaysForSchema, LocalMcapDesktopRuntime } from "@ros-web-viewer/m1-integration";
import { McapSourceSession, type Decompressor, type McapMessage } from "@ros-web-viewer/source-mcap";
import { Ros1BagSourceSession, type Ros1BagReader, type Ros1Message } from "@ros-web-viewer/source-ros1bag";
import {
  Ros2SqliteSourceSession,
  type Ros2BundleAccess,
  type Ros2SourceBundle,
  type Ros2SqliteMessage,
  type SourceEpochPort,
} from "@ros-web-viewer/source-ros2-sqlite";
import {
  BlobRangeSource,
  BoundedByteReader,
  HARD_WORKER_LIMITS,
  SourceEpochController,
  type ByteRange,
  type RangeSource,
  type WorkerResourceLimits,
} from "@ros-web-viewer/worker-runtime";
import { decompress as decompressLz4 } from "lz4-lite";

import { BrowserSqliteQueryProvider, MAX_BROWSER_SQLITE_PARTS } from "./browser-sqlite.js";
import { BrowserCompressionWorker } from "./browser-compression.js";
import { decodeBzip } from "./browser-bzip.js";
import type { DisplayKind, LocalMcapSelection, OpenHostedResult, OpenLocalResult, SeekResult, TopicSummary } from "./shell.js";

export type BrowserSourceFormat = "mcap" | "ros1-bag" | "ros2-sqlite" | "unknown";

const browserMcapDecompressors: Readonly<Record<string, Decompressor>> = {
  lz4(compressed, declaredSize) {
    if (declaredSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("lz4 MCAP chunk exceeds browser integer limits");
    return decompressLz4(compressed, Number(declaredSize));
  },
};

export interface BrowserSample {
  readonly channel: {
    readonly schema: {
      readonly name: string;
      readonly capability: "schema-present" | "opaque";
      readonly encoding?: string;
      readonly definition?: string;
      readonly data?: Uint8Array;
    };
    readonly messageEncoding: string;
  };
  readonly data: Uint8Array;
  readonly logTimeNanos: bigint;
  readonly sourceSequence?: bigint;
}

export interface BrowserSampleWindow {
  readonly samples: readonly BrowserSample[];
  readonly before?: BrowserSample;
  readonly after?: BrowserSample;
  readonly truncated: boolean;
}

const TF_HISTORY_HORIZON_NANOS = 30_000_000_000n;
const TF_HISTORY_SIDE_LIMIT = 2_048;
const TF_HISTORY_SIDE_BYTE_LIMIT = 32 * 1024 * 1024;
const TF_STATIC_PREFIX_LIMIT = 256;

function isStaticTfTopic(topic: string): boolean {
  return /(?:^|\/)tf_static$/u.test(topic);
}

function appendTfHistoryMessage<T extends { readonly data: Uint8Array }>(target: T[], message: T, retainedBytes: number): number | undefined {
  if (message.data.byteLength > TF_HISTORY_SIDE_BYTE_LIMIT) throw new Error("A TF history message exceeds the 32 MiB per-side byte budget.");
  if (retainedBytes + message.data.byteLength > TF_HISTORY_SIDE_BYTE_LIMIT) return undefined;
  target.push(message);
  return retainedBytes + message.data.byteLength;
}

function rollTfHistoryMessage<T extends { readonly data: Uint8Array }>(target: T[], message: T, retainedBytes: number): { readonly bytes: number; readonly truncated: boolean } {
  if (message.data.byteLength > TF_HISTORY_SIDE_BYTE_LIMIT) throw new Error("A TF history message exceeds the 32 MiB per-side byte budget.");
  target.push(message);
  let bytes = retainedBytes + message.data.byteLength;
  let truncated = false;
  while (target.length > TF_HISTORY_SIDE_LIMIT || bytes > TF_HISTORY_SIDE_BYTE_LIMIT) {
    bytes -= target.shift()!.data.byteLength;
    truncated = true;
  }
  return { bytes, truncated };
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
} satisfies WorkerResourceLimits;

const LOCAL_UNINDEXED_READ_PASSES = 32n;

export function browserLocalReadLimits(sourceBytes: bigint): WorkerResourceLimits {
  if (sourceBytes < 0n) throw new Error("local source byte length cannot be negative");
  const scaledTotal = sourceBytes * LOCAL_UNINDEXED_READ_PASSES;
  const withDefaultFloor = scaledTotal < SAMPLE_LIMITS.maxTotalReadBytes ? SAMPLE_LIMITS.maxTotalReadBytes : scaledTotal;
  const maxTotalReadBytes = withDefaultFloor > HARD_WORKER_LIMITS.maxTotalReadBytes ? HARD_WORKER_LIMITS.maxTotalReadBytes : withDefaultFloor;
  return { ...SAMPLE_LIMITS, maxTotalReadBytes };
}

async function cancelResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* validation failure still takes precedence */ }
}

async function readExactResponseBody(response: Response, expectedLength: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) throw new Error("Hosted MCAP response length is outside browser limits.");
  if (!response.body) throw new Error("Hosted MCAP range response has no readable body.");
  const reader = response.body.getReader();
  const output = new Uint8Array(expectedLength);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || offset + value.byteLength > expectedLength) {
        await reader.cancel("Hosted MCAP range body exceeded its declared length.");
        throw new Error("Hosted MCAP range body exceeded its requested immutable range.");
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== expectedLength) throw new Error("Hosted MCAP range body ended before its requested immutable range.");
    return output;
  } finally {
    reader.releaseLock();
  }
}

export class HttpRangeSource implements RangeSource {
  rangeRequests = 0;
  transferredBytes = 0;

  constructor(
    readonly size: bigint,
    private readonly url: string,
    private readonly authorization?: string,
    private readonly immutableValidator?: { readonly header: "etag" | "last-modified"; readonly value: string },
  ) {}

  async read(range: ByteRange, signal: AbortSignal): Promise<Uint8Array> {
    if (range.offset < 0n || range.length < 0n || range.offset + range.length > this.size) throw new RangeError("HTTP range is outside the immutable source");
    if (range.length === 0n) return new Uint8Array();
    const end = range.offset + range.length - 1n;
    const response = await fetch(this.url, {
      headers: {
        Range: `bytes=${range.offset}-${end}`,
        ...(this.authorization ? { Authorization: this.authorization } : {}),
        ...(this.immutableValidator ? { "If-Range": this.immutableValidator.value } : {}),
      },
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      signal,
    });
    const expectedLength = Number(range.length);
    try {
      if (response.status !== 206) throw new Error(`Hosted MCAP must support HTTP Range requests; received ${response.status}.`);
      if (this.immutableValidator && response.headers.get(this.immutableValidator.header) !== this.immutableValidator.value) {
        throw new Error(`Hosted MCAP immutable ${this.immutableValidator.header === "etag" ? "ETag" : "Last-Modified"} validator changed or is missing.`);
      }
      const expectedContentRange = `bytes ${range.offset}-${end}/${this.size}`;
      if (response.headers.get("content-range") !== expectedContentRange) {
        throw new Error(`Hosted MCAP returned an invalid Content-Range; expected ${expectedContentRange}.`);
      }
      if (response.headers.get("content-length") !== String(expectedLength)) {
        throw new Error("Hosted MCAP range response requires an exact Content-Length matching the requested range.");
      }
    } catch (error) {
      await cancelResponseBody(response);
      throw error;
    }
    const data = await readExactResponseBody(response, expectedLength);
    this.rangeRequests += 1;
    this.transferredBytes += data.byteLength;
    return data;
  }
}

function hostedRequest(link: string): { readonly url: string; readonly authorization?: string } {
  const parsed = new URL(link);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))) {
    throw new Error("Hosted recording URL must use HTTPS (HTTP is allowed only for loopback development)." );
  }
  if (parsed.username || parsed.password) throw new Error("Hosted recording credentials must not be embedded in the URL.");
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const capability = fragment.get("capability") ?? fragment.get("cap");
  parsed.hash = "";
  return { url: parsed.href, ...(capability ? { authorization: `Bearer ${capability}` } : {}) };
}

async function probeHostedSource(link: string): Promise<{ readonly source: HttpRangeSource; readonly label: string; readonly version: string }> {
  const request = hostedRequest(link);
  const response = await fetch(request.url, {
    headers: { Range: "bytes=0-0", ...(request.authorization ? { Authorization: request.authorization } : {}) },
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
  });
  let size: bigint;
  let immutableValidator: { readonly header: "etag" | "last-modified"; readonly value: string };
  try {
    if (response.status !== 206) throw new Error(`Hosted recording endpoint must return HTTP 206 for ranges; received ${response.status}.`);
    const contentRange = response.headers.get("content-range")?.match(/^bytes 0-0\/(\d+)$/u);
    if (!contentRange) throw new Error("Hosted recording response is missing an exposed Content-Range total size.");
    size = BigInt(contentRange[1]!);
    if (size <= 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Hosted recording size is outside browser limits.");
    if (response.headers.get("content-length") !== "1") throw new Error("Hosted recording probe requires an exact one-byte Content-Length.");
    const etag = response.headers.get("etag");
    if (etag?.startsWith("W/")) throw new Error("Hosted recording response requires a strong immutable ETag; weak ETags are not accepted.");
    const lastModified = response.headers.get("last-modified");
    if (etag) immutableValidator = { header: "etag", value: etag };
    else if (lastModified) immutableValidator = { header: "last-modified", value: lastModified };
    else throw new Error("Hosted recording response requires an immutable ETag or Last-Modified validator.");
  } catch (error) {
    await cancelResponseBody(response);
    throw error;
  }
  await readExactResponseBody(response, 1);
  const version = immutableValidator.value;
  const url = new URL(request.url);
  const label = url.pathname.split("/").filter(Boolean).at(-1) ?? url.hostname;
  const source = new HttpRangeSource(size, request.url, request.authorization, immutableValidator);
  await source.read({ offset: size - 1n, length: 1n }, new AbortController().signal);
  return { source, label, version };
}

class BlobBagReader implements Ros1BagReader {
  constructor(private readonly blob: Blob) {}

  async size(): Promise<bigint> { return BigInt(this.blob.size); }

  async read(offset: bigint, size: bigint): Promise<Uint8Array> {
    if (offset < 0n || size < 0n || offset + size > BigInt(this.blob.size)) throw new Error("ROS1 bag range is outside the file");
    if (offset > BigInt(Number.MAX_SAFE_INTEGER) || size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ROS1 bag range exceeds browser limits");
    return new Uint8Array(await this.blob.slice(Number(offset), Number(offset + size)).arrayBuffer());
  }
}

export function decodeRos1Bzip(compressed: Uint8Array, declaredSize: number, signal: AbortSignal): Promise<Uint8Array> {
  return decodeBzip(compressed, declaredSize, signal);
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

function topicSummary(id: string, name: string, typeName: string, capability: "schema-present" | "schema-resolvable" | "opaque", messageCount?: bigint): TopicSummary {
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
    ...(messageCount === undefined ? {} : { messageCount }),
  };
}

class BrowserSourceEpoch implements SourceEpochPort {
  #controller = new AbortController();
  #epoch: number;
  constructor(epoch: number) { this.#epoch = epoch; }
  get epoch(): number { return this.#epoch; }
  get signal(): AbortSignal { return this.#controller.signal; }
  abort(reason: string): void { this.#controller.abort(reason); }
  advance(reason = "browser source epoch advanced"): number {
    this.#controller.abort(reason);
    this.#epoch += 1;
    this.#controller = new AbortController();
    return this.#epoch;
  }
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
  #metadata?: LocalMcapDesktopRuntime;
  #kind?: "mcap" | "ros1-bag" | "ros2-sqlite";
  #mcapSession?: McapSourceSession;
  #mcapEpoch?: SourceEpochController;
  #ros1?: Ros1BagSourceSession;
  #ros1Epoch?: BrowserSourceEpoch;
  #ros1Compression?: BrowserCompressionWorker;
  #ros2?: Ros2SqliteSourceSession;
  #ros2Epoch?: BrowserSourceEpoch;
  #startTimeNanos = 0n;
  #epoch = 0;
  #hostedMcap = false;
  #mcapSequentialStartTimeNanos?: bigint;

  constructor(private readonly options: Readonly<{
    allowInlineWorkerFallback?: boolean;
    allowSqliteMaterializedFallback?: boolean;
    forceInlineProcessing?: boolean;
  }> = {}) {}

  async openHostedMcap(link: string): Promise<OpenHostedResult> {
    await this.#closeCurrent();
    const { source, label, version } = await probeHostedSource(link);
    const sourceEpoch = new SourceEpochController();
    sourceEpoch.advance("hosted MCAP opened");
    const reader = new BoundedByteReader(source, sourceEpoch, SAMPLE_LIMITS);
    const session = await McapSourceSession.open(reader, { decompressors: browserMcapDecompressors });
    if (session.mode !== "indexed") throw new Error("Hosted MCAP requires summary and message indexes; sequential remote loading is refused.");
    const range = session.timeRange();
    this.#kind = "mcap";
    this.#hostedMcap = true;
    this.#mcapSession = session;
    this.#mcapEpoch = sourceEpoch;
    this.#startTimeNanos = range?.startTimeNanos ?? 0n;
    this.#epoch = sourceEpoch.epoch;
    return {
      sourceLabel: label,
      sourceHash: version,
      durationNanos: range ? range.endTimeNanos - range.startTimeNanos : 0n,
      epoch: this.#epoch,
      indexState: "indexed",
      topics: session.channels().map((channel) => topicSummary(String(channel.id), channel.topic, channel.schema.name, channel.schema.capability)),
      observability: { rangeRequests: source.rangeRequests, transferredBytes: source.transferredBytes, deniedRequests: 0, activeReaders: 0 },
    };
  }

  async open(selection: LocalMcapSelection): Promise<OpenLocalResult> {
    await this.#closeCurrent();
    const format = selection.format ?? detectBrowserSourceFormat(selection.name);
    if (format === "mcap") return this.#openMcap(selection);
    if (format === "ros1-bag") return this.#openRos1(selection);
    if (format === "ros2-sqlite") return this.#openRos2(selection);
    throw new Error("Unsupported recording. Choose an MCAP, ROS1 .bag, or ROS2 metadata.yaml/.db3 bundle.");
  }

  async #openMcap(selection: LocalMcapSelection): Promise<OpenLocalResult> {
    if (!selection.blob) throw new Error("MCAP selection is missing its local file bytes");
    const limits = browserLocalReadLimits(BigInt(selection.blob.size));
    const metadata = new LocalMcapDesktopRuntime(limits, undefined, browserMcapDecompressors);
    const result = await metadata.openLocalMcap(selection);
    const sourceEpoch = new SourceEpochController();
    const reader = new BoundedByteReader(new BlobRangeSource(selection.blob), sourceEpoch, limits);
    this.#kind = "mcap";
    this.#hostedMcap = false;
    this.#mcapSession = await McapSourceSession.open(reader, { decompressors: browserMcapDecompressors });
    this.#mcapEpoch = sourceEpoch;
    this.#metadata = metadata;
    this.#startTimeNanos = 0n;
    this.#epoch = result.epoch;
    return result;
  }

  async #openRos1(selection: LocalMcapSelection): Promise<OpenLocalResult> {
    if (!selection.blob) throw new Error("ROS1 bag selection is missing its local file bytes");
    const compression = typeof Worker === "undefined" || this.options.forceInlineProcessing ? undefined : new BrowserCompressionWorker();
    if (!compression && !this.options.allowInlineWorkerFallback) {
      throw new Error("ROS1 compressed bag support requires a browser Worker; main-thread fallback is disabled.");
    }
    let session: Ros1BagSourceSession;
    const sourceEpoch = new BrowserSourceEpoch(this.#epoch);
    try {
      session = await Ros1BagSourceSession.open(new BlobBagReader(selection.blob), sourceEpoch, {
        decompressors: compression ? {
          bz2: (bytes, declaredSize, signal) => compression.decompress("bz2", bytes, declaredSize, signal),
          lz4: (bytes, declaredSize, signal) => compression.decompress("lz4", bytes, declaredSize, signal),
        } : {
          bz2: decodeRos1Bzip,
          lz4: decodeRos1Lz4,
        },
      });
    } catch (error) {
      compression?.close();
      throw error;
    }
    const range = session.timeRange();
    this.#kind = "ros1-bag";
    this.#ros1 = session;
    this.#ros1Epoch = sourceEpoch;
    this.#ros1Compression = compression;
    this.#startTimeNanos = range?.startTimeNanos ?? 0n;
    this.#epoch = sourceEpoch.epoch;
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
    if (databaseFiles.length > MAX_BROWSER_SQLITE_PARTS) {
      throw new Error(`ROS2 browser viewer supports at most ${MAX_BROWSER_SQLITE_PARTS} SQLite parts per bag; merge or re-record this ${databaseFiles.length}-part bag.`);
    }
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
      session = await Ros2SqliteSourceSession.open(access, new BrowserSqliteQueryProvider(
        Boolean(this.options.allowSqliteMaterializedFallback ?? this.options.allowInlineWorkerFallback),
        Boolean(this.options.forceInlineProcessing),
      ), sourceEpoch);
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
      topics: session.topics().map((topic, index) => topicSummary(String(index), topic.name, topic.type, topic.schema.capability, topic.messageCount)),
      diagnostic: session.diagnostics.join(" · ") || undefined,
    };
  }

  async seek(timeNanos: bigint): Promise<SeekResult> {
    if (this.#kind === "mcap" && this.#hostedMcap) {
      this.#mcapEpoch?.advance("hosted MCAP seek");
      this.#epoch += 1;
      return { epoch: this.#epoch, currentTimeNanos: timeNanos };
    }
    if (this.#kind === "mcap") {
      this.#mcapEpoch?.advance("local MCAP seek");
      if (!this.#metadata) throw new Error("Open a local MCAP source before seeking.");
      const result = await this.#metadata.seek(timeNanos);
      this.#epoch = result.epoch;
      return result;
    }
    if (this.#kind === "ros1-bag") this.#epoch = this.#ros1Epoch?.advance("ROS1 bag seek") ?? this.#epoch + 1;
    else if (this.#kind === "ros2-sqlite") this.#epoch = this.#ros2?.advanceEpoch("ROS2 SQLite seek") ?? this.#epoch + 1;
    else this.#epoch += 1;
    return { epoch: this.#epoch, currentTimeNanos: timeNanos };
  }

  async messageAt(topic: string, relativeTimeNanos: bigint): Promise<BrowserSample> {
    if (this.#kind === "mcap") return this.#messageAtMcap(topic, relativeTimeNanos);
    if (this.#kind === "ros1-bag") return this.#messageAtRos1(topic, relativeTimeNanos);
    if (this.#kind === "ros2-sqlite") return this.#messageAtRos2(topic, relativeTimeNanos);
    throw new Error("Open a recording before resolving a topic message.");
  }

  async messagesAt(topics: readonly string[], relativeTimeNanos: bigint): Promise<ReadonlyMap<string, BrowserSample>> {
    const uniqueTopics = [...new Set(topics)];
    const entries = await Promise.all(uniqueTopics.map(async (topic) => [topic, await this.messageAt(topic, relativeTimeNanos)] as const));
    return new Map(entries);
  }

  async messagesAround(topic: string, relativeTimeNanos: bigint): Promise<BrowserSampleWindow> {
    if (this.#kind === "mcap") {
      const session = this.#mcapSession;
      if (!session) throw new Error("Open an MCAP recording before resolving TF history.");
      const range = session.timeRange();
      const requested = (range?.startTimeNanos ?? this.#mcapSequentialStartTimeNanos ?? 0n) + relativeTimeNanos;
      const start = requested > TF_HISTORY_HORIZON_NANOS ? requested - TF_HISTORY_HORIZON_NANOS : 0n;
      const end = requested + TF_HISTORY_HORIZON_NANOS;
      const staticPrefix: McapMessage[] = [];
      const before: McapMessage[] = []; const after: McapMessage[] = [];
      let staticPrefixBytes = 0; let beforeBytes = 0; let afterBytes = 0;
      let truncated = false;
      if (session.mode === "indexed") {
        if (isStaticTfTopic(topic)) {
          for await (const message of session.readIndexed({ topics: [topic], startTime: range?.startTimeNanos ?? 0n, endTime: requested })) {
            if (staticPrefix.length === TF_STATIC_PREFIX_LIMIT) { truncated = true; break; }
            const nextBytes = appendTfHistoryMessage(staticPrefix, message, staticPrefixBytes);
            if (nextBytes === undefined) { truncated = true; break; }
            staticPrefixBytes = nextBytes;
          }
        }
        for await (const message of session.readIndexed({ topics: [topic], startTime: start, endTime: requested, reverse: true })) {
          if (before.length === TF_HISTORY_SIDE_LIMIT) { truncated = true; break; }
          const nextBytes = appendTfHistoryMessage(before, message, beforeBytes);
          if (nextBytes === undefined) { truncated = true; break; }
          beforeBytes = nextBytes;
        }
        before.reverse();
        if (!isStaticTfTopic(topic)) {
          for await (const message of session.readIndexed({ topics: [topic], startTime: requested, endTime: end })) {
            if (after.length === TF_HISTORY_SIDE_LIMIT) { truncated = true; break; }
            const nextBytes = appendTfHistoryMessage(after, message, afterBytes);
            if (nextBytes === undefined) { truncated = true; break; }
            afterBytes = nextBytes;
          }
        }
      } else {
        for await (const event of session.scanUnindexed()) {
          if (event.kind !== "message") continue;
          this.#mcapSequentialStartTimeNanos ??= event.message.logTimeNanos;
          const target = this.#mcapSequentialStartTimeNanos + relativeTimeNanos;
          if (event.message.channel.topic !== topic) continue;
          if (isStaticTfTopic(topic) && event.message.logTimeNanos <= target) {
            if (staticPrefix.length >= TF_STATIC_PREFIX_LIMIT) truncated = true;
            else {
              const nextBytes = appendTfHistoryMessage(staticPrefix, event.message, staticPrefixBytes);
              if (nextBytes === undefined) truncated = true; else staticPrefixBytes = nextBytes;
            }
          }
          if (event.message.logTimeNanos < target - (target > TF_HISTORY_HORIZON_NANOS ? TF_HISTORY_HORIZON_NANOS : target)) continue;
          if (event.message.logTimeNanos <= target) {
            const rolled = rollTfHistoryMessage(before, event.message, beforeBytes);
            beforeBytes = rolled.bytes; truncated ||= rolled.truncated;
          } else if (!isStaticTfTopic(topic) && event.message.logTimeNanos <= target + TF_HISTORY_HORIZON_NANOS) {
            if (after.length >= TF_HISTORY_SIDE_LIMIT) truncated = true;
            else {
              const nextBytes = appendTfHistoryMessage(after, event.message, afterBytes);
              if (nextBytes === undefined) truncated = true; else afterBytes = nextBytes;
            }
          } else break;
        }
      }
      const staticPrefixSamples = staticPrefix.map((message) => this.#mcapSample(message));
      const beforeSamples = before.map((message) => this.#mcapSample(message));
      const afterSamples = after.map((message) => this.#mcapSample(message));
      const samples = [...staticPrefixSamples, ...beforeSamples, ...afterSamples];
      const beforeSample = beforeSamples.at(-1);
      const afterSample = afterSamples.at(0);
      return { samples, ...(beforeSample ? { before: beforeSample } : {}), ...(afterSample ? { after: afterSample } : {}), truncated };
    }
    if (this.#kind === "ros1-bag") {
      if (!this.#ros1) throw new Error("Open a ROS1 bag before resolving TF history.");
      const target = this.#startTimeNanos + relativeTimeNanos;
      const start = target > TF_HISTORY_HORIZON_NANOS ? target - TF_HISTORY_HORIZON_NANOS : 0n;
      const end = target + TF_HISTORY_HORIZON_NANOS;
      const staticPrefix: Ros1Message[] = [];
      const before: Ros1Message[] = []; const after: Ros1Message[] = [];
      let staticPrefixBytes = 0; let beforeBytes = 0; let afterBytes = 0;
      let truncated = false;
      if (this.#ros1.mode === "indexed") {
        if (isStaticTfTopic(topic)) {
          for await (const message of this.#ros1.readIndexed({ topics: [topic], startTime: this.#startTimeNanos, endTime: target })) {
            if (staticPrefix.length === TF_STATIC_PREFIX_LIMIT) { truncated = true; break; }
            const nextBytes = appendTfHistoryMessage(staticPrefix, message, staticPrefixBytes);
            if (nextBytes === undefined) { truncated = true; break; }
            staticPrefixBytes = nextBytes;
          }
        }
        for await (const message of this.#ros1.readIndexed({ topics: [topic], startTime: start, endTime: target, reverse: true })) {
          if (before.length === TF_HISTORY_SIDE_LIMIT) { truncated = true; break; }
          const nextBytes = appendTfHistoryMessage(before, message, beforeBytes);
          if (nextBytes === undefined) { truncated = true; break; }
          beforeBytes = nextBytes;
        }
        before.reverse();
        if (!isStaticTfTopic(topic)) {
          for await (const message of this.#ros1.readIndexed({ topics: [topic], startTime: target, endTime: end })) {
            if (after.length === TF_HISTORY_SIDE_LIMIT) { truncated = true; break; }
            const nextBytes = appendTfHistoryMessage(after, message, afterBytes);
            if (nextBytes === undefined) { truncated = true; break; }
            afterBytes = nextBytes;
          }
        }
      } else {
        for await (const event of this.#ros1.scanUnindexed({ topics: [topic] })) {
          if (event.kind !== "message") continue;
          if (isStaticTfTopic(topic) && event.message.timeNanos <= target) {
            if (staticPrefix.length >= TF_STATIC_PREFIX_LIMIT) truncated = true;
            else {
              const nextBytes = appendTfHistoryMessage(staticPrefix, event.message, staticPrefixBytes);
              if (nextBytes === undefined) truncated = true; else staticPrefixBytes = nextBytes;
            }
          }
          if (event.message.timeNanos < start) continue;
          if (event.message.timeNanos <= target) {
            const rolled = rollTfHistoryMessage(before, event.message, beforeBytes);
            beforeBytes = rolled.bytes; truncated ||= rolled.truncated;
          } else if (!isStaticTfTopic(topic) && event.message.timeNanos <= end) {
            if (after.length >= TF_HISTORY_SIDE_LIMIT) truncated = true;
            else {
              const nextBytes = appendTfHistoryMessage(after, event.message, afterBytes);
              if (nextBytes === undefined) truncated = true; else afterBytes = nextBytes;
            }
          } else break;
        }
      }
      const staticPrefixSamples = staticPrefix.map((message) => this.#ros1Sample(message));
      const beforeSamples = before.map((message) => this.#ros1Sample(message));
      const afterSamples = after.map((message) => this.#ros1Sample(message));
      const samples = [...staticPrefixSamples, ...beforeSamples, ...afterSamples];
      const beforeSample = beforeSamples.at(-1);
      const afterSample = afterSamples.at(0);
      return { samples, ...(beforeSample ? { before: beforeSample } : {}), ...(afterSample ? { after: afterSample } : {}), truncated };
    }
    if (this.#kind === "ros2-sqlite") {
      if (!this.#ros2) throw new Error("Open a ROS2 bag before resolving TF history.");
      const target = this.#startTimeNanos + relativeTimeNanos;
      const start = target > TF_HISTORY_HORIZON_NANOS ? target - TF_HISTORY_HORIZON_NANOS : 0n;
      const end = target + TF_HISTORY_HORIZON_NANOS;
      const staticPrefix: Ros2SqliteMessage[] = [];
      const before: Ros2SqliteMessage[] = []; const after: Ros2SqliteMessage[] = [];
      let staticPrefixBytes = 0; let beforeBytes = 0; let afterBytes = 0; let truncated = false;
      if (isStaticTfTopic(topic)) {
        for await (const message of this.#ros2.readMessages({ topics: [topic], startTimeNanos: this.#startTimeNanos, endTimeNanos: target, order: "ascending", limit: TF_STATIC_PREFIX_LIMIT + 1 })) {
          if (staticPrefix.length >= TF_STATIC_PREFIX_LIMIT) { truncated = true; break; }
          const nextBytes = appendTfHistoryMessage(staticPrefix, message, staticPrefixBytes);
          if (nextBytes === undefined) { truncated = true; break; }
          staticPrefixBytes = nextBytes;
        }
      }
      for await (const message of this.#ros2.readMessages({ topics: [topic], startTimeNanos: start, endTimeNanos: target, order: "descending", limit: TF_HISTORY_SIDE_LIMIT })) {
        const nextBytes = appendTfHistoryMessage(before, message, beforeBytes);
        if (nextBytes === undefined) { truncated = true; break; }
        beforeBytes = nextBytes;
      }
      before.reverse();
      if (!isStaticTfTopic(topic)) {
        for await (const message of this.#ros2.readMessages({ topics: [topic], startTimeNanos: target, endTimeNanos: end, order: "ascending", limit: TF_HISTORY_SIDE_LIMIT })) {
          const nextBytes = appendTfHistoryMessage(after, message, afterBytes);
          if (nextBytes === undefined) { truncated = true; break; }
          afterBytes = nextBytes;
        }
      }
      const staticPrefixSamples = staticPrefix.map((message) => this.#ros2Sample(message));
      const beforeSamples = before.map((message) => this.#ros2Sample(message));
      const afterSamples = after.map((message) => this.#ros2Sample(message));
      const samples = [...staticPrefixSamples, ...beforeSamples, ...afterSamples];
      const beforeSample = beforeSamples.at(-1);
      const afterSample = afterSamples.at(0);
      return { samples, ...(beforeSample ? { before: beforeSample } : {}), ...(afterSample ? { after: afterSample } : {}), truncated: truncated || before.length === TF_HISTORY_SIDE_LIMIT || after.length === TF_HISTORY_SIDE_LIMIT };
    }
    throw new Error("Open a recording before resolving TF history.");
  }

  async close(): Promise<void> {
    await this.#closeCurrent();
  }

  async #messageAtMcap(topic: string, relativeTimeNanos: bigint): Promise<BrowserSample> {
    const session = this.#mcapSession;
    if (!session) throw new Error("Open an MCAP recording before resolving a topic message.");
    if (session.mode === "indexed") {
      const range = session.timeRange();
      const requestedTime = (range?.startTimeNanos ?? 0n) + relativeTimeNanos;
      for await (const message of session.readIndexed({ topics: [topic], endTime: requestedTime, reverse: true })) {
        return this.#mcapSample(message);
      }
      for await (const message of session.readIndexed({ topics: [topic], startTime: requestedTime })) {
        return this.#mcapSample(message);
      }
    } else {
      let selected: McapMessage | undefined;
      let firstForTopic: McapMessage | undefined;
      for await (const event of session.scanUnindexed()) {
        if (event.kind !== "message") continue;
        this.#mcapSequentialStartTimeNanos ??= event.message.logTimeNanos;
        const requestedTime = this.#mcapSequentialStartTimeNanos + relativeTimeNanos;
        if (event.message.channel.topic !== topic) continue;
        firstForTopic ??= event.message;
        if (event.message.logTimeNanos > requestedTime) break;
        selected = event.message;
      }
      if (selected ?? firstForTopic) return this.#mcapSample(selected ?? firstForTopic!);
    }
    throw new Error(`No message was found for ${topic}.`);
  }

  #mcapSample(message: McapMessage): BrowserSample {
    return {
      channel: { schema: message.channel.schema, messageEncoding: message.channel.messageEncoding },
      data: message.data,
      logTimeNanos: message.logTimeNanos,
      sourceSequence: message.sequence,
    };
  }

  #ros1Sample(message: Ros1Message): BrowserSample {
    return {
      channel: { schema: { name: message.connection.typeName, capability: message.connection.schema.capability, ...(message.connection.schema.definition ? { definition: message.connection.schema.definition, encoding: "ros1msg" } : {}) }, messageEncoding: "ros1" },
      data: message.data,
      logTimeNanos: message.timeNanos,
      sourceSequence: message.sequence,
    };
  }

  #ros2Sample(message: Ros2SqliteMessage): BrowserSample {
    return {
      channel: { schema: { name: message.topic.type, capability: message.topic.schema.capability === "opaque" ? "opaque" : "schema-present", ...(message.topic.schema.encoding ? { encoding: message.topic.schema.encoding } : {}), ...(message.topic.schema.definition ? { definition: message.topic.schema.definition } : {}) }, messageEncoding: message.topic.serializationFormat },
      data: message.data,
      logTimeNanos: message.timestampNanos,
      sourceSequence: (BigInt(message.partOrdinal) << 64n) | message.rowId,
    };
  }

  async #messageAtRos1(topic: string, relativeTimeNanos: bigint): Promise<BrowserSample> {
    if (!this.#ros1) throw new Error("Open a ROS1 bag before resolving a topic message.");
    const absoluteTime = this.#startTimeNanos + relativeTimeNanos;
    let selected: Ros1Message | undefined;
    if (this.#ros1.mode === "indexed") {
      for await (const message of this.#ros1.readIndexed({ topics: [topic], endTime: absoluteTime, reverse: true })) {
        selected = message;
        break;
      }
      if (!selected) {
        for await (const message of this.#ros1.readIndexed({ topics: [topic], startTime: absoluteTime })) {
          selected = message;
          break;
        }
      }
    } else {
      for await (const event of this.#ros1.scanUnindexed({ topics: [topic] })) {
        if (event.kind !== "message") continue;
        if (event.message.timeNanos > absoluteTime) {
          selected ??= event.message;
          break;
        }
        selected = event.message;
      }
    }
    if (!selected) throw new Error(`No ROS1 message was found for ${topic}.`);
    return this.#ros1Sample(selected);
  }

  async #messageAtRos2(topic: string, relativeTimeNanos: bigint): Promise<BrowserSample> {
    if (!this.#ros2) throw new Error("Open a ROS2 SQLite bag before resolving a topic message.");
    const absoluteTime = this.#startTimeNanos + relativeTimeNanos;
    let selected: Ros2SqliteMessage | undefined;
    for await (const message of this.#ros2.readMessages({ endTimeNanos: absoluteTime, topics: [topic], limit: 1, order: "descending" })) selected = message;
    if (!selected) {
      for await (const message of this.#ros2.readMessages({ startTimeNanos: absoluteTime, topics: [topic], limit: 1 })) selected = message;
    }
    if (!selected) throw new Error(`No ROS2 message was found for ${topic}.`);
    return this.#ros2Sample(selected);
  }

  async #closeCurrent(): Promise<void> {
    this.#ros1?.close();
    this.#ros1 = undefined;
    this.#ros1Epoch?.abort("recording replaced");
    this.#ros1Epoch = undefined;
    this.#ros1Compression?.close();
    this.#ros1Compression = undefined;
    if (this.#ros2) await this.#ros2.close();
    this.#ros2 = undefined;
    this.#ros2Epoch?.abort("recording replaced");
    this.#ros2Epoch = undefined;
    this.#mcapSession = undefined;
    this.#mcapEpoch?.advance("recording replaced");
    this.#mcapEpoch = undefined;
    this.#metadata = undefined;
    this.#hostedMcap = false;
    this.#mcapSequentialStartTimeNanos = undefined;
    this.#kind = undefined;
  }
}
