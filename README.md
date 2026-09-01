# ros-web-viewer

`ros-web-viewer` is the internal working repository name for the ROS data viewing workspace. Public product branding is intentionally undecided.

## Run the browser viewer with Docker

```bash
docker compose up --build
```

Open <http://localhost:8080>. Select **MCAP**, **ROS1 BAG**, or **ROS2 BAG** next to **DEMO**. Each deterministic demo contains eleven synchronized topics. Ten native drawables open together—PointCloud2, Path, TF, LaserScan, Odometry, OccupancyGrid, Marker, Image, CameraInfo, and a numeric plot—and the custom `demo_msgs/Status` topic proves schema-backed raw inspection and selectable numeric-field plots. Real recordings can be opened as follows:

- MCAP: drop or select one `.mcap` file.
- ROS1: drop or select one `.bag` file. Uncompressed, BZip2, and LZ4 chunk decoders are wired.
- ROS2: drop a rosbag2 folder, use **OPEN ROS2 DIR**, or select/drop `metadata.yaml` together with every referenced `.db3` part. A standalone `.db3` is also accepted with synthesized local metadata.

The viewer is canvas-first and keeps multiple named drawables in one WebGL2 scene. Drag to orbit, Shift-drag to pan, use the wheel to zoom, or choose Fit/Orbit/Top/Front. Every visible layer updates at the same requested timeline time using the latest message at or before that time, with a first-message fallback only before a topic begins. TF/TF2 header timestamps drive bounded historical lookup; dynamic transforms require bracketing samples and static transforms remain valid across time. Missing, disconnected, cyclic, or out-of-horizon transforms are shown as layer errors instead of silently using the latest transform. PointCloud2 is never silently sampled: a message inside the configured one-million-point/16 MiB boundary is converted and rendered in full, while an over-budget message becomes an explicit layer error. Path, scan, marker, and map geometry follow the same reject-instead-of-sample rule. The inspector exposes the exact message timestamp and input/rendered/dropped counts; **FULL DATA** is shown only when no invalid vertex was dropped. Image, CameraInfo, numeric plots, schema-backed message trees, and bounded hex/ASCII inspection remain visible as compact auxiliary windows beside the 3D scene. For a custom schema, open **RAW** and choose any bounded numeric field using its **PLOT** action.

All recording open/seek/message parsing runs behind a dedicated recording Worker, and semantic/schema-backed message decoding runs in a separate resettable decoder Worker. PointCloud2-to-render-buffer and raw-image-to-RGBA conversion also occur in that decoder Worker and return transferable buffers; the UI thread only uploads the prepared result. ROS1 BZip2/LZ4 processing remains inside the off-main boundary. ROS2 SQLite imports each selected database into SQLite WASM's OPFS SAH pool in 8 MiB pulls and opens it read-only through that VFS; the product path does not deserialize a whole `.db3` into a JavaScript/WASM byte array. Indexed MCAP remains range-read and remote indexed MCAP never materializes the complete object.

Use **URL** for an indexed remote MCAP served through immutable HTTP byte ranges. The full object is not materialized, unindexed remote MCAP is refused, and an optional `#capability=…` fragment is converted to a bearer header. See [`docs/hosted-range-source.md`](docs/hosted-range-source.md).

Use **LIVE** to configure an authenticated `wss://` subscribe-only relay. The repository now includes separately isolated ROS1 Noetic and ROS2 Jazzy bridge images as opt-in Compose profiles. Their exact launch commands, allowlists, token expiry/revocation behavior, and Firefox verification are documented in [`docs/live-bridge-deployment.md`](docs/live-bridge-deployment.md); the wire profile is in [`docs/live-relay-websocket-v1.md`](docs/live-relay-websocket-v1.md). The browser and bridges expose no ROS write, service, action, parameter, wildcard, or arbitrary-command operation.

Use another host port when 8080 is occupied:

```bash
ROS_WEB_VIEWER_PORT=8090 docker compose up --build
```

Stop it with `docker compose down`.

Recorded MCAP, ROS1 bag, ROS2 SQLite, indexed hosted MCAP ranges, an expiring/revocable share service, and generation-specific ROS live bridges are wired into the Docker deployment. External production still requires operator-owned TLS, credentials, network policy, and deployment authorization.

Share creation is fail-closed by default. Configure `SHARE_CREATE_TOKEN` on Compose and enter the same token in the Share dialog. Anonymous creation is available only as an explicit loopback development override (`SHARE_ALLOW_ANONYMOUS_CREATE=true`); never enable it on a remotely reachable bind.

For local UI development:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

The development server listens on <http://localhost:4173>.

Use Corepack with the pinned pnpm version. Run `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm check:m0`, `pnpm check:m1`, `pnpm check:m2`, `pnpm check:m3`, `pnpm check:m4`, `pnpm check:m5`, `pnpm test:security`, `pnpm test:a11y`, `pnpm test:ux`, and `pnpm build` before review. Dependency, license, and SBOM gates are available through `pnpm audit:dependencies`, `pnpm report:licenses`, and `pnpm sbom`. Regenerate the deterministic M3 contract record with `pnpm evidence:m3`; a clean tree afterward proves the checked-in evidence matches the current harness. The workspace-private extension boundary is documented in [`docs/extension-api.md`](docs/extension-api.md), and [`docs/release-readiness.md`](docs/release-readiness.md) records the blocked M5 decision and exact `pnpm release:readiness:full` gate.

M0–M5 cover the contract baseline, bounded recorded sources and displays, secure-live boundaries, hosted sharing, the trusted build-time extension subset, protocol/schema v1 conformance, and release-hardening gates. The corrective rebuild additionally runs real headless Firefox against Docker for local MCAP, ROS1 bag, ROS2 SQLite, hosted share creation/open/revocation, a public compressed Cartographer ROS1 bag, a non-redistributed SHA-pinned public ROS2 navigation bag, and actual Noetic/Jazzy `/tf` plus `/scan` bridge traffic. This is local deployment evidence, not certification of a particular robot network, public hostname, identity provider, or production storage service.
