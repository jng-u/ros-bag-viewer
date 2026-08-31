export type TimelineTimeSource = "record" | "header" | "clock";

export interface TimeCandidate {
  readonly source: TimelineTimeSource;
  readonly valueNanos?: bigint;
}

export interface NormalizedTimelineTime {
  readonly valueNanos: bigint;
  readonly source: TimelineTimeSource;
  readonly diagnostics: readonly string[];
}

export interface TimelineOrderingKey {
  readonly valueNanos: bigint;
  readonly sourceId: string;
  readonly channelId: string;
  readonly sourceSequence: bigint;
}

export function normalizeSchedulingTime(
  candidates: readonly TimeCandidate[],
  preference: readonly TimelineTimeSource[] = ["record", "header", "clock"],
): NormalizedTimelineTime {
  const bySource = new Map(candidates.map((candidate) => [candidate.source, candidate.valueNanos]));
  const diagnostics: string[] = [];
  for (const source of preference) {
    const value = bySource.get(source);
    if (value === undefined || value < 0n) {
      diagnostics.push(`${source} timestamp is missing or invalid`);
      continue;
    }
    if (source !== preference[0]) diagnostics.push(`scheduling time fell back to ${source}`);
    return { valueNanos: value, source, diagnostics };
  }
  throw new Error(`message has no valid scheduling timestamp: ${diagnostics.join("; ")}`);
}

export function compareTimelineKeys(left: TimelineOrderingKey, right: TimelineOrderingKey): number {
  if (left.valueNanos !== right.valueNanos) return left.valueNanos < right.valueNanos ? -1 : 1;
  const source = left.sourceId.localeCompare(right.sourceId);
  if (source !== 0) return source;
  const channel = left.channelId.localeCompare(right.channelId);
  if (channel !== 0) return channel;
  return left.sourceSequence === right.sourceSequence ? 0 : left.sourceSequence < right.sourceSequence ? -1 : 1;
}

export function stableTimelineSort<T extends TimelineOrderingKey>(messages: readonly T[]): T[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => compareTimelineKeys(left.message, right.message) || left.index - right.index)
    .map(({ message }) => message);
}

export interface QueuedTimelineMessage extends TimelineOrderingKey {
  readonly epoch: number;
  readonly payloadBytes: number;
}

export interface TimelineQueueTelemetry {
  readonly messages: number;
  readonly payloadBytes: number;
  readonly droppedMessages: number;
  readonly peakMessages: number;
  readonly peakPayloadBytes: number;
}

export class BoundedTimelineQueue<T extends QueuedTimelineMessage> {
  readonly #maxMessages: number;
  readonly #maxPayloadBytes: number;
  readonly #messages: T[] = [];
  #epoch: number;
  #payloadBytes = 0;
  #droppedMessages = 0;
  #peakMessages = 0;
  #peakPayloadBytes = 0;

  constructor(epoch: number, maxMessages: number, maxPayloadBytes: number) {
    if (maxMessages < 1 || maxPayloadBytes < 1) throw new Error("timeline queue limits must be positive");
    this.#epoch = epoch;
    this.#maxMessages = maxMessages;
    this.#maxPayloadBytes = maxPayloadBytes;
  }

  push(message: T): void {
    if (message.epoch !== this.#epoch) throw new Error("cannot queue a stale-epoch message");
    if (!Number.isSafeInteger(message.payloadBytes) || message.payloadBytes < 0 || message.payloadBytes > this.#maxPayloadBytes) {
      throw new Error("message exceeds timeline payload budget");
    }
    this.#messages.push(message);
    this.#payloadBytes += message.payloadBytes;
    this.#messages.sort(compareTimelineKeys);
    while (this.#messages.length > this.#maxMessages || this.#payloadBytes > this.#maxPayloadBytes) {
      const dropped = this.#messages.shift();
      if (!dropped) break;
      this.#payloadBytes -= dropped.payloadBytes;
      this.#droppedMessages += 1;
    }
    this.#peakMessages = Math.max(this.#peakMessages, this.#messages.length);
    this.#peakPayloadBytes = Math.max(this.#peakPayloadBytes, this.#payloadBytes);
  }

  drain(): T[] {
    const result = this.#messages.splice(0);
    this.#payloadBytes = 0;
    return result;
  }

  advanceEpoch(epoch: number): void {
    if (epoch <= this.#epoch) throw new Error("timeline epoch must advance monotonically");
    this.#epoch = epoch;
    this.#messages.length = 0;
    this.#payloadBytes = 0;
  }

  telemetry(): TimelineQueueTelemetry {
    return {
      messages: this.#messages.length,
      payloadBytes: this.#payloadBytes,
      droppedMessages: this.#droppedMessages,
      peakMessages: this.#peakMessages,
      peakPayloadBytes: this.#peakPayloadBytes,
    };
  }
}
