# Trusted build-time display extensions

The workspace-private `@ros-web-viewer/extension-api` package exposes version 1 of the reviewed display lifecycle to statically imported packages. Registration is exact-version and fail-closed. The host grants only requested capabilities from this closed set:

- bounded, source-detached normalized message snapshots;
- bounded opaque resource handles; and
- bounded structured diagnostics.

Extensions follow `register -> instantiate -> configure -> attachSource -> update -> render`, with explicit `suspend`, `handleError`, and idempotent `dispose`. A source epoch must advance monotonically. Advancing it disposes all handles from the prior epoch, and stale messages are rejected before an extension callback runs. Each accepted message value is copied under a host-owned byte ceiling (8 MiB by default) before the callback, so retained semantic data cannot alias source-owned storage. Callback failures enter the error state and revoke all handles.

The host surface does not expose WebGL contexts, Worker internals, storage or hosted grants, relay or edge credentials, ROS publish/service/action/parameter/raw-command operations, module loaders, dynamic import, or evaluation functions. Descriptor and lifecycle objects reject extra operations, capability negotiation is immutable, and handles and diagnostics have host-owned ceilings.

This is an API boundary, **not a security sandbox**. Extension packages are reviewed, trusted, build-time dependencies and run with the ambient authority of the application bundle. Definitions must be created with `defineTrustedExtension` and lifecycles with `defineTrustedLifecycle`; these builders create branded host-owned records before the registry enumerates them. Admission registries are module-private and intentionally valid only for the same JavaScript realm **and the same loaded API module instance**. Duplicate package copies do not share brands, preventing a global symbol or mutable registry from becoming a forgery surface. This is not a portable Proxy detector or a cross-realm/plugin authentication mechanism. Untrusted protocol frames and hosted manifests enter through bounded serialized JSON text and are parsed into host-owned records before canonicalization. Arbitrary caller objects, cross-realm definitions, untrusted Proxies, and remotely supplied code are unsupported.

Repository dependency and source review uses a positive default-deny grammar: exactly named extension-API imports, one exported `defineTrustedExtension` result, locally bound identifiers, and a small reviewed standard-library surface. Network, DOM, Worker, storage, reflection, descriptor, constructor, dynamic-code, and ambient-global access are rejected.

`examples/range-summary-extension` is the out-of-core conformance example. It remains a private workspace package, depends only on the extension API, and allocates only a bounded text-buffer handle.
