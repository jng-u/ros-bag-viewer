# Architecture and contract baseline (M0)

**Status:** accepted M0 planning baseline. These contracts are required before M1; they do not constitute M1 implementation.

## Boundaries

Every local, hosted, or live input enters through a source adapter. Adapters emit a versioned normalized envelope owned by `core-model`; timeline, TF, displays, and diagnostics depend on that envelope rather than storage- or ROS-generation-specific APIs.

```text
local/hosted/live byte source
  -> source adapter + schema provider
  -> normalized message envelope
  -> timeline + TF + bounded caches
  -> display registry -> renderer-owned resources
```

M0 deliberately does **not** select a render helper, live wire protocol, hosted chunking strategy, public name, license, or infrastructure provider.

## SourceBundle contract

`SourceBundle` is the recording boundary; a recording is not assumed to be one `File`.

```ts
type SourceBundle = Readonly<{
  bundleId: string;
  version: 1;
  entries: readonly SourceEntry[];
  relations: readonly SourceRelation[];
}>;

type SourceEntry = Readonly<{
  entryId: string;
  relativePath: string;        // normalized, relative, no traversal
  sizeBytes: bigint;
  immutableVersion: string;    // local fingerprint or hosted object version
  sha256?: string;             // required for corpus evidence
  byteSource: LocalBlobSource | GrantedRangeSource;
}>;
```

Normative rules:

- Names are immutable, unique after Unicode/path normalization, relative, and traversal-free.
- Size and immutable version are verified before parsing; hash mismatches fail closed.
- Relations describe metadata, primary data, and ordered multipart membership without relying on filename guessing alone.
- Local entries expose `Blob.slice`; hosted entries expose cancellable HTTP ranges scoped to an immutable object version.
- Adapters validate range semantics and surface bounded fallback/degraded behavior rather than silently materializing a whole source.
- Open, seek, reconnect, replacement, or close advances the source epoch and cancels stale reads.

## Schema capability and provider contract

Every channel reports exactly one capability:

| Capability | Meaning | Allowed behavior |
|---|---|---|
| `schema-present` | A validated schema accompanies the source/channel. | Native or schema-backed generic decoding. |
| `schema-resolvable` | A named provider can resolve a validated schema deterministically. | Resolve within limits, report provenance, then decode. |
| `opaque` | No usable schema is available. | Metadata plus bounded bytes and schema-pack guidance only; never speculative decoding. |

Providers run in deterministic order: embedded schema, ROS 1 connection definition, live-edge introspection, then explicitly supplied session/user schema pack. A result records provider ID/version, source identity, content hash, and conflict diagnostics. Conflicting schemas never use first-success silently. Schema packs are data, not executable code, and are bounded by byte size, nesting depth, field count, array dimensions, name length, and numeric limits.

Compatibility tiers are independent of acquisition capability: `native-display`, `schema-backed-generic`, `opaque-inspectable`, or `unsupported`.

## Normalized message and payload ownership

The envelope preserves source-native type metadata while providing typed source, channel, sequence, epoch, scheduling time, TF-query policy input, schema provenance, diagnostics, and payload ownership.

A payload is an immutable byte span owned by the message or a lease on a ref-counted pool buffer. Worker ownership transfers exactly once. A lease:

- belongs to one source epoch;
- supports explicit `retain()`/`release()` accounting;
- becomes invalid on final release, epoch invalidation, or source close;
- cannot be retained by a display beyond its update call;
- is instrumented in development for use-after-release, double release, and retained-byte budget violations.

Displays copy semantic values they retain or create renderer-owned resources. Raw source bytes, Worker handles, credentials, and the raw WebGL context do not cross the display boundary.

## Internal display lifecycle

The versioned lifecycle is ordered: `register`, `instantiate`, `configure`, `attachSource`, `update`, `render`, with `suspend`, `handleError`, and idempotent `dispose` transitions. `update` receives transient message views; `dispose` releases every renderer-owned handle.

Seek, reconnect, backward clock jump, or source replacement atomically invalidates display, queue, cache, lease, and TF state for the prior epoch. M1 dogfoods this internal contract; M5 may expose only a separately reviewed safe subset to trusted build-time packages. Runtime-loaded untrusted plugins are out of scope.

## Time, TF, resources, and diagnostics

Scheduling time, TF query time, and latency measurement time are distinct typed policies; [ADR-0001](adr/0001-time-tf-semantics.md) is normative. Reads, decompression, queues, caches, schema resolution, payload retention, and GPU resources have byte/item/time limits. Unsupported, degraded, dropped, invalid-time, missing-schema, and TF-error states are explicit and observable without logging payload values, credentials, object keys, or share tokens.

M1 remains blocked until SourceBundle, schema, payload, display, time/TF, compatibility, corpus-license, and threat-boundary documents are reviewed as one baseline. Later changes require contract tests and an ADR amendment; a successful demo cannot override these gates.
