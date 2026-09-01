import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";

const viewerUrl = process.env.VIEWER_URL ?? "http://127.0.0.1:8080";
const shareCreateToken = process.env.SHARE_CREATE_TOKEN;
if (!shareCreateToken) throw new Error("Set SHARE_CREATE_TOKEN to the token configured on the Docker share service.");
const driverPort = Number(process.env.GECKODRIVER_PORT ?? 4600 + (process.pid % 300));
const driver = spawn(process.env.GECKODRIVER ?? "geckodriver", ["--port", String(driverPort)], { stdio: ["ignore", "pipe", "pipe"] });
let driverLog = "";
driver.stdout.on("data", (chunk) => { driverLog += chunk; });
driver.stderr.on("data", (chunk) => { driverLog += chunk; });

const base = `http://127.0.0.1:${driverPort}`;
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const percentile = (values, percentileValue) => [...values].sort((left, right) => left - right)[Math.max(0, Math.ceil(values.length * percentileValue) - 1)];

class CdrWriter {
  bytes = new Uint8Array(64 * 1024);
  view = new DataView(this.bytes.buffer);
  origin = 4;
  offset = 4;
  constructor() { this.view.setUint16(0, 1, false); this.view.setUint16(2, 0, false); }
  align(size) { const relative = this.offset - this.origin; this.offset += (size - (relative % size)) % size; }
  uint8(value) { this.view.setUint8(this.offset++, value); }
  uint32(value) { this.align(4); this.view.setUint32(this.offset, value, true); this.offset += 4; }
  int32(value) { this.align(4); this.view.setInt32(this.offset, value, true); this.offset += 4; }
  float32(value) { this.align(4); this.view.setFloat32(this.offset, value, true); this.offset += 4; }
  float64(value) { this.align(8); this.view.setFloat64(this.offset, value, true); this.offset += 8; }
  string(value) { const encoded = Buffer.from(value, "utf8"); this.uint32(encoded.byteLength + 1); this.bytes.set(encoded, this.offset); this.offset += encoded.byteLength; this.uint8(0); }
  float32Sequence(values) { this.uint32(values.length); for (const value of values) this.float32(value); }
  header(frameId) { this.int32(0); this.uint32(0); this.string(frameId); }
  finish(alignment = 1) { const padding = (alignment - ((this.offset - this.origin) % alignment)) % alignment; return Buffer.from(this.bytes.slice(0, this.offset + padding)); }
}

function liveTfCdr() {
  const writer = new CdrWriter();
  writer.uint32(1);
  writer.header("map"); writer.string("lidar");
  writer.float64(1.25); writer.float64(-0.5); writer.float64(0.4);
  writer.float64(0); writer.float64(0); writer.float64(0); writer.float64(1);
  return writer.finish(4);
}

function liveScanCdr() {
  const writer = new CdrWriter();
  writer.header("lidar");
  const count = 180;
  const increment = Math.PI * 2 / count;
  writer.float32(-Math.PI); writer.float32(Math.PI - increment); writer.float32(increment);
  writer.float32(0); writer.float32(0.1); writer.float32(0.2); writer.float32(20);
  writer.float32Sequence(Array.from({ length: count }, (_, index) => 3.5 + Math.sin(index * 0.12) * 0.4));
  writer.float32Sequence([]);
  return writer.finish(4);
}

function liveNumericCdr() {
  const payload = Buffer.alloc(12); payload[1] = 1; payload.writeDoubleLE(42.5, 4); return payload;
}

function websocketFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.byteLength < 126) return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload]);
  const header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.byteLength, 2);
  return Buffer.concat([header, payload]);
}

function consumeWebsocketFrames(socket, onFrame) {
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.byteLength < 2) return;
      const opcode = buffered[0] & 0x0f;
      const masked = (buffered[1] & 0x80) !== 0;
      let length = buffered[1] & 0x7f;
      let offset = 2;
      if (length === 126) { if (buffered.byteLength < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
      if (length === 127) throw new Error("E2E WebSocket request frame is unexpectedly large");
      const maskBytes = masked ? 4 : 0;
      if (buffered.byteLength < offset + maskBytes + length) return;
      const mask = masked ? buffered.subarray(offset, offset + 4) : undefined;
      offset += maskBytes;
      const payload = Buffer.from(buffered.subarray(offset, offset + length));
      if (mask) for (let index = 0; index < payload.byteLength; index += 1) payload[index] ^= mask[index % 4];
      buffered = buffered.subarray(offset + length);
      if (opcode === 0x8) { socket.end(); return; }
      if (opcode === 0x1) onFrame(JSON.parse(payload.toString("utf8")));
    }
  });
}

async function startFixtureServer() {
  const recording = await readFile(resolve("apps/web/public/demo.mcap"));
  const viewerOrigin = new globalThis.URL(viewerUrl).origin;
  const etag = '"browser-e2e-demo"';
  const server = createServer((request, response) => {
    const cors = {
      "access-control-allow-origin": viewerOrigin,
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "authorization, range, if-range",
      "access-control-expose-headers": "content-range, etag, accept-ranges, content-length",
      "cross-origin-resource-policy": "cross-origin",
      vary: "Origin",
    };
    if (request.method === "OPTIONS") { response.writeHead(204, cors); response.end(); return; }
    if (request.url !== "/demo.mcap" || request.headers.authorization !== "Bearer browser-e2e") { response.writeHead(404, cors); response.end(); return; }
    const match = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/u);
    if (!match) { response.writeHead(416, { ...cors, "content-range": `bytes */${recording.byteLength}` }); response.end(); return; }
    const start = Number(match[1]); const end = Number(match[2]);
    if (start < 0 || end < start || end >= recording.byteLength) { response.writeHead(416, { ...cors, "content-range": `bytes */${recording.byteLength}` }); response.end(); return; }
    const body = recording.subarray(start, end + 1);
    response.writeHead(206, { ...cors, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${recording.byteLength}`, "content-length": body.byteLength, etag, "content-type": "application/octet-stream" });
    response.end(body);
  });
  server.on("upgrade", (request, socket) => {
    if (request.url !== "/live" || request.headers["sec-websocket-protocol"] !== "ros-viewer.subscribe.v1") { socket.destroy(); return; }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") { socket.destroy(); return; }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ros-viewer.subscribe.v1\r\n\r\n`);
    const sentTopics = new Set();
    consumeWebsocketFrames(socket, (requestFrame) => {
      const send = (frame) => socket.write(websocketFrame(frame));
      if (requestFrame.operation === "authenticate") send({ version: 1, kind: "ready", requestId: requestFrame.requestId, sessionId: "browser-e2e-session", expiresAtMs: Date.now() + 60_000 });
      else if (requestFrame.operation === "discover") send({ version: 1, kind: "discovery", requestId: requestFrame.requestId, topics: [
        { id: "live-tf", name: "/tf", typeName: "tf2_msgs/msg/TFMessage", encoding: "cdr" },
        { id: "live-scan", name: "/live/scan", typeName: "sensor_msgs/msg/LaserScan", encoding: "cdr" },
        { id: "live-value", name: "/live/value", typeName: "std_msgs/msg/Float64", encoding: "cdr" },
      ] });
      else if (requestFrame.operation === "subscribe") {
        send({ version: 1, kind: "ack", requestId: requestFrame.requestId });
        const fixtures = [
          ["live-tf", "tf2_msgs/msg/TFMessage", liveTfCdr()],
          ["live-scan", "sensor_msgs/msg/LaserScan", liveScanCdr()],
          ["live-value", "std_msgs/msg/Float64", liveNumericCdr()],
        ];
        fixtures.forEach(([topicId, typeName, payload], index) => {
          if (!requestFrame.topicIds?.includes(topicId) || sentTopics.has(topicId)) return;
          sentTopics.add(topicId);
          setTimeout(() => send({ version: 1, kind: "message", topicId, sequence: "1", sourceTimeNanos: "42000000", receiptTimeNanos: "42100000", typeName, encoding: "cdr", payloadBase64: payload.toString("base64") }), 20 + index * 20);
        });
      } else if (requestFrame.operation === "unsubscribe") send({ version: 1, kind: "ack", requestId: requestFrame.requestId });
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not allocate a TCP port");
  return { server, port: address.port };
}

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

const fixture = await startFixtureServer();
let sessionId;
try {
  await waitFor("geckodriver", async () => (await globalThis.fetch(`${base}/status`)).ok, 10_000);
  const created = await command("/session", "POST", { capabilities: { alwaysMatch: { browserName: "firefox", "moz:firefoxOptions": { args: ["-headless", "--width=1440", "--height=900"] } } } });
  sessionId = created.sessionId;
  const execute = (script, args = []) => command(`/session/${sessionId}/execute/sync`, "POST", { script, args });
  const executeAsync = (script, args = []) => command(`/session/${sessionId}/execute/async`, "POST", { script, args });
  await command(`/session/${sessionId}/url`, "POST", { url: viewerUrl });
  await waitFor("viewer shell", () => execute("return Boolean(document.querySelector('.viewer-shell'))"));
  const environment = await execute(`return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    viewport: [innerWidth, innerHeight],
    devicePixelRatio,
    jsHeapTelemetryAvailable: Boolean(performance.memory),
    longTaskObserverAvailable: typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask') === true,
  };`);

  const results = [];
  for (const format of ["mcap", "ros1", "ros2"]) {
    const openStarted = Date.now();
    const previousEpoch = Number(await execute("return document.querySelector('#epoch-value')?.textContent ?? '0'"));
    const expectedSource = format === "mcap" ? "DEMO.MCAP" : format === "ros1" ? "DEMO-ROS1.BAG" : "ROS2 BAG";
    await execute("const s=document.querySelector('#demo-kind'); s.value=arguments[0]; s.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#demo-button').click();", [format]);
    const result = await waitFor(`${format} demo render`, async () => {
      const value = await execute(`return {
        phase: document.querySelector('.viewer-shell')?.dataset.phase,
        source: document.querySelector('#source-name')?.textContent ?? '',
        epoch: Number(document.querySelector('#epoch-value')?.textContent ?? '0'),
        topics: Number(document.querySelector('#topic-count')?.textContent),
        layers: Number(document.querySelector('#layer-count')?.textContent),
        errors: document.querySelectorAll('.layer-error').length,
        stats: document.querySelector('#scene-stats')?.textContent ?? '',
        readyPointCloud: [...document.querySelectorAll('.layer-row')].some((row)=>row.textContent.includes('/demo/points') && row.textContent.includes('READY')),
        ready: [...document.querySelectorAll('.layer-row')].filter((row)=>row.textContent.includes('READY')).length,
        layerStates: [...document.querySelectorAll('.layer-row')].map((row)=>row.textContent.trim()),
        scene: document.querySelector('#scene-message')?.textContent ?? '',
        status: document.querySelector('#status-line')?.textContent ?? '',
        inspector: document.querySelector('#inspector')?.textContent ?? '',
        imageWidth: document.querySelector('.aux-window canvas')?.width ?? 0,
      };`);
      const renderedVertices = Number(value.stats.match(/WEBGL2([\d,]+) VERTICES/u)?.[1]?.replaceAll(',', '') ?? 0);
      if (value.phase === "ready" && value.source.includes(expectedSource) && value.epoch > previousEpoch && value.topics === 11 && value.layers >= 10 && value.ready >= 10 && value.errors === 0 && value.readyPointCloud && value.scene.includes("synchronized") && renderedVertices >= 200_000 && value.stats.includes("FULL DATA") && value.imageWidth > 0) return { ...value, renderedVertices };
      throw new Error(JSON.stringify(value));
    });
    results.push({ format, openToSynchronizedMs: Date.now() - openStarted, ...result });
  }

  const originalWindow = await command(`/session/${sessionId}/window`);
  await execute("window.open(location.href, '_blank')");
  const secondWindow = await waitFor("second Firefox viewer tab", async () => {
    const handles = await command(`/session/${sessionId}/window/handles`);
    return handles.find((handle) => handle !== originalWindow);
  });
  await command(`/session/${sessionId}/window`, "POST", { handle: secondWindow });
  await waitFor("second viewer shell", () => execute("return Boolean(document.querySelector('.viewer-shell'))"));
  await execute("const s=document.querySelector('#demo-kind'); s.value='ros2'; s.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#demo-button').click();");
  const concurrentRos2 = await waitFor("concurrent ROS2 OPFS session", async () => {
    const value = await execute(`return {
      phase: document.querySelector('.viewer-shell')?.dataset.phase,
      source: document.querySelector('#source-name')?.textContent ?? '',
      topics: Number(document.querySelector('#topic-count')?.textContent),
      ready: [...document.querySelectorAll('.layer-row')].filter((row)=>row.textContent.includes('READY')).length,
      errors: document.querySelectorAll('.layer-error').length,
    };`);
    return value.phase === "ready" && value.source.includes("ROS2 BAG") && value.topics === 11 && value.ready >= 10 && value.errors === 0 ? value : undefined;
  });
  await command(`/session/${sessionId}/window`, "DELETE");
  await command(`/session/${sessionId}/window`, "POST", { handle: originalWindow });

  const opfsNamespaces = () => executeAsync(`const done=arguments[arguments.length-1]; (async()=>{
    const root=await navigator.storage.getDirectory(); const names=[];
    for await (const [name] of root.entries()) if(name.startsWith('.ros-web-viewer-sqlite-')) names.push(name);
    done(names.sort());
  })().catch((error)=>done({error:String(error)}));`);
  const ros2NamespaceBeforeSwitch = await opfsNamespaces();
  if (!Array.isArray(ros2NamespaceBeforeSwitch) || ros2NamespaceBeforeSwitch.length < 1 || ros2NamespaceBeforeSwitch.length > 2) throw new Error(`Expected active ROS2 OPFS namespaces to remain bounded by the two test tabs: ${JSON.stringify(ros2NamespaceBeforeSwitch)}`);
  await execute("const s=document.querySelector('#demo-kind'); s.value='mcap'; s.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#demo-button').click();");
  await waitFor("ROS2 OPFS cleanup after source switch", async () => {
    const namespaces = await opfsNamespaces();
    const value = await execute("return {phase:document.querySelector('.viewer-shell')?.dataset.phase,source:document.querySelector('#source-name')?.textContent??'',demoDisabled:document.querySelector('#demo-button')?.disabled===true};");
    return value.phase === "ready" && value.source.includes("DEMO.MCAP") && !value.demoDisabled && Array.isArray(namespaces) && namespaces.length === 0 ? { value, namespaces } : undefined;
  });
  await execute("const s=document.querySelector('#demo-kind'); s.value='ros2'; s.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#demo-button').click();");
  const ros2Reopen = await waitFor("same-tab ROS2 reopen after OPFS cleanup", async () => {
    const value = await execute(`return {
      phase: document.querySelector('.viewer-shell')?.dataset.phase,
      source: document.querySelector('#source-name')?.textContent ?? '',
      ready: [...document.querySelectorAll('.layer-row')].filter((row)=>row.textContent.includes('READY')).length,
      errors: document.querySelectorAll('.layer-error').length,
    };`);
    const namespaces = await opfsNamespaces();
    if (value.phase === "ready" && value.source.includes("ROS2 BAG") && value.ready >= 10 && value.errors === 0 && Array.isArray(namespaces) && namespaces.length === 1) return { ...value, namespaces };
    throw new Error(JSON.stringify({ value, namespaces }));
  });

  await execute("const row=[...document.querySelectorAll('.layer-row')].find((item)=>item.textContent.includes('/demo/points')); row?.querySelector('.layer-select')?.click(); const input=document.querySelector('input[data-layer-color]'); if(input){input.value='#ff3344'; input.dispatchEvent(new Event('change',{bubbles:true}));}");
  const displayConfiguration = await waitFor("per-display configuration", async () => {
    const value = await execute(`return {
      color: document.querySelector('input[data-layer-color]')?.value ?? '',
      pointReady: [...document.querySelectorAll('.layer-row')].some((row)=>row.textContent.includes('/demo/points') && row.textContent.includes('READY')),
      errors: document.querySelectorAll('.layer-error').length,
    };`);
    return value.color === "#ff3344" && value.pointReady && value.errors === 0 ? value : undefined;
  });

  const seekStarted = Date.now();
  const seekEpoch = Number(await execute("return document.querySelector('#epoch-value')?.textContent ?? '0'"));
  await execute("const t=document.querySelector('#timeline-input'); t.value='5000'; t.dispatchEvent(new Event('input',{bubbles:true})); t.dispatchEvent(new Event('change',{bubbles:true}));");
  const seek = await waitFor("synchronized seek and TF render", async () => {
    const value = await execute(`return {
      epoch: Number(document.querySelector('#epoch-value')?.textContent ?? '0'),
      errors: document.querySelectorAll('.layer-error').length,
      ready: [...document.querySelectorAll('.layer-row')].filter((row)=>row.textContent.includes('READY')).length,
      scene: document.querySelector('#scene-message')?.textContent ?? '',
      time: document.querySelector('#current-time')?.textContent ?? '',
    };`);
    return value.epoch > seekEpoch && value.errors === 0 && value.ready >= 10 && value.scene.includes("synchronized") ? value : undefined;
  });
  seek.elapsedMs = Date.now() - seekStarted;

  await execute("const i=document.querySelector('#fixed-frame-input'); i.value='odom'; i.dispatchEvent(new Event('change',{bubbles:true}));");
  const fixedFrame = await waitFor("fixed-frame reconfiguration", async () => {
    const value = await execute(`return {
      fixedFrame: document.querySelector('#fixed-frame-input')?.value ?? '',
      ready: [...document.querySelectorAll('.layer-row')].filter((row)=>row.textContent.includes('READY')).length,
      layerStates: [...document.querySelectorAll('.layer-row')].map((row)=>row.textContent.trim()),
      scene: document.querySelector('#scene-message')?.textContent ?? '',
    };`);
    if (value.fixedFrame === "odom" && value.ready >= 10 && value.scene.includes("synchronized")) return value;
    throw new Error(JSON.stringify(value));
  });
  await execute("const i=document.querySelector('#fixed-frame-input'); i.value='map'; i.dispatchEvent(new Event('change',{bubbles:true}));");
  await waitFor("fixed-frame reset", async () => (await execute("return document.querySelector('#fixed-frame-input')?.value==='map' && [...document.querySelectorAll('.layer-row')].filter((row)=>row.textContent.includes('READY')).length>=10")));

  await execute(`const row=[...document.querySelectorAll('.topic-row')].find((item)=>item.querySelector('strong')?.textContent==='/demo/custom_status'); row?.querySelector('button[data-kind="raw"]')?.click();`);
  const custom = await waitFor("custom schema raw inspector", async () => {
    const value = await execute(`return {
      text: document.querySelector('#aux-dock')?.textContent ?? '',
      layers: Number(document.querySelector('#layer-count')?.textContent),
      rawReady: [...document.querySelectorAll('.layer-row')].some((row)=>row.textContent.includes('/demo/custom_status') && row.textContent.includes('RAW') && row.textContent.includes('READY')),
    };`);
    return value.text.includes("score") && value.text.includes("inliers") && value.text.includes("residuals") && value.rawReady ? value : undefined;
  });
  await execute(`const button=[...document.querySelectorAll('[data-plot-field]')].find((candidate)=>candidate.textContent.includes('score')); button?.click();`);
  const customPlot = await waitFor("custom numeric field plot", async () => {
    const value = await execute(`return {
      plots: document.querySelectorAll('.plot-window canvas').length,
      layers: Number(document.querySelector('#layer-count')?.textContent),
      customReady: [...document.querySelectorAll('.layer-row')].filter((row)=>row.textContent.includes('/demo/custom_status') && row.textContent.includes('READY')).length,
    };`);
    return value.plots >= 2 && value.customReady >= 2 ? value : undefined;
  });

  await execute("const s=document.querySelector('#demo-kind'); s.value='mcap'; s.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#demo-button').click();");
  await waitFor("shareable local MCAP", async () => await execute("return document.querySelector('.viewer-shell')?.dataset.phase==='ready' && document.querySelector('#source-name')?.textContent.includes('DEMO.MCAP') && !document.querySelector('#share-button')?.disabled"));
  await execute("document.querySelector('#share-button').click(); document.querySelector('#share-ttl').value='900'; document.querySelector('#share-create-token').value=arguments[0]; document.querySelector('#share-form').requestSubmit();", [shareCreateToken]);
  const createdShare = await waitFor("hosted share creation", async () => {
    const value = await execute(`return {
      open: document.querySelector('#share-dialog')?.open === true,
      url: document.querySelector('#share-result')?.value ?? '',
      revokeVisible: document.querySelector('#share-revoke')?.hidden === false,
      status: document.querySelector('#status-line')?.textContent ?? '',
    };`);
    return value.open && value.url.includes("/api/share/") && value.url.includes("#capability=") && value.revokeVisible ? value : undefined;
  });
  await execute("document.querySelector('#share-dialog-close').click();");

  const hostedEpoch = Number(await execute("return document.querySelector('#epoch-value')?.textContent ?? '0'"));
  await execute("document.querySelector('#remote-button').click(); const i=document.querySelector('#remote-url'); i.value=arguments[0]; document.querySelector('#remote-form').requestSubmit();", [createdShare.url]);
  const hosted = await waitFor("hosted HTTP range MCAP", async () => {
    const value = await execute(`return {
      phase: document.querySelector('.viewer-shell')?.dataset.phase,
      mode: document.querySelector('#mode-tag')?.textContent ?? '',
      source: document.querySelector('#source-name')?.textContent ?? '',
      epoch: Number(document.querySelector('#epoch-value')?.textContent ?? '0'),
      topics: Number(document.querySelector('#topic-count')?.textContent),
      layers: Number(document.querySelector('#layer-count')?.textContent),
      errors: document.querySelectorAll('.layer-error').length,
      stats: document.querySelector('#scene-stats')?.textContent ?? '',
      ready: [...document.querySelectorAll('.layer-row')].filter((row)=>row.textContent.includes('READY')).length,
      scene: document.querySelector('#scene-message')?.textContent ?? '',
      imageWidth: document.querySelector('.aux-window canvas')?.width ?? 0,
    };`);
    if (value.phase === "ready" && value.mode.includes("HOSTED") && value.source.includes("RECORDING.MCAP") && value.epoch > hostedEpoch && value.topics === 11 && value.layers >= 10 && value.ready >= 10 && value.errors === 0 && value.scene.includes("synchronized") && value.imageWidth > 0 && /[1-9][0-9]* VERTICES/.test(value.stats)) return value;
    throw new Error(JSON.stringify(value));
  });
  await execute("document.querySelector('#share-button').click(); document.querySelector('#share-revoke').click();");
  await waitFor("share revocation", async () => await execute("return document.querySelector('#share-dialog')?.open===true && document.querySelector('#share-revoke')?.hidden===true"));
  const revokedUrl = new globalThis.URL(createdShare.url);
  const revokedCapability = new globalThis.URLSearchParams(revokedUrl.hash.slice(1)).get("capability");
  revokedUrl.hash = "";
  const revokedResponse = await globalThis.fetch(revokedUrl, { headers: { authorization: `Bearer ${revokedCapability}`, range: "bytes=0-0" } });
  if (revokedResponse.status !== 403) throw new Error(`Revoked share remained readable: HTTP ${revokedResponse.status}`);
  await execute("document.querySelector('#share-dialog-close').click();");
  const sceneScreenshot = await command(`/session/${sessionId}/screenshot`);
  const frameIntervals = await executeAsync(`const done=arguments[arguments.length-1]; const values=[]; let before; const sample=(now)=>{ if(before!==undefined) values.push(now-before); before=now; if(values.length>=120) done(values); else requestAnimationFrame(sample); }; requestAnimationFrame(sample);`);
  const browserFrameTiming = {
    samples: frameIntervals.length,
    p50Ms: Math.round(percentile(frameIntervals, 0.5) * 1000) / 1000,
    p95Ms: Math.round(percentile(frameIntervals, 0.95) * 1000) / 1000,
    p99Ms: Math.round(percentile(frameIntervals, 0.99) * 1000) / 1000,
    maxMs: Math.round(Math.max(...frameIntervals) * 1000) / 1000,
  };

  await execute("document.querySelector('#live-button').click(); document.querySelector('#live-endpoint').value=arguments[0]; document.querySelector('#live-token').value='browser-e2e-token'; document.querySelector('#live-form').requestSubmit();", [`ws://127.0.0.1:${fixture.port}/live`]);
  const live = await waitFor("subscribe-only ROS2 TF, LaserScan, and numeric render", async () => {
    const value = await execute(`return {
      phase: document.querySelector('.viewer-shell')?.dataset.phase,
      mode: document.querySelector('#mode-tag')?.textContent ?? '',
      source: document.querySelector('#source-name')?.textContent ?? '',
      topics: Number(document.querySelector('#topic-count')?.textContent),
      layers: Number(document.querySelector('#layer-count')?.textContent),
      errors: document.querySelectorAll('.layer-error').length,
      ready: [...document.querySelectorAll('.layer-row')].filter((row)=>row.textContent.includes('READY')).length,
      tf: [...document.querySelectorAll('.layer-row')].some((row)=>row.textContent.includes('/tf') && row.textContent.includes('READY')),
      scan: [...document.querySelectorAll('.layer-row')].some((row)=>row.textContent.includes('/live/scan') && row.textContent.includes('READY')),
      plot: [...document.querySelectorAll('.layer-row')].some((row)=>row.textContent.includes('/live/value') && row.textContent.includes('READY')),
      scene: document.querySelector('#scene-message')?.textContent ?? '',
      stats: document.querySelector('#scene-stats')?.textContent ?? '',
    };`);
    return (value.phase === "ready" || value.phase === "degraded") && value.mode.includes("LIVE") && value.source.includes("SECURE LIVE RELAY") && value.topics === 3 && value.layers >= 3 && value.ready >= 3 && value.errors === 0 && value.tf && value.scan && value.plot && value.scene.includes("synchronized") && /[1-9][0-9]* VERTICES/.test(value.stats) ? value : undefined;
  });

  const liveScreenshot = await command(`/session/${sessionId}/screenshot`);
  const screenshotPath = resolve(process.env.E2E_SCREENSHOT ?? "/tmp/ros-web-viewer-browser-e2e.png");
  const liveScreenshotPath = screenshotPath.replace(/\.png$/u, "-live.png");
  await mkdir(dirname(screenshotPath), { recursive: true });
  await writeFile(screenshotPath, Buffer.from(sceneScreenshot, "base64"));
  await writeFile(liveScreenshotPath, Buffer.from(liveScreenshot, "base64"));
  process.stdout.write(`${JSON.stringify({ viewerUrl, environment, results, concurrentRos2, ros2NamespaceBeforeSwitch, ros2Reopen, displayConfiguration, seek, fixedFrame, custom: { layers: custom.layers, rawReady: custom.rawReady }, customPlot, createdShare: { url: createdShare.url.replace(/#.*$/u, "#capability=<redacted>"), revokedStatus: revokedResponse.status }, hosted, browserFrameTiming, live, screenshotPath, liveScreenshotPath }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n${driverLog}\n`);
  process.exitCode = 1;
} finally {
  if (sessionId) await command(`/session/${sessionId}`, "DELETE").catch(() => undefined);
  driver.kill("SIGTERM");
  await new Promise((resolveClose) => fixture.server.close(resolveClose));
}
