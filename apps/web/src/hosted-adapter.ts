import {
  DesktopShellController,
  type DesktopShellPorts,
  type HostedObservabilitySummary,
  type HostedSessionFailureCode,
  type HostedSessionSelection,
  type OpenHostedResult,
  type SeekResult,
} from "./shell.js";

const opaqueCapabilityPattern = /^[A-Za-z0-9_-]{24,512}$/;

export class HostedSessionError extends Error {
  constructor(readonly code: HostedSessionFailureCode) {
    super(`hosted session ${code}`);
    this.name = "HostedSessionError";
  }
}

export interface HostedSourceRuntimePort {
  open(capability: string, signal: AbortSignal): Promise<OpenHostedResult>;
  seek(timeNanos: bigint): Promise<SeekResult>;
}

function capabilityFromFragment(fragment: string): string | undefined {
  const parameters = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment);
  return parameters.get("capability") ?? parameters.get("cap") ?? undefined;
}

export function parseHostedCapability(link: string): string {
  const value = link.trim();
  let capability = value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new HostedSessionError("invalid");
    capability = capabilityFromFragment(url.hash) ?? "";
  } catch (error) {
    if (error instanceof HostedSessionError) throw error;
    if (value.includes("://")) throw new HostedSessionError("invalid");
  }
  if (!opaqueCapabilityPattern.test(capability)) throw new HostedSessionError("invalid");
  return capability;
}

function boundedCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new HostedSessionError("unavailable");
  return value;
}

function sanitizeObservability(value: HostedObservabilitySummary): HostedObservabilitySummary {
  return Object.freeze({
    rangeRequests: boundedCounter(value.rangeRequests),
    transferredBytes: boundedCounter(value.transferredBytes),
    deniedRequests: boundedCounter(value.deniedRequests),
    activeReaders: boundedCounter(value.activeReaders),
  });
}

export class HostedSessionAdapter implements DesktopShellPorts {
  #active = false;
  #openAbort?: AbortController;

  constructor(private readonly runtime: HostedSourceRuntimePort) {}

  async openHostedSession(selection: HostedSessionSelection): Promise<OpenHostedResult> {
    this.#openAbort?.abort();
    this.#active = false;
    const abort = new AbortController();
    this.#openAbort = abort;
    const capability = parseHostedCapability(selection.link);
    const result = await this.runtime.open(capability, abort.signal);
    this.#active = true;
    return { ...result, sourceLabel: "Hosted recording", observability: sanitizeObservability(result.observability) };
  }

  seek(timeNanos: bigint): Promise<SeekResult> {
    if (!this.#active) throw new Error("open a hosted source before seeking");
    return this.runtime.seek(timeNanos);
  }
}

export function createHostedSessionDesktopShell(runtime: HostedSourceRuntimePort): {
  readonly adapter: HostedSessionAdapter;
  readonly controller: DesktopShellController;
} {
  const adapter = new HostedSessionAdapter(runtime);
  return { adapter, controller: new DesktopShellController(adapter) };
}
