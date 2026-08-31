# M1 Dimensional Benchmark and Semantic Verification

**Evidence status:** deterministic dimensional and operation-cost model only  
**Production browser/hardware status:** **not measured**  
**Decision use:** proves bounded operations, accounting formulas, deterministic semantic scenes, and the minimum WebGL2 integration shape. It does not validate candidate latency or memory targets.

## Reproduce the checked-in artifact

```sh
corepack pnpm build
node benchmarks/scenarios/run-m1-dimensional.mjs
node benchmarks/scenarios/run-m1-dimensional.mjs --check
corepack pnpm exec vitest run --config benchmarks/scenarios/vitest.config.ts
```

The generator owns the raw artifact at [`benchmarks/artifacts/m1-dimensional-model.json`](../benchmarks/artifacts/m1-dimensional-model.json). The `--check` form fails when the artifact and generator disagree. The artifact labels `productionHardwareResult` and `browserBenchmarkResult` as `false`; its numbers are deterministic cost-model results and renderer-owned logical byte estimates, not observed browser timing or total GPU memory.

## Fixed scenario

The machine-readable contract is [`m1-dimensional.config.json`](../benchmarks/scenarios/m1-dimensional.config.json).

| Dimension | Fixed value |
|---|---:|
| Corpus | `generated-m1-dimensional-range-v1`, immutable synthetic range source |
| Source size | 8,388,608 bytes |
| Index modes | indexed target-chunk seek; unindexed sequential degraded scan |
| Machine/browser | `M0-LAPTOP-2026-01` / stable Chromium **candidate profiles, not executed** |
| Viewport / DPR / zoom | 1440×900 CSS px / 1 / 100% |
| Cache | cold model |
| PointCloud2 | 120,000 input points at 10 Hz; 60,000 rendered cap |
| Path | 2,000 poses at 5 Hz; 2,000 rendered cap |
| Topic rates | PointCloud2 10 Hz; Path 5 Hz |
| Active displays | 2 |
| Queue capacity | 4 |
| Warmup / repetitions | 10 / 60 modeled frames |
| Statistics | nearest-rank p50, p95, p99 plus maximum |

This generated corpus has no full recording allocation: the synthetic range source exposes only immutable size metadata and allocates each requested range independently. It is the fixed CI/model corpus, not a substitute for the deferred licensed medium dense-render hardware corpus in `corpus-manifest.json`.

## Source and seek evidence

Indexed seek and unindexed scan are separate operations, not mixed into one number.

| Operation | Reads | Completed bytes | Peak in-flight bytes | Modeled time | Bounded proof |
|---|---:|---:|---:|---:|---|
| Indexed target-chunk seek | 4 | 70,720 | 65,536 | 0.695 ms | every request ≤262,144 B; completed bytes < source |
| Unindexed sequential degraded scan | 32 | 8,388,608 | 262,144 | 47.004 ms | whole source is scanned over bounded ranges; no request equals source size |

The unindexed result is deliberately labeled degraded. Reading the complete logical source sequentially is not the same as allocating it: the peak in-flight range remains 1/32 of source size. The raw indexed requests and first/last unindexed requests are recorded in the artifact.

## First content, frame distribution, and long tasks

The thin WebGL2 model reports:

- first content: **9.935 ms modeled** (indexed read cost + point decode cost + first modeled frame);
- p50 / p95 / p99 frame time: **4.482 / 4.764 / 4.764 ms modeled**;
- maximum modeled frame time: **4.764 ms**;
- long-task threshold: 50 ms; modeled long-task count: **0 / 60**;
- queue capacity / modeled maximum depth / modeled drops: **4 / 1 / 0 per second**.

These values are not evidence that a real Chromium session meets the candidate p95 or first-content targets. The raw 60-sample arrays exist to verify percentile arithmetic without unstable wall-clock input.

## Semantic scene gate

The generator sends deterministic PointCloud2 and Path messages through the dogfooded display implementations and the thin `WebGl2Renderer` using a mock WebGL2 operation recorder.

| Display | Primitive | Input | Rendered | Dropped/decimated |
|---|---|---:|---:|---:|
| PointCloud2 (`lidar`) | `POINTS` | 120,000 | 60,000 | 60,000 |
| Path (`map`) | `LINE_STRIP` | 2,000 | 2,000 | 0 |

The artifact includes deterministic bounds, a SHA-256 semantic-scene digest, allocation/upload/draw traces, renderer telemetry before disposal, and zero live/pooled logical GPU bytes after disposal. WebGL has no portable total-GPU-memory API; every GPU byte here is renderer-owned logical allocation accounting.

## Working-set formula

The dimensional formula is fixed as:

`2 × active decoded bytes + GPU working-set bytes + documented fixed overhead bytes`

| Component | Bytes |
|---|---:|
| Active decoded PointCloud2 + Path | 1,488,000 |
| Estimated retained JS | 11,364,608 |
| Retained WASM | 0 |
| Renderer-owned logical GPU working set | 744,000 |
| Documented fixed overhead | 8,388,608 |
| Formula result | 12,108,608 |

The formula is an estimate boundary, not a heap snapshot. A controlled browser run must replace JS/WASM estimates with heap/allocation evidence and keep logical renderer GPU accounting separate from any vendor-specific GPU tooling.

## Thin WebGL2 versus rejected heavyweight-helper baseline

The comparison intentionally avoids naming or pretending to execute an uninstalled library.

| Criterion | Thin WebGL2 baseline | Rejected helper lower-bound model |
|---|---|---|
| Evidence classification | mock-WebGL2 operations + deterministic cost model | synthetic wrapper lower-bound; **not a library measurement** |
| Production runtime dependencies | 0 in `render-core` | at least one if a helper were selected |
| Resource ownership | explicit allocation, pool, upload, telemetry, disposal | adds a wrapper/resource boundary |
| M1 semantic capability | PointCloud2 + Path proven | no additional M1 capability demonstrated |
| Retained geometry copies | renderer upload source only | assumes one additional retained copy |
| Modeled p95 frame time | 4.764 ms | 5.741 ms under stated synthetic assumptions |

The model does **not** establish that thin WebGL2 is faster than a real helper library. It shows that the thin path meets the M1 semantic and ownership contract with less dependency and resource-ownership surface; a helper remains rejected until a named, licensed candidate demonstrates a measured advantage on the same controlled corpus.

## Controlled hardware acceptance still required

A production claim requires a pinned stable Chromium run on an exactly recorded machine/OS/GPU/driver with 1440×900 CSS px at DPR 1, normal power mode, fresh profile, source SHA-256, cache state, quality/decimation, active displays, and timestamp. It must record indexed seek separately from unindexed scan, first content, raw frame samples, p50/p95/p99, >50 ms long tasks, queue depth/drops, heap/WASM observations, renderer-owned GPU bytes, and any vendor GPU observations. Until that artifact exists, the candidate budgets remain hypotheses rather than pass/fail product thresholds.
