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
import { collectNumericFields, numericValueAtPath, type GenericRosDecodeResult } from "./generic-ros-decoder.js";
import { HistoricalFrameResolver, IDENTITY_TRANSFORM, transformBounds, type FrameTransformResolver } from "./frame-resolver.js";
import { OrbitCamera, type CameraPreset } from "./scene-camera.js";
import { poseSourceFrame } from "./pose-source-frame.js";
import { DesktopShellController, type DisplayKind, type TopicSummary } from "./shell.js";
import { standardRosSchema } from "./standard-ros-schema.js";
import { ViewerLayerRegistry, type ViewerLayer } from "./viewer-layers.js";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Application root is missing");

const icon = (name: "close" | "drag" | "eye" | "fit" | "folder" | "minus" | "pause" | "play" | "plus") => {
  const paths = {
    close: '<path d="m6 6 8 8m0-8-8 8"/>',
    eye: '<path d="M2 10s3.2-5 8-5 8 5 8 5-3.2 5-8 5-8-5-8-5Z"/><circle cx="10" cy="10" r="2.2"/>',
    fit: '<path d="M7 3H3v4m10-4h4v4M7 17H3v-4m10 4h4v-4"/>',
    folder: '<path d="M2.5 5.5h5l1.5 2h8.5v8.5h-15Z"/>',
    minus: '<path d="M5 10h10"/>',
    pause: '<path d="M6.5 5v10m7-10v10"/>',
    play: '<path d="m7 5 7 5-7 5Z"/>',
    plus: '<path d="M10 5v10m-5-5h10"/>',
    drag: '<path d="M7 6h6M7 10h6M7 14h6"/>',
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
        <label class="fixed-frame-control">REFERENCE <input id="fixed-frame-input" value="" placeholder="ALL FRAMES" aria-label="TF reference frame; blank shows all native frames" spellcheck="false" /></label>
        <button id="pivot-toggle" type="button" aria-pressed="true" title="Show orbit center">PIVOT</button>
        <span class="dock-help">DRAG WINDOW TO PANE EDGE TO SPLIT</span><button id="reset-window-layout" type="button" title="Return all auxiliary windows to floating mode">RESET WINDOWS</button>
      </div>
      <div class="scene-stats" id="scene-stats"><span>WEBGL2</span><span data-scene-stat="vertices">0 VERTICES</span><span data-scene-stat="quality" class="quality-full">FULL DATA</span><span data-scene-stat="gpu">0 B GPU</span></div>
      <div class="drop-prompt" id="drop-prompt">
        <strong>DROP ROS RECORDING</strong>
        <span>MCAP · ROS1 BAG · ROS2 BAG DIRECTORY</span>
        <button id="drop-open-button" type="button">SELECT RECORDING</button>
      </div>
      <div class="aux-dock" id="aux-dock" aria-label="Image and raw data views"></div>
      <div class="dock-layout-overlay" id="dock-layout-overlay"></div>
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
const messageDecoder = new BrowserMessageDecoder();
const liveTfDecoder = new BrowserMessageDecoder();
const plotHistoryDecoder = new BrowserMessageDecoder();
const plotFieldDecoder = new BrowserMessageDecoder();
window.addEventListener("pagehide", () => { void runtime.close(); messageDecoder.close(); liveTfDecoder.close(); plotHistoryDecoder.close(); plotFieldDecoder.close(); }, { once: true });
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
    renderChrome(false);
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
let fixedFrame = "";
let pivotVisible = true;
let auxiliarySignature = "";
let auxiliaryOrder: string[] = [];
const auxiliaryPositions = new Map<string, { x: number; y: number }>();
const auxiliarySizes = new Map<string, { width: number; height: number }>();
type DockEdge = "bottom" | "left" | "right" | "top";
type DockNode = { readonly kind: "pane"; readonly key: string }
  | { readonly kind: "split"; readonly id: string; readonly axis: "x" | "y"; readonly ratio: number; readonly first: DockNode; readonly second: DockNode };
interface DockRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
let dockRoot: DockNode = { kind: "pane", key: "scene" };
let nextDockSplitId = 1;
let dockPaneRects = new Map<string, DockRect>();
let dockSplitRects = new Map<string, DockRect & { readonly axis: "x" | "y" }>();
let dockSplitParents = new Map<string, { readonly axis: "x" | "y"; readonly length: number; readonly first: DockRect; readonly second: DockRect; readonly ratio: number }>();
let dockDropTarget: { readonly paneKey: string; readonly edge: DockEdge; readonly incoming: DockRect; readonly remaining: DockRect } | undefined;
let activeDockSplitId: string | undefined;
let plotFieldPicker: {
  readonly topicId: string;
  readonly targetPlotGroupId?: string;
  readonly fields: readonly { readonly path: string; readonly value: number }[];
  readonly status: "error" | "loading" | "ready";
  readonly error?: string;
} | undefined;
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
const dockLayoutOverlay = byId<HTMLElement>("dock-layout-overlay");
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
  rawStructured?: string;
  generic?: GenericRosDecodeResult;
  numericFields?: readonly { readonly path: string; readonly value: number }[];
  rawMetadata?: string;
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
let visualFrameQueued = false;
let visualFrameDeferred = false;

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

function genericDecodeInput(sample: BrowserSample, data = sample.data) {
  const fallback = standardRosSchema(sample.channel.schema.name, sample.channel.messageEncoding);
  return {
    typeName: sample.channel.schema.name,
    messageEncoding: sample.channel.messageEncoding,
    schemaEncoding: sample.channel.schema.encoding ?? fallback?.encoding,
    schemaDefinition: sample.channel.schema.definition ?? fallback?.definition,
    schemaData: sample.channel.schema.data,
    data,
  };
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
    renderer.upsert({ id: "orbit-pivot", topology: "lines", positions: new Float32Array([-0.18, 0, 0, 0.18, 0, 0, 0, -0.18, 0, 0, 0.18, 0, 0, 0, -0.18, 0, 0, 0.18]), color: [0.38, 0.85, 1, 1] }),
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

function paintScene(): void {
  const activeRenderer = ensureRenderer();
  resizeScene();
  if (!gl) return;
  activeRenderer.setViewProjection(camera.viewProjection(canvas.width / canvas.height));
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const target = camera.snapshot().target;
  activeRenderer.setTransform("orbit-pivot", new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, target[0], target[1], target[2], 1]));
  for (const resource of gridResources) if (resource.id !== "orbit-pivot" || pivotVisible) resource.draw();
  for (const layer of layers.visibleLayers) {
    const runtimeState = layerRuntime.get(layer.id);
    if (!isGeometryDisplay(runtimeState?.display)) continue;
    if (runtimeState.display.telemetry().state === "rendering" && (layer.status === "ready" || layer.status === "error")) runtimeState.display.render();
  }
  renderSceneStats();
}

function drawScene(): void {
  if (visualFrameQueued) return;
  visualFrameQueued = true;
  requestAnimationFrame(() => {
    visualFrameQueued = false;
    if (rendering) {
      visualFrameDeferred = true;
      return;
    }
    layoutAuxiliaryWindows();
    paintScene();
    paintAuxiliaryCanvases();
  });
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
  const stats = byId("scene-stats");
  stats.querySelector<HTMLElement>('[data-scene-stat="vertices"]')!.textContent = `${rendered.toLocaleString()} VERTICES`;
  const quality = stats.querySelector<HTMLElement>('[data-scene-stat="quality"]')!;
  quality.textContent = dropped ? `${dropped.toLocaleString()} DROPPED` : "FULL DATA";
  quality.classList.toggle("quality-loss", dropped > 0);
  quality.classList.toggle("quality-full", dropped === 0);
  stats.querySelector<HTMLElement>('[data-scene-stat="gpu"]')!.textContent = `${formatBytes(gpu)} GPU`;
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
  auxiliaryOrder = [];
  auxiliaryPositions.clear();
  auxiliarySizes.clear();
  auxiliarySignature = "";
  dockRoot = { kind: "pane", key: "scene" };
  dockDropTarget = undefined;
  activeDockSplitId = undefined;
  plotFieldPicker = undefined;
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
      display.configure({ maxPoints: 1_000_000, maxInputBytes: 16 * 1024 * 1024, color, colorMode: layer.pointCloudColorMode ?? "uniform", colorAxis: layer.pointCloudColorAxis ?? "z", pointSize: layer.pointSize ?? 4 });
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
        if (layer.kind === "numeric-plot" && layer.fieldPath) {
          generic = await messageDecoder.generic(genericDecodeInput(sample, data));
        } else {
        const prepared = await messageDecoder.semanticPrepared(decoderInput, {
          maxPoints: 1_000_000,
          maxInputBytes: 16 * 1024 * 1024,
          color: layer.color ?? palette[layer.colorIndex % palette.length]!,
          colorMode: layer.pointCloudColorMode ?? "uniform",
          colorAxis: layer.pointCloudColorAxis ?? "z",
          pointSize: layer.pointSize ?? 4,
        });
        decoded = prepared.decoded;
        preparedPointCloud = prepared.pointCloud;
        rawImageRgba = prepared.rawImageRgba;
        }
      } catch (semanticError) {
        if (layer.kind !== "numeric-plot" || !layer.fieldPath) throw semanticError;
        decoded = await messageDecoder.semantic(decoderInput);
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
    runtimeState.generic = undefined;
    runtimeState.numericFields = undefined;
    runtimeState.rawMetadata = `TOPIC ${layer.topic.name}\nTYPE ${channel.schema.name}\nMESSAGE ENCODING ${channel.messageEncoding}\nSCHEMA ${channel.schema.capability.toLocaleUpperCase()}${channel.schema.encoding ? ` · ${channel.schema.encoding}` : ""}\nTIME ${envelope.schedulingTime.valueNanos} ns\nPAYLOAD ${data.byteLength} bytes`;
    let rawValue: unknown;
    try {
      const decoded = await messageDecoder.semantic(decoderInput);
      rawValue = decoded.message;
      runtimeState.rawStructured = structuredPreview(decoded.message);
      runtimeState.numericFields = collectNumericFields(decoded.message);
    } catch (semanticError) {
      try {
        const generic = await messageDecoder.generic(genericDecodeInput(decoderInput, data));
        runtimeState.generic = generic;
        runtimeState.numericFields = generic.numericFields;
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
  } else if (decoded && runtimeState.display instanceof NumericPlotDisplay && layer.fieldPath) {
    const value = numericValueAtPath(decoded.message, layer.fieldPath);
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
    const modelMatrix = !fixedFrame || runtimeState.display instanceof FrameTreeDisplay || normalizedFrame === fixedFrame
      ? IDENTITY_TRANSFORM
      : frameResolver?.matrixFromFixed(normalizedFrame, runtimeState.tfQueryTimeNanos);
    if (!modelMatrix) throw new Error(`TF frame ${summary.frameId || "<empty>"} cannot be resolved from reference frame ${fixedFrame}`);
    ensureRenderer().setTransform(layer.id, modelMatrix);
    runtimeState.modelMatrix = modelMatrix;
  }
  layers.update(layer.id, { messageTimeNanos: envelope.schedulingTime.valueNanos, status: "ready", summary, error: undefined });
}

function plotFieldRows(fields: readonly { readonly path: string; readonly value: number }[], query = ""): string {
  const needle = query.trim().toLocaleLowerCase();
  const matching = needle ? fields.filter(({ path }) => path.toLocaleLowerCase().includes(needle)) : fields;
  if (matching.length === 0) return '<p class="plot-field-empty">No matching finite numeric fields.</p>';
  const visible = matching.slice(0, 256);
  return `${visible.map(({ path, value }) => `<button type="button" data-add-plot-field="${escapeHtml(path)}"><span>${escapeHtml(path)}</span><output>${escapeHtml(value.toPrecision(6))}</output>${icon("plus")}</button>`).join("")}${matching.length > visible.length ? `<p class="plot-field-empty">${matching.length - visible.length} more fields — filter by name.</p>` : ""}`;
}

function plotFieldPickerMarkup(topic: TopicSummary): string {
  if (plotFieldPicker?.topicId !== topic.id) return "";
  const target = escapeHtml(plotFieldPicker.targetPlotGroupId ?? "new");
  if (plotFieldPicker.status === "loading") return `<section class="plot-field-picker" data-plot-picker data-plot-target="${target}"><p class="plot-field-empty">Reading fields for the selected plot…</p></section>`;
  if (plotFieldPicker.status === "error") return `<section class="plot-field-picker" data-plot-picker data-plot-target="${target}"><p class="plot-field-error">${escapeHtml(plotFieldPicker.error ?? "Numeric fields could not be decoded.")}</p></section>`;
  const targetFields = plotFieldPicker.targetPlotGroupId
    ? layers.layers.filter((layer) => layer.plotGroupId === plotFieldPicker?.targetPlotGroupId).map((layer) => layer.fieldPath ?? "data").join(" + ")
    : "";
  return `<section class="plot-field-picker" data-plot-picker data-plot-target="${target}">
    <header><strong>${plotFieldPicker.targetPlotGroupId ? `ADD TO · ${escapeHtml(targetFields)}` : "NEW PLOT"}</strong><button type="button" data-close-plot-picker aria-label="Close plot field picker">${icon("close")}</button></header>
    <label><span class="sr-only">Filter numeric fields</span><input type="search" data-plot-field-filter placeholder="orientation, velocity, covariance…" autocomplete="off" /></label>
    <div class="plot-field-list">${plotFieldRows(plotFieldPicker.fields)}</div>
  </section>`;
}

function renderTopics(): void {
  const topics = controller.visibleTopics;
  topicList.innerHTML = topics.length === 0 ? `<p class="empty-copy">${controller.state.phase === "loading" ? "Reading schemas and indexes…" : "No matching topics."}</p>` : topics.map((topic) => {
    const actions = topic.availableDisplays.map((kind) => `<button type="button" data-topic="${escapeHtml(topic.id)}" data-kind="${kind}" title="${kind === "numeric-plot" ? "Choose numeric fields to plot" : `Add ${displayLabel(kind)}`}">${icon("plus")} ${displayLabel(kind)}</button>`).join("");
    return `<article class="topic-row" data-topic-row="${escapeHtml(topic.id)}"><div><strong>${escapeHtml(topic.name)}</strong><span>${escapeHtml(topic.typeName)}</span></div><small>${topic.schemaCapability.replace("schema-", "")}</small><div class="topic-actions">${actions}</div>${plotFieldPickerMarkup(topic)}</article>`;
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
      <span class="layer-drag-handle" role="button" tabindex="0" draggable="true" aria-label="Drag ${escapeHtml(layer.topic.name)} to change draw order">${icon("drag")}</span>
      <button class="visibility-button ${layer.visible ? "is-visible" : ""}" data-layer-action="toggle" type="button" aria-label="${layer.visible ? "Hide" : "Show"} ${escapeHtml(layer.topic.name)}">${icon("eye")}</button>
      <button class="layer-select" data-layer-action="select" type="button"><strong>${escapeHtml(layer.topic.name)}</strong>${layer.kind === "numeric-plot" ? `<em>${escapeHtml(layer.fieldPath ?? "data")}</em>` : ""}<span data-layer-status>${displayLabel(layer.kind)} · ${layer.status.toLocaleUpperCase()}</span></button>
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
  const pointCloud = layer.kind === "point-cloud" || layer.kind === "pointcloud2";
  const colorMode = layer.pointCloudColorMode ?? "uniform";
  const pointControls = pointCloud ? `<div class="point-cloud-controls">
    <label class="display-config">POINT SIZE <span><input type="range" min="1" max="16" step="0.5" value="${layer.pointSize ?? 4}" data-point-size="${layer.id}" aria-label="Point size for ${escapeHtml(layer.topic.name)}" /><output>${layer.pointSize ?? 4}px</output></span></label>
    <label class="display-config">COLOR BY <select data-point-color-mode="${layer.id}" aria-label="Point color mode for ${escapeHtml(layer.topic.name)}"><option value="uniform" ${colorMode === "uniform" ? "selected" : ""}>UNIFORM</option><option value="intensity" ${colorMode === "intensity" ? "selected" : ""}>INTENSITY</option><option value="rgb" ${colorMode === "rgb" ? "selected" : ""}>RGB</option><option value="axis" ${colorMode === "axis" ? "selected" : ""}>AXIS</option></select></label>
    ${colorMode === "axis" ? `<label class="display-config">AXIS <select data-point-axis="${layer.id}" aria-label="Point color axis"><option value="x" ${layer.pointCloudColorAxis === "x" ? "selected" : ""}>X</option><option value="y" ${layer.pointCloudColorAxis === "y" ? "selected" : ""}>Y</option><option value="z" ${!layer.pointCloudColorAxis || layer.pointCloudColorAxis === "z" ? "selected" : ""}>Z</option></select></label><div class="color-ramp" aria-label="Blue to red axis color scale"></div>` : ""}
    ${colorMode === "intensity" ? `<div class="color-ramp" aria-label="Blue to red intensity color scale"></div>` : ""}
  </div>` : "";
  const uniformColor = isGeometryDisplay(runtimeState?.display) && (!pointCloud || colorMode === "uniform") ? `<label class="display-config">COLOR <input type="color" data-layer-color="${layer.id}" value="${layerColorHex(layer)}" aria-label="${escapeHtml(layer.topic.name)} display color" /></label>` : "";
  inspector.innerHTML = `<div class="section-label">SELECTION</div><h2>${escapeHtml(layer.topic.name)}</h2><p class="schema-name">${escapeHtml(layer.topic.typeName)}</p><p class="${layer.error ? "layer-error" : ""}" data-inspector-error ${layer.error ? "" : "hidden"}>${escapeHtml(layer.error ?? "")}</p>${pointControls}${uniformColor}<dl>
    <div><dt>DISPLAY</dt><dd>${displayLabel(layer.kind)}</dd></div>
    ${layer.fieldPath ? `<div><dt>FIELD</dt><dd>${escapeHtml(layer.fieldPath)}</dd></div>` : ""}
    <div><dt>STATUS</dt><dd data-inspector-value="status">${layer.status.toLocaleUpperCase()}</dd></div>
    <div><dt>MESSAGE TIME</dt><dd data-inspector-value="time">${layer.messageTimeNanos?.toString() ?? "—"} ns</dd></div>
    <div><dt>FRAME</dt><dd data-inspector-value="frame">${escapeHtml(summary?.frameId || "—")}</dd></div>
    <div><dt>PAYLOAD</dt><dd data-inspector-value="payload">${runtimeState?.payloadBytes === undefined ? "—" : formatBytes(runtimeState.payloadBytes)}</dd></div>
    <div><dt>INPUT</dt><dd data-inspector-value="input">${summary?.inputVertices.toLocaleString() ?? "—"}</dd></div>
    <div><dt>RENDERED</dt><dd data-inspector-value="rendered">${summary?.renderedVertices.toLocaleString() ?? "—"}</dd></div>
    <div><dt>QUALITY</dt><dd data-inspector-value="quality" class="${summary?.droppedVertices ? "quality-loss" : "quality-full"}">${quality.toLocaleUpperCase()}</dd></div>
  </dl>`;
}

function numericPlotSeries(anchor: ViewerLayer): readonly ViewerLayer[] {
  if (anchor.kind !== "numeric-plot") return [];
  return layers.visibleLayers.filter((candidate) => candidate.kind === "numeric-plot" && candidate.plotGroupId === anchor.plotGroupId);
}

function auxiliaryViewKey(layer: ViewerLayer): string {
  return layer.kind === "numeric-plot" ? `plot:${layer.plotGroupId ?? layer.id}` : `layer:${layer.id}`;
}

function orderedAuxiliaryLayers(): readonly ViewerLayer[] {
  const seenPlotGroups = new Set<string>();
  const visible = layers.visibleLayers.filter((layer) => {
    const { kind } = layer;
    if (kind === "numeric-plot") {
      const group = layer.plotGroupId ?? layer.id;
      if (seenPlotGroups.has(group)) return false;
      seenPlotGroups.add(group);
      return true;
    }
    return kind === "image" || kind === "raw" || kind === "raw-inspector" || kind === "camera-info";
  });
  const visibleKeys = new Set(visible.map(auxiliaryViewKey));
  auxiliaryOrder = auxiliaryOrder.filter((key) => visibleKeys.has(key));
  for (const layer of visible) {
    const key = auxiliaryViewKey(layer);
    if (!auxiliaryOrder.includes(key)) auxiliaryOrder.push(key);
  }
  const byKey = new Map(visible.map((layer) => [auxiliaryViewKey(layer), layer]));
  return auxiliaryOrder.flatMap((key) => byKey.get(key) ? [byKey.get(key)!] : []);
}

function auxiliaryStructureSignature(auxiliary: readonly ViewerLayer[]): string {
  return auxiliary.map((layer) => layer.kind === "numeric-plot"
    ? `${auxiliaryViewKey(layer)}:${layer.kind}:${numericPlotSeries(layer).map((series) => `${series.id}:${series.fieldPath ?? "data"}`).join(",")}`
    : `${auxiliaryViewKey(layer)}:${layer.kind}`).join("|");
}

function auxiliaryPosition(layerId: string, index: number, element: HTMLElement): { x: number; y: number } {
  const stored = auxiliaryPositions.get(layerId);
  const fallbackX = Math.max(8, scenePanel.clientWidth - element.offsetWidth - 12 - (index % 4) * 26);
  const fallbackY = Math.max(44, scenePanel.clientHeight - element.offsetHeight - 30 - Math.floor(index / 4) * 30);
  const x = Math.max(0, Math.min(stored?.x ?? fallbackX, scenePanel.clientWidth - element.offsetWidth));
  const y = Math.max(38, Math.min(stored?.y ?? fallbackY, scenePanel.clientHeight - element.offsetHeight - 22));
  const next = { x, y };
  auxiliaryPositions.set(layerId, next);
  return next;
}

function pruneDockNode(node: DockNode, validKeys: ReadonlySet<string>): DockNode | undefined {
  if (node.kind === "pane") return node.key === "scene" || validKeys.has(node.key) ? node : undefined;
  const first = pruneDockNode(node.first, validKeys);
  const second = pruneDockNode(node.second, validKeys);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function removeDockPane(node: DockNode, key: string): DockNode | undefined {
  if (node.kind === "pane") return node.key === key ? undefined : node;
  const first = removeDockPane(node.first, key);
  const second = removeDockPane(node.second, key);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function replaceDockPane(node: DockNode, targetKey: string, replacement: DockNode): DockNode {
  if (node.kind === "pane") return node.key === targetKey ? replacement : node;
  return { ...node, first: replaceDockPane(node.first, targetKey, replacement), second: replaceDockPane(node.second, targetKey, replacement) };
}

function dockView(viewKey: string, targetKey: string, edge: DockEdge): void {
  if (viewKey === targetKey) return;
  const withoutView = removeDockPane(dockRoot, viewKey) ?? { kind: "pane", key: "scene" };
  const view: DockNode = { kind: "pane", key: viewKey };
  const target: DockNode = { kind: "pane", key: targetKey };
  const before = edge === "left" || edge === "top";
  const split: DockNode = {
    kind: "split",
    id: `dock-split-${nextDockSplitId++}`,
    axis: edge === "left" || edge === "right" ? "x" : "y",
    ratio: 0.5,
    first: before ? view : target,
    second: before ? target : view,
  };
  dockRoot = replaceDockPane(withoutView, targetKey, split);
}

function setDockSplitRatio(node: DockNode, splitId: string, ratio: number): DockNode {
  if (node.kind === "pane") return node;
  if (node.id === splitId) return { ...node, ratio: Math.max(0.15, Math.min(0.85, ratio)) };
  return { ...node, first: setDockSplitRatio(node.first, splitId, ratio), second: setDockSplitRatio(node.second, splitId, ratio) };
}

function dockSplitRatio(node: DockNode, splitId: string): number | undefined {
  if (node.kind === "pane") return undefined;
  if (node.id === splitId) return node.ratio;
  return dockSplitRatio(node.first, splitId) ?? dockSplitRatio(node.second, splitId);
}

function calculateDockLayout(node: DockNode, rect: DockRect): void {
  if (node.kind === "pane") {
    dockPaneRects.set(node.key, rect);
    return;
  }
  const divider = 5;
  if (node.axis === "x") {
    const firstWidth = Math.max(1, Math.round((rect.width - divider) * node.ratio));
    const first = { ...rect, width: firstWidth };
    const second = { x: rect.x + firstWidth + divider, y: rect.y, width: Math.max(1, rect.width - firstWidth - divider), height: rect.height };
    dockSplitParents.set(node.id, { axis: node.axis, length: rect.width, first, second, ratio: node.ratio });
    calculateDockLayout(node.first, first);
    calculateDockLayout(node.second, second);
    dockSplitRects.set(node.id, { x: rect.x + firstWidth, y: rect.y, width: divider, height: rect.height, axis: "x" });
    return;
  }
  const firstHeight = Math.max(1, Math.round((rect.height - divider) * node.ratio));
  const first = { ...rect, height: firstHeight };
  const second = { x: rect.x, y: rect.y + firstHeight + divider, width: rect.width, height: Math.max(1, rect.height - firstHeight - divider) };
  dockSplitParents.set(node.id, { axis: node.axis, length: rect.height, first, second, ratio: node.ratio });
  calculateDockLayout(node.first, first);
  calculateDockLayout(node.second, second);
  dockSplitRects.set(node.id, { x: rect.x, y: rect.y + firstHeight, width: rect.width, height: divider, axis: "y" });
}

function dockOverlayMarkup(): string {
  const splitters = [...dockSplitRects].map(([id, rect]) => `<span class="dock-splitter" data-dock-split="${id}" data-axis="${rect.axis}" role="separator" aria-orientation="${rect.axis === "x" ? "vertical" : "horizontal"}" aria-label="Resize docked panes" tabindex="0" style="left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px"></span>`).join("");
  const preview = (rect: DockRect, label: string, className: string) => `<span class="dock-pane-preview ${className}" style="left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px"><b>${label}</b></span>`;
  let previews = "";
  if (dockDropTarget) {
    const axis = dockDropTarget.edge === "left" || dockDropTarget.edge === "right" ? "x" : "y";
    const incomingPixels = Math.round(axis === "x" ? dockDropTarget.incoming.width : dockDropTarget.incoming.height);
    const remainingPixels = Math.round(axis === "x" ? dockDropTarget.remaining.width : dockDropTarget.remaining.height);
    const total = Math.max(1, incomingPixels + remainingPixels);
    previews = preview(dockDropTarget.incoming, `NEW ${Math.round(incomingPixels / total * 100)}% · ${incomingPixels}px`, "is-incoming")
      + preview(dockDropTarget.remaining, `CURRENT ${Math.round(remainingPixels / total * 100)}% · ${remainingPixels}px`, "is-remaining");
  } else if (activeDockSplitId) {
    const active = dockSplitParents.get(activeDockSplitId);
    if (active) {
      const firstPixels = Math.round(active.axis === "x" ? active.first.width : active.first.height);
      const secondPixels = Math.round(active.axis === "x" ? active.second.width : active.second.height);
      const total = Math.max(1, firstPixels + secondPixels);
      previews = preview(active.first, `${Math.round(firstPixels / total * 100)}% · ${firstPixels}px`, "is-resizing")
        + preview(active.second, `${Math.round(secondPixels / total * 100)}% · ${secondPixels}px`, "is-resizing");
    }
  }
  return `${splitters}${previews}`;
}

function layoutAuxiliaryWindows(): void {
  const auxiliary = orderedAuxiliaryLayers();
  const validKeys = new Set(auxiliary.map(auxiliaryViewKey));
  dockRoot = pruneDockNode(dockRoot, validKeys) ?? { kind: "pane", key: "scene" };
  const docked = dockRoot.kind !== "pane";
  const workspace = docked
    ? { x: 0, y: 38, width: scenePanel.clientWidth, height: Math.max(1, scenePanel.clientHeight - 60) }
    : { x: 0, y: 0, width: scenePanel.clientWidth, height: scenePanel.clientHeight };
  dockPaneRects = new Map();
  dockSplitRects = new Map();
  dockSplitParents = new Map();
  calculateDockLayout(dockRoot, workspace);
  const sceneRect = dockPaneRects.get("scene") ?? workspace;
  canvas.style.left = `${sceneRect.x}px`;
  canvas.style.top = `${sceneRect.y}px`;
  canvas.style.width = `${sceneRect.width}px`;
  canvas.style.height = `${sceneRect.height}px`;
  const windows = [...auxDock.querySelectorAll<HTMLElement>("[data-aux-key]")];
  windows.forEach((element, index) => {
    const key = element.dataset.auxKey;
    if (!key) return;
    const measured = auxiliarySizes.get(key) ?? { width: element.offsetWidth, height: element.offsetHeight };
    auxiliarySizes.set(key, measured);
    const dockRect = dockPaneRects.get(key);
    element.classList.toggle("is-docked", Boolean(dockRect));
    if (dockRect) {
      element.style.width = `${dockRect.width}px`;
      element.style.height = `${dockRect.height}px`;
      element.style.transform = `translate3d(${dockRect.x}px, ${dockRect.y}px, 0)`;
      return;
    }
    element.style.width = `${Math.max(220, measured.width)}px`;
    element.style.height = `${Math.max(120, measured.height)}px`;
    const { x, y } = auxiliaryPosition(key, index, element);
    element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  });
  dockLayoutOverlay.innerHTML = dockOverlayMarkup();
}

function auxiliaryMarkup(layer: ViewerLayer): string {
  const common = `data-aux-key="${escapeHtml(auxiliaryViewKey(layer))}" data-aux-layer="${layer.id}"`;
  const resize = '<span class="aux-resize-handle" data-aux-resize aria-hidden="true"></span>';
  if (layer.kind === "image") return `<section class="aux-window" ${common}><header><i style="background:${layerColor(layer)}"></i><strong>${escapeHtml(layer.topic.name)}</strong><span data-aux-status>WAITING</span></header><canvas aria-label="Image display for ${escapeHtml(layer.topic.name)}"></canvas>${resize}</section>`;
  if (layer.kind === "numeric-plot") {
    const series = numericPlotSeries(layer);
    const legend = series.map((item) => `<span data-plot-series="${item.id}" title="${escapeHtml(item.fieldPath ?? "data")}"><i style="background:${layerColor(item)}"></i><b>${escapeHtml(item.fieldPath ?? "data")}</b><output data-plot-series-value="${item.id}">—</output></span>`).join("");
    return `<section class="aux-window plot-window" ${common} data-series-count="${series.length}"><header><i style="background:${layerColor(layer)}"></i><strong>${escapeHtml(layer.topic.name)}</strong><span data-aux-status>${series.length} SERIES</span><button type="button" data-add-plot-series title="Add another field to this graph">+ FIELD</button><button type="button" data-clear-plot title="Clear plot history">CLEAR</button></header><div class="plot-series-legend">${legend}</div><canvas aria-label="Numeric plot for ${escapeHtml(layer.topic.name)}"></canvas>${resize}</section>`;
  }
  if (layer.kind === "camera-info") return `<section class="aux-window info-window" ${common}><header><i style="background:${layerColor(layer)}"></i><strong>${escapeHtml(layer.topic.name)}</strong><span>CAMERA INFO</span></header><dl><div><dt>SIZE</dt><dd data-camera-value="size">—</dd></div><div><dt>MODEL</dt><dd data-camera-value="model">—</dd></div><div><dt>CALIBRATED</dt><dd data-camera-value="calibrated">—</dd></div></dl>${resize}</section>`;
  return `<section class="aux-window raw-window" ${common}><header><i style="background:${layerColor(layer)}"></i><strong>${escapeHtml(layer.topic.name)}</strong><span data-aux-status>WAITING</span></header><div class="raw-field-actions" data-raw-actions></div><pre class="raw-metadata" data-raw-metadata>Waiting for message metadata…</pre><pre class="raw-structured" data-raw-structured>Waiting for decoded message…</pre>${resize}</section>`;
}

function renderAuxiliary(): void {
  const auxiliary = orderedAuxiliaryLayers();
  const signature = auxiliaryStructureSignature(auxiliary);
  if (signature !== auxiliarySignature) {
    auxiliarySignature = signature;
    auxDock.innerHTML = auxiliary.map(auxiliaryMarkup).join("");
  }
  for (const layer of auxiliary) {
    const windowElement = auxDock.querySelector<HTMLElement>(`[data-aux-key="${auxiliaryViewKey(layer)}"]`);
    if (!windowElement) continue;
    const runtimeState = layerRuntime.get(layer.id);
    const plotSeries = layer.kind === "numeric-plot" ? numericPlotSeries(layer) : [];
    if (layer.kind === "numeric-plot") {
      windowElement.dataset.sampleCount = String(Math.max(0, ...plotSeries.map((series) => layerRuntime.get(series.id)?.numericHistory?.length ?? 0)));
      windowElement.dataset.seriesCount = String(plotSeries.length);
      for (const series of plotSeries) {
        const value = windowElement.querySelector<HTMLOutputElement>(`[data-plot-series-value="${series.id}"]`);
        if (value) value.textContent = layerRuntime.get(series.id)?.numericHistory?.at(-1)?.value.toPrecision(5) ?? "—";
      }
    }
    const status = windowElement.querySelector<HTMLElement>("[data-aux-status]");
    if (status) status.textContent = layer.kind === "image" && runtimeState?.raster
      ? `${runtimeState.raster.width}×${runtimeState.raster.height}`
      : layer.kind === "numeric-plot"
        ? `${plotSeries.length} SERIES`
        : runtimeState?.payloadBytes === undefined ? layer.status.toLocaleUpperCase() : `${formatBytes(runtimeState.payloadBytes)} decoded`;
    if (layer.kind === "raw" || layer.kind === "raw-inspector") {
      const metadata = windowElement.querySelector<HTMLElement>("[data-raw-metadata]");
      const structured = windowElement.querySelector<HTMLElement>("[data-raw-structured]");
      if (metadata) metadata.textContent = runtimeState?.rawMetadata ?? "Waiting for message metadata…";
      if (structured) structured.textContent = runtimeState?.rawStructured ?? "Structured decoding is unavailable because this topic has no usable message schema.";
      const fields = runtimeState?.numericFields?.slice(0, 64) ?? [];
      const actions = windowElement.querySelector<HTMLElement>("[data-raw-actions]");
      const fieldSignature = fields.map(({ path }) => path).join("|");
      if (actions && actions.dataset.fields !== fieldSignature) {
        actions.dataset.fields = fieldSignature;
        actions.innerHTML = fields.length
          ? fields.map(({ path }) => `<button type="button" data-plot-field="${escapeHtml(path)}">PLOT ${escapeHtml(path)}</button>`).join("")
          : '<span>No finite numeric fields in this message.</span>';
      }
      continue;
    }
    if (layer.kind === "camera-info") {
      const details = layer.summary?.details;
      const set = (key: string, value: string) => { const target = windowElement.querySelector<HTMLElement>(`[data-camera-value="${key}"]`); if (target) target.textContent = value; };
      set("size", details ? `${details.width} × ${details.height}` : "—");
      set("model", String(details?.distortionModel ?? "—"));
      set("calibrated", details?.calibrated === true ? "YES" : "NO");
      continue;
    }
  }
  drawScene();
}

function resizeCanvasBackingStore(target: HTMLCanvasElement, scale: number): void {
  const width = Math.max(1, Math.floor(target.clientWidth * scale));
  const height = Math.max(1, Math.floor(target.clientHeight * scale));
  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;
}

function paintAuxiliaryCanvases(): void {
  for (const layer of orderedAuxiliaryLayers()) {
    if (layer.kind !== "numeric-plot" && layer.kind !== "image") continue;
    const target = auxDock.querySelector<HTMLCanvasElement>(`[data-aux-key="${auxiliaryViewKey(layer)}"] canvas`);
    if (!target) continue;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    resizeCanvasBackingStore(target, scale);
    const context = target.getContext("2d", { alpha: false });
    if (!context) continue;
    context.fillStyle = "#08080a";
    context.fillRect(0, 0, target.width, target.height);
    if (layer.kind === "numeric-plot") {
      const series = numericPlotSeries(layer).map((item) => ({
        layer: item,
        samples: layerRuntime.get(item.id)?.numericHistory ?? [],
      })).filter(({ samples }) => samples.length > 0);
      if (series.length < 1) continue;
      const allSamples = series.flatMap(({ samples }) => samples);
      const values = allSamples.map(({ value }) => value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const span = Math.max(max - min, 1e-9);
      const left = 48 * scale;
      const right = target.width - 8 * scale;
      const top = 10 * scale;
      const bottom = target.height - 22 * scale;
      context.font = `${9 * scale}px ui-monospace, monospace`;
      context.textBaseline = "middle";
      context.fillStyle = "#777780";
      context.strokeStyle = "#292930";
      context.lineWidth = 1;
      for (let tick = 0; tick <= 4; tick += 1) {
        const ratio = tick / 4;
        const y = bottom - ratio * (bottom - top);
        context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
        context.fillText((min + span * ratio).toPrecision(4), 5 * scale, y);
      }
      const firstTime = allSamples.reduce((earliest, sample) => sample.timeNanos < earliest ? sample.timeNanos : earliest, allSamples[0]!.timeNanos);
      const lastTime = allSamples.reduce((latest, sample) => sample.timeNanos > latest ? sample.timeNanos : latest, allSamples[0]!.timeNanos);
      const timeSpan = lastTime > firstTime ? lastTime - firstTime : 1n;
      context.textBaseline = "alphabetic";
      context.fillText("0.000s", left, target.height - 5 * scale);
      context.textAlign = "right";
      context.fillText(`${(Number(timeSpan) / 1e9).toFixed(3)}s`, right, target.height - 5 * scale);
      context.textAlign = "left";
      context.lineWidth = Math.max(1, scale);
      for (const item of series) {
        context.strokeStyle = layerColor(item.layer);
        context.beginPath();
        item.samples.forEach(({ value, timeNanos }, index) => {
          const x = firstTime === lastTime ? (left + right) / 2 : left + Number(timeNanos - firstTime) / Number(timeSpan) * (right - left);
          const y = bottom - ((value - min) / span * (bottom - top));
          if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        });
        context.stroke();
        if (item.samples.length === 1) {
          const only = item.samples[0]!;
          context.fillStyle = layerColor(item.layer);
          context.beginPath();
          context.arc((left + right) / 2, bottom - ((only.value - min) / span * (bottom - top)), 2.5 * scale, 0, Math.PI * 2);
          context.fill();
        }
      }
      continue;
    }
    const raster = layerRuntime.get(layer.id)?.raster;
    if (!raster) continue;
    const fit = Math.min(target.width / raster.width, target.height / raster.height);
    const width = raster.width * fit;
    const height = raster.height * fit;
    context.imageSmoothingEnabled = true;
    context.drawImage(raster.source, (target.width - width) / 2, (target.height - height) / 2, width, height);
  }
}

function updateLayerChrome(): void {
  for (const layer of layers.layers) {
    const row = layerList.querySelector<HTMLElement>(`[data-layer="${layer.id}"]`);
    const status = row?.querySelector<HTMLElement>("[data-layer-status]");
    if (status) status.textContent = `${displayLabel(layer.kind)} · ${layer.status.toLocaleUpperCase()}`;
  }
}

function updateInspectorChrome(): void {
  const layer = layers.selected;
  if (!layer) return;
  const runtimeState = layerRuntime.get(layer.id);
  const summary = layer.summary;
  const values: Readonly<Record<string, string>> = {
    status: layer.status.toLocaleUpperCase(),
    time: `${layer.messageTimeNanos?.toString() ?? "—"} ns`,
    frame: summary?.frameId || "—",
    payload: runtimeState?.payloadBytes === undefined ? "—" : formatBytes(runtimeState.payloadBytes),
    input: summary?.inputVertices.toLocaleString() ?? "—",
    rendered: summary?.renderedVertices.toLocaleString() ?? "—",
    quality: summary && summary.droppedVertices > 0 ? `${summary.droppedVertices.toLocaleString()} DROPPED` : "FULL DATA",
  };
  for (const [key, value] of Object.entries(values)) {
    const target = inspector.querySelector<HTMLElement>(`[data-inspector-value="${key}"]`);
    if (target) target.textContent = value;
  }
  const quality = inspector.querySelector<HTMLElement>('[data-inspector-value="quality"]');
  quality?.classList.toggle("quality-loss", Boolean(summary?.droppedVertices));
  quality?.classList.toggle("quality-full", !summary?.droppedVertices);
  const error = inspector.querySelector<HTMLElement>("[data-inspector-error]");
  if (error) { error.hidden = !layer.error; error.classList.toggle("layer-error", Boolean(layer.error)); error.textContent = layer.error ?? ""; }
}

function renderChrome(rebuildStructure = true): void {
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
  if (rebuildStructure) {
    renderTopics();
    renderLayers();
    renderInspector();
  } else {
    updateLayerChrome();
    updateInspectorChrome();
  }
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
      ...(fixedFrame && liveTfBuffer && liveTfEpoch === epoch && liveTfTransformCount > 0
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
    ...(fixedFrame && transformCount > 0 ? { resolver: new HistoricalFrameResolver(fixedFrame, epoch, buffer) } : {}),
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
      for (const layer of visible) if (layer.status !== "ready") layers.update(layer.id, { status: "loading" });
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
      renderChrome(false);
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
    if (visualFrameDeferred) {
      visualFrameDeferred = false;
      drawScene();
    }
  } })();
  return renderCompletion;
}

async function hydrateNumericPlotHistory(layer: ViewerLayer): Promise<void> {
  if (controller.state.sourceMode === "live" || layer.kind !== "numeric-plot" || !layer.fieldPath) return;
  const epoch = controller.state.epoch;
  const windowResult = await runtime.messagesAround(layer.topic.name, controller.state.currentTimeNanos);
  if (epoch !== controller.state.epoch || !layers.layers.some(({ id }) => id === layer.id)) return;
  const ordered = [...windowResult.samples].sort((left, right) => left.logTimeNanos < right.logTimeNanos ? -1 : left.logTimeNanos > right.logTimeNanos ? 1 : 0);
  const reference = await runtime.messageAt(layer.topic.name, controller.state.currentTimeNanos);
  const pivot = Math.max(0, ordered.findIndex(({ logTimeNanos }) => logTimeNanos >= reference.logTimeNanos));
  const start = Math.max(0, Math.min(ordered.length - 2_048, pivot - 1_024));
  const contiguous = ordered.slice(start, start + 2_048);
  const history: { readonly timeNanos: bigint; readonly value: number }[] = [];
  for (let offset = 0; offset < contiguous.length; offset += 64) {
    const batch = contiguous.slice(offset, offset + 64);
    const decoded = await Promise.all(batch.map(async (sample) => {
      let value: number | undefined;
      try {
        const generic = await plotHistoryDecoder.generic(genericDecodeInput(sample));
        value = numericValueAtPath(generic.value, layer.fieldPath!);
      } catch {
        const semantic = await plotHistoryDecoder.semantic(sample);
        value = numericValueAtPath(semantic.message, layer.fieldPath!);
      }
      return value === undefined ? undefined : { timeNanos: sample.logTimeNanos, value };
    }));
    history.push(...decoded.filter((entry): entry is { readonly timeNanos: bigint; readonly value: number } => entry !== undefined));
    if (epoch !== controller.state.epoch || !layers.layers.some(({ id }) => id === layer.id)) return;
  }
  const runtimeState = layerRuntime.get(layer.id);
  if (runtimeState) runtimeState.numericHistory = history;
  renderAuxiliary();
}

async function sampleForTopic(topic: TopicSummary): Promise<BrowserSample> {
  if (controller.state.sourceMode === "live") {
    const sample = liveSamples.get(topic.id);
    if (!sample) throw new Error("Waiting for the first live message on this topic.");
    return sample;
  }
  return runtime.messageAt(topic.name, controller.state.currentTimeNanos);
}

async function openPlotFieldPicker(topic: TopicSummary, targetPlotGroupId?: string): Promise<void> {
  if (plotFieldPicker?.topicId === topic.id && plotFieldPicker.targetPlotGroupId === targetPlotGroupId) {
    plotFieldPicker = undefined;
    renderTopics();
    return;
  }
  plotFieldPicker = { topicId: topic.id, ...(targetPlotGroupId ? { targetPlotGroupId } : {}), fields: [], status: "loading" };
  renderTopics();
  try {
    const sample = await sampleForTopic(topic);
    let fields: readonly { readonly path: string; readonly value: number }[];
    try {
      const decoded = await plotFieldDecoder.generic(genericDecodeInput(sample));
      fields = decoded.numericFields;
    } catch {
      fields = collectNumericFields((await plotFieldDecoder.semantic(sample)).message);
    }
    if (plotFieldPicker?.topicId !== topic.id || plotFieldPicker.targetPlotGroupId !== targetPlotGroupId) return;
    plotFieldPicker = { topicId: topic.id, ...(targetPlotGroupId ? { targetPlotGroupId } : {}), fields, status: "ready" };
  } catch (error) {
    if (plotFieldPicker?.topicId !== topic.id || plotFieldPicker.targetPlotGroupId !== targetPlotGroupId) return;
    plotFieldPicker = { topicId: topic.id, ...(targetPlotGroupId ? { targetPlotGroupId } : {}), fields: [], status: "error", error: error instanceof Error ? error.message : String(error) };
  }
  renderTopics();
}

function addLayer(topic: TopicSummary, kind: DisplayKind, fieldPath?: string, plotGroupId?: string): ViewerLayer {
  const layer = layers.add(topic, kind, fieldPath, kind === "numeric-plot" ? plotGroupId ?? layers.createPlotGroupId() : undefined);
  ensureLayerDisplay(layer);
  renderChrome();
  let initialRender = Promise.resolve();
  if (controller.state.sourceMode === "live") {
    void syncLiveSubscriptions();
  } else initialRender = renderSceneAtCurrentTime(true);
  if (kind === "numeric-plot" && fieldPath) void initialRender.then(() => hydrateNumericPlotHistory(layer)).catch((error) => {
    if (layers.layers.some(({ id }) => id === layer.id)) layers.update(layer.id, { status: "error", error: `Plot history could not be decoded: ${error instanceof Error ? error.message : String(error)}` });
    renderChrome(false);
  });
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
    const topic = controller.state.topics.find((candidate) => candidate.messageCount !== 0n
      && candidate.availableDisplays.includes(kind)
      && (kind !== "numeric-plot" || /^std_msgs\/(?:msg\/)?(?:Float32|Float64|Int32|UInt32)$/u.test(candidate.typeName)));
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

function clearNumericPlotHistories(plotGroupId?: string): void {
  for (const layer of layers.layers) {
    if (layer.kind !== "numeric-plot" || (plotGroupId && layer.plotGroupId !== plotGroupId)) continue;
    const runtimeState = layerRuntime.get(layer.id);
    if (runtimeState) runtimeState.numericHistory = [];
  }
  renderAuxiliary();
}

async function seekTo(requested: bigint): Promise<void> {
  clearNumericPlotHistories();
  await controller.seek(requested);
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
  if ((event.target as HTMLElement).closest("[data-close-plot-picker]")) {
    plotFieldPicker = undefined;
    renderTopics();
    return;
  }
  const fieldButton = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-add-plot-field]");
  if (fieldButton && plotFieldPicker) {
    const topic = controller.state.topics.find(({ id }) => id === plotFieldPicker?.topicId);
    const fieldPath = fieldButton.dataset.addPlotField;
    if (topic && fieldPath) addLayer(topic, "numeric-plot", fieldPath, plotFieldPicker.targetPlotGroupId);
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-topic][data-kind]");
  if (!button) return;
  const topic = controller.state.topics.find(({ id }) => id === button.dataset.topic);
  const kind = button.dataset.kind as DisplayKind | undefined;
  if (!topic || !kind) return;
  if (kind === "numeric-plot") void openPlotFieldPicker(topic);
  else addLayer(topic, kind);
});

topicList.addEventListener("input", (event) => {
  const filter = (event.target as HTMLElement).closest<HTMLInputElement>("input[data-plot-field-filter]");
  const list = filter?.closest<HTMLElement>("[data-plot-picker]")?.querySelector<HTMLElement>(".plot-field-list");
  if (filter && list && plotFieldPicker?.status === "ready") list.innerHTML = plotFieldRows(plotFieldPicker.fields, filter.value);
});

auxDock.addEventListener("click", (event) => {
  const clearButton = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-clear-plot]");
  const clearWindow = clearButton?.closest<HTMLElement>("[data-aux-layer]");
  const clearAnchor = layers.layers.find(({ id }) => id === clearWindow?.dataset.auxLayer);
  if (clearButton && clearAnchor?.kind === "numeric-plot") {
    clearNumericPlotHistories(clearAnchor.plotGroupId);
    return;
  }
  const addSeriesButton = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-add-plot-series]");
  const addSeriesWindow = addSeriesButton?.closest<HTMLElement>("[data-aux-layer]");
  const addSeriesAnchor = layers.layers.find(({ id }) => id === addSeriesWindow?.dataset.auxLayer);
  if (addSeriesButton && addSeriesAnchor?.kind === "numeric-plot" && addSeriesAnchor.plotGroupId) {
    void openPlotFieldPicker(addSeriesAnchor.topic, addSeriesAnchor.plotGroupId);
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-plot-field]");
  const windowElement = button?.closest<HTMLElement>("[data-aux-layer]");
  if (!button || !windowElement) return;
  const rawLayer = layers.layers.find(({ id }) => id === windowElement.dataset.auxLayer);
  const fieldPath = button.dataset.plotField;
  if (rawLayer && fieldPath) addLayer(rawLayer.topic, "numeric-plot", fieldPath);
});

let auxiliaryResize: {
  readonly element: HTMLElement;
  readonly key: string;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly width: number;
  readonly height: number;
} | undefined;

auxDock.addEventListener("pointerdown", (event) => {
  const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-aux-resize]");
  const element = handle?.closest<HTMLElement>("[data-aux-key]");
  const key = element?.dataset.auxKey;
  if (!handle || !element || !key || event.button !== 0 || element.classList.contains("is-docked")) return;
  const size = { width: element.offsetWidth, height: element.offsetHeight };
  auxiliarySizes.set(key, size);
  auxiliaryResize = { element, key, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, ...size };
  try { handle.setPointerCapture(event.pointerId); } catch { /* Synthetic test events have no active native pointer. */ }
  element.classList.add("is-resizing");
  event.preventDefault();
  event.stopPropagation();
});

auxDock.addEventListener("pointermove", (event) => {
  if (!auxiliaryResize || auxiliaryResize.pointerId !== event.pointerId) return;
  const position = auxiliaryPositions.get(auxiliaryResize.key) ?? { x: 0, y: 38 };
  const width = Math.min(scenePanel.clientWidth - position.x, Math.max(220, auxiliaryResize.width + event.clientX - auxiliaryResize.startX));
  const height = Math.min(scenePanel.clientHeight - position.y - 22, Math.max(120, auxiliaryResize.height + event.clientY - auxiliaryResize.startY));
  auxiliarySizes.set(auxiliaryResize.key, { width, height });
  auxiliaryResize.element.style.width = `${width}px`;
  auxiliaryResize.element.style.height = `${height}px`;
  drawScene();
});

const finishAuxiliaryResize = (event: PointerEvent): void => {
  if (!auxiliaryResize || auxiliaryResize.pointerId !== event.pointerId) return;
  auxiliaryResize.element.classList.remove("is-resizing");
  auxiliaryResize = undefined;
};
auxDock.addEventListener("pointerup", finishAuxiliaryResize);
auxDock.addEventListener("pointercancel", finishAuxiliaryResize);

let auxiliaryDrag: {
  readonly element: HTMLElement;
  readonly key: string;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly pointerId: number;
} | undefined;

function dockTargetAt(clientX: number, clientY: number, excludedKey: string): typeof dockDropTarget {
  const panel = scenePanel.getBoundingClientRect();
  const x = clientX - panel.left;
  const y = clientY - panel.top;
  for (const [paneKey, rect] of dockPaneRects) {
    if (paneKey === excludedKey || x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) continue;
    const distances = [
      ["left", x - rect.x], ["right", rect.x + rect.width - x],
      ["top", y - rect.y], ["bottom", rect.y + rect.height - y],
    ] as const;
    const [edge, edgeDistance] = [...distances].sort((left, right) => left[1] - right[1])[0]!;
    const edgeSpan = edge === "left" || edge === "right" ? rect.width : rect.height;
    if (edgeDistance > Math.min(64, edgeSpan * 0.18)) return undefined;
    const divider = 5;
    if (edge === "left" || edge === "right") {
      const firstWidth = Math.max(1, Math.round((rect.width - divider) / 2));
      const left = { ...rect, width: firstWidth };
      const right = { x: rect.x + firstWidth + divider, y: rect.y, width: Math.max(1, rect.width - firstWidth - divider), height: rect.height };
      return { paneKey, edge, incoming: edge === "left" ? left : right, remaining: edge === "left" ? right : left };
    }
    const firstHeight = Math.max(1, Math.round((rect.height - divider) / 2));
    const top = { ...rect, height: firstHeight };
    const bottom = { x: rect.x, y: rect.y + firstHeight + divider, width: rect.width, height: Math.max(1, rect.height - firstHeight - divider) };
    return { paneKey, edge, incoming: edge === "top" ? top : bottom, remaining: edge === "top" ? bottom : top };
  }
  return undefined;
}

auxDock.addEventListener("pointerdown", (event) => {
  const header = (event.target as HTMLElement).closest<HTMLElement>(".aux-window > header");
  const element = header?.closest<HTMLElement>("[data-aux-key]");
  const key = element?.dataset.auxKey;
  if (!header || !element || !key || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
  const panel = scenePanel.getBoundingClientRect();
  const dockRect = dockPaneRects.get(key);
  if (dockRect) {
    dockRoot = removeDockPane(dockRoot, key) ?? { kind: "pane", key: "scene" };
    auxiliaryPositions.set(key, { x: dockRect.x, y: dockRect.y });
    auxiliarySizes.set(key, { width: dockRect.width, height: dockRect.height });
    layoutAuxiliaryWindows();
  }
  auxiliaryOrder = [...auxiliaryOrder.filter((candidate) => candidate !== key), key];
  auxDock.append(element);
  const position = auxiliaryPosition(key, orderedAuxiliaryLayers().findIndex((layer) => auxiliaryViewKey(layer) === key), element);
  auxiliaryDrag = { element, key, offsetX: event.clientX - panel.left - position.x, offsetY: event.clientY - panel.top - position.y, pointerId: event.pointerId };
  try { header.setPointerCapture(event.pointerId); } catch { /* Synthetic test events have no active native pointer. */ }
  element.classList.add("is-dragging");
  event.preventDefault();
});

auxDock.addEventListener("pointermove", (event) => {
  if (!auxiliaryDrag || auxiliaryDrag.pointerId !== event.pointerId) return;
  const panel = scenePanel.getBoundingClientRect();
  const x = Math.max(0, Math.min(event.clientX - panel.left - auxiliaryDrag.offsetX, scenePanel.clientWidth - auxiliaryDrag.element.offsetWidth));
  const y = Math.max(38, Math.min(event.clientY - panel.top - auxiliaryDrag.offsetY, scenePanel.clientHeight - auxiliaryDrag.element.offsetHeight - 22));
  auxiliaryPositions.set(auxiliaryDrag.key, { x, y });
  auxiliaryDrag.element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  dockDropTarget = dockTargetAt(event.clientX, event.clientY, auxiliaryDrag.key);
  dockLayoutOverlay.innerHTML = dockOverlayMarkup();
});

const finishAuxiliaryDrag = (event: PointerEvent): void => {
  if (!auxiliaryDrag || auxiliaryDrag.pointerId !== event.pointerId) return;
  if (dockDropTarget) dockView(auxiliaryDrag.key, dockDropTarget.paneKey, dockDropTarget.edge);
  auxiliaryDrag.element.classList.remove("is-dragging");
  dockDropTarget = undefined;
  auxiliaryDrag = undefined;
  layoutAuxiliaryWindows();
  drawScene();
};
auxDock.addEventListener("pointerup", finishAuxiliaryDrag);
auxDock.addEventListener("pointercancel", finishAuxiliaryDrag);

layerList.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-layer-action]");
  const row = button?.closest<HTMLElement>("[data-layer]");
  if (!button || !row) return;
  const id = row.dataset.layer!;
  if (button.dataset.layerAction === "select") layers.select(id);
  if (button.dataset.layerAction === "select") {
    renderLayers();
    renderInspector();
    drawScene();
    return;
  }
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

layerList.addEventListener("dragstart", (event) => {
  const handle = (event.target as HTMLElement).closest(".layer-drag-handle");
  const row = handle?.closest<HTMLElement>("[data-layer]");
  if (!handle || !row?.dataset.layer || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData("text/x-ros-viewer-layer", row.dataset.layer);
  event.dataTransfer.effectAllowed = "move";
  row.classList.add("is-dragging");
});
layerList.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("text/x-ros-viewer-layer")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  layerList.querySelectorAll(".is-drop-before, .is-drop-after").forEach((element) => element.classList.remove("is-drop-before", "is-drop-after"));
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-layer]");
  if (target) target.classList.add(event.clientY < target.getBoundingClientRect().top + target.offsetHeight / 2 ? "is-drop-before" : "is-drop-after");
});
layerList.addEventListener("dragleave", (event) => (event.target as HTMLElement).closest<HTMLElement>("[data-layer]")?.classList.remove("is-drop-before", "is-drop-after"));
layerList.addEventListener("drop", (event) => {
  const movedId = event.dataTransfer?.getData("text/x-ros-viewer-layer");
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-layer]");
  const targetId = target?.dataset.layer;
  if (!movedId || !target || !targetId || movedId === targetId) return;
  event.preventDefault();
  const order = layers.layers.map(({ id }) => id).filter((id) => id !== movedId);
  const targetRect = target.getBoundingClientRect();
  const insertAt = order.indexOf(targetId) + (event.clientY > targetRect.top + targetRect.height / 2 ? 1 : 0);
  layers.moveTo(movedId, insertAt);
  renderLayers();
  drawScene();
});
layerList.addEventListener("dragend", () => {
  layerList.querySelectorAll(".is-dragging, .is-drop-before, .is-drop-after").forEach((element) => element.classList.remove("is-dragging", "is-drop-before", "is-drop-after"));
});
layerList.addEventListener("keydown", (event) => {
  const handle = (event.target as HTMLElement).closest<HTMLElement>(".layer-drag-handle");
  const row = handle?.closest<HTMLElement>("[data-layer]");
  if (!handle || !row?.dataset.layer || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const current = layers.layers.findIndex(({ id }) => id === row.dataset.layer);
  const target = event.key === "Home" ? 0 : event.key === "End" ? layers.layers.length - 1 : current + (event.key === "ArrowUp" ? -1 : 1);
  layers.moveTo(row.dataset.layer, target);
  renderLayers();
  layerList.querySelector<HTMLElement>(`[data-layer="${row.dataset.layer}"] .layer-drag-handle`)?.focus();
  drawScene();
});

inspector.addEventListener("change", (event) => {
  const pointSize = (event.target as HTMLElement).closest<HTMLInputElement>("input[data-point-size]");
  const colorMode = (event.target as HTMLElement).closest<HTMLSelectElement>("select[data-point-color-mode]");
  const colorAxis = (event.target as HTMLElement).closest<HTMLSelectElement>("select[data-point-axis]");
  if (pointSize || colorMode || colorAxis) {
    const id = pointSize?.dataset.pointSize ?? colorMode?.dataset.pointColorMode ?? colorAxis?.dataset.pointAxis;
    if (!id) return;
    layers.setPointCloudStyle(id, {
      ...(pointSize ? { pointSize: Number(pointSize.value) } : {}),
      ...(colorMode ? { pointCloudColorMode: colorMode.value as "axis" | "intensity" | "rgb" | "uniform" } : {}),
      ...(colorAxis ? { pointCloudColorAxis: colorAxis.value as "x" | "y" | "z" } : {}),
    });
    renderChrome();
    void renderSceneAtCurrentTime();
    return;
  }
  const inputElement = (event.target as HTMLElement).closest<HTMLInputElement>("input[data-layer-color]");
  if (!inputElement) return;
  const match = inputElement.value.match(/^#([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/iu);
  if (!match) return;
  const color = [Number.parseInt(match[1]!, 16) / 255, Number.parseInt(match[2]!, 16) / 255, Number.parseInt(match[3]!, 16) / 255, 1] as const;
  const id = inputElement.dataset.layerColor!;
  layers.setColor(id, color);
  const layer = layers.layers.find((candidate) => candidate.id === id);
  if (!layer) return;
  if (layerRuntime.get(id)?.display instanceof PointCloud2Display) {
    renderChrome();
    void renderSceneAtCurrentTime();
    return;
  }
  const runtimeState = layerRuntime.get(id);
  runtimeState?.lifecycle?.dispose();
  runtimeState?.raster?.close?.();
  layerRuntime.delete(id);
  ensureLayerDisplay(layer);
  renderChrome();
  void renderSceneAtCurrentTime();
});

inspector.addEventListener("input", (event) => {
  const range = (event.target as HTMLElement).closest<HTMLInputElement>("input[data-point-size]");
  if (range) range.parentElement?.querySelector("output")?.replaceChildren(`${range.value}px`);
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
document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (event.code !== "Space" || event.repeat || document.querySelector("dialog[open]")
    || target?.matches("input, select, textarea, button, [contenteditable='true']")) return;
  event.preventDefault();
  if (playing) stopPlayback(); else startPlayback();
});

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
  fixedFrame = next;
  inputElement.value = next;
  rebuildLayerRuntimes();
  renderChrome();
  void renderSceneAtCurrentTime(true);
});

byId<HTMLButtonElement>("pivot-toggle").addEventListener("click", (event) => {
  pivotVisible = !pivotVisible;
  (event.currentTarget as HTMLButtonElement).setAttribute("aria-pressed", String(pivotVisible));
  drawScene();
});

byId<HTMLButtonElement>("reset-window-layout").addEventListener("click", () => {
  dockRoot = { kind: "pane", key: "scene" };
  dockDropTarget = undefined;
  activeDockSplitId = undefined;
  renderAuxiliary();
  drawScene();
});

let dockSplitterDrag: {
  readonly id: string;
  readonly axis: "x" | "y";
  readonly pointerId: number;
  readonly startClient: number;
  readonly startRatio: number;
  readonly length: number;
} | undefined;
dockLayoutOverlay.addEventListener("pointerdown", (event) => {
  const splitter = (event.target as HTMLElement).closest<HTMLElement>("[data-dock-split]");
  const id = splitter?.dataset.dockSplit;
  const parent = id ? dockSplitParents.get(id) : undefined;
  const ratio = id ? dockSplitRatio(dockRoot, id) : undefined;
  if (!splitter || !id || !parent || ratio === undefined || event.button !== 0) return;
  dockSplitterDrag = { id, axis: parent.axis, pointerId: event.pointerId, startClient: parent.axis === "x" ? event.clientX : event.clientY, startRatio: ratio, length: parent.length };
  activeDockSplitId = id;
  try { dockLayoutOverlay.setPointerCapture(event.pointerId); } catch { /* Synthetic test events have no active native pointer. */ }
  event.preventDefault();
  drawScene();
});
dockLayoutOverlay.addEventListener("pointermove", (event) => {
  if (!dockSplitterDrag || dockSplitterDrag.pointerId !== event.pointerId) return;
  const current = dockSplitterDrag.axis === "x" ? event.clientX : event.clientY;
  dockRoot = setDockSplitRatio(dockRoot, dockSplitterDrag.id, dockSplitterDrag.startRatio + (current - dockSplitterDrag.startClient) / dockSplitterDrag.length);
  drawScene();
});
const finishDockSplitterDrag = (event: PointerEvent): void => {
  if (dockSplitterDrag?.pointerId !== event.pointerId) return;
  dockSplitterDrag = undefined;
  activeDockSplitId = undefined;
  drawScene();
};
dockLayoutOverlay.addEventListener("pointerup", finishDockSplitterDrag);
dockLayoutOverlay.addEventListener("pointercancel", finishDockSplitterDrag);
dockLayoutOverlay.addEventListener("keydown", (event) => {
  const splitter = (event.target as HTMLElement).closest<HTMLElement>("[data-dock-split]");
  const id = splitter?.dataset.dockSplit;
  const axis = splitter?.dataset.axis;
  const relevant = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  if (!id || !relevant.includes(event.key)) return;
  const ratio = dockSplitRatio(dockRoot, id);
  if (ratio === undefined) return;
  const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
  dockRoot = setDockSplitRatio(dockRoot, id, ratio + direction * 0.02);
  event.preventDefault();
  drawScene();
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

new ResizeObserver(() => drawScene()).observe(scenePanel);
renderChrome();
drawScene();
