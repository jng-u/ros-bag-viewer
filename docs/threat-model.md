# Browser–relay–edge threat model (M0)

- **Status:** Accepted M0 trust-boundary baseline; not a production certification
- **Gate:** M1 cannot begin until this baseline and the core contracts are reviewed together

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

### Malicious input and schemas

Parsing/decompression run in terminate-able workers under compressed/expanded byte, ratio, nesting, queue, and time budgets. Paths are traversal-free; metadata cannot trigger arbitrary fetches. Sanitized errors leave the app able to open another source.

### Hosted disclosure and revocation

Manifests contain opaque entry IDs and immutable versions, not reusable credentials or long-lived URLs. Grants cover one object/version and bounded range. Revocation blocks new grants immediately; issued grants have a configured measured residual lifetime. Capabilities are high-entropy, expiring, non-enumerable, and absent from logs/durable storage.

### Resource and supply-chain exhaustion

Limit topic count, message size/rate, queue bytes, schema work, decompression, range concurrency, and GPU allocation. Backpressure reports drops/decimation. Pin dependencies, generate SBOM/license/vulnerability evidence, and review build-time extensions as privileged code. Runtime plugins and RViz ABI compatibility are excluded pending a new threat decision.

## Verification matrix

Evidence must cover denied Origins/unauthenticated discovery, arbitrary writes, allowlist bypass, malformed/replayed frames, separate edge identity, failed direct-edge reachability, cross-session object access, grant expiry/revocation, malicious schema packs, traversal, corrupt inputs, decompression bombs, overload/reconnect recovery, and redaction.

Pass means fail-closed behavior, bounded resources, no ROS write reaching the edge, no browser route to edge/ROS, no cross-session disclosure, and sanitized actionable diagnostics.

## Residual and deferred decisions

Authentication provider, relay protocol, storage provider, grant TTL, network implementation, renderer helper, and binary transport remain unselected. Production requires configuration review, penetration testing, dependency evidence, incident/rotation procedures, and authorization for credentials or paid infrastructure.
