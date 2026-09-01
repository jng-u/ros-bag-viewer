import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { decodeSemanticMessage } from "@ros-web-viewer/m1-integration";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserRecordingRuntime, HttpRangeSource } from "../src/browser-runtime.js";

afterEach(() => vi.unstubAllGlobals());

describe("hosted indexed MCAP range runtime", () => {
  it.each([
    ["missing", undefined],
    ["mismatched", "2"],
  ] as const)("rejects a %s Content-Length before reading the hosted body", async (_case, contentLength) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(Uint8Array.of(1)); controller.close(); }, cancel() { cancelled = true; } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-0/8", ...(contentLength ? { "Content-Length": contentLength } : {}) },
    })));
    await expect(new HttpRangeSource(8n, "https://example.invalid/demo.mcap").read({ offset: 0n, length: 1n }, new AbortController().signal)).rejects.toThrow(/exact Content-Length/u);
    expect(cancelled).toBe(true);
  });

  it("cancels an oversized hosted response stream after at most the requested range", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Uint8Array.of(1, 2)); },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 206,
      headers: { "Content-Range": "bytes 0-0/8", "Content-Length": "1" },
    })));
    await expect(new HttpRangeSource(8n, "https://example.invalid/demo.mcap").read({ offset: 0n, length: 1n }, new AbortController().signal)).rejects.toThrow(/exceeded its requested/u);
    expect(cancelled).toBe(true);
  });

  it("opens and seeks without materializing the remote recording", async () => {
    const bytes = await readFile(new URL("../public/demo.mcap", import.meta.url));
    const ranges: string[] = [];
    const authorizations: string[] = [];
    const server = createServer((request, response) => {
      const range = request.headers.range;
      if (!range) {
        response.writeHead(400).end();
        return;
      }
      ranges.push(range);
      authorizations.push(request.headers.authorization ?? "");
      const match = range.match(/^bytes=(\d+)-(\d+)$/u);
      if (!match) {
        response.writeHead(416).end();
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      response.writeHead(206, {
        "Accept-Ranges": "bytes",
        "Access-Control-Expose-Headers": "Content-Range, ETag",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`,
        ETag: '"immutable-demo"',
      });
      response.end(bytes.subarray(start, end + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test range server did not bind TCP");
      const runtime = new BrowserRecordingRuntime();
      const opened = await runtime.openHostedMcap(`http://127.0.0.1:${address.port}/demo.mcap#capability=range-secret`);
      expect(opened.topics).toHaveLength(11);
      expect(opened.indexState).toBe("indexed");
      const sample = await runtime.messageAt("/demo/points", opened.durationNanos / 2n);
      expect(decodeSemanticMessage({ channel: sample.channel, data: sample.data }).kind).toBe("pointcloud2");
      expect(ranges.length).toBeGreaterThan(1);
      expect(ranges.every((range) => /^bytes=\d+-\d+$/u.test(range))).toBe(true);
      expect(new Set(authorizations)).toEqual(new Set(["Bearer range-secret"]));
      const transferred = ranges.reduce((total, range) => {
        const [, start = "0", end = "-1"] = range.match(/^bytes=(\d+)-(\d+)$/u) ?? [];
        return total + Number(end) - Number(start) + 1;
      }, 0);
      expect(transferred).toBeLessThan(bytes.byteLength);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("refuses a range source without an immutable validator", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(206, { "Access-Control-Expose-Headers": "Content-Range", "Content-Range": "bytes 0-0/8", "Content-Length": "1" });
      response.end(new Uint8Array([0]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
      await expect(new BrowserRecordingRuntime().openHostedMcap(`http://127.0.0.1:${address.port}/mutable.mcap`)).rejects.toThrow(/ETag or Last-Modified/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects a hosted probe without an exact one-byte Content-Length", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(206, { "Content-Range": "bytes 0-0/8", ETag: '"immutable"', "Transfer-Encoding": "chunked" });
      response.write(Uint8Array.of(0));
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
      await expect(new BrowserRecordingRuntime().openHostedMcap(`http://127.0.0.1:${address.port}/missing-length.mcap`)).rejects.toThrow(/one-byte Content-Length/u);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("validates Content-Range on every read, not only the probe", async () => {
    const bytes = await readFile(new URL("../public/demo.mcap", import.meta.url));
    let requests = 0;
    const server = createServer((request, response) => {
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/u);
      if (!range) return void response.writeHead(416).end();
      const start = Number(range[1]); const end = Number(range[2]);
      requests += 1;
      response.writeHead(206, {
        "Access-Control-Expose-Headers": "Content-Range, ETag",
        "Content-Length": end - start + 1,
        "Content-Range": requests === 1 ? `bytes 0-0/${bytes.byteLength}` : `bytes ${start + 1}-${end}/${bytes.byteLength}`,
        ETag: '"immutable-demo"',
      });
      response.end(bytes.subarray(start, end + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
      await expect(new BrowserRecordingRuntime().openHostedMcap(`http://127.0.0.1:${address.port}/bad-range.mcap`)).rejects.toThrow(/invalid Content-Range/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects a changed immutable validator on subsequent ranges", async () => {
    const bytes = await readFile(new URL("../public/demo.mcap", import.meta.url));
    let requests = 0;
    const server = createServer((request, response) => {
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/u);
      if (!range) return void response.writeHead(416).end();
      const start = Number(range[1]); const end = Number(range[2]);
      requests += 1;
      response.writeHead(206, {
        "Access-Control-Expose-Headers": "Content-Range, ETag",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`,
        ETag: requests === 1 ? '"immutable-demo"' : '"mutated-demo"',
      });
      response.end(bytes.subarray(start, end + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
      await expect(new BrowserRecordingRuntime().openHostedMcap(`http://127.0.0.1:${address.port}/mutated.mcap`)).rejects.toThrow(/immutable ETag validator changed or is missing/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects weak ETags as immutable source validators", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(206, { "Content-Range": "bytes 0-0/8", "Content-Length": "1", ETag: 'W/"mutable"' });
      response.end(new Uint8Array([0]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
      await expect(new BrowserRecordingRuntime().openHostedMcap(`http://127.0.0.1:${address.port}/weak.mcap`)).rejects.toThrow(/weak ETags/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
