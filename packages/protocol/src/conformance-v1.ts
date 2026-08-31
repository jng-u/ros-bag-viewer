export const V1_CONFORMANCE_TRUTH_SCOPE =
  "deterministic local, in-process, and synthetic evidence; not browser, OS, ROS, network, or production certification" as const;

export const V1_CONFORMANCE_SOURCE_IDS = Object.freeze([
  "local-mcap",
  "local-ros1-bag",
  "local-ros2-sqlite",
  "hosted-source-bundle",
  "ros1-live",
  "ros2-live",
] as const);

export const V1_CONFORMANCE_SCHEMA_IDS = Object.freeze([
  "schema-present",
  "schema-resolvable",
  "opaque",
] as const);

export const V1_CONFORMANCE_TIME_TF_IDS = Object.freeze([
  "record-time",
  "header-time",
  "receipt-time",
  "clock-time",
  "source-epoch-invalidation",
  "tf-interpolation",
  "tf-missing",
  "tf-extrapolation",
] as const);

export const V1_CONFORMANCE_LIFECYCLE_IDS = Object.freeze([
  "register",
  "instantiate",
  "configure",
  "attach",
  "update",
  "render",
  "suspend",
  "error",
  "dispose",
] as const);

export const V1_CONFORMANCE_REJECTION_IDS = Object.freeze([
  "unknown-version",
  "extra-key",
  "operation-widening",
  "capability-escalation",
  "schema-conflict",
  "schema-oversize",
  "schema-depth",
  "lifetime-use-after-release",
  "lifetime-double-release",
  "lifetime-stale-epoch",
] as const);

export const V1_FROZEN_BROWSER_OPERATIONS = Object.freeze([
  "discover",
  "subscribe",
  "unsubscribe",
  "health",
] as const);

export const V1_FROZEN_EDGE_OPERATIONS = Object.freeze(["discover", "subscribe", "unsubscribe"] as const);

export const V1_FROZEN_EXTENSION_OPERATIONS = Object.freeze([
  "attachSource",
  "configure",
  "dispose",
  "handleError",
  "render",
  "suspend",
  "update",
] as const);

export const V1_FROZEN_EXTENSION_CAPABILITIES = Object.freeze([
  "bounded-resources",
  "diagnostics",
  "source-messages",
] as const);

export const V1_SCHEMA_LIMITS = Object.freeze({
  maxBytes: 1024 * 1024,
  maxDepth: 64,
  maxProviders: 8,
  maxTypeNameBytes: 256,
  maxProviderMetadataBytes: 256,
} as const);

export type V1ConformanceViolationCode =
  | "invalid-fixture"
  | "unsupported-version"
  | "operation-widening"
  | "capability-escalation"
  | "incomplete-conformance"
  | "schema-conflict"
  | "schema-oversize"
  | "schema-depth";

export class V1ConformanceViolation extends Error {
  readonly code: V1ConformanceViolationCode;

  constructor(code: V1ConformanceViolationCode, message: string) {
    super(message);
    this.name = "V1ConformanceViolation";
    this.code = code;
  }
}

interface ConformancePass {
  readonly id: string;
  readonly result: "pass";
  readonly evidence: string;
}

interface ConformanceRejection {
  readonly id: string;
  readonly result: "rejected";
  readonly evidence: string;
}

export interface V1ConformanceFixture {
  readonly fixtureVersion: 1;
  readonly protocolVersion: 1;
  readonly schemaVersion: 1;
  readonly freezeCandidate: true;
  readonly truthScope: typeof V1_CONFORMANCE_TRUTH_SCOPE;
  readonly browserOperations: readonly string[];
  readonly edgeOperations: readonly string[];
  readonly extensionOperations: readonly string[];
  readonly extensionCapabilities: readonly string[];
  readonly sources: readonly ConformancePass[];
  readonly schemas: readonly ConformancePass[];
  readonly timeTf: readonly ConformancePass[];
  readonly displayExtensionLifecycle: readonly ConformancePass[];
  readonly rejections: readonly ConformanceRejection[];
}

export interface FrozenV1Conformance extends V1ConformanceFixture {
  readonly frozen: true;
}

export interface V1SchemaProviderCandidate {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly contentHash: string;
}

export interface V1SchemaAdmission {
  readonly version: 1;
  readonly typeName: string;
  readonly schema: unknown;
  readonly providers: readonly V1SchemaProviderCandidate[];
}

const encoder = new TextEncoder();
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new V1ConformanceViolation("invalid-fixture", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new V1ConformanceViolation("invalid-fixture", `${label} has missing or unexpected fields`);
  }
}

function assertExactStringArray(
  value: unknown,
  expected: readonly string[],
  code: "operation-widening" | "capability-escalation" | "incomplete-conformance",
  label: string,
): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new V1ConformanceViolation("invalid-fixture", `${label} must be a string array`);
  }
  if (value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    throw new V1ConformanceViolation(code, `${label} does not match the frozen v1 contract`);
  }
}

function assertConformanceCases(
  value: unknown,
  expectedIds: readonly string[],
  result: "pass" | "rejected",
  label: string,
): asserts value is readonly (ConformancePass | ConformanceRejection)[] {
  if (!Array.isArray(value)) throw new V1ConformanceViolation("invalid-fixture", `${label} must be an array`);
  if (value.length !== expectedIds.length) {
    throw new V1ConformanceViolation("incomplete-conformance", `${label} does not cover every frozen v1 case`);
  }
  value.forEach((candidate, index) => {
    assertExactKeys(candidate, ["id", "result", "evidence"], `${label}[${index}]`);
    if (candidate.id !== expectedIds[index] || candidate.result !== result) {
      throw new V1ConformanceViolation("incomplete-conformance", `${label}[${index}] did not produce the required result`);
    }
    if (typeof candidate.evidence !== "string" || candidate.evidence.length === 0 || !candidate.evidence.endsWith(".test.ts")) {
      throw new V1ConformanceViolation("invalid-fixture", `${label}[${index}] requires a deterministic test evidence path`);
    }
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function parseV1ConformanceFixture(value: unknown): V1ConformanceFixture {
  assertExactKeys(value, [
    "fixtureVersion",
    "protocolVersion",
    "schemaVersion",
    "freezeCandidate",
    "truthScope",
    "browserOperations",
    "edgeOperations",
    "extensionOperations",
    "extensionCapabilities",
    "sources",
    "schemas",
    "timeTf",
    "displayExtensionLifecycle",
    "rejections",
  ], "v1 conformance fixture");

  if (value.fixtureVersion !== 1 || value.protocolVersion !== 1 || value.schemaVersion !== 1) {
    throw new V1ConformanceViolation("unsupported-version", "only exact fixture, protocol, and schema version 1 are supported");
  }
  if (value.freezeCandidate !== true || value.truthScope !== V1_CONFORMANCE_TRUTH_SCOPE) {
    throw new V1ConformanceViolation("invalid-fixture", "freeze intent and evidence scope must be explicit and exact");
  }

  assertExactStringArray(value.browserOperations, V1_FROZEN_BROWSER_OPERATIONS, "operation-widening", "browser operations");
  assertExactStringArray(value.edgeOperations, V1_FROZEN_EDGE_OPERATIONS, "operation-widening", "edge operations");
  assertExactStringArray(
    value.extensionOperations,
    V1_FROZEN_EXTENSION_OPERATIONS,
    "operation-widening",
    "extension operations",
  );
  assertExactStringArray(
    value.extensionCapabilities,
    V1_FROZEN_EXTENSION_CAPABILITIES,
    "capability-escalation",
    "extension capabilities",
  );
  assertConformanceCases(value.sources, V1_CONFORMANCE_SOURCE_IDS, "pass", "source conformance");
  assertConformanceCases(value.schemas, V1_CONFORMANCE_SCHEMA_IDS, "pass", "schema conformance");
  assertConformanceCases(value.timeTf, V1_CONFORMANCE_TIME_TF_IDS, "pass", "time/TF conformance");
  assertConformanceCases(
    value.displayExtensionLifecycle,
    V1_CONFORMANCE_LIFECYCLE_IDS,
    "pass",
    "display/extension lifecycle conformance",
  );
  assertConformanceCases(value.rejections, V1_CONFORMANCE_REJECTION_IDS, "rejected", "negative conformance");

  return value as unknown as V1ConformanceFixture;
}

export function freezeV1Conformance(value: unknown): FrozenV1Conformance {
  const fixture = parseV1ConformanceFixture(value);
  const frozen = JSON.parse(JSON.stringify({ ...fixture, frozen: true })) as FrozenV1Conformance;
  return deepFreeze(frozen);
}

export function validateV1SchemaAdmission(value: unknown): V1SchemaAdmission {
  assertExactKeys(value, ["version", "typeName", "schema", "providers"], "schema admission");
  if (value.version !== 1) throw new V1ConformanceViolation("unsupported-version", "only schema admission version 1 is supported");
  if (
    typeof value.typeName !== "string" ||
    value.typeName.length === 0 ||
    encoder.encode(value.typeName).byteLength > V1_SCHEMA_LIMITS.maxTypeNameBytes
  ) {
    throw new V1ConformanceViolation("invalid-fixture", "schema type name is invalid or oversized");
  }
  let encoded: string;
  try { encoded = JSON.stringify(value.schema); } catch { throw new V1ConformanceViolation("invalid-fixture", "schema content is not serializable"); }
  if (typeof encoded !== "string" || encoder.encode(encoded).byteLength > V1_SCHEMA_LIMITS.maxBytes) {
    throw new V1ConformanceViolation("schema-oversize", "schema exceeds the frozen v1 byte limit");
  }
  const depth = (item: unknown, seen = new Set<object>()): number => {
    if (typeof item !== "object" || item === null) return 0;
    if (seen.has(item)) throw new V1ConformanceViolation("invalid-fixture", "schema content contains a cycle");
    seen.add(item); return 1 + Math.max(0, ...Object.values(item).map((nested) => depth(nested, seen)));
  };
  if (depth(value.schema) > V1_SCHEMA_LIMITS.maxDepth) {
    throw new V1ConformanceViolation("schema-depth", "schema exceeds the frozen v1 depth limit");
  }
  if (!Array.isArray(value.providers) || value.providers.length === 0 || value.providers.length > V1_SCHEMA_LIMITS.maxProviders) {
    throw new V1ConformanceViolation("invalid-fixture", "schema providers are missing or exceed the frozen v1 limit");
  }

  const hashes = new Set<string>();
  value.providers.forEach((provider, index) => {
    assertExactKeys(provider, ["providerId", "providerVersion", "contentHash"], `schema provider[${index}]`);
    if (
      typeof provider.providerId !== "string" || provider.providerId.length === 0 ||
      typeof provider.providerVersion !== "string" || provider.providerVersion.length === 0 ||
      encoder.encode(provider.providerId as string).byteLength > V1_SCHEMA_LIMITS.maxProviderMetadataBytes ||
      encoder.encode(provider.providerVersion as string).byteLength > V1_SCHEMA_LIMITS.maxProviderMetadataBytes ||
      typeof provider.contentHash !== "string" || !digestPattern.test(provider.contentHash)
    ) {
      throw new V1ConformanceViolation("invalid-fixture", `schema provider[${index}] is invalid`);
    }
    hashes.add(provider.contentHash);
  });
  if (hashes.size > 1) throw new V1ConformanceViolation("schema-conflict", "schema providers disagree on content hash");
  return value as unknown as V1SchemaAdmission;
}
