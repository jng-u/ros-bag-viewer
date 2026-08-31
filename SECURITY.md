# Security

Report suspected vulnerabilities privately to the project maintainers. Do not include credentials or sensitive telemetry in issues.

## Secure-live M3 contract

The M3 reference path is read-only by construction:

- browser operations are limited to authenticated discovery, explicit subscribe/unsubscribe, and redacted health;
- browser credentials are Origin- and session-bound and are never accepted by the private edge;
- relay-to-edge identity is distinct, and edge plans bind exact topic/type limits, allowlist digest, connection, sequence, nonce, and expiry;
- ROS1 and ROS2 use separate private/loopback TLS reference adapters; ROS1 additionally requires the checked-in non-root, read-only, no-browser isolation profile;
- no browser, relay, or edge API exposes ROS publish, service, action, parameter mutation, or arbitrary command operations;
- message size/rate, subscription count, request budgets, queues, buffered bytes, and telemetry histories are bounded and report drops without credentials, session IDs, private addresses, or topic names.

The checked-in [M3 evidence](docs/evidence/m3-live.json) is deterministic in-process synthetic contract evidence only. It did **not** exercise real sockets, firewall rules, TLS handshakes, containers, browsers, ROS graphs, production authentication, or public-network reachability. It is not a production security certification. A production deployment still requires environment-specific network-isolation tests, secret and identity lifecycle review, penetration testing, dependency review, incident procedures, and explicit operational approval.

Treat any configuration that binds an edge listener publicly, disables TLS, admits browser credentials at the edge, adds write-capable operations, weakens exact topic/type limits, or removes the ROS1 isolation profile as a security boundary change requiring a new threat-model decision and evidence gate.

## Hosted-sharing M4 reference contract

The M4 reference path keeps hosted recordings private and read-only. Uploads produce immutable object versions and hashes; a signed `SourceBundle` manifest is verified before any adapter reads. Browser sessions use opaque, high-entropy, expiring capabilities. The service issues only short-lived grants bound to one session, object, immutable version, and byte range; it offers no listing operation or reusable storage credential.

Revocation denies new grants immediately. A grant already issued before revocation can remain usable only for its configured short residual lifetime. Explicit deletion and deterministic retention sweeps deny later manifest and range access. Authorization failures are indistinguishable at the public capability boundary, and audit/cost telemetry is bounded and redacted: it contains aggregate counts and bytes, never raw capabilities, grant values, object keys, payloads, or durable URLs.

The checked-in M4 implementation and evidence are a local/in-memory reference contract unless an evidence artifact explicitly records real networking or object storage. They do not certify a production host, identity provider, storage provider, TLS boundary, browser matrix, incident process, or deletion guarantee. Promotion requires deployed isolation and retention evidence, secret lifecycle review, penetration testing, operational monitoring, and explicit authorization for credentials or infrastructure.
