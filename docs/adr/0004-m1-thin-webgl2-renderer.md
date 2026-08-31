# ADR-0004: Thin WebGL2 renderer for the M1 vertical slice

- **Status:** Accepted for the private M1 implementation baseline
- **Evidence grade:** deterministic semantic, dimensional, and operation-cost model; no production browser/hardware result
- **Amends:** ADR-0003 display lifecycle implementation choice; it does not change payload ownership or public plugin scope

## Context

M1 requires bounded PointCloud2 and Path rendering while preserving explicit GPU ownership, source-epoch invalidation, deterministic semantic summaries, and disposal. The M0 baseline intentionally deferred selecting a renderer helper until evidence existed. The implemented render lane now provides a thin WebGL2 port with fixed-capacity buffers, subrange uploads, bounded decimation, exact-capacity pooling, telemetry, and explicit deletion.

A heavyweight helper has not been selected, installed, or executed. Treating estimates for an unnamed library as measured results would be false. The benchmark therefore includes only an explicitly labeled synthetic lower-bound wrapper model for decision-shape comparison.

## Decision

Use the thin `WebGl2Renderer` as the internal M1 renderer baseline. Dogfood it through the internal PointCloud2 and Path displays; do not expose raw WebGL through the display contract. Keep all buffers/programs renderer-owned, account for logical GPU bytes, cap allocations/vertices, decimate deterministically before allocation, and dispose every resource.

Do not add a heavyweight helper for M1. Reopen this decision only for a named, license-reviewed candidate evaluated on the same fixed corpus and controlled browser/hardware protocol. Any amendment must demonstrate semantic equivalence, bounded resource ownership, disposal, bundle/dependency impact, maintainability impact, and a measured benefit that cannot be obtained with the thin port.

## Evidence

[`docs/benchmark.md`](../benchmark.md) and the generated raw artifact record:

- separate bounded indexed and unindexed source operations;
- deterministic PointCloud2 `POINTS` and Path `LINE_STRIP` scene summaries;
- buffer allocation/upload/draw traces and before/after-disposal telemetry;
- renderer-owned logical GPU bytes, not a total GPU-memory claim;
- raw deterministic frame-model samples and percentile arithmetic;
- a synthetic wrapper lower-bound clearly marked as not a library or hardware measurement.

The thin path has zero production dependencies in `render-core` and proves the required M1 semantics. The evidence supports the smaller ownership and integration surface. It does not prove speed superiority over any real helper and does not validate production performance budgets.

## Consequences

- M1 owns shader, buffer, camera/grid, telemetry, and disposal correctness directly.
- Renderer limits and semantic summaries remain testable without browser timing nondeterminism.
- Browser compatibility and real GPU behavior still require controlled Chromium/Firefox evidence.
- New display needs that materially exceed the thin port trigger a fresh comparison rather than ad hoc helper adoption.
- No public plugin ABI, public package identity, hosted service, mobile/VR surface, or runtime-loaded extension is created by this decision.
