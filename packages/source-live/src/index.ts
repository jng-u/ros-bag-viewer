export interface LiveSourceLimits {
  readonly maxTopicsPerSubscription: number;
  readonly maxMessageBytes: number;
  readonly maxMessagesPerSecond: number;
  readonly maxQueueMessages: number;
  readonly maxQueueBytes: number;
}

export const DEFAULT_LIVE_SOURCE_LIMITS: LiveSourceLimits = Object.freeze({
  maxTopicsPerSubscription: 32,
  maxMessageBytes: 4 * 1024 * 1024,
  maxMessagesPerSecond: 2_000,
  maxQueueMessages: 2_048,
  maxQueueBytes: 16 * 1024 * 1024,
});

export interface LiveSessionCredentials {
  readonly browserOrigin: string;
  readonly sessionToken: string;
}

export interface LiveSessionBinding {
  readonly browserOrigin: string;
  readonly sessionId: string;
}

export interface LiveTopicSchema {
  readonly typeName: string;
  readonly encoding: string;
  readonly definitionHash?: string;
}

export interface LiveTopic {
  readonly id: string;
  readonly name: string;
  readonly schema: LiveTopicSchema;
}

export interface LiveRelayFrame {
  readonly topicId: string;
  readonly sequence: bigint;
  readonly sourceTimeNanos: bigint;
  readonly receiptTimeNanos: bigint;
  readonly receivedAtMillis: number;
  readonly payload: Uint8Array;
}

export interface LiveRelaySubscription {
  close(): Promise<void>;
}

/**
 * Deliberately subscribe-only. Implementations cannot surface publish, service,
 * action, parameter, or arbitrary-command primitives through this contract.
 */
export interface LiveRelayConnection {
  readonly binding: LiveSessionBinding;
  discoverTopics(): Promise<readonly LiveTopic[]>;
  subscribe(topicIds: readonly string[], onFrame: (frame: LiveRelayFrame) => void): Promise<LiveRelaySubscription>;
  close(): Promise<void>;
}

export interface LiveRelayTransport {
  connect(credentials: LiveSessionCredentials): Promise<LiveRelayConnection>;
}

export interface LiveMessageEnvelope {
  readonly version: 1;
  readonly sourceEpoch: number;
  readonly topicId: string;
  readonly topicName: string;
  readonly sequence: bigint;
  readonly time: {
    readonly sourceTimeNanos: bigint;
    readonly receiptTimeNanos: bigint;
  };
  readonly schema: LiveTopicSchema;
  readonly payload: Uint8Array;
}

export interface LiveSourceTelemetry {
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
  readonly reconnects: number;
  readonly diagnostic?: string;
}

interface MutableTelemetry {
  state: LiveSourceTelemetry["state"];
  sourceEpoch: number;
  queuedMessages: number;
  queuedBytes: number;
  acceptedMessages: number;
  deliveredMessages: number;
  droppedOversize: number;
  droppedRateLimited: number;
  droppedQueuePressure: number;
  rejectedProtocolFrames: number;
  reconnects: number;
  diagnostic?: string;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
}

function assertLimits(limits: LiveSourceLimits): void {
  for (const [name, value] of Object.entries(limits)) assertPositiveInteger(name, value);
  if (limits.maxMessageBytes > limits.maxQueueBytes) {
    throw new Error("maxMessageBytes cannot exceed maxQueueBytes");
  }
}

function assertCredentials(credentials: LiveSessionCredentials): void {
  let origin: URL;
  try {
    origin = new URL(credentials.browserOrigin);
  } catch {
    throw new Error("browserOrigin must be an absolute origin URL");
  }
  if (origin.origin !== credentials.browserOrigin || !["https:", "http:"].includes(origin.protocol)) {
    throw new Error("browserOrigin must contain only an http(s) origin");
  }
  if (!credentials.sessionToken.trim()) throw new Error("sessionToken is required");
}

function compareEnvelopes(left: LiveMessageEnvelope, right: LiveMessageEnvelope): number {
  if (left.time.sourceTimeNanos !== right.time.sourceTimeNanos) {
    return left.time.sourceTimeNanos < right.time.sourceTimeNanos ? -1 : 1;
  }
  const topicOrder = left.topicId.localeCompare(right.topicId);
  if (topicOrder !== 0) return topicOrder;
  if (left.sequence === right.sequence) return 0;
  return left.sequence < right.sequence ? -1 : 1;
}

export class BoundedLiveSource {
  readonly #transport: LiveRelayTransport;
  readonly #credentials: LiveSessionCredentials;
  readonly #limits: LiveSourceLimits;
  readonly #topics = new Map<string, LiveTopic>();
  readonly #queue: LiveMessageEnvelope[] = [];
  readonly #telemetry: MutableTelemetry = {
    state: "disconnected",
    sourceEpoch: 0,
    queuedMessages: 0,
    queuedBytes: 0,
    acceptedMessages: 0,
    deliveredMessages: 0,
    droppedOversize: 0,
    droppedRateLimited: 0,
    droppedQueuePressure: 0,
    rejectedProtocolFrames: 0,
    reconnects: 0,
  };
  #connection?: LiveRelayConnection;
  #subscription?: LiveRelaySubscription;
  #subscribedTopicIds = new Set<string>();
  #rateSecond?: number;
  #rateCount = 0;

  constructor(
    transport: LiveRelayTransport,
    credentials: LiveSessionCredentials,
    limits: LiveSourceLimits = DEFAULT_LIVE_SOURCE_LIMITS,
  ) {
    assertCredentials(credentials);
    assertLimits(limits);
    this.#transport = transport;
    this.#credentials = credentials;
    this.#limits = Object.freeze({ ...limits });
  }

  get topics(): readonly LiveTopic[] {
    return [...this.#topics.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  get telemetry(): LiveSourceTelemetry {
    return Object.freeze({ ...this.#telemetry });
  }

  async connect(): Promise<readonly LiveTopic[]> {
    if (this.#connection || this.#telemetry.state !== "disconnected") {
      throw new Error("live source is already connected or connecting");
    }
    this.#telemetry.state = this.#telemetry.sourceEpoch === 0 ? "connecting" : "reconnecting";
    let connection: LiveRelayConnection;
    try {
      connection = await this.#transport.connect(this.#credentials);
    } catch (error) {
      this.#telemetry.state = "disconnected";
      throw error;
    }
    if (connection.binding.browserOrigin !== this.#credentials.browserOrigin) {
      await connection.close();
      this.#telemetry.state = "disconnected";
      throw new Error("relay origin binding does not match the browser session");
    }
    if (!connection.binding.sessionId.trim()) {
      await connection.close();
      this.#telemetry.state = "disconnected";
      throw new Error("relay returned an empty bound session id");
    }

    let discovered: readonly LiveTopic[];
    try {
      discovered = await connection.discoverTopics();
    } catch (error) {
      await connection.close();
      this.#telemetry.state = "disconnected";
      throw error;
    }
    const topics = new Map<string, LiveTopic>();
    for (const topic of discovered) {
      if (!topic.id || !topic.name.startsWith("/") || !topic.schema.typeName || !topic.schema.encoding) {
        await connection.close();
        this.#telemetry.state = "disconnected";
        throw new Error("relay returned an invalid topic catalog");
      }
      if (topic.id === "*" || topic.name.includes("*")) {
        await connection.close();
        this.#telemetry.state = "disconnected";
        throw new Error("wildcard topics are not permitted");
      }
      if (topics.has(topic.id)) {
        await connection.close();
        this.#telemetry.state = "disconnected";
        throw new Error(`relay returned duplicate topic id ${topic.id}`);
      }
      topics.set(topic.id, Object.freeze({ ...topic, schema: Object.freeze({ ...topic.schema }) }));
    }

    this.#connection = connection;
    this.#topics.clear();
    for (const [id, topic] of topics) this.#topics.set(id, topic);
    this.#telemetry.sourceEpoch += 1;
    if (this.#telemetry.sourceEpoch > 1) this.#telemetry.reconnects += 1;
    this.#telemetry.state = "connected";
    this.#telemetry.diagnostic = undefined;
    return this.topics;
  }

  async reconnect(): Promise<readonly LiveTopic[]> {
    const topics = [...this.#subscribedTopicIds];
    await this.#closeConnection();
    const discovered = await this.connect();
    if (topics.length > 0) await this.subscribe(topics);
    return discovered;
  }

  async subscribe(topicIds: readonly string[]): Promise<void> {
    const connection = this.#connection;
    if (!connection) throw new Error("connect before subscribing");
    const unique = [...new Set(topicIds)];
    if (unique.length === 0) throw new Error("at least one explicit topic is required");
    if (unique.length > this.#limits.maxTopicsPerSubscription) throw new Error("subscription exceeds maxTopicsPerSubscription");
    for (const topicId of unique) {
      if (topicId === "*" || topicId.includes("*")) throw new Error("wildcard subscriptions are not permitted");
      if (!this.#topics.has(topicId)) throw new Error(`topic ${topicId} is not in the discovered catalog`);
    }
    await this.#subscription?.close();
    this.#subscribedTopicIds = new Set(unique);
    const epoch = this.#telemetry.sourceEpoch;
    this.#subscription = await connection.subscribe(Object.freeze(unique), (frame) => this.#acceptFrame(frame, epoch));
  }

  async unsubscribe(): Promise<void> {
    await this.#subscription?.close();
    this.#subscription = undefined;
    this.#subscribedTopicIds.clear();
  }

  drain(maxMessages = this.#limits.maxQueueMessages): readonly LiveMessageEnvelope[] {
    assertPositiveInteger("maxMessages", maxMessages);
    const drained = this.#queue.splice(0, maxMessages);
    const drainedBytes = drained.reduce((total, envelope) => total + envelope.payload.byteLength, 0);
    this.#telemetry.queuedMessages = this.#queue.length;
    this.#telemetry.queuedBytes -= drainedBytes;
    this.#telemetry.deliveredMessages += drained.length;
    return drained;
  }

  async close(): Promise<void> {
    await this.#closeConnection();
  }

  #acceptFrame(frame: LiveRelayFrame, callbackEpoch: number): void {
    const topic = this.#topics.get(frame.topicId);
    if (
      callbackEpoch !== this.#telemetry.sourceEpoch ||
      !topic ||
      !this.#subscribedTopicIds.has(frame.topicId) ||
      frame.sequence < 0n ||
      frame.sourceTimeNanos < 0n ||
      frame.receiptTimeNanos < 0n ||
      !Number.isSafeInteger(frame.receivedAtMillis) ||
      frame.receivedAtMillis < 0
    ) {
      this.#telemetry.rejectedProtocolFrames += 1;
      if (this.#telemetry.state !== "disconnected") {
        this.#degrade("A relay frame violated the bound subscription protocol.");
      }
      return;
    }
    if (frame.payload.byteLength > this.#limits.maxMessageBytes) {
      this.#telemetry.droppedOversize += 1;
      this.#degrade("An oversized live message was dropped.");
      return;
    }

    const second = Math.floor(frame.receivedAtMillis / 1_000);
    if (this.#rateSecond !== undefined && second < this.#rateSecond) {
      this.#telemetry.rejectedProtocolFrames += 1;
      this.#degrade("A relay frame used a non-monotonic receipt window.");
      return;
    }
    if (this.#rateSecond !== second) {
      this.#rateSecond = second;
      this.#rateCount = 0;
    }
    if (this.#rateCount >= this.#limits.maxMessagesPerSecond) {
      this.#telemetry.droppedRateLimited += 1;
      this.#degrade("The live message rate exceeded its session limit.");
      return;
    }
    this.#rateCount += 1;

    const payload = frame.payload.slice();
    const envelope: LiveMessageEnvelope = Object.freeze({
      version: 1,
      sourceEpoch: callbackEpoch,
      topicId: topic.id,
      topicName: topic.name,
      sequence: frame.sequence,
      time: Object.freeze({ sourceTimeNanos: frame.sourceTimeNanos, receiptTimeNanos: frame.receiptTimeNanos }),
      schema: topic.schema,
      payload,
    });
    this.#queue.push(envelope);
    this.#queue.sort(compareEnvelopes);
    this.#telemetry.acceptedMessages += 1;
    this.#telemetry.queuedBytes += payload.byteLength;
    while (
      this.#queue.length > this.#limits.maxQueueMessages ||
      this.#telemetry.queuedBytes > this.#limits.maxQueueBytes
    ) {
      const dropped = this.#queue.shift();
      if (!dropped) break;
      this.#telemetry.queuedBytes -= dropped.payload.byteLength;
      this.#telemetry.droppedQueuePressure += 1;
      this.#degrade("Live queue pressure dropped the oldest message.");
    }
    this.#telemetry.queuedMessages = this.#queue.length;
  }

  #degrade(diagnostic: string): void {
    this.#telemetry.state = "degraded";
    this.#telemetry.diagnostic = diagnostic;
  }

  async #closeConnection(): Promise<void> {
    await this.unsubscribe();
    await this.#connection?.close();
    this.#connection = undefined;
    this.#topics.clear();
    this.#rateSecond = undefined;
    this.#rateCount = 0;
    this.#queue.length = 0;
    this.#telemetry.queuedMessages = 0;
    this.#telemetry.queuedBytes = 0;
    this.#telemetry.state = "disconnected";
  }
}
