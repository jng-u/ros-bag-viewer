import { describe, expect, it } from "vitest";

import { formatRawPreview } from "../src/raw-preview.js";

describe("raw byte preview", () => {
  it("shows bounded offsets, hexadecimal bytes, ASCII, and truncation", () => {
    const bytes = Uint8Array.from({ length: 40 }, (_, index) => index + 0x20);
    const preview = formatRawPreview(bytes, 20);
    expect(preview.text).toContain("00000000");
    expect(preview.text).toContain("20 21 22 23");
    expect(preview.text).toContain(' !"#');
    expect(preview.shownBytes).toBe(20);
    expect(preview.truncatedBytes).toBe(20);
  });
});
