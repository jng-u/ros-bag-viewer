# ros-web-viewer

`ros-web-viewer` is the internal working repository name for the ROS data viewing workspace. Public product branding is intentionally undecided.

## Run the browser viewer with Docker

```bash
docker compose up --build
```

Open <http://localhost:8080>. Select **MCAP**, **ROS1 BAG**, or **ROS2 BAG** next to **LOAD DEMO** for immediate PointCloud2, Image, Path, and Raw-inspector samples. Real recordings can be opened as follows:

- MCAP: drop or select one `.mcap` file.
- ROS1: drop or select one `.bag` file. Uncompressed, BZip2, and LZ4 chunk decoders are wired.
- ROS2: drop a rosbag2 folder, use **OPEN ROS2 DIR**, or select/drop `metadata.yaml` together with every referenced `.db3` part. A standalone `.db3` is also accepted with synthesized local metadata.

The first compatible PointCloud2 display is created automatically. Topic discovery, PointCloud2/Path rendering, raw and compressed Image display, bounded hex/ASCII Raw inspection, timeline seeking, source epochs, bounded WebGL2 rendering, and GPU telemetry run in the browser; local recording bytes are not uploaded to the Caddy container. ROS2 CDR transport alignment bytes are accepted only at the valid final 4-byte boundary rather than being interpreted as message fields.

Use another host port when 8080 is occupied:

```bash
ROS_WEB_VIEWER_PORT=8090 docker compose up --build
```

Stop it with `docker compose down`.

Recorded MCAP, ROS1 bag, and ROS2 SQLite paths are wired into this Docker image. Secure live mode still requires a separately deployed authenticated relay/edge runtime and remains disabled in this browser-only container.

For local UI development:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

The development server listens on <http://localhost:4173>.

Use Corepack with the pinned pnpm version. Run `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm check:m0`, `pnpm check:m1`, `pnpm check:m2`, `pnpm check:m3`, `pnpm check:m4`, `pnpm check:m5`, `pnpm test:security`, `pnpm test:a11y`, `pnpm test:ux`, and `pnpm build` before review. Dependency, license, and SBOM gates are available through `pnpm audit:dependencies`, `pnpm report:licenses`, and `pnpm sbom`. Regenerate the deterministic M3 contract record with `pnpm evidence:m3`; a clean tree afterward proves the checked-in evidence matches the current harness. The workspace-private extension boundary is documented in [`docs/extension-api.md`](docs/extension-api.md), and [`docs/release-readiness.md`](docs/release-readiness.md) records the blocked M5 decision and exact `pnpm release:readiness:full` gate.

M0–M5 now cover the contract baseline, bounded recorded sources and displays, a secure-live reference path, hosted reference sharing, the trusted build-time extension subset, protocol/schema v1 conformance, and local release-hardening gates. These results are deliberately repository-static, deterministic, local, in-process, or synthetic evidence: they do not claim real ROS, browser, operating-system, GPU, network, storage, identity, or production execution. M5 remains release-blocked by its recorded compatibility/accessibility exceptions and unauthorized public/external actions. See [`SECURITY.md`](SECURITY.md), [`docs/evidence/m3-live.json`](docs/evidence/m3-live.json), and [`docs/evidence/m5-release-readiness.json`](docs/evidence/m5-release-readiness.json) for the exact boundaries and residual requirements.
