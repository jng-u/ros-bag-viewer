import { describe, expect, it, vi } from "vitest";

import {
  HostedSessionError,
  createHostedSessionDesktopShell,
  parseHostedCapability,
  renderDesktopShell,
  type HostedSourceRuntimePort,
  type OpenHostedResult,
} from "../src/index.js";

const capability = "opaque_capability_0123456789abcdef";

const opened: OpenHostedResult = {
  sourceLabel: "must-not-render-object-key",
  sourceHash: "sha256:hosted",
  durationNanos: 10_000n,
  epoch: 4,
  indexState: "indexed",
  topics: [
    {
      id: "points",
      name: "/points",
      typeName: "sensor_msgs/msg/PointCloud2",
      compatibility: "native-display",
      schemaCapability: "schema-present",
      availableDisplays: ["point-cloud", "raw"],
    },
  ],
  observability: { rangeRequests: 3, transferredBytes: 2_048, deniedRequests: 1, activeReaders: 1 },
};

function runtime(result: OpenHostedResult = opened): HostedSourceRuntimePort {
  return {
    open: vi.fn(async () => result),
    seek: vi.fn(async (currentTimeNanos) => ({ epoch: 5, currentTimeNanos })),
  };
}

describe("hosted session adapter", () => {
  it("accepts only an opaque raw capability or HTTPS fragment capability", () => {
    expect(parseHostedCapability(capability)).toBe(capability);
    expect(parseHostedCapability(`https://viewer.example/session#capability=${capability}`)).toBe(capability);
    expect(() => parseHostedCapability(`https://viewer.example/session?capability=${capability}`)).toThrow(
      HostedSessionError,
    );
    expect(() => parseHostedCapability(`http://viewer.example/session#cap=${capability}`)).toThrow(HostedSessionError);
    expect(() => parseHostedCapability("short-secret")).toThrow(HostedSessionError);
  });

  it("opens the normalized hosted source without exposing its capability or runtime label", async () => {
    const source = runtime();
    const { controller } = createHostedSessionDesktopShell(source);
    const pending = controller.openHosted({ link: `https://viewer.example/session#cap=${capability}` });
    expect(controller.state).toMatchObject({ phase: "loading", sourceMode: "hosted", sourceLabel: "Hosted recording" });
    expect(renderDesktopShell(controller)).not.toContain(capability);
    await pending;

    expect(source.open).toHaveBeenCalledWith(capability, expect.any(AbortSignal));
    expect(controller.state).toMatchObject({ phase: "ready", epoch: 4, durationNanos: 10_000n });
    expect(controller.state.topics).toEqual(opened.topics);
    const html = renderDesktopShell(controller);
    expect(html).toContain("Mode: hosted · read-only");
    expect(html).toContain("Hosted reads: 3 ranges / 2048 bytes");
    expect(html).not.toContain(capability);
    expect(html).not.toContain("must-not-render-object-key");
  });

  it.each([
    ["expired", "expired"],
    ["revoked", "revoked"],
    ["deleted", "deleted"],
    ["retention-expired", "no longer retained"],
  ] as const)("renders an accessible, redacted %s recovery state", async (code, expected) => {
    const source = runtime();
    vi.mocked(source.open).mockRejectedValueOnce(Object.assign(new Error(`raw object-key/${capability}`), { code }));
    const { controller } = createHostedSessionDesktopShell(source);
    await controller.openHosted({ link: capability });

    const html = renderDesktopShell(controller);
    expect(controller.state.phase).toBe("error");
    expect(html).toContain('role="alert"');
    expect(html).toContain(expected);
    expect(html).not.toContain("raw object-key");
    expect(html).not.toContain(capability);
  });

  it("rejects unbounded or malformed observability instead of rendering it", async () => {
    const source = runtime({ ...opened, observability: { ...opened.observability, transferredBytes: -1 } });
    const { controller } = createHostedSessionDesktopShell(source);
    await controller.openHosted({ link: capability });
    expect(controller.state).toMatchObject({ phase: "error" });
    expect(renderDesktopShell(controller)).toContain("hosted session is unavailable");
  });
});
