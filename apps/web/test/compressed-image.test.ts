import { describe, expect, it } from "vitest";

import { compressedImageDimensions } from "../src/compressed-image.js";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

describe("compressed image dimension preflight", () => {
  it("reads PNG dimensions before browser raster allocation", () => {
    expect(compressedImageDimensions(png(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
  });

  it("reads JPEG SOF dimensions without decoding pixels", () => {
    const bytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x01, 0xe0, 0x02, 0x80, 0xff, 0xd9);
    expect(compressedImageDimensions(bytes, "image/jpeg")).toEqual({ width: 640, height: 480 });
  });

  it("reads WebP VP8X dimensions without decoding pixels", () => {
    const bytes = new Uint8Array(30);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
    new DataView(bytes.buffer).setUint32(16, 10, true);
    bytes.set([0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00], 24);
    expect(compressedImageDimensions(bytes, "image/webp")).toEqual({ width: 640, height: 480 });
  });

  it("exposes oversized dimensions before createImageBitmap can allocate them", () => {
    const result = compressedImageDimensions(png(100_000, 100_000), "image/png");
    expect(result.width * result.height).toBeGreaterThan(16_000_000);
  });

  it("fails closed on malformed or dimensionless headers", () => {
    expect(() => compressedImageDimensions(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9), "image/jpeg")).toThrow(/no bounded frame dimensions/u);
    expect(() => compressedImageDimensions(new Uint8Array(12), "image/webp")).toThrow(/invalid or truncated/u);
  });
});
