import { describe, expect, it, vi } from "vitest";

import { ReferenceCountedPayloadLease, type NormalizedMessageEnvelope, type SourceEpoch } from "@ros-web-viewer/core-model";
import { BrowserDisplayLifecycle } from "../src/browser-display-lifecycle.js";

function envelope(epoch: SourceEpoch): NormalizedMessageEnvelope {
  return {
    version: 1,
    sourceId: "source" as NormalizedMessageEnvelope["sourceId"],
    channelId: "topic" as NormalizedMessageEnvelope["channelId"],
    sourceSequence: 1n,
    epoch,
    schedulingTime: { valueNanos: 10n, source: "record", epoch },
    tfQueryTime: { valueNanos: 8n, source: "header", epoch },
    schema: { capability: "schema-present", typeName: "sensor_msgs/PointCloud2", provenance: [] },
    payload: new ReferenceCountedPayloadLease(epoch, 1, Uint8Array.of(1)),
    nativeTypeMetadata: {},
    diagnostics: [],
  };
}

describe("browser display lifecycle", () => {
  it("routes a normalized envelope through attach, update, render, retry, and dispose", async () => {
    const updates: NormalizedMessageEnvelope[] = [];
    const attach = vi.fn();
    const render = vi.fn();
    const dispose = vi.fn();
    let fail = true;
    const lifecycle = new BrowserDisplayLifecycle<string>(async (message, context) => {
      expect(context).toBe("prepared");
      updates.push(message);
      if (fail) throw new Error("decode failed");
    }, attach, render, dispose);
    lifecycle.register();
    lifecycle.instantiate();
    lifecycle.configure();
    lifecycle.attachSource(3 as SourceEpoch);
    lifecycle.prepare("prepared");
    await expect(lifecycle.update(envelope(3 as SourceEpoch))).rejects.toThrow("decode failed");
    expect(lifecycle.state).toBe("error");

    fail = false;
    lifecycle.prepare("prepared");
    await lifecycle.update(envelope(3 as SourceEpoch));
    lifecycle.render();
    lifecycle.dispose();

    expect(updates).toHaveLength(2);
    expect(updates[1]?.tfQueryTime?.valueNanos).toBe(8n);
    expect(attach).toHaveBeenCalledWith(3);
    expect(render).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(lifecycle.state).toBe("disposed");
  });

  it("rejects an envelope from another source epoch", async () => {
    const lifecycle = new BrowserDisplayLifecycle<string>(async () => undefined, () => undefined, () => undefined, () => undefined);
    lifecycle.instantiate();
    lifecycle.configure();
    lifecycle.attachSource(1 as SourceEpoch);
    lifecycle.prepare("prepared");
    await expect(lifecycle.update(envelope(2 as SourceEpoch))).rejects.toThrow(/unattached source epoch/);
  });
});
