export class BrowserCompressionWorker {
  #worker: Worker;
  readonly #pending = new Map<number, { readonly resolve: (value: Uint8Array) => void; readonly reject: (error: Error) => void }>();
  #nextId = 1;
  #closed = false;

  constructor() {
    this.#worker = this.#createWorker();
  }

  #createWorker(): Worker {
    const worker = new Worker(new URL("./compression-worker.js", import.meta.url), { type: "module", name: "ros1-decompression" });
    worker.addEventListener("message", (event: MessageEvent<{ readonly id: number; readonly ok: boolean; readonly output?: Uint8Array; readonly error?: string }>) => {
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      if (event.data.ok && event.data.output) pending.resolve(event.data.output); else pending.reject(new Error(event.data.error ?? "ROS1 decompression worker failed."));
    });
    worker.addEventListener("error", () => {
      if (this.#worker !== worker) return;
      this.#closed = true;
      worker.terminate();
      this.#rejectAll(new Error("ROS1 decompression worker crashed."));
    });
    return worker;
  }

  decompress(codec: "bz2" | "lz4", compressed: Uint8Array, declaredSize: number, signal: AbortSignal): Promise<Uint8Array> {
    if (this.#closed) return Promise.reject(new Error("ROS1 decompression worker is unavailable."));
    if (signal.aborted) return Promise.reject(new DOMException("ROS1 decompression aborted", "AbortError"));
    const id = this.#nextId++;
    const owned = compressed.slice();
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!this.#pending.delete(id)) return;
        reject(new DOMException("ROS1 decompression aborted", "AbortError"));
        this.#replaceWorker(new DOMException("ROS1 decompression superseded", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => { signal.removeEventListener("abort", abort); resolve(value); },
        reject: (error) => { signal.removeEventListener("abort", abort); reject(error); },
      });
      try {
        this.#worker.postMessage({ id, codec, compressed: owned, declaredSize }, [owned.buffer]);
      } catch (error) {
        signal.removeEventListener("abort", abort);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.terminate();
    this.#rejectAll(new Error("ROS1 decompression worker closed."));
  }

  #replaceWorker(error: Error): void {
    this.#worker.terminate();
    this.#rejectAll(error);
    this.#closed = false;
    this.#worker = this.#createWorker();
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
