import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const viewerUrl = process.env.VIEWER_URL ?? "http://127.0.0.1:8080";
const liveEndpoint = process.env.LIVE_ENDPOINT;
const liveToken = process.env.LIVE_TOKEN;
const generation = process.env.ROS_GENERATION;
const maxRelayLatencyMs = Number(process.env.MAX_RELAY_LATENCY_MS ?? 50);
const maxDisplayLatencyMs = Number(process.env.MAX_DISPLAY_LATENCY_MS ?? 100);
if (!liveEndpoint || !liveToken || !["ros1", "ros2"].includes(generation)) {
  throw new Error("Set LIVE_ENDPOINT, LIVE_TOKEN, and ROS_GENERATION=ros1|ros2.");
}
if (!(maxRelayLatencyMs > 0) || !(maxDisplayLatencyMs > 0)) throw new Error("Live latency budgets must be positive milliseconds.");

const driverPort = Number(process.env.GECKODRIVER_PORT ?? 4900 + (process.pid % 300));
const driver = spawn(process.env.GECKODRIVER ?? "geckodriver", ["--port", String(driverPort)], { stdio: ["ignore", "pipe", "pipe"] });
let driverLog = "";
driver.stdout.on("data", (chunk) => { driverLog += chunk; });
driver.stderr.on("data", (chunk) => { driverLog += chunk; });
const base = `http://127.0.0.1:${driverPort}`;
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitFor(description, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

async function command(path, method = "GET", body) {
  const response = await globalThis.fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) throw new Error(payload.value?.message ?? `WebDriver HTTP ${response.status}`);
  return payload.value;
}

let sessionId;
try {
  await waitFor("geckodriver", async () => (await globalThis.fetch(`${base}/status`)).ok, 10_000);
  const created = await command("/session", "POST", { capabilities: { alwaysMatch: { browserName: "firefox", "moz:firefoxOptions": { args: ["-headless", "--width=1440", "--height=900"] } } } });
  sessionId = created.sessionId;
  const execute = (script, args = []) => command(`/session/${sessionId}/execute/sync`, "POST", { script, args });
  await command(`/session/${sessionId}/url`, "POST", { url: viewerUrl });
  await waitFor("viewer shell", () => execute("return Boolean(document.querySelector('.viewer-shell'))"));
  await execute(`
    document.querySelector('#live-button').click();
    document.querySelector('#live-endpoint').value = arguments[0];
    document.querySelector('#live-token').value = arguments[1];
    document.querySelector('#live-form').requestSubmit();
  `, [liveEndpoint, liveToken]);
  const result = await waitFor(`${generation} TF and LaserScan render`, async () => {
    const value = await execute(`return {
      phase: document.querySelector('.viewer-shell')?.dataset.phase,
      mode: document.querySelector('#mode-tag')?.textContent ?? '',
      source: document.querySelector('#source-name')?.textContent ?? '',
      topics: Number(document.querySelector('#topic-count')?.textContent),
      layers: Number(document.querySelector('#layer-count')?.textContent),
      errors: document.querySelectorAll('.layer-error').length,
      ready: [...document.querySelectorAll('.layer-row')].filter((row)=>row.textContent.includes('READY')).length,
      tf: [...document.querySelectorAll('.layer-row')].some((row)=>row.textContent.includes('/tf') && row.textContent.includes('READY')),
      scan: [...document.querySelectorAll('.layer-row')].some((row)=>row.textContent.includes('/scan') && row.textContent.includes('READY')),
      scene: document.querySelector('#scene-message')?.textContent ?? '',
      stats: document.querySelector('#scene-stats')?.textContent ?? '',
      quality: document.querySelector('#status-line')?.textContent ?? '',
    };`);
    const relayLatencyMs = Number(value.quality.match(/relay ([\d.]+) ms/u)?.[1]);
    const displayLatencyMs = Number(value.quality.match(/display ([\d.]+) ms/u)?.[1]);
    const passed = value.phase === "ready"
      && value.mode.includes("LIVE")
      && value.source.includes("SECURE LIVE RELAY")
      && value.topics >= 2
      && value.layers >= 2
      && value.ready >= 2
      && value.errors === 0
      && value.tf
      && value.scan
      && value.scene.includes("synchronized")
      && /\d{2}:\d{2}:\d{2}\.\d{3} UTC/u.test(value.scene)
      && !value.scene.includes("00:00:00.000 UTC")
      && /[1-9][0-9]* VERTICES/.test(value.stats)
      && value.quality.includes("dropped 0")
      && value.quality.includes("rendered from")
      && !value.quality.includes("failed")
      && value.quality.includes("relay")
      && value.quality.includes("display")
      && Number.isFinite(relayLatencyMs)
      && relayLatencyMs <= maxRelayLatencyMs
      && Number.isFinite(displayLatencyMs)
      && displayLatencyMs <= maxDisplayLatencyMs;
    if (passed) return { ...value, relayLatencyMs, displayLatencyMs, maxRelayLatencyMs, maxDisplayLatencyMs };
    throw new Error(JSON.stringify(value));
  });
  let customSchema;
  if (generation === "ros2") {
    await execute(`const row=[...document.querySelectorAll('.topic-row')].find((item)=>item.querySelector('strong')?.textContent==='/viewer/plane'); row?.querySelector('button[data-kind="raw"]')?.click();`);
    const raw = await waitFor("ROS2 live schema-backed custom raw tree", async () => {
      const value = await execute(`return {
        rawReady:[...document.querySelectorAll('.layer-row')].some((row)=>row.textContent.includes('/viewer/plane')&&row.textContent.includes('RAW')&&row.textContent.includes('READY')),
        aux:document.querySelector('#aux-dock')?.textContent??'',
      };`);
      return value.rawReady && value.aux.includes("coef") ? value : undefined;
    });
    await execute(`const button=[...document.querySelectorAll('[data-plot-field]')].find((candidate)=>candidate.textContent.includes('coef[0]')); button?.click();`);
    const plot = await waitFor("ROS2 live custom numeric plot", async () => {
      const value = await execute(`return {
        ready:[...document.querySelectorAll('.layer-row')].filter((row)=>row.textContent.includes('/viewer/plane')&&row.textContent.includes('READY')).length,
        plots:document.querySelectorAll('.plot-window canvas').length,
        errors:document.querySelectorAll('.layer-error').length,
      };`);
      return value.ready >= 2 && value.plots >= 1 && value.errors === 0 ? value : undefined;
    });
    customSchema = { raw, plot };
  }
  const screenshotPath = resolve(process.env.E2E_SCREENSHOT ?? `/tmp/ros-web-viewer-${generation}-bridge-e2e.png`);
  await mkdir(dirname(screenshotPath), { recursive: true });
  await writeFile(screenshotPath, Buffer.from(await command(`/session/${sessionId}/screenshot`), "base64"));
  process.stdout.write(`${JSON.stringify({ viewerUrl, liveEndpoint, generation, result, customSchema, screenshotPath }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n${driverLog}\n`);
  process.exitCode = 1;
} finally {
  if (sessionId) await command(`/session/${sessionId}`, "DELETE").catch(() => undefined);
  driver.kill("SIGTERM");
}
