# ADR-0003: Payload leases and internal display lifecycle

- **Status:** Accepted M0 baseline
- **Scope:** ownership and lifecycle contract; no renderer or extension API lock

## Context

Dense images and point clouds cannot tolerate hidden copies or unbounded retention. Displays need deterministic cleanup across seek, replacement, context loss, and error without privileged renderer, Worker, storage, or relay internals.

## Decision

Messages carry immutable owned spans or explicit ref-counted leases. Worker ownership transfers once. Leases belong to one source epoch, support audited retain/release, and are invalid after final release or epoch invalidation. Development detects use-after-release, double release, and retained-byte budget violations.

Displays follow `register -> instantiate -> configure -> attachSource -> update -> render`, with `suspend`, `handleError`, and idempotent `dispose`. `update` receives transient payload views. Displays retain only copied semantics or renderer-owned handles; never raw WebGL, credentials, object grants, or Worker internals.

Seek, reconnect, backward time jump, and source replacement atomically advance the epoch and reset stale resources. Error handling preserves actionable diagnostics and cannot leave partially owned resources.

## Consequences

Byte/GPU ownership is measurable and bounded. M1 dogfoods this internal contract before M5 may stabilize a smaller trusted build-time subset. Runtime-loaded untrusted plugins require a separate ADR and threat model.
