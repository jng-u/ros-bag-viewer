# ros-web-viewer

`ros-web-viewer` is the internal working repository name for the ROS data viewing workspace. Public product branding is intentionally undecided.

Use Corepack with the pinned pnpm version. Run `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm check:m0`, `pnpm test:security`, `pnpm test:a11y`, `pnpm test:ux`, and `pnpm build` before review. Dependency, license, and SBOM gates are available through `pnpm audit:dependencies`, `pnpm report:licenses`, and `pnpm sbom`.

M0 establishes repository, contract, documentation, and desktop UX baselines only. Integration, end-to-end, microbenchmark, and corpus-benchmark commands remain explicit M1 deferrals rather than simulated runtime evidence.
