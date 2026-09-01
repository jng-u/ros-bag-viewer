import { ImageDisplay, PathDisplay, PointCloud2Display, type SemanticSceneSummary } from "@ros-web-viewer/displays-core";
import { decodeSemanticMessage } from "@ros-web-viewer/m1-integration";
import { WebGl2Renderer } from "@ros-web-viewer/render-core";

import { BrowserRecordingRuntime, detectBrowserSourceFormat, localFileVersion } from "./browser-runtime.js";
import { rawImageToRgba } from "./image-raster.js";
import { formatRawPreview } from "./raw-preview.js";
import { DesktopShellController, type DisplayKind, type TopicSummary } from "./shell.js";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Application root is missing");

app.innerHTML = `
  <div class="viewer-shell" data-phase="empty">
    <header class="topbar">
      <div class="wordmark" aria-label="ROS Web Viewer">
        <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M6 22.5 16 5l10 17.5M9.5 17h13M12.5 22.5h7"/></svg>
        <span>ROS WEB VIEWER</span>
      </div>
      <div class="source-summary">
        <span class="source-name" id="source-name">NO SOURCE</span>
        <span class="mode-tag" id="mode-tag">READ ONLY</span>
      </div>
      <div class="topbar-actions">
        <button class="quiet-button" id="live-button" type="button" aria-describedby="live-note">LIVE RELAY</button>
        <span class="sr-only" id="live-note">Requires a separately configured authenticated relay.</span>
        <select class="demo-select" id="demo-kind" aria-label="Demo recording format">
          <option value="mcap">MCAP</option>
          <option value="ros1">ROS1 BAG</option>
          <option value="ros2">ROS2 BAG</option>
        </select>
        <button class="quiet-button" id="demo-button" type="button">LOAD DEMO</button>
        <label class="quiet-button" for="directory-input">OPEN ROS2 DIR</label>
        <label class="open-button" for="recording-input">OPEN RECORDING</label>
        <input id="recording-input" type="file" accept=".mcap,.bag,.db3,.yaml,.yml" multiple />
        <input id="directory-input" type="file" webkitdirectory multiple />
      </div>
    </header>

    <aside class="topics-panel" aria-label="Topic browser">
      <div class="panel-heading">
        <div><span class="panel-label">SOURCE CHANNELS</span><strong id="topic-count">0 TOPICS</strong></div>
        <span class="connection-dot" id="connection-dot" aria-hidden="true"></span>
      </div>
      <label class="search-field">
        <span class="sr-only">Filter topics</span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>
        <input id="topic-filter" type="search" placeholder="Filter topics or types" autocomplete="off" />
      </label>
      <div class="topic-list" id="topic-list">
        <div class="empty-list"><span>—</span><p>Drop MCAP, ROS1 bag,<br/>or a ROS2 bag folder.</p></div>
      </div>
    </aside>

    <main class="viewport-panel" aria-label="3D display workspace">
      <div class="viewport-toolbar">
        <div class="view-title"><span id="view-kind">3D</span><strong id="view-title">WORLD VIEW</strong></div>
        <div class="view-stats" id="view-stats"><span>WEBGL2</span><span>0 DRAW CALLS</span></div>
      </div>
      <div class="canvas-wrap" id="drop-zone">
        <canvas id="scene-canvas" aria-label="ROS scene visualization"></canvas>
        <canvas id="image-canvas" aria-label="ROS image visualization" hidden></canvas>
        <div class="axis-glyph" aria-hidden="true"><i class="axis-x">X</i><i class="axis-y">Y</i><i class="axis-z">Z</i></div>
        <div class="drop-prompt" id="drop-prompt">
          <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 10v29m0-29L21 21m11-11 11 11"/><path d="M13 38v11c0 3 2 5 5 5h28c3 0 5-2 5-5V38"/></svg>
          <strong>DROP ROS RECORDING</strong>
          <span>MCAP · ROS1 .bag · ROS2 metadata.yaml + .db3</span>
          <button id="drop-open-button" type="button">SELECT FILE</button>
        </div>
        <div class="canvas-message" id="canvas-message" role="status" aria-live="polite"></div>
      </div>
    </main>

    <aside class="inspector-panel" aria-label="Display inspector">
      <div class="panel-heading"><div><span class="panel-label">INSPECTOR</span><strong id="inspector-title">NO DISPLAY</strong></div></div>
      <div class="inspector-content" id="inspector-content">
        <p class="muted-copy">Choose a compatible display from the topic browser. PointCloud2 and Path render through the bounded WebGL2 lifecycle.</p>
      </div>
      <div class="resource-strip">
        <span>GPU BUDGET</span><meter id="gpu-meter" min="0" max="67108864" value="0"></meter><output id="gpu-output">0 B</output>
      </div>
    </aside>

    <footer class="timeline-panel" aria-label="Timeline">
      <button class="transport-button" id="play-button" type="button" aria-label="Play recording">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 4 9 6-9 6Z"/></svg>
      </button>
      <button class="transport-button" id="step-back" type="button" aria-label="Step backward">−</button>
      <div class="timeline-track">
        <input id="timeline-input" type="range" min="0" max="1000" value="0" aria-label="Seek recording" />
        <div class="timeline-meta"><output id="current-time">00:00.000</output><span id="timeline-state">NO INDEX</span><output id="duration-time">00:00.000</output></div>
      </div>
      <button class="transport-button" id="step-forward" type="button" aria-label="Step forward">+</button>
      <div class="epoch-readout"><span>EPOCH</span><strong id="epoch-value">0</strong></div>
    </footer>

    <div class="status-line" id="status-line" role="status" aria-live="polite">Ready. Recording bytes remain in your browser.</div>
  </div>
`;

const runtime = new BrowserRecordingRuntime();
const controller = new DesktopShellController({
  openLocalRecording: (selection) => runtime.open(selection),
  seek: (timeNanos) => runtime.seek(timeNanos),
});

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
};

const shell = document.querySelector<HTMLElement>(".viewer-shell")!;
const input = byId<HTMLInputElement>("recording-input");
const directoryInput = byId<HTMLInputElement>("directory-input");
const dropZone = byId<HTMLElement>("drop-zone");
const dropPrompt = byId<HTMLElement>("drop-prompt");
const canvas = byId<HTMLCanvasElement>("scene-canvas");
const imageCanvas = byId<HTMLCanvasElement>("image-canvas");
const axisGlyph = document.querySelector<HTMLElement>(".axis-glyph")!;
const topicList = byId<HTMLElement>("topic-list");
const inspector = byId<HTMLElement>("inspector-content");
const timeline = byId<HTMLInputElement>("timeline-input");
const statusLine = byId<HTMLElement>("status-line");
const canvasMessage = byId<HTMLElement>("canvas-message");
const playButton = byId<HTMLButtonElement>("play-button");

let renderer: WebGl2Renderer | undefined;
let activeDisplay: { dispose(): void } | undefined;
let activeTopic: TopicSummary | undefined;
let activeKind: DisplayKind | undefined;
let rendering = false;
let playing = false;
let playTimer: number | undefined;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatNanos(value: bigint): string {
  const totalMilliseconds = value / 1_000_000n;
  const minutes = totalMilliseconds / 60_000n;
  const seconds = (totalMilliseconds / 1_000n) % 60n;
  const milliseconds = totalMilliseconds % 1_000n;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${milliseconds.toString().padStart(3, "0")}`;
}

function displayLabel(kind: DisplayKind): string {
  return kind.replaceAll("-", " ").toLocaleUpperCase();
}

function resizeCanvas(): WebGL2RenderingContext {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(canvas.clientWidth * scale));
  const height = Math.max(1, Math.floor(canvas.clientHeight * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: true });
  if (!gl) throw new Error("WebGL2 is unavailable in this browser or GPU configuration.");
  gl.viewport(0, 0, width, height);
  gl.clearColor(0.015, 0.035, 0.043, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  return gl;
}

function showRasterSurface(enabled: boolean): void {
  canvas.hidden = enabled;
  imageCanvas.hidden = !enabled;
  axisGlyph.hidden = enabled;
}

function rasterCanvasContext(): CanvasRenderingContext2D {
  showRasterSurface(true);
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(dropZone.clientWidth * scale));
  const height = Math.max(1, Math.floor(dropZone.clientHeight * scale));
  if (imageCanvas.width !== width || imageCanvas.height !== height) {
    imageCanvas.width = width;
    imageCanvas.height = height;
  }
  const context = imageCanvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas2D is unavailable for image rendering.");
  context.fillStyle = "#020607";
  context.fillRect(0, 0, width, height);
  return context;
}

function drawRasterSource(source: CanvasImageSource, width: number, height: number, smoothing: boolean): void {
  const context = rasterCanvasContext();
  const scale = Math.min(imageCanvas.width / width, imageCanvas.height / height);
  const targetWidth = Math.max(1, Math.floor(width * scale));
  const targetHeight = Math.max(1, Math.floor(height * scale));
  const x = Math.floor((imageCanvas.width - targetWidth) / 2);
  const y = Math.floor((imageCanvas.height - targetHeight) / 2);
  context.imageSmoothingEnabled = smoothing;
  context.drawImage(source, x, y, targetWidth, targetHeight);
}

function compressedImageMime(format: string): string {
  const match = format.toLocaleLowerCase().match(/(?:^|[;\s])(jpe?g|png|webp)(?:\s|$)/u);
  const codec = match?.[1];
  if (codec === "jpg" || codec === "jpeg") return "image/jpeg";
  if (codec === "png") return "image/png";
  if (codec === "webp") return "image/webp";
  throw new Error(`unsupported compressed image codec: ${format}`);
}

async function drawDecodedImage(decoded: Extract<ReturnType<typeof decodeSemanticMessage>, { kind: "image" | "compressed-image" }>): Promise<{ width: number; height: number }> {
  if (decoded.kind === "image") {
    const source = document.createElement("canvas");
    source.width = decoded.message.width;
    source.height = decoded.message.height;
    const context = source.getContext("2d");
    if (!context) throw new Error("Canvas2D is unavailable for raw image conversion.");
    context.putImageData(new ImageData(new Uint8ClampedArray(rawImageToRgba(decoded.message)), decoded.message.width, decoded.message.height), 0, 0);
    drawRasterSource(source, decoded.message.width, decoded.message.height, false);
    return { width: decoded.message.width, height: decoded.message.height };
  }
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(decoded.message.data)], { type: compressedImageMime(decoded.message.format) }));
  try {
    const pixels = bitmap.width * bitmap.height;
    if (!Number.isSafeInteger(pixels) || pixels > 16_000_000) throw new Error("Compressed image pixel budget exceeded");
    drawRasterSource(bitmap, bitmap.width, bitmap.height, true);
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

function projectionFor(summary: SemanticSceneSummary): Float32Array {
  const bounds = summary.bounds;
  if (!bounds) return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const centerX = (bounds.min[0] + bounds.max[0]) / 2;
  const centerY = (bounds.min[1] + bounds.max[1]) / 2;
  const centerZ = (bounds.min[2] + bounds.max[2]) / 2;
  const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2], 0.001);
  const scale = 1.7 / span;
  return new Float32Array([
    scale, 0, 0, 0,
    0, scale, 0, 0,
    0, 0, scale, 0,
    -centerX * scale, -centerY * scale, -centerZ * scale, 1,
  ]);
}

function renderState(): void {
  const state = controller.state;
  shell.dataset.phase = state.phase;
  byId("source-name").textContent = (state.sourceLabel ?? "NO SOURCE").toLocaleUpperCase();
  byId("mode-tag").textContent = state.sourceMode === "live" ? "LIVE / READ ONLY" : "LOCAL / READ ONLY";
  byId("topic-count").textContent = `${state.topics.length} TOPIC${state.topics.length === 1 ? "" : "S"}`;
  byId("epoch-value").textContent = String(state.epoch);
  byId("current-time").textContent = formatNanos(state.currentTimeNanos);
  byId("duration-time").textContent = formatNanos(state.durationNanos);
  byId("timeline-state").textContent = state.indexState === "none" ? "NO INDEX" : state.indexState.toLocaleUpperCase();
  timeline.value = state.durationNanos === 0n ? "0" : String(Number((state.currentTimeNanos * 1000n) / state.durationNanos));
  timeline.disabled = state.durationNanos === 0n || state.phase === "loading";
  statusLine.textContent = state.blockingError ?? state.notice ?? "Ready.";
  statusLine.dataset.tone = state.blockingError ? "error" : state.phase === "degraded" ? "warning" : "normal";
  byId("connection-dot").classList.toggle("is-active", state.phase === "ready" || state.phase === "degraded");
  dropPrompt.hidden = state.phase !== "empty" && state.phase !== "error";

  const topics = controller.visibleTopics;
  topicList.innerHTML = topics.length === 0
    ? `<div class="empty-list"><span>—</span><p>${state.phase === "loading" ? "Reading indexes and schemas…" : "No matching topics."}</p></div>`
    : topics.map((topic) => {
        const actions = topic.availableDisplays.map((kind) => `<button type="button" data-topic="${escapeHtml(topic.id)}" data-kind="${kind}">${displayLabel(kind)}</button>`).join("");
        return `<article class="topic-row"><div><strong>${escapeHtml(topic.name)}</strong><span>${escapeHtml(topic.typeName)}</span></div><small>${topic.schemaCapability.replace("schema-", "")}</small><div class="topic-actions">${actions}</div></article>`;
      }).join("");
}

function showInspector(summary: SemanticSceneSummary, topic: TopicSummary): void {
  const bounds = summary.bounds;
  inspector.innerHTML = `
    <dl class="detail-list">
      <div><dt>TOPIC</dt><dd>${escapeHtml(topic.name)}</dd></div>
      <div><dt>TYPE</dt><dd>${escapeHtml(topic.typeName)}</dd></div>
      <div><dt>FRAME</dt><dd>${escapeHtml(summary.frameId || "—")}</dd></div>
      <div><dt>PRIMITIVE</dt><dd>${summary.primitive.toLocaleUpperCase()}</dd></div>
      <div><dt>VERTICES</dt><dd>${summary.renderedVertices.toLocaleString()} / ${summary.inputVertices.toLocaleString()}</dd></div>
      <div><dt>BOUNDS MIN</dt><dd>${bounds ? bounds.min.map((value) => value.toFixed(2)).join("  ") : "—"}</dd></div>
      <div><dt>BOUNDS MAX</dt><dd>${bounds ? bounds.max.map((value) => value.toFixed(2)).join("  ") : "—"}</dd></div>
    </dl>`;
}

async function renderActiveTopic(): Promise<void> {
  if (!activeTopic || !activeKind || rendering) return;
  rendering = true;
  delete canvasMessage.dataset.tone;
  canvasMessage.textContent = `Reading ${activeTopic.name} at ${formatNanos(controller.state.currentTimeNanos)}…`;
  try {
    const message = await runtime.sample(activeTopic.name, controller.state.currentTimeNanos);
    byId("inspector-title").textContent = displayLabel(activeKind);
    byId("view-title").textContent = activeTopic.name.toLocaleUpperCase();
    byId("view-kind").textContent = displayLabel(activeKind);
    if (activeKind === "raw" || activeKind === "raw-inspector") {
      activeDisplay?.dispose();
      activeDisplay = undefined;
      showRasterSurface(false);
      resizeCanvas();
      const preview = formatRawPreview(message.data);
      inspector.innerHTML = `<dl class="detail-list"><div><dt>TOPIC</dt><dd>${escapeHtml(activeTopic.name)}</dd></div><div><dt>SCHEMA</dt><dd>${escapeHtml(message.channel.schema.name)}</dd></div><div><dt>ENCODING</dt><dd>${escapeHtml(message.channel.messageEncoding)}</dd></div><div><dt>PAYLOAD</dt><dd>${formatBytes(message.data.byteLength)}</dd></div><div><dt>LOG TIME</dt><dd>${message.logTimeNanos.toString()} ns</dd></div></dl><h3 class="raw-heading">BYTE PREVIEW · ${preview.shownBytes.toLocaleString()} B</h3><pre class="raw-preview">${escapeHtml(preview.text)}</pre>${preview.truncatedBytes > 0 ? `<p class="raw-truncated">${preview.truncatedBytes.toLocaleString()} additional bytes omitted by the bounded preview.</p>` : ""}`;
      canvasMessage.textContent = `${preview.shownBytes.toLocaleString()} raw bytes shown in the inspector${preview.truncatedBytes > 0 ? `; ${preview.truncatedBytes.toLocaleString()} omitted` : ""}.`;
      return;
    }
    const decoded = decodeSemanticMessage({
      channel: { schema: message.channel.schema, messageEncoding: message.channel.messageEncoding },
      data: message.data,
    });
    if ((decoded.kind === "image" || decoded.kind === "compressed-image") && activeKind === "image") {
      activeDisplay?.dispose();
      const display = new ImageDisplay("active-image");
      display.configure({ maxInputBytes: 32 * 1024 * 1024, maxPixels: 16_000_000 });
      display.attachSource(controller.state.epoch);
      const summary = display.update(decoded.message, controller.state.epoch);
      const dimensions = await drawDecodedImage(decoded);
      display.render();
      activeDisplay = display;
      byId("view-stats").innerHTML = `<span>CANVAS2D</span><span>${dimensions.width.toLocaleString()} × ${dimensions.height.toLocaleString()}</span><span>${formatBytes(message.data.byteLength)}</span>`;
      const gpuMeter = byId<HTMLMeterElement>("gpu-meter");
      gpuMeter.value = 0;
      byId("gpu-output").textContent = "RASTER";
      showInspector(summary, activeTopic);
      canvasMessage.textContent = `${dimensions.width.toLocaleString()} × ${dimensions.height.toLocaleString()} image rendered from ${summary.frameId || "unframed data"}.`;
      return;
    }
    showRasterSurface(false);
    const gl = resizeCanvas();
    renderer ??= new WebGl2Renderer(canvas, {
      maxGpuBytes: 64 * 1024 * 1024,
      maxBufferBytes: 32 * 1024 * 1024,
      maxVerticesPerGeometry: 1_000_000,
      maxPooledBuffers: 4,
    });
    activeDisplay?.dispose();
    let summary: SemanticSceneSummary;
    if (decoded.kind === "pointcloud2" && (activeKind === "point-cloud" || activeKind === "pointcloud2")) {
      const display = new PointCloud2Display("active-pointcloud", renderer);
      display.configure({ maxPoints: 1_000_000, maxInputBytes: 32 * 1024 * 1024, color: [0.28, 0.93, 0.82, 1] });
      display.attachSource(controller.state.epoch);
      summary = display.update(decoded.message, controller.state.epoch);
      renderer.setViewProjection(projectionFor(summary));
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      display.render();
      activeDisplay = display;
    } else if (decoded.kind === "path" && activeKind === "path") {
      const display = new PathDisplay("active-path", renderer);
      display.configure({ maxPoses: 250_000, maxInputBytes: 32 * 1024 * 1024, color: [1, 0.72, 0.22, 1] });
      display.attachSource(controller.state.epoch);
      summary = display.update(decoded.message, controller.state.epoch);
      renderer.setViewProjection(projectionFor(summary));
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      display.render();
      activeDisplay = display;
    } else {
      throw new Error(`${displayLabel(activeKind)} cannot decode ${message.channel.schema.name}.`);
    }
    const telemetry = renderer.telemetry();
    byId("view-stats").innerHTML = `<span>WEBGL2</span><span>${telemetry.drawCalls} DRAW CALL${telemetry.drawCalls === 1 ? "" : "S"}</span><span>${formatBytes(telemetry.liveGpuBytes)} GPU</span>`;
    const gpuMeter = byId<HTMLMeterElement>("gpu-meter");
    gpuMeter.value = telemetry.liveGpuBytes;
    byId("gpu-output").textContent = formatBytes(telemetry.liveGpuBytes);
    showInspector(summary, activeTopic);
    canvasMessage.textContent = `${summary.renderedVertices.toLocaleString()} vertices rendered from ${summary.frameId || "unframed data"}.`;
  } catch (error) {
    canvasMessage.textContent = error instanceof Error ? error.message : String(error);
    canvasMessage.dataset.tone = "error";
  } finally {
    rendering = false;
  }
}

interface SelectedBrowserFile {
  readonly file: File;
  readonly relativePath: string;
}

function selectedFiles(files: FileList): SelectedBrowserFile[] {
  return Array.from(files, (file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<SelectedBrowserFile> {
  return new Promise((resolve, reject) => entry.file(
    (file) => resolve({ file, relativePath: entry.fullPath.replace(/^\//u, "") || file.name }),
    reject,
  ));
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
  const nested = await directoryEntries(entry as FileSystemDirectoryEntry);
  return (await Promise.all(nested.map(filesFromEntry))).flat();
}

async function droppedFiles(transfer: DataTransfer): Promise<SelectedBrowserFile[]> {
  const entries = Array.from(transfer.items, (item) => item.webkitGetAsEntry()).filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length === 0) return selectedFiles(transfer.files);
  return (await Promise.all(entries.map(filesFromEntry))).flat();
}

async function openFiles(entries: readonly SelectedBrowserFile[]): Promise<void> {
  if (entries.length === 0) return;
  stopPlayback();
  activeTopic = undefined;
  activeKind = undefined;
  activeDisplay?.dispose();
  activeDisplay = undefined;
  byId("view-title").textContent = "WORLD VIEW";
  byId("inspector-title").textContent = "NO DISPLAY";
  const ros2 = entries.some(({ relativePath }) => detectBrowserSourceFormat(relativePath) === "ros2-sqlite");
  const first = entries[0]!;
  const detected = ros2 ? "ros2-sqlite" : detectBrowserSourceFormat(first.file.name);
  const name = ros2 ? `ROS2 BAG · ${entries.length} FILE${entries.length === 1 ? "" : "S"}` : first.file.name;
  inspector.innerHTML = `<p class="muted-copy">Opening ${escapeHtml(name)} and discovering bounded source metadata.</p>`;
  const versions = entries.map(({ file, relativePath }) => `${relativePath}:${localFileVersion(file)}`);
  await controller.openLocal({
    format: detected === "unknown" ? "mcap" : detected,
    name,
    sizeBytes: entries.reduce((total, { file }) => total + file.size, 0),
    immutableVersion: versions.join("|"),
    blob: first.file,
    files: entries.map(({ file, relativePath }) => ({
      name: file.name,
      relativePath,
      sizeBytes: file.size,
      immutableVersion: localFileVersion(file),
      blob: file,
    })),
  });
  renderState();
  const topic = controller.state.topics.find(({ availableDisplays }) => availableDisplays.includes("point-cloud") || availableDisplays.includes("pointcloud2"))
    ?? controller.state.topics.find(({ availableDisplays }) => availableDisplays.some((kind) => kind !== "raw" && kind !== "raw-inspector"))
    ?? controller.state.topics.find(({ availableDisplays }) => availableDisplays.length > 0);
  const kind = topic?.availableDisplays.find((candidate) => candidate !== "raw" && candidate !== "raw-inspector")
    ?? topic?.availableDisplays[0];
  if (topic && kind) {
    controller.addDisplay(topic.id, kind);
    activeTopic = topic;
    activeKind = kind;
    renderState();
    await renderActiveTopic();
  }
}

function stopPlayback(): void {
  playing = false;
  playButton.classList.remove("is-playing");
  playButton.setAttribute("aria-label", "Play recording");
  if (playTimer !== undefined) window.clearInterval(playTimer);
  playTimer = undefined;
}

function startPlayback(): void {
  if (controller.state.durationNanos === 0n) return;
  playing = true;
  playButton.classList.add("is-playing");
  playButton.setAttribute("aria-label", "Pause recording");
  playTimer = window.setInterval(() => {
    if (rendering) return;
    const duration = controller.state.durationNanos;
    const step = duration / 100n || 1n;
    const next = controller.state.currentTimeNanos + step;
    if (next >= duration) {
      stopPlayback();
      return;
    }
    void controller.seek(next).then(() => {
      renderState();
      return renderActiveTopic();
    });
  }, 180);
}

input.addEventListener("change", () => {
  if (input.files) void openFiles(selectedFiles(input.files));
  input.value = "";
});
directoryInput.addEventListener("change", () => {
  if (directoryInput.files) void openFiles(selectedFiles(directoryInput.files));
  directoryInput.value = "";
});

byId("drop-open-button").addEventListener("click", () => input.click());
byId<HTMLButtonElement>("demo-button").addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const demoKind = byId<HTMLSelectElement>("demo-kind").value as "mcap" | "ros1" | "ros2";
  button.disabled = true;
  button.textContent = "LOADING…";
  statusLine.dataset.tone = "normal";
  statusLine.textContent = `Loading the bundled deterministic ${demoKind.toLocaleUpperCase()} demo…`;
  try {
    const paths = demoKind === "mcap" ? ["demo.mcap"] : demoKind === "ros1" ? ["demo-ros1.bag"] : ["demo-ros2/metadata.yaml", "demo-ros2/data_0.db3"];
    const entries = await Promise.all(paths.map(async (path): Promise<SelectedBrowserFile> => {
      const response = await fetch(`/${path}`);
      if (!response.ok) throw new Error(`Demo request for ${path} failed with HTTP ${response.status}.`);
      const blob = await response.blob();
      const name = path.split("/").at(-1) ?? path;
      return { file: new File([blob], name, { type: "application/octet-stream", lastModified: 0 }), relativePath: path };
    }));
    await openFiles(entries);
  } catch (error) {
    statusLine.dataset.tone = "error";
    statusLine.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
    button.textContent = "LOAD DEMO";
  }
});
byId("live-button").addEventListener("click", () => {
  statusLine.dataset.tone = "warning";
  statusLine.textContent = "This container serves the browser viewer only. Configure and deploy the authenticated relay/edge runtime before enabling live ROS topics.";
});

for (const eventName of ["dragenter", "dragover"] as const) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"] as const) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}
dropZone.addEventListener("drop", (event) => {
  const transfer = event.dataTransfer;
  if (!transfer) return;
  void droppedFiles(transfer).then(openFiles).catch((error) => {
    statusLine.dataset.tone = "error";
    statusLine.textContent = `Could not read the dropped recording: ${error instanceof Error ? error.message : String(error)}`;
  });
});

byId<HTMLInputElement>("topic-filter").addEventListener("input", (event) => {
  controller.setTopicFilter((event.target as HTMLInputElement).value);
  renderState();
});

topicList.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-topic][data-kind]");
  if (!target) return;
  const topic = controller.state.topics.find(({ id }) => id === target.dataset.topic);
  const kind = target.dataset.kind as DisplayKind | undefined;
  if (!topic || !kind) return;
  controller.addDisplay(topic.id, kind);
  activeTopic = topic;
  activeKind = kind;
  renderState();
  void renderActiveTopic();
});

timeline.addEventListener("change", () => {
  const duration = controller.state.durationNanos;
  const requested = duration === 0n ? 0n : (duration * BigInt(timeline.value)) / 1000n;
  void controller.seek(requested).then(() => {
    renderState();
    return renderActiveTopic();
  });
});

async function step(direction: -1 | 1): Promise<void> {
  stopPlayback();
  const duration = controller.state.durationNanos;
  if (duration === 0n) return;
  const delta = duration / 100n || 1n;
  const current = controller.state.currentTimeNanos;
  const next = direction < 0 ? (current > delta ? current - delta : 0n) : (current + delta > duration ? duration : current + delta);
  await controller.seek(next);
  renderState();
  await renderActiveTopic();
}

byId("step-back").addEventListener("click", () => void step(-1));
byId("step-forward").addEventListener("click", () => void step(1));
playButton.addEventListener("click", () => playing ? stopPlayback() : startPlayback());

new ResizeObserver(() => {
  try {
    if (imageCanvas.hidden) resizeCanvas();
    if (activeTopic) void renderActiveTopic();
  } catch (error) {
    canvasMessage.textContent = error instanceof Error ? error.message : String(error);
  }
}).observe(dropZone);

renderState();
resizeCanvas();
