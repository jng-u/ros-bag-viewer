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
| ROS 2 MCAP | Local `File`/`Blob`; indexed | Topics/types/times, range reads, deterministic seek, schema provenance | Docker Firefox passes the generated full native-display fixture; public dense MCAP hardware evidence remains open |
| ROS 2 MCAP | Local/hosted; unindexed | Explicit sequential/degraded mode, bounded index build and cancellation | Planned; fixture not approved |
| ROS 1 bag | Local recording; isolated ROS 1 lane | Connection schema, supported compression, topic/time inventory | Docker Firefox passes generated uncompressed/LZ4 fixtures and the public 37.8 MiB indexed BZip2 Cartographer bag by pinned SHA-256 |
| ROS 2 SQLite | `metadata.yaml` plus single/multipart `.db3` | Relation validation, ordering, missing-part diagnostics | Docker Firefox passes generated bundles plus the pinned 49.5 MB SEAV navigation bag: 25 topics and synchronized TF/scan/odom/map/marker/plot/raw at an active-SLAM timestamp |
| ROS 1/ROS 2 live | Private generation-specific edge through relay | Read-only subscriptions, schema provenance, reconnect epochs | Docker Noetic and Jazzy bridges bind only `127.0.0.1:8765/8766` and pass actual ROS `/tf` and `/scan` into Firefox; external TLS/network/identity certification remains deployment-specific |
| Hosted recordings | Immutable capability-scoped upload plus ranges | Local/hosted normalized equivalence and authorization failures | Docker share service and Firefox pass create, immutable range-open, synchronized rendering, revoke, and post-revoke HTTP 403; no enterprise catalog or production object-store claim |

Evidence records exact browser build, OS, CPU/GPU, WebGL2 capability, viewport/DPR, input hash, ROS generation/distro, storage version, compression codec, schema provider, source mode, and cold/warm/cache state. Current stable Chromium and Firefox on Windows, macOS, and Ubuntu are candidates, not support claims.

The named benchmark profile is **M0-LAPTOP-2026-01**: x86-64, at least four physical CPU cores, 16 GiB RAM, a WebGL2-capable integrated GPU, Ubuntu 24.04, plugged-in balanced power mode, stable Chromium, 1440×900 CSS pixels at DPR 1, fresh profile, and default compact quality. Every result replaces the minimum profile with exact make/model, CPU/GPU/driver, RAM, kernel, browser build/flags, power/thermal state, viewport/DPR, and source hash; a result without those fields is invalid evidence.

ROS 1 evidence must include the exact isolated container/VM digest, host requirements, known residual risk, last verified date, and retirement trigger. Retire a tier if its pinned environment cannot be reproduced, has an unmitigated critical vulnerability, or cannot run on supported hosts.

## Verified generation-specific bridge environment

Last verified: **2026-09-02** on Linux Docker Engine with host networking and headless Firefox 154.

| Lane | Pinned base | Built image evidence | Host requirements | Residual risk / retirement trigger |
|---|---|---|---|---|
| ROS1 Noetic | `ros:noetic-ros-core-focal@sha256:fd6279f04e51fa61201a791da9a156129941887b95b614ae0cec7865ef49de4f` | `sha256:155a8d8355df9dcf1394efc6190852269fc096791443e2773ebfb7e6b4a082e7` | Linux host networking; reachable ROS master; allowlisted topics | Ubuntu Focal/Noetic is legacy. Retire if the pinned image no longer rebuilds, cannot be vulnerability-mitigated, or supported hosts lose host-network compatibility. |
| ROS2 Jazzy | `ros:jazzy-ros-core@sha256:fb9a5620bb92e133047c62555e307a2a481bde384c70595ceae464bc84e51df1` | `sha256:c4d71245967011bd9a3b527176af9e3635bc9b050c64d7b2cd4bb0bae8acb3cd` | Linux host networking; DDS domain reachability; UDPv4 Fast DDS | DDS discovery and QoS remain robot-network specific. Retire or repin on unsupported Jazzy/base image, critical vulnerability, or middleware incompatibility. |

These image IDs identify the locally verified builds, not a public registry guarantee. A rebuild after dependency repository changes must record a new ID and rerun both live browser gates.

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

## G005 M4 hosted-sharing reference amendment

M4 admits hosted sharing only at the local/reference evidence tier. A passing gate must verify the signed manifest before reads; immutable size/version/hash relations; incremental cancellable object/version/range-granted reads; and local/hosted equivalence for normalized topic, schema, ordering, and timeline results. Negative coverage includes malformed or tampered manifests, enumeration, unauthorized and expired capabilities, cross-session/object/version/range access, immediate new-grant denial after revocation, bounded residual issued-grant lifetime, deletion, deterministic retention sweep, and redacted bounded telemetry.

This does not promote a public hostname, production object store, network stack, browser matrix, authentication provider, durable deletion guarantee, or cost/performance claim. Those require exact deployed environment evidence and the normal compatibility-promotion fields.
