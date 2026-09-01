# Browser–relay–edge threat model (M0, amended by G004 M3 contract evidence)

- **Status:** Accepted M0 trust-boundary baseline; not a production certification
- **Gate:** M1 cannot begin until this baseline and the core contracts are reviewed together
- **External audit record:** approved parent-workspace Architect and Critic iteration-2 reviews under `.omx/plans/reviews/`; those leader-owned artifacts are intentionally outside this isolated Git repository

## Assets and objectives

Protect recording bytes, hosted objects, session capabilities, relay/edge credentials, ROS reachability, topic metadata, schema integrity, browser availability, and the guarantee that browsers cannot publish, call services/actions, or send arbitrary bridge commands.

## Trust boundaries

| Boundary | Trust posture | Required controls |
|---|---|---|
| Browser | Untrusted client | No durable secrets; bounded parsing/render work |
| Local/hosted bytes | Untrusted content | Type, size, range, hash, parser, and decompression bounds |
| Schema packs | Untrusted data | No code; size/depth/field/type bounds; provenance/conflicts |
| Public relay | Internet policy point | TLS, session auth, Origin validation, quotas, backpressure, allowlisted operations |
| Object store | Private immutable bytes | Short-lived object/version/range grants; no list capability |
| Private edge | Trusted narrow adapter | Separate identity; relay-generated subscribe plans only; private network |
| ROS graph | Operational private network | No public route; read-only allowlist; deny writes before edge |
| Build-time extensions | Trusted dependencies, not sandboxed | Pin/review; scoped API; no credentials/raw WebGL/Workers |

## Principal threats and controls

### Command escalation

The relay validates session and Origin before discovery. Browsers submit constrained subscription intent; the server constructs bridge commands. Unknown operations, wildcard escalation, publish, service, action, parameter mutation, and arbitrary frames fail closed before the edge.

### Identity collapse, replay, and cross-session access

Browser credentials are never valid at the edge. Relay-edge identity is separate, mutually authenticated, narrowly scoped, and independently rotated. Plans bind session, allowlist, limits, nonce, and expiry. Replays, expired plans, wrong-session tokens, and cross-session range requests fail closed.

### Direct edge/ROS exposure

Edge and ROS networks have no public/browser route. Network tests prove only the relay reaches the edge. Responses avoid unnecessary private addresses or ROS topology.

The deterministic M3 reference adapters prove protocol identity separation in process. The bundled real ROS bridges additionally refuse non-loopback binds; Docker host inspection on 2026-09-02 showed the viewer on `127.0.0.1:8080` and bridges only on `127.0.0.1:8765/8766`. Caddy has no bridge proxy route. Remote use therefore requires an operator-owned TLS proxy colocated with the ROS host; firewall, routing, DNS, certificate, and public reachability certification remain deployment-specific.

### Malicious input and schemas

Parsing/decompression run in terminate-able workers under compressed/expanded byte, ratio, nesting, queue, and time budgets. Paths are traversal-free; metadata cannot trigger arbitrary fetches. Sanitized errors leave the app able to open another source.

### Hosted disclosure and revocation

Signed manifests contain opaque entry IDs, immutable versions, sizes, hashes, and relations, not reusable credentials or long-lived URLs. Signature, version, and hash tampering fail before reads. Grants cover one session/object/version and bounded range. Revocation blocks new grants immediately; issued grants have a configured measured residual lifetime. Capabilities are high-entropy, expiring, non-enumerable, and absent from logs/durable storage. Deletion and retention expiry deny both manifest resolution and subsequent grant issuance.

### Resource and supply-chain exhaustion

Limit topic count, message size/rate, queue bytes, schema work, decompression, range concurrency, and GPU allocation. Backpressure reports transport drops, while over-budget geometry is rejected explicitly rather than sampled. Pin dependencies, generate SBOM/license/vulnerability evidence, and review build-time extensions as privileged code. Runtime plugins and RViz ABI compatibility are excluded pending a new threat decision.

## Verification matrix

Evidence must cover denied Origins/unauthenticated discovery, arbitrary writes, allowlist bypass, malformed/replayed frames, separate edge identity, failed direct-edge reachability, capability enumeration, tampered manifests, cross-session/object/version/range access, grant expiry/revocation and residual lifetime, deletion/retention sweep, malicious schema packs, traversal, corrupt inputs, decompression bombs, overload/reconnect recovery, and token/object/payload redaction.

Pass means fail-closed behavior, bounded resources, no ROS write reaching the edge, no browser route to edge/ROS, no cross-session disclosure, and sanitized actionable diagnostics.

## Residual and deferred decisions

M3 selects a versioned subscribe-only contract and local reference relay/edge behavior for deterministic validation. M4 selects only local/in-memory hosted capability, signed-manifest, short-lived exact-range grant, revocation, deletion, retention, and redacted telemetry behavior. Authentication and storage providers, network and TLS implementation, relay hosting, edge deployment, credential rotation, production grant lifetime, renderer helper, and binary transport remain unselected. The machine-readable M3/M4 evidence is synthetic unless it explicitly records otherwise. Production requires configuration review, deployed network/storage-isolation and retention evidence, penetration testing, dependency evidence, incident/rotation procedures, and authorization for credentials or infrastructure.
