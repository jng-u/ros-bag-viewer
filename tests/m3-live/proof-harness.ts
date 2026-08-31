import {
  InMemorySessionAuthenticator,
  SecureLiveRelay,
  type EdgeTransport,
  type RelayConnection,
} from "../../apps/relay/src/index.js";
import {
  PrivateEdgeRuntime,
  computeAllowlistDigest,
  type EdgePlan,
  type EdgeReadPort,
  type EdgeReply,
  type RelayEdgeIdentity,
  type RosGeneration,
  type TopicDescriptor,
} from "../../packages/edge-runtime/src/index.js";

export const liveTopics: readonly TopicDescriptor[] = Object.freeze([
  Object.freeze({
    topic: "/points",
    type: "sensor_msgs/msg/PointCloud2",
    maxRateHz: 1_000,
    maxMessageBytes: 512,
  }),
  Object.freeze({
    topic: "/camera/image",
    type: "sensor_msgs/msg/Image",
    maxRateHz: 1_000,
    maxMessageBytes: 2_048,
  }),
]);

const relayIdentity = Object.freeze({ identityId: "m3-relay", credential: "edge-secret" });
const allowlistDigest = computeAllowlistDigest(liveTopics);

class SyntheticRosReadPort implements EdgeReadPort {
  readonly callbacks = new Map<string, (payload: Uint8Array) => void>();
  readonly writesAttempted = 0;

  async discover(): Promise<readonly { readonly topic: string; readonly type: string }[]> {
    return [
      ...liveTopics.map(({ topic, type }) => ({ topic, type })),
      { topic: "/private/not-allowlisted", type: "example_msgs/msg/Secret" },
    ];
  }

  async subscribe(
    topic: string,
    _type: string,
    onFrame: (payload: Uint8Array) => void,
  ): Promise<{ close(): void }> {
    this.callbacks.set(topic, onFrame);
    return { close: () => { this.callbacks.delete(topic); } };
  }

  emit(topic: string, payload: Uint8Array): void {
    const callback = this.callbacks.get(topic);
    if (!callback) throw new Error(`topic ${topic} is not subscribed`);
    callback(payload);
  }
}

class RuntimeEdgeTransport implements EdgeTransport {
  constructor(
    readonly runtime: PrivateEdgeRuntime,
    readonly port: SyntheticRosReadPort,
  ) {}

  async request(identity: RelayEdgeIdentity, plan: EdgePlan): Promise<EdgeReply> {
    const result = await this.runtime.execute(identity, plan, this.port);
    if (!result.ok) throw new Error(result.code);
    return result.reply;
  }
}

export interface M3SyntheticFixture {
  readonly generation: RosGeneration;
  readonly edge: PrivateEdgeRuntime;
  readonly port: SyntheticRosReadPort;
  readonly relay: SecureLiveRelay;
  connect(connectionId: string): Promise<RelayConnection>;
  setNow(value: number): void;
  getNow(): number;
}

export function createSyntheticFixture(generation: RosGeneration): M3SyntheticFixture {
  let now = 10_000;
  let nonce = 0;
  const port = new SyntheticRosReadPort();
  const edge = new PrivateEdgeRuntime(
    {
      generation,
      listener: { host: "127.0.0.1", port: generation === "ros1" ? 7441 : 7442, tls: true },
      allowedRelayIds: [relayIdentity.identityId],
      allowedTopics: liveTopics,
      allowlistDigest,
      verifyRelayCredential: ({ identityId, credential }) =>
        identityId === relayIdentity.identityId && credential === relayIdentity.credential,
      limits: {
        maxCommandBytes: 16 * 1024,
        maxCommandsPerWindow: 1_000,
        commandWindowMs: 1_000,
        maxPlanTtlMs: 1_000,
        maxTrackedConnections: 8,
        maxSubscriptions: 4,
        maxFrameBytes: 2_048,
        maxQueuedFramesPerSubscription: 4,
        maxBufferedBytes: 16 * 1024,
        maxTelemetryEvents: 32,
      },
    },
    () => now,
  );
  const transport = new RuntimeEdgeTransport(edge, port);
  const authenticator = new InMemorySessionAuthenticator([
    {
      credential: "browser-secret",
      grant: {
        principalId: "m3-principal",
        sessionId: "m3-session",
        allowedOrigins: ["https://viewer.example"],
        expiresAtMs: 100_000,
      },
    },
  ]);
  const relay = new SecureLiveRelay({
    authenticator,
    allowedOrigins: ["https://viewer.example"],
    resolveSessionPolicy: () => ({ topics: liveTopics }),
    edgeIdentity: relayIdentity,
    edgeTransport: transport,
    now: () => now,
    nonce: () => `m3-nonce-${nonce++}`,
    limits: {
      maxConnectionsPerSession: 1,
      maxSubscriptionsPerSession: 2,
      maxDiscoveryTopics: 8,
      quotaWindowMs: 1_000,
      maxRequestsPerWindow: 100,
      maxRequestBytesPerWindow: 64 * 1024,
      maxQueueMessages: 12,
      maxQueueBytes: 10_000,
      maxDrainMessages: 12,
      maxDrainBytes: 10_000,
      edgePlanTtlMs: 500,
    },
    protocolLimits: { maxMessageBytes: 2_048 },
  });

  return {
    generation,
    edge,
    port,
    relay,
    connect(connectionId) {
      return relay.connect({
        credential: "browser-secret",
        origin: "https://viewer.example",
        sessionId: "m3-session",
        connectionId,
      });
    },
    setNow(value) { now = value; },
    getNow() { return now; },
  };
}

function subscribeFrame(sequence: number, subscriptionId: string, topic: TopicDescriptor) {
  return {
    version: 1 as const,
    operation: "subscribe" as const,
    sessionId: "m3-session",
    sequence,
    requestId: `request-${sequence}`,
    subscriptionId,
    topic: topic.topic,
    type: topic.type,
    maxRateHz: topic.maxRateHz,
    maxMessageBytes: topic.maxMessageBytes,
  };
}

export interface SyntheticLoadProof {
  readonly generation: RosGeneration;
  readonly evidenceKind: "deterministic-local-synthetic";
  readonly iterations: number;
  readonly attemptedFrames: number;
  readonly payloadClasses: readonly Readonly<{ topic: string; bytes: number }>[];
  readonly edge: {
    readonly acceptedFrames: number;
    readonly droppedFrames: number;
    readonly peakConfiguredFramesPerSubscription: number;
    readonly peakConfiguredBufferedBytes: number;
    readonly telemetryEvents: number;
  };
  readonly relay: {
    readonly queueDepth: number;
    readonly queueBytes: number;
    readonly queueHighWaterMessages: number;
    readonly queueHighWaterBytes: number;
    readonly droppedMessages: number;
    readonly drainedMessages: number;
  };
  readonly syntheticTransitLatencyNanos: {
    readonly samples: number;
    readonly maximum: number;
    readonly p95: number;
    readonly clockModel: "deterministic-same-clock";
  };
  readonly reconnectEpochs: readonly [number, number];
  readonly noRosWriteSurface: boolean;
}

export async function runSyntheticLoadProof(generation: RosGeneration): Promise<SyntheticLoadProof> {
  const fixture = createSyntheticFixture(generation);
  const connection = await fixture.connect(`${generation}-connection-1`);
  for (const [index, topic] of liveTopics.entries()) {
    const response = await connection.handle(subscribeFrame(index, `subscription-${index}`, topic));
    if (response.kind !== "ack") throw new Error(`failed to subscribe ${topic.topic}`);
  }

  const iterations = 500;
  const syntheticLatencies: number[] = [];
  let sourceSequence = 0;
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    fixture.setNow(fixture.getNow() + 1);
    fixture.port.emit("/points", new Uint8Array(512).fill(iteration % 251));
    fixture.port.emit("/camera/image", new Uint8Array(2_048).fill(iteration % 251));

    if (iteration % 10 === 0) {
      for (let subscriptionIndex = 0; subscriptionIndex < liveTopics.length; subscriptionIndex += 1) {
        const subscriptionId = `subscription-${subscriptionIndex}`;
        let frame = fixture.edge.drainFrame(subscriptionId);
        while (frame) {
          const syntheticLatency = 2_000_000;
          syntheticLatencies.push(syntheticLatency);
          connection.pushFromEdge({
            subscriptionId,
            sourceSequence: sourceSequence++,
            timestampNanos: String(BigInt(fixture.getNow()) * 1_000_000n - BigInt(syntheticLatency)),
            payload: frame.payload,
          });
          frame = fixture.edge.drainFrame(subscriptionId);
        }
      }
    }
  }

  const edgeTelemetry = fixture.edge.snapshotTelemetry();
  const health = connection.health();
  const drained = connection.drain();
  const firstEpoch = connection.connectionEpoch;
  await connection.close();
  const reconnected = await fixture.connect(`${generation}-connection-2`);
  const secondEpoch = reconnected.connectionEpoch;
  await reconnected.close();
  await fixture.edge.close();

  const sortedLatencies = [...syntheticLatencies].sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(sortedLatencies.length * 0.95) - 1);
  return Object.freeze({
    generation,
    evidenceKind: "deterministic-local-synthetic",
    iterations,
    attemptedFrames: iterations * liveTopics.length,
    payloadClasses: Object.freeze([
      Object.freeze({ topic: "/points", bytes: 512 }),
      Object.freeze({ topic: "/camera/image", bytes: 2_048 }),
    ]),
    edge: Object.freeze({
      acceptedFrames: edgeTelemetry.acceptedFrames,
      droppedFrames: edgeTelemetry.droppedFrames,
      peakConfiguredFramesPerSubscription: 4,
      peakConfiguredBufferedBytes: 16 * 1024,
      telemetryEvents: edgeTelemetry.recentEvents.length,
    }),
    relay: Object.freeze({
      queueDepth: health.queueDepth,
      queueBytes: health.queueBytes,
      queueHighWaterMessages: health.queueHighWaterMessages,
      queueHighWaterBytes: health.queueHighWaterBytes,
      droppedMessages: health.droppedMessages,
      drainedMessages: drained.length,
    }),
    syntheticTransitLatencyNanos: Object.freeze({
      samples: syntheticLatencies.length,
      maximum: sortedLatencies.at(-1) ?? 0,
      p95: sortedLatencies[p95Index] ?? 0,
      clockModel: "deterministic-same-clock" as const,
    }),
    reconnectEpochs: Object.freeze([firstEpoch, secondEpoch]) as readonly [number, number],
    noRosWriteSurface:
      fixture.port.writesAttempted === 0 &&
      !["publish", "callService", "sendAction", "setParameter"].some(
        (name) => name in PrivateEdgeRuntime.prototype || name in SecureLiveRelay.prototype,
      ),
  });
}
