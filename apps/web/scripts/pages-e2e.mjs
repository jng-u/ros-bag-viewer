import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

// Emulate a Pages project site: subpath assets, no API, and no COOP/COEP.
const root = resolve("apps/web/dist-web");
const prefix = "/ros-bag-viewer/";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" };
await stat(resolve(root, "index.html"));
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new globalThis.URL(request.url, "http://localhost").pathname);
    if (!pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
    const path = resolve(root, pathname.slice(prefix.length) || "index.html");
    if (!path.startsWith(`${root}${sep}`)) { response.writeHead(404); response.end(); return; }
    const file = await stat(path);
    if (!file.isFile()) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream", "content-length": file.size });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404); response.end();
  }
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
try {
  const child = spawn(process.execPath, ["apps/web/scripts/browser-e2e.mjs"], {
    stdio: "inherit",
    env: { ...process.env, VIEWER_URL: `http://127.0.0.1:${server.address().port}${prefix}`, VIEWER_ONLY_E2E: "1", STATIC_HOST_E2E: "1" },
  });
  process.exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
