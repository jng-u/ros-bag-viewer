export type SourceId = string & { readonly __sourceId: unique symbol };
export type SourceEpoch = number & { readonly __sourceEpoch: unique symbol };
export type SourceEntryId = string & { readonly __sourceEntryId: unique symbol };
export type ChannelId = string & { readonly __channelId: unique symbol };

export type RecordedSourceFormat = "mcap" | "ros1-bag" | "ros2-sqlite";

export interface RecordedSourceRegistration {
  readonly format: RecordedSourceFormat;
  readonly extensions: readonly string[];
  readonly multipart: boolean;
  readonly indexedSeek: "native" | "degraded-when-unindexed";
  readonly capabilityDiagnostic?: string;
}

export const BUILTIN_RECORDED_SOURCES: readonly RecordedSourceRegistration[] = Object.freeze([
  Object.freeze({
    format: "mcap" as const,
    extensions: Object.freeze([".mcap"]),
    multipart: false,
    indexedSeek: "degraded-when-unindexed" as const,
  }),
  Object.freeze({
    format: "ros1-bag" as const,
    extensions: Object.freeze([".bag"]),
    multipart: false,
    indexedSeek: "degraded-when-unindexed" as const,
    capabilityDiagnostic: "bz2/lz4 require an explicitly supplied bounded decoder adapter",
  }),
  Object.freeze({
    format: "ros2-sqlite" as const,
    extensions: Object.freeze(["metadata.yaml", ".db3"]),
    multipart: true,
    indexedSeek: "native" as const,
    capabilityDiagnostic: "requires a read-only browser-compatible SQLite query provider",
  }),
]);

export function recordedSourceRegistration(format: RecordedSourceFormat): RecordedSourceRegistration {
  const registration = BUILTIN_RECORDED_SOURCES.find((candidate) => candidate.format === format);
  if (!registration) throw new Error(`unknown recorded source format ${format}`);
  return registration;
}

export interface ByteRange {
  readonly offset: bigint;
  readonly length: bigint;
}

export interface LocalBlobSource {
  readonly kind: "local-blob";
  readonly sourceId: SourceId;
}

export interface GrantedRangeSource {
  readonly kind: "granted-range";
  readonly sourceId: SourceId;
  readonly immutableVersion: string;
}

export type ByteSource = LocalBlobSource | GrantedRangeSource;

export interface SourceEntry {
  readonly entryId: SourceEntryId;
  readonly relativePath: string;
  readonly sizeBytes: bigint;
  readonly immutableVersion: string;
  readonly sha256?: string;
  readonly byteSource: ByteSource;
}

export type SourceRelationKind = "metadata-for" | "ordered-part" | "sidecar-index";

export interface SourceRelation {
  readonly fromEntryId: SourceEntryId;
  readonly toEntryId: SourceEntryId;
  readonly kind: SourceRelationKind;
  readonly ordinal?: number;
}

export interface SourceBundle {
  readonly bundleId: string;
  readonly version: 1;
  readonly entries: readonly SourceEntry[];
  readonly relations: readonly SourceRelation[];
}

export type SchemaCapability = "schema-present" | "schema-resolvable" | "opaque";

export interface SchemaProviderProvenance {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly contentHash?: string;
  readonly sourceEntryId?: SourceEntryId;
}

export interface SchemaResolution {
  readonly capability: SchemaCapability;
  readonly typeName: string;
  readonly provenance: readonly SchemaProviderProvenance[];
  readonly diagnostic?: string;
}

export type TimestampSource = "record" | "header" | "receipt" | "clock";

export interface NormalizedTime {
  readonly valueNanos: bigint;
  readonly source: TimestampSource;
  readonly epoch: SourceEpoch;
}

export interface SchedulingPolicy {
  readonly kind: "scheduling";
  readonly preferred: "record" | "header" | "clock";
  readonly fallback: "diagnostic-record" | "quarantine";
}

export interface TfQueryPolicy {
  readonly kind: "tf-query";
  readonly preferred: "header";
  readonly fallback: "diagnostic-scheduling" | "error";
}

export interface LatencyPolicy {
  readonly kind: "latency";
  readonly measurement: "synchronized-source-to-render" | "relay-browser-transit";
  readonly clockSyncErrorNanos?: bigint;
}

export interface TfPolicy {
  readonly interpolation: "linear" | "none";
  readonly cacheHorizonNanos: bigint;
  readonly allowStatic: boolean;
  readonly extrapolation: "error" | "diagnostic";
}

export interface PayloadLease {
  readonly epoch: SourceEpoch;
  readonly byteLength: number;
  readonly retainCount: number;
  readonly released: boolean;
  retain(): PayloadLease;
  release(): void;
  assertUsable(epoch: SourceEpoch): void;
}

export class ReferenceCountedPayloadLease implements PayloadLease {
  readonly epoch: SourceEpoch;
  readonly byteLength: number;
  #retainCount = 1;
  #invalidated = false;

  constructor(epoch: SourceEpoch, byteLength: number) {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error("payload byteLength must be a non-negative safe integer");
    }
    this.epoch = epoch;
    this.byteLength = byteLength;
  }

  get retainCount(): number {
    return this.#retainCount;
  }

  get released(): boolean {
    return this.#invalidated || this.#retainCount === 0;
  }

  retain(): PayloadLease {
    if (this.released) throw new Error("cannot retain a released payload lease");
    this.#retainCount += 1;
    return this;
  }

  release(): void {
    if (this.#retainCount === 0) throw new Error("payload lease released more than retained");
    this.#retainCount -= 1;
  }

  invalidate(): void {
    this.#invalidated = true;
    this.#retainCount = 0;
  }

  assertUsable(epoch: SourceEpoch): void {
    if (this.epoch !== epoch || this.released) {
      throw new Error("payload lease is not valid for the active source epoch");
    }
  }
}

export interface NormalizedMessageEnvelope {
  readonly version: 1;
  readonly sourceId: SourceId;
  readonly channelId: ChannelId;
  readonly sourceSequence: bigint;
  readonly epoch: SourceEpoch;
  readonly schedulingTime: NormalizedTime;
  readonly tfQueryTime?: NormalizedTime;
  readonly schema: SchemaResolution;
  readonly payload: PayloadLease;
  readonly nativeTypeMetadata: Readonly<Record<string, string>>;
  readonly diagnostics: readonly string[];
}

export type DisplayState =
  | "registered"
  | "instantiated"
  | "configured"
  | "attached"
  | "rendering"
  | "suspended"
  | "error"
  | "disposed";

export interface DisplayLifecycle {
  readonly state: DisplayState;
  register(): void;
  instantiate(): void;
  configure(config: unknown): void;
  attachSource(epoch: SourceEpoch): void;
  update(message: NormalizedMessageEnvelope): void;
  render(): void;
  suspend(): void;
  handleError(error: Error): void;
  dispose(): void;
}

function assertNormalizedRelativePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error("source path must be a non-empty normalized relative POSIX path");
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("source path contains an empty or traversal segment");
  }
}

export function assertBundle(bundle: SourceBundle): void {
  if (!bundle.bundleId || bundle.version !== 1 || bundle.entries.length === 0) {
    throw new Error("SourceBundle requires an id, version 1, and at least one entry");
  }

  const entryIds = new Set<SourceEntryId>();
  for (const entry of bundle.entries) {
    assertNormalizedRelativePath(entry.relativePath);
    if (entry.sizeBytes < 0n || !entry.immutableVersion) throw new Error("invalid source entry");
    if (entryIds.has(entry.entryId)) throw new Error("duplicate source entry id");
    entryIds.add(entry.entryId);
  }

  for (const relation of bundle.relations) {
    if (!entryIds.has(relation.fromEntryId) || !entryIds.has(relation.toEntryId)) {
      throw new Error("source relation references an unknown entry");
    }
    const ordinal = relation.ordinal;
    if (relation.kind === "ordered-part" && (ordinal === undefined || !Number.isInteger(ordinal) || ordinal < 0)) {
      throw new Error("ordered multipart relation requires a non-negative ordinal");
    }
  }
}

export function assertEpoch(lease: PayloadLease, epoch: SourceEpoch): void {
  lease.assertUsable(epoch);
}
