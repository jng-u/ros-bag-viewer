# Trusted build-time display extensions

The workspace-private `@ros-web-viewer/extension-api` package exposes version 1 of the reviewed display lifecycle to statically imported packages. Registration is exact-version and fail-closed. The host grants only requested capabilities from this closed set:

- transient normalized source messages;
- bounded opaque resource handles; and
- bounded structured diagnostics.

Extensions follow `register -> instantiate -> configure -> attachSource -> update -> render`, with explicit `suspend`, `handleError`, and idempotent `dispose`. A source epoch must advance monotonically. Advancing it disposes all handles from the prior epoch, and stale messages are rejected before an extension callback runs. Callback failures enter the error state and revoke all handles.

The host surface does not expose WebGL contexts, Worker internals, storage or hosted grants, relay or edge credentials, ROS publish/service/action/parameter/raw-command operations, module loaders, dynamic import, or evaluation functions. Descriptor and lifecycle objects reject extra operations, capability negotiation is immutable, and handles and diagnostics have host-owned ceilings.

This is an API boundary, **not a security sandbox**. Extension packages are reviewed, trusted, build-time dependencies and run with the ambient authority of the application bundle. Repository dependency and source review must therefore reject privileged internal imports, runtime-loaded code, `eval`, and `new Function`. Untrusted or remotely supplied code is unsupported.

`examples/range-summary-extension` is the out-of-core conformance example. It remains a private workspace package, depends only on the extension API, and allocates only a bounded text-buffer handle.
