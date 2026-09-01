import { BrowserRecordingRuntime } from "./browser-runtime.js";
import { configureBrowserSqliteNamespace } from "./browser-sqlite.js";
import type { LocalMcapSelection } from "./shell.js";

type WorkerRequest = (
  | { readonly id: number; readonly operation: "open"; readonly selection: LocalMcapSelection }
  | { readonly id: number; readonly operation: "openHostedMcap"; readonly link: string }
  | { readonly id: number; readonly operation: "seek"; readonly timeNanos: bigint }
  | { readonly id: number; readonly operation: "messageAt"; readonly topic: string; readonly relativeTimeNanos: bigint }
  | { readonly id: number; readonly operation: "messagesAround"; readonly topic: string; readonly relativeTimeNanos: bigint }
  | { readonly id: number; readonly operation: "close" }
) & { readonly opfsNamespace: string };

type WorkerResponse = { readonly id: number; readonly ok: true; readonly value: unknown } | { readonly id: number; readonly ok: false; readonly error: string };

// This worker is the off-main execution boundary. SQLite uses worker-local OPFS
// and must not fall back to whole-database browser materialization.
const runtime = new BrowserRecordingRuntime({
  allowInlineWorkerFallback: true,
  allowSqliteMaterializedFallback: false,
  forceInlineProcessing: false,
});
let configuredNamespace: string | undefined;
let configurationPromise: Promise<void> | undefined;
let releaseNamespaceLock: (() => void) | undefined;

function lockName(namespace: string): string {
  return `ros-web-viewer.sqlite-opfs.${namespace}`;
}

async function configureNamespace(namespace: string): Promise<void> {
  let acquired!: () => void;
  const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
  const holdPromise = new Promise<void>((resolve) => { releaseNamespaceLock = resolve; });
  void navigator.locks.request(lockName(namespace), async () => {
    acquired();
    await holdPromise;
  });
  await acquiredPromise;
  const root = await navigator.storage.getDirectory();
  for await (const [name] of root.entries()) {
    const match = name.match(/^\.ros-web-viewer-sqlite-([a-f0-9]{32})$/u);
    if (!match || match[1] === namespace) continue;
    await navigator.locks.request(lockName(match[1]), { ifAvailable: true }, async (lock) => {
      if (lock) await root.removeEntry(name, { recursive: true });
    });
  }
  configureBrowserSqliteNamespace(namespace);
  configuredNamespace = namespace;
}

async function handle(request: WorkerRequest): Promise<unknown> {
  if (configuredNamespace === undefined) {
    configurationPromise ??= configureNamespace(request.opfsNamespace);
    await configurationPromise;
  } else if (configuredNamespace !== request.opfsNamespace) {
    throw new Error("Recording Worker OPFS namespace changed within one Worker lifetime.");
  }
  if (request.operation === "close") {
    try { return await runtime.close(); } finally { releaseNamespaceLock?.(); }
  }
  if (request.operation === "open") return runtime.open(request.selection);
  if (request.operation === "openHostedMcap") return runtime.openHostedMcap(request.link);
  if (request.operation === "seek") return runtime.seek(request.timeNanos);
  if (request.operation === "messageAt") return runtime.messageAt(request.topic, request.relativeTimeNanos);
  return runtime.messagesAround(request.topic, request.relativeTimeNanos);
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data).then(
    (value) => {
      self.postMessage({ id: event.data.id, ok: true, value } satisfies WorkerResponse);
      if (event.data.operation === "close") self.close();
    },
    (error: unknown) => self.postMessage({ id: event.data.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse),
  );
});
