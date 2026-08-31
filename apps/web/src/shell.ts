export type ShellPhase = "empty" | "loading" | "ready" | "degraded" | "error";

export type CompatibilityTier =
  | "native-display"
  | "schema-backed-generic"
  | "opaque-inspectable"
  | "unsupported";

export type RecordedSourceFormat = "mcap" | "ros1-bag" | "ros2-sqlite";

export type DisplayKind =
  | "camera-info"
  | "frame-tree"
  | "grid"
  | "image"
  | "laser-scan"
  | "marker"
  | "numeric-plot"
  | "occupancy-grid"
  | "odometry"
  | "path"
  | "point-cloud"
  | "pointcloud2"
  | "pose"
  | "raw"
  | "raw-inspector";

export type ShellRegion = "session" | "topics" | "workspace" | "inspector" | "timeline";

export interface LocalMcapSelection {
  readonly format?: RecordedSourceFormat;
  readonly name: string;
  readonly sizeBytes: number;
  readonly immutableVersion: string;
  readonly blob?: Blob;
}

export interface TopicSummary {
  readonly id: string;
  readonly name: string;
  readonly typeName: string;
  readonly compatibility: CompatibilityTier;
  readonly schemaCapability: "schema-present" | "schema-resolvable" | "opaque";
  readonly availableDisplays: readonly DisplayKind[];
}

export interface OpenLocalResult {
  readonly sourceLabel: string;
  readonly sourceHash: string;
  readonly durationNanos: bigint;
  readonly epoch: number;
  readonly indexState: "indexed" | "sequential";
  readonly topics: readonly TopicSummary[];
  readonly diagnostic?: string;
}

export interface SeekResult {
  readonly epoch: number;
  readonly currentTimeNanos: bigint;
  readonly diagnostic?: string;
}

export interface DesktopShellPorts {
  readonly openLocalMcap?: (selection: LocalMcapSelection) => Promise<OpenLocalResult>;
  readonly openLocalRecording?: (selection: LocalMcapSelection) => Promise<OpenLocalResult>;
  readonly seek: (timeNanos: bigint) => Promise<SeekResult>;
}

export interface DisplayConfiguration {
  readonly fixedFrame: string;
  readonly color: string;
  readonly scale: number;
  readonly quality: "compact" | "balanced";
}

export interface DisplayPanel {
  readonly id: string;
  readonly topicId: string;
  readonly title: string;
  readonly kind: DisplayKind;
  readonly status: "loading" | "ready" | "tf-error";
  readonly configuration: DisplayConfiguration;
  readonly tfError?: TfError;
}

export interface TfError {
  readonly targetFrame: string;
  readonly sourceFrame: string;
  readonly queryTimeNanos: bigint;
  readonly reason: string;
}

export interface DesktopShellState {
  readonly phase: ShellPhase;
  readonly sourceLabel?: string;
  readonly sourceHash?: string;
  readonly sourceFormat?: RecordedSourceFormat;
  readonly sourceSelection?: LocalMcapSelection;
  readonly topics: readonly TopicSummary[];
  readonly topicFilter: string;
  readonly displays: readonly DisplayPanel[];
  readonly activeDisplayId?: string;
  readonly currentTimeNanos: bigint;
  readonly durationNanos: bigint;
  readonly epoch: number;
  readonly indexState: "none" | "indexed" | "sequential";
  readonly focusedRegion: ShellRegion;
  readonly blockingError?: string;
  readonly notice?: string;
}

const defaultConfiguration: DisplayConfiguration = {
  fixedFrame: "map",
  color: "intensity",
  scale: 1,
  quality: "compact",
};

const regionOrder: readonly ShellRegion[] = ["session", "topics", "workspace", "inspector", "timeline"];

function clampTime(timeNanos: bigint, durationNanos: bigint): bigint {
  if (timeNanos < 0n) return 0n;
  if (timeNanos > durationNanos) return durationNanos;
  return timeNanos;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown local source error";
}

export class DesktopShellController {
  #state: DesktopShellState = {
    phase: "empty",
    topics: [],
    topicFilter: "",
    displays: [],
    currentTimeNanos: 0n,
    durationNanos: 0n,
    epoch: 0,
    indexState: "none",
    focusedRegion: "session",
    notice: "Choose a local MCAP, ROS1 bag, or ROS2 SQLite recording to inspect topics.",
  };

  constructor(private readonly ports: DesktopShellPorts) {}

  get state(): DesktopShellState {
    return this.#state;
  }

  get visibleTopics(): readonly TopicSummary[] {
    const needle = this.#state.topicFilter.trim().toLocaleLowerCase();
    if (!needle) return this.#state.topics;
    return this.#state.topics.filter((topic) =>
      `${topic.name} ${topic.typeName} ${topic.compatibility}`.toLocaleLowerCase().includes(needle),
    );
  }

  async openLocal(selection: LocalMcapSelection): Promise<void> {
    this.#state = {
      ...this.#state,
      phase: "loading",
      sourceSelection: selection,
      sourceFormat: selection.format ?? "mcap",
      sourceLabel: selection.name,
      blockingError: undefined,
      notice: `Opening ${selection.name}; indexing and resolving schemas.`,
    };

    try {
      const result = this.ports.openLocalRecording
        ? await this.ports.openLocalRecording(selection)
        : this.ports.openLocalMcap
          ? await this.ports.openLocalMcap(selection)
          : await Promise.reject(new Error("no recorded-source runtime is registered"));
      this.#state = {
        ...this.#state,
        phase: result.indexState === "sequential" ? "degraded" : "ready",
        sourceLabel: result.sourceLabel,
        sourceHash: result.sourceHash,
        topics: result.topics,
        displays: [],
        activeDisplayId: undefined,
        currentTimeNanos: 0n,
        durationNanos: result.durationNanos,
        epoch: result.epoch,
        indexState: result.indexState,
        notice:
          result.diagnostic ??
          (result.topics.length === 0
            ? "Source opened, but it contains no discoverable topics. Replace the source or inspect diagnostics."
            : `${result.topics.length} topics discovered.`),
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        phase: "error",
        blockingError: `Could not open ${selection.name}: ${errorMessage(error)}. Choose another local recording or retry.`,
        notice: undefined,
      };
    }
  }

  retryOpen(): Promise<void> {
    const selection = this.#state.sourceSelection;
    if (!selection) throw new Error("no local source is available to retry");
    return this.openLocal(selection);
  }

  setTopicFilter(value: string): void {
    this.#state = { ...this.#state, topicFilter: value };
  }

  addDisplay(topicId: string, kind: DisplayKind): string {
    const topic = this.#state.topics.find((candidate) => candidate.id === topicId);
    if (!topic) throw new Error(`unknown topic ${topicId}`);
    if (!topic.availableDisplays.includes(kind)) {
      throw new Error(`${kind} is unavailable for ${topic.name} (${topic.compatibility})`);
    }

    const id = `display-${this.#state.displays.length + 1}`;
    const display: DisplayPanel = {
      id,
      topicId,
      title: `${topic.name} · ${kind}`,
      kind,
      status: "ready",
      configuration: defaultConfiguration,
    };
    this.#state = {
      ...this.#state,
      displays: [...this.#state.displays, display],
      activeDisplayId: id,
      focusedRegion: "workspace",
      notice: `${display.title} added. Focus remains in the display workspace.`,
    };
    return id;
  }

  selectDisplay(displayId: string): void {
    if (!this.#state.displays.some(({ id }) => id === displayId)) throw new Error(`unknown display ${displayId}`);
    this.#state = { ...this.#state, activeDisplayId: displayId };
  }

  configureActiveDisplay(configuration: Partial<DisplayConfiguration>): void {
    const activeDisplayId = this.#state.activeDisplayId;
    if (!activeDisplayId) throw new Error("no active display to configure");
    if (configuration.scale !== undefined && (!Number.isFinite(configuration.scale) || configuration.scale <= 0)) {
      throw new Error("display scale must be a positive finite number");
    }

    this.#state = {
      ...this.#state,
      displays: this.#state.displays.map((display) =>
        display.id === activeDisplayId
          ? { ...display, configuration: { ...display.configuration, ...configuration } }
          : display,
      ),
      notice: "Display configuration updated; the last valid rendering remains visible.",
    };
  }

  async seek(timeNanos: bigint): Promise<void> {
    if (this.#state.phase === "empty" || this.#state.phase === "error") {
      throw new Error("open a source before seeking");
    }
    const requestedTime = clampTime(timeNanos, this.#state.durationNanos);
    this.#state = {
      ...this.#state,
      phase: "loading",
      displays: this.#state.displays.map((display) => ({ ...display, status: "loading", tfError: undefined })),
      notice: `Seeking to ${requestedTime} ns; stale display and TF state are invalidated.`,
    };

    try {
      const result = await this.ports.seek(requestedTime);
      this.#state = {
        ...this.#state,
        phase: this.#state.indexState === "sequential" ? "degraded" : "ready",
        currentTimeNanos: result.currentTimeNanos,
        epoch: result.epoch,
        displays: this.#state.displays.map((display) => ({ ...display, status: "ready" })),
        blockingError: undefined,
        notice: result.diagnostic ?? `Seek complete at ${result.currentTimeNanos} ns; epoch ${result.epoch}.`,
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        phase: "error",
        blockingError: `Seek failed: ${errorMessage(error)}. The local source remains selected; retry or replace it.`,
        notice: undefined,
      };
    }
  }

  reportTfError(displayId: string, tfError: TfError): void {
    if (!this.#state.displays.some(({ id }) => id === displayId)) throw new Error(`unknown display ${displayId}`);
    this.#state = {
      ...this.#state,
      displays: this.#state.displays.map((display) =>
        display.id === displayId ? { ...display, status: "tf-error", tfError } : display,
      ),
      notice: `TF unavailable from ${tfError.sourceFrame} to ${tfError.targetFrame} at ${tfError.queryTimeNanos} ns: ${tfError.reason}. Geometry is halted.`,
    };
  }

  moveRegionFocus(direction: 1 | -1): ShellRegion {
    const current = regionOrder.indexOf(this.#state.focusedRegion);
    const next = (current + direction + regionOrder.length) % regionOrder.length;
    const focusedRegion = regionOrder[next];
    this.#state = { ...this.#state, focusedRegion };
    return focusedRegion;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function displayName(kind: DisplayKind): string {
  if (kind === "point-cloud") return "Point cloud";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function renderTopic(topic: TopicSummary): string {
  const actions = topic.availableDisplays.length
    ? topic.availableDisplays
        .map(
          (kind) =>
            `<button type="button" data-action="add-display" data-topic-id="${escapeHtml(topic.id)}" data-display-kind="${kind}" aria-label="Add ${displayName(kind)} display for ${escapeHtml(topic.name)}">Add ${displayName(kind)}</button>`,
        )
        .join("")
    : `<span role="note">No display: ${escapeHtml(topic.compatibility)}</span>`;
  return `<li role="treeitem" aria-label="${escapeHtml(topic.name)}, ${escapeHtml(topic.typeName)}, ${topic.compatibility}"><strong>${escapeHtml(topic.name)}</strong><span>${escapeHtml(topic.typeName)}</span><span>${topic.schemaCapability}</span>${actions}</li>`;
}

function renderDisplay(display: DisplayPanel, activeDisplayId: string | undefined): string {
  const error = display.tfError
    ? `<p class="panel-error" role="alert">TF ${escapeHtml(display.tfError.sourceFrame)} → ${escapeHtml(display.tfError.targetFrame)} at ${display.tfError.queryTimeNanos} ns: ${escapeHtml(display.tfError.reason)}. Geometry halted.</p>`
    : "";
  return `<article class="display-panel" tabindex="0" data-display-id="${escapeHtml(display.id)}" aria-label="${escapeHtml(display.title)}" aria-current="${display.id === activeDisplayId ? "true" : "false"}" aria-busy="${display.status === "loading"}"><header><h3>${escapeHtml(display.title)}</h3><button type="button" aria-label="Configure ${escapeHtml(display.title)}">Settings</button></header>${error}<p>Status: ${display.status}</p></article>`;
}

export function renderDesktopShell(controller: DesktopShellController): string {
  const state = controller.state;
  const activeDisplay = state.displays.find(({ id }) => id === state.activeDisplayId);
  const sessionError = state.blockingError
    ? `<div id="shell-error" role="alert" tabindex="-1">${escapeHtml(state.blockingError)}</div>`
    : "";
  const topics = controller.visibleTopics.length
    ? controller.visibleTopics.map(renderTopic).join("")
    : `<li role="treeitem" aria-disabled="true">No matching topics. Clear the search or open another source.</li>`;
  const displays = state.displays.length
    ? state.displays.map((display) => renderDisplay(display, state.activeDisplayId)).join("")
    : `<p class="empty-state">Add a compatible topic display to inspect the recording.</p>`;
  const inspector = activeDisplay
    ? `<form aria-label="Display configuration"><label>Fixed frame<input name="fixed-frame" value="${escapeHtml(activeDisplay.configuration.fixedFrame)}" aria-describedby="display-config-help"></label><label>Color field<input name="color" value="${escapeHtml(activeDisplay.configuration.color)}"></label><label>Scale<input name="scale" type="number" min="0.01" step="0.01" value="${activeDisplay.configuration.scale}"></label><p id="display-config-help">Invalid edits preserve the last valid rendering.</p></form>`
    : `<p>Select a display to inspect frame, color, scale, schema, and diagnostics.</p>`;

  return `<div class="desktop-shell" data-phase="${state.phase}" data-focused-region="${state.focusedRegion}" aria-label="Local recorded-source desktop viewer">
  <header class="session-bar" aria-label="Session bar"><strong>${escapeHtml(state.sourceLabel ?? "No local source")}</strong><span>Mode: local ${state.sourceFormat ?? "recording"}</span><span>State: ${state.phase}</span><button type="button" data-action="open-local" aria-describedby="source-help">Open local recording</button><span id="source-help">Recording bytes remain local.</span><button type="button" disabled aria-describedby="share-help">Share</button><span id="share-help">Unavailable in the local M2 slice; no upload occurs.</span><button type="button" disabled>Live (not available)</button></header>
  ${sessionError}
  <div class="shell-notice" role="status" aria-live="polite">${escapeHtml(state.notice ?? "")}</div>
  <nav class="topic-browser" aria-label="Topic browser"><h2>Topics</h2><label for="topic-search">Search topics</label><input id="topic-search" type="search" value="${escapeHtml(state.topicFilter)}"><ul role="tree">${topics}</ul></nav>
  <main class="display-workspace" aria-label="Display workspace" aria-busy="${state.phase === "loading"}"><h2>Displays</h2>${displays}</main>
  <aside class="inspector" aria-label="Inspector"><h2>Inspector</h2>${inspector}</aside>
  <footer class="timeline" aria-label="Timeline"><button type="button" aria-label="Play recording">Play</button><button type="button" aria-label="Step backward">−1</button><input type="range" min="0" max="${state.durationNanos}" value="${state.currentTimeNanos}" aria-label="Seek recording"><button type="button" aria-label="Step forward">+1</button><output>${state.currentTimeNanos} / ${state.durationNanos} ns</output><span>Epoch ${state.epoch}</span><span>Clock: record</span><span>Index: ${state.indexState}</span></footer>
</div>`;
}

export interface SemanticEvidenceEnvironment {
  readonly browser: string;
  readonly viewportCssPixels: readonly [number, number];
  readonly devicePixelRatio: number;
  readonly zoomPercent: number;
  readonly reducedMotion: boolean;
}

export interface SemanticShellEvidence {
  readonly environment: SemanticEvidenceEnvironment;
  readonly phase: ShellPhase;
  readonly sourceHash?: string;
  readonly focusedRegion: ShellRegion;
  readonly semanticHtml: string;
  readonly assertions: Readonly<Record<string, boolean>>;
}

export function captureSemanticEvidence(
  controller: DesktopShellController,
  environment: SemanticEvidenceEnvironment,
): SemanticShellEvidence {
  const semanticHtml = renderDesktopShell(controller);
  const [width, height] = environment.viewportCssPixels;
  return {
    environment,
    phase: controller.state.phase,
    sourceHash: controller.state.sourceHash,
    focusedRegion: controller.state.focusedRegion,
    semanticHtml,
    assertions: {
      fiveStableRegions: ["Session bar", "Topic browser", "Display workspace", "Inspector", "Timeline"].every(
        (name) => semanticHtml.includes(`aria-label="${name}"`),
      ),
      logicalRegionOrder:
        semanticHtml.indexOf("Session bar") < semanticHtml.indexOf("Topic browser") &&
        semanticHtml.indexOf("Topic browser") < semanticHtml.indexOf("Display workspace") &&
        semanticHtml.indexOf("Display workspace") < semanticHtml.indexOf("Inspector") &&
        semanticHtml.indexOf("Inspector") < semanticHtml.indexOf("Timeline"),
      accessibleAnnouncements: semanticHtml.includes('role="status"') && semanticHtml.includes('aria-live="polite"'),
      localOnlyEntry: semanticHtml.includes("Open local recording") && semanticHtml.includes("Recording bytes remain local."),
      desktopViewport: width >= 960 && height >= 600,
      validDpr: environment.devicePixelRatio > 0 && environment.devicePixelRatio <= 4,
      zoomOperable: environment.zoomPercent >= 100 && environment.zoomPercent <= 200,
      reducedMotionRecorded: typeof environment.reducedMotion === "boolean",
    },
  };
}

export const desktopShellStyles = `
:root {
  color-scheme: dark;
  --surface-0: #0b0d12;
  --surface-1: #121620;
  --surface-2: #1a2030;
  --text-strong: #f4f7ff;
  --text-muted: #aab4c8;
  --accent-cyan: #5ce1e6;
  --danger: #ff6b7a;
  font: 13px/18px system-ui, sans-serif;
}
.desktop-shell {
  min-width: 960px;
  min-height: 600px;
  display: grid;
  grid-template: "session session session" auto "topics workspace inspector" minmax(0, 1fr) "timeline timeline timeline" auto / 240px minmax(420px, 1fr) 280px;
  color: var(--text-strong);
  background: var(--surface-0);
}
.session-bar { grid-area: session; }
.topic-browser { grid-area: topics; overflow: auto; }
.display-workspace { grid-area: workspace; overflow: auto; }
.inspector { grid-area: inspector; overflow: auto; }
.timeline { grid-area: timeline; }
.session-bar, .timeline { display: flex; gap: 8px; align-items: center; padding: 8px 12px; }
.topic-browser, .display-workspace, .inspector { padding: 12px; border: 1px solid var(--surface-2); }
button, input { min-height: 32px; }
:focus-visible { outline: 2px solid var(--accent-cyan); outline-offset: 2px; }
.panel-error, [role="alert"] { color: var(--danger); }
@media (max-width: 1100px) {
  .desktop-shell { grid-template-columns: 200px minmax(400px, 1fr) 220px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
}
`;
