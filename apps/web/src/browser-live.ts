import { availableDisplaysForSchema } from "@ros-web-viewer/m1-integration";

import type { BrowserSample } from "./browser-runtime.js";
import type {
  DesktopShellPorts,
  LiveConnectionSelection,
  LivePollResult,
  LiveTelemetrySummary,
  OpenLiveResult,
  TopicSummary,
} from "./shell.js";

interface RelayTopic {
  readonly id: string;
  readonly name: string;
  readonly typeName: string;
  readonly encoding: string;
  readonly schemaEncoding?: string;
  readonly schemaDefinition?: string;
}

interface RelayResponse {
  readonly version: 1;
  readonly kind: string;
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly expiresAtMs?: number;
  readonly topics?: readonly RelayTopic[];
  readonly nextCursor?: number;
  readonly topicId?: string;
  readonly sequence?: string;
  readonly sourceTimeNanos?: string;
  readonly receiptTimeNanos?: string;
  readonly typeName?: string;
  readonly encoding?: string;
  readonly payloadBase64?: string;
  readonly relayDroppedMessages?: number;
  readonly relayDropReason?: string;
  readonly message?: string;
}

const MAX_CONTROL_BYTES = 256 * 1024;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_FRAME_BYTES = Math.ceil(MAX_MESSAGE_BYTES / 3) * 4 + 64 * 1024;
const MAX_TOPICS = 32;
const MAX_DISCOVERY_PAGES = 32;
const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_MESSAGES = 256;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;

interface QueuedLiveDelivery {
  readonly topicId: string;
  readonly sample: BrowserSample;
  readonly bytes: number;
  readonly generation: number;
  readonly receivedAtMs: number;
}

function validateEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "wss:" && !(loopback && url.protocol === "ws:")) throw new Error("Live relay endpoint must use WSS (WS is allowed only for loopback development)." );
  if (url.username || url.password || url.hash) throw new Error("Live relay endpoint must not embed credentials or fragments.");
  return url.href;
}

function decodeBase64(value: string): Uint8Array {
  if (value.length > Math.ceil(MAX_MESSAGE_BYTES / 3) * 4 + 8) throw new Error("Live payload exceeds the encoded message budget.");
  const binary = atob(value);
  if (binary.length > MAX_MESSAGE_BYTES) throw new Error("Live payload exceeds the message budget.");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function parseNonnegativeBigInt(value: string | undefined, label: string): bigint {
  if (!value || !/^\d+$/u.test(value)) throw new Error(`${label} must be a non-negative decimal string.`);
  return BigInt(value);
}

function topicSummary(topic: RelayTopic): TopicSummary {
  if (!topic.id || !topic.name.startsWith("/") || !topic.typeName || !topic.encoding) throw new Error("Live relay returned an invalid topic.");
  if (topic.schemaDefinition && new TextEncoder().encode(topic.schemaDefinition).byteLength > MAX_SCHEMA_BYTES) throw new Error("Live topic schema exceeds the schema budget.");
  const declaredDisplays = availableDisplaysForSchema(topic.typeName, "schema-present");
  const hasNativeDisplay = declaredDisplays.some((kind) => kind !== "raw");
  const schemaPresent = hasNativeDisplay || Boolean(topic.schemaDefinition);
  const availableDisplays = schemaPresent ? declaredDisplays : ["raw"] as const;
  return {
    id: topic.id,
    name: topic.name,
    typeName: topic.typeName,
    compatibility: hasNativeDisplay ? "native-display" : schemaPresent ? "schema-backed-generic" : "opaque-inspectable",
    schemaCapability: schemaPresent ? "schema-present" : "opaque",
    availableDisplays,
  };
}

/**
 * Browser implementation of the documented subscribe-only relay protocol.
 * It intentionally exposes no publish, service, action, parameter, or command operation.
 */
export class BrowserLiveRelay implements Pick<DesktopShellPorts, "connectLive" | "disconnectLive" | "pollLive" | "seek" | "subscribeLive"> {
  #endpoint?: string;
  #socket?: WebSocket;
  #requestSequence = 0;
  #pending = new Map<string, { readonly resolve: (value: RelayResponse) => void; readonly reject: (error: Error) => void; readonly timeout: number }>();
  #topics = new Map<string, RelayTopic>();
  #subscribedTopicIds = new Set<string>();
  #deliveryQueue: QueuedLiveDelivery[] = [];
  #activeDrainGeneration?: number;
  #connectionGeneration = 0;
  #latestSourceTimeNanos?: bigint;
  #queuedMessages = 0;
  #queuedBytes = 0;
  #acceptedMessages = 0;
  #deliveredMessages = 0;
  #droppedMessages = 0;
  #relayDroppedMessages = 0;
  #latestRelayLatencyMs?: number;
  #maxRelayLatencyMs?: number;
  #latestBrowserDeliveryLatencyMs?: number;
  #maxBrowserDeliveryLatencyMs?: number;
  #sourceEpoch = 0;
  #lastSequenceByTopic = new Map<string, bigint>();
  #pendingDisplayDeliveries = 0;
  #pendingDisplayErrors = 0;
  #pendingStaleMessages = 0;
  #completedMessagesPending = 0;
  #state: LiveTelemetrySummary["state"] = "disconnected";
  #diagnostic?: string;

  constructor(
    private readonly onSample: (topicId: string, sample: BrowserSample) => void | Promise<void>,
    private readonly onState?: () => void,
  ) {}

  setEndpoint(endpoint: string): void {
    this.#endpoint = validateEndpoint(endpoint);
  }

  async connectLive(selection: LiveConnectionSelection): Promise<OpenLiveResult> {
    if (!this.#endpoint) throw new Error("Set a live relay endpoint before connecting.");
    await this.disconnectLive();
    this.#acceptedMessages = 0;
    this.#deliveredMessages = 0;
    this.#droppedMessages = 0;
    this.#relayDroppedMessages = 0;
    this.#latestRelayLatencyMs = undefined;
    this.#maxRelayLatencyMs = undefined;
    this.#latestBrowserDeliveryLatencyMs = undefined;
    this.#maxBrowserDeliveryLatencyMs = undefined;
    this.#latestSourceTimeNanos = undefined;
    this.#pendingDisplayDeliveries = 0;
    this.#pendingDisplayErrors = 0;
    this.#pendingStaleMessages = 0;
    this.#state = "connecting";
    this.onState?.();
    const socket = new WebSocket(this.#endpoint, "ros-viewer.subscribe.v1");
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#handleMessage(socket, event));
    socket.addEventListener("close", () => this.#handleClose(socket));
    socket.addEventListener("error", () => {
      if (this.#socket === socket) {
        this.#state = "degraded";
        this.#diagnostic = "Live relay transport error.";
        this.onState?.();
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("Live relay connection timed out.")), 10_000);
        socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Could not establish the live relay WebSocket.")); }, { once: true });
      });
      const ready = await this.#request("authenticate", { browserOrigin: selection.browserOrigin, sessionToken: selection.sessionToken });
      if (ready.kind !== "ready" || !ready.sessionId || !Number.isSafeInteger(ready.expiresAtMs) || ready.expiresAtMs! <= Date.now()) {
        throw new Error("Live relay rejected the authenticated browser session or returned an invalid expiry.");
      }
      const discoveredTopics: RelayTopic[] = [];
      let cursor: number | undefined = 0;
      let discoveryPages = 0;
      let discoveryBytes = 0;
      while (cursor !== undefined) {
        discoveryPages += 1;
        if (discoveryPages > MAX_DISCOVERY_PAGES) throw new Error("Live relay discovery exceeded the page budget.");
        const discovery = await this.#request("discover", { cursor });
        if (discovery.kind !== "discovery" || !Array.isArray(discovery.topics)) throw new Error("Live relay returned an invalid discovery response.");
        discoveryBytes += new TextEncoder().encode(JSON.stringify(discovery.topics)).byteLength;
        if (discoveryBytes > MAX_DISCOVERY_BYTES) throw new Error("Live relay discovery exceeded the aggregate byte budget.");
        discoveredTopics.push(...discovery.topics);
        if (discoveredTopics.length > MAX_TOPICS) throw new Error("Live relay returned too many discovered topics.");
        const nextCursor = discovery.nextCursor;
        if (discovery.topics.length === 0 && nextCursor !== undefined) throw new Error("Live relay returned an empty advancing discovery page.");
        if (nextCursor !== undefined && (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor)) {
          throw new Error("Live relay returned an invalid discovery cursor.");
        }
        if (nextCursor !== undefined && nextCursor > MAX_TOPICS) throw new Error("Live relay discovery cursor exceeds the topic budget.");
        cursor = nextCursor;
      }
      const ids = new Set(discoveredTopics.map(({ id }) => id));
      if (ids.size !== discoveredTopics.length) throw new Error("Live relay returned duplicate discovered topic ids.");
      const summaries = discoveredTopics.map(topicSummary);
      this.#topics = new Map(discoveredTopics.map((topic) => [topic.id, topic]));
      this.#sourceEpoch += 1;
      this.#state = "connected";
      this.#diagnostic = undefined;
      this.onState?.();
      return { sourceLabel: "Secure live relay", epoch: this.#sourceEpoch, topics: summaries, telemetry: this.#telemetry() };
    } catch (error) {
      if (this.#socket === socket) this.#socket = undefined;
      socket.close(1000, "connection failed");
      this.#resetDisconnected();
      throw error;
    }
  }

  async subscribeLive(topicIds: readonly string[]): Promise<void> {
    const unique = [...new Set(topicIds)];
    if (unique.length > 32) throw new Error("Live subscription allows at most 32 explicit topics.");
    if (unique.some((id) => id.includes("*") || !this.#topics.has(id))) throw new Error("Live subscription contains an undiscovered or wildcard topic.");
    const desired = new Set(unique);
    const removed = [...this.#subscribedTopicIds].filter((id) => !desired.has(id));
    if (removed.length > 0) {
      const response = await this.#request("unsubscribe", { topicIds: removed });
      if (response.kind !== "ack") throw new Error("Live relay rejected the explicit unsubscription.");
      for (const id of removed) this.#subscribedTopicIds.delete(id);
    }
    const changed = unique.length !== this.#subscribedTopicIds.size || unique.some((id) => !this.#subscribedTopicIds.has(id));
    if (unique.length > 0 && changed) {
      const response = await this.#request("subscribe", { topicIds: unique });
      if (response.kind !== "ack") throw new Error("Live relay rejected the explicit subscription.");
    }
    this.#subscribedTopicIds = desired;
  }

  pollLive(): LivePollResult {
    const messageCount = this.#completedMessagesPending;
    this.#completedMessagesPending = 0;
    const result: LivePollResult = {
      epoch: this.#sourceEpoch,
      latestSourceTimeNanos: this.#latestSourceTimeNanos,
      messageCount,
      telemetry: this.#telemetry(),
      displayDeliveries: this.#pendingDisplayDeliveries,
      displayErrors: this.#pendingDisplayErrors,
      staleMessageCount: this.#pendingStaleMessages,
    };
    this.#pendingDisplayDeliveries = 0;
    this.#pendingDisplayErrors = 0;
    this.#pendingStaleMessages = 0;
    return result;
  }

  recordDisplayResult(deliveries: number, errors: number, staleMessages = 0): void {
    this.#pendingDisplayDeliveries += deliveries;
    this.#pendingDisplayErrors += errors;
    this.#pendingStaleMessages += staleMessages;
  }

  recordDiagnostic(diagnostic: string): void {
    this.#state = "degraded";
    this.#diagnostic = diagnostic;
    this.onState?.();
  }

  async disconnectLive(): Promise<void> {
    const socket = this.#socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        const subscribed = [...this.#subscribedTopicIds];
        if (subscribed.length > 0) await this.#requestWithSocket(socket, "unsubscribe", { topicIds: subscribed });
      } catch { /* close remains mandatory */ }
    }
    if (this.#socket === socket) this.#socket = undefined;
    socket?.close(1000, "viewer disconnect");
    this.#resetDisconnected();
  }

  seek(): Promise<never> {
    return Promise.reject(new Error("Recorded seek is unavailable in live mode."));
  }

  async #request(operation: "authenticate" | "discover" | "subscribe" | "unsubscribe", body: Readonly<Record<string, unknown>>): Promise<RelayResponse> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Live relay is not connected.");
    return this.#requestWithSocket(socket, operation, body);
  }

  #requestWithSocket(socket: WebSocket, operation: "authenticate" | "discover" | "subscribe" | "unsubscribe", body: Readonly<Record<string, unknown>>): Promise<RelayResponse> {
    const requestId = `browser-${++this.#requestSequence}`;
    return new Promise<RelayResponse>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (!this.#pending.delete(requestId)) return;
        reject(new Error(`Live relay ${operation} request timed out.`));
      }, 10_000);
      this.#pending.set(requestId, { resolve, reject, timeout });
      try {
        socket.send(JSON.stringify({ version: 1, operation, requestId, ...body }));
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #handleMessage(socket: WebSocket, event: MessageEvent): void {
    if (this.#socket !== socket) return;
    if (typeof event.data !== "string" || event.data.length > MAX_MESSAGE_FRAME_BYTES) {
      this.#drop("Live relay sent an unsupported or oversized frame.");
      return;
    }
    let frame: RelayResponse;
    try {
      frame = JSON.parse(event.data) as RelayResponse;
      if (frame.version !== 1 || !frame.kind) throw new Error("invalid relay frame");
      if (frame.kind !== "message" && event.data.length > MAX_CONTROL_BYTES) throw new Error("oversized relay control frame");
      if (frame.requestId) {
        const pending = this.#pending.get(frame.requestId);
        if (!pending) throw new Error("unknown relay request id");
        this.#pending.delete(frame.requestId);
        clearTimeout(pending.timeout);
        if (frame.kind === "error") pending.reject(new Error(frame.message || "Live relay request failed.")); else pending.resolve(frame);
        return;
      }
      if (frame.kind === "telemetry") {
        this.#applyRelayDrops(frame);
        this.onState?.();
        return;
      }
      if (frame.kind !== "message" || !frame.topicId || !frame.payloadBase64) throw new Error("unexpected relay event");
      const topic = this.#topics.get(frame.topicId);
      if (!topic) throw new Error("message for undiscovered topic");
      if (!this.#subscribedTopicIds.has(frame.topicId)) throw new Error("message for unsubscribed topic");
      if (frame.typeName !== undefined && frame.typeName !== topic.typeName) throw new Error("message type does not match discovery");
      if (frame.encoding !== undefined && frame.encoding !== topic.encoding) throw new Error("message encoding does not match discovery");
      const sourceTimeNanos = parseNonnegativeBigInt(frame.sourceTimeNanos, "sourceTimeNanos");
      const receiptTimeNanos = parseNonnegativeBigInt(frame.receiptTimeNanos, "receiptTimeNanos");
      if (receiptTimeNanos < sourceTimeNanos) throw new Error("receiptTimeNanos precedes sourceTimeNanos");
      const relayLatencyMs = Number(receiptTimeNanos - sourceTimeNanos) / 1_000_000;
      this.#latestRelayLatencyMs = relayLatencyMs;
      this.#maxRelayLatencyMs = Math.max(this.#maxRelayLatencyMs ?? 0, relayLatencyMs);
      const sequence = parseNonnegativeBigInt(frame.sequence, "sequence");
      const previousSequence = this.#lastSequenceByTopic.get(frame.topicId);
      if (previousSequence !== undefined && sequence <= previousSequence) throw new Error("message sequence is replayed or out of order");
      const payload = decodeBase64(frame.payloadBase64);
      if (frame.relayDroppedMessages !== undefined) this.#applyRelayDrops(frame);
      if (this.#queuedMessages >= MAX_QUEUED_MESSAGES || this.#queuedBytes + payload.byteLength > MAX_QUEUED_BYTES) {
        throw new Error("live message queue budget exceeded");
      }
      this.#lastSequenceByTopic.set(frame.topicId, sequence);
      this.#queuedMessages += 1;
      this.#queuedBytes += payload.byteLength;
      this.#acceptedMessages += 1;
      this.#latestSourceTimeNanos = sourceTimeNanos;
      this.#deliveryQueue.push({
        topicId: frame.topicId,
        bytes: payload.byteLength,
        generation: this.#connectionGeneration,
        receivedAtMs: performance.now(),
        sample: {
          channel: {
            schema: topic.schemaDefinition
              ? { name: topic.typeName, capability: "schema-present", definition: topic.schemaDefinition, encoding: topic.schemaEncoding }
              : { name: topic.typeName, capability: availableDisplaysForSchema(topic.typeName, "schema-present").some((kind) => kind !== "raw") ? "schema-present" : "opaque" },
            messageEncoding: topic.encoding,
          },
          data: payload,
          logTimeNanos: sourceTimeNanos,
          sourceSequence: sequence,
        },
      });
      void this.#drainDeliveries(this.#connectionGeneration);
    } catch (error) {
      this.#drop(error instanceof Error ? error.message : "Invalid live relay frame.");
    }
  }

  #drop(diagnostic: string): void {
    this.#droppedMessages += 1;
    this.#state = "degraded";
    this.#diagnostic = diagnostic;
    this.onState?.();
  }

  #applyRelayDrops(frame: RelayResponse): void {
    if (!Number.isSafeInteger(frame.relayDroppedMessages) || frame.relayDroppedMessages! < this.#relayDroppedMessages) {
      throw new Error("relay drop counter is invalid");
    }
    const newlyReportedDrops = frame.relayDroppedMessages! - this.#relayDroppedMessages;
    this.#relayDroppedMessages = frame.relayDroppedMessages!;
    if (newlyReportedDrops > 0) {
      this.#droppedMessages += newlyReportedDrops;
      this.#state = "degraded";
      this.#diagnostic = `Relay dropped ${newlyReportedDrops} message(s): ${frame.relayDropReason || "bounded backpressure"}.`;
    }
  }

  #handleClose(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    this.#resetDisconnected();
    this.onState?.();
  }

  #resetDisconnected(): void {
    this.#connectionGeneration += 1;
    for (const { reject, timeout } of this.#pending.values()) {
      clearTimeout(timeout);
      reject(new Error("Live relay connection closed."));
    }
    this.#pending.clear();
    this.#topics.clear();
    this.#subscribedTopicIds.clear();
    this.#lastSequenceByTopic.clear();
    this.#deliveryQueue = [];
    this.#activeDrainGeneration = undefined;
    this.#state = "disconnected";
    this.#queuedMessages = 0;
    this.#queuedBytes = 0;
    this.#completedMessagesPending = 0;
  }

  async #drainDeliveries(generation: number): Promise<void> {
    if (this.#activeDrainGeneration === generation) return;
    this.#activeDrainGeneration = generation;
    try {
      while (generation === this.#connectionGeneration) {
        const delivery = this.#deliveryQueue.shift();
        if (!delivery) return;
        try {
          const result = this.onSample(delivery.topicId, delivery.sample);
          if (result && typeof result.then === "function") await result;
          if (generation !== this.#connectionGeneration) return;
          this.#deliveredMessages += 1;
          this.#completedMessagesPending += 1;
          const browserDeliveryLatencyMs = performance.now() - delivery.receivedAtMs;
          this.#latestBrowserDeliveryLatencyMs = browserDeliveryLatencyMs;
          this.#maxBrowserDeliveryLatencyMs = Math.max(this.#maxBrowserDeliveryLatencyMs ?? 0, browserDeliveryLatencyMs);
          this.onState?.();
        } catch (error) {
          if (generation === this.#connectionGeneration) this.#drop(error instanceof Error ? error.message : "Live sample delivery failed.");
        } finally {
          if (generation === this.#connectionGeneration) {
            this.#queuedMessages -= 1;
            this.#queuedBytes -= delivery.bytes;
          }
        }
      }
    } finally {
      if (this.#activeDrainGeneration === generation) this.#activeDrainGeneration = undefined;
      if (generation === this.#connectionGeneration && this.#deliveryQueue.length > 0) void this.#drainDeliveries(generation);
    }
  }

  #telemetry(): LiveTelemetrySummary {
    return {
      state: this.#state,
      sourceEpoch: this.#sourceEpoch,
      queuedMessages: this.#queuedMessages,
      queuedBytes: this.#queuedBytes,
      acceptedMessages: this.#acceptedMessages,
      deliveredMessages: this.#deliveredMessages,
      droppedMessages: this.#droppedMessages,
      latestRelayLatencyMs: this.#latestRelayLatencyMs,
      maxRelayLatencyMs: this.#maxRelayLatencyMs,
      latestBrowserDeliveryLatencyMs: this.#latestBrowserDeliveryLatencyMs,
      maxBrowserDeliveryLatencyMs: this.#maxBrowserDeliveryLatencyMs,
      diagnostic: this.#diagnostic,
    };
  }
}
