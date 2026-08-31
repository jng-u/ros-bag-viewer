import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  DesktopShellController,
  RecordedSourceRegistry,
  captureSemanticEvidence,
  desktopShellStyles,
  renderDesktopShell,
  type DesktopShellPorts,
  type LocalMcapSelection,
  type OpenLocalResult,
} from "../src/index.js";

const selection: LocalMcapSelection = {
  name: "generated-m1.mcap",
  sizeBytes: 4_096,
  immutableVersion: "sha256:m1",
};

const indexedSource: OpenLocalResult = {
  sourceLabel: selection.name,
  sourceHash: selection.immutableVersion,
  durationNanos: 10_000n,
  epoch: 1,
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
    {
      id: "path",
      name: "/path",
      typeName: "nav_msgs/msg/Path",
      compatibility: "native-display",
      schemaCapability: "schema-present",
      availableDisplays: ["path", "raw"],
    },
    {
      id: "opaque",
      name: "/vendor/opaque",
      typeName: "vendor_msgs/msg/Opaque",
      compatibility: "opaque-inspectable",
      schemaCapability: "opaque",
      availableDisplays: [],
    },
  ],
};

function ports(openResult: OpenLocalResult = indexedSource): DesktopShellPorts {
  return {
    openLocalMcap: vi.fn(async () => openResult),
    seek: vi.fn(async (currentTimeNanos) => ({ epoch: 2, currentTimeNanos })),
  };
}

describe("minimum desktop shell", () => {
  it("renders the five accessible regions and truthful local-only entry state", () => {
    const html = renderDesktopShell(new DesktopShellController(ports()));

    for (const region of ["Session bar", "Topic browser", "Display workspace", "Inspector", "Timeline"]) {
      expect(html).toContain(`aria-label="${region}"`);
    }
    expect(html).toContain("Choose a local MCAP, ROS1 bag, or ROS2 SQLite recording");
    expect(html).toContain("Recording bytes remain local");
    expect(html).toContain("Share</button>");
    expect(html).toContain("disabled aria-describedby=\"share-help\"");
    expect(html).toContain("Live (not available)");
    expect(html).not.toMatch(/publish|service call|action call|upload now/i);
  });

  it("opens a local source, discovers topics, filters, and adds/configures a display", async () => {
    const adapter = ports();
    const controller = new DesktopShellController(adapter);

    const pending = controller.openLocal(selection);
    expect(controller.state.phase).toBe("loading");
    expect(renderDesktopShell(controller)).toContain('aria-busy="true"');
    await pending;

    expect(adapter.openLocalMcap).toHaveBeenCalledWith(selection);
    expect(controller.state.phase).toBe("ready");
    expect(controller.state.topics).toHaveLength(3);
    controller.setTopicFilter("pointcloud2");
    expect(controller.visibleTopics.map(({ name }) => name)).toEqual(["/points"]);

    const displayId = controller.addDisplay("points", "point-cloud");
    controller.configureActiveDisplay({ fixedFrame: "odom", scale: 0.25, quality: "balanced" });
    const display = controller.state.displays.find(({ id }) => id === displayId);
    expect(display?.configuration).toMatchObject({ fixedFrame: "odom", scale: 0.25, quality: "balanced" });
    expect(controller.state.focusedRegion).toBe("workspace");
    expect(renderDesktopShell(controller)).toContain("Display configuration");
    expect(() => controller.addDisplay("opaque", "path")).toThrow(/unavailable/);
  });

  it("seeks through the adapter, advances epoch, and exposes sequential-index degradation", async () => {
    const adapter = ports({ ...indexedSource, indexState: "sequential", diagnostic: "Index absent; sequential seek enabled." });
    const controller = new DesktopShellController(adapter);
    await controller.openLocal(selection);
    controller.addDisplay("path", "path");

    const pending = controller.seek(12_000n);
    expect(controller.state.phase).toBe("loading");
    expect(controller.state.displays[0]?.status).toBe("loading");
    await pending;

    expect(adapter.seek).toHaveBeenCalledWith(10_000n);
    expect(controller.state).toMatchObject({ phase: "degraded", currentTimeNanos: 10_000n, epoch: 2 });
    expect(renderDesktopShell(controller)).toContain("Index: sequential");
  });

  it("halts affected geometry and announces exact TF failure context", async () => {
    const controller = new DesktopShellController(ports());
    await controller.openLocal(selection);
    const displayId = controller.addDisplay("points", "point-cloud");
    controller.reportTfError(displayId, {
      targetFrame: "map",
      sourceFrame: "lidar",
      queryTimeNanos: 5_000n,
      reason: "outside cache horizon",
    });

    const html = renderDesktopShell(controller);
    expect(controller.state.displays[0]?.status).toBe("tf-error");
    expect(html).toContain('role="alert"');
    expect(html).toContain("TF lidar → map at 5000 ns: outside cache horizon. Geometry halted.");
  });

  it("preserves the source choice and actionable recovery after open and seek errors", async () => {
    const openFailure = new DesktopShellController({
      openLocalMcap: async () => {
        throw new Error("invalid footer");
      },
      seek: async () => ({ epoch: 0, currentTimeNanos: 0n }),
    });
    await openFailure.openLocal(selection);
    expect(openFailure.state).toMatchObject({ phase: "error", sourceSelection: selection });
    expect(renderDesktopShell(openFailure)).toContain("Choose another local recording or retry");

    const seekFailure = new DesktopShellController({
      openLocalMcap: async () => indexedSource,
      seek: async () => {
        throw new Error("range unavailable");
      },
    });
    await seekFailure.openLocal(selection);
    await seekFailure.seek(1_000n);
    expect(seekFailure.state.sourceSelection).toEqual(selection);
    expect(seekFailure.state.blockingError).toContain("retry or replace it");
  });

  it("records deterministic keyboard, reduced-motion, viewport, DPR, zoom, and semantic evidence", async () => {
    const controller = new DesktopShellController(ports());
    await controller.openLocal(selection);

    expect([1, 1, 1, 1, 1].map(() => controller.moveRegionFocus(1))).toEqual([
      "topics",
      "workspace",
      "inspector",
      "timeline",
      "session",
    ]);
    expect(controller.moveRegionFocus(-1)).toBe("timeline");

    const evidence = captureSemanticEvidence(controller, {
      browser: "deterministic-semantic-harness",
      viewportCssPixels: [1_440, 900],
      devicePixelRatio: 1,
      zoomPercent: 200,
      reducedMotion: true,
    });
    expect(Object.values(evidence.assertions).every(Boolean)).toBe(true);
    expect(evidence.environment).toMatchObject({
      viewportCssPixels: [1_440, 900],
      devicePixelRatio: 1,
      zoomPercent: 200,
      reducedMotion: true,
    });
    expect(desktopShellStyles).toContain("min-width: 960px");
    expect(desktopShellStyles).toContain("prefers-reduced-motion: reduce");
    expect(desktopShellStyles).toContain(":focus-visible");
  });

  it("keeps generated semantic evidence truthful and complete across user-visible states", () => {
    const artifact = JSON.parse(
      readFileSync(new URL("../evidence/desktop-shell.semantic.json", import.meta.url), "utf8"),
    ) as {
      generatedBy: string;
      scenarios: Array<{
        scenario: string;
        phase: string;
        evidenceKind: string;
        hardwareMeasurement: boolean;
        assertions: Record<string, boolean>;
      }>;
    };

    expect(artifact.generatedBy).toBe("apps/web/scripts/generate-semantic-evidence.mjs");
    expect(artifact.scenarios.map(({ scenario }) => scenario)).toEqual([
      "empty",
      "loading",
      "ready",
      "degraded",
      "tf-error",
      "error",
    ]);
    for (const scenario of artifact.scenarios) {
      expect(scenario.evidenceKind).toBe("deterministic-semantic-model");
      expect(scenario.hardwareMeasurement).toBe(false);
      expect(Object.values(scenario.assertions).every(Boolean)).toBe(true);
    }
  });

  it("dispatches MCAP, ROS1 bag, and ROS2 SQLite selections through the recorded-source registry", async () => {
    const registry = new RecordedSourceRegistry();
    const opens: string[] = [];
    for (const format of ["mcap", "ros1-bag", "ros2-sqlite"] as const) {
      registry.register(format, {
        async open(value) {
          opens.push(`${format}:${value.name}`);
          return { ...indexedSource, sourceLabel: value.name, epoch: opens.length };
        },
        async seek(currentTimeNanos) {
          return { epoch: opens.length + 1, currentTimeNanos };
        },
      });
    }
    expect(registry.formats()).toEqual(["mcap", "ros1-bag", "ros2-sqlite"]);
    const controller = new DesktopShellController(registry);
    for (const format of registry.formats()) {
      await controller.openLocal({ ...selection, format, name: `fixture-${format}` });
      expect(controller.state).toMatchObject({ phase: "ready", sourceFormat: format, sourceLabel: `fixture-${format}` });
    }
    expect(opens).toEqual([
      "mcap:fixture-mcap",
      "ros1-bag:fixture-ros1-bag",
      "ros2-sqlite:fixture-ros2-sqlite",
    ]);
  });
});
