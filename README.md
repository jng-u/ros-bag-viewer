# ros-web-viewer

`ros-web-viewer` is the internal working repository name for the ROS data viewing workspace. Public product branding is intentionally undecided.

## Run the browser viewer with Docker

```bash
docker compose up --build
```

Open <http://localhost:8080>. Click **LOAD DEMO** for an immediate PointCloud2/Path sample, or drop an `.mcap` recording into the viewport. Topic discovery, PointCloud2/Path display creation, raw inspection, timeline seeking, source epochs, bounded WebGL2 rendering, and GPU telemetry run in the browser; recording bytes are not uploaded to the Caddy container.

Use another host port when 8080 is occupied:

```bash
ROS_WEB_VIEWER_PORT=8090 docker compose up --build
```

Stop it with `docker compose down`.

This first Docker-runnable vertical slice supports MCAP directly. ROS1 bag and ROS2 SQLite parser contracts remain in the workspace, but their browser codec/SQLite runtimes are not yet wired into this image; selecting those formats produces an explicit capability error rather than pretending they rendered. Secure live mode likewise requires a separately deployed authenticated relay/edge runtime and remains disabled in this browser-only container.

For local UI development:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

The development server listens on <http://localhost:4173>.

Use Corepack with the pinned pnpm version. Run `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm check:m0`, `pnpm check:m1`, `pnpm check:m2`, `pnpm check:m3`, `pnpm check:m4`, `pnpm check:m5`, `pnpm test:security`, `pnpm test:a11y`, `pnpm test:ux`, and `pnpm build` before review. Dependency, license, and SBOM gates are available through `pnpm audit:dependencies`, `pnpm report:licenses`, and `pnpm sbom`. Regenerate the deterministic M3 contract record with `pnpm evidence:m3`; a clean tree afterward proves the checked-in evidence matches the current harness. The workspace-private extension boundary is documented in [`docs/extension-api.md`](docs/extension-api.md), and [`docs/release-readiness.md`](docs/release-readiness.md) records the blocked M5 decision and exact `pnpm release:readiness:full` gate.

M0–M5 now cover the contract baseline, bounded recorded sources and displays, a secure-live reference path, hosted reference sharing, the trusted build-time extension subset, protocol/schema v1 conformance, and local release-hardening gates. These results are deliberately repository-static, deterministic, local, in-process, or synthetic evidence: they do not claim real ROS, browser, operating-system, GPU, network, storage, identity, or production execution. M5 remains release-blocked by its recorded compatibility/accessibility exceptions and unauthorized public/external actions. See [`SECURITY.md`](SECURITY.md), [`docs/evidence/m3-live.json`](docs/evidence/m3-live.json), and [`docs/evidence/m5-release-readiness.json`](docs/evidence/m5-release-readiness.json) for the exact boundaries and residual requirements.
