import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

import { BrowserCompressionWorker } from "../src/browser-compression.js";
import { BrowserMessageDecoder } from "../src/browser-message-decoder.js";
import { BrowserRecordingWorker } from "../src/browser-recording-worker.js";
import { BrowserSqliteQueryProvider } from "../src/browser-sqlite.js";

class ControlledRecordingWorker extends EventTarget {
  static instances: ControlledRecordingWorker[] = [];
  requests: { id: number; operation: string; selection?: { name: string } }[] = [];
  terminated = false;
  constructor() { super(); ControlledRecordingWorker.instances.push(this); }
  postMessage(request: { id: number; operation: string; selection?: { name: string } }): void { this.requests.push(request); }
  terminate(): void { this.terminated = true; }
  respond(id: number, value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: { id, ok: true, value } }));
  }
}

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

  it("keeps the latest ROS1 open when source replacement overlaps a completed close", async () => {
    ControlledRecordingWorker.instances = [];
    vi.stubGlobal("Worker", ControlledRecordingWorker);
    const recording = new BrowserRecordingWorker("test-namespace");
    const first = recording.open({ name: "previous.mcap", sizeBytes: 1, immutableVersion: "1" });
    const firstSettled = first.catch((error: unknown) => error);
    const original = ControlledRecordingWorker.instances[0]!;
    original.respond(original.requests[0]!.id, undefined);
    const latest = recording.open({ name: "htp_01.bag", format: "ros1-bag", sizeBytes: 1, immutableVersion: "2" });
    // Capture cancellation as a value so failures cannot become unhandled rejections.
    const latestSettled = latest.catch((error: unknown) => error);
    await vi.waitFor(() => {
      const active = ControlledRecordingWorker.instances.at(-1)!;
      expect(active.requests.some((request) => request.operation === "open")).toBe(true);
    });
    const active = ControlledRecordingWorker.instances.at(-1)!;
    const openRequests = active.requests.filter((request) => request.operation === "open");
    expect(openRequests).toHaveLength(1);
    expect(openRequests[0]!.selection!.name).toBe("htp_01.bag");
    for (const request of openRequests) {
      active.respond(request.id, {
        sourceLabel: request.selection!.name, sourceHash: "2", durationNanos: 1n,
        epoch: 1, indexState: "indexed", topics: [],
      });
    }
    expect(await latestSettled).toMatchObject({ sourceLabel: "htp_01.bag", indexState: "indexed" });
    expect(await firstSettled).toMatchObject({ message: "recording source replaced" });
    const closing = recording.close();
    const close = active.requests.at(-1)!;
    active.respond(close.id, undefined);
    await closing;
  });

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
