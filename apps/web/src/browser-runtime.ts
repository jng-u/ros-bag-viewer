import { LocalMcapDesktopRuntime } from "@ros-web-viewer/m1-integration";
import { McapSourceSession, type McapMessage } from "@ros-web-viewer/source-mcap";
import { BlobRangeSource, BoundedByteReader, SourceEpochController } from "@ros-web-viewer/worker-runtime";

import type { LocalMcapSelection, OpenLocalResult, SeekResult } from "./shell.js";

export type BrowserSourceFormat = "mcap" | "ros1-bag" | "ros2-sqlite" | "unknown";

export function detectBrowserSourceFormat(fileName: string): BrowserSourceFormat {
  const lower = fileName.toLocaleLowerCase();
  if (lower.endsWith(".mcap")) return "mcap";
  if (lower.endsWith(".bag")) return "ros1-bag";
  if (lower.endsWith(".db3") || lower.endsWith("metadata.yaml") || lower.endsWith("metadata.yml")) {
    return "ros2-sqlite";
  }
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

/** Browser-facing MCAP runtime. Other adapters remain explicit, honest capability errors. */
export class BrowserRecordingRuntime {
  readonly #metadata = new LocalMcapDesktopRuntime();
  #blob?: Blob;

  async open(selection: LocalMcapSelection): Promise<OpenLocalResult> {
    const format = selection.format ?? detectBrowserSourceFormat(selection.name);
    if (format === "ros1-bag") {
      throw new Error("ROS1 bag parsing exists in the core, but this Docker browser build has not wired its codec runtime yet. Convert to MCAP for this preview.");
    }
    if (format === "ros2-sqlite") {
      throw new Error("ROS2 SQLite needs a browser SQLite/WASM provider and metadata.yaml bundle selection. This Docker preview currently runs MCAP directly.");
    }
    if (format !== "mcap") throw new Error("Unsupported file. Drop an .mcap recording.");
    const result = await this.#metadata.openLocalMcap(selection);
    this.#blob = selection.blob;
    return result;
  }

  seek(timeNanos: bigint): Promise<SeekResult> {
    return this.#metadata.seek(timeNanos);
  }

  async sample(topic: string, relativeTimeNanos: bigint): Promise<McapMessage> {
    if (!this.#blob) throw new Error("Open an MCAP recording before sampling a topic.");
    const epoch = new SourceEpochController();
    const reader = new BoundedByteReader(new BlobRangeSource(this.#blob), epoch, SAMPLE_LIMITS);
    const session = await McapSourceSession.open(reader);
    if (session.mode === "indexed") {
      const range = session.timeRange();
      const startTime = (range?.startTimeNanos ?? 0n) + relativeTimeNanos;
      for await (const message of session.readIndexed({ topics: [topic], startTime })) return message;
      let previous: McapMessage | undefined;
      for await (const message of session.readIndexed({ topics: [topic], endTime: startTime })) previous = message;
      if (previous) return previous;
    } else {
      for await (const event of session.scanUnindexed({ topics: [topic] })) {
        if (event.kind === "message") return event.message;
      }
    }
    throw new Error(`No message was found for ${topic}.`);
  }
}
