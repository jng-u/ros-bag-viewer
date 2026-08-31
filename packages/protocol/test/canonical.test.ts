import { describe, expect, it, vi } from "vitest";

import { CanonicalDataError, canonicalizePlainData } from "../src/canonical.js";

describe("plain-data canonicalization bounds", () => {
  it("rejects attacker-sized and sparse arrays before length-sized allocation", () => {
    const target: unknown[] = [];
    target.length = 0xffff_ffff;
    const ownKeys = vi.fn(Reflect.ownKeys);
    const hostile = new Proxy(target, { ownKeys });
    expect(() => canonicalizePlainData(hostile, { label: "hostile", maxItems: 8, maxBytes: 1_024 }))
      .toThrowError(expect.objectContaining<Partial<CanonicalDataError>>({ code: "item-limit" }));
    expect(ownKeys).not.toHaveBeenCalled();
    expect(() => canonicalizePlainData(new Array(3), { label: "sparse" })).toThrow(/dense/);
  });

  it("rejects cycles and repeated references as non-tree input", () => {
    const objectCycle: Record<string, unknown> = {};
    objectCycle.self = objectCycle;
    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);
    const shared = { value: 1 };
    for (const value of [objectCycle, arrayCycle, { first: shared, second: shared }]) {
      expect(() => canonicalizePlainData(value, { label: "graph" }))
        .toThrowError(expect.objectContaining<Partial<CanonicalDataError>>({ code: "cycle-or-repeat" }));
    }
  });

  it("accounts exact canonical JSON UTF-8 bytes before construction", () => {
    for (const value of [
      { text: "😀\n\"" },
      { ["x".repeat(64)]: "value" },
      { text: "\\\u0001" },
      { text: "\ud800" },
    ]) {
      const exact = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      expect(canonicalizePlainData(value, { label: "bytes", maxBytes: exact })).toEqual(value);
      expect(() => canonicalizePlainData(value, { label: "bytes", maxBytes: exact - 1 }))
        .toThrowError(expect.objectContaining<Partial<CanonicalDataError>>({ code: "byte-limit" }));
    }
  });
});
