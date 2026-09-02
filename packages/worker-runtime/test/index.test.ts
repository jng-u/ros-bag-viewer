import { describe, expect, it } from "vitest";

import {
  BlobRangeSource,
  BoundedByteReader,
  GrantedRangeSource,
  HARD_WORKER_LIMITS,
  SourceEpochController,
  TestableWorkerPort,
  type ByteRange,
  type RangeSource,
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

class ControlledRangeSource implements RangeSource {
  readonly size = 16n;
  readonly #pending: Array<() => void> = [];

  read(range: ByteRange): Promise<Uint8Array> {
    return new Promise((resolve) => {
      this.#pending.push(() => resolve(new Uint8Array(Number(range.length))));
    });
  }

  releaseNext(): void {
    const release = this.#pending.shift();
    if (!release) throw new Error("no active range read to release");
    release();
  }
}

function readerWith(resourceLimits: WorkerResourceLimits): BoundedByteReader {
  return new BoundedByteReader(
    new BlobRangeSource(new Blob([new Uint8Array(16)])),
    new SourceEpochController(),
    resourceLimits,
  );
}

describe("bounded byte reader", () => {
  it("rejects non-finite concurrency and queue limits at construction", () => {
    expect(() => readerWith({ ...limits, maxConcurrentReads: Number.POSITIVE_INFINITY })).toThrow(/maxConcurrentReads/);
    expect(() => readerWith({ ...limits, maxQueuedReads: Number.NaN })).toThrow(/maxQueuedReads/);
  });

  it("validates every numeric limit against missing, non-finite, signed, unsafe, and hard-ceiling inputs", () => {
    const positiveFields = [
      "maxSingleReadBytes",
      "maxConcurrentReads",
      "maxBufferedBytes",
      "maxDecompressedBytes",
      "maxDecompressionRatio",
    ] as const;
    const nonnegativeFields = ["maxQueuedReads", "maxCacheBytes"] as const;
    for (const field of [...positiveFields, ...nonnegativeFields]) {
      const missing = { ...limits } as Record<keyof WorkerResourceLimits, number | bigint>;
      delete missing[field];
      expect(() => readerWith(missing as unknown as WorkerResourceLimits)).toThrow(new RegExp(field));
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => readerWith({ ...limits, [field]: value })).toThrow(new RegExp(field));
      }
      expect(() => readerWith({ ...limits, [field]: HARD_WORKER_LIMITS[field] + 1 })).toThrow(
        new RegExp(`${field} cannot exceed the hard worker resource limit`),
      );
    }
    for (const field of positiveFields) {
      expect(() => readerWith({ ...limits, [field]: 0 })).toThrow(new RegExp(`${field} must be a positive safe integer`));
    }
    expect(() => readerWith({ ...limits, maxQueuedReads: 0, maxCacheBytes: 0 })).not.toThrow();
  });

  it("validates the bigint session total and accepts the exact coherent hard ceilings", () => {
    for (const value of [undefined, 0n, -1n, Number.NaN, 1] as const) {
      expect(() => readerWith({ ...limits, maxTotalReadBytes: value } as unknown as WorkerResourceLimits)).toThrow(
        /maxTotalReadBytes/,
      );
    }
    expect(() => readerWith({
      ...limits,
      maxTotalReadBytes: HARD_WORKER_LIMITS.maxTotalReadBytes + 1n,
    })).toThrow(/maxTotalReadBytes cannot exceed the hard worker resource limit/);
    expect(() => readerWith(HARD_WORKER_LIMITS)).not.toThrow();
  });

  it("rejects incoherent nested byte budgets", () => {
    expect(() => readerWith({ ...limits, maxSingleReadBytes: 9, maxBufferedBytes: 8 })).toThrow(
      /maxSingleReadBytes cannot exceed maxBufferedBytes/,
    );
    expect(() => readerWith({ ...limits, maxSingleReadBytes: 4, maxTotalReadBytes: 3n })).toThrow(
      /maxSingleReadBytes cannot exceed maxTotalReadBytes/,
    );
    expect(() => readerWith({ ...limits, maxBufferedBytes: 17, maxDecompressedBytes: 16 })).toThrow(
      /maxBufferedBytes cannot exceed maxDecompressedBytes/,
    );
    expect(() => readerWith({ ...limits, maxCacheBytes: 17, maxDecompressedBytes: 16 })).toThrow(
      /maxCacheBytes cannot exceed maxDecompressedBytes/,
    );
  });

  it("enforces exact active, queued, and rejected read telemetry at the configured boundaries", async () => {
    const source = new ControlledRangeSource();
    const reader = new BoundedByteReader(source, new SourceEpochController(), { ...limits, maxQueuedReads: 2 });
    const first = reader.read(0n, 1n);
    const second = reader.read(1n, 1n);
    const third = reader.read(2n, 1n);
    await expect(reader.read(3n, 1n)).rejects.toThrow(/bounded read queue is full/);
    expect(reader.snapshotTelemetry()).toEqual({
      readCalls: 4,
      requestedBytes: 3n,
      completedBytes: 0n,
      activeReads: 1,
      queuedReads: 2,
      peakActiveReads: 1,
      peakInFlightBytes: 1,
      cancelledReads: 0,
      rejectedReads: 1,
    });
    source.releaseNext();
    await first;
    source.releaseNext();
    await second;
    source.releaseNext();
    await third;
    expect(reader.snapshotTelemetry()).toMatchObject({
      requestedBytes: 3n,
      completedBytes: 3n,
      activeReads: 0,
      queuedReads: 0,
      peakActiveReads: 1,
      rejectedReads: 1,
    });
  });

  it("copies validated limits so post-construction mutation cannot reopen the bypass", async () => {
    const source = new ControlledRangeSource();
    const mutableLimits = { ...limits, maxQueuedReads: 0 };
    const reader = new BoundedByteReader(source, new SourceEpochController(), mutableLimits);
    mutableLimits.maxConcurrentReads = Number.POSITIVE_INFINITY;
    mutableLimits.maxQueuedReads = Number.NaN;
    const active = reader.read(0n, 1n);
    await expect(reader.read(1n, 1n)).rejects.toThrow(/bounded read queue is full/);
    expect(reader.snapshotTelemetry()).toMatchObject({
      activeReads: 1,
      queuedReads: 0,
      peakActiveReads: 1,
      rejectedReads: 1,
    });
    source.releaseNext();
    await active;
  });

  it("validates the same one-time caller snapshot that it stores", async () => {
    const source = new ControlledRangeSource();
    const accessorLimits = { ...limits, maxQueuedReads: 0 };
    let concurrentReads = 1;
    Object.defineProperty(accessorLimits, "maxConcurrentReads", {
      enumerable: true,
      get: () => {
        const value = concurrentReads;
        concurrentReads = Number.POSITIVE_INFINITY;
        return value;
      },
    });
    const reader = new BoundedByteReader(source, new SourceEpochController(), accessorLimits);
    const active = reader.read(0n, 1n);
    await expect(reader.read(1n, 1n)).rejects.toThrow(/bounded read queue is full/);
    source.releaseNext();
    await active;
  });

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

  it("applies maxTotalReadBytes per source epoch instead of permanently exhausting an interactive session", async () => {
    const epoch = new SourceEpochController();
    const reader = new BoundedByteReader(new BlobRangeSource(new Blob([new Uint8Array(16)])), epoch, limits);
    await reader.read(0n, 4n);
    await reader.read(4n, 4n);
    await reader.read(8n, 4n);
    await reader.read(12n, 4n);
    await expect(reader.read(0n, 1n)).rejects.toThrow(/maxTotalReadBytes/u);
    epoch.advance("seek");
    await expect(reader.read(0n, 4n)).resolves.toHaveLength(4);
    expect(reader.snapshotTelemetry()).toMatchObject({ requestedBytes: 20n, completedBytes: 20n });
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
