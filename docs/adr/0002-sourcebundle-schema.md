# ADR-0002: SourceBundle and schema capability contracts

- **Status:** Accepted M0 baseline
- **Scope:** recording boundary and schema acquisition; no adapter implementation

## Context

ROS 2 SQLite may contain metadata plus multiple parts, hosted recordings need immutable ranges, and schemas may be embedded, resolvable, conflicting, or absent. A single-file/nullable-schema model cannot represent these cases truthfully.

## Decision

Use an immutable `SourceBundle` containing normalized named entries, sizes, immutable versions/hashes, and explicit metadata/part relations. Local entries provide sliceable blobs; hosted entries provide cancellable immutable-version-scoped ranges. Adapters validate relations and range behavior before payload parsing.

Every channel exposes `schema-present`, `schema-resolvable`, or `opaque`. Providers run deterministically: embedded, ROS 1 connection definition, live-edge introspection, then explicit schema pack. Results include provider/version/hash provenance. Conflicts are diagnosed; absence remains opaque.

Untrusted schema packs are declarative data with byte, nesting, field-count, array, name, and numeric bounds. They cannot execute code. Opaque channels expose metadata and a bounded byte preview plus import guidance, never guessed typed values.

## Consequences

Single and multipart local/hosted recordings share one boundary. Hosted equivalence can be tested without selecting a hosted product stack. Fixtures must cover relations, missing parts, traversal, hash/version mismatch, conflicts, malicious packs, and absent schemas.
