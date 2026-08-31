export const LIVE_PROTOCOL_VERSION = 1 as const;

export * from "./conformance-v1.js";

import { CanonicalDataError, canonicalizePlainData } from "./canonical.js";

export const BROWSER_OPERATIONS = Object.freeze(["discover", "subscribe", "unsubscribe", "health"] as const);
export type BrowserOperation = (typeof BROWSER_OPERATIONS)[number];

export const EDGE_OPERATIONS = Object.freeze(["discover", "subscribe", "unsubscribe"] as const);
export type EdgeOperation = (typeof EDGE_OPERATIONS)[number];

export type ProtocolViolationCode =
  | "invalid-frame"
  | "frame-too-large"
  | "unsupported-version"
  | "operation-denied"
  | "invalid-field"
  | "duplicate-key"
  | "expired-plan";

export class ProtocolViolation extends Error {
  readonly code: ProtocolViolationCode;

  constructor(code: ProtocolViolationCode, message: string) {
    super(message);
    this.name = "ProtocolViolation";
    this.code = code;
  }
}

export interface ProtocolLimits {
  readonly maxFrameBytes: number;
  readonly maxIdentifierBytes: number;
  readonly maxTopicBytes: number;
  readonly maxTypeBytes: number;
  readonly maxRateHz: number;
  readonly maxMessageBytes: number;
}

export const DEFAULT_PROTOCOL_LIMITS: ProtocolLimits = Object.freeze({
  maxFrameBytes: 16 * 1024,
  maxIdentifierBytes: 128,
  maxTopicBytes: 256,
  maxTypeBytes: 256,
  maxRateHz: 1_000,
  maxMessageBytes: 16 * 1024 * 1024,
});

interface BrowserFrameBase {
  readonly version: 1;
  readonly sessionId: string;
  readonly sequence: number;
  readonly requestId: string;
}

export interface DiscoverFrame extends BrowserFrameBase {
  readonly operation: "discover";
}

export interface SubscribeFrame extends BrowserFrameBase {
  readonly operation: "subscribe";
  readonly subscriptionId: string;
  readonly topic: string;
  readonly type: string;
  readonly maxRateHz: number;
  readonly maxMessageBytes: number;
}

export interface UnsubscribeFrame extends BrowserFrameBase {
  readonly operation: "unsubscribe";
  readonly subscriptionId: string;
}

export interface HealthFrame extends BrowserFrameBase {
  readonly operation: "health";
}

export type BrowserFrame = DiscoverFrame | SubscribeFrame | UnsubscribeFrame | HealthFrame;

export interface TopicDescriptor {
  readonly topic: string;
  readonly type: string;
  readonly maxRateHz: number;
  readonly maxMessageBytes: number;
  readonly schemaHash?: string;
}

export interface RelayHealth {
  readonly state: "open" | "closed";
  readonly connectionEpoch: number;
  readonly activeSubscriptions: number;
  readonly queueDepth: number;
  readonly queueBytes: number;
  readonly queueHighWaterMessages: number;
  readonly queueHighWaterBytes: number;
  readonly droppedMessages: number;
  readonly droppedBytes: number;
  readonly rejectedFrames: number;
}

export type RelayErrorCode =
  | "unauthorized"
  | "invalid-request"
  | "replayed-request"
  | "policy-denied"
  | "quota-exceeded"
  | "edge-unavailable"
  | "closed";

export type RelayResponse =
  | Readonly<{ version: 1; kind: "discovery"; requestId: string; topics: readonly TopicDescriptor[] }>
  | Readonly<{ version: 1; kind: "ack"; requestId: string; operation: "subscribe" | "unsubscribe" }>
  | Readonly<{ version: 1; kind: "health"; requestId: string; health: RelayHealth }>
  | Readonly<{ version: 1; kind: "error"; requestId?: string; code: RelayErrorCode; message: string }>;

export interface RelayDataEvent {
  readonly version: 1;
  readonly kind: "message";
  readonly subscriptionId: string;
  readonly sourceSequence: number;
  readonly timestampNanos: string;
  readonly payload: Uint8Array;
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

export interface EdgeDiscoverPlan extends EdgePlanBase {
  readonly operation: "discover";
}

export interface EdgeSubscribePlan extends EdgePlanBase {
  readonly operation: "subscribe";
  readonly subscriptionId: string;
  readonly topic: string;
  readonly type: string;
  readonly maxRateHz: number;
  readonly maxMessageBytes: number;
}

export interface EdgeUnsubscribePlan extends EdgePlanBase {
  readonly operation: "unsubscribe";
  readonly subscriptionId: string;
}

export type EdgePlan = EdgeDiscoverPlan | EdgeSubscribePlan | EdgeUnsubscribePlan;

export interface RelayEdgeIdentity {
  readonly identityId: string;
  readonly credential: string;
}

export type EdgeReply =
  | Readonly<{ version: 1; kind: "discovery"; topics: readonly TopicDescriptor[] }>
  | Readonly<{ version: 1; kind: "ack"; operation: "subscribe" | "unsubscribe" }>;

const encoder = new TextEncoder();
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const topicPattern = /^\/[A-Za-z0-9_.~/-]+$/;
const typePattern = /^[A-Za-z0-9_]+\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)?$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function assertSafePositive(value: unknown, name: string, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new ProtocolViolation("invalid-field", `${name} is outside the allowed range`);
  }
}

function assertSafeNonNegative(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolViolation("invalid-field", `${name} must be a non-negative safe integer`);
  }
}

function assertIdentifier(value: unknown, name: string, limits: ProtocolLimits): asserts value is string {
  if (
    typeof value !== "string" ||
    !identifierPattern.test(value) ||
    byteLength(value) > limits.maxIdentifierBytes
  ) {
    throw new ProtocolViolation("invalid-field", `${name} is invalid`);
  }
}

function assertTopic(value: unknown, limits: ProtocolLimits): asserts value is string {
  if (
    typeof value !== "string" ||
    !topicPattern.test(value) ||
    value.includes("//") ||
    [..."*?[]{}"].some((forbidden) => value.includes(forbidden)) ||
    byteLength(value) > limits.maxTopicBytes
  ) {
    throw new ProtocolViolation("invalid-field", "topic must be an exact normalized name without wildcards");
  }
}

function assertType(value: unknown, limits: ProtocolLimits): asserts value is string {
  if (typeof value !== "string" || !typePattern.test(value) || byteLength(value) > limits.maxTypeBytes) {
    throw new ProtocolViolation("invalid-field", "type must be an exact ROS type name");
  }
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== "string") || keys.some((key) => !allowedKeys.has(key as string)) || keys.length !== allowed.length) {
    throw new ProtocolViolation("invalid-frame", "frame has missing or unexpected fields");
  }
}

function canonicalRecord(value: unknown, label: string): Record<string, unknown> {
  try {
    const canonical = canonicalizePlainData(value, { label });
    if (!isRecord(canonical)) throw new ProtocolViolation("invalid-frame", `${label} must be an object`);
    return canonical;
  } catch (error) {
    if (error instanceof CanonicalDataError) throw new ProtocolViolation("invalid-frame", error.message);
    throw error;
  }
}

function canonicalLimits(value: unknown): ProtocolLimits {
  const limits = canonicalRecord(value, "protocol limits");
  const keys = ["maxFrameBytes", "maxIdentifierBytes", "maxTopicBytes", "maxTypeBytes", "maxRateHz", "maxMessageBytes"] as const;
  assertExactKeys(limits, keys);
  for (const key of keys) {
    if (!Number.isSafeInteger(limits[key]) || (limits[key] as number) <= 0) {
      throw new ProtocolViolation("invalid-field", `${key} must be a positive safe integer`);
    }
  }
  return limits as unknown as ProtocolLimits;
}

function assertFrameBytes(value: unknown, limits: ProtocolLimits): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ProtocolViolation("invalid-frame", "frame is not JSON serializable");
  }
  if (encoded === undefined || byteLength(encoded) > limits.maxFrameBytes) {
    throw new ProtocolViolation("frame-too-large", "frame exceeds the configured byte ceiling");
  }
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function readJsonString(text: string, start: number): { readonly value: string; readonly end: number } {
  if (text[start] !== '"') throw new ProtocolViolation("invalid-frame", "object key must be a string");
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (text[cursor] === '"') {
      const raw = text.slice(start, cursor + 1);
      try {
        return { value: JSON.parse(raw) as string, end: cursor + 1 };
      } catch {
        throw new ProtocolViolation("invalid-frame", "invalid JSON string");
      }
    }
    cursor += 1;
  }
  throw new ProtocolViolation("invalid-frame", "unterminated JSON string");
}

function skipJsonValue(text: string, start: number): number {
  let cursor = skipWhitespace(text, start);
  if (text[cursor] === '"') return readJsonString(text, cursor).end;
  if (text[cursor] === "{" || text[cursor] === "[") {
    const open = text[cursor]!;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    while (cursor < text.length) {
      if (text[cursor] === '"') {
        cursor = readJsonString(text, cursor).end;
        continue;
      }
      if (text[cursor] === open) depth += 1;
      if (text[cursor] === close) {
        depth -= 1;
        if (depth === 0) return cursor + 1;
      }
      cursor += 1;
    }
    throw new ProtocolViolation("invalid-frame", "unterminated JSON value");
  }
  while (cursor < text.length && text[cursor] !== "," && text[cursor] !== "}") cursor += 1;
  return cursor;
}

function assertNoDuplicateTopLevelKeys(text: string): void {
  let cursor = skipWhitespace(text, 0);
  if (text[cursor] !== "{") return;
  cursor = skipWhitespace(text, cursor + 1);
  const keys = new Set<string>();
  while (cursor < text.length && text[cursor] !== "}") {
    const key = readJsonString(text, cursor);
    if (keys.has(key.value)) throw new ProtocolViolation("duplicate-key", "frame contains a duplicate key");
    keys.add(key.value);
    cursor = skipWhitespace(text, key.end);
    if (text[cursor] !== ":") throw new ProtocolViolation("invalid-frame", "object key is missing a value");
    cursor = skipWhitespace(text, skipJsonValue(text, cursor + 1));
    if (text[cursor] === ",") cursor = skipWhitespace(text, cursor + 1);
    else if (text[cursor] !== "}") throw new ProtocolViolation("invalid-frame", "invalid object separator");
  }
}

export function parseBrowserFrameJson(
  text: string,
  limits: ProtocolLimits = DEFAULT_PROTOCOL_LIMITS,
): BrowserFrame {
  const canonicalProtocolLimits = canonicalLimits(limits);
  if (byteLength(text) > canonicalProtocolLimits.maxFrameBytes) {
    throw new ProtocolViolation("frame-too-large", "frame exceeds the configured byte ceiling");
  }
  assertNoDuplicateTopLevelKeys(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolViolation("invalid-frame", "frame is not valid JSON");
  }
  return parseBrowserFrame(value, canonicalProtocolLimits);
}

export function parseBrowserFrame(
  value: unknown,
  limits: ProtocolLimits = DEFAULT_PROTOCOL_LIMITS,
): BrowserFrame {
  const canonicalProtocolLimits = canonicalLimits(limits);
  const frame = canonicalRecord(value, "frame");
  assertFrameBytes(frame, canonicalProtocolLimits);
  if (frame.version !== LIVE_PROTOCOL_VERSION) {
    throw new ProtocolViolation("unsupported-version", "protocol version is not supported");
  }
  if (typeof frame.operation !== "string" || !(BROWSER_OPERATIONS as readonly string[]).includes(frame.operation)) {
    throw new ProtocolViolation("operation-denied", "operation is not permitted by the read-only protocol");
  }
  assertIdentifier(frame.sessionId, "sessionId", canonicalProtocolLimits);
  assertSafeNonNegative(frame.sequence, "sequence");
  assertIdentifier(frame.requestId, "requestId", canonicalProtocolLimits);

  const common = ["version", "operation", "sessionId", "sequence", "requestId"];
  switch (frame.operation) {
    case "discover":
    case "health":
      assertExactKeys(frame, common);
      return frame as unknown as DiscoverFrame | HealthFrame;
    case "unsubscribe":
      assertExactKeys(frame, [...common, "subscriptionId"]);
      assertIdentifier(frame.subscriptionId, "subscriptionId", canonicalProtocolLimits);
      return frame as unknown as UnsubscribeFrame;
    case "subscribe":
      assertExactKeys(frame, [
        ...common,
        "subscriptionId",
        "topic",
        "type",
        "maxRateHz",
        "maxMessageBytes",
      ]);
      assertIdentifier(frame.subscriptionId, "subscriptionId", canonicalProtocolLimits);
      assertTopic(frame.topic, canonicalProtocolLimits);
      assertType(frame.type, canonicalProtocolLimits);
      assertSafePositive(frame.maxRateHz, "maxRateHz", canonicalProtocolLimits.maxRateHz);
      assertSafePositive(frame.maxMessageBytes, "maxMessageBytes", canonicalProtocolLimits.maxMessageBytes);
      return frame as unknown as SubscribeFrame;
    default:
      throw new ProtocolViolation("operation-denied", "operation is not permitted by the read-only protocol");
  }
}

export function validateTopicDescriptor(
  value: unknown,
  limits: ProtocolLimits = DEFAULT_PROTOCOL_LIMITS,
): TopicDescriptor {
  const canonicalProtocolLimits = canonicalLimits(limits);
  const descriptor = canonicalRecord(value, "topic descriptor");
  const allowed = descriptor.schemaHash === undefined
    ? ["topic", "type", "maxRateHz", "maxMessageBytes"]
    : ["topic", "type", "maxRateHz", "maxMessageBytes", "schemaHash"];
  assertExactKeys(descriptor, allowed);
  assertTopic(descriptor.topic, canonicalProtocolLimits);
  assertType(descriptor.type, canonicalProtocolLimits);
  assertSafePositive(descriptor.maxRateHz, "maxRateHz", canonicalProtocolLimits.maxRateHz);
  assertSafePositive(descriptor.maxMessageBytes, "maxMessageBytes", canonicalProtocolLimits.maxMessageBytes);
  if (descriptor.schemaHash !== undefined && (typeof descriptor.schemaHash !== "string" || !digestPattern.test(descriptor.schemaHash))) {
    throw new ProtocolViolation("invalid-field", "schemaHash is invalid");
  }
  return descriptor as unknown as TopicDescriptor;
}

export function validateEdgePlan(
  value: unknown,
  options: Readonly<{ nowMs: number; maxTtlMs: number; limits?: ProtocolLimits }>,
): EdgePlan {
  const canonicalOptions = canonicalRecord(options, "edge plan options");
  assertExactKeys(canonicalOptions, canonicalOptions.limits === undefined ? ["nowMs", "maxTtlMs"] : ["nowMs", "maxTtlMs", "limits"]);
  assertSafeNonNegative(canonicalOptions.nowMs, "nowMs");
  assertSafePositive(canonicalOptions.maxTtlMs, "maxTtlMs", Number.MAX_SAFE_INTEGER);
  const limits = canonicalLimits(canonicalOptions.limits ?? DEFAULT_PROTOCOL_LIMITS);
  const plan = canonicalRecord(value, "edge plan");
  assertFrameBytes(plan, limits);
  if (plan.version !== LIVE_PROTOCOL_VERSION) throw new ProtocolViolation("unsupported-version", "protocol version is not supported");
  if (typeof plan.operation !== "string" || !(EDGE_OPERATIONS as readonly string[]).includes(plan.operation)) {
    throw new ProtocolViolation("operation-denied", "edge operation is not permitted");
  }
  assertIdentifier(plan.sessionId, "sessionId", limits);
  assertIdentifier(plan.connectionId, "connectionId", limits);
  assertSafeNonNegative(plan.sequence, "sequence");
  assertIdentifier(plan.nonce, "nonce", limits);
  assertSafeNonNegative(plan.issuedAtMs, "issuedAtMs");
  assertSafeNonNegative(plan.expiresAtMs, "expiresAtMs");
  if (
    typeof plan.allowlistDigest !== "string" ||
    !digestPattern.test(plan.allowlistDigest) ||
    byteLength(plan.allowlistDigest) > limits.maxIdentifierBytes
  ) {
    throw new ProtocolViolation("invalid-field", "allowlistDigest is invalid");
  }
  if (
    plan.expiresAtMs <= (canonicalOptions.nowMs as number) ||
    plan.expiresAtMs <= plan.issuedAtMs ||
    plan.expiresAtMs - plan.issuedAtMs > (canonicalOptions.maxTtlMs as number)
  ) {
    throw new ProtocolViolation("expired-plan", "edge plan is expired or exceeds its allowed lifetime");
  }

  const common = [
    "version",
    "operation",
    "sessionId",
    "connectionId",
    "sequence",
    "nonce",
    "issuedAtMs",
    "expiresAtMs",
    "allowlistDigest",
  ];
  if (plan.operation === "discover") {
    assertExactKeys(plan, common);
    return plan as unknown as EdgeDiscoverPlan;
  }
  assertIdentifier(plan.subscriptionId, "subscriptionId", limits);
  if (plan.operation === "unsubscribe") {
    assertExactKeys(plan, [...common, "subscriptionId"]);
    return plan as unknown as EdgeUnsubscribePlan;
  }
  assertExactKeys(plan, [...common, "subscriptionId", "topic", "type", "maxRateHz", "maxMessageBytes"]);
  assertTopic(plan.topic, limits);
  assertType(plan.type, limits);
  assertSafePositive(plan.maxRateHz, "maxRateHz", limits.maxRateHz);
  assertSafePositive(plan.maxMessageBytes, "maxMessageBytes", limits.maxMessageBytes);
  return plan as unknown as EdgeSubscribePlan;
}
