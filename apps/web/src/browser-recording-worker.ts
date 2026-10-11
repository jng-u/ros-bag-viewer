import type { BrowserSample, BrowserSampleWindow } from "./browser-runtime.js";
import type { LocalMcapSelection, OpenHostedResult, OpenLocalResult, SeekResult } from "./shell.js";

type Request =
  | { readonly operation: "open"; readonly selection: LocalMcapSelection }
  | { readonly operation: "openHostedMcap"; readonly link: string }
  | { readonly operation: "seek"; readonly timeNanos: bigint }
  | { readonly operation: "messageAt"; readonly topic: string; readonly relativeTimeNanos: bigint }
  | { readonly operation: "messagesAround"; readonly topic: string; readonly relativeTimeNanos: bigint }
  | { readonly operation: "close" };

type Response = { readonly id: number; readonly ok: true; readonly value: unknown } | { readonly id: number; readonly ok: false; readonly error: string };

/** UI-thread proxy for all recording parsing and SQLite work. */
export class BrowserRecordingWorker {
  #worker: Worker;
  readonly #pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timeout: number }>();
  #nextId = 1;
  #epoch = 0;
  #sourceGeneration = 0;
  #closed = false;
  #openRequest?: Extract<Request, { readonly operation: "open" | "openHostedMcap" }>;
  readonly #opfsNamespace: string;

  constructor(opfsNamespace = perTabOpfsNamespace()) {
    this.#opfsNamespace = opfsNamespace;
    this.#worker = this.#createWorker();
  }

  async open(selection: LocalMcapSelection): Promise<OpenLocalResult> {
    const generation = ++this.#sourceGeneration;
    this.#openRequest = undefined;
    await this.#replaceWorker("recording source replaced");
    if (generation !== this.#sourceGeneration) throw new Error("recording source replaced");
    const request = { operation: "open", selection } as const;
    const result = await this.#request(request) as OpenLocalResult;
    if (generation !== this.#sourceGeneration) throw new Error("recording source replaced");
    this.#openRequest = request;
    this.#epoch += 1;
    return { ...result, epoch: this.#epoch };
  }
  async openHostedMcap(link: string): Promise<OpenHostedResult> {
    const generation = ++this.#sourceGeneration;
    this.#openRequest = undefined;
    await this.#replaceWorker("recording source replaced");
    if (generation !== this.#sourceGeneration) throw new Error("recording source replaced");
    const request = { operation: "openHostedMcap", link } as const;
    const result = await this.#request(request) as OpenHostedResult;
    if (generation !== this.#sourceGeneration) throw new Error("recording source replaced");
    this.#openRequest = request;
    this.#epoch += 1;
    return { ...result, epoch: this.#epoch };
  }
  async seek(timeNanos: bigint): Promise<SeekResult> {
    if (this.#pending.size > 0) {
      const openRequest = this.#openRequest;
      if (!openRequest) throw new Error("Cannot cancel stale recording work before a source is open.");
      await this.#replaceWorker("recording seek superseded stale source work");
      await this.#request(openRequest);
    }
    const result = await this.#request({ operation: "seek", timeNanos }) as SeekResult;
    this.#epoch += 1;
    return { ...result, epoch: this.#epoch };
  }
  messageAt(topic: string, relativeTimeNanos: bigint): Promise<BrowserSample> { return this.#request({ operation: "messageAt", topic, relativeTimeNanos }) as Promise<BrowserSample>; }
  messagesAround(topic: string, relativeTimeNanos: bigint): Promise<BrowserSampleWindow> { return this.#request({ operation: "messagesAround", topic, relativeTimeNanos }) as Promise<BrowserSampleWindow>; }

  #createWorker(): Worker {
    const worker = new Worker(new URL("./recording-worker.js", import.meta.url), { type: "module", name: "ros-recording-source" });
    worker.addEventListener("message", (event: MessageEvent<Response>) => {
      if (this.#worker !== worker) return;
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      clearTimeout(pending.timeout);
      if (event.data.ok) pending.resolve(event.data.value); else pending.reject(new Error(event.data.error));
    });
    worker.addEventListener("error", () => {
      if (this.#worker !== worker) return;
      this.#closed = true;
      worker.terminate();
      this.#rejectAll(new Error("Recording source worker crashed."));
    });
    return worker;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#sourceGeneration += 1;
    const worker = this.#worker;
    if (this.#pending.size === 0) {
      this.#closed = false;
      try { await this.#request({ operation: "close" }, 5_000); } catch { /* stable namespace is cleared by the next Worker after forced termination */ }
      this.#closed = true;
    }
    worker.terminate();
    this.#rejectAll(new Error("Recording source worker closed."));
  }

  #request(request: Request, timeoutMilliseconds = 120_000): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Recording source worker is unavailable."));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new Error(`Recording source worker ${request.operation} timed out.`));
      }, timeoutMilliseconds);
      this.#pending.set(id, { resolve, reject, timeout });
      try {
        this.#worker.postMessage({ id, ...request, opfsNamespace: this.#opfsNamespace });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async #replaceWorker(reason: string): Promise<void> {
    const worker = this.#worker;
    if (this.#pending.size === 0) {
      try { await this.#request({ operation: "close" }, 5_000); } catch { /* terminate and recover the same namespace below */ }
    }
    // A newer replacement may have completed while graceful close was pending.
    if (this.#worker !== worker) return;
    worker.terminate();
    this.#rejectAll(new Error(reason));
    this.#closed = false;
    this.#worker = this.#createWorker();
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.#pending.clear();
  }
}

function randomNamespace(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function perTabOpfsNamespace(): string {
  try {
    const marker = window.name.match(/(?:^|;)rvw-opfs=([a-f0-9]{32})(?:;|$)/u)?.[1];
    if (marker) return marker;
    const created = randomNamespace();
    window.name = `${window.name ? `${window.name};` : ""}rvw-opfs=${created}`;
    return created;
  } catch {
    return randomNamespace();
  }
}
