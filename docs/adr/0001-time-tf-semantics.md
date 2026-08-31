# ADR-0001: Scheduling, TF, latency, and epoch semantics

- **Status:** Accepted M0 baseline
- **Decision source:** approved RALPLAN Architect/Critic consensus
- **Scope:** policy only; implementation and fixture evidence begin after M0

## Context

ROS recordings and live streams expose record/log, header, receipt, ROS `/clock`, and wall/monotonic time. Treating them as interchangeable can render plausible but incorrect geometry, especially after seek or reconnect.

## Decision

Define distinct non-interchangeable types for scheduling time (delivery order), TF query time (transform selection), latency time (a named measured interval), and monotonic duration (local work/timeouts, never ROS chronology).

### Recorded scheduling and ordering

Record/log time is the default. An adapter may select another source time only through an explicit contract with validated timestamps. Invalid or missing timestamps are quarantined or receive a diagnosed fallback; they never silently join the normal ordered stream. Equal timestamps sort by source ID, channel ID, then source sequence, independent of chunking or read concurrency.

### `/clock`

`/clock` controls ROS-time scheduling only when session policy selects it and values are valid. Pause, invalid values, and backward jumps are explicit transitions. Wall or receipt time never silently substitutes.

### TF query

A valid message header stamp is the default. If missing or invalid, the documented scheduling-time fallback may be used only with a diagnostic. Historical lookup never silently uses the latest transform. Static transforms, bracketing interpolation, bounded cache horizon, missing parents, cycles, fixed-frame changes, and extrapolation are explicit results; out-of-policy extrapolation is an error.

### Live latency

When source emission time is synchronized, report emission-to-render latency with measured clock offset/error. Otherwise report a specifically named relay-ingress-to-browser or browser-receipt-to-render interval, never glass-to-glass latency.

### Epoch invalidation

Open/replacement, reconnect, seek, selected-clock change, and backward jump create a new epoch. Advancing it atomically cancels reads and invalidates queues, TF, caches, payload leases, and display state. Old-epoch work is discarded.

## Consequences

Clock conversions/fallbacks are visible in types and diagnostics. Repeated seeks and different chunking must produce identical ordering and semantic scene summaries. Amendments require differential time/TF fixture evidence and review.
