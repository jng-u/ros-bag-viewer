# M5 release-readiness gate

**Current decision:** **blocked**. This repository has not been authorized for public naming, license selection, publication, credentials, paid infrastructure, external deployment, or production deployment.

**GitHub Pages scope update:** the maintainer has now explicitly requested source publication to `jng-u/ros-bag-viewer` and preparation of its static Pages site; see [the scoped deployment record](github-pages.md). The M5 evidence below is the earlier production-readiness record, not a prohibition on that specific request or a certification of the Pages deployment. License selection, package publication, credentials, paid infrastructure, and production certification remain outside that request.

The machine-readable source of truth is [`docs/evidence/m5-release-readiness.json`](evidence/m5-release-readiness.json). It maps AC-01 through AC-17 to exact commands and artifacts, records evidence class and limitations, and makes missing evidence release-blocking rather than silently treating it as a pass.

## Evidence boundary

Repository gates plus the corrective evidence now prove repository-static contracts, deterministic fixtures, a local Docker/Firefox run, a licensed pinned public ROS1 bag, an operator-downloaded non-redistributed SHA-pinned ROS2 navigation bag, and local Noetic/Jazzy bridge traffic. This still does **not** certify:

- the required Firefox/Chromium matrix across Windows, macOS, and Ubuntu;
- production GPU/driver behavior, browser heap, accessibility tree, screen reader, or reviewed pixel output;
- a physical robot network or the full ROS distribution/middleware matrix beyond the locally measured Noetic/Jazzy containers;
- deployed TLS, firewall, identity, relay, edge, object storage, retention, or deletion behavior;
- production performance, security, availability, cost, or supply-chain operations.

Every promoted compatibility result must record the exact browser/OS/CPU/GPU/driver, power state, viewport/DPR/zoom, source hash, cache state, dependency versions, ROS/storage/compression dimensions, timestamp, raw command output, and owning decision. A local or synthetic pass cannot be relabeled as that evidence.

## Blocking decisions

| Criterion | Decision | Owner | Concrete expiry | Required closure evidence |
|---|---|---|---|---|
| AC-15 | Release-blocking exception `EX-M5-AC15-COMPATIBILITY` | `release-compatibility-owner` | 2026-09-30 | Exact passing browser/OS/ROS/storage/compression executions for each promoted row |
| AC-16 | Release-blocking exception `EX-M5-AC16-ACCESSIBILITY` | `release-accessibility-owner` | 2026-09-30 | Reviewed exact-browser automated and manual evidence for keyboard, focus, labels, contrast, 200% zoom, reduced motion, announcements, and primary-flow visuals |
| AC-17 | Unauthorized; no exception or waiver | Human authorization required | Not applicable | Explicit human record before any public or external action |

An expiry does not convert an exception into approval. An expired or unresolved exception keeps the release blocked.

## Recovery gate

The local suites cover bounded parser/source failures, relay/edge reconnect with epoch invalidation, hosted expiry/revocation/deletion, cancellation, and resource disposal. WebGL context-loss recovery lacks an exact real-browser execution and remains a release blocker. Recovery must preserve the selected source when safe, invalidate stale epoch-owned work, release renderer/Worker resources, keep diagnostics bounded and non-secret, and never reload or reconnect into a broader capability.

## Accessibility gate

The shell tests lock semantic region structure, keyboard order, focus-restoration behavior, accessible names/states, error-announcement copy, reduced-motion metadata, and fixed viewport/DPR/zoom evidence. Those assertions are necessary but not sufficient. AC-16 remains blocked until reviewed evidence includes a real accessibility tree, keyboard-only execution, visible focus, screen-reader announcements, contrast, 200% zoom, reduced-motion behavior, and deterministic visual/interaction evidence for every primary and error state.

## Security and supply-chain gate

The release lane requires the adversarial M3/M4 suites, frozen install, high-severity dependency audit, complete dependency-license inventory, and CycloneDX SBOM generation. Generated files are evidence outputs, not a public license selection. There is intentionally no repository `LICENSE`, publication configuration, credential, paid-infrastructure configuration, or deployment action.

## Deterministic benchmark and exact-tree gate

The M1 benchmark is a deterministic operation-cost and logical-allocation model. It is not a browser or production-hardware result. Reproduce it and the repository gates with:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm test:integration
corepack pnpm test:e2e
corepack pnpm check:m0
corepack pnpm check:m1
corepack pnpm check:m2
corepack pnpm check:m3
corepack pnpm check:m4
corepack pnpm check:m5
corepack pnpm test:security
corepack pnpm test:a11y
corepack pnpm test:ux
corepack pnpm test:toolchain
corepack pnpm exec vitest run packages/render-core/test/index.test.ts packages/source-live/test/index.test.ts packages/source-hosted/test/index.test.ts tests/m4-hosted/lifecycle.test.ts
corepack pnpm release:readiness
corepack pnpm evidence:semantic
corepack pnpm evidence:m3
corepack pnpm build
node benchmarks/scenarios/run-m1-dimensional.mjs --check
corepack pnpm exec vitest run --config benchmarks/scenarios/vitest.config.ts
corepack pnpm audit:dependencies
corepack pnpm report:licenses
corepack pnpm sbom
corepack pnpm release:readiness:full
```

The final command checks the benchmark artifact, generates the license inventory and SBOM twice to prove deterministic bytes, and fails on a dirty tree. Run this sequence on the exact clean commit; missing, skipped, dirty, or unavailable evidence blocks release. `corepack pnpm check:m5` is the focused extension, frozen-protocol, and release-readiness test gate.
