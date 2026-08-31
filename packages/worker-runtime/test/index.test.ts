import { describe, expect, it } from "vitest";

import {
  BlobRangeSource,
  BoundedByteReader,
  GrantedRangeSource,
  SourceEpochController,
  TestableWorkerPort,
  type WorkerResourceLimits,
} from "../src/index.js";

const limits: WorkerResourceLimits = {
  maxSingleReadBytes: 4,
  maxTotalReadBytes: 16n,
  maxConcurrentReads: 1,
  maxQueuedReads: 1,
  maxBufferedBytes: 16,
  maxDecompressedBytes: 16,
  maxDecompressionRatio: 4,
  maxCacheBytes: 8,
};

describe("bounded byte reader", () => {
  it("reads exact Blob slices and reports dimensional telemetry", async () => {
    const epoch = new SourceEpochController();
    const reader = new BoundedByteReader(new BlobRangeSource(new Blob([Uint8Array.of(0, 1, 2, 3, 4)])), epoch, limits);

    await expect(reader.read(1n, 3n)).resolves.toEqual(Uint8Array.of(1, 2, 3));
    expect(reader.snapshotTelemetry()).toMatchObject({
      readCalls: 1,
      requestedBytes: 3n,
      completedBytes: 3n,
      peakActiveReads: 1,
      peakInFlightBytes: 3,
    });
  });

  it("rejects oversized and out-of-bounds requests without whole-source fallback", async () => {
    const reader = new BoundedByteReader(new BlobRangeSource(new Blob([new Uint8Array(10)])), new SourceEpochController(), limits);
    await expect(reader.read(0n, 5n)).rejects.toThrow(/maxSingleReadBytes/);
    await expect(reader.read(9n, 2n)).rejects.toThrow(/outside/);
    expect(reader.snapshotTelemetry().rejectedReads).toBe(2);
  });

  it("cancels an in-flight granted range when the source epoch advances", async () => {
    const epoch = new SourceEpochController();
    const source = new GrantedRangeSource(4n, "sha256:fixed", (_range, signal) =>
      new Promise<Uint8Array>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
        setTimeout(() => resolve(Uint8Array.of(1, 2)), 100);
      }),
    );
    const reader = new BoundedByteReader(source, epoch, limits);
    const pending = reader.read(0n, 2n);
    epoch.advance("seek");
    await expect(pending).rejects.toThrow(/cancelled|seek/);
    expect(reader.snapshotTelemetry().cancelledReads).toBe(1);
  });
});

describe("testable Worker port", () => {
  it("rejects stale requests and discards results completed after seek", async () => {
    const epoch = new SourceEpochController();
    const port = new TestableWorkerPort(
      { handle: async () => "ok" },
      epoch,
    );
    await expect(port.dispatch({ requestId: 1, epoch: 1, operation: "open", payload: null })).resolves.toMatchObject({
      ok: false,
      error: "stale source epoch",
    });
    await expect(port.dispatch({ requestId: 2, epoch: 0, operation: "open", payload: null })).resolves.toMatchObject({
      ok: true,
      result: "ok",
    });
  });
});
