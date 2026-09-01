import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";

const EXPECTED_DATABASE_SHA256 = "987109ba897916a7384d76bfdef94253d3426b2b8bef241504e6974e1fdc4f6d";
const EXPECTED_METADATA_SHA256 = "54706215175ea6e0956d212ba6c2d273cff7f09ff3e9556e77beadf30f148059";
const corpusDirectory = resolve(process.env.PUBLIC_ROS2_CORPUS ?? "benchmarks/downloads/seav-ros2");
const databasePath = resolve(corpusDirectory, "rosbag2_2025_03_30-14_47_38_0.db3");
const metadataPath = resolve(corpusDirectory, "metadata.yaml");
const outputPath = resolve(process.env.PUBLIC_ROS2_BENCHMARK_OUTPUT ?? "benchmarks/artifacts/public-browser-seav-ros2.json");
const viewerUrl = process.env.VIEWER_URL ?? "http://127.0.0.1:8080";
const driverPort = Number(process.env.GECKODRIVER_PORT ?? 5000 + (process.pid % 80));
const driver = spawn(process.env.GECKODRIVER ?? "geckodriver", ["--port", String(driverPort)], { stdio: ["ignore", "pipe", "pipe"] });
let driverLog = "";
driver.stdout.on("data", (chunk) => { driverLog += chunk; });
driver.stderr.on("data", (chunk) => { driverLog += chunk; });

const base = `http://127.0.0.1:${driverPort}`;
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const percentile = (values, quantile) => [...values].sort((left, right) => left - right)[Math.max(0, Math.ceil(values.length * quantile) - 1)];

async function waitFor(description, predicate, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await predicate(); if (last) return last; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

async function command(path, method = "GET", body) {
  const response = await globalThis.fetch(`${base}${path}`, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) throw new Error(payload.value?.message ?? `WebDriver HTTP ${response.status}`);
  return payload.value;
}

async function descendantRssKiB(rootPid) {
  const rows = await new Promise((resolveRows, reject) => {
    const child = spawn("ps", ["-eo", "pid=,ppid=,rss=,comm="]);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveRows(output.trim().split("\n").map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]), command: match[4] } : undefined;
    }).filter(Boolean)) : reject(new Error(`ps exited ${code}`)));
  });
  const descendants = new Set([rootPid]);
  for (;;) {
    const before = descendants.size;
    for (const row of rows) if (descendants.has(row.ppid)) descendants.add(row.pid);
    if (before === descendants.size) break;
  }
  return rows.filter((row) => descendants.has(row.pid) && /firefox|gecko/iu.test(row.command)).reduce((sum, row) => sum + row.rss, 0);
}

const [database, metadata] = await Promise.all([readFile(databasePath), readFile(metadataPath)]);
const databaseSha256 = createHash("sha256").update(database).digest("hex");
const metadataSha256 = createHash("sha256").update(metadata).digest("hex");
if (databaseSha256 !== EXPECTED_DATABASE_SHA256 || metadataSha256 !== EXPECTED_METADATA_SHA256) throw new Error("Public ROS2 corpus SHA-256 mismatch.");

let sessionId;
let peakBrowserRssKiB = 0;
const memorySampler = globalThis.setInterval(() => { void descendantRssKiB(driver.pid).then((value) => { peakBrowserRssKiB = Math.max(peakBrowserRssKiB, value); }); }, 100);
try {
  await waitFor("geckodriver", async () => (await globalThis.fetch(`${base}/status`)).ok, 10_000);
  const created = await command("/session", "POST", { capabilities: { alwaysMatch: { browserName: "firefox", "moz:firefoxOptions": { args: ["-headless", "--width=1440", "--height=900"] } } } });
  sessionId = created.sessionId;
  const execute = (script, args = []) => command(`/session/${sessionId}/execute/sync`, "POST", { script, args });
  const executeAsync = (script, args = []) => command(`/session/${sessionId}/execute/async`, "POST", { script, args });
  await command(`/session/${sessionId}/url`, "POST", { url: viewerUrl });
  await waitFor("viewer", () => execute("return Boolean(document.querySelector('.viewer-shell'))"));
  const environment = await execute("return {userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,viewport:[innerWidth,innerHeight],devicePixelRatio,crossOriginIsolated};");
  const input = await command(`/session/${sessionId}/element`, "POST", { using: "css selector", value: "#recording-input" });
  const elementId = input["element-6066-11e4-a52e-4f735466cecf"];
  const fileValue = `${metadataPath}\n${databasePath}`;
  const openStarted = globalThis.performance.now();
  await command(`/session/${sessionId}/element/${elementId}/value`, "POST", { text: fileValue, value: [...fileValue] });
  const opened = await waitFor("public ROS2 SLAM bag render", async () => {
    const value = await execute(`return {
      phase:document.querySelector('.viewer-shell')?.dataset.phase,
      topics:Number(document.querySelector('#topic-count')?.textContent),
      source:document.querySelector('#source-name')?.textContent??'',
      ready:[...document.querySelectorAll('.layer-row')].filter((row)=>row.textContent.includes('READY')).length,
      errors:document.querySelectorAll('.layer-error').length,
      layers:[...document.querySelectorAll('.layer-row')].map((row)=>row.textContent.trim()),
      stats:document.querySelector('#scene-stats')?.textContent??'',
      duration:document.querySelector('#duration-time')?.textContent??'',
    };`);
    if (value.phase === "ready" && value.topics === 25 && value.source.includes("ROS2 BAG") && value.layers.length === 6 && value.layers.every((label) => /READY|ERROR/u.test(label))) return value;
    throw new Error(JSON.stringify(value));
  });
  const sourceOpenMs = globalThis.performance.now() - openStarted;

  const rawStarted = globalThis.performance.now();
  await execute("const row=[...document.querySelectorAll('.topic-row')].find((item)=>item.querySelector('strong')?.textContent==='/odom'); row?.querySelector('button[data-kind=raw]')?.click();");
  const raw = await waitFor("public ROS2 odometry raw tree", async () => {
    const value = await execute("return {ready:[...document.querySelectorAll('.layer-row')].some((row)=>row.textContent.includes('/odom')&&row.textContent.includes('RAW')&&row.textContent.includes('READY')),errors:document.querySelectorAll('.layer-error').length,aux:document.querySelector('#aux-dock')?.textContent??''};");
    return value.ready && value.errors === 0 && value.aux.includes("pose") ? value : undefined;
  });
  const rawFirstContentMs = globalThis.performance.now() - rawStarted;

  const epoch = Number(await execute("return document.querySelector('#epoch-value')?.textContent"));
  const seekStarted = globalThis.performance.now();
  // The pinned capture continues recording IMU/odometry long after its SLAM
  // map->odom broadcaster stops. Exercise the interval where the recorded
  // SLAM graph is actually connected instead of accepting a TF latest-value
  // fallback that would make a later timestamp look valid.
  await execute("const input=document.querySelector('#timeline-input'); input.value='1000'; input.dispatchEvent(new Event('change',{bubbles:true}));");
  const seek = await waitFor("public ROS2 synchronized active-SLAM seek", async () => {
    const value = await execute("return {epoch:Number(document.querySelector('#epoch-value')?.textContent),ready:[...document.querySelectorAll('.layer-row')].filter((row)=>row.textContent.includes('READY')).length,layers:[...document.querySelectorAll('.layer-row')].map((row)=>row.textContent.trim()),time:document.querySelector('#current-time')?.textContent};");
    return value.epoch > epoch && value.layers.length === 7 && value.layers.every((label)=>/READY|ERROR/.test(label)) ? value : undefined;
  });
  if (seek.layers.some((label) => label.includes("ERROR"))) {
    const errorRows = await execute("return [...document.querySelectorAll('.layer-row')].map((row,index)=>({index,label:row.textContent.trim()})).filter(({label})=>label.includes('ERROR'));");
    const diagnostics = [];
    for (const row of errorRows) {
      await execute("document.querySelectorAll('.layer-row')[arguments[0]]?.querySelector('.layer-select')?.click();", [row.index]);
      diagnostics.push({ ...row, inspector: await execute("return document.querySelector('#inspector')?.textContent??''") });
    }
    const sceneDiagnostic = await execute("return document.querySelector('#scene-message')?.textContent??''");
    throw new Error(`Public ROS2 native display errors after active-SLAM seek: ${JSON.stringify({ diagnostics, sceneDiagnostic })}`);
  }
  const seekMs = globalThis.performance.now() - seekStarted;
  const playbackBefore = await execute("return document.querySelector('#current-time')?.textContent");
  await execute("document.querySelector('#play-button')?.click();");
  const frameIntervals = await executeAsync("const done=arguments[arguments.length-1];const out=[];let before;const sample=(now)=>{if(before!==undefined)out.push(now-before);before=now;if(out.length===120)done(out);else requestAnimationFrame(sample)};requestAnimationFrame(sample);");
  const playbackAfter = await execute("return document.querySelector('#current-time')?.textContent");
  await execute("document.querySelector('#play-button')?.click();");
  if (playbackAfter === playbackBefore) throw new Error("Public ROS2 playback did not advance.");
  const playbackFrameTiming = { samples: frameIntervals.length, p50Ms: percentile(frameIntervals, 0.5), p95Ms: percentile(frameIntervals, 0.95), p99Ms: percentile(frameIntervals, 0.99), maxMs: Math.max(...frameIntervals), playbackBefore, playbackAfter };
  await delay(200);
  peakBrowserRssKiB = Math.max(peakBrowserRssKiB, await descendantRssKiB(driver.pid));
  const budgets = { sourceOpenMs: 20_000, rawFirstContentMs: 5_000, seekMs: 5_000, playbackFrameP95Ms: 25, peakBrowserRssBytes: 1024 * 1024 * 1024 };
  const passed = sourceOpenMs <= budgets.sourceOpenMs && rawFirstContentMs <= budgets.rawFirstContentMs && seekMs <= budgets.seekMs && playbackFrameTiming.p95Ms <= budgets.playbackFrameP95Ms && peakBrowserRssKiB * 1024 <= budgets.peakBrowserRssBytes;
  const artifact = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    corpus: {
      id: "seav-ros2-humble-navigation-2025-03-30",
      upstreamCommit: "fa609c6a0a546248a354d72ff28d998d0338640d",
      sourceUrl: "https://github.com/se-buw/seav/tree/fa609c6a0a546248a354d72ff28d998d0338640d/docs/rosbag/rosbag2_2025_03_30-14_47_38",
      databaseSha256,
      metadataSha256,
      byteSize: database.byteLength + metadata.byteLength,
      license: "NOASSERTION",
      redistributionPolicy: "prohibited; download from pinned upstream for local evaluation only",
    },
    machine: { hostname: hostname(), platform: platform(), release: release(), cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytesAtReport: freemem() },
    browser: environment,
    result: { sourceOpenMs, rawFirstContentMs, seekMs, peakBrowserRssBytes: peakBrowserRssKiB * 1024, playbackFrameTiming, opened, raw: { ready: raw.ready, errors: raw.errors }, seek },
    budgets,
    passed,
  };
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n${driverLog}\n`);
  process.exitCode = 1;
} finally {
  globalThis.clearInterval(memorySampler);
  if (sessionId) await command(`/session/${sessionId}`, "DELETE").catch(() => undefined);
  driver.kill("SIGTERM");
}
