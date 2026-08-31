import { readFile } from "node:fs/promises";

import { McapWriter, type IWritable } from "@mcap/core";
import { describe, expect, it } from "vitest";

import {
  HostedAccessError,
  HostedSharingService,
  serializeGrantedRangeRead,
  serializeHostedManifestPayload,
  serializeHostedSessionInput,
  serializeRangeGrantRequest,
  verifyHostedManifest,
  type CreateHostedSessionInput,
  type GrantedRangeRead,
  type HostedSessionDescriptor,
  type IssuedRangeGrant,
  type RangeGrantRequest,
  type SignedHostedManifest,
} from "../../packages/hosted-core/src/index.js";
import { McapSourceSession } from "../../packages/source-mcap/src/index.js";
import {
  HostedSourceSession,
  type HostedGrantScope,
  type HostedManifestVerifier,
  type HostedRangeGrant,
  type HostedRangeTransport,
  type SignedManifestEnvelope,
  type VerifiedHostedManifest,
} from "../../packages/source-hosted/src/index.js";
import {
  BlobRangeSource,
  BoundedByteReader,
  SourceEpochController,
  type RangeSource,
  type WorkerResourceLimits,
} from "../../packages/worker-runtime/src/index.js";
import {
  createHostedSessionDesktopShell,
  renderDesktopShell,
  type HostedSourceRuntimePort,
  type OpenHostedResult,
} from "../../apps/web/src/index.js";

const encoder = new TextEncoder();

interface MutableClock {
  value: number;
}

class FixtureWritable implements IWritable {
  readonly chunks: Uint8Array[] = [];
  #position = 0n;

  async write(buffer: Uint8Array): Promise<void> {
    this.chunks.push(buffer.slice());
    this.#position += BigInt(buffer.byteLength);
  }

  position(): bigint {
    return this.#position;
  }

  bytes(): Uint8Array {
    const output = new Uint8Array(Number(this.#position));
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}

async function mcapFixture(messageCount = 96): Promise<Uint8Array> {
  const writable = new FixtureWritable();
  const writer = new McapWriter({
    writable,
    useChunks: true,
    useStatistics: true,
    useSummaryOffsets: true,
    repeatSchemas: true,
    repeatChannels: true,
    useMessageIndex: true,
    useChunkIndex: true,
    chunkSize: 32 * 1_024,
  });
  await writer.start({ profile: "ros2", library: "M4 deterministic local fixture" });
  const schemaId = await writer.registerSchema({
    name: "example_msgs/msg/Bytes",
    encoding: "ros2msg",
    data: encoder.encode("uint8[] data\n"),
  });
  const channelId = await writer.registerChannel({ schemaId, topic: "/bytes", messageEncoding: "cdr", metadata: new Map() });
  for (let index = 0; index < messageCount; index += 1) {
    const data = new Uint8Array(1_024);
    data.fill(index % 251);
    await writer.addMessage({
      channelId,
      sequence: index,
      logTime: BigInt(10 + index * 10),
      publishTime: BigInt(9 + index * 10),
      data,
    });
  }
  await writer.end();
  return writable.bytes();
}

function capability(url: string): string {
  const value = url.split("/").at(-1);
  if (!value) throw new Error("missing hosted capability fixture");
  return value;
}

function createHostedSession(
  service: HostedSharingService,
  input: CreateHostedSessionInput,
): Promise<HostedSessionDescriptor> {
  return service.createHostedSessionSerialized(serializeHostedSessionInput(input));
}

function issueRangeGrant(
  service: HostedSharingService,
  sessionCapability: string,
  request: RangeGrantRequest,
): IssuedRangeGrant {
  return service.issueRangeGrantSerialized(sessionCapability, serializeRangeGrantRequest(request));
}

async function readGrantedRange(
  service: HostedSharingService,
  request: GrantedRangeRead,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const bytes = await service.readGrantedRangeSerialized(serializeGrantedRangeRead(request), signal);
  return Uint8Array.from(bytes);
}

function sourceEnvelope(manifest: SignedHostedManifest): SignedManifestEnvelope {
  return Object.freeze({
    payload: serializeHostedManifestPayload(JSON.stringify(manifest.payload)),
    signature: manifest.signature,
    keyId: manifest.keyId,
    algorithm: manifest.algorithm,
  });
}

class CoreManifestVerifier implements HostedManifestVerifier {
  readonly #manifest: SignedHostedManifest;
  readonly #trustedKey: string;

  constructor(manifest: SignedHostedManifest, trustedKey: string) {
    this.#manifest = manifest;
    this.#trustedKey = trustedKey;
  }

  async verify(envelope: SignedManifestEnvelope, signal: AbortSignal): Promise<VerifiedHostedManifest> {
    if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (
      envelope.payload !== serializeHostedManifestPayload(JSON.stringify(this.#manifest.payload)) ||
      envelope.signature !== this.#manifest.signature ||
      envelope.keyId !== this.#manifest.keyId ||
      envelope.algorithm !== this.#manifest.algorithm
    ) {
      throw new Error("signed manifest envelope mismatch");
    }
    verifyHostedManifest(JSON.stringify(this.#manifest), this.#trustedKey);
    return Object.freeze({
      verification: "verified-signature" as const,
      bundleId: this.#manifest.payload.bundleId,
      version: 1 as const,
      sessionId: this.#manifest.payload.sessionId,
      validFromMs: this.#manifest.payload.issuedAtMs,
      expiresAtMs: this.#manifest.payload.expiresAtMs,
      entries: Object.freeze(this.#manifest.payload.entries.map((entry) => Object.freeze({
        entryId: entry.entryId,
        relativePath: entry.relativePath,
        sizeBytes: BigInt(entry.sizeBytes),
        objectId: entry.objectId,
        immutableVersion: entry.immutableVersion,
        sha256: `sha256:${entry.sha256}`,
        chunks: Object.freeze(entry.chunks.map((chunk) => Object.freeze({
          offset: BigInt(chunk.offset),
          length: BigInt(chunk.length),
          sha256: chunk.sha256,
        }))),
      }))),
      relations: Object.freeze(this.#manifest.payload.relations.map((relation) => Object.freeze({ ...relation }))),
    });
  }
}

class CoreRangeTransport implements HostedRangeTransport {
  readonly #service: HostedSharingService;
  readonly #manifest: SignedHostedManifest;
  readonly #capability: string;
  readonly #now: () => number;

  constructor(service: HostedSharingService, manifest: SignedHostedManifest, capabilityValue: string, now: () => number) {
    this.#service = service;
    this.#manifest = manifest;
    this.#capability = capabilityValue;
    this.#now = now;
  }

  async issueRangeGrant(capabilityValue: string, scope: HostedGrantScope, signal: AbortSignal): Promise<HostedRangeGrant> {
    if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const entry = this.#manifest.payload.entries.find((candidate) => candidate.objectId === scope.objectId);
    if (!entry) throw new HostedAccessError();
    const issuedAtMs = this.#now();
    const grant = issueRangeGrant(this.#service, capabilityValue, {
      sessionId: scope.sessionId,
      entryId: entry.entryId,
      objectId: scope.objectId,
      immutableVersion: scope.immutableVersion,
      offset: scope.offset,
      length: scope.length,
    });
    return Object.freeze({ ...scope, token: grant.token, issuedAtMs, expiresAtMs: grant.expiresAtMs });
  }

  async fetchRange(grant: HostedRangeGrant, signal: AbortSignal): Promise<Uint8Array> {
    const entry = this.#manifest.payload.entries.find((candidate) => candidate.objectId === grant.objectId);
    if (!entry) throw new HostedAccessError();
    return readGrantedRange(this.#service, {
      sessionCapability: this.#capability,
      grantToken: grant.token,
      sessionId: grant.sessionId,
      entryId: entry.entryId,
      objectId: grant.objectId,
      immutableVersion: grant.immutableVersion,
      offset: grant.offset,
      length: grant.length,
    }, signal);
  }
}

interface HostedFixture {
  readonly service: HostedSharingService;
  readonly clock: MutableClock;
  readonly bytes: Uint8Array;
  readonly descriptor: HostedSessionDescriptor;
  readonly capability: string;
  readonly manifest: SignedHostedManifest;
  readonly source: HostedSourceSession;
}

function serviceFixture(clock: MutableClock): HostedSharingService {
  return new HostedSharingService({
    now: () => clock.value,
    limits: {
      sessionTtlMs: 10_000,
      grantTtlMs: 500,
      retentionMs: 20_000,
      maxEntriesPerSession: 8,
      maxSessionBytes: 2 * 1_024 * 1_024,
      maxStoredBytes: 8 * 1_024 * 1_024,
      maxActiveSessions: 16,
      maxActiveGrants: 2_048,
      maxRangeBytes: 64 * 1_024,
      auditCapacity: 128,
    },
  });
}

async function hostedFixture(bytes: Uint8Array, clock: MutableClock = { value: 100_000 }): Promise<HostedFixture> {
  const service = serviceFixture(clock);
  const descriptor = await createHostedSession(service, {
    entries: [{ entryId: "recording", relativePath: "recordings/fixture.mcap", bytes }],
  });
  const sessionCapability = capability(descriptor.capabilityUrl);
  const manifest = service.openHostedSession(sessionCapability);
  const transport = new CoreRangeTransport(service, manifest, sessionCapability, () => clock.value);
  const source = await HostedSourceSession.open(
    sourceEnvelope(manifest),
    sessionCapability,
    new CoreManifestVerifier(manifest, descriptor.manifestVerificationKey),
    transport,
    {
      now: () => clock.value,
      limits: {
        maxEntries: 8,
        maxChunksPerEntry: 1_024,
        maxChunkBytes: 64 * 1_024,
        maxReadBytes: 256 * 1_024,
        maxCacheBytes: 0,
        maxGrantTtlMs: descriptor.residualGrantLifetimeMs,
      },
    },
  );
  return { service, clock, bytes, descriptor, capability: sessionCapability, manifest, source };
}

const workerLimits: WorkerResourceLimits = {
  maxSingleReadBytes: 256 * 1_024,
  maxTotalReadBytes: 8n * 1_024n * 1_024n,
  maxConcurrentReads: 4,
  maxQueuedReads: 16,
  maxBufferedBytes: 512 * 1_024,
  maxDecompressedBytes: 2 * 1_024 * 1_024,
  maxDecompressionRatio: 16,
  maxCacheBytes: 256 * 1_024,
};

function reader(source: RangeSource): BoundedByteReader {
  return new BoundedByteReader(source, new SourceEpochController(), workerLimits);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer));
  return `sha256:${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

async function playbackSnapshot(source: RangeSource) {
  const session = await McapSourceSession.open(reader(source), {
    limits: {
      sequentialReadBytes: 64 * 1_024,
      maxBufferedBytes: 512 * 1_024,
      maxDecompressedBytes: 2 * 1_024 * 1_024,
      maxDecompressionRatio: 16,
      maxMessageIndexCacheBytes: 128 * 1_024,
    },
  });
  const messages = [];
  for await (const message of session.readIndexed()) {
    messages.push({
      topic: message.channel.topic,
      schema: message.channel.schema,
      sequence: message.sequence,
      logTimeNanos: message.logTimeNanos,
      publishTimeNanos: message.publishTimeNanos,
      payloadHash: await sha256(message.data),
    });
  }
  return Object.freeze({
    channels: session.channels(),
    timeRange: session.timeRange(),
    messages,
    diagnostic: session.diagnostic,
    mode: session.mode,
  });
}

function rangeScope(fixture: HostedFixture, offset = 0n, length = 64n) {
  const entry = fixture.manifest.payload.entries[0]!;
  return Object.freeze({
    sessionId: fixture.manifest.payload.sessionId,
    entryId: entry.entryId,
    objectId: entry.objectId,
    immutableVersion: entry.immutableVersion,
    offset,
    length,
  });
}

function grantedRead(fixture: HostedFixture, grant: IssuedRangeGrant) {
  return Object.freeze({
    ...grant,
    sessionCapability: fixture.capability,
    grantToken: grant.token,
  });
}

class HostedMcapRuntime implements HostedSourceRuntimePort {
  readonly #fixture: HostedFixture;

  constructor(fixture: HostedFixture) {
    this.#fixture = fixture;
  }

  async open(capabilityValue: string, signal: AbortSignal): Promise<OpenHostedResult> {
    if (capabilityValue !== this.#fixture.capability || signal.aborted) throw Object.assign(new Error("denied"), { code: "invalid" });
    const manifest = this.#fixture.service.openHostedSession(capabilityValue);
    verifyHostedManifest(JSON.stringify(manifest), this.#fixture.descriptor.manifestVerificationKey);
    const session = await McapSourceSession.open(reader(this.#fixture.source.entrySource(manifest.payload.entries[0]!.entryId)), {
      limits: {
        sequentialReadBytes: 64 * 1_024,
        maxBufferedBytes: 512 * 1_024,
        maxDecompressedBytes: 2 * 1_024 * 1_024,
        maxDecompressionRatio: 16,
        maxMessageIndexCacheBytes: 128 * 1_024,
      },
    });
    const timeRange = session.timeRange();
    const telemetry = this.#fixture.service.telemetry();
    return Object.freeze({
      sourceLabel: manifest.payload.entries[0]!.objectId,
      sourceHash: manifest.payload.entries[0]!.immutableVersion,
      durationNanos: timeRange ? timeRange.endTimeNanos - timeRange.startTimeNanos : 0n,
      epoch: 1,
      indexState: session.mode === "indexed" ? "indexed" : "sequential",
      topics: session.channels().map((channel) => Object.freeze({
        id: String(channel.id),
        name: channel.topic,
        typeName: channel.schema.name,
        compatibility: channel.schema.capability === "schema-present" ? "schema-backed-generic" as const : "opaque-inspectable" as const,
        schemaCapability: channel.schema.capability,
        availableDisplays: ["raw-inspector" as const],
      })),
      diagnostic: session.diagnostic,
      observability: Object.freeze({
        rangeRequests: telemetry.rangeReads,
        transferredBytes: telemetry.bytesServed,
        deniedRequests: telemetry.deniedRequests,
        activeReaders: 1,
      }),
    });
  }

  async seek(timeNanos: bigint) {
    return Object.freeze({ epoch: 1, currentTimeNanos: timeNanos });
  }
}

describe("M4 hosted cross-boundary proof", () => {
  it("runs upload -> signed manifest -> exact grants -> source-equivalent playback -> opaque hosted UI", async () => {
    const bytes = await mcapFixture();
    expect(bytes.byteLength).toBeGreaterThan(64 * 1_024);
    const fixture = await hostedFixture(bytes);
    const localBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const local = await playbackSnapshot(new BlobRangeSource(new Blob([localBuffer])));
    const hosted = await playbackSnapshot(fixture.source.entrySource(fixture.manifest.payload.entries[0]!.entryId));

    expect(hosted).toEqual(local);
    expect(fixture.manifest.payload.entries[0]!.chunks.length).toBeGreaterThan(1);
    expect(fixture.service.telemetry()).toMatchObject({ rangeReads: expect.any(Number), bytesServed: expect.any(Number) });
    expect(fixture.service.telemetry().rangeReads).toBeGreaterThan(1);
    expect(fixture.source.telemetry()).toMatchObject({ rangeFetches: expect.any(Number), integrityFailures: 0 });

    const { controller } = createHostedSessionDesktopShell(new HostedMcapRuntime(fixture));
    await controller.openHosted({ link: `https://viewer.invalid/session#cap=${fixture.capability}` });
    const html = renderDesktopShell(controller);
    expect(controller.state).toMatchObject({ phase: "ready", sourceMode: "hosted", indexState: "indexed" });
    expect(controller.state.topics.map((topic) => topic.name)).toEqual(["/bytes"]);
    expect(html).toContain("Mode: hosted · read-only");
    expect(html).not.toContain(fixture.capability);
    expect(html).not.toContain(fixture.manifest.payload.entries[0]!.objectId);
    expect(html).not.toContain(fixture.manifest.signature);
    expect(html).not.toContain(fixture.descriptor.manifestVerificationKey);
  });

  it("denies enumeration and cross-session/object/version/range access with constant-shape errors", async () => {
    const first = await hostedFixture(Uint8Array.from({ length: 256 }, (_, index) => index));
    const otherTenant = serviceFixture(first.clock);
    const secondDescriptor = await createHostedSession(first.service, {
      entries: [{ entryId: "other", relativePath: "other.mcap", bytes: Uint8Array.of(7, 8, 9, 10) }],
    });
    const secondCapability = capability(secondDescriptor.capabilityUrl);
    const second = first.service.openHostedSession(secondCapability);
    const scope = rangeScope(first, 0n, 32n);
    const validGrant = issueRangeGrant(first.service, first.capability, scope);
    const denied = [
      () => first.service.openHostedSession("A".repeat(43)),
      () => otherTenant.openHostedSession(first.capability),
      () => issueRangeGrant(first.service, first.capability, { ...scope, entryId: "B".repeat(43) }),
      () => issueRangeGrant(first.service, first.capability, { ...scope, sessionId: second.payload.sessionId }),
      () => issueRangeGrant(first.service, first.capability, { ...scope, objectId: second.payload.entries[0]!.objectId }),
      () => issueRangeGrant(first.service, first.capability, { ...scope, immutableVersion: `sha256:${"0".repeat(64)}` }),
      () => issueRangeGrant(first.service, first.capability, { ...scope, length: 65n * 1_024n }),
    ];
    for (const action of denied) {
      expect(action).toThrowError(expect.objectContaining({ code: "access-denied", message: "hosted access denied" }));
    }

    const baseRead = grantedRead(first, validGrant);
    for (const changed of [
      { ...baseRead, sessionCapability: secondCapability },
      { ...baseRead, sessionId: second.payload.sessionId },
      { ...baseRead, objectId: second.payload.entries[0]!.objectId },
      { ...baseRead, immutableVersion: `sha256:${"0".repeat(64)}` },
      { ...baseRead, offset: 1n },
      { ...baseRead, length: 31n },
      { ...baseRead, grantToken: "C".repeat(43) },
    ]) {
      await expect(readGrantedRange(first.service, changed, new AbortController().signal)).rejects.toMatchObject({
        code: "access-denied",
        message: "hosted access denied",
      });
    }
    expect("listSessions" in first.service).toBe(false);
    expect("listObjects" in first.service).toBe(false);
  });

  it("enforces immediate new-grant revocation, residual expiry, deletion, and deterministic retention", async () => {
    const fixture = await hostedFixture(Uint8Array.from({ length: 256 }, (_, index) => index), { value: 200_000 });
    const scope = rangeScope(fixture, 0n, 32n);
    const residual = issueRangeGrant(fixture.service, fixture.capability, scope);
    fixture.service.revokeSession(fixture.capability);
    expect(() => issueRangeGrant(fixture.service, fixture.capability, scope)).toThrow(HostedAccessError);
    fixture.clock.value = residual.expiresAtMs - 1;
    await expect(readGrantedRange(fixture.service, grantedRead(fixture, residual), new AbortController().signal)).resolves.toEqual(
      fixture.bytes.subarray(0, 32),
    );
    fixture.clock.value = residual.expiresAtMs;
    await expect(readGrantedRange(fixture.service, grantedRead(fixture, residual), new AbortController().signal)).rejects.toBeInstanceOf(
      HostedAccessError,
    );
    expect(residual.expiresAtMs - 200_000).toBe(fixture.descriptor.residualGrantLifetimeMs);

    fixture.clock.value += 1;
    const deleted = await createHostedSession(fixture.service, {
      entries: [{ entryId: "deleted", relativePath: "deleted.bag", bytes: Uint8Array.of(1, 2, 3, 4) }],
    });
    const deletedCapability = capability(deleted.capabilityUrl);
    const deletedEntry = deleted.manifest.payload.entries[0]!;
    const deletedScope = {
      sessionId: deleted.manifest.payload.sessionId,
      entryId: deletedEntry.entryId,
      objectId: deletedEntry.objectId,
      immutableVersion: deletedEntry.immutableVersion,
      offset: 0n,
      length: 4n,
    } as const;
    const deletedGrant = issueRangeGrant(fixture.service, deletedCapability, deletedScope);
    await fixture.service.deleteSession(deletedCapability);
    expect(() => fixture.service.openHostedSession(deletedCapability)).toThrow(HostedAccessError);
    await expect(readGrantedRange(fixture.service, {
      ...deletedGrant,
      sessionCapability: deletedCapability,
      grantToken: deletedGrant.token,
    }, new AbortController().signal)).rejects.toBeInstanceOf(HostedAccessError);

    const retained = await createHostedSession(fixture.service, {
      entries: [{ entryId: "retained", relativePath: "retained.bag", bytes: Uint8Array.of(9, 8, 7) }],
      sessionTtlMs: 100,
      retentionMs: 200,
    });
    const retainedCapability = capability(retained.capabilityUrl);
    fixture.clock.value += 199;
    await expect(fixture.service.sweepRetention()).resolves.toMatchObject({ sessionsDeleted: 0 });
    fixture.clock.value += 1;
    await expect(fixture.service.sweepRetention()).resolves.toMatchObject({ sessionsDeleted: expect.any(Number), objectsDeleted: expect.any(Number) });
    expect(() => fixture.service.openHostedSession(retainedCapability)).toThrow(HostedAccessError);
  });

  it("rejects manifest tampering and emits bounded redacted synthetic audit/cost evidence", async () => {
    const fixture = await hostedFixture(encoder.encode("SENSITIVE_SYNTHETIC_PAYLOAD"), { value: 300_000 });
    const tampered = JSON.parse(JSON.stringify(fixture.manifest)) as SignedHostedManifest;
    (tampered.payload.entries[0] as { relativePath: string }).relativePath = "recordings/other.mcap";
    expect(() => verifyHostedManifest(JSON.stringify(tampered), fixture.descriptor.manifestVerificationKey)).toThrow(/signature/);
    expect(() => verifyHostedManifest(JSON.stringify(fixture.manifest), "AA")).toThrow(/trusted/);

    const scope = rangeScope(fixture, 0n, 4n);
    const grant = issueRangeGrant(fixture.service, fixture.capability, scope);
    await readGrantedRange(fixture.service, grantedRead(fixture, grant), new AbortController().signal);
    expect(() => fixture.service.openHostedSession("D".repeat(43))).toThrow(HostedAccessError);
    const telemetry = fixture.service.telemetry();
    const audit = fixture.service.auditEvents();
    expect(Object.values(telemetry).every((value) => Number.isSafeInteger(value) && value >= 0)).toBe(true);
    expect(telemetry).toMatchObject({
      activeSessions: 1,
      sessionsCreated: 1,
      objectsUploaded: 1,
      uploadedBytes: fixture.bytes.byteLength,
      grantsIssued: 1,
      rangeReads: 1,
      bytesServed: 4,
      deniedRequests: 1,
    });
    expect(telemetry.activeSessions).toBeLessThanOrEqual(16);
    expect(telemetry.activeGrants).toBeLessThanOrEqual(2_048);
    expect(audit.length).toBeLessThanOrEqual(128);
    expect(audit.every((event) => Object.keys(event).sort().join(",") === "atMs,kind")).toBe(true);
    const observability = JSON.stringify({ telemetry, audit });
    expect(observability).not.toContain(fixture.capability);
    expect(observability).not.toContain(grant.token);
    expect(observability).not.toContain(fixture.manifest.payload.entries[0]!.objectId);
    expect(observability).not.toContain("SENSITIVE_SYNTHETIC_PAYLOAD");

    const evidence = JSON.parse(await readFile(new URL("../../docs/evidence/m4-hosted.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      milestone: "M4",
      environment: {
        execution: "local-in-process",
        storage: "in-memory-reference",
        fixture: "synthetic",
        networkExecution: false,
        externalDeployment: false,
        paidInfrastructure: false,
        productionSecurityClaim: false,
      },
      gates: {
        signedManifest: "pass",
        exactRangeIsolation: "pass",
        revocationAndResidualTtl: "pass",
        deletionAndRetention: "pass",
        sourceAndUiEquivalence: "pass",
        redactedBoundedObservability: "pass",
      },
    });
    expect(JSON.stringify(evidence)).not.toMatch(/capability_[A-Za-z0-9_-]|grant-[A-Za-z0-9_-]|storageKey|SENSITIVE_SYNTHETIC_PAYLOAD/);
  });
});
