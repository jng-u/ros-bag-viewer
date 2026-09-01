import { describe, expect, it } from "vitest";

import { rawImageToRgba } from "../src/image-raster.js";

describe("raw image raster conversion", () => {
  it("converts padded BGR rows into RGBA without exposing row padding", () => {
    expect(rawImageToRgba({
      frameId: "camera",
      width: 2,
      height: 1,
      encoding: "bgr8",
      step: 8,
      isBigEndian: false,
      data: Uint8Array.of(0, 0, 255, 0, 255, 0, 99, 99),
    })).toEqual(Uint8ClampedArray.of(255, 0, 0, 255, 0, 255, 0, 255));
  });
});
