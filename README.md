# ros-web-viewer

`ros-web-viewer` is the internal working repository name for the ROS data viewing workspace. Public product branding is intentionally undecided.

Use Corepack with the pinned pnpm version. Run `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm check:m0`, `pnpm check:m1`, `pnpm check:m2`, `pnpm check:m3`, `pnpm test:security`, `pnpm test:a11y`, `pnpm test:ux`, and `pnpm build` before review. Dependency, license, and SBOM gates are available through `pnpm audit:dependencies`, `pnpm report:licenses`, and `pnpm sbom`. Regenerate the deterministic M3 contract record with `pnpm evidence:m3`; a clean tree afterward proves the checked-in evidence matches the current harness.

M0–M3 now cover the contract baseline, bounded recorded sources and displays, and a secure-live reference path. The M3 result is deliberately local, in-process synthetic evidence: it does not claim real ROS, browser, container, TLS, firewall, public-network, or production-authentication execution. See [`SECURITY.md`](SECURITY.md) and [`docs/evidence/m3-live.json`](docs/evidence/m3-live.json) for the exact boundary and residual requirements.
