import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";

const EXPECTED_SHA256 = "77b943168236396d4330c2149cc9120c09945cc66909b826e72269e369030673";
const corpusPath = resolve(process.env.PUBLIC_CORPUS ?? "benchmarks/downloads/cartographer-backpack-2d.bag");
const outputPath = resolve(process.env.PUBLIC_BENCHMARK_OUTPUT ?? "benchmarks/artifacts/public-browser-cartographer.json");
const viewerUrl = process.env.VIEWER_URL ?? "http://127.0.0.1:8080";
const driverPort = Number(process.env.GECKODRIVER_PORT ?? 4900 + (process.pid % 80));
const driver = spawn(process.env.GECKODRIVER ?? "geckodriver", ["--port", String(driverPort)], { stdio: ["ignore", "pipe", "pipe"] });
let driverLog = "";
driver.stdout.on("data", (chunk) => { driverLog += chunk; });
driver.stderr.on("data", (chunk) => { driverLog += chunk; });

const base = `http://127.0.0.1:${driverPort}`;
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const percentile = (values, quantile) => [...values].sort((left, right) => left - right)[Math.max(0, Math.ceil(values.length * quantile) - 1)];

async function waitFor(description, predicate, timeout = 30_000) {
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
  const processList = await new Promise((resolveList, reject) => {
    const child = spawn("ps", ["-eo", "pid=,ppid=,rss=,comm="]);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveList(output) : reject(new Error(`ps exited ${code}`)));
  });
  const rows = processList.trim().split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]), command: match[4] } : undefined;
  }).filter(Boolean);
  const descendants = new Set([rootPid]);
  for (;;) {
    const before = descendants.size;
    for (const row of rows) if (descendants.has(row.ppid)) descendants.add(row.pid);
    if (descendants.size === before) break;
  }
  return rows.filter((row) => descendants.has(row.pid) && /firefox|gecko/iu.test(row.command)).reduce((sum, row) => sum + row.rss, 0);
}

const corpus = await readFile(corpusPath);
const sha256 = createHash("sha256").update(corpus).digest("hex");
if (sha256 !== EXPECTED_SHA256) throw new Error(`Public corpus SHA-256 mismatch: ${sha256}`);

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
  const openStarted = globalThis.performance.now();
  await command(`/session/${sessionId}/element/${elementId}/value`, "POST", { text: corpusPath, value: [...corpusPath] });
  const opened = await waitFor("public ROS1 bag discovery", async () => {
    const value = await execute("return {phase:document.querySelector('.viewer-shell')?.dataset.phase,topics:Number(document.querySelector('#topic-count')?.textContent),source:document.querySelector('#source-name')?.textContent,status:document.querySelector('#status-line')?.textContent,duration:document.querySelector('#duration-time')?.textContent};");
    return value.phase === "ready" && value.topics === 3 && value.source.includes("CARTOGRAPHER-BACKPACK-2D.BAG") ? value : undefined;
  }, 30_000);
  const sourceOpenMs = globalThis.performance.now() - openStarted;

  const rawStarted = globalThis.performance.now();
  await execute("document.querySelector('.topic-row button[data-kind=raw]')?.click();");
  const raw = await waitFor("public corpus raw display", async () => {
    const value = await execute("return {ready:[...document.querySelectorAll('.layer-row')].some(row=>row.textContent.includes('RAW')&&row.textContent.includes('READY')),layerStates:[...document.querySelectorAll('.layer-row')].map(row=>row.textContent.trim()),errors:document.querySelectorAll('.layer-error').length,aux:document.querySelector('#aux-dock')?.textContent??'',scene:document.querySelector('#scene-message')?.textContent??'',status:document.querySelector('#status-line')?.textContent??'',topics:document.querySelector('#topic-list')?.textContent??'',inspector:document.querySelector('#inspector')?.textContent??''};");
    if (value.ready && value.errors === 0) return value;
    throw new Error(JSON.stringify(value));
  }, 5_000);
  const rawFirstContentMs = globalThis.performance.now() - rawStarted;

  const epoch = Number(await execute("return document.querySelector('#epoch-value')?.textContent"));
  const seekStarted = globalThis.performance.now();
  await execute("const input=document.querySelector('#timeline-input'); input.value='5000'; input.dispatchEvent(new Event('change',{bubbles:true}));");
  const seek = await waitFor("public corpus seek", async () => {
    const value = await execute("return {epoch:Number(document.querySelector('#epoch-value')?.textContent),ready:[...document.querySelectorAll('.layer-row')].some(row=>row.textContent.includes('READY')),errors:document.querySelectorAll('.layer-error').length,time:document.querySelector('#current-time')?.textContent};");
    return value.epoch > epoch && value.ready && value.errors === 0 ? value : undefined;
  });
  const seekMs = globalThis.performance.now() - seekStarted;
  const playbackBefore = await execute("return document.querySelector('#current-time')?.textContent");
  await execute("document.querySelector('#play-button')?.click();");
  const frameIntervals = await executeAsync("const done=arguments[arguments.length-1];const out=[];let before;const sample=(now)=>{if(before!==undefined)out.push(now-before);before=now;if(out.length===120)done(out);else requestAnimationFrame(sample)};requestAnimationFrame(sample);");
  const playbackAfter = await execute("return document.querySelector('#current-time')?.textContent");
  await execute("if(document.querySelector('#play-button')?.getAttribute('aria-label')==='Pause recording')document.querySelector('#play-button').click();");
  if (playbackAfter === playbackBefore) throw new Error("Public benchmark playback did not advance while frame timing was sampled.");
  const playbackFrameTiming = { samples: frameIntervals.length, p50Ms: percentile(frameIntervals, 0.5), p95Ms: percentile(frameIntervals, 0.95), p99Ms: percentile(frameIntervals, 0.99), maxMs: Math.max(...frameIntervals), playbackBefore, playbackAfter };
  await delay(200);
  peakBrowserRssKiB = Math.max(peakBrowserRssKiB, await descendantRssKiB(driver.pid));
  const budgets = { sourceOpenMs: 15_000, rawFirstContentMs: 5_000, seekMs: 3_000, playbackFrameP95Ms: 25, peakBrowserRssBytes: 1024 * 1024 * 1024 };
  const passed = sourceOpenMs <= budgets.sourceOpenMs
    && rawFirstContentMs <= budgets.rawFirstContentMs
    && seekMs <= budgets.seekMs
    && playbackFrameTiming.p95Ms <= budgets.playbackFrameP95Ms
    && peakBrowserRssKiB * 1024 <= budgets.peakBrowserRssBytes;
  const artifact = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    corpus: { id: "cartographer-backpack-2d-b0-2014-07-11", path: "downloaded-by-hash", sha256, byteSize: corpus.byteLength, license: "Apache-2.0" },
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
