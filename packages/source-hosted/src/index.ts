export interface HostedByteRange {
  readonly offset: bigint;
  readonly length: bigint;
}

export interface HostedRangeSource {
  readonly size: bigint;
  readonly immutableVersion: string;
  read(range: HostedByteRange, signal: AbortSignal): Promise<Uint8Array>;
}

export interface SignedManifestEnvelope {
  readonly payload: string;
  readonly signature: string;
  readonly keyId: string;
  readonly algorithm: string;
}

export interface HostedManifestChunk {
  readonly offset: bigint;
  readonly length: bigint;
  readonly sha256: string;
}

export interface HostedManifestEntry {
  readonly entryId: string;
  readonly relativePath: string;
  readonly sizeBytes: bigint;
  readonly objectId: string;
  readonly immutableVersion: string;
  readonly sha256: string;
  readonly chunks: readonly HostedManifestChunk[];
}

export type HostedRelationKind = "metadata-for" | "ordered-part" | "sidecar-index";

export interface HostedManifestRelation {
  readonly fromEntryId: string;
  readonly toEntryId: string;
  readonly kind: HostedRelationKind;
  readonly ordinal?: number;
}

export interface VerifiedHostedManifest {
  readonly verification: "verified-signature";
  readonly bundleId: string;
  readonly version: 1;
  readonly sessionId: string;
  readonly validFromMs: number;
  readonly expiresAtMs: number;
  readonly entries: readonly HostedManifestEntry[];
  readonly relations: readonly HostedManifestRelation[];
}

export interface HostedManifestVerifier {
  verify(envelope: SignedManifestEnvelope, signal: AbortSignal): Promise<VerifiedHostedManifest>;
}

export interface HostedGrantScope {
  readonly sessionId: string;
  readonly objectId: string;
  readonly immutableVersion: string;
  readonly offset: bigint;
  readonly length: bigint;
}

export interface HostedRangeGrant extends HostedGrantScope {
  readonly token: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface HostedRangeTransport {
  issueRangeGrant(
    capability: string,
    serializedScope: string,
    signal: AbortSignal,
    admitSerializedGrant: (serializedGrant: unknown) => void,
  ): Promise<void>;
  fetchRange(serializedGrant: string, signal: AbortSignal): Promise<Uint8Array>;
  /** Consume/record a fresh exact authorization before serving verified cached bytes. Omit to disable persistent caching. */
  authorizeCachedRange?(serializedGrant: string, signal: AbortSignal): Promise<void>;
}

export interface HostedBundleEntry {
  readonly entryId: string;
  readonly relativePath: string;
  readonly sizeBytes: bigint;
  readonly immutableVersion: string;
  readonly sha256: string;
  readonly byteSource: {
    readonly kind: "granted-range";
    readonly sourceId: string;
    readonly immutableVersion: string;
  };
}

export interface HostedSourceBundle {
  readonly bundleId: string;
  readonly version: 1;
  readonly entries: readonly HostedBundleEntry[];
  readonly relations: readonly HostedManifestRelation[];
}

export interface HostedSourceLimits {
  readonly maxEntries: number;
  readonly maxChunksPerEntry: number;
  readonly maxChunkBytes: number;
  readonly maxReadBytes: number;
  readonly maxCacheBytes: number;
  readonly maxGrantTtlMs: number;
}

export const DEFAULT_HOSTED_SOURCE_LIMITS: HostedSourceLimits = Object.freeze({
  maxEntries: 1_024,
  maxChunksPerEntry: 16_384,
  maxChunkBytes: 4 * 1024 * 1024,
  maxReadBytes: 16 * 1024 * 1024,
  maxCacheBytes: 32 * 1024 * 1024,
  maxGrantTtlMs: 60_000,
});

export const HARD_HOSTED_SOURCE_LIMITS: HostedSourceLimits = Object.freeze({
  maxEntries: 4_096,
  maxChunksPerEntry: 65_536,
  maxChunkBytes: 64 * 1024 * 1024,
  maxReadBytes: 256 * 1024 * 1024,
  maxCacheBytes: 512 * 1024 * 1024,
  maxGrantTtlMs: 60 * 60 * 1_000,
});

export type HostedSourceErrorCode =
  | "invalid-manifest"
  | "manifest-expired"
  | "access-denied"
  | "invalid-range"
  | "resource-limit"
  | "integrity-failed"
  | "cancelled"
  | "closed";

const ERROR_MESSAGES: Readonly<Record<HostedSourceErrorCode, string>> = Object.freeze({
  "invalid-manifest": "hosted source manifest is invalid",
  "manifest-expired": "hosted source manifest is not active",
  "access-denied": "hosted source request denied",
  "invalid-range": "hosted source range is invalid",
  "resource-limit": "hosted source resource limit exceeded",
  "integrity-failed": "hosted source integrity verification failed",
  cancelled: "hosted source request cancelled",
  closed: "hosted source session is closed",
});

export class HostedSourceError extends Error {
  readonly code: HostedSourceErrorCode;

  constructor(code: HostedSourceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = code === "cancelled" ? "AbortError" : "HostedSourceError";
    this.code = code;
  }
}

export interface HostedSourceTelemetry {
  readonly grantRequests: number;
  readonly rangeFetches: number;
  readonly completedBytes: bigint;
  readonly cacheHits: number;
  readonly coalescedReads: number;
  readonly cacheBytes: number;
  readonly rejectedReads: number;
  readonly cancelledReads: number;
  readonly integrityFailures: number;
}

interface MutableTelemetry {
  grantRequests: number;
  rangeFetches: number;
  completedBytes: bigint;
  cacheHits: number;
  coalescedReads: number;
  cacheBytes: number;
  rejectedReads: number;
  cancelledReads: number;
  integrityFailures: number;
}

interface CachedChunk {
  readonly bytes: Uint8Array;
  readonly byteLength: number;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_RELATIONS = 65_536;
const MAX_SERIALIZED_GRANT_BYTES = 16 * 1024;

function assertBoundedSerializedText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_SERIALIZED_GRANT_BYTES) {
    throw new Error(`${label} must be bounded serialized JSON text`);
  }
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let width: number;
    if (code < 0x80) width = 1;
    else if (code < 0x800) width = 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        width = 4;
        index += 1;
      } else width = 3;
    } else width = 3;
    if (width > MAX_SERIALIZED_GRANT_BYTES - bytes) throw new Error(`${label} exceeds the byte ceiling`);
    bytes += width;
  }
}

function parseSerializedRecord(value: unknown, expectedKeys: readonly string[], label: string): Record<string, unknown> {
  assertBoundedSerializedText(value, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  const actualKeys = Object.keys(parsed).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (actualKeys.length !== sortedExpectedKeys.length || actualKeys.some((key, index) => key !== sortedExpectedKeys[index])) {
    throw new Error(`${label} has invalid fields`);
  }
  return parsed as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
  return value;
}

function bigintField(record: Record<string, unknown>, key: string, label: string): bigint {
  const value = stringField(record, key, label);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label}.${key} must be a canonical unsigned integer`);
  return BigInt(value);
}

function safeIntegerField(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) throw new Error(`${label}.${key} must be a safe integer`);
  return value as number;
}

export function serializeHostedGrantScope(scope: HostedGrantScope): string {
  return JSON.stringify({
    sessionId: scope.sessionId,
    objectId: scope.objectId,
    immutableVersion: scope.immutableVersion,
    offset: scope.offset.toString(),
    length: scope.length.toString(),
  });
}

export function parseHostedGrantScope(serialized: unknown): HostedGrantScope {
  const label = "hosted grant scope";
  const record = parseSerializedRecord(serialized, ["sessionId", "objectId", "immutableVersion", "offset", "length"], label);
  return Object.freeze({
    sessionId: stringField(record, "sessionId", label),
    objectId: stringField(record, "objectId", label),
    immutableVersion: stringField(record, "immutableVersion", label),
    offset: bigintField(record, "offset", label),
    length: bigintField(record, "length", label),
  });
}

export function serializeHostedRangeGrant(grant: HostedRangeGrant): string {
  return JSON.stringify({
    sessionId: grant.sessionId,
    objectId: grant.objectId,
    immutableVersion: grant.immutableVersion,
    offset: grant.offset.toString(),
    length: grant.length.toString(),
    token: grant.token,
    issuedAtMs: grant.issuedAtMs,
    expiresAtMs: grant.expiresAtMs,
  });
}

export function parseHostedRangeGrant(serialized: unknown): HostedRangeGrant {
  const label = "hosted range grant";
  const record = parseSerializedRecord(serialized, [
    "sessionId", "objectId", "immutableVersion", "offset", "length", "token", "issuedAtMs", "expiresAtMs",
  ], label);
  return Object.freeze({
    sessionId: stringField(record, "sessionId", label),
    objectId: stringField(record, "objectId", label),
    immutableVersion: stringField(record, "immutableVersion", label),
    offset: bigintField(record, "offset", label),
    length: bigintField(record, "length", label),
    token: stringField(record, "token", label),
    issuedAtMs: safeIntegerField(record, "issuedAtMs", label),
    expiresAtMs: safeIntegerField(record, "expiresAtMs", label),
  });
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
}

function assertLimits(limits: HostedSourceLimits): void {
  assertPositiveSafeInteger(limits.maxEntries, "maxEntries");
  assertPositiveSafeInteger(limits.maxChunksPerEntry, "maxChunksPerEntry");
  assertPositiveSafeInteger(limits.maxChunkBytes, "maxChunkBytes");
  assertPositiveSafeInteger(limits.maxReadBytes, "maxReadBytes");
  assertPositiveSafeInteger(limits.maxGrantTtlMs, "maxGrantTtlMs");
  if (!Number.isSafeInteger(limits.maxCacheBytes) || limits.maxCacheBytes < 0) {
    throw new Error("maxCacheBytes must be a non-negative safe integer");
  }
  for (const name of Object.keys(HARD_HOSTED_SOURCE_LIMITS) as Array<keyof HostedSourceLimits>) {
    if (limits[name] > HARD_HOSTED_SOURCE_LIMITS[name]) throw new Error(`${name} exceeds the hard hosted source limit`);
  }
  if (limits.maxChunkBytes > limits.maxReadBytes) throw new Error("maxChunkBytes cannot exceed maxReadBytes");
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH &&
    ![...value].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f);
}

function validRelativePath(path: string): boolean {
  if (!path || path.length > 4_096 || path !== path.normalize("NFC") || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function assertManifest(manifest: VerifiedHostedManifest, limits: HostedSourceLimits, nowMs: number): void {
  if (
    manifest.verification !== "verified-signature" ||
    manifest.version !== 1 ||
    !validIdentifier(manifest.bundleId) ||
    !validIdentifier(manifest.sessionId) ||
    !Number.isSafeInteger(manifest.validFromMs) ||
    !Number.isSafeInteger(manifest.expiresAtMs) ||
    manifest.validFromMs >= manifest.expiresAtMs
  ) {
    throw new HostedSourceError("invalid-manifest");
  }
  if (nowMs < manifest.validFromMs || nowMs >= manifest.expiresAtMs) throw new HostedSourceError("manifest-expired");
  if (manifest.entries.length === 0 || manifest.entries.length > limits.maxEntries || manifest.relations.length > MAX_RELATIONS) {
    throw new HostedSourceError("resource-limit");
  }

  const entryIds = new Set<string>();
  const normalizedPaths = new Set<string>();
  for (const entry of manifest.entries) {
    if (
      !validIdentifier(entry.entryId) ||
      !validIdentifier(entry.objectId) ||
      !validIdentifier(entry.immutableVersion) ||
      !validRelativePath(entry.relativePath) ||
      entry.sizeBytes < 0n ||
      !SHA256_PATTERN.test(entry.sha256) ||
      entryIds.has(entry.entryId) ||
      normalizedPaths.has(entry.relativePath)
    ) {
      throw new HostedSourceError("invalid-manifest");
    }
    entryIds.add(entry.entryId);
    normalizedPaths.add(entry.relativePath);
    if (entry.chunks.length > limits.maxChunksPerEntry) throw new HostedSourceError("resource-limit");
    let cursor = 0n;
    for (const chunk of entry.chunks) {
      if (
        chunk.offset !== cursor ||
        chunk.length <= 0n ||
        chunk.length > BigInt(limits.maxChunkBytes) ||
        !SHA256_PATTERN.test(chunk.sha256)
      ) {
        throw new HostedSourceError("invalid-manifest");
      }
      cursor += chunk.length;
    }
    if (cursor !== entry.sizeBytes || (entry.sizeBytes > 0n && entry.chunks.length === 0)) {
      throw new HostedSourceError("invalid-manifest");
    }
  }

  const orderedOrdinals = new Set<string>();
  for (const relation of manifest.relations) {
    if (!entryIds.has(relation.fromEntryId) || !entryIds.has(relation.toEntryId)) {
      throw new HostedSourceError("invalid-manifest");
    }
    if (relation.kind === "ordered-part") {
      if (relation.ordinal === undefined || !Number.isSafeInteger(relation.ordinal) || relation.ordinal < 0) {
        throw new HostedSourceError("invalid-manifest");
      }
      const key = `${relation.fromEntryId}\0${relation.ordinal}`;
      if (orderedOrdinals.has(key)) throw new HostedSourceError("invalid-manifest");
      orderedOrdinals.add(key);
    } else if (relation.ordinal !== undefined) {
      throw new HostedSourceError("invalid-manifest");
    }
  }
}

function increment(value: number): number {
  return value === Number.MAX_SAFE_INTEGER ? value : value + 1;
}

function cancellationError(): HostedSourceError {
  return new HostedSourceError("cancelled");
}

function linkedSignal(left: AbortSignal, right: AbortSignal): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abortLeft = (): void => controller.abort(left.reason);
  const abortRight = (): void => controller.abort(right.reason);
  if (left.aborted) abortLeft();
  else left.addEventListener("abort", abortLeft, { once: true });
  if (right.aborted) abortRight();
  else right.addEventListener("abort", abortRight, { once: true });
  return {
    signal: controller.signal,
    dispose(): void {
      left.removeEventListener("abort", abortLeft);
      right.removeEventListener("abort", abortRight);
    },
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer));
  return `sha256:${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function assertGrant(
  grant: HostedRangeGrant,
  scope: HostedGrantScope,
  nowMs: number,
  maxGrantTtlMs: number,
  manifestExpiresAtMs: number,
): void {
  if (
    !validIdentifier(grant.token) ||
    grant.sessionId !== scope.sessionId ||
    grant.objectId !== scope.objectId ||
    grant.immutableVersion !== scope.immutableVersion ||
    grant.offset !== scope.offset ||
    grant.length !== scope.length ||
    !Number.isSafeInteger(grant.issuedAtMs) ||
    !Number.isSafeInteger(grant.expiresAtMs) ||
    grant.issuedAtMs > nowMs ||
    grant.expiresAtMs <= nowMs ||
    grant.expiresAtMs <= grant.issuedAtMs ||
    grant.expiresAtMs - grant.issuedAtMs > maxGrantTtlMs ||
    grant.expiresAtMs - nowMs > maxGrantTtlMs ||
    grant.expiresAtMs > manifestExpiresAtMs
  ) {
    throw new HostedSourceError("access-denied");
  }
}

export class HostedSourceSession {
  readonly #manifest: VerifiedHostedManifest;
  readonly #capability: string;
  readonly #transport: HostedRangeTransport;
  readonly #limits: HostedSourceLimits;
  readonly #now: () => number;
  readonly #controller = new AbortController();
  readonly #entries = new Map<string, HostedManifestEntry>();
  readonly #sources = new Map<string, HostedRangeSource>();
  readonly #cache = new Map<string, CachedChunk>();
  readonly #inFlight = new Map<string, { readonly signal: AbortSignal; readonly promise: Promise<Uint8Array> }>();
  readonly #diagnostics = new Set<string>();
  readonly #telemetry: MutableTelemetry = {
    grantRequests: 0,
    rangeFetches: 0,
    completedBytes: 0n,
    cacheHits: 0,
    coalescedReads: 0,
    cacheBytes: 0,
    rejectedReads: 0,
    cancelledReads: 0,
    integrityFailures: 0,
  };
  #closed = false;

  private constructor(
    manifest: VerifiedHostedManifest,
    capability: string,
    transport: HostedRangeTransport,
    limits: HostedSourceLimits,
    now: () => number,
  ) {
    this.#manifest = manifest;
    this.#capability = capability;
    this.#transport = transport;
    this.#limits = limits;
    this.#now = now;
    for (const entry of manifest.entries) this.#entries.set(entry.entryId, entry);
  }

  static async open(
    envelope: SignedManifestEnvelope,
    capability: string,
    verifier: HostedManifestVerifier,
    transport: HostedRangeTransport,
    options: {
      readonly limits?: HostedSourceLimits;
      readonly now?: () => number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<HostedSourceSession> {
    if (!validIdentifier(capability)) throw new HostedSourceError("access-denied");
    const limits = Object.freeze({ ...(options.limits ?? DEFAULT_HOSTED_SOURCE_LIMITS) });
    try {
      assertLimits(limits);
    } catch {
      throw new HostedSourceError("resource-limit");
    }
    const now = options.now ?? Date.now;
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) throw cancellationError();
    let manifest: VerifiedHostedManifest;
    try {
      manifest = await verifier.verify(envelope, signal);
    } catch {
      if (signal.aborted) throw cancellationError();
      throw new HostedSourceError("invalid-manifest");
    }
    assertManifest(manifest, limits, now());
    return new HostedSourceSession(manifest, capability, transport, limits, now);
  }

  bundle(): HostedSourceBundle {
    this.#assertOpen();
    return Object.freeze({
      bundleId: this.#manifest.bundleId,
      version: 1 as const,
      entries: Object.freeze(this.#manifest.entries.map((entry) => Object.freeze({
        entryId: entry.entryId,
        relativePath: entry.relativePath,
        sizeBytes: entry.sizeBytes,
        immutableVersion: entry.immutableVersion,
        sha256: entry.sha256,
        byteSource: Object.freeze({
          kind: "granted-range" as const,
          sourceId: `hosted:${entry.entryId}`,
          immutableVersion: entry.immutableVersion,
        }),
      }))),
      relations: Object.freeze(this.#manifest.relations.map((relation) => Object.freeze({ ...relation }))),
    });
  }

  entrySource(entryId: string): HostedRangeSource {
    this.#assertOpen();
    const entry = this.#entry(entryId);
    const existing = this.#sources.get(entryId);
    if (existing) return existing;
    const source: HostedRangeSource = Object.freeze({
      size: entry.sizeBytes,
      immutableVersion: entry.immutableVersion,
      read: (range: HostedByteRange, signal: AbortSignal): Promise<Uint8Array> =>
        this.readEntry(entryId, range.offset, range.length, signal),
    });
    this.#sources.set(entryId, source);
    return source;
  }

  async readEntry(entryId: string, offset: bigint, length: bigint, signal: AbortSignal): Promise<Uint8Array> {
    try {
      this.#assertOpen();
      const entry = this.#entry(entryId);
      if (offset < 0n || length < 0n || offset + length > entry.sizeBytes) throw new HostedSourceError("invalid-range");
      if (length > BigInt(this.#limits.maxReadBytes)) throw new HostedSourceError("resource-limit");
      if (length === 0n) return new Uint8Array();
      const linked = linkedSignal(signal, this.#controller.signal);
      try {
        if (linked.signal.aborted) throw cancellationError();
        const end = offset + length;
        const chunks = entry.chunks.filter((chunk) => chunk.offset < end && chunk.offset + chunk.length > offset);
        const output = new Uint8Array(Number(length));
        let outputOffset = 0;
        for (const chunk of chunks) {
          if (linked.signal.aborted) throw cancellationError();
          const bytes = await this.#readChunk(entry, chunk, linked.signal, signal);
          const sliceStart = chunk.offset < offset ? Number(offset - chunk.offset) : 0;
          const sliceEnd = chunk.offset + chunk.length > end ? Number(end - chunk.offset) : bytes.byteLength;
          const slice = bytes.subarray(sliceStart, sliceEnd);
          output.set(slice, outputOffset);
          outputOffset += slice.byteLength;
        }
        if (outputOffset !== output.byteLength) throw new HostedSourceError("integrity-failed");
        if (offset === 0n && length === entry.sizeBytes) {
          const digest = await sha256(output);
          if (linked.signal.aborted) throw cancellationError();
          this.#assertOpen();
          if (digest !== entry.sha256) {
            this.#telemetry.integrityFailures = increment(this.#telemetry.integrityFailures);
            throw new HostedSourceError("integrity-failed");
          }
        }
        return output;
      } finally {
        linked.dispose();
      }
    } catch (error) {
      const normalized = this.#normalizeError(error);
      if (normalized.code === "cancelled") this.#telemetry.cancelledReads = increment(this.#telemetry.cancelledReads);
      else this.#telemetry.rejectedReads = increment(this.#telemetry.rejectedReads);
      this.#recordDiagnostic(normalized.code);
      throw normalized;
    }
  }

  diagnostics(): readonly string[] {
    return Object.freeze([...this.#diagnostics]);
  }

  telemetry(): HostedSourceTelemetry {
    return Object.freeze({ ...this.#telemetry });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort("hosted source closed");
    this.#cache.clear();
    this.#telemetry.cacheBytes = 0;
  }

  #assertOpen(): void {
    if (this.#closed) throw new HostedSourceError("closed");
    if (this.#now() >= this.#manifest.expiresAtMs) throw new HostedSourceError("manifest-expired");
  }

  #entry(entryId: string): HostedManifestEntry {
    const entry = this.#entries.get(entryId);
    if (!entry) throw new HostedSourceError("access-denied");
    return entry;
  }

  async #readChunk(
    entry: HostedManifestEntry,
    chunk: HostedManifestChunk,
    signal: AbortSignal,
    operationSignal: AbortSignal,
  ): Promise<Uint8Array> {
    const scope: HostedGrantScope = {
      sessionId: this.#manifest.sessionId,
      objectId: entry.objectId,
      immutableVersion: entry.immutableVersion,
      offset: chunk.offset,
      length: chunk.length,
    };
    this.#telemetry.grantRequests = increment(this.#telemetry.grantRequests);
    let grant: HostedRangeGrant;
    try {
      const admission: { called: boolean; invalid: boolean; grant?: HostedRangeGrant } = { called: false, invalid: false };
      await this.#transport.issueRangeGrant(
        this.#capability,
        serializeHostedGrantScope(scope),
        signal,
        (serializedGrant): void => {
          if (admission.called) {
            admission.invalid = true;
            return;
          }
          admission.called = true;
          try {
            admission.grant = parseHostedRangeGrant(serializedGrant);
          } catch {
            admission.invalid = true;
          }
        },
      );
      if (!admission.called || admission.invalid || !admission.grant) throw new HostedSourceError("access-denied");
      grant = admission.grant;
      if (signal.aborted) throw cancellationError();
      assertGrant(grant, scope, this.#now(), this.#limits.maxGrantTtlMs, this.#manifest.expiresAtMs);
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw cancellationError();
      throw new HostedSourceError("access-denied");
    }

    const cacheKey = `${scope.sessionId}\0${scope.objectId}\0${scope.immutableVersion}\0${chunk.offset}\0${chunk.length}\0${chunk.sha256}`;
    const cached = this.#cache.get(cacheKey);
    if (cached && this.#transport.authorizeCachedRange) {
      try {
        await this.#transport.authorizeCachedRange(serializeHostedRangeGrant(grant), signal);
        if (signal.aborted) throw cancellationError();
        assertGrant(grant, scope, this.#now(), this.#limits.maxGrantTtlMs, this.#manifest.expiresAtMs);
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw cancellationError();
        throw new HostedSourceError("access-denied");
      }
      this.#cache.delete(cacheKey);
      this.#cache.set(cacheKey, cached);
      this.#telemetry.cacheHits = increment(this.#telemetry.cacheHits);
      return cached.bytes.slice();
    }
    const active = this.#inFlight.get(cacheKey);
    if (active?.signal === operationSignal) {
      this.#telemetry.coalescedReads = increment(this.#telemetry.coalescedReads);
      return (await active.promise).slice();
    }

    const request = this.#fetchAndVerify(grant, chunk, signal);
    if (!active) this.#inFlight.set(cacheKey, { signal: operationSignal, promise: request });
    try {
      const bytes = await request;
      this.#cacheChunk(cacheKey, bytes);
      return bytes.slice();
    } finally {
      if (this.#inFlight.get(cacheKey)?.promise === request) this.#inFlight.delete(cacheKey);
    }
  }

  async #fetchAndVerify(grant: HostedRangeGrant, chunk: HostedManifestChunk, signal: AbortSignal): Promise<Uint8Array> {
    this.#telemetry.rangeFetches = increment(this.#telemetry.rangeFetches);
    let bytes: Uint8Array;
    try {
      bytes = await this.#transport.fetchRange(serializeHostedRangeGrant(grant), signal);
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw cancellationError();
      throw new HostedSourceError("access-denied");
    }
    if (signal.aborted) throw cancellationError();
    if (BigInt(bytes.byteLength) !== chunk.length) {
      this.#telemetry.integrityFailures = increment(this.#telemetry.integrityFailures);
      throw new HostedSourceError("integrity-failed");
    }
    const digest = await sha256(bytes);
    if (signal.aborted) throw cancellationError();
    assertGrant(grant, {
      sessionId: grant.sessionId,
      objectId: grant.objectId,
      immutableVersion: grant.immutableVersion,
      offset: grant.offset,
      length: grant.length,
    }, this.#now(), this.#limits.maxGrantTtlMs, this.#manifest.expiresAtMs);
    if (digest !== chunk.sha256) {
      this.#telemetry.integrityFailures = increment(this.#telemetry.integrityFailures);
      throw new HostedSourceError("integrity-failed");
    }
    this.#telemetry.completedBytes += chunk.length;
    return bytes.slice();
  }

  #cacheChunk(key: string, bytes: Uint8Array): void {
    if (!this.#transport.authorizeCachedRange || this.#limits.maxCacheBytes === 0 || bytes.byteLength > this.#limits.maxCacheBytes) return;
    while (this.#telemetry.cacheBytes + bytes.byteLength > this.#limits.maxCacheBytes) {
      const oldestKey = this.#cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.#cache.get(oldestKey);
      this.#cache.delete(oldestKey);
      if (oldest) this.#telemetry.cacheBytes -= oldest.byteLength;
    }
    this.#cache.set(key, { bytes: bytes.slice(), byteLength: bytes.byteLength });
    this.#telemetry.cacheBytes += bytes.byteLength;
  }

  #normalizeError(error: unknown): HostedSourceError {
    if (error instanceof HostedSourceError) return error;
    if (error instanceof Error && error.name === "AbortError") return cancellationError();
    return new HostedSourceError("access-denied");
  }

  #recordDiagnostic(code: HostedSourceErrorCode): void {
    if (this.#diagnostics.size < 16) this.#diagnostics.add(`${code}: ${ERROR_MESSAGES[code]}`);
  }
}
