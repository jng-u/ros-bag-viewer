import { describe, expect, it, vi } from "vitest";

vi.mock("seek-bzip", () => ({
  default: {
    decode(_compressed: Uint8Array, writer: { write(bytes: Uint8Array, sourceOffset: number, length: number): number }) {
      writer.write(Uint8Array.of(7), 1, 1);
    },
  },
}));

import { decodeBzip } from "../src/browser-bzip.js";

describe("browser BZip2 compatibility boundary", () => {
  it("rejects an invalid decoder write range instead of substituting zero bytes", async () => {
    await expect(decodeBzip(Uint8Array.of(1), 1, new AbortController().signal)).rejects.toThrow(/invalid source range/);
  });
});
