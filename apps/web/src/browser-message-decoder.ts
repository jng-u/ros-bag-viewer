import type { DecodedSemanticMessage } from "@ros-web-viewer/m1-integration";
import type { PointCloud2DisplayConfig, PreparedPointCloud2 } from "@ros-web-viewer/displays-core";
import type { BrowserSample } from "./browser-runtime.js";
import type { GenericRosDecodeInput, GenericRosDecodeResult } from "./generic-ros-decoder.js";

type Response = { readonly id: number; readonly ok: true; readonly value: unknown } | { readonly id: number; readonly ok: false; readonly error: string };

export interface PreparedSemanticMessage {
  readonly decoded: DecodedSemanticMessage;
  readonly pointCloud?: PreparedPointCloud2;
  readonly rawImageRgba?: Uint8ClampedArray;
}

/** Off-main semantic and schema-backed decoder with fail-closed crash behavior. */
export class BrowserMessageDecoder {
  #worker: Worker;
  readonly #pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timeout: number }>();
  #nextId = 1;
  #closed = false;

  constructor() {
    this.#worker = this.#createWorker();
  }

  reset(reason = "Message decode superseded by a newer render."): void {
    if (this.#closed) return;
    const previous = this.#worker;
    previous.terminate();
    this.#rejectAll(new DOMException(reason, "AbortError"));
    this.#worker = this.#createWorker();
  }

  #createWorker(): Worker {
    const worker = new Worker(new URL("./decoder-worker.js", import.meta.url), { type: "module", name: "ros-message-decoder" });
    worker.addEventListener("message", (event: MessageEvent<Response>) => {
      if (worker !== this.#worker) return;
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      clearTimeout(pending.timeout);
      if (event.data.ok) pending.resolve(event.data.value); else pending.reject(new Error(event.data.error));
    });
    worker.addEventListener("error", () => {
      if (worker !== this.#worker) return;
      this.#closed = true;
      worker.terminate();
      this.#rejectAll(new Error("Message decoder worker crashed."));
    });
    return worker;
  }

  semantic(sample: BrowserSample): Promise<DecodedSemanticMessage> {
    const owned = sample.data.slice();
    return this.#request({ operation: "semantic", sample: { ...sample, data: owned } }, owned.buffer) as Promise<DecodedSemanticMessage>;
  }

  semanticPrepared(sample: BrowserSample, pointCloudConfig: PointCloud2DisplayConfig): Promise<PreparedSemanticMessage> {
    const owned = sample.data.slice();
    return this.#request({ operation: "semantic-prepared", sample: { ...sample, data: owned }, pointCloudConfig }, owned.buffer) as Promise<PreparedSemanticMessage>;
  }

  generic(input: GenericRosDecodeInput): Promise<GenericRosDecodeResult> {
    const owned = input.data.slice();
    return this.#request({ operation: "generic", input: { ...input, data: owned } }, owned.buffer) as Promise<GenericRosDecodeResult>;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.terminate();
    this.#rejectAll(new Error("Message decoder worker closed."));
  }

  #request(request: Readonly<Record<string, unknown>>, transfer: ArrayBuffer): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Message decoder worker is unavailable."));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new Error("Message decoder worker timed out."));
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timeout });
      try {
        this.#worker.postMessage({ id, ...request }, [transfer]);
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.#pending.clear();
  }
}
