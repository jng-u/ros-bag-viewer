import {
  CameraInfoDisplay,
  FrameTreeDisplay,
  ImageDisplay,
  LaserScanDisplay,
  MarkerDisplay,
  NumericPlotDisplay,
  OccupancyGridDisplay,
  OdometryDisplay,
  PathDisplay,
  PointCloud2Display,
  PoseDisplay,
  RawInspectorDisplay,
  type Bounds3,
  type PreparedPointCloud2,
  type SemanticSceneSummary,
} from "@ros-web-viewer/displays-core";
import type { NormalizedMessageEnvelope, SourceEpoch } from "@ros-web-viewer/core-model";
import { availableDisplaysForSchema, type DecodedSemanticMessage } from "@ros-web-viewer/m1-integration";
import { WebGl2Renderer, type GeometryResource } from "@ros-web-viewer/render-core";
import { TfBuffer } from "@ros-web-viewer/tf";

import {
  detectBrowserSourceFormat,
  localFileVersion,
  type BrowserSample,
} from "./browser-runtime.js";
import { BrowserLiveRelay } from "./browser-live.js";
import { compressedImageDimensions } from "./compressed-image.js";
import { BrowserDisplayLifecycle } from "./browser-display-lifecycle.js";
import { BrowserMessageDecoder } from "./browser-message-decoder.js";
import { normalizeBrowserSample } from "./browser-envelope.js";
import { BrowserRecordingWorker } from "./browser-recording-worker.js";
import { numericValueAtPath, type GenericRosDecodeResult } from "./generic-ros-decoder.js";
import { HistoricalFrameResolver, IDENTITY_TRANSFORM, transformBounds, type FrameTransformResolver } from "./frame-resolver.js";
import { formatRawPreview, type RawPreview } from "./raw-preview.js";
import { OrbitCamera, type CameraPreset } from "./scene-camera.js";
import { poseSourceFrame } from "./pose-source-frame.js";
import { DesktopShellController, type DisplayKind, type TopicSummary } from "./shell.js";
import { ViewerLayerRegistry, type ViewerLayer } from "./viewer-layers.js";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Application root is missing");

const icon = (name: "close" | "eye" | "fit" | "folder" | "minus" | "pause" | "play" | "plus") => {
  const paths = {
    close: '<path d="m6 6 8 8m0-8-8 8"/>',
    eye: '<path d="M2 10s3.2-5 8-5 8 5 8 5-3.2 5-8 5-8-5-8-5Z"/><circle cx="10" cy="10" r="2.2"/>',
    fit: '<path d="M7 3H3v4m10-4h4v4M7 17H3v-4m10 4h4v-4"/>',
    folder: '<path d="M2.5 5.5h5l1.5 2h8.5v8.5h-15Z"/>',
    minus: '<path d="M5 10h10"/>',
    pause: '<path d="M6.5 5v10m7-10v10"/>',
    play: '<path d="m7 5 7 5-7 5Z"/>',
    plus: '<path d="M10 5v10m-5-5h10"/>',
  } as const;
  return `<svg viewBox="0 0 20 20" aria-hidden="true">${paths[name]}</svg>`;
};

app.innerHTML = `
  <div class="viewer-shell" data-phase="empty">
    <header class="menu-bar">
      <div class="brand"><span class="brand-mark">RV</span><strong>ROS VIEWER</strong><small>DRAWABLE SCENE</small></div>
      <div class="source-chip"><i id="connection-dot"></i><span id="source-name">NO SOURCE</span><small id="mode-tag">LOCAL · READ ONLY</small></div>
      <div class="source-actions">
        <select id="demo-kind" aria-label="Demo recording format"><option value="mcap">MCAP</option><option value="ros1">ROS1 BAG</option><option value="ros2">ROS2 BAG</option></select>
        <button id="demo-button" type="button">DEMO</button>
        <button id="remote-button" type="button">URL</button>
        <button id="share-button" type="button" disabled>SHARE</button>
        <button id="live-button" type="button">LIVE</button>
        <label for="directory-input">${icon("folder")} ROS2 DIR</label>
        <label class="primary-action" for="recording-input">${icon("folder")} OPEN</label>
        <input id="recording-input" type="file" accept=".mcap,.bag,.db3,.yaml,.yml" multiple />
        <input id="directory-input" type="file" webkitdirectory multiple />
      </div>
    </header>

    <aside class="topics-panel" aria-label="Topic browser">
      <div class="panel-title"><span>TOPICS</span><output id="topic-count">0</output></div>
      <label class="filter-field"><span class="sr-only">Filter topics</span><input id="topic-filter" type="search" placeholder="filter topic / schema" autocomplete="off" /></label>
      <div class="topic-list" id="topic-list"><p class="empty-copy">Open or drop a ROS recording.</p></div>
      <div class="source-foot"><span id="source-format">—</span><span id="source-index">NO INDEX</span></div>
    </aside>

    <main class="scene-panel" aria-label="3D drawable scene">
      <canvas id="scene-canvas" aria-label="Interactive ROS 3D scene"></canvas>
      <div class="camera-tools" role="toolbar" aria-label="Camera controls">
        <button data-camera="fit" type="button" title="Frame visible drawables">${icon("fit")} FIT</button>
        <button data-camera="orbit" type="button">ORBIT</button>
        <button data-camera="top" type="button">TOP</button>
        <button data-camera="front" type="button">FRONT</button>
        <label class="fixed-frame-control">FIXED <input id="fixed-frame-input" value="map" aria-label="TF fixed frame" spellcheck="false" /></label>
      </div>
      <div class="scene-stats" id="scene-stats"><span>WEBGL2</span><span>0 VERTICES</span><span>FULL DATA</span></div>
      <div class="drop-prompt" id="drop-prompt">
        <strong>DROP ROS RECORDING</strong>
        <span>MCAP · ROS1 BAG · ROS2 BAG DIRECTORY</span>
        <button id="drop-open-button" type="button">SELECT RECORDING</button>
      </div>
      <div class="aux-dock" id="aux-dock" aria-label="Image and raw data views"></div>
      <div class="scene-message" id="scene-message" role="status" aria-live="polite"></div>
    </main>

    <aside class="layers-panel" aria-label="Scene drawables">
      <div class="panel-title"><span>DRAWABLES</span><output id="layer-count">0</output></div>
      <div class="layer-list" id="layer-list"><p class="empty-copy">Add displays from Topics. Multiple drawables share one synchronized scene.</p></div>
      <section class="inspector" id="inspector"><div class="section-label">SELECTION</div><p class="empty-copy">No drawable selected.</p></section>
      <div class="mouse-guide"><span><b>LMB</b> orbit</span><span><b>SHIFT + LMB</b> pan</span><span><b>WHEEL</b> zoom</span></div>
    </aside>

    <footer class="timeline-panel" aria-label="Timeline">
      <button class="icon-button" id="play-button" type="button" aria-label="Play recording">${icon("play")}</button>
      <button class="icon-button" id="step-back" type="button" aria-label="Step backward">${icon("minus")}</button>
      <output id="current-time">00:00.000</output>
      <input id="timeline-input" type="range" min="0" max="10000" value="0" aria-label="Seek recording" />
      <output id="duration-time">00:00.000</output>
      <button class="icon-button" id="step-forward" type="button" aria-label="Step forward">${icon("plus")}</button>
      <label class="rate-control">RATE <select id="playback-rate"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select></label>
      <span class="epoch-readout">EPOCH <b id="epoch-value">0</b></span>
    </footer>
    <div class="status-line" id="status-line" role="status" aria-live="polite">Ready. Recording data stays in this browser.</div>
    <dialog id="source-dialog" aria-labelledby="source-dialog-title">
      <form id="remote-form" data-source-form="remote">
        <header><div><small>REMOTE SOURCE</small><h2 id="source-dialog-title">Open indexed MCAP URL</h2></div><button id="source-dialog-close" type="button" aria-label="Close">${icon("close")}</button></header>
        <p>The server must expose immutable HTTP byte ranges through CORS. An optional <code>#capability=…</code> fragment is sent only as a bearer header and is never displayed after opening.</p>
        <label>HTTPS MCAP URL<input id="remote-url" type="url" required placeholder="https://host/session.mcap#capability=…" autocomplete="off" /></label>
        <footer><button type="button" id="remote-cancel">CANCEL</button><button class="dialog-primary" type="submit">OPEN RANGE SOURCE</button></footer>
      </form>
      <form id="live-form" data-source-form="live">
        <header><div><small>ONLINE SOURCE</small><h2 id="live-dialog-title">Connect subscribe-only relay</h2></div><button id="live-dialog-close" type="button" aria-label="Close">${icon("close")}</button></header>
        <p>The relay is limited to authenticated topic discovery and subscriptions. The viewer has no ROS publish, service, action, parameter, or command operation.</p>
        <label>WSS RELAY ENDPOINT<input id="live-endpoint" type="url" required placeholder="wss://relay.example/viewer" autocomplete="off" /></label>
        <label>SESSION TOKEN<input id="live-token" type="password" required autocomplete="off" /></label>
        <footer><button type="button" id="live-cancel">CANCEL</button><button class="dialog-primary" type="submit">CONNECT READ ONLY</button></footer>
      </form>
    </dialog>
    <dialog id="share-dialog" aria-labelledby="share-dialog-title">
      <form id="share-form">
        <header><div><small>HOSTED REVIEW</small><h2 id="share-dialog-title">Create expiring MCAP link</h2></div><button id="share-dialog-close" type="button" aria-label="Close">${icon("close")}</button></header>
        <p id="share-summary">Open a local MCAP recording first. Uploads are immutable, capability-scoped, and automatically expire.</p>
        <label>LINK LIFETIME<select id="share-ttl"><option value="900">15 MINUTES</option><option value="3600" selected>1 HOUR</option><option value="86400">24 HOURS</option></select></label>
        <label>CREATE TOKEN (REMOTE DEPLOYMENTS)<input id="share-create-token" type="password" autocomplete="off" /></label>
        <label id="share-result-wrap" hidden>CAPABILITY LINK<input id="share-result" type="url" readonly autocomplete="off" /></label>
        <footer><button type="button" id="share-copy" hidden>COPY LINK</button><button type="button" id="share-revoke" hidden>REVOKE</button><button type="button" id="share-cancel">CANCEL</button><button class="dialog-primary" id="share-create" type="submit">CREATE LINK</button></footer>
      </form>
    </dialog>
  </div>
`;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
};

const runtime = new BrowserRecordingWorker();
window.addEventListener("pagehide", () => { void runtime.close(); }, { once: true });
const messageDecoder = new BrowserMessageDecoder();
const liveTfDecoder = new BrowserMessageDecoder();
const liveSamples = new Map<string, BrowserSample>();
let liveTfBuffer: TfBuffer | undefined;
let liveTfEpoch = -1;
let liveTfTransformCount = 0;
const liveRenderSequences = new Map<string, number>();
let shareableMcap: File | undefined;
let lastCreatedShare: { readonly recordingUrl: string; readonly revokeUrl: string; readonly revokeToken: string; readonly expiresAtMs: number } | undefined;
let livePollScheduled = false;
function scheduleLivePoll(): void {
  if (livePollScheduled) return;
  livePollScheduled = true;
  window.setTimeout(() => {
    livePollScheduled = false;
    if (controller.state.sourceMode !== "live") return;
    controller.pollLive();
    renderChrome();
  }, 0);
}
const liveRelay = new BrowserLiveRelay(async (topicId, sample) => {
  liveSamples.set(topicId, sample);
  const sequence = (liveRenderSequences.get(topicId) ?? 0) + 1;
  liveRenderSequences.set(topicId, sequence);
  if (availableDisplaysForSchema(sample.channel.schema.name, "schema-present").includes("frame-tree")) {
    try { await ingestLiveTf(topicId, sample); } catch (error) {
      liveRelay.recordDisplayResult(0, 1);
      liveRelay.recordDiagnostic(`Live TF decode failed for ${sample.channel.schema.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await renderSceneAtCurrentTime();
  if (liveRenderSequences.get(topicId) !== sequence) {
    liveRelay.recordDisplayResult(0, 0, 1);
    scheduleLivePoll();
    return;
  }
  const topicLayers = layers.visibleLayers.filter((layer) => layer.topic.id === topicId);
  liveRelay.recordDisplayResult(
    topicLayers.filter((layer) => layer.status === "ready").length,
    topicLayers.filter((layer) => layer.status === "error").length,
  );
  scheduleLivePoll();
}, scheduleLivePoll);
const controller = new DesktopShellController({
  openLocalRecording: (selection) => runtime.open(selection),
  openHostedSession: (selection) => runtime.openHostedMcap(selection.link),
  seek: (timeNanos) => runtime.seek(timeNanos),
  connectLive: (selection) => liveRelay.connectLive(selection),
  subscribeLive: (topicIds) => liveRelay.subscribeLive(topicIds),
  pollLive: () => liveRelay.pollLive(),
  disconnectLive: () => liveRelay.disconnectLive(),
});
const layers = new ViewerLayerRegistry();
const camera = new OrbitCamera();
let fixedFrame = "map";
let liveSubscriptionUpdate: Promise<void> = Promise.resolve();
// Recorded acquisition is already bounded by message count and log-time range. Do not
// prune that bounded set by header time: bags may use a different header/log clock.
const RECORDED_TF_MAX_HEADER_HISTORY_NANOS = (1n << 63n) - 1n;

function resetLiveTfState(): void {
  liveTfDecoder.reset("Live TF source epoch replaced.");
  liveTfBuffer = undefined;
  liveTfEpoch = -1;
  liveTfTransformCount = 0;
}

function desiredLiveTopicIds(): string[] {
  const visible = layers.visibleLayers;
  const desired = new Set(visible.map((layer) => layer.topic.id));
  const needsTransforms = visible.some((layer) => layer.kind !== "raw" && layer.kind !== "numeric-plot" && layer.kind !== "image");
  if (needsTransforms) {
    for (const topic of controller.state.topics) {
      if (topic.availableDisplays.includes("frame-tree")) desired.add(topic.id);
    }
  }
  return [...desired];
}

function syncLiveSubscriptions(): Promise<void> {
  liveSubscriptionUpdate = liveSubscriptionUpdate.then(async () => {
      if (controller.state.sourceMode !== "live" || (controller.state.phase !== "ready" && controller.state.phase !== "degraded")) return;
      const desired = desiredLiveTopicIds();
      await controller.subscribeLive(desired);
      const retained = new Set(desired);
      for (const topicId of liveSamples.keys()) if (!retained.has(topicId)) liveSamples.delete(topicId);
      for (const topicId of liveRenderSequences.keys()) if (!retained.has(topicId)) liveRenderSequences.delete(topicId);
    }).catch((error) => {
      liveRelay.recordDisplayResult(0, 1);
      liveRelay.recordDiagnostic(`Live subscription update failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  return liveSubscriptionUpdate;
}

async function ingestLiveTf(topicId: string, sample: BrowserSample): Promise<void> {
  if (controller.state.sourceMode !== "live") return;
  const epoch = controller.state.epoch;
  if (!liveTfBuffer || liveTfEpoch !== epoch) {
    liveTfBuffer = new TfBuffer(epoch, 512, 30_000_000_000n, 30_000_000_000n);
    liveTfEpoch = epoch;
    liveTfTransformCount = 0;
  }
  const decoded = await liveTfDecoder.semantic(sample);
  if (controller.state.sourceMode !== "live" || controller.state.epoch !== epoch || decoded.kind !== "frame-tree") return;
  const topic = controller.state.topics.find(({ id }) => id === topicId);
  for (const transform of decoded.message.transforms) {
    liveTfBuffer.add({
      parentFrame: transform.parentFrameId.replace(/^\/+|\/+$/gu, ""),
      childFrame: transform.childFrameId.replace(/^\/+|\/+$/gu, ""),
      timeNanos: transform.stampNanos,
      isStatic: /(?:^|\/)tf_static$/u.test(topic?.name ?? ""),
      epoch,
      translation: transform.translation,
      rotation: transform.rotation,
    });
    liveTfTransformCount += 1;
  }
}

const shell = document.querySelector<HTMLElement>(".viewer-shell")!;
const canvas = byId<HTMLCanvasElement>("scene-canvas");
const scenePanel = document.querySelector<HTMLElement>(".scene-panel")!;
const topicList = byId<HTMLElement>("topic-list");
const layerList = byId<HTMLElement>("layer-list");
const inspector = byId<HTMLElement>("inspector");
const auxDock = byId<HTMLElement>("aux-dock");
const timeline = byId<HTMLInputElement>("timeline-input");
const playButton = byId<HTMLButtonElement>("play-button");
const statusLine = byId<HTMLElement>("status-line");
const sceneMessage = byId<HTMLElement>("scene-message");
const input = byId<HTMLInputElement>("recording-input");
const directoryInput = byId<HTMLInputElement>("directory-input");

type GeometryDisplay =
  | FrameTreeDisplay
  | LaserScanDisplay
  | MarkerDisplay
  | OccupancyGridDisplay
  | OdometryDisplay
  | PathDisplay
  | PointCloud2Display
  | PoseDisplay;
type LayerDisplay = GeometryDisplay | CameraInfoDisplay | ImageDisplay | NumericPlotDisplay | RawInspectorDisplay;
interface RasterFrame { readonly source: CanvasImageSource; readonly width: number; readonly height: number; readonly close?: () => void }
interface LayerRuntime {
  display?: LayerDisplay;
  lifecycle?: BrowserDisplayLifecycle<LayerUpdateContext>;
  attachedEpoch?: number;
  raster?: RasterFrame;
  raw?: RawPreview;
  rawStructured?: string;
  generic?: GenericRosDecodeResult;
  numericHistory?: { readonly timeNanos: bigint; readonly value: number }[];
  payloadBytes?: number;
  schemaName?: string;
  modelMatrix?: Float32Array;
  tfQueryTimeNanos?: bigint;
}

interface LayerUpdateContext {
  readonly channel: BrowserSample["channel"];
  readonly generation: number;
  readonly frameResolver?: FrameTransformResolver;
  readonly decoded?: DecodedSemanticMessage;
  readonly generic?: GenericRosDecodeResult;
  readonly frameTreeMessage?: Extract<DecodedSemanticMessage, { readonly kind: "frame-tree" }>["message"];
  readonly preparedPointCloud?: PreparedPointCloud2;
  readonly rawImageRgba?: Uint8ClampedArray;
}

const layerRuntime = new Map<string, LayerRuntime>();
const palette: readonly (readonly [number, number, number, number])[] = [
  [0.25, 0.82, 1, 1], [1, 0.69, 0.24, 1], [0.56, 0.9, 0.38, 1], [0.93, 0.38, 0.74, 1], [0.68, 0.54, 1, 1],
];
let renderer: WebGl2Renderer | undefined;
let gl: WebGL2RenderingContext | undefined;
let gridResources: GeometryResource[] = [];
let rendering = false;
let renderQueued = false;
let renderGeneration = 0;
let renderCompletion: Promise<void> = Promise.resolve();
let fitQueued = false;
let playing = false;
let animationFrame = 0;
let lastFrameMilliseconds = 0;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function formatNanos(value: bigint): string {
  const milliseconds = value / 1_000_000n;
  const minutes = milliseconds / 60_000n;
  const seconds = (milliseconds / 1_000n) % 60n;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${(milliseconds % 1_000n).toString().padStart(3, "0")}`;
}

function formatSourceTime(value: bigint): string {
  if (controller.state.sourceMode !== "live") return formatNanos(value);
  const milliseconds = Number(value / 1_000_000n);
  if (!Number.isFinite(milliseconds) || milliseconds > 8_640_000_000_000_000) return formatNanos(value);
  const iso = new Date(milliseconds).toISOString();
  return `${iso.slice(11, 23)} UTC`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function structuredPreview(value: unknown): string {
  const text = JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current === "bigint") return `${current} ns`;
    if (ArrayBuffer.isView(current)) {
      const values = Array.from(current as unknown as ArrayLike<number>);
      return values.length <= 64 ? values : [...values.slice(0, 64), `… ${values.length - 64} values omitted`];
    }
    if (Array.isArray(current) && current.length > 64) return [...current.slice(0, 64), `… ${current.length - 64} values omitted`];
    return current;
  }, 2) ?? "null";
  return text.length <= 32_768 ? text : `${text.slice(0, 32_768)}\n… structured preview truncated`;
}

function displayLabel(kind: DisplayKind): string {
  return kind.replaceAll("-", " ").toLocaleUpperCase();
}

function resizeScene(): void {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(canvas.clientWidth * scale));
  const height = Math.max(1, Math.floor(canvas.clientHeight * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  if (gl) gl.viewport(0, 0, width, height);
}

function createGridPositions(extent = 20, divisions = 40): Float32Array {
  const values: number[] = [];
  for (let index = 0; index <= divisions; index += 1) {
    const value = -extent + (index / divisions) * extent * 2;
    values.push(-extent, value, 0, extent, value, 0, value, -extent, 0, value, extent, 0);
  }
  return new Float32Array(values);
}

function ensureRenderer(): WebGl2Renderer {
  if (renderer) return renderer;
  resizeScene();
  gl = canvas.getContext("webgl2", { alpha: false, antialias: true }) ?? undefined;
  if (!gl) throw new Error("WebGL2 is unavailable in this browser or GPU configuration.");
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.clearColor(0.025, 0.025, 0.03, 1);
  renderer = new WebGl2Renderer(canvas, {
    maxGpuBytes: 128 * 1024 * 1024,
    maxBufferBytes: 64 * 1024 * 1024,
    maxVerticesPerGeometry: 1_000_000,
    maxPooledBuffers: 8,
  });
  gridResources = [
    renderer.upsert({ id: "scene-grid", topology: "lines", positions: createGridPositions(), color: [0.2, 0.21, 0.24, 1] }),
    renderer.upsert({ id: "axis-x", topology: "lines", positions: new Float32Array([0, 0, 0.015, 4, 0, 0.015]), color: [0.92, 0.27, 0.27, 1] }),
    renderer.upsert({ id: "axis-y", topology: "lines", positions: new Float32Array([0, 0, 0.02, 0, 4, 0.02]), color: [0.3, 0.82, 0.37, 1] }),
    renderer.upsert({ id: "axis-z", topology: "lines", positions: new Float32Array([0, 0, 0, 0, 0, 4]), color: [0.31, 0.52, 1, 1] }),
  ];
  return renderer;
}

function combinedBounds(): Bounds3 | undefined {
  const bounds = layers.visibleLayers.flatMap(({ id, summary }) => summary?.bounds
    ? [transformBounds(summary.bounds, layerRuntime.get(id)?.modelMatrix ?? IDENTITY_TRANSFORM)]
    : []);
  if (bounds.length === 0) return undefined;
  return {
    min: [Math.min(...bounds.map(({ min }) => min[0])), Math.min(...bounds.map(({ min }) => min[1])), Math.min(...bounds.map(({ min }) => min[2]))],
    max: [Math.max(...bounds.map(({ max }) => max[0])), Math.max(...bounds.map(({ max }) => max[1])), Math.max(...bounds.map(({ max }) => max[2]))],
  };
}

function drawScene(): void {
  const activeRenderer = ensureRenderer();
  resizeScene();
  if (!gl) return;
  activeRenderer.setViewProjection(camera.viewProjection(canvas.width / canvas.height));
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  for (const resource of gridResources) resource.draw();
  for (const layer of layers.visibleLayers) {
    const runtimeState = layerRuntime.get(layer.id);
    if (layer.status === "ready" && isGeometryDisplay(runtimeState?.display)) runtimeState.lifecycle?.render();
  }
  renderSceneStats();
}

function isGeometryDisplay(display: LayerDisplay | undefined): display is GeometryDisplay {
  return display instanceof FrameTreeDisplay
    || display instanceof LaserScanDisplay
    || display instanceof MarkerDisplay
    || display instanceof OccupancyGridDisplay
    || display instanceof OdometryDisplay
    || display instanceof PathDisplay
    || display instanceof PointCloud2Display
    || display instanceof PoseDisplay;
}

function renderSceneStats(): void {
  const summaries = layers.visibleLayers.flatMap(({ summary }) => summary && (summary.primitive === "points" || summary.primitive === "lines" || summary.primitive === "line-strip") ? [summary] : []);
  const rendered = summaries.reduce((total, summary) => total + summary.renderedVertices, 0);
  const dropped = summaries.reduce((total, summary) => total + summary.droppedVertices, 0);
  const gpu = renderer?.telemetry().liveGpuBytes ?? 0;
  byId("scene-stats").innerHTML = `<span>WEBGL2</span><span>${rendered.toLocaleString()} VERTICES</span><span class="${dropped ? "quality-loss" : "quality-full"}">${dropped ? `${dropped.toLocaleString()} DROPPED` : "FULL DATA"}</span><span>${formatBytes(gpu)} GPU</span>`;
}

function clearLayerRuntimes(): void {
  renderGeneration += 1;
  renderQueued = false;
  for (const runtimeState of layerRuntime.values()) {
    runtimeState.lifecycle?.dispose();
    runtimeState.raster?.close?.();
  }
  layerRuntime.clear();
  layers.clear();
}

function rebuildLayerRuntimes(): void {
  renderGeneration += 1;
  renderQueued = false;
  for (const runtimeState of layerRuntime.values()) {
    runtimeState.lifecycle?.dispose();
    runtimeState.raster?.close?.();
  }
  layerRuntime.clear();
  for (const layer of layers.layers) ensureLayerDisplay(layer);
}

function ensureLayerDisplay(layer: ViewerLayer, epoch = controller.state.epoch): LayerRuntime {
  const existing = layerRuntime.get(layer.id) ?? {};
  const activeRenderer = ensureRenderer();
  if (!existing.display) {
    const color = layer.color ?? palette[layer.colorIndex % palette.length]!;
    if (layer.kind === "point-cloud" || layer.kind === "pointcloud2") {
      const display = new PointCloud2Display(layer.id, activeRenderer);
      display.configure({ maxPoints: 1_000_000, maxInputBytes: 16 * 1024 * 1024, color });
      existing.display = display;
    } else if (layer.kind === "path") {
      const display = new PathDisplay(layer.id, activeRenderer);
      display.configure({ maxPoses: 100_000, maxInputBytes: 16 * 1024 * 1024, color });
      existing.display = display;
    } else if (layer.kind === "image") {
      const display = new ImageDisplay(layer.id);
      display.configure({ maxInputBytes: 32 * 1024 * 1024, maxPixels: 16_000_000 });
      existing.display = display;
    } else if (layer.kind === "laser-scan") {
      const display = new LaserScanDisplay(layer.id, activeRenderer);
      display.configure({ maxRanges: 1_000_000, maxInputBytes: 16 * 1024 * 1024, color });
      existing.display = display;
    } else if (layer.kind === "pose") {
      const display = new PoseDisplay(layer.id, activeRenderer);
      display.configure({ axisLength: 1, maxInputBytes: 4096, color });
      existing.display = display;
    } else if (layer.kind === "odometry") {
      const display = new OdometryDisplay(layer.id, activeRenderer);
      display.configure({ axisLength: 1, maxInputBytes: 4096, color });
      existing.display = display;
    } else if (layer.kind === "occupancy-grid") {
      const display = new OccupancyGridDisplay(layer.id, activeRenderer);
      display.configure({ occupiedThreshold: 50, maxCells: 500_000, maxInputBytes: 32 * 1024 * 1024, color });
      existing.display = display;
    } else if (layer.kind === "frame-tree") {
      const display = new FrameTreeDisplay(layer.id, activeRenderer);
      display.configure({ fixedFrame, maxTransforms: 100_000, maxInputBytes: 16 * 1024 * 1024, color });
      existing.display = display;
    } else if (layer.kind === "marker") {
      const display = new MarkerDisplay(layer.id, activeRenderer);
      display.configure({ maxMarkers: 10_000, maxPoints: 100_000, maxInputBytes: 16 * 1024 * 1024, color });
      existing.display = display;
    } else if (layer.kind === "camera-info") {
      const display = new CameraInfoDisplay(layer.id);
      display.configure({ maxInputBytes: 256 * 1024 });
      existing.display = display;
    } else if (layer.kind === "numeric-plot") {
      const display = new NumericPlotDisplay(layer.id);
      display.configure({ fieldPath: layer.fieldPath ? "selected" : "data", maxSamples: 2048, maxInputBytes: 64 * 1024 });
      existing.display = display;
    } else if (layer.kind === "raw" || layer.kind === "raw-inspector") {
      const display = new RawInspectorDisplay(layer.id);
      display.configure({ maxInputBytes: 32 * 1024 * 1024, maxDepth: 32, maxFields: 10_000, maxArrayLength: 4_096, maxStringBytes: 64 * 1024, maxPreviewBytes: 4_096 });
      existing.display = display;
    }
    layerRuntime.set(layer.id, existing);
  }
  if (existing.display && !existing.lifecycle) {
    const display = existing.display;
    existing.lifecycle = new BrowserDisplayLifecycle<LayerUpdateContext>(
      (envelope, context) => updateNormalizedLayer(layer, envelope, context),
      (sourceEpoch) => display.attachSource(sourceEpoch),
      () => display.render(),
      () => display.dispose(),
    );
    existing.lifecycle.register();
    existing.lifecycle.instantiate();
    existing.lifecycle.configure();
  }
  if (existing.lifecycle && existing.attachedEpoch !== epoch) {
    existing.lifecycle.attachSource(epoch as SourceEpoch);
    existing.attachedEpoch = epoch;
  }
  return existing;
}

function compressedImageMime(format: string): string {
  const codec = format.toLocaleLowerCase().match(/(?:^|[;\s])(jpe?g|png|webp)(?:\s|$)/u)?.[1];
  if (codec === "jpg" || codec === "jpeg") return "image/jpeg";
  if (codec === "png") return "image/png";
  if (codec === "webp") return "image/webp";
  throw new Error(`Unsupported compressed image codec: ${format}`);
}

async function rasterFrame(
  decoded: Extract<DecodedSemanticMessage, { kind: "image" | "compressed-image" }>,
  preparedRgba?: Uint8ClampedArray,
): Promise<RasterFrame> {
  if (decoded.kind === "image") {
    const source = document.createElement("canvas");
    source.width = decoded.message.width;
    source.height = decoded.message.height;
    const context = source.getContext("2d");
    if (!context) throw new Error("Canvas2D is unavailable for raw image conversion.");
    const rgba = preparedRgba;
    if (!rgba) throw new Error("Raw image Worker did not return a prepared RGBA frame.");
    const imageData = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength);
    context.putImageData(new ImageData(imageData, source.width, source.height), 0, 0);
    return { source, width: source.width, height: source.height };
  }
  const mime = compressedImageMime(decoded.message.format);
  const header = compressedImageDimensions(decoded.message.data, mime);
  const pixels = header.width * header.height;
  if (!Number.isSafeInteger(pixels) || pixels > 16_000_000) {
    throw new Error("Compressed image pixel budget exceeded");
  }
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(decoded.message.data)], { type: mime }));
  if (bitmap.width !== header.width || bitmap.height !== header.height) {
    bitmap.close();
    throw new Error("Compressed image decoder dimensions disagree with the bounded header preflight");
  }
  return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
}

async function updateLayer(
  layer: ViewerLayer,
  sample: BrowserSample,
  epoch: number,
  generation: number,
  frameResolver?: FrameTransformResolver,
  frameTreeMessage?: Extract<DecodedSemanticMessage, { readonly kind: "frame-tree" }>["message"],
): Promise<void> {
  const runtimeState = ensureLayerDisplay(layer, epoch);
  const baseEnvelope = normalizeBrowserSample(sample, layer.topic, epoch, controller.state.sourceHash ?? controller.state.sourceLabel ?? "browser-source");
  try {
    let decoded: DecodedSemanticMessage | undefined;
    let generic: GenericRosDecodeResult | undefined;
    let preparedPointCloud: PreparedPointCloud2 | undefined;
    let rawImageRgba: Uint8ClampedArray | undefined;
    if (layer.kind !== "raw" && layer.kind !== "raw-inspector") {
      const data = baseEnvelope.payload.readBytes(baseEnvelope.epoch);
      const decoderInput: BrowserSample = { channel: sample.channel, data, logTimeNanos: baseEnvelope.schedulingTime.valueNanos, sourceSequence: baseEnvelope.sourceSequence };
      try {
        const prepared = await messageDecoder.semanticPrepared(decoderInput, {
          maxPoints: 1_000_000,
          maxInputBytes: 16 * 1024 * 1024,
          color: layer.color ?? palette[layer.colorIndex % palette.length]!,
        });
        decoded = prepared.decoded;
        preparedPointCloud = prepared.pointCloud;
        rawImageRgba = prepared.rawImageRgba;
      } catch (semanticError) {
        if (layer.kind !== "numeric-plot" || !layer.fieldPath) throw semanticError;
        generic = await messageDecoder.generic({
          typeName: sample.channel.schema.name,
          messageEncoding: sample.channel.messageEncoding,
          schemaEncoding: sample.channel.schema.encoding,
          schemaDefinition: sample.channel.schema.definition,
          schemaData: sample.channel.schema.data,
          data,
        });
      }
    }
    const tfQueryTimeNanos = decoded && "stampNanos" in decoded.message ? decoded.message.stampNanos : undefined;
    const envelope: NormalizedMessageEnvelope = tfQueryTimeNanos === undefined ? baseEnvelope : {
      ...baseEnvelope,
      tfQueryTime: { valueNanos: tfQueryTimeNanos, source: "header", epoch: baseEnvelope.epoch },
    };
    if (!runtimeState.lifecycle) throw new Error(`${displayLabel(layer.kind)} display lifecycle is unavailable`);
    runtimeState.lifecycle.prepare({ channel: sample.channel, generation, frameResolver, decoded, generic, frameTreeMessage, preparedPointCloud, rawImageRgba });
    await runtimeState.lifecycle.update(envelope);
  } finally {
    baseEnvelope.payload.release();
  }
}

async function updateNormalizedLayer(
  layer: ViewerLayer,
  envelope: NormalizedMessageEnvelope,
  context: LayerUpdateContext,
): Promise<void> {
  const { channel, generation, frameResolver } = context;
  const epoch = envelope.epoch;
  const data = envelope.payload.readBytes(epoch);
  // Workers receive a structured-clone DTO; the normalized envelope remains the UI/display ownership boundary.
  const decoderInput: BrowserSample = { channel, data, logTimeNanos: envelope.schedulingTime.valueNanos, sourceSequence: envelope.sourceSequence };
  const assertCurrent = (): void => {
    if (generation !== renderGeneration || epoch !== controller.state.epoch || !layers.layers.some(({ id }) => id === layer.id)) {
      throw new Error("stale render generation");
    }
  };
  assertCurrent();
  const runtimeState = layerRuntime.get(layer.id);
  if (!runtimeState?.display) throw new Error(`${displayLabel(layer.kind)} display is unavailable`);
  runtimeState.payloadBytes = data.byteLength;
  runtimeState.schemaName = channel.schema.name;
  if (layer.kind === "raw" || layer.kind === "raw-inspector") {
    runtimeState.raw = formatRawPreview(data);
    runtimeState.generic = undefined;
    let rawValue: unknown;
    try {
      const decoded = await messageDecoder.semantic(decoderInput);
      rawValue = decoded.message;
      runtimeState.rawStructured = structuredPreview(decoded.message);
    } catch (semanticError) {
      try {
        const generic = await messageDecoder.generic({
          typeName: channel.schema.name,
          messageEncoding: channel.messageEncoding,
          schemaEncoding: channel.schema.encoding,
          schemaDefinition: channel.schema.definition,
          schemaData: channel.schema.data,
          data,
        });
        runtimeState.generic = generic;
        rawValue = generic.value;
        runtimeState.rawStructured = structuredPreview(generic.value);
      } catch (genericError) {
        runtimeState.rawStructured = channel.schema.capability === "opaque"
          ? undefined
          : `SCHEMA DECODE ERROR\n${genericError instanceof Error ? genericError.message : String(genericError)}\n\nNATIVE DECODER\n${semanticError instanceof Error ? semanticError.message : String(semanticError)}`;
      }
    }
    assertCurrent();
    if (!(runtimeState.display instanceof RawInspectorDisplay)) throw new Error("RAW inspector display is unavailable");
    const summary = runtimeState.display.update({
      typeName: channel.schema.name,
      schemaCapability: rawValue === undefined ? "opaque" : channel.schema.capability,
      ...(rawValue === undefined ? { bytes: data } : { value: rawValue }),
    }, epoch);
    runtimeState.lifecycle?.render();
    layers.update(layer.id, { messageTimeNanos: envelope.schedulingTime.valueNanos, status: "ready", summary, error: undefined });
    return;
  }
  const { decoded, generic } = context;
  assertCurrent();
  runtimeState.tfQueryTimeNanos = envelope.tfQueryTime?.valueNanos ?? envelope.schedulingTime.valueNanos;
  let summary: SemanticSceneSummary;
  if (generic && runtimeState.display instanceof NumericPlotDisplay && layer.fieldPath) {
    const value = numericValueAtPath(generic.value, layer.fieldPath);
    summary = runtimeState.display.update({ timestampNanos: envelope.schedulingTime.valueNanos, value: { selected: value } }, epoch);
    if (value !== undefined) {
      const history = runtimeState.numericHistory ?? [];
      if (history.at(-1)?.timeNanos !== envelope.schedulingTime.valueNanos) history.push({ timeNanos: envelope.schedulingTime.valueNanos, value });
      if (history.length > 2048) history.splice(0, history.length - 2048);
      runtimeState.numericHistory = history;
    }
    runtimeState.lifecycle?.render();
  } else if (decoded?.kind === "pointcloud2" && runtimeState.display instanceof PointCloud2Display && context.preparedPointCloud) {
    summary = runtimeState.display.updatePrepared(context.preparedPointCloud, epoch);
  } else if (decoded?.kind === "path" && runtimeState.display instanceof PathDisplay) {
    summary = runtimeState.display.update(decoded.message, epoch);
  } else if (decoded?.kind === "laser-scan" && runtimeState.display instanceof LaserScanDisplay) {
    summary = runtimeState.display.update(decoded.message, epoch);
  } else if (decoded?.kind === "pose" && runtimeState.display instanceof PoseDisplay) {
    // geometry_msgs/Pose has no Header. Interpret it in the selected fixed frame
    // rather than exposing a native display that can only fail on an empty frame.
    summary = runtimeState.display.update({
      ...decoded.message,
      frameId: poseSourceFrame(decoded.message.frameId, fixedFrame),
    }, epoch);
  } else if (decoded?.kind === "odometry" && runtimeState.display instanceof OdometryDisplay) {
    summary = runtimeState.display.update(decoded.message, epoch);
  } else if (decoded?.kind === "odometry" && runtimeState.display instanceof PoseDisplay) {
    summary = runtimeState.display.update({ frameId: decoded.message.frameId, ...decoded.message.pose }, epoch);
  } else if (decoded?.kind === "occupancy-grid" && runtimeState.display instanceof OccupancyGridDisplay) {
    summary = runtimeState.display.update(decoded.message, epoch);
  } else if (decoded?.kind === "frame-tree" && runtimeState.display instanceof FrameTreeDisplay) {
    summary = runtimeState.display.update(context.frameTreeMessage ?? decoded.message, epoch);
  } else if (decoded?.kind === "marker" && runtimeState.display instanceof MarkerDisplay) {
    summary = runtimeState.display.update(decoded.message, epoch);
  } else if (decoded?.kind === "camera-info" && runtimeState.display instanceof CameraInfoDisplay) {
    summary = runtimeState.display.update(decoded.message, epoch);
    runtimeState.lifecycle?.render();
  } else if (decoded?.kind === "numeric" && runtimeState.display instanceof NumericPlotDisplay) {
    summary = runtimeState.display.update({ timestampNanos: envelope.schedulingTime.valueNanos, value: { data: decoded.message.value } }, epoch);
    const history = runtimeState.numericHistory ?? [];
    if (history.at(-1)?.timeNanos !== envelope.schedulingTime.valueNanos) history.push({ timeNanos: envelope.schedulingTime.valueNanos, value: decoded.message.value });
    if (history.length > 2048) history.splice(0, history.length - 2048);
    runtimeState.numericHistory = history;
    runtimeState.lifecycle?.render();
  } else if ((decoded?.kind === "image" || decoded?.kind === "compressed-image") && runtimeState.display instanceof ImageDisplay) {
    summary = runtimeState.display.update(decoded.message, epoch);
    const nextRaster = await rasterFrame(decoded, context.rawImageRgba);
    if (generation !== renderGeneration || epoch !== controller.state.epoch || !layers.layers.some(({ id }) => id === layer.id)) {
      nextRaster.close?.();
      throw new Error("stale render generation");
    }
    runtimeState.raster?.close?.();
    runtimeState.raster = nextRaster;
    runtimeState.lifecycle?.render();
  } else {
    throw new Error(`${displayLabel(layer.kind)} cannot decode ${channel.schema.name}`);
  }
  assertCurrent();
  if (isGeometryDisplay(runtimeState.display)) {
    const normalizedFrame = summary.frameId.replace(/^\/+|\/+$/gu, "");
    const modelMatrix = runtimeState.display instanceof FrameTreeDisplay || normalizedFrame === fixedFrame
      ? IDENTITY_TRANSFORM
      : frameResolver?.matrixFromFixed(normalizedFrame, runtimeState.tfQueryTimeNanos);
    if (!modelMatrix) throw new Error(`TF frame ${summary.frameId || "<empty>"} cannot be resolved from fixed frame ${fixedFrame}`);
    ensureRenderer().setTransform(layer.id, modelMatrix);
    runtimeState.modelMatrix = modelMatrix;
  }
  layers.update(layer.id, { messageTimeNanos: envelope.schedulingTime.valueNanos, status: "ready", summary, error: undefined });
}

function renderTopics(): void {
  const topics = controller.visibleTopics;
  topicList.innerHTML = topics.length === 0 ? `<p class="empty-copy">${controller.state.phase === "loading" ? "Reading schemas and indexes…" : "No matching topics."}</p>` : topics.map((topic) => {
    const actions = topic.availableDisplays.map((kind) => `<button type="button" data-topic="${escapeHtml(topic.id)}" data-kind="${kind}" title="Add ${displayLabel(kind)}">${icon("plus")} ${displayLabel(kind)}</button>`).join("");
    return `<article class="topic-row"><div><strong>${escapeHtml(topic.name)}</strong><span>${escapeHtml(topic.typeName)}</span></div><small>${topic.schemaCapability.replace("schema-", "")}</small><div class="topic-actions">${actions}</div></article>`;
  }).join("");
}

function layerColor(layer: ViewerLayer): string {
  const color = layer.color ?? palette[layer.colorIndex % palette.length]!;
  return `rgb(${Math.round(color[0] * 255)} ${Math.round(color[1] * 255)} ${Math.round(color[2] * 255)})`;
}

function layerColorHex(layer: ViewerLayer): string {
  const color = layer.color ?? palette[layer.colorIndex % palette.length]!;
  return `#${color.slice(0, 3).map((component) => Math.round(component * 255).toString(16).padStart(2, "0")).join("")}`;
}

function renderLayers(): void {
  byId("layer-count").textContent = String(layers.layers.length);
  layerList.innerHTML = layers.layers.length === 0 ? '<p class="empty-copy">Add displays from Topics. Multiple drawables share one synchronized scene.</p>' : layers.layers.map((layer) => `
    <article class="layer-row ${layers.selected?.id === layer.id ? "is-selected" : ""}" data-layer="${layer.id}" style="--layer-color:${layerColor(layer)}">
      <button class="visibility-button ${layer.visible ? "is-visible" : ""}" data-layer-action="toggle" type="button" aria-label="${layer.visible ? "Hide" : "Show"} ${escapeHtml(layer.topic.name)}">${icon("eye")}</button>
      <button class="layer-select" data-layer-action="select" type="button"><strong>${escapeHtml(layer.topic.name)}</strong><span>${displayLabel(layer.kind)} · ${layer.status.toLocaleUpperCase()}</span></button>
      <button class="remove-button" data-layer-action="remove" type="button" aria-label="Remove ${escapeHtml(layer.topic.name)}">${icon("minus")}</button>
    </article>`).join("");
}

function renderInspector(): void {
  const layer = layers.selected;
  if (!layer) {
    inspector.innerHTML = '<div class="section-label">SELECTION</div><p class="empty-copy">No drawable selected.</p>';
    return;
  }
  const runtimeState = layerRuntime.get(layer.id);
  const summary = layer.summary;
  const quality = summary && summary.droppedVertices > 0 ? `${summary.droppedVertices.toLocaleString()} dropped` : "full data";
  inspector.innerHTML = `<div class="section-label">SELECTION</div><h2>${escapeHtml(layer.topic.name)}</h2><p class="schema-name">${escapeHtml(layer.topic.typeName)}</p>${layer.error ? `<p class="layer-error">${escapeHtml(layer.error)}</p>` : ""}${isGeometryDisplay(runtimeState?.display) ? `<label class="display-config">COLOR <input type="color" data-layer-color="${layer.id}" value="${layerColorHex(layer)}" aria-label="${escapeHtml(layer.topic.name)} display color" /></label>` : ""}<dl>
    <div><dt>DISPLAY</dt><dd>${displayLabel(layer.kind)}</dd></div>
    ${layer.fieldPath ? `<div><dt>FIELD</dt><dd>${escapeHtml(layer.fieldPath)}</dd></div>` : ""}
    <div><dt>STATUS</dt><dd>${layer.status.toLocaleUpperCase()}</dd></div>
    <div><dt>MESSAGE TIME</dt><dd>${layer.messageTimeNanos?.toString() ?? "—"} ns</dd></div>
    <div><dt>FRAME</dt><dd>${escapeHtml(summary?.frameId || "—")}</dd></div>
    <div><dt>PAYLOAD</dt><dd>${runtimeState?.payloadBytes === undefined ? "—" : formatBytes(runtimeState.payloadBytes)}</dd></div>
    <div><dt>INPUT</dt><dd>${summary?.inputVertices.toLocaleString() ?? "—"}</dd></div>
    <div><dt>RENDERED</dt><dd>${summary?.renderedVertices.toLocaleString() ?? "—"}</dd></div>
    <div><dt>QUALITY</dt><dd class="${summary?.droppedVertices ? "quality-loss" : "quality-full"}">${quality.toLocaleUpperCase()}</dd></div>
  </dl>`;
}

function renderAuxiliary(): void {
  const auxiliary = layers.visibleLayers.filter(({ kind }) => kind === "image" || kind === "raw" || kind === "raw-inspector" || kind === "numeric-plot" || kind === "camera-info");
  auxDock.innerHTML = auxiliary.map((layer) => {
    const runtimeState = layerRuntime.get(layer.id);
    if (layer.kind === "image") return `<section class="aux-window" data-aux-layer="${layer.id}"><header><i style="background:${layerColor(layer)}"></i><strong>${escapeHtml(layer.topic.name)}</strong><span>${runtimeState?.raster ? `${runtimeState.raster.width}×${runtimeState.raster.height}` : layer.status}</span></header><canvas aria-label="Image display for ${escapeHtml(layer.topic.name)}"></canvas></section>`;
    if (layer.kind === "numeric-plot") return `<section class="aux-window plot-window" data-aux-layer="${layer.id}"><header><i style="background:${layerColor(layer)}"></i><strong>${escapeHtml(layer.topic.name)}</strong><span>${escapeHtml(layer.fieldPath ?? "data")}</span></header><canvas aria-label="Numeric plot for ${escapeHtml(layer.topic.name)}"></canvas></section>`;
    if (layer.kind === "camera-info") {
      const details = layer.summary?.details;
      return `<section class="aux-window info-window" data-aux-layer="${layer.id}"><header><i style="background:${layerColor(layer)}"></i><strong>${escapeHtml(layer.topic.name)}</strong><span>CAMERA INFO</span></header><dl><div><dt>SIZE</dt><dd>${details ? `${details.width} × ${details.height}` : "—"}</dd></div><div><dt>MODEL</dt><dd>${escapeHtml(String(details?.distortionModel ?? "—"))}</dd></div><div><dt>CALIBRATED</dt><dd>${details?.calibrated === true ? "YES" : "NO"}</dd></div></dl></section>`;
    }
    const preview = runtimeState?.rawStructured ? `${runtimeState.rawStructured}\n\nBYTE PREVIEW\n${runtimeState.raw?.text ?? ""}` : runtimeState?.raw?.text ?? "Waiting for message…";
    const numericActions = runtimeState?.generic?.numericFields.slice(0, 32).map(({ path }) => `<button type="button" data-plot-field="${escapeHtml(path)}">PLOT ${escapeHtml(path)}</button>`).join("") ?? "";
    return `<section class="aux-window raw-window" data-aux-layer="${layer.id}"><header><i style="background:${layerColor(layer)}"></i><strong>${escapeHtml(layer.topic.name)}</strong><span>${runtimeState?.raw ? `${runtimeState.raw.shownBytes} B shown` : layer.status}</span></header><div class="raw-field-actions">${numericActions}</div><pre>${escapeHtml(preview)}</pre></section>`;
  }).join("");
  for (const layer of auxiliary) {
    const target = auxDock.querySelector<HTMLCanvasElement>(`[data-aux-layer="${layer.id}"] canvas`);
    if (!target) continue;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    target.width = Math.max(1, Math.floor(target.clientWidth * scale));
    target.height = Math.max(1, Math.floor(target.clientHeight * scale));
    const context = target.getContext("2d", { alpha: false });
    if (!context) continue;
    context.fillStyle = "#08080a";
    context.fillRect(0, 0, target.width, target.height);
    if (layer.kind === "numeric-plot") {
      const samples = layerRuntime.get(layer.id)?.numericHistory ?? [];
      if (samples.length < 1) continue;
      const values = samples.map(({ value }) => value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const span = Math.max(max - min, 1e-9);
      context.strokeStyle = layerColor(layer);
      context.lineWidth = Math.max(1, scale);
      context.beginPath();
      samples.forEach(({ value }, index) => {
        const x = samples.length === 1 ? target.width / 2 : index / (samples.length - 1) * target.width;
        const y = target.height - ((value - min) / span * (target.height - 12) + 6);
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.stroke();
      if (samples.length === 1) {
        context.fillStyle = layerColor(layer);
        context.beginPath();
        context.arc(target.width / 2, target.height / 2, 2.5 * scale, 0, Math.PI * 2);
        context.fill();
      }
      continue;
    }
    if (layer.kind !== "image") continue;
    const raster = layerRuntime.get(layer.id)?.raster;
    if (!raster) continue;
    const fit = Math.min(target.width / raster.width, target.height / raster.height);
    const width = raster.width * fit;
    const height = raster.height * fit;
    context.imageSmoothingEnabled = true;
    context.drawImage(raster.source, (target.width - width) / 2, (target.height - height) / 2, width, height);
  }
}

function renderChrome(): void {
  const state = controller.state;
  shell.dataset.phase = state.phase;
  byId("source-name").textContent = (state.sourceLabel ?? "NO SOURCE").toLocaleUpperCase();
  byId("mode-tag").textContent = `${state.sourceMode ?? "local"} · READ ONLY`.toLocaleUpperCase();
  byId("topic-count").textContent = String(state.topics.length);
  byId("source-format").textContent = state.sourceFormat?.toLocaleUpperCase() ?? "—";
  byId("source-index").textContent = state.indexState.toLocaleUpperCase();
  byId("epoch-value").textContent = String(state.epoch);
  byId("current-time").textContent = formatSourceTime(state.currentTimeNanos);
  byId("duration-time").textContent = formatNanos(state.durationNanos);
  timeline.value = state.durationNanos === 0n ? "0" : String(Number((state.currentTimeNanos * 10_000n) / state.durationNanos));
  timeline.disabled = state.durationNanos === 0n || state.phase === "loading";
  byId("connection-dot").classList.toggle("is-active", state.phase === "ready" || state.phase === "degraded");
  byId<HTMLButtonElement>("share-button").disabled = !shareableMcap && !lastCreatedShare;
  byId("drop-prompt").hidden = state.phase !== "empty" && state.phase !== "error";
  const liveHealth = state.liveTelemetry
    ? ` Queue ${state.liveTelemetry.queuedMessages}/${formatBytes(state.liveTelemetry.queuedBytes)} · dropped ${state.liveTelemetry.droppedMessages}`
      + (state.liveTelemetry.latestRelayLatencyMs === undefined ? "" : ` · relay ${state.liveTelemetry.latestRelayLatencyMs.toFixed(2)} ms`)
      + (state.liveTelemetry.latestBrowserDeliveryLatencyMs === undefined ? "" : ` · display ${state.liveTelemetry.latestBrowserDeliveryLatencyMs.toFixed(2)} ms`)
    : "";
  statusLine.textContent = `${state.blockingError ?? state.notice ?? "Ready."}${liveHealth}`;
  statusLine.dataset.tone = state.blockingError ? "error" : state.phase === "degraded" ? "warning" : "normal";
  renderTopics();
  renderLayers();
  renderInspector();
  renderAuxiliary();
}

async function historicalFrameResolver(
  transformTopics: readonly TopicSummary[],
  requestedTime: bigint,
  epoch: number,
  generation: number,
): Promise<{
  readonly resolver?: FrameTransformResolver;
  readonly frameTreeMessage?: Extract<DecodedSemanticMessage, { readonly kind: "frame-tree" }>["message"];
  readonly diagnostics: readonly string[];
}> {
  const samplesByTopic = new Map<string, readonly BrowserSample[]>();
  const referenceSampleByTopic = new Map<string, BrowserSample>();
  const diagnostics: string[] = [];
  if (controller.state.sourceMode === "live") {
    // Live frame-tree visualization is explicitly latest-per-child: no future
    // bracket exists yet and relay receipt time may differ from ROS header time.
    // Geometry TF lookup remains strict and header-time based.
    const snapshot = liveTfBuffer?.latestSnapshot(epoch);
    return {
      ...(liveTfBuffer && liveTfEpoch === epoch && liveTfTransformCount > 0
        ? { resolver: new HistoricalFrameResolver(fixedFrame, epoch, liveTfBuffer) }
        : {}),
      ...(snapshot?.samples.length ? { frameTreeMessage: { transforms: snapshot.samples.map((sample) => ({
        parentFrameId: sample.parentFrame,
        childFrameId: sample.childFrame,
        stampNanos: sample.timeNanos,
        translation: sample.translation,
        rotation: sample.rotation,
      })) } } : {}),
      diagnostics: [...diagnostics, ...(snapshot?.diagnostics ?? [])],
    };
  } else {
    await Promise.all(transformTopics.map(async (topic) => {
      const window = await runtime.messagesAround(topic.name, requestedTime);
      if (window.truncated && /(?:^|\/)tf_static$/u.test(topic.name)) {
        throw new Error(`${topic.name} static TF history exceeded its bounded prefix; transform rendering was refused instead of using an incomplete frame tree`);
      }
      samplesByTopic.set(topic.id, window.samples);
      const reference = window.before ?? window.after;
      if (reference) referenceSampleByTopic.set(topic.id, reference);
      if (window.truncated) diagnostics.push(`${topic.name} TF history was bounded to 2,048 messages and 32 MiB on each side of the playhead`);
    }));
  }
  if (generation !== renderGeneration || epoch !== controller.state.epoch) throw new DOMException("TF history superseded", "AbortError");
  const buffer = new TfBuffer(epoch, 100_000, 30_000_000_000n, RECORDED_TF_MAX_HEADER_HISTORY_NANOS);
  let transformCount = 0;
  let snapshotHeaderTimeNanos: bigint | undefined;
  for (const topic of transformTopics) {
    const seen = new Set<string>();
    for (const sample of samplesByTopic.get(topic.id) ?? []) {
      const sampleKey = `${sample.sourceSequence ?? sample.logTimeNanos}:${sample.logTimeNanos}:${sample.data.byteLength}`;
      if (seen.has(sampleKey)) continue;
      seen.add(sampleKey);
      const decoded = await messageDecoder.semantic(sample);
      if (generation !== renderGeneration || epoch !== controller.state.epoch) throw new DOMException("TF decode superseded", "AbortError");
      if (decoded.kind !== "frame-tree") continue;
      if (!/(?:^|\/)tf_static$/u.test(topic.name) && sample === referenceSampleByTopic.get(topic.id)) {
        for (const transform of decoded.message.transforms) {
          snapshotHeaderTimeNanos = snapshotHeaderTimeNanos === undefined || transform.stampNanos > snapshotHeaderTimeNanos
            ? transform.stampNanos
            : snapshotHeaderTimeNanos;
        }
      }
      for (const transform of decoded.message.transforms) {
        const parentFrame = transform.parentFrameId.replace(/^\/+|\/+$/gu, "");
        const childFrame = transform.childFrameId.replace(/^\/+|\/+$/gu, "");
        buffer.add({
          parentFrame,
          childFrame,
          timeNanos: transform.stampNanos,
          isStatic: /(?:^|\/)tf_static$/u.test(topic.name),
          epoch,
          translation: transform.translation,
          rotation: transform.rotation,
        });
        transformCount += 1;
      }
    }
  }
  const snapshot = buffer.snapshot(snapshotHeaderTimeNanos ?? requestedTime, epoch);
  return {
    ...(transformCount > 0 ? { resolver: new HistoricalFrameResolver(fixedFrame, epoch, buffer) } : {}),
    ...(snapshot.samples.length ? { frameTreeMessage: { transforms: snapshot.samples.map((sample) => ({
      parentFrameId: sample.parentFrame,
      childFrameId: sample.childFrame,
      stampNanos: sample.timeNanos,
      translation: sample.translation,
      rotation: sample.rotation,
    })) } } : {}),
    diagnostics: [...diagnostics, ...snapshot.diagnostics],
  };
}

async function renderSceneAtCurrentTime(frameVisible = false): Promise<void> {
  messageDecoder.reset("Render superseded by a newer timeline/source request.");
  renderGeneration += 1;
  fitQueued ||= frameVisible;
  if (rendering) {
    renderQueued = true;
    return renderCompletion;
  }
  rendering = true;
  renderCompletion = (async () => { try {
    do {
      renderQueued = false;
      const shouldFit = fitQueued;
      fitQueued = false;
      const visible = [...layers.visibleLayers];
      const requestedTime = controller.state.currentTimeNanos;
      const epoch = controller.state.epoch;
      const generation = renderGeneration;
      for (const layer of visible) layers.update(layer.id, { status: "loading" });
      renderChrome();
      sceneMessage.textContent = visible.length === 0 ? "Add one or more topic displays." : `Resolving ${visible.length} drawable${visible.length === 1 ? "" : "s"} at ${formatSourceTime(requestedTime)}…`;
      const sampleResults = new Map<string, BrowserSample | Error>();
      const transformTopics = controller.state.topics.filter((topic) => topic.availableDisplays.includes("frame-tree"));
      const uniqueTopics = [...new Map([...visible.map((layer) => layer.topic), ...transformTopics].map((topic) => [topic.id, topic])).values()];
      let topicCursor = 0;
      const loadTopic = async (): Promise<void> => {
        while (topicCursor < uniqueTopics.length) {
          const topic = uniqueTopics[topicCursor++]!;
          try {
            let sample: BrowserSample;
            if (controller.state.sourceMode === "live") {
              const liveSample = liveSamples.get(topic.id);
              if (!liveSample) throw new Error("Waiting for the first live message.");
              sample = liveSample;
            } else {
              sample = await runtime.messageAt(topic.name, requestedTime);
            }
            sampleResults.set(topic.id, sample);
          } catch (error) {
            sampleResults.set(topic.id, error instanceof Error ? error : new Error(String(error)));
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(1, uniqueTopics.length) }, loadTopic));
      if (generation !== renderGeneration || epoch !== controller.state.epoch) continue;
      let frameResolver: FrameTransformResolver | undefined;
      let frameTreeMessage: Extract<DecodedSemanticMessage, { readonly kind: "frame-tree" }>["message"] | undefined;
      let tfDiagnostics: readonly string[] = [];
      try {
        const frameResolution = await historicalFrameResolver(transformTopics, requestedTime, epoch, generation);
        frameResolver = frameResolution.resolver;
        frameTreeMessage = frameResolution.frameTreeMessage;
        tfDiagnostics = frameResolution.diagnostics;
      } catch (error) {
        if (generation !== renderGeneration || epoch !== controller.state.epoch) continue;
        sceneMessage.textContent = `TF history rejected: ${error instanceof Error ? error.message : String(error)}`;
      }
      for (const layer of visible) {
        try {
          const result = sampleResults.get(layer.topic.id);
          if (result instanceof Error) throw result;
          if (!result) throw new Error("Topic message resolution did not complete.");
          await updateLayer(layer, result, epoch, generation, frameResolver, frameTreeMessage);
        } catch (error) {
          if (generation === renderGeneration && epoch === controller.state.epoch && layers.layers.some(({ id }) => id === layer.id)) {
            layers.update(layer.id, { status: "error", error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      if (generation !== renderGeneration || epoch !== controller.state.epoch) continue;
      if (shouldFit) {
        const bounds = combinedBounds();
        if (bounds) camera.frame(bounds);
      }
      renderChrome();
      drawScene();
      const failures = visible.filter(({ id }) => layers.layers.find((layer) => layer.id === id)?.status === "error").length;
      const tfDiagnosticText = tfDiagnostics.length ? ` ${tfDiagnostics.join(" · ")}.` : "";
      sceneMessage.textContent = failures
        ? `${failures} drawable${failures === 1 ? "" : "s"} failed; other layers remain visible.${tfDiagnosticText}`
        : `${visible.length} synchronized drawable${visible.length === 1 ? "" : "s"} at ${formatSourceTime(requestedTime)}.${tfDiagnosticText}`;
      sceneMessage.dataset.tone = failures ? "error" : tfDiagnostics.length ? "warning" : "normal";
    } while (renderQueued);
  } finally {
    rendering = false;
  } })();
  return renderCompletion;
}

function addLayer(topic: TopicSummary, kind: DisplayKind, fieldPath?: string): ViewerLayer {
  const layer = layers.add(topic, kind, fieldPath);
  ensureLayerDisplay(layer);
  renderChrome();
  if (controller.state.sourceMode === "live") {
    void syncLiveSubscriptions();
  } else void renderSceneAtCurrentTime(true);
  return layer;
}

interface SelectedBrowserFile { readonly file: File; readonly relativePath: string }
function selectedFiles(files: FileList): SelectedBrowserFile[] {
  return Array.from(files, (file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<SelectedBrowserFile> {
  return new Promise((resolve, reject) => entry.file((file) => resolve({ file, relativePath: entry.fullPath.replace(/^\//u, "") || file.name }), reject));
}

async function directoryEntries(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const output: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return output;
    output.push(...batch);
  }
}

async function filesFromEntry(entry: FileSystemEntry): Promise<SelectedBrowserFile[]> {
  if (entry.isFile) return [await fileFromEntry(entry as FileSystemFileEntry)];
  if (!entry.isDirectory) return [];
  return (await Promise.all((await directoryEntries(entry as FileSystemDirectoryEntry)).map(filesFromEntry))).flat();
}

async function droppedFiles(transfer: DataTransfer): Promise<SelectedBrowserFile[]> {
  const entries = Array.from(transfer.items, (item) => item.webkitGetAsEntry()).filter((entry): entry is FileSystemEntry => entry !== null);
  return entries.length === 0 ? selectedFiles(transfer.files) : (await Promise.all(entries.map(filesFromEntry))).flat();
}

function autoAddLayers(): void {
  const preferred: readonly DisplayKind[] = ["point-cloud", "pointcloud2", "path", "frame-tree", "laser-scan", "odometry", "occupancy-grid", "marker", "image", "camera-info", "numeric-plot"];
  const usedKinds = new Set<DisplayKind>();
  for (const kind of preferred) {
    if ((kind === "pointcloud2" && usedKinds.has("point-cloud")) || (kind === "point-cloud" && usedKinds.has("pointcloud2"))) continue;
    const topic = controller.state.topics.find((candidate) => candidate.messageCount !== 0n && candidate.availableDisplays.includes(kind));
    if (!topic) continue;
    layers.add(topic, kind);
    usedKinds.add(kind);
  }
  for (const layer of layers.layers) ensureLayerDisplay(layer);
}

async function openFiles(entries: readonly SelectedBrowserFile[]): Promise<void> {
  if (entries.length === 0) return;
  stopPlayback();
  if (controller.state.sourceMode === "live") await controller.disconnectLive();
  liveSamples.clear();
  resetLiveTfState();
  liveRenderSequences.clear();
  clearLayerRuntimes();
  const ros2 = entries.some(({ relativePath }) => detectBrowserSourceFormat(relativePath) === "ros2-sqlite");
  const first = entries[0]!;
  const detected = ros2 ? "ros2-sqlite" : detectBrowserSourceFormat(first.file.name);
  const name = ros2 ? `ROS2 BAG · ${entries.length} FILE${entries.length === 1 ? "" : "S"}` : first.file.name;
  renderChrome();
  await controller.openLocal({
    format: detected === "unknown" ? "mcap" : detected,
    name,
    sizeBytes: entries.reduce((total, { file }) => total + file.size, 0),
    immutableVersion: entries.map(({ file, relativePath }) => `${relativePath}:${localFileVersion(file)}`).join("|"),
    blob: first.file,
    files: entries.map(({ file, relativePath }) => ({ name: file.name, relativePath, sizeBytes: file.size, immutableVersion: localFileVersion(file), blob: file })),
  });
  shareableMcap = detected === "mcap" && entries.length === 1 ? first.file : undefined;
  autoAddLayers();
  renderChrome();
  await renderSceneAtCurrentTime(true);
}

function stopPlayback(): void {
  playing = false;
  cancelAnimationFrame(animationFrame);
  playButton.innerHTML = icon("play");
  playButton.setAttribute("aria-label", "Play recording");
}

function startPlayback(): void {
  if (controller.state.durationNanos === 0n) return;
  playing = true;
  lastFrameMilliseconds = performance.now();
  playButton.innerHTML = icon("pause");
  playButton.setAttribute("aria-label", "Pause recording");
  const tick = async (now: number) => {
    if (!playing) return;
    const elapsed = Math.min(now - lastFrameMilliseconds, 250);
    lastFrameMilliseconds = now;
    if (!rendering) {
      const rate = Number(byId<HTMLSelectElement>("playback-rate").value);
      const delta = BigInt(Math.max(1, Math.round(elapsed * rate * 1_000_000)));
      const duration = controller.state.durationNanos;
      const next = controller.state.currentTimeNanos + delta;
      if (next >= duration) {
        await controller.seek(duration);
        await renderSceneAtCurrentTime();
        stopPlayback();
        return;
      }
      await controller.seek(next);
      await renderSceneAtCurrentTime();
    }
    animationFrame = requestAnimationFrame((timestamp) => void tick(timestamp));
  };
  animationFrame = requestAnimationFrame((timestamp) => void tick(timestamp));
}

async function seekTo(requested: bigint): Promise<void> {
  await controller.seek(requested);
  renderChrome();
  await renderSceneAtCurrentTime();
}

input.addEventListener("change", () => { if (input.files) void openFiles(selectedFiles(input.files)); input.value = ""; });
directoryInput.addEventListener("change", () => { if (directoryInput.files) void openFiles(selectedFiles(directoryInput.files)); directoryInput.value = ""; });
byId("drop-open-button").addEventListener("click", () => input.click());

byId<HTMLButtonElement>("demo-button").addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const kind = byId<HTMLSelectElement>("demo-kind").value as "mcap" | "ros1" | "ros2";
  button.disabled = true;
  button.textContent = "LOADING";
  try {
    const paths = kind === "mcap" ? ["demo.mcap"] : kind === "ros1" ? ["demo-ros1.bag"] : ["demo-ros2/metadata.yaml", "demo-ros2/data_0.db3"];
    const entries = await Promise.all(paths.map(async (path): Promise<SelectedBrowserFile> => {
      const response = await fetch(`/${path}`);
      if (!response.ok) throw new Error(`Demo request for ${path} failed with HTTP ${response.status}.`);
      const blob = await response.blob();
      return { file: new File([blob], path.split("/").at(-1) ?? path, { type: "application/octet-stream", lastModified: 0 }), relativePath: path };
    }));
    await openFiles(entries);
  } catch (error) {
    statusLine.dataset.tone = "error";
    statusLine.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
    button.textContent = "DEMO";
  }
});

const sourceDialog = byId<HTMLDialogElement>("source-dialog");
const openSourceDialog = (mode: "remote" | "live"): void => {
  sourceDialog.dataset.mode = mode;
  sourceDialog.setAttribute("aria-labelledby", mode === "remote" ? "source-dialog-title" : "live-dialog-title");
  sourceDialog.showModal();
};
byId("remote-button").addEventListener("click", () => openSourceDialog("remote"));
byId("live-button").addEventListener("click", () => openSourceDialog("live"));
byId("source-dialog-close").addEventListener("click", () => sourceDialog.close());
byId("live-dialog-close").addEventListener("click", () => sourceDialog.close());
byId("remote-cancel").addEventListener("click", () => sourceDialog.close());
byId("live-cancel").addEventListener("click", () => sourceDialog.close());

const shareDialog = byId<HTMLDialogElement>("share-dialog");
function renderShareDialog(): void {
  const resultWrap = byId<HTMLElement>("share-result-wrap");
  const result = byId<HTMLInputElement>("share-result");
  const create = byId<HTMLButtonElement>("share-create");
  byId("share-summary").textContent = shareableMcap
    ? `${shareableMcap.name} · ${(shareableMcap.size / (1024 * 1024)).toFixed(1)} MiB. The server retains it only for the selected link lifetime plus a bounded cleanup window.`
    : lastCreatedShare ? `The last capability link expires at ${new Date(lastCreatedShare.expiresAtMs).toLocaleString()}.` : "Open a local MCAP recording first.";
  create.disabled = !shareableMcap;
  resultWrap.hidden = !lastCreatedShare;
  result.value = lastCreatedShare?.recordingUrl ?? "";
  byId<HTMLButtonElement>("share-copy").hidden = !lastCreatedShare;
  byId<HTMLButtonElement>("share-revoke").hidden = !lastCreatedShare;
}
byId("share-button").addEventListener("click", () => { renderShareDialog(); shareDialog.showModal(); });
for (const id of ["share-dialog-close", "share-cancel"]) byId(id).addEventListener("click", () => shareDialog.close());
byId<HTMLFormElement>("share-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const file = shareableMcap;
  if (!file) return;
  const createToken = byId<HTMLInputElement>("share-create-token").value;
  byId<HTMLInputElement>("share-create-token").value = "";
  const create = byId<HTMLButtonElement>("share-create");
  create.disabled = true;
  create.textContent = "UPLOADING";
  statusLine.dataset.tone = "normal";
  statusLine.textContent = `Creating an expiring share for ${file.name}…`;
  void fetch("/api/share", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-recording-name": encodeURIComponent(file.name),
      "x-share-ttl-seconds": byId<HTMLSelectElement>("share-ttl").value,
      ...(createToken ? { "x-share-create-token": createToken } : {}),
    },
    body: file,
    credentials: "same-origin",
  }).then(async (response) => {
    const payload = await response.json() as Partial<typeof lastCreatedShare> & { readonly error?: string };
    if (!response.ok || !payload.recordingUrl || !payload.revokeUrl || !payload.revokeToken || !payload.expiresAtMs) throw new Error(payload.error ?? `Share service returned HTTP ${response.status}.`);
    lastCreatedShare = {
      recordingUrl: new URL(payload.recordingUrl, location.href).href,
      revokeUrl: new URL(payload.revokeUrl, location.href).href,
      revokeToken: payload.revokeToken,
      expiresAtMs: payload.expiresAtMs,
    };
    statusLine.textContent = `Share link created; expires ${new Date(payload.expiresAtMs).toLocaleString()}.`;
    renderShareDialog();
  }).catch((error) => {
    statusLine.dataset.tone = "error";
    statusLine.textContent = `Could not create share: ${error instanceof Error ? error.message : String(error)}`;
  }).finally(() => {
    create.textContent = "CREATE LINK";
    create.disabled = !shareableMcap;
  });
});
byId("share-copy").addEventListener("click", () => {
  if (!lastCreatedShare) return;
  void navigator.clipboard.writeText(lastCreatedShare.recordingUrl).then(() => { statusLine.textContent = "Capability link copied."; });
});
byId("share-revoke").addEventListener("click", () => {
  const share = lastCreatedShare;
  if (!share) return;
  void fetch(share.revokeUrl, { method: "POST", headers: { Authorization: `Bearer ${share.revokeToken}` }, credentials: "same-origin" }).then((response) => {
    if (!response.ok) throw new Error(`Share service returned HTTP ${response.status}.`);
    lastCreatedShare = undefined;
    statusLine.textContent = "Share link revoked.";
    renderShareDialog();
    renderChrome();
  }).catch((error) => {
    statusLine.dataset.tone = "error";
    statusLine.textContent = `Could not revoke share: ${error instanceof Error ? error.message : String(error)}`;
  });
});
byId<HTMLFormElement>("remote-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const remoteInput = byId<HTMLInputElement>("remote-url");
  const url = remoteInput.value;
  remoteInput.value = "";
  sourceDialog.close();
  stopPlayback();
  clearLayerRuntimes();
  renderChrome();
  void (async () => {
    if (controller.state.sourceMode === "live") await controller.disconnectLive();
    shareableMcap = undefined;
    liveSamples.clear();
    resetLiveTfState();
    liveRenderSequences.clear();
    await controller.openHosted({ link: url });
    if (controller.state.phase === "ready" || controller.state.phase === "degraded") autoAddLayers();
    renderChrome();
    if (layers.layers.length > 0) await renderSceneAtCurrentTime(true);
  })();
});
byId<HTMLFormElement>("live-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const endpoint = byId<HTMLInputElement>("live-endpoint").value;
  const sessionToken = byId<HTMLInputElement>("live-token").value;
  byId<HTMLInputElement>("live-token").value = "";
  sourceDialog.close();
  stopPlayback();
  clearLayerRuntimes();
  shareableMcap = undefined;
  liveSamples.clear();
  resetLiveTfState();
  liveRenderSequences.clear();
  try {
    liveRelay.setEndpoint(endpoint);
  } catch (error) {
    statusLine.dataset.tone = "error";
    statusLine.textContent = error instanceof Error ? error.message : String(error);
    return;
  }
  renderChrome();
  void controller.connectLive({ browserOrigin: location.origin, sessionToken }).then(async () => {
    if (controller.state.phase === "ready" || controller.state.phase === "degraded") {
      autoAddLayers();
      await syncLiveSubscriptions();
    }
    renderChrome();
  });
});

for (const name of ["dragenter", "dragover"] as const) scenePanel.addEventListener(name, (event) => { event.preventDefault(); scenePanel.classList.add("is-dragging"); });
for (const name of ["dragleave", "drop"] as const) scenePanel.addEventListener(name, (event) => { event.preventDefault(); scenePanel.classList.remove("is-dragging"); });
scenePanel.addEventListener("drop", (event) => {
  if (!event.dataTransfer) return;
  void droppedFiles(event.dataTransfer).then(openFiles).catch((error) => {
    statusLine.dataset.tone = "error";
    statusLine.textContent = `Could not read recording: ${error instanceof Error ? error.message : String(error)}`;
  });
});

byId<HTMLInputElement>("topic-filter").addEventListener("input", (event) => {
  controller.setTopicFilter((event.target as HTMLInputElement).value);
  renderTopics();
});

topicList.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-topic][data-kind]");
  if (!button) return;
  const topic = controller.state.topics.find(({ id }) => id === button.dataset.topic);
  const kind = button.dataset.kind as DisplayKind | undefined;
  if (topic && kind) addLayer(topic, kind);
});

auxDock.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-plot-field]");
  const windowElement = button?.closest<HTMLElement>("[data-aux-layer]");
  if (!button || !windowElement) return;
  const rawLayer = layers.layers.find(({ id }) => id === windowElement.dataset.auxLayer);
  const fieldPath = button.dataset.plotField;
  if (rawLayer && fieldPath) addLayer(rawLayer.topic, "numeric-plot", fieldPath);
});

layerList.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-layer-action]");
  const row = button?.closest<HTMLElement>("[data-layer]");
  if (!button || !row) return;
  const id = row.dataset.layer!;
  if (button.dataset.layerAction === "select") layers.select(id);
  if (button.dataset.layerAction === "toggle") {
    renderGeneration += 1;
    layers.toggle(id);
  }
  if (button.dataset.layerAction === "remove") {
    renderGeneration += 1;
    const runtimeState = layerRuntime.get(id);
    runtimeState?.lifecycle?.dispose();
    runtimeState?.raster?.close?.();
    layerRuntime.delete(id);
    layers.remove(id);
  }
  const newlyVisible = button.dataset.layerAction === "toggle" && layers.layers.find((layer) => layer.id === id)?.visible;
  if (newlyVisible) void renderSceneAtCurrentTime();
  else {
    renderChrome();
    drawScene();
  }
  if (controller.state.sourceMode === "live" && button.dataset.layerAction !== "select") void syncLiveSubscriptions();
});

inspector.addEventListener("change", (event) => {
  const inputElement = (event.target as HTMLElement).closest<HTMLInputElement>("input[data-layer-color]");
  if (!inputElement) return;
  const match = inputElement.value.match(/^#([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/iu);
  if (!match) return;
  const color = [Number.parseInt(match[1]!, 16) / 255, Number.parseInt(match[2]!, 16) / 255, Number.parseInt(match[3]!, 16) / 255, 1] as const;
  const id = inputElement.dataset.layerColor!;
  layers.setColor(id, color);
  const runtimeState = layerRuntime.get(id);
  runtimeState?.lifecycle?.dispose();
  runtimeState?.raster?.close?.();
  layerRuntime.delete(id);
  const layer = layers.layers.find((candidate) => candidate.id === id);
  if (!layer) return;
  ensureLayerDisplay(layer);
  renderChrome();
  void renderSceneAtCurrentTime();
});

timeline.addEventListener("input", () => {
  const duration = controller.state.durationNanos;
  const requested = duration === 0n ? 0n : (duration * BigInt(timeline.value)) / 10_000n;
  byId("current-time").textContent = formatNanos(requested);
});
timeline.addEventListener("change", () => {
  stopPlayback();
  const duration = controller.state.durationNanos;
  void seekTo(duration === 0n ? 0n : (duration * BigInt(timeline.value)) / 10_000n);
});

async function step(direction: -1 | 1): Promise<void> {
  stopPlayback();
  const duration = controller.state.durationNanos;
  if (duration === 0n) return;
  const delta = duration / 100n || 1n;
  const current = controller.state.currentTimeNanos;
  await seekTo(direction < 0 ? (current > delta ? current - delta : 0n) : (current + delta > duration ? duration : current + delta));
}

byId("step-back").addEventListener("click", () => void step(-1));
byId("step-forward").addEventListener("click", () => void step(1));
playButton.addEventListener("click", () => playing ? stopPlayback() : startPlayback());

document.querySelector<HTMLElement>(".camera-tools")!.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-camera]");
  const action = button?.dataset.camera;
  if (!action) return;
  if (action === "fit") {
    const bounds = combinedBounds();
    if (bounds) camera.frame(bounds);
  } else camera.preset(action as CameraPreset);
  drawScene();
});

byId<HTMLInputElement>("fixed-frame-input").addEventListener("change", (event) => {
  const inputElement = event.currentTarget as HTMLInputElement;
  const next = inputElement.value.replace(/^\/+|\/+$/gu, "").trim();
  if (!next) {
    inputElement.value = fixedFrame;
    statusLine.dataset.tone = "error";
    statusLine.textContent = "TF fixed frame cannot be empty.";
    return;
  }
  fixedFrame = next;
  inputElement.value = next;
  rebuildLayerRuntimes();
  renderChrome();
  void renderSceneAtCurrentTime(true);
});

let pointer: { readonly id: number; readonly x: number; readonly y: number; readonly pan: boolean } | undefined;
canvas.addEventListener("pointerdown", (event) => {
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: event.shiftKey || event.button === 1 || event.button === 2 };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!pointer || pointer.id !== event.pointerId) return;
  const deltaX = event.clientX - pointer.x;
  const deltaY = event.clientY - pointer.y;
  if (pointer.pan) camera.pan(deltaX, deltaY, canvas.clientHeight); else camera.orbit(deltaX, deltaY);
  pointer = { ...pointer, x: event.clientX, y: event.clientY };
  drawScene();
});
canvas.addEventListener("pointerup", (event) => { if (pointer?.id === event.pointerId) pointer = undefined; });
canvas.addEventListener("pointercancel", () => { pointer = undefined; });
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("wheel", (event) => { event.preventDefault(); camera.zoom(event.deltaY); drawScene(); }, { passive: false });
canvas.addEventListener("dblclick", () => { const bounds = combinedBounds(); if (bounds) camera.frame(bounds); drawScene(); });

new ResizeObserver(() => { renderAuxiliary(); drawScene(); }).observe(scenePanel);
renderChrome();
drawScene();
