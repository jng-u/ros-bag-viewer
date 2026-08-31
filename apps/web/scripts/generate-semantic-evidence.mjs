import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { URL, fileURLToPath } from "node:url";

import { DesktopShellController, captureSemanticEvidence } from "../dist/shell.js";

const selection = {
  name: "generated-m1.mcap",
  sizeBytes: 4_096,
  immutableVersion: "sha256:m1-deterministic-fixture",
};

const topics = [
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
];

const environment = {
  browser: "deterministic-semantic-model (not a browser or hardware measurement)",
  viewportCssPixels: [1_440, 900],
  devicePixelRatio: 1,
  zoomPercent: 200,
  reducedMotion: true,
};

function controller(indexState = "indexed") {
  return new DesktopShellController({
    openLocalMcap: async () => ({
      sourceLabel: selection.name,
      sourceHash: selection.immutableVersion,
      durationNanos: 10_000n,
      epoch: 1,
      indexState,
      topics,
      diagnostic: indexState === "sequential" ? "Index absent; sequential seek enabled." : undefined,
    }),
    seek: async (currentTimeNanos) => ({ epoch: 2, currentTimeNanos }),
  });
}

const empty = controller();
const loading = new DesktopShellController({
  openLocalMcap: () => new Promise(() => undefined),
  seek: async (currentTimeNanos) => ({ epoch: 1, currentTimeNanos }),
});
void loading.openLocal(selection);

const ready = controller();
await ready.openLocal(selection);
ready.addDisplay("points", "point-cloud");
ready.configureActiveDisplay({ fixedFrame: "odom", scale: 0.25 });

const degraded = controller("sequential");
await degraded.openLocal(selection);
degraded.addDisplay("path", "path");
await degraded.seek(5_000n);

const tfError = controller();
await tfError.openLocal(selection);
const displayId = tfError.addDisplay("points", "point-cloud");
tfError.reportTfError(displayId, {
  targetFrame: "map",
  sourceFrame: "lidar",
  queryTimeNanos: 5_000n,
  reason: "outside cache horizon",
});

const genericError = new DesktopShellController({
  openLocalMcap: async () => {
    throw new Error("invalid MCAP footer");
  },
  seek: async (currentTimeNanos) => ({ epoch: 0, currentTimeNanos }),
});
await genericError.openLocal(selection);

const keyboardTraversal = [1, 1, 1, 1, 1].map(() => ready.moveRegionFocus(1));
const scenarios = [
  ["empty", "A clear local-source action remains available.", empty],
  ["loading", "Indexing and schema resolution are named while the source action remains visible.", loading],
  ["ready", "Topics are discoverable and a configured display is inspectable.", ready],
  ["degraded", "Sequential indexing remains explicit after seek.", degraded],
  ["tf-error", "Affected geometry halts with frame, query time, and reason.", tfError],
  ["error", "The selected source and safe retry or replacement action remain visible.", genericError],
].map(([scenario, expectedOutcome, value]) => ({
  scenario,
  expectedOutcome,
  evidenceKind: "deterministic-semantic-model",
  hardwareMeasurement: false,
  ...captureSemanticEvidence(value, environment),
}));

const artifact = {
  schemaVersion: 1,
  generatedBy: "apps/web/scripts/generate-semantic-evidence.mjs",
  fixture: selection,
  keyboardTraversal,
  scenarios,
};

const outputUrl = new URL("../evidence/desktop-shell.semantic.json", import.meta.url);
await mkdir(dirname(fileURLToPath(outputUrl)), { recursive: true });
await writeFile(outputUrl, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
