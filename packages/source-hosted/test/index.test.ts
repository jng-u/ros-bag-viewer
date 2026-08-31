import { McapWriter, type IWritable } from "@mcap/core";
import { describe, expect, it, vi } from "vitest";

import { emitV1SemanticEvent } from "../../../tests/support/v1-conformance-event.js";
import { McapSourceSession } from "../../source-mcap/src/index.js";
import {
  BlobRangeSource,
  BoundedByteReader,
  SourceEpochController,
  type RangeSource,
  type WorkerResourceLimits,
} from "../../worker-runtime/src/index.js";
import {
  HostedSourceError,
  HostedSourceSession,
  type HostedGrantScope,
  type HostedManifestEntry,
  type HostedManifestVerifier,
  type HostedRangeGrant,
  type HostedRangeTransport,
  type SignedManifestEnvelope,
  type VerifiedHostedManifest,
} from "../src/index.js";

const NOW = 10_000;
const ENVELOPE: SignedManifestEnvelope = Object.freeze({
  payload: "canonical-manifest-v1",
  signature: "signature-fixture",
  keyId: "local-test-key",
  algorithm: "test-sha256",
});

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer));
  return `sha256:${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

async function manifest(bytes: Uint8Array, overrides: Partial<HostedManifestEntry> = {}): Promise<VerifiedHostedManifest> {
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 64) {
    const chunk = bytes.subarray(offset, Math.min(offset + 64, bytes.byteLength));
    chunks.push({ offset: BigInt(offset), length: BigInt(chunk.byteLength), sha256: await sha256(chunk) });
  }
  return {
    verification: "verified-signature",
    bundleId: "bundle-fixture",
    version: 1,
    sessionId: "session-fixture",
    validFromMs: NOW - 1_000,
    expiresAtMs: NOW + 120_000,
    entries: [{
      entryId: "entry-fixture",
      relativePath: "recordings/fixture.mcap",
      sizeBytes: BigInt(bytes.byteLength),
      objectId: "object-fixture",
      immutableVersion: "version-fixture",
      sha256: await sha256(bytes),
      chunks,
      ...overrides,
    }],
    relations: [],
  };
}

class FixtureVerifier implements HostedManifestVerifier {
  calls = 0;
  reject = false;
  readonly #manifest: VerifiedHostedManifest;

  constructor(value: VerifiedHostedManifest) {
    this.#manifest = value;
  }

  async verify(envelope: SignedManifestEnvelope, signal: AbortSignal): Promise<VerifiedHostedManifest> {
    this.calls += 1;
    if (signal.aborted) throw new Error("aborted");
    if (this.reject || envelope.signature !== ENVELOPE.signature || envelope.payload !== ENVELOPE.payload) {
      throw new Error("signature rejected");
    }
    return this.#manifest;
  }
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

class FixtureTransport implements HostedRangeTransport {
  readonly scopes: HostedGrantScope[] = [];
  fetchCalls = 0;
  revoked = false;
  tamperPayload = false;
  stallFetch = false;
  mutateGrant?: (grant: HostedRangeGrant) => HostedRangeGrant;
  readonly #bytes: Uint8Array;
  readonly #pending: Array<{ readonly grant: HostedRangeGrant; readonly resolve: (bytes: Uint8Array) => void }> = [];

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  async issueRangeGrant(capability: string, scope: HostedGrantScope, signal: AbortSignal): Promise<HostedRangeGrant> {
    if (signal.aborted) throw abortError();
    if (this.revoked || capability !== "opaque-capability") throw new Error("denied");
    this.scopes.push({ ...scope });
    const grant: HostedRangeGrant = {
      ...scope,
      token: `grant-${this.scopes.length}`,
      issuedAtMs: NOW,
      expiresAtMs: NOW + 5_000,
    };
    return this.mutateGrant?.(grant) ?? grant;
  }

  async fetchRange(grant: HostedRangeGrant, signal: AbortSignal): Promise<Uint8Array> {
    this.fetchCalls += 1;
    if (signal.aborted) throw abortError();
    if (this.stallFetch) {
      return new Promise<Uint8Array>((resolve, reject) => {
        this.#pending.push({ grant, resolve });
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    }
    const start = Number(grant.offset);
    const end = Number(grant.offset + grant.length);
    const output = this.#bytes.slice(start, end);
    if (this.tamperPayload && output.byteLength > 0) output[0] ^= 0xff;
    return output;
  }

  async authorizeCachedRange(_grant: HostedRangeGrant, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    if (this.revoked) throw new Error("denied");
  }

  releaseStalled(): void {
    for (const { grant, resolve } of this.#pending.splice(0)) {
      resolve(this.#bytes.slice(Number(grant.offset), Number(grant.offset + grant.length)));
    }
  }
}

async function openFixture(
  bytes: Uint8Array,
  options: {
    readonly manifest?: VerifiedHostedManifest;
    readonly transport?: FixtureTransport;
    readonly verifier?: FixtureVerifier;
    readonly now?: () => number;
  } = {},
): Promise<{ readonly session: HostedSourceSession; readonly transport: FixtureTransport; readonly verifier: FixtureVerifier }> {
  const verified = options.manifest ?? await manifest(bytes);
  const transport = options.transport ?? new FixtureTransport(bytes);
  const verifier = options.verifier ?? new FixtureVerifier(verified);
  const session = await HostedSourceSession.open(ENVELOPE, "opaque-capability", verifier, transport, {
    now: options.now ?? (() => NOW),
    limits: {
      maxEntries: 4,
      maxChunksPerEntry: 1_024,
      maxChunkBytes: 64,
      maxReadBytes: 4_096,
      maxCacheBytes: 4_096,
      maxGrantTtlMs: 10_000,
    },
  });
  return { session, transport, verifier };
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

async function mcapFixture(): Promise<Uint8Array> {
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
    chunkSize: 32,
  });
  await writer.start({ profile: "ros2", library: "hosted source fixture" });
  const schemaId = await writer.registerSchema({
    name: "example_msgs/msg/Point",
    encoding: "ros2msg",
    data: new TextEncoder().encode("float64 x\n"),
  });
  const channelId = await writer.registerChannel({ schemaId, topic: "/points", messageEncoding: "cdr", metadata: new Map() });
  await writer.addMessage({ channelId, sequence: 0, logTime: 10n, publishTime: 9n, data: Uint8Array.of(1, 2, 3) });
  await writer.addMessage({ channelId, sequence: 1, logTime: 20n, publishTime: 19n, data: Uint8Array.of(4, 5, 6) });
  await writer.end();
  return writable.bytes();
}

const workerLimits: WorkerResourceLimits = {
  maxSingleReadBytes: 1_024,
  maxTotalReadBytes: 128n * 1_024n,
  maxConcurrentReads: 2,
  maxQueuedReads: 8,
  maxBufferedBytes: 2_048,
  maxDecompressedBytes: 4_096,
  maxDecompressionRatio: 16,
  maxCacheBytes: 2_048,
};

function boundedReader(source: RangeSource): BoundedByteReader {
  return new BoundedByteReader(source, new SourceEpochController(), workerLimits);
}

async function mcapSnapshot(source: RangeSource) {
  const session = await McapSourceSession.open(boundedReader(source), {
    limits: {
      sequentialReadBytes: 64,
      maxBufferedBytes: 2_048,
      maxDecompressedBytes: 4_096,
      maxDecompressionRatio: 16,
      maxMessageIndexCacheBytes: 256,
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
  return { channels: session.channels(), timeRange: session.timeRange(), messages, diagnostic: session.diagnostic };
}

describe("hosted SourceBundle adapter", () => {
  it("verifies the signed manifest and preserves local MCAP schema, order, timeline, payload hashes, and diagnostics", async () => {
    const bytes = await mcapFixture();
    const localBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const local = await mcapSnapshot(new BlobRangeSource(new Blob([localBuffer])));
    const { session, transport, verifier } = await openFixture(bytes);
    const hosted = await mcapSnapshot(session.entrySource("entry-fixture"));

    expect(hosted).toEqual(local);
    expect(verifier.calls).toBe(1);
    expect(transport.scopes.length).toBeGreaterThan(1);
    expect(transport.scopes.every((scope) => scope.sessionId === "session-fixture" && scope.objectId === "object-fixture")).toBe(true);
    expect(session.bundle()).toMatchObject({
      entries: [{
        relativePath: "recordings/fixture.mcap",
        byteSource: { kind: "granted-range", immutableVersion: "version-fixture" },
      }],
    });
    expect(Object.values(session.telemetry()).map(String).join(" ")).not.toContain("opaque-capability");
    emitV1SemanticEvent({ schemaVersion: 1, domain: "source", result: "pass", code: "hosted-source-bundle", facts: {
      manifestVerifications: verifier.calls, rangeScopes: transport.scopes.length, messages: hosted.messages.length,
    } });
  });

  it("rejects tampered signatures, traversal, duplicate normalized paths, invalid hashes, and oversized chunk declarations", async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const verified = await manifest(bytes);
    const verifier = new FixtureVerifier(verified);
    await expect(HostedSourceSession.open({ ...ENVELOPE, signature: "tampered" }, "opaque-capability", verifier, new FixtureTransport(bytes), {
      now: () => NOW,
    })).rejects.toMatchObject({ code: "invalid-manifest" });

    for (const invalidEntry of [
      { relativePath: "../secret.mcap" },
      { sha256: "sha256:not-a-digest" },
      { chunks: [{ ...verified.entries[0]!.chunks[0]!, length: 5_000_000n }] },
    ]) {
      const invalid = await manifest(bytes, invalidEntry);
      await expect(HostedSourceSession.open(ENVELOPE, "opaque-capability", new FixtureVerifier(invalid), new FixtureTransport(bytes), {
        now: () => NOW,
      })).rejects.toBeInstanceOf(HostedSourceError);
    }

    const duplicate = { ...verified, entries: [verified.entries[0]!, { ...verified.entries[0]!, entryId: "entry-two" }] };
    await expect(HostedSourceSession.open(ENVELOPE, "opaque-capability", new FixtureVerifier(duplicate), new FixtureTransport(bytes), {
      now: () => NOW,
    })).rejects.toMatchObject({ code: "invalid-manifest" });

    const expired = { ...verified, expiresAtMs: NOW };
    await expect(HostedSourceSession.open(ENVELOPE, "opaque-capability", new FixtureVerifier(expired), new FixtureTransport(bytes), {
      now: () => NOW,
    })).rejects.toMatchObject({ code: "manifest-expired" });
  });

  it.each([
    ["session", (grant: HostedRangeGrant) => ({ ...grant, sessionId: "cross-session" })],
    ["object", (grant: HostedRangeGrant) => ({ ...grant, objectId: "cross-object" })],
    ["version", (grant: HostedRangeGrant) => ({ ...grant, immutableVersion: "cross-version" })],
    ["offset", (grant: HostedRangeGrant) => ({ ...grant, offset: grant.offset + 1n })],
    ["length", (grant: HostedRangeGrant) => ({ ...grant, length: grant.length - 1n })],
    ["expired", (grant: HostedRangeGrant) => ({ ...grant, expiresAtMs: NOW })],
    ["overlong", (grant: HostedRangeGrant) => ({ ...grant, expiresAtMs: NOW + 10_001 })],
  ] as const)("denies a %s-scoped or expired range grant with a redacted diagnostic", async (_case, mutate) => {
    const bytes = Uint8Array.from({ length: 96 }, (_, index) => index);
    const transport = new FixtureTransport(bytes);
    transport.mutateGrant = mutate;
    const { session } = await openFixture(bytes, { transport });

    await expect(session.readEntry("entry-fixture", 0n, 4n, new AbortController().signal)).rejects.toMatchObject({
      code: "access-denied",
      message: "hosted source request denied",
    });
    expect(session.diagnostics()).toEqual(["access-denied: hosted source request denied"]);
    expect(JSON.stringify(session.diagnostics())).not.toMatch(/session-fixture|object-fixture|version-fixture|opaque-capability/);
  });

  it("reauthorizes cache hits so revocation immediately denies new reads", async () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => index);
    const { session, transport } = await openFixture(bytes);
    expect(await session.readEntry("entry-fixture", 0n, 4n, new AbortController().signal)).toEqual(bytes.subarray(0, 4));
    expect(transport.fetchCalls).toBe(1);
    expect(await session.readEntry("entry-fixture", 0n, 4n, new AbortController().signal)).toEqual(bytes.subarray(0, 4));
    expect(transport.fetchCalls).toBe(1);
    expect(session.telemetry().cacheHits).toBe(1);
    transport.revoked = true;

    await expect(session.readEntry("entry-fixture", 0n, 4n, new AbortController().signal)).rejects.toMatchObject({ code: "access-denied" });
    expect(transport.fetchCalls).toBe(1);
    expect(session.telemetry().grantRequests).toBe(3);
  });

  it("rejects enumeration, range overflow, response hash mismatch, and whole-object hash mismatch", async () => {
    const bytes = Uint8Array.from({ length: 96 }, (_, index) => index);
    const { session, transport } = await openFixture(bytes);
    await expect(session.readEntry("enumerated-entry", 0n, 1n, new AbortController().signal)).rejects.toMatchObject({
      code: "access-denied",
      message: "hosted source request denied",
    });
    await expect(session.readEntry("entry-fixture", 95n, 2n, new AbortController().signal)).rejects.toMatchObject({ code: "invalid-range" });
    transport.tamperPayload = true;
    await expect(session.readEntry("entry-fixture", 0n, 1n, new AbortController().signal)).rejects.toMatchObject({ code: "integrity-failed" });

    const wrongObjectHash = await manifest(bytes, { sha256: `sha256:${"0".repeat(64)}` });
    const other = await openFixture(bytes, { manifest: wrongObjectHash });
    await expect(other.session.readEntry("entry-fixture", 0n, BigInt(bytes.byteLength), new AbortController().signal)).rejects.toMatchObject({
      code: "integrity-failed",
    });
  });

  it("coalesces only exact in-flight chunks and cancels active reads on caller abort or close", async () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => index);
    const transport = new FixtureTransport(bytes);
    transport.stallFetch = true;
    const { session } = await openFixture(bytes, { transport });
    const operationController = new AbortController();
    const first = session.readEntry("entry-fixture", 0n, 4n, operationController.signal);
    const second = session.readEntry("entry-fixture", 4n, 4n, operationController.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.fetchCalls).toBe(1);
    expect(session.telemetry().coalescedReads).toBe(1);
    operationController.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    await expect(second).rejects.toMatchObject({ code: "cancelled" });

    const closingTransport = new FixtureTransport(bytes);
    closingTransport.stallFetch = true;
    const closing = await openFixture(bytes, { transport: closingTransport });
    const active = closing.session.readEntry("entry-fixture", 0n, 4n, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    closing.session.close();
    await expect(active).rejects.toMatchObject({ code: "cancelled" });
    expect(() => closing.session.entrySource("entry-fixture")).toThrowError(expect.objectContaining({ code: "closed" }));
  });

  it("rejects bytes returned after the exact grant expires and does not cache them", async () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => index);
    let now = NOW;
    const transport = new FixtureTransport(bytes);
    transport.stallFetch = true;
    const { session } = await openFixture(bytes, { transport, now: () => now });
    const read = session.readEntry("entry-fixture", 0n, 4n, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    now = NOW + 5_001;
    transport.releaseStalled();

    await expect(read).rejects.toMatchObject({ code: "access-denied" });
    expect(session.telemetry()).toMatchObject({ completedBytes: 0n, cacheBytes: 0 });
  });

  it("rechecks cancellation after asynchronous integrity hashing and does not cache cancelled content", async () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => index);
    const { session } = await openFixture(bytes);
    const digestBytes = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    let releaseDigest: (() => void) | undefined;
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementationOnce(
      () => new Promise<ArrayBuffer>((resolve) => {
        releaseDigest = () => resolve(digestBytes.slice(0));
      }),
    );
    try {
      const controller = new AbortController();
      const read = session.readEntry("entry-fixture", 0n, 4n, controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();
      releaseDigest?.();

      await expect(read).rejects.toMatchObject({ code: "cancelled" });
      expect(session.telemetry()).toMatchObject({ completedBytes: 0n, cacheBytes: 0 });
    } finally {
      digestSpy.mockRestore();
    }
  });
});
