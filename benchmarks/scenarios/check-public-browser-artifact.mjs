import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.env.PUBLIC_BENCHMARK_OUTPUT ?? "benchmarks/artifacts/public-browser-cartographer.json");
const artifact = JSON.parse(await readFile(path, "utf8"));
const expectedSha = "77b943168236396d4330c2149cc9120c09945cc66909b826e72269e369030673";
const requiredBudgets = ["sourceOpenMs", "rawFirstContentMs", "seekMs", "playbackFrameP95Ms", "peakBrowserRssBytes"];
if (artifact.schemaVersion !== 1 || artifact.corpus?.sha256 !== expectedSha || artifact.passed !== true) throw new Error("Public browser artifact identity/pass state is invalid.");
for (const key of requiredBudgets) if (!Number.isFinite(artifact.budgets?.[key]) || artifact.budgets[key] <= 0) throw new Error(`Public browser artifact is missing budget ${key}.`);
if (artifact.result?.sourceOpenMs > artifact.budgets.sourceOpenMs
  || artifact.result?.rawFirstContentMs > artifact.budgets.rawFirstContentMs
  || artifact.result?.seekMs > artifact.budgets.seekMs
  || artifact.result?.playbackFrameTiming?.p95Ms > artifact.budgets.playbackFrameP95Ms
  || artifact.result?.peakBrowserRssBytes > artifact.budgets.peakBrowserRssBytes
  || artifact.result?.playbackFrameTiming?.samples !== 120
  || artifact.result?.playbackFrameTiming?.playbackBefore === artifact.result?.playbackFrameTiming?.playbackAfter) {
  throw new Error("Public browser artifact results do not satisfy the checked budgets/playback evidence.");
}
process.stdout.write(`public browser artifact PASS: ${path}\n`);
