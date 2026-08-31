# Compatibility baseline (M0)

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
| ROS 1 bag | Local recording; isolated ROS 1 lane | Connection schema, supported compression, topic/time inventory | Licensed compressed SLAM bag admitted; adapter execution deferred |
| ROS 2 SQLite | `metadata.yaml` plus single/multipart `.db3` | Relation validation, ordering, missing-part diagnostics | Humble single-file fixture admitted; multipart evidence deferred to M2 |
| ROS 1/ROS 2 live | Private generation-specific edge through relay | Read-only subscriptions, schema provenance, reconnect epochs | Deferred to M3 |
| Hosted recordings | Immutable manifest plus granted ranges | Local/hosted normalized equivalence and authorization failures | Contract only; deferred to M4 |

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
