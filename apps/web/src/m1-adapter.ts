import { LocalMcapDesktopRuntime } from "@ros-web-viewer/m1-integration";

import { DesktopShellController } from "./shell.js";

export type LocalMcapDesktopRuntimePort = Pick<LocalMcapDesktopRuntime, "openLocalMcap" | "seek" | "readTelemetry">;

export function createLocalMcapDesktopShell(
  runtime: LocalMcapDesktopRuntimePort = new LocalMcapDesktopRuntime(),
): {
  readonly controller: DesktopShellController;
  readonly runtime: LocalMcapDesktopRuntimePort;
} {
  return { controller: new DesktopShellController(runtime), runtime };
}
