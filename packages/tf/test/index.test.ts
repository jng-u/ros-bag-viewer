import { describe, expect, it } from "vitest";

import { emitV1SemanticEvent } from "../../../tests/support/v1-conformance-event.js";
import { TfBuffer, type TfSample } from "../src/index.js";

const identity = { x: 0, y: 0, z: 0, w: 1 };

function sample(overrides: Partial<TfSample> = {}): TfSample {
  return {
    parentFrame: "map",
    childFrame: "base",
    timeNanos: 0n,
    isStatic: false,
    epoch: 1,
    translation: { x: 0, y: 0, z: 0 },
    rotation: identity,
    ...overrides,
  };
}

describe("TF buffer", () => {
  it("interpolates bracketing transforms without latest fallback", () => {
    const buffer = new TfBuffer(1, 8);
    buffer.add(sample({ timeNanos: 0n, translation: { x: 0, y: 0, z: 0 } }));
    buffer.add(sample({ timeNanos: 10n, translation: { x: 10, y: 0, z: 0 } }));
    const observed = buffer.lookup("map", "base", 5n, 1);
    expect(observed).toMatchObject({
      ok: true,
      interpolated: true,
      transform: { translation: { x: 5, y: 0, z: 0 } },
    });
    emitV1SemanticEvent({ schemaVersion: 1, domain: "time-tf", result: "pass", code: "tf-interpolation", facts: {
      ok: observed.ok, interpolated: observed.ok ? observed.interpolated : false,
    } });
  });

  it("rejects extrapolation outside bracketing samples", () => {
    const buffer = new TfBuffer(1, 8);
    buffer.add(sample({ timeNanos: 0n }));
    buffer.add(sample({ timeNanos: 10n, translation: { x: 10, y: 0, z: 0 } }));
    const observed = buffer.lookup("map", "base", 11n, 1);
    expect(observed).toMatchObject({
      ok: false,
      reason: "extrapolation",
    });
    emitV1SemanticEvent({ schemaVersion: 1, domain: "time-tf", result: "pass", code: "tf-extrapolation", facts: {
      ok: observed.ok, reason: observed.ok ? "none" : observed.reason,
    } });
  });

  it("composes static chains and reports missing paths", () => {
    const buffer = new TfBuffer(1, 8);
    buffer.add(sample({ isStatic: true, parentFrame: "map", childFrame: "odom", translation: { x: 1, y: 0, z: 0 } }));
    buffer.add(sample({ isStatic: true, parentFrame: "odom", childFrame: "base", translation: { x: 2, y: 0, z: 0 } }));
    const composed = buffer.lookup("map", "base", 100n, 1);
    expect(composed).toMatchObject({
      ok: true,
      transform: { translation: { x: 3, y: 0, z: 0 } },
    });
    const missing = buffer.lookup("camera", "base", 100n, 1);
    expect(missing).toMatchObject({ ok: false, reason: "missing" });
    emitV1SemanticEvent({ schemaVersion: 1, domain: "time-tf", result: "pass", code: "tf-missing", facts: {
      composed: composed.ok, missingReason: missing.ok ? "none" : missing.reason,
    } });
  });

  it("detects cycles and invalidates all history on epoch advance", () => {
    const buffer = new TfBuffer(1, 8);
    buffer.add(sample({ isStatic: true, parentFrame: "b", childFrame: "a" }));
    buffer.add(sample({ isStatic: true, parentFrame: "a", childFrame: "b" }));
    expect(buffer.lookup("root", "a", 0n, 1)).toMatchObject({ ok: false, reason: "cycle" });
    buffer.advanceEpoch(2);
    expect(buffer.lookup("root", "a", 0n, 1)).toMatchObject({ ok: false, reason: "stale-epoch" });
    expect(buffer.lookup("root", "a", 0n, 2)).toMatchObject({ ok: false, reason: "missing" });
  });
});
