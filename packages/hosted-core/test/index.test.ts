import { describe, expect, it, vi } from "vitest";

import {
  HostedAccessError,
  HostedSharingService,
  serializeGrantedRangeRead,
  serializeHostedManifestPayload,
  serializeHostedSessionInput,
  serializeRangeGrantRequest,
  verifyHostedManifest,
  type ImmutableObjectRef,
  type ImmutableObjectStore,
  type SignedHostedManifest,
} from "../src/index.js";

class AdversarialStore implements ImmutableObjectStore {
  readonly #objects = new Map<string, Uint8Array>();
  beforeRead?: () => void;

  async put(ref: ImmutableObjectRef, bytes: Uint8Array): Promise<void> {
    this.#objects.set(ref.storageKey, bytes.slice());
  }

  async read(ref: ImmutableObjectRef, offset: bigint, length: bigint, signal: AbortSignal): Promise<Uint8Array> {
    void signal;
    const bytes = this.#objects.get(ref.storageKey);
    if (!bytes) throw new Error("missing object");
    this.beforeRead?.();
    return bytes.slice(Number(offset), Number(offset + length));
  }

  async delete(ref: ImmutableObjectRef): Promise<boolean> {
    void ref;
    return false;
  }
}

function capability(url: string): string {
  return url.split("/").at(-1)!;
}

function fixture(now: { value: number }, overrides: Record<string, number> = {}) {
  const service = new HostedSharingService({
    now: () => now.value,
    limits: {
      sessionTtlMs: 1_000,
      grantTtlMs: 100,
      retentionMs: 2_000,
      maxRangeBytes: 64,
      maxSessionBytes: 4_096,
      maxStoredBytes: 16_384,
      auditCapacity: 8,
      ...overrides,
    },
  });
  return service;
}

function createHostedSession(
  service: HostedSharingService,
  input: Parameters<typeof serializeHostedSessionInput>[0],
) {
  return service.createHostedSessionSerialized(serializeHostedSessionInput(input));
}

function issueRangeGrant(
  service: HostedSharingService,
  sessionCapability: string,
  request: Parameters<typeof serializeRangeGrantRequest>[0],
) {
  return service.issueRangeGrantSerialized(sessionCapability, serializeRangeGrantRequest(request));
}

async function readGrantedRange(
  service: HostedSharingService,
  request: Parameters<typeof serializeGrantedRangeRead>[0],
  signal: AbortSignal,
) {
  const bytes = await service.readGrantedRangeSerialized(serializeGrantedRangeRead(request), signal);
  return Uint8Array.from(bytes);
}

async function hosted(service: HostedSharingService, bytes = Uint8Array.from({ length: 256 }, (_, index) => index)) {
  const descriptor = await createHostedSession(service, {
    entries: [
      { entryId: "metadata", relativePath: "metadata.yaml", bytes: new TextEncoder().encode("version: 5\n") },
      { entryId: "part", relativePath: "recordings/part-0.db3", bytes },
    ],
    relations: [{ fromEntryId: "metadata", toEntryId: "part", kind: "metadata-for" }],
  });
  const bundle = verifyHostedManifest(JSON.stringify(descriptor.manifest), descriptor.manifestVerificationKey);
  return { descriptor, bundle, capability: capability(descriptor.capabilityUrl), bytes };
}

function rangeScope(
  opened: Awaited<ReturnType<typeof hosted>>,
  entryIndex: number,
  offset: bigint,
  length: bigint,
) {
  const entry = opened.bundle.entries[entryIndex]!;
  const manifestEntry = opened.descriptor.manifest.payload.entries.find((candidate) => candidate.entryId === entry.entryId)!;
  return {
    sessionId: opened.descriptor.manifest.payload.sessionId,
    entryId: entry.entryId,
    objectId: manifestEntry.objectId,
    immutableVersion: entry.immutableVersion,
    offset,
    length,
  } as const;
}

function tamper(manifest: SignedHostedManifest, change: (copy: SignedHostedManifest) => void): SignedHostedManifest {
  const copy = JSON.parse(JSON.stringify(manifest)) as SignedHostedManifest;
  change(copy);
  return copy;
}

describe("provider-neutral hosted sharing core", () => {
  it("creates private immutable objects and a trusted canonical signed SourceBundle manifest", async () => {
    const now = { value: 10_000 };
    const service = fixture(now);
    const upload = Uint8Array.of(1, 2, 3, 4, 5, 6);
    const descriptor = await createHostedSession(service, {
      entries: [{ entryId: "recording", relativePath: "recordings/source.mcap", bytes: upload }],
    });
    upload.fill(99);

    const manifest = service.openHostedSession(capability(descriptor.capabilityUrl));
    const bundle = verifyHostedManifest(JSON.stringify(manifest), descriptor.manifestVerificationKey);
    const ownKeys = vi.fn(Reflect.ownKeys);
    const get = vi.fn(Reflect.get);
    const getPrototypeOf = vi.fn(Reflect.getPrototypeOf);
    const hostile = new Proxy(manifest, { get, getPrototypeOf, ownKeys });
    expect(() => verifyHostedManifest(hostile as unknown as string, descriptor.manifestVerificationKey))
      .toThrow(/bounded serialized JSON text/);
    expect(() => serializeHostedManifestPayload(hostile as unknown as string))
      .toThrow(/bounded serialized JSON text/);
    expect(get).not.toHaveBeenCalled();
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();
    expect(bundle.entries).toHaveLength(1);
    expect(bundle.entries[0]).toMatchObject({
      relativePath: "recordings/source.mcap",
      sizeBytes: 6n,
      immutableVersion: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      byteSource: { kind: "granted-range" },
    });
    expect(bundle.entries[0]!.immutableVersion).toBe(`sha256:${bundle.entries[0]!.sha256}`);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.payload.entries)).toBe(true);

    const entry = bundle.entries[0]!;
    const manifestEntry = descriptor.manifest.payload.entries[0]!;
    const scope = {
      sessionId: descriptor.manifest.payload.sessionId,
      entryId: entry.entryId,
      objectId: manifestEntry.objectId,
      immutableVersion: entry.immutableVersion,
      offset: 0n,
      length: entry.sizeBytes,
    } as const;
    const grant = issueRangeGrant(service, capability(descriptor.capabilityUrl), scope);
    await expect(readGrantedRange(service, {
      ...scope,
      sessionCapability: capability(descriptor.capabilityUrl),
      grantToken: grant.token,
    }, new AbortController().signal)).resolves.toEqual(Uint8Array.of(1, 2, 3, 4, 5, 6));

    const changedPath = tamper(manifest, (copy) => {
      (copy.payload.entries[0] as { relativePath: string }).relativePath = "recordings/other.mcap";
    });
    expect(() => verifyHostedManifest(JSON.stringify(changedPath), descriptor.manifestVerificationKey)).toThrow(/signature/);
    const changedSize = tamper(manifest, (copy) => {
      (copy.payload.entries[0] as { sizeBytes: string }).sizeBytes = "7";
    });
    expect(() => verifyHostedManifest(JSON.stringify(changedSize), descriptor.manifestVerificationKey)).toThrow();
    const changedSession = tamper(manifest, (copy) => {
      (copy.payload as { sessionId: string }).sessionId = "D".repeat(43);
    });
    expect(() => verifyHostedManifest(JSON.stringify(changedSession), descriptor.manifestVerificationKey)).toThrow(/signature/);
    const oversizedKey = tamper(manifest, (copy) => {
      (copy as { publicKeySpki: string }).publicKeySpki = "A".repeat(1_000_000);
    });
    expect(() => verifyHostedManifest(JSON.stringify(oversizedKey), descriptor.manifestVerificationKey)).toThrow(/public key encoding/);
    const oversizedSignature = tamper(manifest, (copy) => {
      (copy as { signature: string }).signature = "A".repeat(1_000_000);
    });
    expect(() => verifyHostedManifest(JSON.stringify(oversizedSignature), descriptor.manifestVerificationKey)).toThrow(/signature encoding/);
    expect(() => verifyHostedManifest(JSON.stringify(manifest), "AA")).toThrow(/trusted/);
  });

  it("fails unauthorized, enumerated, expired, cross-session, cross-object, cross-version, and cross-range access closed", async () => {
    const now = { value: 20_000 };
    const service = fixture(now);
    const first = await hosted(service);
    const second = await hosted(service, Uint8Array.of(7, 8, 9));
    const otherEntry = first.bundle.entries[0]!;
    const scope = rangeScope(first, 1, 10n, 8n);
    const grant = issueRangeGrant(service, first.capability, scope);
    const valid = {
      ...scope,
      sessionCapability: first.capability,
      grantToken: grant.token,
    } as const;
    const signal = new AbortController().signal;

    expect(() => service.openHostedSession("A".repeat(43))).toThrow(HostedAccessError);
    expect(() => issueRangeGrant(service, first.capability, { ...valid, immutableVersion: "sha256:" + "0".repeat(64) })).toThrow(HostedAccessError);
    expect(() => issueRangeGrant(service, first.capability, { ...valid, entryId: otherEntry.entryId })).toThrow(HostedAccessError);
    expect(() => issueRangeGrant(service, first.capability, { ...valid, objectId: second.descriptor.manifest.payload.entries[1]!.objectId })).toThrow(HostedAccessError);
    expect(() => issueRangeGrant(service, first.capability, { ...valid, sessionId: second.descriptor.manifest.payload.sessionId })).toThrow(HostedAccessError);
    expect(() => issueRangeGrant(service, first.capability, { ...valid, length: 65n })).toThrow(HostedAccessError);
    expect(() => issueRangeGrant(service, first.capability, { ...valid, offset: -1n })).toThrow(HostedAccessError);
    await expect(readGrantedRange(service, { ...valid, sessionCapability: second.capability }, signal)).rejects.toBeInstanceOf(HostedAccessError);
    await expect(readGrantedRange(service, { ...valid, grantToken: "B".repeat(43) }, signal)).rejects.toBeInstanceOf(HostedAccessError);
    await expect(readGrantedRange(service, { ...valid, entryId: otherEntry.entryId }, signal)).rejects.toBeInstanceOf(HostedAccessError);
    await expect(readGrantedRange(service, { ...valid, objectId: second.descriptor.manifest.payload.entries[1]!.objectId }, signal)).rejects.toBeInstanceOf(HostedAccessError);
    await expect(readGrantedRange(service, { ...valid, sessionId: second.descriptor.manifest.payload.sessionId }, signal)).rejects.toBeInstanceOf(HostedAccessError);
    await expect(readGrantedRange(service, { ...valid, immutableVersion: otherEntry.immutableVersion }, signal)).rejects.toBeInstanceOf(HostedAccessError);
    await expect(readGrantedRange(service, { ...valid, offset: 11n }, signal)).rejects.toBeInstanceOf(HostedAccessError);
    await expect(readGrantedRange(service, { ...valid, length: 7n }, signal)).rejects.toBeInstanceOf(HostedAccessError);
    await expect(readGrantedRange(service, valid, signal)).resolves.toEqual(first.bytes.slice(10, 18));

    now.value = grant.expiresAtMs;
    await expect(readGrantedRange(service, valid, signal)).rejects.toBeInstanceOf(HostedAccessError);
    now.value = first.descriptor.expiresAtMs;
    expect(() => service.openHostedSession(first.capability)).toThrow(HostedAccessError);
  });

  it("revokes new grants immediately while bounding already-issued grant residual lifetime", async () => {
    const now = { value: 30_000 };
    const service = fixture(now);
    const opened = await hosted(service);
    const scope = rangeScope(opened, 1, 2n, 4n);
    const grant = issueRangeGrant(service, opened.capability, scope);
    const read = {
      ...scope,
      sessionCapability: opened.capability,
      grantToken: grant.token,
    } as const;
    service.revokeSession(opened.capability);
    expect(() => issueRangeGrant(service, opened.capability, read)).toThrow(HostedAccessError);
    expect(() => service.openHostedSession(opened.capability)).toThrow(HostedAccessError);

    now.value = grant.expiresAtMs - 1;
    await expect(readGrantedRange(service, read, new AbortController().signal)).resolves.toEqual(opened.bytes.slice(2, 6));
    now.value = grant.expiresAtMs;
    await expect(readGrantedRange(service, read, new AbortController().signal)).rejects.toBeInstanceOf(HostedAccessError);
    expect(grant.expiresAtMs - 30_000).toBe(100);
  });

  it("deletion and deterministic retention deny subsequent access, including existing grants", async () => {
    const now = { value: 40_000 };
    const service = fixture(now);
    const deleted = await hosted(service);
    const scope = rangeScope(deleted, 1, 0n, 4n);
    const grant = issueRangeGrant(service, deleted.capability, scope);
    await service.deleteSession(deleted.capability);
    expect(() => service.openHostedSession(deleted.capability)).toThrow(HostedAccessError);
    await expect(readGrantedRange(service, {
      ...scope,
      sessionCapability: deleted.capability,
      grantToken: grant.token,
    }, new AbortController().signal)).rejects.toBeInstanceOf(HostedAccessError);

    const retained = await createHostedSession(service, {
      entries: [{ entryId: "bag", relativePath: "recording.bag", bytes: Uint8Array.of(1, 2, 3) }],
      sessionTtlMs: 200,
      retentionMs: 300,
    });
    const retainedCapability = capability(retained.capabilityUrl);
    now.value += 299;
    await expect(service.sweepRetention()).resolves.toMatchObject({ sessionsDeleted: 0 });
    now.value += 1;
    await expect(service.sweepRetention()).resolves.toMatchObject({ sessionsDeleted: 1, objectsDeleted: 1, bytesDeleted: 3 });
    await expect(service.sweepRetention()).resolves.toMatchObject({ sessionsDeleted: 0, objectsDeleted: 0, bytesDeleted: 0 });
    expect(() => service.openHostedSession(retainedCapability)).toThrow(HostedAccessError);
  });

  it("revalidates deletion, expiry, and cancellation after an adversarial asynchronous provider read", async () => {
    const now = { value: 45_000 };
    const store = new AdversarialStore();
    const service = new HostedSharingService({
      store,
      now: () => now.value,
      limits: { sessionTtlMs: 1_000, grantTtlMs: 100, retentionMs: 2_000, maxRangeBytes: 64 },
    });
    const create = async () => {
      const descriptor = await createHostedSession(service, {
        entries: [{ entryId: "bag", relativePath: "recording.bag", bytes: Uint8Array.of(1, 2, 3, 4) }],
      });
      const bundle = verifyHostedManifest(JSON.stringify(descriptor.manifest), descriptor.manifestVerificationKey);
      const sessionCapability = capability(descriptor.capabilityUrl);
      const entry = bundle.entries[0]!;
      const manifestEntry = descriptor.manifest.payload.entries[0]!;
      const scope = {
        sessionId: descriptor.manifest.payload.sessionId,
        entryId: entry.entryId,
        objectId: manifestEntry.objectId,
        immutableVersion: entry.immutableVersion,
        offset: 0n,
        length: 4n,
      } as const;
      const grant = issueRangeGrant(service, sessionCapability, scope);
      return { descriptor, sessionCapability, scope, grant };
    };

    const deleted = await create();
    await service.deleteSession(deleted.sessionCapability);
    await expect(readGrantedRange(service, {
      ...deleted.scope,
      sessionCapability: deleted.sessionCapability,
      grantToken: deleted.grant.token,
    }, new AbortController().signal)).rejects.toBeInstanceOf(HostedAccessError);

    const expiring = await create();
    store.beforeRead = () => { now.value = expiring.grant.expiresAtMs; };
    await expect(readGrantedRange(service, {
      ...expiring.scope,
      sessionCapability: expiring.sessionCapability,
      grantToken: expiring.grant.token,
    }, new AbortController().signal)).rejects.toBeInstanceOf(HostedAccessError);

    now.value += 1;
    const cancelling = await create();
    const abort = new AbortController();
    store.beforeRead = () => abort.abort("source closed");
    await expect(readGrantedRange(service, {
      ...cancelling.scope,
      sessionCapability: cancelling.sessionCapability,
      grantToken: cancelling.grant.token,
    }, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses incremental cancellable range reads and preserves bundle order and byte equivalence", async () => {
    const now = { value: 50_000 };
    const service = fixture(now);
    const opened = await hosted(service);
    const entry = opened.bundle.entries[1]!;
    const source = service.createRangeSource(opened.capability, entry.entryId);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < opened.bytes.byteLength; offset += 32) {
      chunks.push(await source.read({ offset: BigInt(offset), length: 32n }, new AbortController().signal));
    }
    expect(Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))).toEqual(opened.bytes);
    expect(opened.bundle.entries.map(({ relativePath }) => relativePath)).toEqual([
      "metadata.yaml",
      "recordings/part-0.db3",
    ]);
    expect(opened.bundle.relations).toEqual([expect.objectContaining({
      fromEntryId: opened.bundle.entries[0]!.entryId,
      toEntryId: opened.bundle.entries[1]!.entryId,
      kind: "metadata-for",
    })]);
    expect(service.telemetry()).toMatchObject({ rangeReads: 8, bytesServed: 256 });

    await expect(source.read({ offset: 0n, length: 65n }, new AbortController().signal)).rejects.toBeInstanceOf(HostedAccessError);
    const abort = new AbortController();
    abort.abort("source changed");
    await expect(source.read({ offset: 0n, length: 32n }, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps audit and cost telemetry bounded and free of capabilities, grants, object keys, and payloads", async () => {
    const now = { value: 60_000 };
    const service = fixture(now, { auditCapacity: 3 });
    const opened = await hosted(service, new TextEncoder().encode("SENSITIVE_PAYLOAD"));
    const entry = opened.bundle.entries[1]!;
    const scope = rangeScope(opened, 1, 0n, 4n);
    const grant = issueRangeGrant(service, opened.capability, scope);
    await readGrantedRange(service, {
      ...scope,
      sessionCapability: opened.capability,
      grantToken: grant.token,
    }, new AbortController().signal);
    expect(() => service.openHostedSession("C".repeat(43))).toThrow(HostedAccessError);

    const serialized = JSON.stringify({ audit: service.auditEvents(), telemetry: service.telemetry() });
    expect(service.auditEvents()).toHaveLength(3);
    expect(serialized).not.toContain(opened.capability);
    expect(serialized).not.toContain(grant.token);
    expect(serialized).not.toContain("SENSITIVE_PAYLOAD");
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain(entry.entryId);
    expect(service.telemetry()).toMatchObject({
      sessionsCreated: 1,
      objectsUploaded: 2,
      uploadedBytes: 28,
      grantsIssued: 1,
      rangeReads: 1,
      bytesServed: 4,
      deniedRequests: 1,
    });
    expect("listSessions" in service).toBe(false);
    expect("listObjects" in service).toBe(false);
  });
});

describe("serialized hosted admission", () => {
  it("rejects hostile Proxy inputs before any trap", async () => {
    const service = new HostedSharingService();
    const traps = { get: vi.fn(), getPrototypeOf: vi.fn(), ownKeys: vi.fn(), toJSON: vi.fn() };
    const hostile = new Proxy({}, { get: traps.get, getPrototypeOf: traps.getPrototypeOf, ownKeys: traps.ownKeys, getOwnPropertyDescriptor: traps.get });
    await expect(service.createHostedSessionSerialized(hostile as unknown as string)).rejects.toThrow(/serialized JSON/);
    expect(traps.get).not.toHaveBeenCalled(); expect(traps.getPrototypeOf).not.toHaveBeenCalled(); expect(traps.ownKeys).not.toHaveBeenCalled();
    expect(() => service.issueRangeGrantSerialized("cap", hostile as unknown as string)).toThrow(/serialized JSON/);
    await expect(service.readGrantedRangeSerialized(hostile as unknown as string, new AbortController().signal)).rejects.toThrow(/serialized JSON/);
  });
});
