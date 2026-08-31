export type RosGeneration = "ros1" | "ros2";

export interface TopicDescriptor {
  readonly topic: string;
  readonly type: string;
  readonly maxRateHz: number;
  readonly maxMessageBytes: number;
  readonly schemaHash?: string;
}

interface EdgePlanBase {
  readonly version: 1;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly sequence: number;
  readonly nonce: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly allowlistDigest: string;
}

export type EdgePlan =
  | (EdgePlanBase & { readonly operation: "discover" })
  | (EdgePlanBase & {
      readonly operation: "subscribe";
      readonly subscriptionId: string;
      readonly topic: string;
      readonly type: string;
      readonly maxRateHz: number;
      readonly maxMessageBytes: number;
    })
  | (EdgePlanBase & { readonly operation: "unsubscribe"; readonly subscriptionId: string });

export interface RelayEdgeIdentity {
  readonly identityId: string;
  readonly credential: string;
}

export type EdgeReply =
  | Readonly<{ version: 1; kind: "discovery"; topics: readonly TopicDescriptor[] }>
  | Readonly<{ version: 1; kind: "ack"; operation: "subscribe" | "unsubscribe" }>;

export interface PrivateListenerConfig {
  readonly host: string;
  readonly port: number;
  readonly tls: true;
}

export interface EdgeRuntimeLimits {
  readonly maxCommandBytes: number;
  readonly maxCommandsPerWindow: number;
  readonly commandWindowMs: number;
  readonly maxPlanTtlMs: number;
  readonly maxTrackedConnections: number;
  readonly maxSubscriptions: number;
  readonly maxFrameBytes: number;
  readonly maxQueuedFramesPerSubscription: number;
  readonly maxBufferedBytes: number;
  readonly maxTelemetryEvents: number;
}

export const DEFAULT_EDGE_RUNTIME_LIMITS: EdgeRuntimeLimits = Object.freeze({
  maxCommandBytes: 16 * 1024,
  maxCommandsPerWindow: 120,
  commandWindowMs: 60_000,
  maxPlanTtlMs: 30_000,
  maxTrackedConnections: 64,
  maxSubscriptions: 32,
  maxFrameBytes: 4 * 1024 * 1024,
  maxQueuedFramesPerSubscription: 8,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxTelemetryEvents: 128,
});

export interface EdgeRuntimeConfig {
  readonly generation: RosGeneration;
  readonly listener: PrivateListenerConfig;
  readonly allowedRelayIds: readonly string[];
  readonly allowedTopics: readonly TopicDescriptor[];
  readonly allowlistDigest: string;
  readonly verifyRelayCredential: (identity: RelayEdgeIdentity) => boolean;
  readonly limits?: EdgeRuntimeLimits;
}

export interface DiscoveredTopic {
  readonly topic: string;
  readonly type: string;
  readonly schemaHash?: string;
}

export interface EdgeReadPort {
  discover(signal: AbortSignal): Promise<readonly DiscoveredTopic[]>;
  subscribe(
    topic: string,
    type: string,
    onFrame: (payload: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<{ close(): void | Promise<void> }>;
}

export type EdgeExecutionResult =
  | { readonly ok: true; readonly reply: EdgeReply }
  | {
      readonly ok: false;
      readonly code:
        | "unauthenticated-relay"
        | "invalid-plan"
        | "replayed-plan"
        | "rate-limited"
        | "connection-limit"
        | "topic-denied"
        | "subscription-limit"
        | "unknown-subscription"
        | "edge-failure";
    };

type EdgeRejectionCode = Extract<EdgeExecutionResult, { readonly ok: false }>["code"];

export interface EdgeFrame {
  readonly subscriptionId: string;
  readonly sequence: number;
  readonly payload: Uint8Array;
}

export interface EdgeTelemetryEvent {
  readonly atMs: number;
  readonly kind: "command-accepted" | "command-rejected" | "frame-dropped" | "backend-failure";
  readonly code: string;
}

export interface EdgeTelemetrySnapshot {
  readonly acceptedCommands: number;
  readonly rejectedCommands: number;
  readonly acceptedFrames: number;
  readonly droppedFrames: number;
  readonly activeSubscriptions: number;
  readonly bufferedBytes: number;
  readonly recentEvents: readonly EdgeTelemetryEvent[];
}

interface SubscriptionState {
  readonly id: string;
  readonly relayIdentityId: string;
  readonly connectionId: string;
  readonly topic: string;
  readonly type: string;
  readonly maxRateHz: number;
  readonly maxMessageBytes: number;
  readonly controller: AbortController;
  readonly queue: EdgeFrame[];
  nextSequence: number;
  lastAcceptedFrameAtMs?: number;
  close?: () => void | Promise<void>;
}

interface RateWindow {
  startedAtMs: number;
  count: number;
}

interface ConnectionState {
  lastSequence: number;
  readonly nonces: Set<string>;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TOPIC_PATTERN = /^\/[A-Za-z0-9_.~/-]+$/;
const TYPE_PATTERN = /^[A-Za-z0-9_]+\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)?$/;
const PROTOCOL_CEILINGS = Object.freeze({
  maxFrameBytes: 16 * 1024,
  maxRateHz: 1000,
  maxMessageBytes: 16 * 1024 * 1024,
});

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key)) && Object.keys(value).length === allowed.length;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  const [first = -1, second = -1] = octets;
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function isPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost"
    || normalized === "::1"
    || isPrivateIpv4(normalized)
    || isPrivateIpv6(normalized);
}

function isPrivateIpv6(host: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(host) || !/^f[cd][0-9a-f]{2}:/i.test(host)) return false;
  if ((host.match(/::/g) ?? []).length > 1) return false;
  const [left = "", right = ""] = host.split("::");
  const leftSegments = left ? left.split(":") : [];
  const rightSegments = right ? right.split(":") : [];
  const segments = [...leftSegments, ...rightSegments];
  if (segments.some((segment) => !/^[0-9a-f]{1,4}$/i.test(segment))) return false;
  return host.includes("::") ? segments.length < 8 : segments.length === 8;
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
}

function validateLimits(limits: EdgeRuntimeLimits): void {
  for (const name of Object.keys(limits) as Array<keyof EdgeRuntimeLimits>) {
    assertPositiveSafeInteger(name, limits[name]);
  }
  if (limits.maxFrameBytes > limits.maxBufferedBytes) {
    throw new Error("maxFrameBytes cannot exceed maxBufferedBytes");
  }
  if (limits.maxCommandBytes > PROTOCOL_CEILINGS.maxFrameBytes) {
    throw new Error("maxCommandBytes cannot exceed the protocol frame ceiling");
  }
}

function validateTopicList(topics: readonly TopicDescriptor[]): readonly TopicDescriptor[] {
  if (topics.length === 0) throw new Error("allowedTopics must not be empty");
  const unique = new Set<string>();
  const validated: TopicDescriptor[] = [];
  for (const topic of topics) {
    const key = `${topic.topic}\0${topic.type}`;
    if (unique.has(key)) throw new Error(`duplicate allowlisted ROS topic/type ${topic.topic} ${topic.type}`);
    if (
      typeof topic.topic !== "string"
      || !TOPIC_PATTERN.test(topic.topic)
      || topic.topic.includes("//")
      || topic.topic.endsWith("/")
      || typeof topic.type !== "string"
      || !TYPE_PATTERN.test(topic.type)
    ) {
      throw new Error(`invalid allowlisted ROS topic/type ${topic.topic} ${topic.type}`);
    }
    assertPositiveSafeInteger("topic.maxRateHz", topic.maxRateHz);
    assertPositiveSafeInteger("topic.maxMessageBytes", topic.maxMessageBytes);
    if (topic.maxRateHz > PROTOCOL_CEILINGS.maxRateHz || topic.maxMessageBytes > PROTOCOL_CEILINGS.maxMessageBytes) {
      throw new Error("allowlisted topic policy exceeds the protocol ceiling");
    }
    unique.add(key);
    validated.push(Object.freeze({ ...topic }));
  }
  return Object.freeze(validated);
}

export function computeAllowlistDigest(topics: readonly TopicDescriptor[]): string {
  const canonical = [...topics]
    .sort((left, right) => left.topic < right.topic ? -1 : left.topic > right.topic ? 1 : left.type < right.type ? -1 : left.type > right.type ? 1 : 0)
    .map(({ topic, type, maxRateHz, maxMessageBytes, schemaHash }) => ({
      topic,
      type,
      maxRateHz,
      maxMessageBytes,
      ...(schemaHash ? { schemaHash } : {}),
    }));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function validateRelayIds(relayIds: readonly string[]): readonly string[] {
  if (relayIds.length === 0) throw new Error("allowedRelayIds must not be empty");
  const unique = new Set<string>();
  for (const relayId of relayIds) {
    if (!ID_PATTERN.test(relayId)) throw new Error(`invalid relay id ${relayId}`);
    if (unique.has(relayId)) throw new Error(`duplicate relay id ${relayId}`);
    unique.add(relayId);
  }
  return Object.freeze([...unique]);
}

export function assertPrivateListener(listener: PrivateListenerConfig): void {
  if (!isPrivateHost(listener.host)) throw new Error("edge listener must bind to a private or loopback literal");
  if (!Number.isSafeInteger(listener.port) || listener.port < 1 || listener.port > 65_535) {
    throw new Error("edge listener port must be an integer from 1 through 65535");
  }
  if (listener.tls !== true) throw new Error("edge listener TLS must remain enabled");
}

function serializedSize(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return undefined;
  }
}

function isSafeNonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafePositive(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function parseEdgePlan(value: unknown, nowMs: number, maxTtlMs: number): EdgePlan | undefined {
  if (!isObject(value) || value.version !== 1 || !["discover", "subscribe", "unsubscribe"].includes(String(value.operation))) {
    return undefined;
  }
  if (
    !isIdentifier(value.sessionId)
    || !isIdentifier(value.connectionId)
    || !isSafeNonnegative(value.sequence)
    || !isIdentifier(value.nonce)
    || !isSafeNonnegative(value.issuedAtMs)
    || !isSafeNonnegative(value.expiresAtMs)
    || typeof value.allowlistDigest !== "string"
    || !DIGEST_PATTERN.test(value.allowlistDigest)
    || value.expiresAtMs <= nowMs
    || value.expiresAtMs <= value.issuedAtMs
    || value.expiresAtMs - value.issuedAtMs > maxTtlMs
  ) {
    return undefined;
  }
  const common = ["version", "operation", "sessionId", "connectionId", "sequence", "nonce", "issuedAtMs", "expiresAtMs", "allowlistDigest"];
  if (value.operation === "discover") {
    return hasOnlyKeys(value, common) ? value as unknown as EdgePlan : undefined;
  }
  if (!isIdentifier(value.subscriptionId)) return undefined;
  if (value.operation === "unsubscribe") {
    return hasOnlyKeys(value, [...common, "subscriptionId"]) ? value as unknown as EdgePlan : undefined;
  }
  if (
    !hasOnlyKeys(value, [...common, "subscriptionId", "topic", "type", "maxRateHz", "maxMessageBytes"])
    || typeof value.topic !== "string"
    || !TOPIC_PATTERN.test(value.topic)
    || value.topic.includes("//")
    || value.topic.endsWith("/")
    || typeof value.type !== "string"
    || !TYPE_PATTERN.test(value.type)
    || !isSafePositive(value.maxRateHz, PROTOCOL_CEILINGS.maxRateHz)
    || !isSafePositive(value.maxMessageBytes, PROTOCOL_CEILINGS.maxMessageBytes)
  ) {
    return undefined;
  }
  return value as unknown as EdgePlan;
}

export class PrivateEdgeRuntime {
  readonly generation: RosGeneration;
  readonly listener: PrivateListenerConfig;
  readonly #allowedRelayIds: ReadonlySet<string>;
  readonly #allowedTopics: ReadonlyMap<string, TopicDescriptor>;
  readonly #allowlistDigest: string;
  readonly #verifyRelayCredential: (identity: RelayEdgeIdentity) => boolean;
  readonly #limits: EdgeRuntimeLimits;
  readonly #clock: () => number;
  readonly #rateWindows = new Map<string, RateWindow>();
  readonly #connections = new Map<string, ConnectionState>();
  readonly #subscriptions = new Map<string, SubscriptionState>();
  readonly #events: EdgeTelemetryEvent[] = [];
  #acceptedCommands = 0;
  #rejectedCommands = 0;
  #acceptedFrames = 0;
  #droppedFrames = 0;
  #bufferedBytes = 0;

  constructor(config: EdgeRuntimeConfig, clock: () => number = Date.now) {
    if (config.generation !== "ros1" && config.generation !== "ros2") throw new Error("unsupported ROS generation");
    assertPrivateListener(config.listener);
    const limits = Object.freeze({ ...(config.limits ?? DEFAULT_EDGE_RUNTIME_LIMITS) });
    validateLimits(limits);
    const allowedTopics = validateTopicList(config.allowedTopics);
    if (!DIGEST_PATTERN.test(config.allowlistDigest) || config.allowlistDigest !== computeAllowlistDigest(allowedTopics)) {
      throw new Error("allowlistDigest does not bind the configured topic policy");
    }
    if (typeof config.verifyRelayCredential !== "function") throw new Error("verifyRelayCredential is required");
    this.generation = config.generation;
    this.listener = Object.freeze({ ...config.listener });
    this.#allowedRelayIds = new Set(validateRelayIds(config.allowedRelayIds));
    this.#allowedTopics = new Map(allowedTopics.map((topic) => [`${topic.topic}\0${topic.type}`, topic]));
    this.#allowlistDigest = config.allowlistDigest;
    this.#verifyRelayCredential = config.verifyRelayCredential;
    this.#limits = limits;
    this.#clock = clock;
  }

  async execute(identityValue: unknown, rawPlan: unknown, port: EdgeReadPort): Promise<EdgeExecutionResult> {
    const identity = this.#validateIdentity(identityValue);
    if (!identity) return this.#reject("unauthenticated-relay");
    if ((serializedSize(rawPlan) ?? Number.POSITIVE_INFINITY) > this.#limits.maxCommandBytes) {
      return this.#reject("invalid-plan");
    }
    const parsedPlan = parseEdgePlan(rawPlan, this.#clock(), this.#limits.maxPlanTtlMs);
    if (!parsedPlan) return this.#reject("invalid-plan");
    const plan = parsedPlan;
    if (plan.allowlistDigest !== this.#allowlistDigest) return this.#reject("topic-denied");
    if (!this.#consumeRate(identity.identityId)) return this.#reject("rate-limited");
    const replayCode = this.#consumePlan(identity.identityId, plan);
    if (replayCode) return this.#reject(replayCode);

    try {
      if (plan.operation === "discover") {
        const controller = new AbortController();
        const discovered = await port.discover(controller.signal);
        const topics: TopicDescriptor[] = [];
        const seen = new Set<string>();
        for (const topic of discovered) {
          const policy = this.#allowedTopics.get(`${topic.topic}\0${topic.type}`);
          if (!policy || seen.has(`${policy.topic}\0${policy.type}`)) continue;
          topics.push(policy);
          seen.add(`${policy.topic}\0${policy.type}`);
          if (topics.length === this.#allowedTopics.size) break;
        }
        return this.#accept({ version: 1, kind: "discovery", topics: Object.freeze(topics) });
      }
      if (plan.operation === "subscribe") {
        const policy = this.#allowedTopics.get(`${plan.topic}\0${plan.type}`);
        if (
          !policy
          || plan.maxRateHz > policy.maxRateHz
          || plan.maxMessageBytes > policy.maxMessageBytes
          || plan.maxMessageBytes > this.#limits.maxFrameBytes
        ) {
          return this.#reject("topic-denied");
        }
        if (this.#subscriptions.has(plan.subscriptionId)) return this.#reject("subscription-limit");
        if (this.#subscriptions.size >= this.#limits.maxSubscriptions) return this.#reject("subscription-limit");
        const state: SubscriptionState = {
          id: plan.subscriptionId,
          relayIdentityId: identity.identityId,
          connectionId: plan.connectionId,
          topic: plan.topic,
          type: plan.type,
          maxRateHz: plan.maxRateHz,
          maxMessageBytes: plan.maxMessageBytes,
          controller: new AbortController(),
          queue: [],
          nextSequence: 1,
        };
        this.#subscriptions.set(state.id, state);
        try {
          const handle = await port.subscribe(
            plan.topic,
            plan.type,
            (payload) => { this.#acceptFrame(state, payload); },
            state.controller.signal,
          );
          state.close = handle.close;
        } catch (error) {
          this.#subscriptions.delete(state.id);
          state.controller.abort("subscription setup failed");
          throw error;
        }
        return this.#accept({ version: 1, kind: "ack", operation: "subscribe" });
      }
      const state = this.#subscriptions.get(plan.subscriptionId);
      if (
        !state
        || state.relayIdentityId !== identity.identityId
        || state.connectionId !== plan.connectionId
      ) {
        return this.#reject("unknown-subscription");
      }
      await this.#closeSubscription(state);
      return this.#accept({ version: 1, kind: "ack", operation: "unsubscribe" });
    } catch {
      this.#record("backend-failure", "edge-failure");
      return this.#reject("edge-failure");
    }
  }

  drainFrame(subscriptionId: string): EdgeFrame | undefined {
    const state = this.#subscriptions.get(subscriptionId);
    const frame = state?.queue.shift();
    if (frame) this.#bufferedBytes -= frame.payload.byteLength;
    return frame;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#subscriptions.values()].map((state) => this.#closeSubscription(state)));
  }

  snapshotTelemetry(): EdgeTelemetrySnapshot {
    return Object.freeze({
      acceptedCommands: this.#acceptedCommands,
      rejectedCommands: this.#rejectedCommands,
      acceptedFrames: this.#acceptedFrames,
      droppedFrames: this.#droppedFrames,
      activeSubscriptions: this.#subscriptions.size,
      bufferedBytes: this.#bufferedBytes,
      recentEvents: Object.freeze(this.#events.map((event) => Object.freeze({ ...event }))),
    });
  }

  #validateIdentity(value: unknown): RelayEdgeIdentity | undefined {
    if (
      !isObject(value)
      || !hasOnlyKeys(value, ["identityId", "credential"])
      || typeof value.identityId !== "string"
      || !this.#allowedRelayIds.has(value.identityId)
      || typeof value.credential !== "string"
      || value.credential.length === 0
      || value.credential.length > 1024
      || (serializedSize(value) ?? Number.POSITIVE_INFINITY) > 2048
    ) {
      return undefined;
    }
    const identity = value as unknown as RelayEdgeIdentity;
    try {
      return this.#verifyRelayCredential(identity) === true ? identity : undefined;
    } catch {
      return undefined;
    }
  }

  #consumeRate(identityId: string): boolean {
    const now = this.#clock();
    const current = this.#rateWindows.get(identityId);
    if (!current || now - current.startedAtMs >= this.#limits.commandWindowMs) {
      this.#rateWindows.set(identityId, { startedAtMs: now, count: 1 });
      return true;
    }
    if (current.count >= this.#limits.maxCommandsPerWindow) return false;
    current.count += 1;
    return true;
  }

  #consumePlan(identityId: string, plan: EdgePlan): "replayed-plan" | "connection-limit" | undefined {
    const key = `${identityId}\0${plan.connectionId}`;
    let connection = this.#connections.get(key);
    if (!connection) {
      if (this.#connections.size >= this.#limits.maxTrackedConnections) return "connection-limit";
      connection = { lastSequence: -1, nonces: new Set() };
      this.#connections.set(key, connection);
    }
    if (plan.sequence <= connection.lastSequence || connection.nonces.has(plan.nonce)) return "replayed-plan";
    connection.lastSequence = plan.sequence;
    connection.nonces.add(plan.nonce);
    if (connection.nonces.size > this.#limits.maxCommandsPerWindow) {
      const oldest = connection.nonces.values().next().value as string | undefined;
      if (oldest !== undefined) connection.nonces.delete(oldest);
    }
    return undefined;
  }

  #accept(reply: EdgeReply): EdgeExecutionResult {
    this.#acceptedCommands += 1;
    this.#record("command-accepted", reply.kind);
    return { ok: true, reply };
  }

  #reject(code: EdgeRejectionCode): EdgeExecutionResult {
    this.#rejectedCommands += 1;
    this.#record("command-rejected", code);
    return { ok: false, code };
  }

  #acceptFrame(state: SubscriptionState, payload: Uint8Array): void {
    const now = this.#clock();
    const minimumIntervalMs = 1000 / state.maxRateHz;
    if (
      state.controller.signal.aborted
      || !this.#subscriptions.has(state.id)
      || !(payload instanceof Uint8Array)
      || payload.byteLength > state.maxMessageBytes
      || payload.byteLength > this.#limits.maxFrameBytes
      || state.queue.length >= this.#limits.maxQueuedFramesPerSubscription
      || this.#bufferedBytes + payload.byteLength > this.#limits.maxBufferedBytes
      || (state.lastAcceptedFrameAtMs !== undefined && now - state.lastAcceptedFrameAtMs < minimumIntervalMs)
    ) {
      this.#droppedFrames += 1;
      this.#record("frame-dropped", "backpressure-size-or-rate-limit");
      return;
    }
    const copied = payload.slice();
    state.queue.push(Object.freeze({ subscriptionId: state.id, sequence: state.nextSequence++, payload: copied }));
    state.lastAcceptedFrameAtMs = now;
    this.#bufferedBytes += copied.byteLength;
    this.#acceptedFrames += 1;
  }

  async #closeSubscription(state: SubscriptionState): Promise<void> {
    if (!this.#subscriptions.delete(state.id)) return;
    state.controller.abort("subscription closed");
    for (const frame of state.queue) this.#bufferedBytes -= frame.payload.byteLength;
    state.queue.length = 0;
    await state.close?.();
  }

  #record(kind: EdgeTelemetryEvent["kind"], code: string): void {
    if (this.#events.length >= this.#limits.maxTelemetryEvents) this.#events.shift();
    this.#events.push(Object.freeze({ atMs: this.#clock(), kind, code }));
  }
}
import { createHash } from "node:crypto";
