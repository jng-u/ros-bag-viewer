# Compatibility baseline (M0, amended by G003 M2 evidence)

**Status:** target matrix and evidence contract. A row becomes supported only after its pinned fixture and environment evidence pass.

## Compatibility tiers

| Tier | Definition | User-visible behavior |
|---|---|---|
| `native-display` | Validated schema and a first-party semantic display exist. | Native display choices plus generic inspection. |
| `schema-backed-generic` | Validated schema exists but no native display exists. | Tree/table inspection and numeric-leaf plotting. |
| `opaque-inspectable` | Schema is absent or cannot be safely resolved. | Metadata, bounded byte preview, provenance, and schema-pack guidance. |
| `unsupported` | Storage, compression, encoding, version, or limits cannot be handled. | Fail-closed diagnostic naming the unsupported dimension. |

## M0 target matrix

| Source | Form | Required evidence | M0 status |
|---|---|---|---|
| ROS 2 MCAP | Local `File`/`Blob`; indexed | Topics/types/times, range reads, deterministic seek, schema provenance | Format fixture admitted; ROS 2 SLAM/render evidence deferred to M1 |
| ROS 2 MCAP | Local/hosted; unindexed | Explicit sequential/degraded mode, bounded index build and cancellation | Planned; fixture not approved |
| ROS 1 bag | Local recording; isolated ROS 1 lane | Connection schema, supported compression, topic/time inventory | M2 deterministic synthetic local/granted-range adapter gate passes; public corpus/browser support is not yet promoted |
| ROS 2 SQLite | `metadata.yaml` plus single/multipart `.db3` | Relation validation, ordering, missing-part diagnostics | M2 deterministic synthetic single/multipart local/granted-range gate passes; production browser SQLite provider and public corpus support are not yet promoted |
| ROS 1/ROS 2 live | Private generation-specific edge through relay | Read-only subscriptions, schema provenance, reconnect epochs | M3 deterministic local synthetic contract gate passes for both generations; real ROS/network/browser environments are not promoted |
| Hosted recordings | Immutable manifest plus granted ranges | Local/hosted normalized equivalence and authorization failures | M2 immutable granted-range equivalence harness passes; production authorization, revocation, storage, and sharing remain M4 |

Evidence records exact browser build, OS, CPU/GPU, WebGL2 capability, viewport/DPR, input hash, ROS generation/distro, storage version, compression codec, schema provider, source mode, and cold/warm/cache state. Current stable Chromium and Firefox on Windows, macOS, and Ubuntu are candidates, not support claims.

The named benchmark profile is **M0-LAPTOP-2026-01**: x86-64, at least four physical CPU cores, 16 GiB RAM, a WebGL2-capable integrated GPU, Ubuntu 24.04, plugged-in balanced power mode, stable Chromium, 1440×900 CSS pixels at DPR 1, fresh profile, and default compact quality. Every result replaces the minimum profile with exact make/model, CPU/GPU/driver, RAM, kernel, browser build/flags, power/thermal state, viewport/DPR, and source hash; a result without those fields is invalid evidence.

ROS 1 evidence must include the exact isolated container/VM digest, host requirements, known residual risk, last verified date, and retirement trigger. Retire a tier if its pinned environment cannot be reproduced, has an unmitigated critical vulnerability, or cannot run on supported hosts.

## Degraded and unsupported rules

- Unindexed input never advertises indexed random seek.
- Unknown compression/storage/version never falls through to a misleading parse error.
- Missing schema never produces guessed field values.
- Missing multipart members name the expected relation and offending entry.
- Hosted servers without correct byte-range semantics use an explicitly bounded fallback or fail actionably.
- WebGPU experimentation cannot substitute for the WebGL2 correctness baseline.

## Evidence required to promote a row

1. Corpus entry with authoritative URL or recipe, license, redistribution decision, SHA-256, size, and inventory.
2. Deterministic source-relation, schema, time-ordering, and failure results.
3. Local/hosted equivalence where applicable.
4. Exact environment/dependency versions and raw command output.
5. Owner, review date, and explicit supported/degraded/unsupported decision.

See [corpus-manifest.md](corpus-manifest.md).

## G003 M2 recorded-source evidence amendment

The M2 gate adds generated ROS 1 bag and ROS 2 SQLite multipart fixtures. It compares local `Blob`/directory reads with immutable HTTP-like granted ranges and requires identical topic, schema, time, message, generic-inspector, and numeric-plot summaries. It also locks deterministic multipart ordering, bounded range/query telemetry, repeated epoch invalidation, explicit TF missing/extrapolation/stale-epoch results, all native display registrations, opaque byte-only inspection, and actionable unsupported storage/compression/codec diagnostics.

This is **synthetic contract evidence**, not a claim that a public recording, browser/OS matrix, production object store, authorization service, compressed ROS 1 decoder, or production browser SQLite VFS has passed. Those rows remain unpromoted until the evidence requirements above are satisfied. The machine-readable scope and gate record is [evidence/m2-recorded-source.json](evidence/m2-recorded-source.json).

## G004 M3 secure-live evidence amendment

The M3 gate composes the strict browser protocol, authenticated relay, private edge runtime, and bounded browser live-source contract in a deterministic in-process harness. Negative cases cover invalid Origin/session/browser credential, invalid relay identity, expiry, replay, unknown or write-shaped operations, wildcard/topic/type escalation, message/frame sizes, request/subscription quotas, and public/browser-shaped direct-edge identities. Both ROS1 and ROS2 profiles run 500 synthetic iterations with point-cloud-like and image-like payloads, bounded edge and relay queues, visible drops/backpressure, bounded redacted telemetry, deterministic same-clock latency samples, and reconnect epochs `[1, 2]`.

This evidence promotes only the **local synthetic contract gate**, not ROS distribution, middleware, browser, operating system, public relay, container, firewall, TLS, identity-provider, or production deployment compatibility. The 2 ms latency value is a harness constant and must not appear as a hardware or network performance claim. Promotion requires the normal evidence fields plus real generation-specific ROS environments and exact network/browser execution records. See [evidence/m3-live.json](evidence/m3-live.json).
