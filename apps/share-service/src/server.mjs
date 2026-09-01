import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MIN_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_SESSIONS = 64;
const MAX_STORED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 2;
const ID_PATTERN = /^[a-f0-9]{32}$/u;
const MCAP_MAGIC = Buffer.from([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a]);

const json = (response, status, value) => {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "cache-control": "no-store", "content-length": body.byteLength, "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
  response.end(body);
};

const digest = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const safeEqual = (left, right) => {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
};

function bearer(request) {
  const match = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u);
  return match?.[1];
}

function loopbackOrigin(value) {
  if (typeof value !== "string") return false;
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new globalThis.URL(value).hostname); } catch { return false; }
}

function recordingName(value) {
  if (typeof value !== "string" || value.length > 1_024) return "recording.mcap";
  try {
    const decoded = decodeURIComponent(value).normalize("NFC");
    const name = basename(decoded).replace(/[^A-Za-z0-9._ -]/gu, "_").slice(0, 128);
    return name.toLocaleLowerCase().endsWith(".mcap") ? name : "recording.mcap";
  } catch { return "recording.mcap"; }
}

function validMetadata(value) {
  return value && typeof value === "object" && ID_PATTERN.test(value.id)
    && /^[a-f0-9]{64}$/u.test(value.capabilityDigest) && /^[a-f0-9]{64}$/u.test(value.revokeDigest)
    && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0 && value.sizeBytes <= MAX_UPLOAD_BYTES
    && Number.isSafeInteger(value.expiresAtMs) && Number.isSafeInteger(value.retentionAtMs)
    && /^[a-f0-9]{64}$/u.test(value.sha256);
}

export async function createShareServer({ dataDir, now = Date.now, createToken = "", allowAnonymousCreate = false }) {
  await mkdir(dataDir, { recursive: true });
  const sessions = new Map();
  let activeUploads = 0;
  let reservedUploadBytes = 0;

  const startupNames = await readdir(dataDir);
  for (const name of startupNames) {
    if (/^\.[a-f0-9]{32}\.upload$/u.test(name) || /^\.[a-f0-9]{32}\.metadata-[a-f0-9]+\.tmp$/u.test(name)) {
      await rm(join(dataDir, name), { force: true });
    }
  }
  for (const name of startupNames) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dataDir, name), "utf8"));
      if (!validMetadata(parsed) || name !== `${parsed.id}.json`) throw new Error("invalid share metadata");
      const recording = await stat(join(dataDir, `${parsed.id}.mcap`));
      if (!recording.isFile() || recording.size !== parsed.sizeBytes) throw new Error("share recording does not match metadata");
      sessions.set(parsed.id, parsed);
    } catch {
      await rm(join(dataDir, name), { force: true });
      const id = name.slice(0, -5);
      if (ID_PATTERN.test(id)) await rm(join(dataDir, `${id}.mcap`), { force: true });
    }
  }
  for (const name of startupNames) {
    const match = name.match(/^([a-f0-9]{32})\.mcap$/u);
    if (match && !sessions.has(match[1])) await rm(join(dataDir, name), { force: true });
  }

  const persist = async (metadata) => {
    const temporaryPath = join(dataDir, `.${metadata.id}.metadata-${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, join(dataDir, `${metadata.id}.json`));
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  };
  let sweepPromise;
  const runSweep = async () => {
    const current = now();
    for (const [id, metadata] of sessions) {
      if (metadata.retentionAtMs > current) continue;
      sessions.delete(id);
      await Promise.allSettled([rm(join(dataDir, `${id}.mcap`), { force: true }), rm(join(dataDir, `${id}.json`), { force: true })]);
    }
  };
  const sweep = () => {
    sweepPromise ??= runSweep().finally(() => { sweepPromise = undefined; });
    return sweepPromise;
  };
  await sweep();

  const server = createServer(async (request, response) => {
    try {
      response.setHeader("referrer-policy", "no-referrer");
      if (request.url === "/healthz") { response.writeHead(200, { "cache-control": "no-store" }); response.end("ok"); return; }
      if (request.method === "OPTIONS") { response.writeHead(204, { "access-control-allow-headers": "authorization, content-type, range, x-recording-name, x-share-ttl-seconds", "access-control-allow-methods": "GET, HEAD, POST, OPTIONS" }); response.end(); return; }
      await sweep();

      if (request.method === "POST" && request.url === "/api/share") {
        const suppliedCreateToken = request.headers["x-share-create-token"];
        if (createToken) {
          const suppliedDigest = typeof suppliedCreateToken === "string" ? digest(suppliedCreateToken) : "";
          if (!safeEqual(suppliedDigest, digest(createToken))) { json(response, 401, { error: "share creation is not authorized" }); return; }
        } else if (!allowAnonymousCreate || !loopbackOrigin(request.headers.origin)) {
          json(response, 403, { error: "share creation requires a configured token; anonymous creation is available only in explicit loopback development mode" });
          return;
        }
        const contentLength = Number(request.headers["content-length"]);
        const ttlSeconds = Number(request.headers["x-share-ttl-seconds"] ?? 3600);
        if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_UPLOAD_BYTES) { json(response, 413, { error: "MCAP upload must declare 1–536870912 bytes" }); return; }
        if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) { json(response, 400, { error: "share TTL must be 300–86400 seconds" }); return; }
        const storedBytes = [...sessions.values()].reduce((total, metadata) => total + metadata.sizeBytes, 0);
        if (sessions.size + activeUploads >= MAX_SESSIONS || storedBytes + reservedUploadBytes + contentLength > MAX_STORED_BYTES) { json(response, 507, { error: "share storage quota is exhausted" }); return; }
        if (activeUploads >= MAX_CONCURRENT_UPLOADS) { json(response, 429, { error: "too many concurrent share uploads" }); return; }
        activeUploads += 1;
        reservedUploadBytes += contentLength;
        let uploadReleased = false;
        const releaseUpload = () => {
          if (uploadReleased) return;
          uploadReleased = true;
          activeUploads -= 1;
          reservedUploadBytes -= contentLength;
        };
        response.once("finish", releaseUpload);
        response.once("close", releaseUpload);
        const id = randomBytes(16).toString("hex");
        const capability = token();
        const revokeToken = token();
        const temporaryPath = join(dataDir, `.${id}.upload`);
        const finalPath = join(dataDir, `${id}.mcap`);
        const handle = await open(temporaryPath, "wx", 0o600);
        const hash = createHash("sha256");
        let received = 0;
        let prefix = Buffer.alloc(0);
        try {
          for await (const value of request) {
            const chunk = Buffer.from(value);
            received += chunk.byteLength;
            if (received > contentLength || received > MAX_UPLOAD_BYTES) throw new Error("upload exceeds declared size");
            if (prefix.byteLength < MCAP_MAGIC.byteLength) prefix = Buffer.concat([prefix, chunk.subarray(0, MCAP_MAGIC.byteLength - prefix.byteLength)]);
            hash.update(chunk);
            await handle.write(chunk);
          }
        } catch (error) {
          await handle.close();
          await rm(temporaryPath, { force: true });
          throw error;
        }
        await handle.close();
        if (received !== contentLength) { await rm(temporaryPath, { force: true }); json(response, 400, { error: "upload length did not match Content-Length" }); return; }
        if (!prefix.equals(MCAP_MAGIC)) { await rm(temporaryPath, { force: true }); json(response, 415, { error: "share upload is not an MCAP file" }); return; }
        await rename(temporaryPath, finalPath);
        const createdAtMs = now();
        const metadata = {
          id,
          name: recordingName(request.headers["x-recording-name"]),
          sizeBytes: received,
          sha256: hash.digest("hex"),
          capabilityDigest: digest(capability),
          revokeDigest: digest(revokeToken),
          createdAtMs,
          expiresAtMs: createdAtMs + ttlSeconds * 1_000,
          retentionAtMs: createdAtMs + ttlSeconds * 1_000 + RETENTION_MS,
        };
        try {
          await persist(metadata);
          sessions.set(id, metadata);
        } catch (error) {
          await Promise.allSettled([rm(finalPath, { force: true }), rm(join(dataDir, `${id}.json`), { force: true })]);
          throw error;
        }
        json(response, 201, {
          recordingUrl: `/api/share/${id}/recording.mcap#capability=${capability}`,
          revokeUrl: `/api/share/${id}/revoke`,
          revokeToken,
          expiresAtMs: metadata.expiresAtMs,
        });
        return;
      }

      const match = request.url?.match(/^\/api\/share\/([a-f0-9]{32})\/(recording\.mcap|revoke)$/u);
      if (!match) { json(response, 404, { error: "not found" }); return; }
      const [, id, operation] = match;
      const metadata = sessions.get(id);
      if (!metadata) { json(response, 404, { error: "share is unavailable" }); return; }

      if (operation === "revoke" && request.method === "POST") {
        const credential = bearer(request);
        if (!credential || !safeEqual(digest(credential), metadata.revokeDigest)) { json(response, 403, { error: "share revocation denied" }); return; }
        if (!metadata.revokedAtMs) { metadata.revokedAtMs = now(); await persist(metadata); }
        response.writeHead(204, { "cache-control": "no-store" }); response.end(); return;
      }

      if (operation !== "recording.mcap" || !["GET", "HEAD"].includes(request.method ?? "")) { json(response, 405, { error: "method not allowed" }); return; }
      const credential = bearer(request);
      if (!credential || !safeEqual(digest(credential), metadata.capabilityDigest) || metadata.revokedAtMs || metadata.expiresAtMs <= now()) { json(response, 403, { error: "share access denied" }); return; }
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/u);
      if (!range) { response.writeHead(416, { "accept-ranges": "bytes", "content-range": `bytes */${metadata.sizeBytes}` }); response.end(); return; }
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= metadata.sizeBytes) { response.writeHead(416, { "content-range": `bytes */${metadata.sizeBytes}` }); response.end(); return; }
      const recordingHandle = await open(join(dataDir, `${id}.mcap`), "r");
      const recordingStream = recordingHandle.createReadStream({ start, end });
      recordingStream.once("error", (error) => {
        if (!response.headersSent) json(response, 500, { error: "share recording is unavailable" });
        else response.destroy(error);
      });
      response.writeHead(206, {
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${metadata.sizeBytes}`,
        "content-type": "application/octet-stream",
        etag: `"sha256-${metadata.sha256}"`,
      });
      if (request.method === "HEAD") { recordingStream.destroy(); response.end(); return; }
      recordingStream.pipe(response);
    } catch (error) {
      if (!response.headersSent) json(response, 500, { error: error instanceof Error ? error.message : "share service failure" });
      else response.destroy(error instanceof Error ? error : undefined);
    }
  });

  const sweepTimer = globalThis.setInterval(() => { void sweep(); }, 60_000);
  sweepTimer.unref();
  server.once("close", () => globalThis.clearInterval(sweepTimer));
  return { server, sessions, sweep };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8090);
  const { server } = await createShareServer({
    dataDir: process.env.SHARE_DATA_DIR ?? "/data",
    createToken: process.env.SHARE_CREATE_TOKEN ?? "",
    allowAnonymousCreate: process.env.SHARE_ALLOW_ANONYMOUS_CREATE === "true",
  });
  server.listen(port, "0.0.0.0", () => process.stdout.write(`share service listening on ${port}\n`));
}
