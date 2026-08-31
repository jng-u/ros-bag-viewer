# Corpus manifest and licensing gate (M0)

**Gate status:** **BLOCKED — no external corpus is approved for CI or redistribution yet.** M0 must not invent URLs, licenses, or hashes. Generated fixtures require recorded generator inputs and licensing.

## Required manifest fields

| Field | Requirement |
|---|---|
| `id` / `revision` | Stable identifier and immutable upstream revision |
| `authoritative_url` | Publisher-controlled source, not an unverified mirror |
| `retrieved_at` | UTC timestamp and retrieval method |
| `license_id` / `license_url` | Exact asset/data license and primary evidence |
| `redistribution` | `allowed`, `download-by-hash`, `internal-only`, or `forbidden`, with rationale |
| `sha256` / `size_bytes` | Hash and exact size of every bundle entry |
| `format` | ROS generation, storage/version, compression, indexing, multipart relations |
| `inventory` | Topics, native types, schema providers, time range, rates, and dimensions |
| `sensitivity` | No credentials, personal data, or restricted operational data |
| `intended_jobs` | Unit, integration, compatibility, E2E, benchmark, or hardware job |
| `review` | Owner, reviewer, decision, date, and recheck trigger |

## Candidate slots

| ID | Purpose | Required characteristics | Evidence state |
|---|---|---|---|
| `generated-minimal` | Deterministic merge gate | MCAP and bundle metadata; TF, odometry, path, point cloud, image, custom and opaque data | Generator/license/hash missing |
| `ros2-mcap-medium` | Indexed seek/render baseline | Public ROS 2 SLAM/odometry MCAP with dense data | Source/license/hash not selected |
| `ros2-mcap-unindexed` | Degraded behavior | Reproducible unindexed derivative | Parent and derivative permission unverified |
| `ros1-bag-medium` | ROS 1 compatibility | Public SLAM/odometry bag with connection definitions | Source/license/hash not selected |
| `ros2-sqlite-multipart` | Bundle relation checks | `metadata.yaml` plus multiple `.db3` parts | Source/license/hash not selected |
| `adversarial-generated` | Bounded failure | Truncated, malformed, oversized, traversal, schema-conflict, and decompression cases | Generator/license/hash missing |

## Selection and approval

1. Retrieve from the authoritative publisher and preserve asset license evidence.
2. Verify the data license separately from repository/source-code licensing.
3. Compute hashes locally, inventory without publishing sensitive values, and record derivations.
4. Decide whether bytes may be committed, downloaded by hash, used internally, or rejected.
5. Require second-person license and sensitivity review before CI consumption.
6. Use deterministic generated fixtures for merge gates; reserve large corpus runs for approved runners.
7. Re-review on disappearance, license change, hash drift, or material transformation.

If CI use or redistribution is unclear, reject the fixture or use a documented non-redistributing acquisition path. M1 remains blocked if no lawful reproducible corpus can exercise its correctness and performance gates.
