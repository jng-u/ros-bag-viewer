import {
  BUILTIN_RECORDED_SOURCES,
  recordedSourceRegistration,
  type RecordedSourceFormat,
} from "@ros-web-viewer/core-model";

import {
  DesktopShellController,
  type DesktopShellPorts,
  type LocalMcapSelection,
  type OpenLocalResult,
  type SeekResult,
} from "./shell.js";

export interface RecordedSourceRuntimePort {
  open(selection: LocalMcapSelection): Promise<OpenLocalResult>;
  seek(timeNanos: bigint): Promise<SeekResult>;
}

export class RecordedSourceRegistry implements DesktopShellPorts {
  readonly #runtimes = new Map<RecordedSourceFormat, RecordedSourceRuntimePort>();
  #active?: RecordedSourceRuntimePort;

  register(format: RecordedSourceFormat, runtime: RecordedSourceRuntimePort): void {
    recordedSourceRegistration(format);
    if (this.#runtimes.has(format)) throw new Error(`recorded source runtime ${format} is already registered`);
    this.#runtimes.set(format, runtime);
  }

  formats(): readonly RecordedSourceFormat[] {
    return BUILTIN_RECORDED_SOURCES.map(({ format }) => format).filter((format) => this.#runtimes.has(format));
  }

  async openLocalRecording(selection: LocalMcapSelection): Promise<OpenLocalResult> {
    const format = selection.format ?? "mcap";
    const runtime = this.#runtimes.get(format);
    if (!runtime) {
      const registration = recordedSourceRegistration(format);
      const detail = registration.capabilityDiagnostic ? `: ${registration.capabilityDiagnostic}` : "";
      throw new Error(`no ${format} recorded-source runtime is registered${detail}`);
    }
    const result = await runtime.open(selection);
    this.#active = runtime;
    return result;
  }

  openLocalMcap(selection: LocalMcapSelection): Promise<OpenLocalResult> {
    return this.openLocalRecording({ ...selection, format: "mcap" });
  }

  seek(timeNanos: bigint): Promise<SeekResult> {
    if (!this.#active) throw new Error("open a recorded source before seeking");
    return this.#active.seek(timeNanos);
  }
}

export function createRecordedSourceDesktopShell(registry: RecordedSourceRegistry): {
  readonly controller: DesktopShellController;
  readonly registry: RecordedSourceRegistry;
} {
  return { controller: new DesktopShellController(registry), registry };
}
