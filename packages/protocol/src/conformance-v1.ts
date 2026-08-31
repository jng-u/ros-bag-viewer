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

const V1_CONFORMANCE_EVIDENCE: Readonly<Record<string, string>> = Object.freeze({
  "local-mcap": "packages/source-mcap/test/index.test.ts",
  "local-ros1-bag": "packages/source-ros1bag/test/index.test.ts",
  "local-ros2-sqlite": "packages/source-ros2-sqlite/test/index.test.ts",
  "hosted-source-bundle": "packages/source-hosted/test/index.test.ts",
  "ros1-live": "tests/m3-live/security-gate.test.ts",
  "ros2-live": "tests/m3-live/security-gate.test.ts",
  "schema-present": "packages/source-mcap/test/index.test.ts",
  "schema-resolvable": "packages/source-ros2-sqlite/test/index.test.ts",
  opaque: "packages/displays-core/test/index.test.ts",
  "record-time": "packages/timeline/test/index.test.ts",
  "header-time": "packages/timeline/test/index.test.ts",
  "receipt-time": "packages/source-live/test/index.test.ts",
  "clock-time": "packages/timeline/test/index.test.ts",
  "source-epoch-invalidation": "packages/core-model/test/index.test.ts",
  "tf-interpolation": "packages/tf/test/index.test.ts",
  "tf-missing": "packages/tf/test/index.test.ts",
  "tf-extrapolation": "packages/tf/test/index.test.ts",
  register: "packages/extension-api/test/index.test.ts",
  instantiate: "packages/extension-api/test/index.test.ts",
  configure: "packages/extension-api/test/index.test.ts",
  attach: "packages/extension-api/test/index.test.ts",
  update: "packages/extension-api/test/index.test.ts",
  render: "packages/extension-api/test/index.test.ts",
  suspend: "packages/extension-api/test/index.test.ts",
  error: "packages/extension-api/test/index.test.ts",
  dispose: "packages/extension-api/test/index.test.ts",
  "unknown-version": "packages/protocol/test/conformance-v1.test.ts",
  "extra-key": "packages/protocol/test/conformance-v1.test.ts",
  "operation-widening": "packages/protocol/test/conformance-v1.test.ts",
  "capability-escalation": "packages/protocol/test/conformance-v1.test.ts",
  "schema-conflict": "packages/protocol/test/conformance-v1.test.ts",
  "schema-oversize": "packages/protocol/test/conformance-v1.test.ts",
  "schema-depth": "packages/protocol/test/conformance-v1.test.ts",
  "lifetime-use-after-release": "packages/protocol/test/conformance-v1.test.ts",
  "lifetime-double-release": "packages/protocol/test/conformance-v1.test.ts",
  "lifetime-stale-epoch": "packages/protocol/test/conformance-v1.test.ts",
});

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
  readonly schema: unknown;
}

export interface V1SchemaAdmission {
  readonly version: 1;
  readonly typeName: string;
  readonly providers: readonly V1SchemaProviderCandidate[];
}

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new V1ConformanceViolation("invalid-fixture", `${label} must be an object`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) throw new V1ConformanceViolation("invalid-fixture", `${label} has symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || "get" in descriptor || "set" in descriptor)) {
    throw new V1ConformanceViolation("invalid-fixture", `${label} has hidden or accessor fields`);
  }
  const actual = (keys as string[]).sort();
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
    if (candidate.evidence !== V1_CONFORMANCE_EVIDENCE[expectedIds[index]!]) {
      throw new V1ConformanceViolation("invalid-fixture", `${label}[${index}] does not name its frozen case evidence`);
    }
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function canonicalPlainData(value: unknown, label: string, depth = 0, counter = { value: 0 }): unknown {
  if (++counter.value > 100_000) throw new V1ConformanceViolation("invalid-fixture", `${label} exceeds the item limit`);
  if (depth > V1_SCHEMA_LIMITS.maxDepth) throw new V1ConformanceViolation("schema-depth", `${label} exceeds the depth limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new V1ConformanceViolation("invalid-fixture", `${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") throw new V1ConformanceViolation("invalid-fixture", `${label} contains executable or unsupported data`);
  if (Array.isArray(value)) {
    const expected = ["length", ...value.map((_, index) => String(index))].sort();
    const actual = Reflect.ownKeys(value).map(String).sort();
    if (actual.join() !== expected.join()) throw new V1ConformanceViolation("invalid-fixture", `${label} contains augmented array fields`);
    return value.map((item, index) => canonicalPlainData(item, `${label}[${index}]`, depth + 1, counter));
  }
  if (!isRecord(value)) throw new V1ConformanceViolation("invalid-fixture", `${label} must contain plain data`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) throw new V1ConformanceViolation("invalid-fixture", `${label} contains symbols`);
  const output: Record<string, unknown> = {};
  for (const key of (keys as string[]).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) throw new V1ConformanceViolation("invalid-fixture", `${label} contains hidden or accessor data`);
    output[key] = canonicalPlainData(descriptor.value, `${label}.${key}`, depth + 1, counter);
  }
  return output;
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
  const canonical = canonicalPlainData(value, "v1 conformance fixture");
  const fixture = parseV1ConformanceFixture(canonical);
  const frozen = { ...fixture, frozen: true } as FrozenV1Conformance;
  return deepFreeze(frozen);
}

export function validateV1SchemaAdmission(value: unknown): V1SchemaAdmission {
  const canonical = canonicalPlainData(value, "schema admission") as Record<string, unknown>;
  assertExactKeys(canonical, ["version", "typeName", "providers"], "schema admission");
  const admission = canonical;
  if (admission.version !== 1) throw new V1ConformanceViolation("unsupported-version", "only schema admission version 1 is supported");
  if (
    typeof admission.typeName !== "string" ||
    admission.typeName.length === 0 ||
    encoder.encode(admission.typeName).byteLength > V1_SCHEMA_LIMITS.maxTypeNameBytes
  ) {
    throw new V1ConformanceViolation("invalid-fixture", "schema type name is invalid or oversized");
  }
  if (!Array.isArray(admission.providers) || admission.providers.length === 0 || admission.providers.length > V1_SCHEMA_LIMITS.maxProviders) {
    throw new V1ConformanceViolation("invalid-fixture", "schema providers are missing or exceed the frozen v1 limit");
  }

  const schemas = new Set<string>();
  admission.providers.forEach((provider, index) => {
    assertExactKeys(provider, ["providerId", "providerVersion", "schema"], `schema provider[${index}]`);
    if (encoder.encode(JSON.stringify(provider.schema)).byteLength > V1_SCHEMA_LIMITS.maxBytes) {
      throw new V1ConformanceViolation("schema-oversize", `schema provider[${index}] exceeds the byte limit`);
    }
    if (
      typeof provider.providerId !== "string" || provider.providerId.length === 0 ||
      typeof provider.providerVersion !== "string" || provider.providerVersion.length === 0 ||
      encoder.encode(provider.providerId as string).byteLength > V1_SCHEMA_LIMITS.maxProviderMetadataBytes ||
      encoder.encode(provider.providerVersion as string).byteLength > V1_SCHEMA_LIMITS.maxProviderMetadataBytes
    ) {
      throw new V1ConformanceViolation("invalid-fixture", `schema provider[${index}] is invalid`);
    }
    schemas.add(JSON.stringify(provider.schema));
  });
  if (schemas.size > 1) throw new V1ConformanceViolation("schema-conflict", "schema providers disagree on canonical content");
  return deepFreeze(admission as unknown as V1SchemaAdmission);
}
