export interface ByteRange {
  readonly offset: bigint;
  readonly length: bigint;
}

export interface RangeSource {
  readonly size: bigint;
  read(range: ByteRange, signal: AbortSignal): Promise<Uint8Array>;
}

export interface WorkerResourceLimits {
  readonly maxSingleReadBytes: number;
  readonly maxTotalReadBytes: bigint;
  readonly maxConcurrentReads: number;
  readonly maxQueuedReads: number;
  readonly maxBufferedBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxDecompressionRatio: number;
  readonly maxCacheBytes: number;
}

export const DEFAULT_WORKER_LIMITS: WorkerResourceLimits = {
  maxSingleReadBytes: 4 * 1024 * 1024,
  maxTotalReadBytes: 512n * 1024n * 1024n,
  maxConcurrentReads: 4,
  maxQueuedReads: 32,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxDecompressedBytes: 64 * 1024 * 1024,
  maxDecompressionRatio: 100,
  maxCacheBytes: 32 * 1024 * 1024,
};

export interface ReadTelemetry {
  readCalls: number;
  requestedBytes: bigint;
  completedBytes: bigint;
  activeReads: number;
  queuedReads: number;
  peakActiveReads: number;
  peakInFlightBytes: number;
  cancelledReads: number;
  rejectedReads: number;
}

function abortError(reason?: unknown): Error {
  const error = new Error(reason instanceof Error ? reason.message : "operation aborted");
  error.name = "AbortError";
  return error;
}

function assertRange(range: ByteRange, size: bigint): void {
  if (range.offset < 0n || range.length < 0n || range.offset + range.length > size) {
    throw new RangeError("byte range is outside the immutable source");
  }
}

export class BlobRangeSource implements RangeSource {
  readonly size: bigint;
  readonly #blob: Blob;

  constructor(blob: Blob) {
    this.#blob = blob;
    this.size = BigInt(blob.size);
  }

  async read(range: ByteRange, signal: AbortSignal): Promise<Uint8Array> {
    assertRange(range, this.size);
    if (signal.aborted) throw abortError(signal.reason);
    const start = Number(range.offset);
    const end = Number(range.offset + range.length);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new RangeError("Blob offsets exceed the JavaScript safe-integer range");
    }
    const data = new Uint8Array(await this.#blob.slice(start, end).arrayBuffer());
    if (signal.aborted) throw abortError(signal.reason);
    return data;
  }
}

export type GrantedRangeFetcher = (range: ByteRange, signal: AbortSignal) => Promise<Uint8Array>;

export class GrantedRangeSource implements RangeSource {
  readonly size: bigint;
  readonly immutableVersion: string;
  readonly #fetch: GrantedRangeFetcher;

  constructor(size: bigint, immutableVersion: string, fetchRange: GrantedRangeFetcher) {
    if (size < 0n || !immutableVersion) throw new Error("granted range source must be immutable and sized");
    this.size = size;
    this.immutableVersion = immutableVersion;
    this.#fetch = fetchRange;
  }

  async read(range: ByteRange, signal: AbortSignal): Promise<Uint8Array> {
    assertRange(range, this.size);
    const data = await this.#fetch(range, signal);
    if (BigInt(data.byteLength) !== range.length) {
      throw new Error("granted range response length does not match the requested immutable range");
    }
    return data;
  }
}

export class SourceEpochController {
  #epoch = 0;
  #controller = new AbortController();

  get epoch(): number {
    return this.#epoch;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  advance(reason = "source epoch advanced"): number {
    this.#controller.abort(reason);
    this.#epoch += 1;
    this.#controller = new AbortController();
    return this.#epoch;
  }
}

interface QueuedRead {
  readonly offset: bigint;
  readonly size: bigint;
  readonly epoch: number;
  readonly signal: AbortSignal;
  readonly resolve: (value: Uint8Array) => void;
  readonly reject: (error: unknown) => void;
}

export class BoundedByteReader {
  readonly #source: RangeSource;
  readonly #limits: WorkerResourceLimits;
  readonly #epoch: SourceEpochController;
  readonly #queue: QueuedRead[] = [];
  readonly #telemetry: ReadTelemetry = {
    readCalls: 0,
    requestedBytes: 0n,
    completedBytes: 0n,
    activeReads: 0,
    queuedReads: 0,
    peakActiveReads: 0,
    peakInFlightBytes: 0,
    cancelledReads: 0,
    rejectedReads: 0,
  };
  #inFlightBytes = 0;

  constructor(source: RangeSource, epoch: SourceEpochController, limits: WorkerResourceLimits = DEFAULT_WORKER_LIMITS) {
    this.#source = source;
    this.#epoch = epoch;
    this.#limits = limits;
    if (limits.maxConcurrentReads < 1 || limits.maxQueuedReads < 0 || limits.maxSingleReadBytes < 1) {
      throw new Error("worker read limits must be positive and finite");
    }
  }

  async size(): Promise<bigint> {
    return this.#source.size;
  }

  read(offset: bigint, size: bigint): Promise<Uint8Array> {
    this.#telemetry.readCalls += 1;
    try {
      assertRange({ offset, length: size }, this.#source.size);
      if (size > BigInt(this.#limits.maxSingleReadBytes)) {
        throw new Error("byte range exceeds maxSingleReadBytes");
      }
      if (this.#telemetry.requestedBytes + size > this.#limits.maxTotalReadBytes) {
        throw new Error("byte range session exceeds maxTotalReadBytes");
      }
      if (this.#epoch.signal.aborted) throw abortError(this.#epoch.signal.reason);
      if (this.#telemetry.activeReads >= this.#limits.maxConcurrentReads && this.#queue.length >= this.#limits.maxQueuedReads) {
        throw new Error("bounded read queue is full");
      }
    } catch (error) {
      this.#telemetry.rejectedReads += 1;
      return Promise.reject(error);
    }

    this.#telemetry.requestedBytes += size;
    return new Promise<Uint8Array>((resolve, reject) => {
      this.#queue.push({ offset, size, epoch: this.#epoch.epoch, signal: this.#epoch.signal, resolve, reject });
      this.#telemetry.queuedReads = this.#queue.length;
      this.#drain();
    });
  }

  snapshotTelemetry(): Readonly<ReadTelemetry> {
    return { ...this.#telemetry };
  }

  #drain(): void {
    while (this.#telemetry.activeReads < this.#limits.maxConcurrentReads && this.#queue.length > 0) {
      const item = this.#queue.shift();
      if (!item) return;
      this.#telemetry.queuedReads = this.#queue.length;
      void this.#execute(item);
    }
  }

  async #execute(item: QueuedRead): Promise<void> {
    const { epoch, signal } = item;
    const byteLength = Number(item.size);
    this.#telemetry.activeReads += 1;
    this.#inFlightBytes += byteLength;
    this.#telemetry.peakActiveReads = Math.max(this.#telemetry.peakActiveReads, this.#telemetry.activeReads);
    this.#telemetry.peakInFlightBytes = Math.max(this.#telemetry.peakInFlightBytes, this.#inFlightBytes);
    try {
      if (signal.aborted || epoch !== this.#epoch.epoch) throw abortError(signal.reason);
      const data = await this.#source.read({ offset: item.offset, length: item.size }, signal);
      if (signal.aborted || epoch !== this.#epoch.epoch) throw abortError(signal.reason);
      if (BigInt(data.byteLength) !== item.size) throw new Error("range source returned an unexpected byte count");
      this.#telemetry.completedBytes += item.size;
      item.resolve(data);
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.#telemetry.cancelledReads += 1;
      } else {
        this.#telemetry.rejectedReads += 1;
      }
      item.reject(error);
    } finally {
      this.#telemetry.activeReads -= 1;
      this.#inFlightBytes -= byteLength;
      this.#drain();
    }
  }
}

export interface WorkerRequest<TPayload = unknown> {
  readonly requestId: number;
  readonly epoch: number;
  readonly operation: string;
  readonly payload: TPayload;
}

export type WorkerResponse<TResult = unknown> =
  | { readonly requestId: number; readonly epoch: number; readonly ok: true; readonly result: TResult }
  | { readonly requestId: number; readonly epoch: number; readonly ok: false; readonly error: string };

export interface WorkerRequestHandler {
  handle(request: WorkerRequest, signal: AbortSignal): Promise<unknown>;
}

export class TestableWorkerPort {
  readonly #handler: WorkerRequestHandler;
  readonly #epoch: SourceEpochController;

  constructor(handler: WorkerRequestHandler, epoch: SourceEpochController) {
    this.#handler = handler;
    this.#epoch = epoch;
  }

  async dispatch(request: WorkerRequest): Promise<WorkerResponse> {
    if (request.epoch !== this.#epoch.epoch) {
      return { requestId: request.requestId, epoch: request.epoch, ok: false, error: "stale source epoch" };
    }
    try {
      const result = await this.#handler.handle(request, this.#epoch.signal);
      if (request.epoch !== this.#epoch.epoch) throw abortError();
      return { requestId: request.requestId, epoch: request.epoch, ok: true, result };
    } catch (error) {
      return {
        requestId: request.requestId,
        epoch: request.epoch,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
