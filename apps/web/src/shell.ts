export type ShellPhase = "empty" | "loading" | "ready" | "degraded" | "error";

export type CompatibilityTier =
  | "native-display"
  | "schema-backed-generic"
  | "opaque-inspectable"
  | "unsupported";

export type RecordedSourceFormat = "mcap" | "ros1-bag" | "ros2-sqlite";

export type SourceMode = "recorded" | "hosted" | "live";

export type LiveConnectionState = "disconnected" | "connecting" | "connected" | "degraded" | "reconnecting";

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
  readonly files?: readonly {
    readonly name: string;
    readonly relativePath: string;
    readonly sizeBytes: number;
    readonly immutableVersion: string;
    readonly blob: Blob;
  }[];
}

export interface TopicSummary {
  readonly id: string;
  readonly name: string;
  readonly typeName: string;
  readonly compatibility: CompatibilityTier;
  readonly schemaCapability: "schema-present" | "schema-resolvable" | "opaque";
  readonly availableDisplays: readonly DisplayKind[];
  readonly messageCount?: bigint;
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

export interface LiveConnectionSelection {
  readonly browserOrigin: string;
  readonly sessionToken: string;
}

export interface HostedSessionSelection {
  readonly link: string;
}

export type HostedSessionFailureCode =
  | "deleted"
  | "expired"
  | "invalid"
  | "retention-expired"
  | "revoked"
  | "unavailable";

export interface HostedObservabilitySummary {
  readonly rangeRequests: number;
  readonly transferredBytes: number;
  readonly deniedRequests: number;
  readonly activeReaders: number;
}

export interface OpenHostedResult extends OpenLocalResult {
  readonly observability: HostedObservabilitySummary;
}

export interface LiveTelemetrySummary {
  readonly state: LiveConnectionState;
  readonly sourceEpoch: number;
  readonly queuedMessages: number;
  readonly queuedBytes: number;
  readonly acceptedMessages: number;
  readonly deliveredMessages: number;
  readonly droppedMessages: number;
  readonly latestRelayLatencyMs?: number;
  readonly maxRelayLatencyMs?: number;
  readonly latestBrowserDeliveryLatencyMs?: number;
  readonly maxBrowserDeliveryLatencyMs?: number;
  readonly diagnostic?: string;
}

export interface OpenLiveResult {
  readonly sourceLabel: string;
  readonly epoch: number;
  readonly topics: readonly TopicSummary[];
  readonly telemetry: LiveTelemetrySummary;
}

export interface LivePollResult {
  readonly epoch: number;
  readonly latestSourceTimeNanos?: bigint;
  readonly messageCount: number;
  readonly telemetry: LiveTelemetrySummary;
  readonly displayDeliveries?: number;
  readonly displayErrors?: number;
  readonly staleMessageCount?: number;
}

export interface DesktopShellPorts {
  readonly openLocalMcap?: (selection: LocalMcapSelection) => Promise<OpenLocalResult>;
  readonly openLocalRecording?: (selection: LocalMcapSelection) => Promise<OpenLocalResult>;
  readonly openHostedSession?: (selection: HostedSessionSelection) => Promise<OpenHostedResult>;
  readonly seek: (timeNanos: bigint) => Promise<SeekResult>;
  readonly connectLive?: (selection: LiveConnectionSelection) => Promise<OpenLiveResult>;
  readonly subscribeLive?: (topicIds: readonly string[]) => Promise<void>;
  readonly pollLive?: () => LivePollResult;
  readonly reconnectLive?: () => Promise<OpenLiveResult>;
  readonly disconnectLive?: () => Promise<void>;
  readonly registerLiveDisplay?: (display: DisplayPanel) => void;
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
  readonly sourceMode?: SourceMode;
  readonly sourceSelection?: LocalMcapSelection;
  readonly topics: readonly TopicSummary[];
  readonly topicFilter: string;
  readonly displays: readonly DisplayPanel[];
  readonly activeDisplayId?: string;
  readonly currentTimeNanos: bigint;
  readonly durationNanos: bigint;
  readonly epoch: number;
  readonly indexState: "none" | "indexed" | "sequential";
  readonly liveState: LiveConnectionState;
  readonly liveTelemetry?: LiveTelemetrySummary;
  readonly hostedObservability?: HostedObservabilitySummary;
  readonly focusedRegion: ShellRegion;
  readonly blockingError?: string;
  readonly notice?: string;
}

const defaultConfiguration: DisplayConfiguration = {
  fixedFrame: "",
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
  #sourceGeneration = 0;
  #state: DesktopShellState = {
    phase: "empty",
    topics: [],
    topicFilter: "",
    displays: [],
    currentTimeNanos: 0n,
    durationNanos: 0n,
    epoch: 0,
    indexState: "none",
    liveState: "disconnected",
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
    const generation = ++this.#sourceGeneration;
    this.#state = {
      ...this.#state,
      phase: "loading",
      sourceSelection: selection,
      sourceFormat: selection.format ?? "mcap",
      sourceMode: "recorded",
      liveState: "disconnected",
      liveTelemetry: undefined,
      hostedObservability: undefined,
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
      if (generation !== this.#sourceGeneration) return;
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
      if (generation !== this.#sourceGeneration) return;
      this.#state = {
        ...this.#state,
        phase: "error",
        blockingError: `Could not open ${selection.name}: ${errorMessage(error)}. Choose another local recording or retry.`,
        notice: undefined,
      };
    }
  }

  async openHosted(selection: HostedSessionSelection): Promise<void> {
    const generation = ++this.#sourceGeneration;
    if (!this.ports.openHostedSession) throw new Error("no hosted-source runtime is registered");
    this.#state = {
      ...this.#state,
      phase: "loading",
      sourceMode: "hosted",
      sourceFormat: undefined,
      sourceLabel: "Hosted recording",
      sourceHash: undefined,
      sourceSelection: undefined,
      liveState: "disconnected",
      liveTelemetry: undefined,
      hostedObservability: undefined,
      topics: [],
      displays: [],
      activeDisplayId: undefined,
      currentTimeNanos: 0n,
      durationNanos: 0n,
      indexState: "none",
      blockingError: undefined,
      notice: "Opening an opaque hosted session; validating the signed manifest and immutable source.",
    };

    try {
      const result = await this.ports.openHostedSession(selection);
      if (generation !== this.#sourceGeneration) return;
      this.#state = {
        ...this.#state,
        phase: result.indexState === "sequential" ? "degraded" : "ready",
        sourceLabel: result.sourceLabel,
        sourceHash: result.sourceHash,
        durationNanos: result.durationNanos,
        epoch: result.epoch,
        indexState: result.indexState,
        topics: result.topics,
        hostedObservability: result.observability,
        notice:
          result.diagnostic ??
          `${result.topics.length} hosted topics discovered. Access is read-only and capability-scoped.`,
      };
    } catch (error) {
      const code = hostedFailureCode(error);
      if (generation !== this.#sourceGeneration) return;
      this.#state = {
        ...this.#state,
        phase: "error",
        blockingError: hostedFailureMessage(code),
        notice: undefined,
      };
    }
  }

  retryOpen(): Promise<void> {
    const selection = this.#state.sourceSelection;
    if (!selection) throw new Error("no local source is available to retry");
    return this.openLocal(selection);
  }

  async connectLive(selection: LiveConnectionSelection): Promise<void> {
    const generation = ++this.#sourceGeneration;
    if (!this.ports.connectLive) throw new Error("no secure live-source runtime is registered");
    this.#state = {
      ...this.#state,
      phase: "loading",
      sourceMode: "live",
      sourceFormat: undefined,
      sourceLabel: "Secure live relay",
      sourceHash: undefined,
      sourceSelection: undefined,
      liveState: "connecting",
      liveTelemetry: undefined,
      hostedObservability: undefined,
      topics: [],
      displays: [],
      activeDisplayId: undefined,
      currentTimeNanos: 0n,
      durationNanos: 0n,
      indexState: "none",
      blockingError: undefined,
      notice: "Authenticating a browser-bound, subscribe-only live session.",
    };
    try {
      const result = await this.ports.connectLive(selection);
      if (generation !== this.#sourceGeneration) return;
      this.#state = {
        ...this.#state,
        phase: result.telemetry.state === "degraded" ? "degraded" : "ready",
        sourceLabel: result.sourceLabel,
        epoch: result.epoch,
        topics: result.topics,
        liveState: result.telemetry.state,
        liveTelemetry: result.telemetry,
        notice: `${result.topics.length} live topics discovered. Live mode is read-only.`,
      };
    } catch (error) {
      if (generation !== this.#sourceGeneration) return;
      this.#state = {
        ...this.#state,
        phase: "error",
        liveState: "disconnected",
        blockingError: `Could not connect secure live mode: ${errorMessage(error)}. Retry the authenticated session.`,
        notice: undefined,
      };
    }
  }

  async subscribeLive(topicIds: readonly string[]): Promise<void> {
    if (this.#state.sourceMode !== "live" || !this.ports.subscribeLive) {
      throw new Error("connect secure live mode before subscribing");
    }
    await this.ports.subscribeLive(topicIds);
    this.#state = {
      ...this.#state,
      notice: `${topicIds.length} explicit live topic${topicIds.length === 1 ? "" : "s"} subscribed read-only.`,
    };
  }

  pollLive(): LivePollResult {
    if (this.#state.sourceMode !== "live" || !this.ports.pollLive) {
      throw new Error("connect secure live mode before polling");
    }
    const result = this.ports.pollLive();
    const deliveries = result.displayDeliveries ?? 0;
    const errors = result.displayErrors ?? 0;
    const stale = result.staleMessageCount ?? 0;
    let routedNotice: string;
    if (errors > 0) {
      routedNotice = `${deliveries} live display update${deliveries === 1 ? "" : "s"} rendered; ${errors} failed.`;
    } else if (deliveries > 0) {
      routedNotice = `${deliveries} live display update${deliveries === 1 ? "" : "s"} rendered from ${result.messageCount} message${result.messageCount === 1 ? "" : "s"}.`;
    } else {
      routedNotice = `${result.messageCount} live message${result.messageCount === 1 ? "" : "s"} drained; no active display rendered.`;
    }
    const staleNotice = stale > 0 ? ` ${stale} stale-epoch message${stale === 1 ? "" : "s"} ignored.` : "";
    const notice = `${result.telemetry.diagnostic === undefined ? "" : `${result.telemetry.diagnostic} `}${routedNotice}${staleNotice}`;
    this.#state = {
      ...this.#state,
      phase: result.telemetry.state === "disconnected"
        ? "error"
        : result.telemetry.state === "connecting" || result.telemetry.state === "reconnecting"
          ? "loading"
          : result.telemetry.state === "degraded" || errors > 0 ? "degraded" : "ready",
      epoch: result.epoch,
      currentTimeNanos: result.latestSourceTimeNanos ?? this.#state.currentTimeNanos,
      liveState: result.telemetry.state,
      liveTelemetry: result.telemetry,
      notice,
      blockingError: result.telemetry.state === "disconnected" ? result.telemetry.diagnostic ?? "Live relay disconnected." : undefined,
    };
    return result;
  }

  async reconnectLive(): Promise<void> {
    if (this.#state.sourceMode !== "live" || !this.ports.reconnectLive) {
      throw new Error("connect secure live mode before reconnecting");
    }
    const generation = ++this.#sourceGeneration;
    this.#state = {
      ...this.#state,
      phase: "loading",
      liveState: "reconnecting",
      notice: "Reconnecting live source; stale epoch data is ignored.",
    };
    try {
      const result = await this.ports.reconnectLive();
      if (generation !== this.#sourceGeneration) return;
      this.#state = {
        ...this.#state,
        phase: result.telemetry.state === "degraded" ? "degraded" : "ready",
        epoch: result.epoch,
        topics: result.topics,
        liveState: result.telemetry.state,
        liveTelemetry: result.telemetry,
        notice: `Live source reconnected at epoch ${result.epoch}.`,
      };
    } catch (error) {
      if (generation !== this.#sourceGeneration) return;
      this.#state = {
        ...this.#state,
        phase: "error",
        liveState: "disconnected",
        blockingError: `Live reconnect failed: ${errorMessage(error)}. Retry the authenticated session.`,
        notice: undefined,
      };
    }
  }

  async disconnectLive(): Promise<void> {
    const generation = ++this.#sourceGeneration;
    await this.ports.disconnectLive?.();
    if (generation !== this.#sourceGeneration) return;
    this.#state = {
      ...this.#state,
      phase: "empty",
      sourceMode: undefined,
      sourceLabel: undefined,
      topics: [],
      displays: [],
      activeDisplayId: undefined,
      currentTimeNanos: 0n,
      epoch: 0,
      liveState: "disconnected",
      liveTelemetry: undefined,
      blockingError: undefined,
      notice: "Live session disconnected. Choose a local recording or secure live mode.",
    };
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
    if (this.#state.sourceMode === "live") {
      if (!this.ports.registerLiveDisplay) throw new Error("live display registration unavailable");
      this.ports.registerLiveDisplay(display);
    }
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

function hostedFailureCode(error: unknown): HostedSessionFailureCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (
      code === "deleted" ||
      code === "expired" ||
      code === "invalid" ||
      code === "retention-expired" ||
      code === "revoked" ||
      code === "unavailable"
    ) {
      return code;
    }
  }
  return "unavailable";
}

function hostedFailureMessage(code: HostedSessionFailureCode): string {
  const messages: Record<HostedSessionFailureCode, string> = {
    deleted: "This hosted session was deleted. Ask the session owner for a new source.",
    expired: "This hosted session expired. Ask the session owner for a new opaque link.",
    invalid: "This hosted link is invalid or was altered. Check the complete link and try again.",
    "retention-expired": "This hosted session is no longer retained. Ask the session owner to share it again.",
    revoked: "This hosted session was revoked. Ask the session owner for a new opaque link.",
    unavailable: "The hosted session is unavailable. Retry later or open another source.",
  };
  return messages[code];
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
  const modeSummary =
    state.sourceMode === "live"
      ? "secure live · read-only"
      : state.sourceMode === "hosted"
        ? "hosted · read-only"
        : `local ${state.sourceFormat ?? "recording"}`;
  const liveTelemetry = state.liveTelemetry
    ? `<span>Queue: ${state.liveTelemetry.queuedMessages} messages / ${state.liveTelemetry.queuedBytes} bytes</span><span>Dropped: ${state.liveTelemetry.droppedMessages}</span>${state.liveTelemetry.latestRelayLatencyMs === undefined ? "" : `<span>Relay: ${state.liveTelemetry.latestRelayLatencyMs.toFixed(2)} ms</span>`}${state.liveTelemetry.latestBrowserDeliveryLatencyMs === undefined ? "" : `<span>Display: ${state.liveTelemetry.latestBrowserDeliveryLatencyMs.toFixed(2)} ms</span>`}`
    : "";
  const hostedObservability = state.hostedObservability
    ? `<span>Hosted reads: ${state.hostedObservability.rangeRequests} ranges / ${state.hostedObservability.transferredBytes} bytes</span><span>Denied: ${state.hostedObservability.deniedRequests}</span><span>Active readers: ${state.hostedObservability.activeReaders}</span>`
    : "";
  const timeline =
    state.sourceMode === "live"
      ? `<output>Latest source time: ${state.currentTimeNanos} ns</output><span>Epoch ${state.epoch}</span><span>Clock: source / receipt</span>${liveTelemetry}`
      : `<button type="button" aria-label="Play recording">Play</button><button type="button" aria-label="Step backward">−1</button><input type="range" min="0" max="${state.durationNanos}" value="${state.currentTimeNanos}" aria-label="Seek recording"><button type="button" aria-label="Step forward">+1</button><output>${state.currentTimeNanos} / ${state.durationNanos} ns</output><span>Epoch ${state.epoch}</span><span>Clock: record</span><span>Index: ${state.indexState}</span>${hostedObservability}`;

  return `<div class="desktop-shell" data-phase="${state.phase}" data-focused-region="${state.focusedRegion}" aria-label="Read-only ROS data desktop viewer">
  <header class="session-bar" aria-label="Session bar"><strong>${escapeHtml(state.sourceLabel ?? "No source")}</strong><span>Mode: ${modeSummary}</span><span>State: ${state.phase}</span><button type="button" data-action="open-local" aria-describedby="source-help">Open local recording</button><span id="source-help">Recording bytes remain local.</span><button type="button" data-action="open-hosted" aria-describedby="hosted-help">Open hosted link</button><span id="hosted-help">Uses an opaque capability; storage credentials and object keys stay hidden.</span><button type="button" data-action="connect-live" aria-describedby="live-help">Connect secure live (read-only)</button><span id="live-help">Uses an authenticated browser session; topic access is explicit and bounded.</span><button type="button" disabled aria-describedby="share-help">Share</button><span id="share-help">Creation is unavailable in this local reference UI; no upload occurs.</span></header>
  ${sessionError}
  <div class="shell-notice" role="status" aria-live="polite">${escapeHtml(state.notice ?? "")}</div>
  <nav class="topic-browser" aria-label="Topic browser"><h2>Topics</h2><label for="topic-search">Search topics</label><input id="topic-search" type="search" value="${escapeHtml(state.topicFilter)}"><ul role="tree">${topics}</ul></nav>
  <main class="display-workspace" aria-label="Display workspace" aria-busy="${state.phase === "loading"}"><h2>Displays</h2>${displays}</main>
  <aside class="inspector" aria-label="Inspector"><h2>Inspector</h2>${inspector}</aside>
  <footer class="timeline" aria-label="Timeline">${timeline}</footer>
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
      secureLiveReadOnlyEntry:
        semanticHtml.includes("Connect secure live (read-only)") &&
        semanticHtml.includes("authenticated browser session") &&
        !semanticHtml.includes("Live (not available)"),
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
