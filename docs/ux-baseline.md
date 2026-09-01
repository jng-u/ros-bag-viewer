# Desktop UX Baseline

**Status:** Approved for M0 baseline  
**Scope:** desktop evidence contract only; implementation begins after M0

## 1. Product experience principles

- Prefer truthful source, clock, transform, and degradation state over a visually plausible scene.
- Keep dense inspection controls discoverable without hiding diagnostics or destructive state changes.
- Treat local, hosted, and live sources as entry modes into one topic, display, and timeline model.
- Preserve user context after recoverable failures; never require a page reload to escape a bad source.

## 2. Desktop information architecture

The fixed desktop shell has five stable regions:

1. **Session bar:** source identity, mode, connection health, global diagnostics, share/live entry, and help.
2. **Topic browser:** searchable topic/type/schema tree with compatibility tier and add-display actions.
3. **Display workspace:** tiled 3D, image, plot, raw, and diagnostic panels with an explicit active panel.
4. **Inspector:** selected display configuration, frame/time policy, schema provenance, and error detail.
5. **Timeline:** play/pause, seek, step, speed, current/source time, epoch, range, and degraded-index state.

The topic browser and inspector may collapse to labeled rails, but the timeline and global source/health state remain visible. Panel reordering is not required for M0 or the first vertical slice.

## 3. Primary flows

### Open a source

1. Choose local files/directory, hosted link, or live connection.
2. Review detected bundle parts and validation diagnostics before opening.
3. Enter the workspace in a loading state that reports indexing and schema progress.
4. On failure, retain the source picker, safe diagnostics, and a clear retry/replace action.

### Discover a topic and add a display

1. Search or browse topics by name, type, compatibility tier, and schema capability.
2. Inspect schema provenance or opaque-data guidance without first adding a display.
3. Choose a compatible display; unavailable choices explain the missing capability.
4. Focus the new panel and announce the addition without moving keyboard focus unpredictably.

### Configure a display

1. Select the panel or its settings action.
2. Edit frame, color, scale, numeric field, and quality controls in the inspector.
3. Validate inline; preserve the last valid rendering when safe.
4. Surface TF/schema/resource errors in both the panel and global diagnostics.

### Navigate the timeline

1. Play, pause, seek, step, or change speed from controls or shortcuts.
2. Show the active scheduling clock, source epoch, and indexed/degraded state.
3. A seek invalidates stale panel/TF state visibly; panels show loading until the new epoch is ready.
4. Missing transforms halt affected geometry and identify frame, query time, and reason.

### Share a session

The local reference UI can open an HTTPS hosted link whose opaque capability is carried only in its fragment, or accept the opaque capability directly. It never renders or persists that capability, a grant, storage credential, or object key. The opened source enters the same topic/display/timeline model as a local recording and presents only bounded aggregate range, byte, denial, and active-reader counts.

Loading names manifest and immutable-source validation. Expired, revoked, deleted, retention-expired, invalid, and unavailable sessions receive distinct accessible recovery copy without echoing backend diagnostics. Creation/upload remains visibly unavailable in the reference shell, so the UI never implies an upload occurred. Enterprise catalog, search, administration, RBAC, collaboration, and infrastructure-selection controls are excluded.

### Connect live

The live entry gathers an approved relay endpoint/session credential, previews allowed topics, and labels the connection read-only. It never exposes raw ROS operations, edge addresses, publish/service/action controls, or wildcard escalation.

## 4. Compact iridescence-inspired tokens

Tokens describe a restrained data-tool surface, not photorealistic material.

| Category | Token | Baseline |
|---|---|---|
| Color | `surface-0/1/2` | `#0B0D12`, `#121620`, `#1A2030` |
| Color | `text-strong/muted` | `#F4F7FF`, `#AAB4C8` |
| Color | `accent-cyan/violet` | `#5CE1E6`, `#A98BFF`; accents never carry state alone |
| Color | `danger/warning/success` | `#FF6B7A`, `#F4C95D`, `#62D99C` |
| Typography | `font-ui` | system sans, 13 px/18 px; 600 weight for labels |
| Typography | `font-data` | system monospace, 12 px/17 px for time, frames, and values |
| Spacing | `space-1..6` | 4, 8, 12, 16, 24, 32 px |
| Density | `control-sm/md` | 28/34 px height; hit target remains at least 32×32 px |
| Shape | `radius-sm/md` | 4/8 px; no ornamental pill controls |
| Elevation | `edge/overlay` | 1 px border; one restrained overlay shadow |
| Motion | `fast/base` | 100/160 ms; opacity/transform only, never required to understand state |

Focus uses a 2 px high-contrast outline plus 2 px offset. Iridescence is limited to subtle accent borders or gradients with a solid-color fallback; text never sits on an uncontrolled gradient.

## 5. States and error behavior

- **Empty:** explain the next source/topic/display action, not merely “no data.”
- **Loading:** name the operation and expose determinate progress when known; loading never hides cancel.
- **Degraded:** preserve inspection while labeling sequential indexing, drops, explicit geometry-limit rejection, or unsupported codecs.
- **Error:** state what failed, the affected scope, safe recovery, and diagnostic detail; do not erase the prior source choice.
- **TF failure:** stop affected geometry rather than substitute the latest transform; show target/source frame and query time.
- **Offline/reconnecting:** distinguish browser-relay loss from relay-edge/ROS health and increment the source epoch after reconnect.

Errors are associated with controls using `aria-describedby`; blocking errors receive focus at the summary and are announced through an assertive live region. Background/degradation notices use a polite live region and deduplicate repeated messages.

## 6. Keyboard, focus, and accessibility

- One logical tab order follows session bar → topic browser → workspace → inspector → timeline; collapsed regions are removed from the tab order.
- Arrow keys move within trees, tablists, menus, sliders, and toolbars according to their ARIA pattern; `Enter`/`Space` activate, `Escape` closes the top overlay and restores its trigger.
- Shortcuts have visible discovery, avoid browser/assistive-technology conflicts, and never replace operable controls.
- Opening a dialog focuses its heading/first meaningful control; closing restores the trigger. Source/epoch updates do not steal focus.
- Every icon control has an accessible name; topic schema/tier and timeline state are available as text, not color alone.
- Text and essential icons target WCAG 2.2 AA contrast (4.5:1 normal text, 3:1 large text and UI components).
- At 200% zoom, primary flows remain operable at the baseline viewport without two-dimensional page scrolling; dense data regions may scroll internally.
- `prefers-reduced-motion: reduce` removes nonessential transitions and animated gradients while preserving immediate state changes.

Automated accessibility checks are necessary but not sufficient. Evidence also records keyboard traversal, focus restoration, screen-reader names/states, error announcements, contrast, zoom, and reduced-motion behavior.

## 7. Performance and resource budgets

M0 fixes the measurement contract; numerical product thresholds remain hypotheses until approved benchmark evidence exists.

- No interaction may require whole-recording allocation on the main thread.
- Interaction evidence records p50/p95/p99 frame time, long tasks over 50 ms, queue/drop state, and estimated JS/WASM/GPU memory.
- Candidate budgets: first useful medium-corpus content ≤3 s, indexed seek ≤500 ms p95, interaction frame time ≤22.2 ms p95, and no more than two main-thread tasks over 50 ms per second.
- Candidate peak memory is `2 × active decoded + GPU working-set bytes + documented fixed overhead`.
- Loading, empty, error, TF failure, and degraded states must remain responsive and keyboard operable under the measured load.

These values are not validated targets until the benchmark environment and corpus are approved; evidence must label them `candidate` until then.

## 8. Fixed evidence contract

Baseline captures use **1440×900 CSS pixels at DPR 1** in the pinned stable Chromium build on the compatibility document's benchmark machine, normal power mode, default compact density, dark theme, reduced motion both off and on, and a fresh profile. Any exception records browser/version, OS, GPU, viewport, DPR, zoom, theme, power state, source hash, quality/limit rejection, active displays, cache state, and timestamp.

For source open, topic discovery, display add/configuration, timeline seek, share/live entry, loading, empty, generic error, and TF failure, capture:

- semantic DOM/accessibility-tree assertions;
- deterministic screenshot or short interaction trace;
- keyboard order/focus restoration/error-announcement checklist;
- automated accessibility results and manual contrast/reduced-motion review;
- p95 frame time, long-task count, and memory/queue observations under the fixed scenario.

Visual diffs prove token/layout stability only; they cannot override semantic, accessibility, time/TF, or performance failures. Evidence filenames include scenario, source hash, browser version, viewport, DPR, and commit.

### Evidence checklist

Each reviewed scenario records every item below as `pass`, `fail`, or `not-applicable`, with a link to the supporting artifact. A failed required item blocks UX acceptance; a missing item is not an implicit pass.

- [ ] Scenario and expected user outcome are named.
- [ ] Source hash, browser/version, OS/GPU, viewport, DPR, zoom, theme, power state, and commit are recorded.
- [ ] Empty, loading, degraded, success, and applicable error/TF states are exercised.
- [ ] Keyboard traversal, visible focus, overlay focus restoration, and shortcut discoverability pass.
- [ ] Accessible names/states, live-region announcements, contrast, 200% zoom, and reduced motion pass.
- [ ] Semantic assertions and deterministic visual or interaction evidence are attached.
- [ ] p95 frame time, long tasks, queue/drop state, and memory observations are attached and labeled against candidate budgets.
- [ ] Any exception names its scope, owner, expiry/review date, and user-visible fallback.

## 9. Explicit exclusions

M0 and MVP do not define mobile or VR layouts, photorealistic materials, ornamental 3D chrome, collaboration, or full RViz parity. They also do not select a renderer helper, public product brand, hosted provider, or live transport lock.
