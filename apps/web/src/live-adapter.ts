import {
  ReferenceCountedPayloadLease,
  type ChannelId,
  type DisplayLifecycle,
  type NormalizedMessageEnvelope,
  type SourceEpoch,
  type SourceId,
} from "@ros-web-viewer/core-model";

import {
  DesktopShellController,
  type DesktopShellPorts,
  type DisplayKind,
  type DisplayPanel,
  type LiveConnectionSelection,
  type LivePollResult,
  type LiveTelemetrySummary,
  type OpenLiveResult,
  type TopicSummary,
} from "./shell.js";

export interface LiveAdapterTopic {
  readonly id: string;
  readonly name: string;
  readonly schema: {
    readonly typeName: string;
    readonly encoding: string;
    readonly definitionHash?: string;
  };
}

export interface LiveAdapterEnvelope {
  readonly version: 1;
  readonly sourceEpoch: number;
  readonly topicId: string;
  readonly topicName: string;
  readonly sequence: bigint;
  readonly time: {
    readonly sourceTimeNanos: bigint;
    readonly receiptTimeNanos: bigint;
  };
  readonly schema: {
    readonly typeName: string;
    readonly encoding: string;
    readonly definitionHash?: string;
  };
  readonly payload: Uint8Array;
}

export type LiveDisplayLifecycleFactory = (display: DisplayPanel) => DisplayLifecycle;

export interface LiveAdapterTelemetry {
  readonly state: "disconnected" | "connecting" | "connected" | "degraded" | "reconnecting";
  readonly sourceEpoch: number;
  readonly queuedMessages: number;
  readonly queuedBytes: number;
  readonly acceptedMessages: number;
  readonly deliveredMessages: number;
  readonly droppedOversize: number;
  readonly droppedRateLimited: number;
  readonly droppedQueuePressure: number;
  readonly rejectedProtocolFrames: number;
  readonly diagnostic?: string;
}

/** Structural port implemented by @ros-web-viewer/source-live without coupling the web shell to a transport. */
export interface LiveDesktopSourcePort {
  readonly topics: readonly LiveAdapterTopic[];
  readonly telemetry: LiveAdapterTelemetry;
  connect(): Promise<readonly LiveAdapterTopic[]>;
  subscribe(topicIds: readonly string[]): Promise<void>;
  drain(maxMessages?: number): readonly LiveAdapterEnvelope[];
  reconnect(): Promise<readonly LiveAdapterTopic[]>;
  close(): Promise<void>;
}

const nativeDisplays = new Map<string, readonly DisplayKind[]>([
  ["sensor_msgs/msg/Image", ["image", "raw"]],
  ["sensor_msgs/msg/PointCloud2", ["point-cloud", "raw"]],
  ["sensor_msgs/msg/LaserScan", ["laser-scan", "raw"]],
  ["nav_msgs/msg/Path", ["path", "raw"]],
  ["nav_msgs/msg/Odometry", ["odometry", "raw"]],
  ["nav_msgs/msg/OccupancyGrid", ["occupancy-grid", "raw"]],
  ["geometry_msgs/msg/PoseStamped", ["pose", "raw"]],
]);

function topicSummary(topic: LiveAdapterTopic): TopicSummary {
  const availableDisplays = nativeDisplays.get(topic.schema.typeName) ?? (["raw-inspector"] as const);
  return {
    id: topic.id,
    name: topic.name,
    typeName: topic.schema.typeName,
    compatibility: nativeDisplays.has(topic.schema.typeName) ? "native-display" : "schema-backed-generic",
    schemaCapability: "schema-present",
    availableDisplays,
  };
}

function telemetrySummary(telemetry: LiveAdapterTelemetry): LiveTelemetrySummary {
  return {
    state: telemetry.state,
    sourceEpoch: telemetry.sourceEpoch,
    queuedMessages: telemetry.queuedMessages,
    queuedBytes: telemetry.queuedBytes,
    acceptedMessages: telemetry.acceptedMessages,
    deliveredMessages: telemetry.deliveredMessages,
    droppedMessages:
      telemetry.droppedOversize +
      telemetry.droppedRateLimited +
      telemetry.droppedQueuePressure +
      telemetry.rejectedProtocolFrames,
    diagnostic: telemetry.diagnostic,
  };
}

interface RegisteredLiveDisplay {
  readonly topicId: string;
  readonly lifecycle: DisplayLifecycle;
}

export class LiveDesktopAdapter implements DesktopShellPorts {
  readonly #displays = new Map<string, RegisteredLiveDisplay>();
  #source?: LiveDesktopSourcePort;

  constructor(
    private readonly sourceFactory: (selection: LiveConnectionSelection) => LiveDesktopSourcePort,
    private readonly displayFactory?: LiveDisplayLifecycleFactory,
  ) {}

  async connectLive(selection: LiveConnectionSelection): Promise<OpenLiveResult> {
    if (this.#source) {
      try {
        await this.#source.close();
      } finally {
        this.#source = undefined;
        this.#disposeDisplays();
      }
    }
    const source = this.sourceFactory(selection);
    const topics = await source.connect();
    this.#source = source;
    return {
      sourceLabel: "Secure live relay",
      epoch: source.telemetry.sourceEpoch,
      topics: topics.map(topicSummary),
      telemetry: telemetrySummary(source.telemetry),
    };
  }

  async subscribeLive(topicIds: readonly string[]): Promise<void> {
    if (!this.#source) throw new Error("connect secure live mode before subscribing");
    await this.#source.subscribe(topicIds);
  }

  registerLiveDisplay(display: DisplayPanel): void {
    if (!this.#source) throw new Error("connect secure live mode before registering displays");
    if (!this.displayFactory) throw new Error("live display runtime is unavailable");
    if (this.#displays.has(display.id)) throw new Error(`duplicate live display ${display.id}`);
    const lifecycle = this.displayFactory(display);
    try {
      lifecycle.register();
      lifecycle.instantiate();
      lifecycle.configure(display.configuration);
      lifecycle.attachSource(this.#source.telemetry.sourceEpoch as SourceEpoch);
    } catch (error) {
      try { lifecycle.dispose(); } catch { /* preserve the admission error */ }
      throw error;
    }
    this.#displays.set(display.id, { topicId: display.topicId, lifecycle });
  }

  pollLive(): LivePollResult {
    if (!this.#source) throw new Error("connect secure live mode before polling");
    const messages = this.#source.drain();
    const epoch = this.#source.telemetry.sourceEpoch as SourceEpoch;
    let latest: bigint | undefined;
    let displayDeliveries = 0;
    let displayErrors = 0;
    let staleMessageCount = 0;

    for (const message of messages) {
      if (message.sourceEpoch !== epoch) {
        staleMessageCount += 1;
        continue;
      }
      if (latest === undefined || message.time.sourceTimeNanos > latest) latest = message.time.sourceTimeNanos;
      const lease = new ReferenceCountedPayloadLease(epoch, message.payload.byteLength, message.payload);
      const time = { valueNanos: message.time.sourceTimeNanos, source: "clock" as const, epoch };
      const normalized: NormalizedMessageEnvelope = {
        version: 1,
        sourceId: "secure-live" as SourceId,
        channelId: message.topicId as ChannelId,
        sourceSequence: message.sequence,
        epoch,
        schedulingTime: time,
        schema: {
          capability: "schema-present",
          typeName: message.schema.typeName,
          provenance: [{
            providerId: "live-relay",
            providerVersion: "1",
            ...(message.schema.definitionHash === undefined ? {} : { contentHash: message.schema.definitionHash }),
          }],
        },
        payload: lease,
        nativeTypeMetadata: Object.freeze({
          topicName: message.topicName,
          encoding: message.schema.encoding,
          ...(message.schema.definitionHash === undefined ? {} : { definitionHash: message.schema.definitionHash }),
        }),
        diagnostics: Object.freeze([]),
      };
      try {
        for (const { topicId, lifecycle } of this.#displays.values()) {
          if (topicId !== message.topicId) continue;
          lease.retain();
          try {
            lifecycle.update(normalized);
            lifecycle.render();
            displayDeliveries += 1;
          } catch (error) {
            displayErrors += 1;
            this.#handleLifecycleError(lifecycle, error);
          } finally {
            lease.release();
          }
        }
      } finally {
        lease.release();
      }
    }

    return {
      epoch,
      latestSourceTimeNanos: latest,
      messageCount: messages.length,
      telemetry: telemetrySummary(this.#source.telemetry),
      displayDeliveries,
      displayErrors,
      staleMessageCount,
    };
  }

  async reconnectLive(): Promise<OpenLiveResult> {
    if (!this.#source) throw new Error("connect secure live mode before reconnecting");
    const topics = await this.#source.reconnect();
    const epoch = this.#source.telemetry.sourceEpoch as SourceEpoch;
    let firstError: unknown;
    for (const { lifecycle } of this.#displays.values()) {
      try {
        lifecycle.suspend();
        lifecycle.attachSource(epoch);
      } catch (error) {
        firstError ??= error;
        this.#handleLifecycleError(lifecycle, error);
      }
    }
    if (firstError !== undefined) throw firstError;
    return {
      sourceLabel: "Secure live relay",
      epoch,
      topics: topics.map(topicSummary),
      telemetry: telemetrySummary(this.#source.telemetry),
    };
  }

  async disconnectLive(): Promise<void> {
    try {
      await this.#source?.close();
    } finally {
      this.#source = undefined;
      this.#disposeDisplays();
    }
  }

  seek(): Promise<never> {
    return Promise.reject(new Error("recorded seek is unavailable in live mode"));
  }

  #disposeDisplays(): void {
    for (const { lifecycle } of this.#displays.values()) {
      try { lifecycle.dispose(); } catch { /* best-effort teardown */ }
    }
    this.#displays.clear();
  }

  #handleLifecycleError(lifecycle: DisplayLifecycle, error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    try { lifecycle.handleError(normalized); } catch { /* retain the original bounded result */ }
  }
}

export function createLiveDesktopShell(
  sourceFactory: (selection: LiveConnectionSelection) => LiveDesktopSourcePort,
  displayFactory?: LiveDisplayLifecycleFactory,
): {
  readonly controller: DesktopShellController;
  readonly adapter: LiveDesktopAdapter;
} {
  const adapter = new LiveDesktopAdapter(sourceFactory, displayFactory);
  return { controller: new DesktopShellController(adapter), adapter };
}
