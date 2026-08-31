import {
  DesktopShellController,
  type DesktopShellPorts,
  type DisplayKind,
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
  readonly sourceEpoch: number;
  readonly topicId: string;
  readonly sourceTimeNanos?: bigint;
  readonly time?: { readonly sourceTimeNanos: bigint };
}

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

export class LiveDesktopAdapter implements DesktopShellPorts {
  #source?: LiveDesktopSourcePort;

  constructor(private readonly sourceFactory: (selection: LiveConnectionSelection) => LiveDesktopSourcePort) {}

  async connectLive(selection: LiveConnectionSelection): Promise<OpenLiveResult> {
    await this.#source?.close();
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

  pollLive(): LivePollResult {
    if (!this.#source) throw new Error("connect secure live mode before polling");
    const messages = this.#source.drain();
    const latest = messages.reduce<bigint | undefined>((value, message) => {
      const time = message.time?.sourceTimeNanos ?? message.sourceTimeNanos;
      return time === undefined || (value !== undefined && value >= time) ? value : time;
    }, undefined);
    return {
      epoch: this.#source.telemetry.sourceEpoch,
      latestSourceTimeNanos: latest,
      messageCount: messages.length,
      telemetry: telemetrySummary(this.#source.telemetry),
    };
  }

  async reconnectLive(): Promise<OpenLiveResult> {
    if (!this.#source) throw new Error("connect secure live mode before reconnecting");
    const topics = await this.#source.reconnect();
    return {
      sourceLabel: "Secure live relay",
      epoch: this.#source.telemetry.sourceEpoch,
      topics: topics.map(topicSummary),
      telemetry: telemetrySummary(this.#source.telemetry),
    };
  }

  async disconnectLive(): Promise<void> {
    await this.#source?.close();
    this.#source = undefined;
  }

  seek(): Promise<never> {
    return Promise.reject(new Error("recorded seek is unavailable in live mode"));
  }
}

export function createLiveDesktopShell(sourceFactory: (selection: LiveConnectionSelection) => LiveDesktopSourcePort): {
  readonly controller: DesktopShellController;
  readonly adapter: LiveDesktopAdapter;
} {
  const adapter = new LiveDesktopAdapter(sourceFactory);
  return { controller: new DesktopShellController(adapter), adapter };
}
