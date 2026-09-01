# Deployed Viewer Rebuild Audit

This audit compares the original interview specification with the application actually served by the Docker image. Repository-only contracts, synthetic harnesses, and unconnected display classes do not count as delivered viewer features.

| Original requirement | Docker viewer before rebuild | Rebuild acceptance |
|---|---|---|
| Compact, immediate, iridescence-inspired point-cloud viewer | Fixed dashboard shell with a non-interactive orthographic canvas | Canvas-first drawable viewer with orbit, pan, zoom, fit, top/front views, floating compact controls, and a real world grid |
| Multiple compatible displays | One global `activeTopic`, `activeKind`, and `activeDisplay`; choosing another topic disposed the previous display | Named scene layers can be added, selected, hidden, shown, removed, updated at one timeline time, and rendered together |
| Point-cloud-focused full data with bounded degradation | One complete message was selected at the timeline time, but the API was misleadingly called `sample`; display and renderer limits could silently decimate | API is named `messageAt`; every layer reports exact input/rendered/dropped counts and quality state; no hidden reduction |
| TF/TF2, grid, point cloud/scan, image/camera, pose/odometry/path, markers, occupancy map, numeric plots | Only PointCloud2, Path, Image, and byte Raw were connected to the shipped browser route; the other classes existed only in packages/tests | Each advertised native action must have a browser decoder, real display instance, timeline update, fixture, and browser assertion before it is shown as supported |
| Unknown/custom message tree/table and selectable numeric plots | Hex/ASCII byte preview only | Schema-backed field tree and numeric field selection; opaque schemas remain explicitly byte-only |
| Synchronized play/pause/seek/rate | Fixed timer and one active display | All visible layers resolve at the same requested source time; rate is explicit; stale work is superseded; per-layer message time is visible |
| Local files processed off the UI thread without whole-file materialization | MCAP/ROS1 used range reads, but decompression and orchestration ran on the main thread; ROS2 SQLite materialized each `.db3` into WASM memory | Parsing/decompression/query work moves behind a Worker boundary; any materialization limit is explicit and never represented as streaming |
| Hosted session URL | Reference packages and tests existed, but no usable Docker viewer entry | A visible, tested hosted-open flow using the same scene/timeline model |
| Secured ROS1/ROS2 live observation | Protocol/reference packages existed, but the Docker button only reported that no relay was deployed | A configured authenticated relay flow, real connection health, allowlisted subscriptions, and the same scene layers; otherwise the control stays labeled unavailable |
| Actionable compatibility truth | Topic actions were partly derived from package declarations rather than shipped browser capability | The browser capability registry is the source of truth; unsupported types never advertise a dead native button |

## Confirmed causes

1. Milestone completion was judged primarily by isolated contracts and deterministic synthetic tests, not by a browser acceptance matrix over the deployed product.
2. The production route was added after those milestones and bypassed much of the earlier normalized display lifecycle.
3. The WebGL renderer supported multiple named resources, but the route reduced it to one global active display.
4. Classes registered in `displays-core` were treated as equivalent to usable viewer features even when no source-byte decoder or browser presentation existed.
5. Performance safety mechanisms were not surfaced as user-visible quality state, making bounded behavior look like unexplained sampling.

## Rebuild rule

A feature is delivered only when the Docker browser can open a real-format fixture, expose the action, render or inspect it, update it with the synchronized timeline, report bounded degradation, and pass a headless-browser assertion. Package registration alone is not delivery evidence.

## Corrective rebuild result

The current Docker route now satisfies the browser-facing portions of this table:

- one WebGL2 scene retains multiple independent 3D drawables and compact image/data/plot windows;
- MCAP, ROS1 bag, and ROS2 SQLite demos each expose eleven topics and auto-open ten native synchronized displays;
- the eleventh `demo_msgs/Status` topic is decoded from its embedded ROS1/ROS2 schema into a field tree, and each bounded numeric field can create an independent plot layer;
- TF/TF2 header stamps are preserved; bounded `/tf` history is interpolated only between bracketing samples, `/tf_static` remains time-independent, and missing/out-of-horizon lookups become explicit layer errors;
- point-in-time lookup chooses the latest message at or before the playhead, falling back to a topic's first message only before that topic begins;
- visible-layer reads are concurrency-bounded so adding the custom topic cannot overflow the source reader queue;
- hosted indexed MCAP uses validated immutable HTTP byte ranges, while all recording parsing, ROS2 SQLite queries, and ROS1 compressed-chunk decoding run behind an off-main browser Worker boundary;
- every non-fixed-frame geometry receives a composed quaternion/translation model transform, while missing, disconnected, ambiguous, or cyclic TF paths become explicit layer errors rather than silently misplaced geometry;
- a checked-in geckodriver runner replays MCAP, ROS1, and ROS2 through the deployed Docker route, seeks the shared timeline, and asserts PointCloud2, image, multi-layer, full-data, schema-backed raw/plot, hosted-range, and live WebSocket behavior.

The live browser path is now exercised through the bundled Noetic and Jazzy bridge images against actual ROS graph publishers for `/tf` and `/scan`, using direct loopback-only WebSockets (`8765`/`8766`) into the same Firefox/WebGL display lifecycle. Caddy intentionally has no bridge proxy route. This proves the local generation-specific adapter path; public TLS/network/identity deployment remains an operator-owned production action. See [`rebuild-browser-e2e.md`](rebuild-browser-e2e.md) and [`live-bridge-deployment.md`](live-bridge-deployment.md).
