import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.env.PUBLIC_ROS2_BENCHMARK_OUTPUT ?? "benchmarks/artifacts/public-browser-seav-ros2.json");
const artifact = JSON.parse(await readFile(path, "utf8"));
const expectedDatabaseSha = "987109ba897916a7384d76bfdef94253d3426b2b8bef241504e6974e1fdc4f6d";
const expectedMetadataSha = "54706215175ea6e0956d212ba6c2d273cff7f09ff3e9556e77beadf30f148059";
const requiredBudgets = ["sourceOpenMs", "rawFirstContentMs", "seekMs", "playbackFrameP95Ms", "peakBrowserRssBytes"];
if (artifact.schemaVersion !== 1 || artifact.corpus?.databaseSha256 !== expectedDatabaseSha || artifact.corpus?.metadataSha256 !== expectedMetadataSha || artifact.passed !== true) throw new Error("Public ROS2 browser artifact identity/pass state is invalid.");
for (const key of requiredBudgets) if (!Number.isFinite(artifact.budgets?.[key]) || artifact.budgets[key] <= 0) throw new Error(`Public ROS2 browser artifact is missing budget ${key}.`);
if (artifact.result?.sourceOpenMs > artifact.budgets.sourceOpenMs
  || artifact.result?.rawFirstContentMs > artifact.budgets.rawFirstContentMs
  || artifact.result?.seekMs > artifact.budgets.seekMs
  || artifact.result?.playbackFrameTiming?.p95Ms > artifact.budgets.playbackFrameP95Ms
  || artifact.result?.peakBrowserRssBytes > artifact.budgets.peakBrowserRssBytes
  || artifact.result?.playbackFrameTiming?.samples !== 120
  || artifact.result?.playbackFrameTiming?.playbackBefore === artifact.result?.playbackFrameTiming?.playbackAfter
  || artifact.result?.opened?.topics !== 25
  || artifact.result?.seek?.ready < 7
  || artifact.result?.seek?.layers?.some((label) => label.includes("ERROR"))) {
  throw new Error("Public ROS2 browser artifact does not satisfy the checked budgets and display evidence.");
}
process.stdout.write(`public ROS2 browser artifact PASS: ${path}\n`);
