import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";

import {
  assertBundle,
  type SourceBundle,
  type SourceEntry,
  type SourceEntryId,
  type SourceId,
  type SourceRelation,
} from "@ros-web-viewer/core-model";
import { GrantedRangeSource } from "@ros-web-viewer/worker-runtime";

const TOKEN_BYTES = 32;
const MANIFEST_CHUNK_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SAFE_COUNTER = Number.MAX_SAFE_INTEGER;
const MAX_MANIFEST_ENTRIES = 1_024;
const MAX_MANIFEST_RELATIONS = 65_536;
const MAX_RELATIVE_PATH_LENGTH = 4_096;

export interface HostedCoreLimits {
  readonly maxEntriesPerSession: number;
  readonly maxSessionBytes: number;
  readonly maxStoredBytes: number;
  readonly maxActiveSessions: number;
  readonly maxActiveGrants: number;
  readonly maxRangeBytes: number;
  readonly sessionTtlMs: number;
  readonly grantTtlMs: number;
  readonly retentionMs: number;
  readonly auditCapacity: number;
}

export const DEFAULT_HOSTED_CORE_LIMITS: HostedCoreLimits = Object.freeze({
  maxEntriesPerSession: 64,
  maxSessionBytes: 512 * 1024 * 1024,
  maxStoredBytes: 2 * 1024 * 1024 * 1024,
  maxActiveSessions: 128,
  maxActiveGrants: 4_096,
  maxRangeBytes: 4 * 1024 * 1024,
  sessionTtlMs: 60 * 60 * 1_000,
  grantTtlMs: 15_000,
  retentionMs: 24 * 60 * 60 * 1_000,
  auditCapacity: 256,
});

export interface ImmutableObjectRef {
  readonly storageKey: string;
  readonly immutableVersion: string;
  readonly sizeBytes: bigint;
  readonly sha256: string;
}

export interface ImmutableObjectStore {
  put(ref: ImmutableObjectRef, bytes: Uint8Array): Promise<void>;
  read(ref: ImmutableObjectRef, offset: bigint, length: bigint, signal: AbortSignal): Promise<Uint8Array>;
  delete(ref: ImmutableObjectRef): Promise<boolean>;
}

function abortError(reason?: unknown): Error {
  const error = new Error(reason instanceof Error ? reason.message : "operation aborted");
  error.name = "AbortError";
  return error;
}

export class InMemoryImmutableObjectStore implements ImmutableObjectStore {
  readonly #objects = new Map<string, { readonly ref: ImmutableObjectRef; readonly bytes: Uint8Array }>();

  async put(ref: ImmutableObjectRef, bytes: Uint8Array): Promise<void> {
    if (this.#objects.has(ref.storageKey)) throw new Error("immutable object key already exists");
    const copy = bytes.slice();
    if (BigInt(copy.byteLength) !== ref.sizeBytes || sha256(copy) !== ref.sha256) {
      throw new Error("immutable object metadata does not match content");
    }
    this.#objects.set(ref.storageKey, { ref: Object.freeze({ ...ref }), bytes: copy });
  }

  async read(ref: ImmutableObjectRef, offset: bigint, length: bigint, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) throw abortError(signal.reason);
    const stored = this.#objects.get(ref.storageKey);
    if (!stored || stored.ref.immutableVersion !== ref.immutableVersion || stored.ref.sha256 !== ref.sha256) {
      throw new Error("immutable object is unavailable");
    }
    if (offset < 0n || length <= 0n || offset + length > stored.ref.sizeBytes) {
      throw new Error("immutable object range is invalid");
    }
    const start = Number(offset);
    const end = Number(offset + length);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new Error("immutable object range is unsafe");
    const result = stored.bytes.slice(start, end);
    if (signal.aborted) throw abortError(signal.reason);
    return result;
  }

  async delete(ref: ImmutableObjectRef): Promise<boolean> {
    const stored = this.#objects.get(ref.storageKey);
    if (!stored || stored.ref.immutableVersion !== ref.immutableVersion) return false;
    return this.#objects.delete(ref.storageKey);
  }
}

export interface HostedUploadEntry {
  readonly entryId: string;
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

export interface HostedUploadRelation {
  readonly fromEntryId: string;
  readonly toEntryId: string;
  readonly kind: SourceRelation["kind"];
  readonly ordinal?: number;
}

export interface CreateHostedSessionInput {
  readonly entries: readonly HostedUploadEntry[];
  readonly relations?: readonly HostedUploadRelation[];
  readonly sessionTtlMs?: number;
  readonly retentionMs?: number;
}

export interface HostedManifestEntry {
  readonly entryId: string;
  readonly objectId: string;
  readonly relativePath: string;
  readonly sizeBytes: string;
  readonly immutableVersion: string;
  readonly sha256: string;
  readonly sourceId: string;
  readonly chunks: readonly HostedManifestChunk[];
}

export interface HostedManifestChunk {
  readonly offset: string;
  readonly length: string;
  readonly sha256: string;
}

export interface HostedManifestPayload {
  readonly schemaVersion: 1;
  readonly bundleId: string;
  readonly sessionId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly entries: readonly HostedManifestEntry[];
  readonly relations: readonly HostedUploadRelation[];
}

export interface SignedHostedManifest {
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly publicKeySpki: string;
  readonly payload: HostedManifestPayload;
  readonly signature: string;
}

export interface HostedSessionDescriptor {
  readonly capabilityUrl: string;
  readonly manifest: SignedHostedManifest;
  readonly manifestVerificationKey: string;
  readonly expiresAtMs: number;
  readonly residualGrantLifetimeMs: number;
}

export interface RangeGrantRequest {
  readonly sessionId: string;
  readonly entryId: string;
  readonly objectId: string;
  readonly immutableVersion: string;
  readonly offset: bigint;
  readonly length: bigint;
}

export interface IssuedRangeGrant extends RangeGrantRequest {
  readonly token: string;
  readonly expiresAtMs: number;
}

export interface GrantedRangeRead extends RangeGrantRequest {
  readonly sessionCapability: string;
  readonly grantToken: string;
}

export type HostedAuditKind =
  | "session-created"
  | "session-opened"
  | "access-denied"
  | "grant-issued"
  | "range-read"
  | "session-revoked"
  | "session-deleted"
  | "retention-swept";

export interface HostedAuditEvent {
  readonly kind: HostedAuditKind;
  readonly atMs: number;
}

export interface HostedTelemetry {
  readonly activeSessions: number;
  readonly activeGrants: number;
  readonly sessionsCreated: number;
  readonly objectsUploaded: number;
  readonly uploadedBytes: number;
  readonly grantsIssued: number;
  readonly rangeReads: number;
  readonly bytesServed: number;
  readonly deniedRequests: number;
  readonly sessionsRevoked: number;
  readonly sessionsDeleted: number;
  readonly objectsDeleted: number;
  readonly retentionSweeps: number;
}

interface StoredEntry {
  readonly manifest: HostedManifestEntry;
  readonly object: ImmutableObjectRef;
}

interface SessionRecord {
  readonly capabilityDigest: Uint8Array;
  readonly manifest: SignedHostedManifest;
  readonly entries: ReadonlyMap<string, StoredEntry>;
  readonly expiresAtMs: number;
  readonly retentionAtMs: number;
  readonly lifecycle: { deleted: boolean };
  revokedAtMs?: number;
}

interface GrantRecord extends RangeGrantRequest {
  readonly tokenDigest: Uint8Array;
  readonly sessionCapabilityDigest: Uint8Array;
  readonly object: ImmutableObjectRef;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly lifecycle: SessionRecord["lifecycle"];
}

type MutableHostedTelemetry = {
  -readonly [K in keyof Omit<HostedTelemetry, "activeSessions" | "activeGrants">]: HostedTelemetry[K];
};

export class HostedAccessError extends Error {
  readonly code = "access-denied" as const;

  constructor() {
    super("hosted access denied");
    this.name = "HostedAccessError";
  }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function token(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function digestToken(value: string): Uint8Array {
  const normalized = TOKEN_PATTERN.test(value) ? value : "_".repeat(43);
  return createHash("sha256").update(normalized).digest();
}

function equalDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function increment(value: number, amount = 1): number {
  return Math.min(MAX_SAFE_COUNTER, value + amount);
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
}

function validateLimits(limits: HostedCoreLimits): HostedCoreLimits {
  for (const [name, value] of Object.entries(limits)) assertPositiveSafeInteger(name, value);
  if (limits.grantTtlMs > limits.sessionTtlMs) throw new Error("grantTtlMs cannot exceed sessionTtlMs");
  if (limits.retentionMs < limits.sessionTtlMs) throw new Error("retentionMs cannot be shorter than sessionTtlMs");
  if (limits.maxSessionBytes > limits.maxStoredBytes) throw new Error("maxSessionBytes cannot exceed maxStoredBytes");
  return Object.freeze({ ...limits });
}

export function serializeHostedManifestPayload(payload: HostedManifestPayload): string {
  return JSON.stringify({
    schemaVersion: payload.schemaVersion,
    bundleId: payload.bundleId,
    sessionId: payload.sessionId,
    issuedAtMs: payload.issuedAtMs,
    expiresAtMs: payload.expiresAtMs,
    entries: payload.entries.map((entry) => ({
      entryId: entry.entryId,
      objectId: entry.objectId,
      relativePath: entry.relativePath,
      sizeBytes: entry.sizeBytes,
      immutableVersion: entry.immutableVersion,
      sha256: entry.sha256,
      sourceId: entry.sourceId,
      chunks: entry.chunks.map((chunk) => ({ offset: chunk.offset, length: chunk.length, sha256: chunk.sha256 })),
    })),
    relations: payload.relations.map((relation) => ({
      fromEntryId: relation.fromEntryId,
      toEntryId: relation.toEntryId,
      kind: relation.kind,
      ...(relation.ordinal === undefined ? {} : { ordinal: relation.ordinal }),
    })),
  });
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function cloneFrozen<T>(value: T): T {
  const clone = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (candidate: unknown): unknown => {
    if (!candidate || typeof candidate !== "object" || Object.isFrozen(candidate)) return candidate;
    for (const nested of Object.values(candidate)) freeze(nested);
    return Object.freeze(candidate);
  };
  return freeze(clone) as T;
}

function decodeCanonicalBase64Url(value: string, maxBytes: number, label: string): Buffer {
  if (typeof value !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 ||
      value.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`invalid hosted manifest ${label}`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength > maxBytes || bytes.toString("base64url") !== value) throw new Error(`invalid hosted manifest ${label}`);
  return bytes;
}

function assertManifestShape(manifest: SignedHostedManifest): void {
  if (!manifest || typeof manifest !== "object" || !exactKeys(manifest, ["algorithm", "keyId", "publicKeySpki", "payload", "signature"])) {
    throw new Error("invalid hosted manifest envelope");
  }
  if (manifest.algorithm !== "Ed25519" || !SHA256_PATTERN.test(manifest.keyId)) throw new Error("invalid hosted manifest key");
  const publicKeyBytes = decodeCanonicalBase64Url(manifest.publicKeySpki, 128, "public key encoding");
  const signatureBytes = decodeCanonicalBase64Url(manifest.signature, 64, "signature encoding");
  if (
    publicKeyBytes.byteLength === 0 || signatureBytes.byteLength !== 64
  ) {
    throw new Error("invalid hosted manifest encoding");
  }
  const payload = manifest.payload;
  if (!payload || !exactKeys(payload, ["schemaVersion", "bundleId", "sessionId", "issuedAtMs", "expiresAtMs", "entries", "relations"])) {
    throw new Error("invalid hosted manifest payload");
  }
  if (payload.schemaVersion !== 1 || !TOKEN_PATTERN.test(payload.bundleId) || !TOKEN_PATTERN.test(payload.sessionId)) {
    throw new Error("invalid hosted manifest identity");
  }
  if (!Number.isSafeInteger(payload.issuedAtMs) || !Number.isSafeInteger(payload.expiresAtMs) || payload.expiresAtMs <= payload.issuedAtMs) {
    throw new Error("invalid hosted manifest lifetime");
  }
  if (payload.entries.length === 0 || payload.entries.length > MAX_MANIFEST_ENTRIES || payload.relations.length > MAX_MANIFEST_RELATIONS) {
    throw new Error("invalid hosted manifest size");
  }
  const objectIds = new Set<string>();
  const sourceIds = new Set<string>();
  const paths = new Set<string>();
  for (const entry of payload.entries) {
    if (!exactKeys(entry, ["entryId", "objectId", "relativePath", "sizeBytes", "immutableVersion", "sha256", "sourceId", "chunks"])) {
      throw new Error("invalid hosted manifest entry");
    }
    if (!TOKEN_PATTERN.test(entry.entryId) || !TOKEN_PATTERN.test(entry.objectId) || !TOKEN_PATTERN.test(entry.sourceId) || !/^(0|[1-9][0-9]*)$/.test(entry.sizeBytes)) {
      throw new Error("invalid hosted manifest entry encoding");
    }
    if (!SHA256_PATTERN.test(entry.sha256) || entry.immutableVersion !== `sha256:${entry.sha256}`) {
      throw new Error("invalid hosted manifest immutable relation");
    }
    if (
      entry.relativePath.length > MAX_RELATIVE_PATH_LENGTH
      || objectIds.has(entry.objectId)
      || sourceIds.has(entry.sourceId)
      || paths.has(entry.relativePath)
    ) {
      throw new Error("invalid hosted manifest entry uniqueness");
    }
    objectIds.add(entry.objectId);
    sourceIds.add(entry.sourceId);
    paths.add(entry.relativePath);
    let cursor = 0n;
    for (const chunk of entry.chunks) {
      if (!exactKeys(chunk, ["offset", "length", "sha256"]) || !/^(0|[1-9][0-9]*)$/.test(chunk.offset) || !/^[1-9][0-9]*$/.test(chunk.length)) {
        throw new Error("invalid hosted manifest chunk encoding");
      }
      const offset = BigInt(chunk.offset);
      const length = BigInt(chunk.length);
      if (offset !== cursor || length > BigInt(MANIFEST_CHUNK_BYTES) || !/^sha256:[a-f0-9]{64}$/.test(chunk.sha256)) {
        throw new Error("invalid hosted manifest chunk relation");
      }
      cursor += length;
    }
    if (cursor !== BigInt(entry.sizeBytes)) throw new Error("invalid hosted manifest chunk coverage");
  }
  for (const relation of payload.relations) {
    const expected = relation.ordinal === undefined
      ? ["fromEntryId", "toEntryId", "kind"]
      : ["fromEntryId", "toEntryId", "kind", "ordinal"];
    if (!exactKeys(relation, expected)) throw new Error("invalid hosted manifest relation");
  }
}

export function verifyHostedManifest(manifest: SignedHostedManifest, trustedPublicKeySpki: string): SourceBundle {
  assertManifestShape(manifest);
  if (manifest.publicKeySpki !== trustedPublicKeySpki) throw new Error("hosted manifest signer is not trusted");
  const publicKeyBytes = decodeCanonicalBase64Url(manifest.publicKeySpki, 128, "public key encoding");
  if (sha256(publicKeyBytes) !== manifest.keyId) throw new Error("hosted manifest key id mismatch");
  const publicKey = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
  const valid = verify(null, Buffer.from(serializeHostedManifestPayload(manifest.payload)), publicKey,
    decodeCanonicalBase64Url(manifest.signature, 64, "signature encoding"));
  if (!valid) throw new Error("hosted manifest signature is invalid");

  const entries: SourceEntry[] = manifest.payload.entries.map((entry) => ({
    entryId: entry.entryId as SourceEntryId,
    relativePath: entry.relativePath,
    sizeBytes: BigInt(entry.sizeBytes),
    immutableVersion: entry.immutableVersion,
    sha256: entry.sha256,
    byteSource: {
      kind: "granted-range",
      sourceId: entry.sourceId as SourceId,
      immutableVersion: entry.immutableVersion,
    },
  }));
  const relations: SourceRelation[] = manifest.payload.relations.map((relation) => ({
    fromEntryId: relation.fromEntryId as SourceEntryId,
    toEntryId: relation.toEntryId as SourceEntryId,
    kind: relation.kind,
    ...(relation.ordinal === undefined ? {} : { ordinal: relation.ordinal }),
  }));
  const bundle: SourceBundle = {
    bundleId: manifest.payload.bundleId,
    version: 1,
    entries,
    relations,
  };
  assertBundle(bundle);
  if (new Set(entries.map(({ relativePath }) => relativePath)).size !== entries.length) {
    throw new Error("hosted manifest contains duplicate paths");
  }
  return Object.freeze({
    ...bundle,
    entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry, byteSource: Object.freeze({ ...entry.byteSource }) }))),
    relations: Object.freeze(relations.map((relation) => Object.freeze({ ...relation }))),
  });
}

function signManifest(payload: HostedManifestPayload, privateKey: KeyObject, publicKeySpki: string): SignedHostedManifest {
  const publicKeyBytes = Buffer.from(publicKeySpki, "base64url");
  return cloneFrozen({
    algorithm: "Ed25519" as const,
    keyId: sha256(publicKeyBytes),
    publicKeySpki,
    payload,
    signature: sign(null, Buffer.from(serializeHostedManifestPayload(payload)), privateKey).toString("base64url"),
  });
}

export class HostedSharingService {
  readonly #store: ImmutableObjectStore;
  readonly #clock: () => number;
  readonly #limits: HostedCoreLimits;
  readonly #privateKey: KeyObject;
  readonly #publicKeySpki: string;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #grants = new Map<string, GrantRecord>();
  readonly #audit: HostedAuditEvent[] = [];
  #storedBytes = 0;
  #telemetry: MutableHostedTelemetry = {
    sessionsCreated: 0,
    objectsUploaded: 0,
    uploadedBytes: 0,
    grantsIssued: 0,
    rangeReads: 0,
    bytesServed: 0,
    deniedRequests: 0,
    sessionsRevoked: 0,
    sessionsDeleted: 0,
    objectsDeleted: 0,
    retentionSweeps: 0,
  };

  constructor(options: {
    readonly store?: ImmutableObjectStore;
    readonly now?: () => number;
    readonly limits?: Partial<HostedCoreLimits>;
  } = {}) {
    this.#store = options.store ?? new InMemoryImmutableObjectStore();
    this.#clock = options.now ?? Date.now;
    this.#limits = validateLimits({ ...DEFAULT_HOSTED_CORE_LIMITS, ...options.limits });
    const pair = generateKeyPairSync("ed25519");
    this.#privateKey = pair.privateKey;
    this.#publicKeySpki = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  }

  get manifestVerificationKey(): string {
    return this.#publicKeySpki;
  }

  async createHostedSession(input: CreateHostedSessionInput): Promise<HostedSessionDescriptor> {
    if (this.#sessions.size >= this.#limits.maxActiveSessions) throw new Error("hosted session capacity reached");
    if (input.entries.length === 0 || input.entries.length > this.#limits.maxEntriesPerSession) {
      throw new Error("hosted upload entry count is outside configured limits");
    }
    const entryNames = new Set<string>();
    let totalBytes = 0;
    for (const entry of input.entries) {
      if (!entry.entryId || entryNames.has(entry.entryId)) throw new Error("hosted upload entry ids must be unique");
      entryNames.add(entry.entryId);
      totalBytes += entry.bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > this.#limits.maxSessionBytes) throw new Error("hosted upload exceeds session byte limit");
    }
    if (this.#storedBytes + totalBytes > this.#limits.maxStoredBytes) throw new Error("hosted storage capacity reached");

    const sessionTtlMs = input.sessionTtlMs ?? this.#limits.sessionTtlMs;
    const retentionMs = input.retentionMs ?? this.#limits.retentionMs;
    assertPositiveSafeInteger("sessionTtlMs", sessionTtlMs);
    assertPositiveSafeInteger("retentionMs", retentionMs);
    if (sessionTtlMs > this.#limits.sessionTtlMs || retentionMs > this.#limits.retentionMs || retentionMs < sessionTtlMs) {
      throw new Error("hosted session lifetime exceeds configured limits");
    }

    const now = this.#now();
    const capability = token();
    const bundleId = token();
    const sessionId = token();
    const storedEntries = new Map<string, StoredEntry>();
    const manifestEntries: HostedManifestEntry[] = [];
    try {
      for (const upload of input.entries) {
        const bytes = upload.bytes.slice();
        const contentHash = sha256(bytes);
        const opaqueEntryId = token();
        const objectId = token();
        const object: ImmutableObjectRef = Object.freeze({
          storageKey: token(),
          immutableVersion: `sha256:${contentHash}`,
          sizeBytes: BigInt(bytes.byteLength),
          sha256: contentHash,
        });
        await this.#store.put(object, bytes);
        const manifestEntry: HostedManifestEntry = Object.freeze({
          entryId: opaqueEntryId,
          objectId,
          relativePath: upload.relativePath,
          sizeBytes: String(bytes.byteLength),
          immutableVersion: object.immutableVersion,
          sha256: contentHash,
          sourceId: token(),
          chunks: Object.freeze(Array.from({ length: Math.ceil(bytes.byteLength / MANIFEST_CHUNK_BYTES) }, (_, index) => {
            const offset = index * MANIFEST_CHUNK_BYTES;
            const chunk = bytes.subarray(offset, Math.min(offset + MANIFEST_CHUNK_BYTES, bytes.byteLength));
            return Object.freeze({
              offset: String(offset),
              length: String(chunk.byteLength),
              sha256: `sha256:${sha256(chunk)}`,
            });
          })),
        });
        storedEntries.set(opaqueEntryId, { manifest: manifestEntry, object });
        manifestEntries.push(manifestEntry);
      }
      const idMap = new Map(input.entries.map((entry, index) => [entry.entryId, manifestEntries[index]!.entryId]));
      const relations = (input.relations ?? []).map((relation): HostedUploadRelation => ({
        fromEntryId: idMap.get(relation.fromEntryId) ?? "",
        toEntryId: idMap.get(relation.toEntryId) ?? "",
        kind: relation.kind,
        ...(relation.ordinal === undefined ? {} : { ordinal: relation.ordinal }),
      }));
      if (relations.some(({ fromEntryId, toEntryId }) => !fromEntryId || !toEntryId)) throw new Error("hosted relation references an unknown upload entry");
      const payload: HostedManifestPayload = cloneFrozen({
        schemaVersion: 1 as const,
        bundleId,
        sessionId,
        issuedAtMs: now,
        expiresAtMs: now + sessionTtlMs,
        entries: manifestEntries,
        relations,
      });
      const manifest = signManifest(payload, this.#privateKey, this.#publicKeySpki);
      verifyHostedManifest(manifest, this.#publicKeySpki);
      const capabilityDigest = digestToken(capability);
      this.#sessions.set(Buffer.from(capabilityDigest).toString("hex"), {
        capabilityDigest,
        manifest,
        entries: storedEntries,
        expiresAtMs: payload.expiresAtMs,
        retentionAtMs: now + retentionMs,
        lifecycle: { deleted: false },
      });
      this.#storedBytes += totalBytes;
      this.#telemetry.sessionsCreated = increment(this.#telemetry.sessionsCreated);
      this.#telemetry.objectsUploaded = increment(this.#telemetry.objectsUploaded, input.entries.length);
      this.#telemetry.uploadedBytes = increment(this.#telemetry.uploadedBytes, totalBytes);
      this.#record("session-created");
      return Object.freeze({
        capabilityUrl: `/hosted/session/${capability}`,
        manifest: cloneFrozen(manifest),
        manifestVerificationKey: this.#publicKeySpki,
        expiresAtMs: payload.expiresAtMs,
        residualGrantLifetimeMs: this.#limits.grantTtlMs,
      });
    } catch (error) {
      for (const { object } of storedEntries.values()) await this.#store.delete(object);
      throw error;
    }
  }

  openHostedSession(sessionCapability: string): SignedHostedManifest {
    const session = this.#activeSession(sessionCapability);
    this.#record("session-opened");
    return cloneFrozen(session.manifest);
  }

  issueRangeGrant(sessionCapability: string, request: RangeGrantRequest): IssuedRangeGrant {
    try {
      if (this.#grants.size >= this.#limits.maxActiveGrants) throw new HostedAccessError();
      const session = this.#activeSession(sessionCapability);
      const entry = session.entries.get(request.entryId);
      if (
        !entry
        || request.sessionId !== session.manifest.payload.sessionId
        || request.objectId !== entry.manifest.objectId
        || request.immutableVersion !== entry.object.immutableVersion
        || request.offset < 0n
        || request.length <= 0n
        || request.length > BigInt(this.#limits.maxRangeBytes)
        || request.offset + request.length > entry.object.sizeBytes
      ) {
        throw new HostedAccessError();
      }
      const now = this.#now();
      const expiresAtMs = Math.min(now + this.#limits.grantTtlMs, session.expiresAtMs);
      if (expiresAtMs <= now) throw new HostedAccessError();
      const grantToken = token();
      const tokenDigest = digestToken(grantToken);
      this.#grants.set(Buffer.from(tokenDigest).toString("hex"), Object.freeze({
        ...request,
        tokenDigest,
        sessionCapabilityDigest: session.capabilityDigest,
        object: entry.object,
        issuedAtMs: now,
        expiresAtMs,
        lifecycle: session.lifecycle,
      }));
      this.#telemetry.grantsIssued = increment(this.#telemetry.grantsIssued);
      this.#record("grant-issued");
      return Object.freeze({ ...request, token: grantToken, expiresAtMs });
    } catch (error) {
      if (error instanceof HostedAccessError) this.#deny();
      throw error instanceof HostedAccessError ? error : new HostedAccessError();
    }
  }

  async readGrantedRange(request: GrantedRangeRead, signal: AbortSignal): Promise<Uint8Array> {
    try {
      if (signal.aborted) throw abortError(signal.reason);
      const grant = this.#findGrant(request.grantToken);
      const capabilityDigest = digestToken(request.sessionCapability);
      if (
        !grant
        || !equalDigest(grant.sessionCapabilityDigest, capabilityDigest)
        || grant.lifecycle.deleted
        || grant.expiresAtMs <= this.#now()
        || grant.sessionId !== request.sessionId
        || grant.entryId !== request.entryId
        || grant.objectId !== request.objectId
        || grant.immutableVersion !== request.immutableVersion
        || grant.offset !== request.offset
        || grant.length !== request.length
      ) {
        throw new HostedAccessError();
      }
      const bytes = await this.#store.read(grant.object, request.offset, request.length, signal);
      if (signal.aborted) throw abortError(signal.reason);
      if (grant.lifecycle.deleted || grant.expiresAtMs <= this.#now()) throw new HostedAccessError();
      if (bytes.byteLength !== Number(request.length)) throw new HostedAccessError();
      this.#telemetry.rangeReads = increment(this.#telemetry.rangeReads);
      this.#telemetry.bytesServed = increment(this.#telemetry.bytesServed, bytes.byteLength);
      this.#record("range-read");
      return bytes.slice();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      this.#deny();
      throw new HostedAccessError();
    }
  }

  createRangeSource(sessionCapability: string, entryId: string): GrantedRangeSource {
    const session = this.#activeSession(sessionCapability);
    const entry = session.entries.get(entryId);
    if (!entry) {
      this.#deny();
      throw new HostedAccessError();
    }
    return new GrantedRangeSource(entry.object.sizeBytes, entry.object.immutableVersion, async (range, signal) => {
      if (signal.aborted) throw abortError(signal.reason);
      const grant = this.issueRangeGrant(sessionCapability, {
        sessionId: session.manifest.payload.sessionId,
        entryId,
        objectId: entry.manifest.objectId,
        immutableVersion: entry.object.immutableVersion,
        offset: range.offset,
        length: range.length,
      });
      return this.readGrantedRange({
        sessionCapability,
        grantToken: grant.token,
        sessionId: session.manifest.payload.sessionId,
        entryId,
        objectId: entry.manifest.objectId,
        immutableVersion: entry.object.immutableVersion,
        offset: range.offset,
        length: range.length,
      }, signal);
    });
  }

  revokeSession(sessionCapability: string): void {
    const session = this.#activeSession(sessionCapability);
    session.revokedAtMs = this.#now();
    this.#telemetry.sessionsRevoked = increment(this.#telemetry.sessionsRevoked);
    this.#record("session-revoked");
  }

  async deleteSession(sessionCapability: string): Promise<void> {
    const session = this.#findSession(sessionCapability);
    if (!session) {
      this.#deny();
      throw new HostedAccessError();
    }
    await this.#deleteRecord(session);
    this.#telemetry.sessionsDeleted = increment(this.#telemetry.sessionsDeleted);
    this.#record("session-deleted");
  }

  async sweepRetention(): Promise<Readonly<{ sessionsDeleted: number; objectsDeleted: number; bytesDeleted: number; grantsExpired: number }>> {
    const now = this.#now();
    let sessionsDeleted = 0;
    let objectsDeleted = 0;
    let bytesDeleted = 0;
    for (const session of [...this.#sessions.values()]) {
      if (session.retentionAtMs > now) continue;
      const result = await this.#deleteRecord(session);
      sessionsDeleted += 1;
      objectsDeleted += result.objectsDeleted;
      bytesDeleted += result.bytesDeleted;
    }
    let grantsExpired = 0;
    for (const [key, grant] of this.#grants) {
      if (grant.expiresAtMs <= now) {
        this.#grants.delete(key);
        grantsExpired += 1;
      }
    }
    this.#telemetry.retentionSweeps = increment(this.#telemetry.retentionSweeps);
    this.#record("retention-swept");
    return Object.freeze({ sessionsDeleted, objectsDeleted, bytesDeleted, grantsExpired });
  }

  telemetry(): Readonly<HostedTelemetry> {
    return Object.freeze({ activeSessions: this.#sessions.size, activeGrants: this.#grants.size, ...this.#telemetry });
  }

  auditEvents(): readonly HostedAuditEvent[] {
    return Object.freeze(this.#audit.map((event) => Object.freeze({ ...event })));
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("hosted clock must return a non-negative safe integer");
    return now;
  }

  #findSession(capability: string): SessionRecord | undefined {
    const digest = digestToken(capability);
    const session = this.#sessions.get(Buffer.from(digest).toString("hex"));
    return session && equalDigest(session.capabilityDigest, digest) ? session : undefined;
  }

  #activeSession(capability: string): SessionRecord {
    const session = this.#findSession(capability);
    if (!session || session.revokedAtMs !== undefined || session.expiresAtMs <= this.#now()) {
      this.#deny();
      throw new HostedAccessError();
    }
    return session;
  }

  #findGrant(grantToken: string): GrantRecord | undefined {
    const digest = digestToken(grantToken);
    const grant = this.#grants.get(Buffer.from(digest).toString("hex"));
    return grant && equalDigest(grant.tokenDigest, digest) ? grant : undefined;
  }

  async #deleteRecord(session: SessionRecord): Promise<{ objectsDeleted: number; bytesDeleted: number }> {
    session.lifecycle.deleted = true;
    let objectsDeleted = 0;
    let bytesDeleted = 0;
    for (const { object } of session.entries.values()) {
      if (await this.#store.delete(object)) {
        objectsDeleted += 1;
        bytesDeleted += Number(object.sizeBytes);
      }
    }
    this.#sessions.delete(Buffer.from(session.capabilityDigest).toString("hex"));
    this.#storedBytes = Math.max(0, this.#storedBytes - bytesDeleted);
    this.#telemetry.objectsDeleted = increment(this.#telemetry.objectsDeleted, objectsDeleted);
    return { objectsDeleted, bytesDeleted };
  }

  #deny(): void {
    this.#telemetry.deniedRequests = increment(this.#telemetry.deniedRequests);
    this.#record("access-denied");
  }

  #record(kind: HostedAuditKind): void {
    if (this.#audit.length === this.#limits.auditCapacity) this.#audit.shift();
    this.#audit.push(Object.freeze({ kind, atMs: this.#now() }));
  }
}
