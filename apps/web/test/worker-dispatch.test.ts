import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

import { BrowserCompressionWorker } from "../src/browser-compression.js";
import { BrowserMessageDecoder } from "../src/browser-message-decoder.js";
import { BrowserRecordingWorker } from "../src/browser-recording-worker.js";
import { BrowserSqliteQueryProvider } from "../src/browser-sqlite.js";

class ThrowingWorker extends EventTarget {
  postMessage(): never { throw new Error("structured clone dispatch failed"); }
  terminate(): void {}
}

describe("browser Worker dispatch cleanup", () => {
  beforeEach(() => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("Worker", ThrowingWorker);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("settles recording and message decoder requests when postMessage throws", async () => {
    const recording = new BrowserRecordingWorker();
    await expect(recording.messageAt("/points", 0n)).rejects.toThrow(/structured clone dispatch failed/);
    recording.close();

    const decoder = new BrowserMessageDecoder();
    await expect(decoder.semantic({
      channel: { schema: { name: "std_msgs/msg/Float64", capability: "schema-present" }, messageEncoding: "cdr" },
      data: new Uint8Array(12),
      logTimeNanos: 0n,
    })).rejects.toThrow(/structured clone dispatch failed/);
    decoder.close();
  });

  it("settles decompression dispatch failures and rejects SQLite outside the OPFS Worker boundary", async () => {
    const compression = new BrowserCompressionWorker();
    await expect(compression.decompress("lz4", Uint8Array.of(1), 1, new AbortController().signal)).rejects.toThrow(/structured clone dispatch failed/);
    compression.close();

    const provider = new BrowserSqliteQueryProvider(false, false);
    await expect(provider.open({
      relativePath: "data.db3",
      sizeBytes: 1n,
      read: async () => Uint8Array.of(0),
    }, new AbortController().signal)).rejects.toThrow(/requires a recording Worker/);
  });

  it("uses a nested decompression worker that is replaced on abort", async () => {
    const recordingSource = await readFile(new URL("../src/recording-worker.ts", import.meta.url), "utf8");
    const compressionSource = await readFile(new URL("../src/browser-compression.ts", import.meta.url), "utf8");
    expect(recordingSource).toContain("forceInlineProcessing: false");
    expect(compressionSource).toContain("this.#replaceWorker");
    expect(compressionSource).toContain("this.#worker.terminate()");
  });
});
