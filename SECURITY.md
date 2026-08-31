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
