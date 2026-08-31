import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  DEFAULT_PROTOCOL_LIMITS,
  LIVE_PROTOCOL_VERSION,
  ProtocolViolation,
  parseBrowserFrameJson,
  validateEdgePlan,
  validateTopicDescriptor,
  type BrowserFrame,
  type EdgePlan,
  type EdgeReply,
  type ProtocolLimits,
  type RelayDataEvent,
  type RelayEdgeIdentity,
  type RelayErrorCode,
  type RelayHealth,
  type RelayResponse,
  type SubscribeFrame,
  type TopicDescriptor,
} from "@ros-web-viewer/protocol";

export interface BrowserSessionGrant {
  readonly principalId: string;
  readonly sessionId: string;
  readonly allowedOrigins: readonly string[];
  readonly expiresAtMs: number;
}

export interface BrowserAuthenticator {
  authenticate(credential: string): Promise<BrowserSessionGrant | undefined>;
}

export type RelayTopicPolicy = TopicDescriptor;

export interface RelaySessionPolicy {
  readonly topics: readonly RelayTopicPolicy[];
}

export interface RelayLimits {
  readonly maxCredentialBytes: number;
  readonly maxConnectionsPerSession: number;
  readonly maxSubscriptionsPerSession: number;
  readonly maxDiscoveryTopics: number;
  readonly quotaWindowMs: number;
  readonly maxRequestsPerWindow: number;
  readonly maxRequestBytesPerWindow: number;
  readonly maxQueueMessages: number;
  readonly maxQueueBytes: number;
  readonly maxDrainMessages: number;
  readonly maxDrainBytes: number;
  readonly edgePlanTtlMs: number;
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = Object.freeze({
  maxCredentialBytes: 4 * 1024,
  maxConnectionsPerSession: 2,
  maxSubscriptionsPerSession: 32,
  maxDiscoveryTopics: 256,
  quotaWindowMs: 1_000,
  maxRequestsPerWindow: 100,
  maxRequestBytesPerWindow: 256 * 1024,
  maxQueueMessages: 128,
  maxQueueBytes: 16 * 1024 * 1024,
  maxDrainMessages: 64,
  maxDrainBytes: 8 * 1024 * 1024,
  edgePlanTtlMs: 5_000,
});

export interface EdgeMessage {
  readonly subscriptionId: string;
  readonly sourceSequence: number;
  readonly timestampNanos: string;
  readonly payload: Uint8Array;
}

export interface EdgeTransport {
  request(identity: RelayEdgeIdentity, plan: EdgePlan): Promise<EdgeReply>;
}

export interface RelayConfiguration {
  readonly authenticator: BrowserAuthenticator;
  readonly allowedOrigins: readonly string[];
  readonly resolveSessionPolicy: (grant: BrowserSessionGrant) => RelaySessionPolicy | undefined;
  readonly edgeIdentity: RelayEdgeIdentity;
  readonly edgeTransport: EdgeTransport;
  readonly limits?: Partial<RelayLimits>;
  readonly protocolLimits?: Partial<ProtocolLimits>;
  readonly now?: () => number;
  readonly nonce?: () => string;
}

export interface RelayConnectRequest {
  readonly credential: string;
  readonly origin: string;
  readonly sessionId: string;
  readonly connectionId?: string;
}

export interface RelayTelemetry {
  readonly acceptedConnections: number;
  readonly rejectedConnections: number;
  readonly acceptedFrames: number;
  readonly rejectedFrames: number;
  readonly replayedFrames: number;
  readonly edgeRequests: number;
  readonly edgeFailures: number;
  readonly droppedMessages: number;
  readonly droppedBytes: number;
  readonly activeConnections: number;
}

export class RelayDenied extends Error {
  readonly code: RelayErrorCode;

  constructor(code: RelayErrorCode, message: string) {
    super(message);
    this.name = "RelayDenied";
    this.code = code;
  }
}

interface MutableRelayTelemetry {
  acceptedConnections: number;
  rejectedConnections: number;
  acceptedFrames: number;
  rejectedFrames: number;
  replayedFrames: number;
  edgeRequests: number;
  edgeFailures: number;
  droppedMessages: number;
  droppedBytes: number;
}

interface QueueEntry {
  readonly event: RelayDataEvent;
  readonly chargedBytes: number;
}

interface RateWindow {
  startedAtMs: number;
  messages: number;
}

const encoder = new TextEncoder();

function hash(value: string): Uint8Array {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function exactOrigin(origin: string): string | undefined {
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function frameByteLength(value: string, maximum: number): number {
  if (value.length > maximum) return maximum + 1;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let width: number;
    if (code < 0x80) width = 1;
    else if (code < 0x800) width = 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { width = 4; index += 1; }
      else width = 3;
    } else width = 3;
    if (width > maximum - bytes) return maximum + 1;
    bytes += width;
  }
  return bytes;
}

function mergeLimits(overrides: Partial<RelayLimits> | undefined): RelayLimits {
  const merged = { ...DEFAULT_RELAY_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(merged)) positiveSafeInteger(value, name);
  if (merged.maxDrainMessages > merged.maxQueueMessages || merged.maxDrainBytes > merged.maxQueueBytes) {
    throw new Error("drain limits cannot exceed queue limits");
  }
  return Object.freeze(merged);
}

function mergeProtocolLimits(overrides: Partial<ProtocolLimits> | undefined): ProtocolLimits {
  const merged = { ...DEFAULT_PROTOCOL_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(merged)) positiveSafeInteger(value, name);
  return Object.freeze(merged);
}

function allowlistDigest(topics: readonly RelayTopicPolicy[]): string {
  const canonical = topics
    .map(({ topic, type, maxRateHz, maxMessageBytes }) => ({ topic, type, maxRateHz, maxMessageBytes }))
    .sort((left, right) => `${left.topic}\0${left.type}`.localeCompare(`${right.topic}\0${right.type}`));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function publicError(code: RelayErrorCode, requestId?: string): RelayResponse {
  const message = code === "unauthorized" ? "connection is not authorized" : "request was rejected";
  return Object.freeze({ version: LIVE_PROTOCOL_VERSION, kind: "error", requestId, code, message });
}

export class InMemorySessionAuthenticator implements BrowserAuthenticator {
  readonly #grants: readonly Readonly<{ digest: Uint8Array; grant: BrowserSessionGrant }>[];

  constructor(entries: readonly Readonly<{ credential: string; grant: BrowserSessionGrant }>[]) {
    this.#grants = entries.map(({ credential, grant }) => {
      if (!credential) throw new Error("browser credential must not be empty");
      return Object.freeze({
        digest: hash(credential),
        grant: Object.freeze({ ...grant, allowedOrigins: Object.freeze([...grant.allowedOrigins]) }),
      });
    });
  }

  async authenticate(credential: string): Promise<BrowserSessionGrant | undefined> {
    const presented = hash(credential);
    let grant: BrowserSessionGrant | undefined;
    for (const candidate of this.#grants) {
      if (safeEqual(candidate.digest, presented)) grant = candidate.grant;
    }
    return grant;
  }
}

export class SecureLiveRelay {
  readonly #authenticator: BrowserAuthenticator;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #resolveSessionPolicy: RelayConfiguration["resolveSessionPolicy"];
  readonly #edgeIdentity: RelayEdgeIdentity;
  readonly #edgeTransport: EdgeTransport;
  readonly #limits: RelayLimits;
  readonly #protocolLimits: ProtocolLimits;
  readonly #now: () => number;
  readonly #nonce: () => string;
  readonly #connections = new Map<string, RelayConnection>();
  readonly #sessionConnections = new Map<string, Set<string>>();
  readonly #sessionSequences = new Map<string, number>();
  readonly #sessionEpochs = new Map<string, number>();
  readonly #telemetry: MutableRelayTelemetry = {
    acceptedConnections: 0,
    rejectedConnections: 0,
    acceptedFrames: 0,
    rejectedFrames: 0,
    replayedFrames: 0,
    edgeRequests: 0,
    edgeFailures: 0,
    droppedMessages: 0,
    droppedBytes: 0,
  };

  constructor(configuration: RelayConfiguration) {
    this.#authenticator = configuration.authenticator;
    this.#resolveSessionPolicy = configuration.resolveSessionPolicy;
    this.#edgeTransport = configuration.edgeTransport;
    this.#limits = mergeLimits(configuration.limits);
    this.#protocolLimits = mergeProtocolLimits(configuration.protocolLimits);
    this.#now = configuration.now ?? Date.now;
    this.#nonce = configuration.nonce ?? randomUUID;
    this.#allowedOrigins = new Set(configuration.allowedOrigins.map((origin) => {
      const normalized = exactOrigin(origin);
      if (!normalized) throw new Error("allowedOrigins must contain exact HTTP(S) origins");
      return normalized;
    }));
    if (this.#allowedOrigins.size === 0) throw new Error("at least one allowed Origin is required");
    if (!configuration.edgeIdentity.identityId || !configuration.edgeIdentity.credential) {
      throw new Error("a distinct relay-to-edge identity and credential are required");
    }
    this.#edgeIdentity = Object.freeze({ ...configuration.edgeIdentity });
  }

  async connect(request: RelayConnectRequest): Promise<RelayConnection> {
    const reject = (): never => {
      this.#telemetry.rejectedConnections += 1;
      throw new RelayDenied("unauthorized", "connection is not authorized");
    };
    const origin = exactOrigin(request.origin);
    if (
      !origin ||
      !this.#allowedOrigins.has(origin) ||
      !request.credential ||
      request.credential === this.#edgeIdentity.credential ||
      encoder.encode(request.credential).byteLength > this.#limits.maxCredentialBytes
    ) return reject();

    let grant: BrowserSessionGrant | undefined;
    try {
      grant = await this.#authenticator.authenticate(request.credential);
    } catch {
      return reject();
    }
    if (
      !grant ||
      grant.sessionId !== request.sessionId ||
      grant.expiresAtMs <= this.#now() ||
      !grant.allowedOrigins.includes(origin)
    ) return reject();

    const policy = this.#resolveSessionPolicy(grant);
    if (!policy) return reject();
    const validatedTopics = policy.topics.map((topic) => validateTopicDescriptor(topic, this.#protocolLimits));
    const existing = this.#sessionConnections.get(grant.sessionId) ?? new Set<string>();
    if (existing.size >= this.#limits.maxConnectionsPerSession) return reject();

    const connectionId = request.connectionId ?? this.#nonce();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(connectionId) || this.#connections.has(connectionId)) return reject();
    const epoch = (this.#sessionEpochs.get(grant.sessionId) ?? 0) + 1;
    this.#sessionEpochs.set(grant.sessionId, epoch);
    const connection = new RelayConnection({
      service: this,
      connectionId,
      connectionEpoch: epoch,
      grant,
      policy: Object.freeze({ topics: Object.freeze(validatedTopics) }),
      limits: this.#limits,
      protocolLimits: this.#protocolLimits,
      now: this.#now,
      nonce: this.#nonce,
    });
    existing.add(connectionId);
    this.#sessionConnections.set(grant.sessionId, existing);
    this.#connections.set(connectionId, connection);
    this.#telemetry.acceptedConnections += 1;
    return connection;
  }

  telemetry(): RelayTelemetry {
    return Object.freeze({ ...this.#telemetry, activeConnections: this.#connections.size });
  }

  consumeSequence(sessionId: string, sequence: number): boolean {
    const previous = this.#sessionSequences.get(sessionId) ?? -1;
    if (sequence <= previous) {
      this.#telemetry.replayedFrames += 1;
      return false;
    }
    this.#sessionSequences.set(sessionId, sequence);
    return true;
  }

  acceptedFrame(): void {
    this.#telemetry.acceptedFrames += 1;
  }

  rejectedFrame(): void {
    this.#telemetry.rejectedFrames += 1;
  }

  dropped(bytes: number): void {
    this.#telemetry.droppedMessages += 1;
    this.#telemetry.droppedBytes += bytes;
  }

  async requestEdge(plan: EdgePlan): Promise<EdgeReply> {
    this.#telemetry.edgeRequests += 1;
    try {
      return await this.#edgeTransport.request(this.#edgeIdentity, plan);
    } catch {
      this.#telemetry.edgeFailures += 1;
      throw new RelayDenied("edge-unavailable", "request was rejected");
    }
  }

  remove(connection: RelayConnection): void {
    this.#connections.delete(connection.connectionId);
    const connections = this.#sessionConnections.get(connection.sessionId);
    connections?.delete(connection.connectionId);
    if (connections?.size === 0) this.#sessionConnections.delete(connection.sessionId);
  }
}

interface RelayConnectionOptions {
  readonly service: SecureLiveRelay;
  readonly connectionId: string;
  readonly connectionEpoch: number;
  readonly grant: BrowserSessionGrant;
  readonly policy: RelaySessionPolicy;
  readonly limits: RelayLimits;
  readonly protocolLimits: ProtocolLimits;
  readonly now: () => number;
  readonly nonce: () => string;
}

export class RelayConnection {
  readonly connectionId: string;
  readonly connectionEpoch: number;
  readonly sessionId: string;
  readonly #service: SecureLiveRelay;
  readonly #grant: BrowserSessionGrant;
  readonly #policy: RelaySessionPolicy;
  readonly #limits: RelayLimits;
  readonly #protocolLimits: ProtocolLimits;
  readonly #now: () => number;
  readonly #nonce: () => string;
  readonly #allowlistDigest: string;
  readonly #subscriptions = new Map<string, SubscribeFrame>();
  readonly #messageWindows = new Map<string, RateWindow>();
  readonly #queue: QueueEntry[] = [];
  #queueBytes = 0;
  #queueHighWaterMessages = 0;
  #queueHighWaterBytes = 0;
  #droppedMessages = 0;
  #droppedBytes = 0;
  #rejectedFrames = 0;
  #windowStartedAtMs: number;
  #windowRequests = 0;
  #windowBytes = 0;
  #edgeSequence = 0;
  #closed = false;

  constructor(options: RelayConnectionOptions) {
    this.connectionId = options.connectionId;
    this.connectionEpoch = options.connectionEpoch;
    this.sessionId = options.grant.sessionId;
    this.#service = options.service;
    this.#grant = options.grant;
    this.#policy = options.policy;
    this.#limits = options.limits;
    this.#protocolLimits = options.protocolLimits;
    this.#now = options.now;
    this.#nonce = options.nonce;
    this.#allowlistDigest = allowlistDigest(options.policy.topics);
    this.#windowStartedAtMs = this.#now();
  }

  get closed(): boolean {
    return this.#closed;
  }

  async handle(input: string): Promise<RelayResponse> {
    if (this.#closed) return this.#reject("closed");
    if (typeof input !== "string") return this.#reject("invalid-request");
    const chargedBytes = frameByteLength(input, this.#protocolLimits.maxFrameBytes);
    if (!this.#chargeRequest(chargedBytes)) return this.#reject("quota-exceeded");

    let frame: BrowserFrame;
    try {
      frame = parseBrowserFrameJson(input, this.#protocolLimits);
    } catch (error) {
      if (error instanceof ProtocolViolation) return this.#reject("invalid-request");
      return this.#reject("invalid-request");
    }
    if (frame.sessionId !== this.sessionId || this.#grant.expiresAtMs <= this.#now()) {
      return this.#reject("unauthorized", frame.requestId);
    }
    if (!this.#service.consumeSequence(this.sessionId, frame.sequence)) {
      return this.#reject("replayed-request", frame.requestId);
    }

    this.#service.acceptedFrame();
    try {
      switch (frame.operation) {
        case "discover":
          return await this.#discover(frame);
        case "subscribe":
          return await this.#subscribe(frame);
        case "unsubscribe":
          return await this.#unsubscribe(frame);
        case "health":
          return Object.freeze({
            version: LIVE_PROTOCOL_VERSION,
            kind: "health",
            requestId: frame.requestId,
            health: this.health(),
          });
      }
    } catch (error) {
      if (error instanceof RelayDenied) return this.#reject(error.code, frame.requestId);
      return this.#reject("edge-unavailable", frame.requestId);
    }
  }

  async #discover(frame: Extract<BrowserFrame, { operation: "discover" }>): Promise<RelayResponse> {
    const reply = await this.#service.requestEdge(this.#plan({ operation: "discover" }));
    if (reply.kind !== "discovery") throw new RelayDenied("edge-unavailable", "request was rejected");
    if (!Array.isArray(reply.topics) || reply.topics.length > this.#limits.maxDiscoveryTopics) {
      throw new RelayDenied("edge-unavailable", "request was rejected");
    }
    const allowed = new Map(this.#policy.topics.map((topic) => [`${topic.topic}\0${topic.type}`, topic]));
    const topics = reply.topics
      .map((topic) => validateTopicDescriptor(topic, this.#protocolLimits))
      .filter((topic) => allowed.has(`${topic.topic}\0${topic.type}`))
      .map((topic) => {
        const policy = allowed.get(`${topic.topic}\0${topic.type}`)!;
        return Object.freeze({
          ...topic,
          maxRateHz: Math.min(topic.maxRateHz, policy.maxRateHz),
          maxMessageBytes: Math.min(topic.maxMessageBytes, policy.maxMessageBytes),
        });
      });
    return Object.freeze({
      version: LIVE_PROTOCOL_VERSION,
      kind: "discovery",
      requestId: frame.requestId,
      topics: Object.freeze(topics),
    });
  }

  async #subscribe(frame: SubscribeFrame): Promise<RelayResponse> {
    if (this.#subscriptions.has(frame.subscriptionId)) throw new RelayDenied("policy-denied", "request was rejected");
    if (this.#subscriptions.size >= this.#limits.maxSubscriptionsPerSession) {
      throw new RelayDenied("quota-exceeded", "request was rejected");
    }
    const allowed = this.#policy.topics.find(({ topic, type }) => topic === frame.topic && type === frame.type);
    if (!allowed || frame.maxRateHz > allowed.maxRateHz || frame.maxMessageBytes > allowed.maxMessageBytes) {
      throw new RelayDenied("policy-denied", "request was rejected");
    }
    const reply = await this.#service.requestEdge(this.#plan({
      operation: "subscribe",
      subscriptionId: frame.subscriptionId,
      topic: frame.topic,
      type: frame.type,
      maxRateHz: frame.maxRateHz,
      maxMessageBytes: frame.maxMessageBytes,
    }));
    if (reply.kind !== "ack" || reply.operation !== "subscribe") {
      throw new RelayDenied("edge-unavailable", "request was rejected");
    }
    this.#subscriptions.set(frame.subscriptionId, frame);
    return Object.freeze({
      version: LIVE_PROTOCOL_VERSION,
      kind: "ack",
      requestId: frame.requestId,
      operation: "subscribe",
    });
  }

  async #unsubscribe(frame: Extract<BrowserFrame, { operation: "unsubscribe" }>): Promise<RelayResponse> {
    if (!this.#subscriptions.has(frame.subscriptionId)) throw new RelayDenied("policy-denied", "request was rejected");
    const reply = await this.#service.requestEdge(this.#plan({ operation: "unsubscribe", subscriptionId: frame.subscriptionId }));
    if (reply.kind !== "ack" || reply.operation !== "unsubscribe") {
      throw new RelayDenied("edge-unavailable", "request was rejected");
    }
    this.#subscriptions.delete(frame.subscriptionId);
    this.#messageWindows.delete(frame.subscriptionId);
    return Object.freeze({
      version: LIVE_PROTOCOL_VERSION,
      kind: "ack",
      requestId: frame.requestId,
      operation: "unsubscribe",
    });
  }

  #plan(operation: Pick<EdgePlan, "operation"> & Record<string, unknown>): EdgePlan {
    const issuedAtMs = this.#now();
    const expiresAtMs = Math.min(issuedAtMs + this.#limits.edgePlanTtlMs, this.#grant.expiresAtMs);
    const plan = {
      version: LIVE_PROTOCOL_VERSION,
      ...operation,
      sessionId: this.sessionId,
      connectionId: this.connectionId,
      sequence: this.#edgeSequence++,
      nonce: this.#nonce(),
      issuedAtMs,
      expiresAtMs,
      allowlistDigest: this.#allowlistDigest,
    };
    return validateEdgePlan(plan, {
      nowMs: issuedAtMs,
      maxTtlMs: this.#limits.edgePlanTtlMs,
      limits: this.#protocolLimits,
    });
  }

  pushFromEdge(message: EdgeMessage): boolean {
    if (this.#closed) return false;
    const subscription = this.#subscriptions.get(message.subscriptionId);
    if (
      !subscription ||
      !Number.isSafeInteger(message.sourceSequence) ||
      message.sourceSequence < 0 ||
      !/^(0|[1-9][0-9]*)$/u.test(message.timestampNanos) ||
      !(message.payload instanceof Uint8Array) ||
      message.payload.byteLength > subscription.maxMessageBytes ||
      message.payload.byteLength > this.#protocolLimits.maxMessageBytes ||
      !this.#admitRate(subscription)
    ) {
      this.#drop(message.payload instanceof Uint8Array ? message.payload.byteLength : 0);
      return false;
    }
    const event: RelayDataEvent = Object.freeze({
      version: LIVE_PROTOCOL_VERSION,
      kind: "message",
      subscriptionId: message.subscriptionId,
      sourceSequence: message.sourceSequence,
      timestampNanos: message.timestampNanos,
      payload: message.payload,
    });
    const chargedBytes = message.payload.byteLength + 128;
    if (chargedBytes > this.#limits.maxQueueBytes) {
      this.#drop(chargedBytes);
      return false;
    }
    while (
      this.#queue.length >= this.#limits.maxQueueMessages ||
      this.#queueBytes + chargedBytes > this.#limits.maxQueueBytes
    ) {
      const dropped = this.#queue.shift();
      if (!dropped) break;
      this.#queueBytes -= dropped.chargedBytes;
      this.#drop(dropped.chargedBytes);
    }
    this.#queue.push({ event, chargedBytes });
    this.#queueBytes += chargedBytes;
    this.#queueHighWaterMessages = Math.max(this.#queueHighWaterMessages, this.#queue.length);
    this.#queueHighWaterBytes = Math.max(this.#queueHighWaterBytes, this.#queueBytes);
    return true;
  }

  drain(options: Readonly<{ maxMessages?: number; maxBytes?: number }> = {}): readonly RelayDataEvent[] {
    if (this.#closed) return Object.freeze([]);
    const maxMessages = options.maxMessages ?? this.#limits.maxDrainMessages;
    const maxBytes = options.maxBytes ?? this.#limits.maxDrainBytes;
    if (
      !Number.isSafeInteger(maxMessages) || maxMessages <= 0 || maxMessages > this.#limits.maxDrainMessages ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > this.#limits.maxDrainBytes
    ) throw new RelayDenied("quota-exceeded", "request was rejected");
    const events: RelayDataEvent[] = [];
    let bytes = 0;
    while (events.length < maxMessages) {
      const next = this.#queue[0];
      if (!next || bytes + next.chargedBytes > maxBytes) break;
      this.#queue.shift();
      this.#queueBytes -= next.chargedBytes;
      bytes += next.chargedBytes;
      events.push(next.event);
    }
    return Object.freeze(events);
  }

  health(): RelayHealth {
    return Object.freeze({
      state: this.#closed ? "closed" : "open",
      connectionEpoch: this.connectionEpoch,
      activeSubscriptions: this.#subscriptions.size,
      queueDepth: this.#queue.length,
      queueBytes: this.#queueBytes,
      queueHighWaterMessages: this.#queueHighWaterMessages,
      queueHighWaterBytes: this.#queueHighWaterBytes,
      droppedMessages: this.#droppedMessages,
      droppedBytes: this.#droppedBytes,
      rejectedFrames: this.#rejectedFrames,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const subscriptions = [...this.#subscriptions.keys()];
    this.#subscriptions.clear();
    this.#messageWindows.clear();
    this.#queue.length = 0;
    this.#queueBytes = 0;
    await Promise.allSettled(subscriptions.map(async (subscriptionId) => {
      await this.#service.requestEdge(this.#plan({ operation: "unsubscribe", subscriptionId }));
    }));
    this.#service.remove(this);
  }

  #chargeRequest(bytes: number): boolean {
    const now = this.#now();
    if (now - this.#windowStartedAtMs >= this.#limits.quotaWindowMs) {
      this.#windowStartedAtMs = now;
      this.#windowRequests = 0;
      this.#windowBytes = 0;
    }
    if (
      !Number.isSafeInteger(bytes) ||
      this.#windowRequests + 1 > this.#limits.maxRequestsPerWindow ||
      this.#windowBytes + bytes > this.#limits.maxRequestBytesPerWindow
    ) return false;
    this.#windowRequests += 1;
    this.#windowBytes += bytes;
    return true;
  }

  #admitRate(subscription: SubscribeFrame): boolean {
    const now = this.#now();
    const window = this.#messageWindows.get(subscription.subscriptionId) ?? { startedAtMs: now, messages: 0 };
    if (now - window.startedAtMs >= 1_000) {
      window.startedAtMs = now;
      window.messages = 0;
    }
    if (window.messages >= subscription.maxRateHz) return false;
    window.messages += 1;
    this.#messageWindows.set(subscription.subscriptionId, window);
    return true;
  }

  #drop(bytes: number): void {
    this.#droppedMessages += 1;
    this.#droppedBytes += bytes;
    this.#service.dropped(bytes);
  }

  #reject(code: RelayErrorCode, requestId?: string): RelayResponse {
    this.#rejectedFrames += 1;
    this.#service.rejectedFrame();
    return publicError(code, requestId);
  }
}

export const relayShell = "relay-shell";
