import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createShareServer } from "../src/server.mjs";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!(); });

describe("minimal hosted share service", () => {
  it("creates immutable range links and enforces revocation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ros-viewer-share-"));
    let now = 1_000_000;
    const fixture = await createShareServer({ dataDir: directory, now: () => now, allowAnonymousCreate: true });
    await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => fixture.server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
    const address = fixture.server.address();
    if (!address || typeof address === "string") throw new Error("share test server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const recording = new Uint8Array([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a, 1, 2]);
    const created = await fetch(`${base}/api/share`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", origin: "http://127.0.0.1:8080", "x-recording-name": encodeURIComponent("trial.mcap"), "x-share-ttl-seconds": "300" },
      body: recording,
    });
    expect(created.status).toBe(201);
    const descriptor = await created.json() as { recordingUrl: string; revokeUrl: string; revokeToken: string; expiresAtMs: number };
    const link = new URL(descriptor.recordingUrl, base);
    const capability = new URLSearchParams(link.hash.slice(1)).get("capability")!;
    link.hash = "";
    const firstRange = await fetch(link, { headers: { authorization: `Bearer ${capability}`, range: "bytes=8-9" } });
    expect(firstRange.status).toBe(206);
    expect(firstRange.headers.get("content-range")).toBe("bytes 8-9/10");
    expect([...new Uint8Array(await firstRange.arrayBuffer())]).toEqual([1, 2]);

    expect((await fetch(new URL(descriptor.revokeUrl, base), { method: "POST", headers: { authorization: `Bearer ${descriptor.revokeToken}` } })).status).toBe(204);
    expect((await fetch(link, { headers: { authorization: `Bearer ${capability}`, range: "bytes=0-0" } })).status).toBe(403);
    now = descriptor.expiresAtMs + 24 * 60 * 60 * 1_000 + 1;
    await fixture.sweep();
    expect(fixture.sessions.size).toBe(0);
  });

  it("rejects anonymous remote creation and non-MCAP uploads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ros-viewer-share-"));
    const fixture = await createShareServer({ dataDir: directory, allowAnonymousCreate: true });
    await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => fixture.server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
    const address = fixture.server.address();
    if (!address || typeof address === "string") throw new Error("share test server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "content-type": "application/octet-stream", "x-share-ttl-seconds": "300" };
    expect((await fetch(`${base}/api/share`, { method: "POST", headers, body: new Uint8Array(8) })).status).toBe(403);
    expect((await fetch(`${base}/api/share`, { method: "POST", headers: { ...headers, origin: "http://localhost:8080" }, body: new Uint8Array(8) })).status).toBe(415);
  });

  it("requires the configured creation token even from loopback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ros-viewer-share-"));
    const fixture = await createShareServer({ dataDir: directory, createToken: "0123456789abcdef" });
    await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => fixture.server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
    const address = fixture.server.address();
    if (!address || typeof address === "string") throw new Error("share test server did not bind");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/share`, {
      method: "POST",
      headers: { origin: "http://localhost:8080", "content-type": "application/octet-stream", "x-share-ttl-seconds": "300", "x-share-create-token": "wrong-token-value" },
      body: new Uint8Array([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a]),
    });
    expect(response.status).toBe(401);
  });

  it("reconciles interrupted uploads and torn metadata before quota accounting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ros-viewer-share-"));
    const uploadId = "1".repeat(32);
    const orphanId = "2".repeat(32);
    const tornId = "3".repeat(32);
    await Promise.all([
      writeFile(join(directory, `.${uploadId}.upload`), new Uint8Array(1024)),
      writeFile(join(directory, `${orphanId}.mcap`), new Uint8Array(1024)),
      writeFile(join(directory, `${tornId}.json`), "{not-json"),
      writeFile(join(directory, `${tornId}.mcap`), new Uint8Array(1024)),
    ]);
    const fixture = await createShareServer({ dataDir: directory, allowAnonymousCreate: true });
    await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => fixture.server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
    expect(fixture.sessions.size).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  });
});
