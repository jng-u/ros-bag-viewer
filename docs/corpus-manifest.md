# Corpus manifest and licensing gate (M0)

**Gate status:** **APPROVED FOR M0.** The machine-readable source of truth is [`benchmarks/corpus-manifest.json`](../benchmarks/corpus-manifest.json). Licensed/generated fixtures remain automatic CI inputs. The additional SEAV ROS2 navigation bag is pinned by commit and SHA-256 but has no upstream repository-level license, so it is never redistributed and is operator-triggered local evidence only.

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

## Admitted M0 evidence

| ID | Purpose | License/use decision | Evidence state |
|---|---|---|---|
| `generated-m0-source-bundle-smoke-v1` | Deterministic metadata/hash merge gate | Internal CI only; no public project-license choice | Checked in and hash verified |
| `cartographer-backpack-2d-b0-2014-07-11` | Public ROS 1 compressed SLAM/odometry baseline | Apache-2.0; CI use and redistribution allowed | URL, license, size, SHA-256, duration, topics/types verified |
| `mcap-upstream-ros2-humble-sqlite-talker` | Public ROS 2 SQLite/schema-generation fixture | MIT; CI use and redistribution allowed | Commit-pinned URL, license, size, SHA-256, topics/types verified |
| `mcap-upstream-demo-format` | Public indexed MCAP format fixture | MIT; CI use and redistribution allowed | Commit-pinned URL, license, size, SHA-256, topics/types verified |

The JSON manifest separately records larger ROS 2 SLAM/dense-render and multipart SQLite candidates as **deferred to their M1/M2 evidence gates**. They are not represented as existing or passing, and they do not weaken the admitted M0 repository/contract corpus.

## Selection and approval

1. Retrieve from the authoritative publisher and preserve asset license evidence.
2. Verify the data license separately from repository/source-code licensing.
3. Compute hashes locally, inventory without publishing sensitive values, and record derivations.
4. Decide whether bytes may be committed, downloaded by hash, used internally, or rejected.
5. Require second-person license and sensitivity review before CI consumption.
6. Use deterministic generated fixtures for merge gates; reserve large corpus runs for approved runners.
7. Re-review on disappearance, license change, hash drift, or material transformation.

If CI use or redistribution becomes unclear, remove the entry from the admitted list and block the affected milestone. M1 performance remains blocked until its deferred medium/large dimensional corpus is separately approved and executed.
