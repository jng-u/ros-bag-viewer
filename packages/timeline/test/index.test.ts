import { describe, expect, it } from "vitest";

import { emitV1SemanticEvent } from "../../../tests/support/v1-conformance-event.js";
import { BoundedTimelineQueue, normalizeSchedulingTime, stableTimelineSort } from "../src/index.js";

describe("timeline normalization", () => {
  it("selects valid record timestamps exactly", () => {
    const observed = normalizeSchedulingTime([
      { source: "record", valueNanos: 10n },
      { source: "header", valueNanos: 12n },
    ]);
    expect(observed).toEqual({ valueNanos: 10n, source: "record", diagnostics: [] });
    emitV1SemanticEvent({ schemaVersion: 1, domain: "time-tf", result: "pass", code: "record-time", facts: {
      source: observed.source, valueNanos: observed.valueNanos.toString(), diagnostics: observed.diagnostics.length,
    } });
  });

  it("selects valid header timestamps with diagnosed fallback", () => {
    const observed = normalizeSchedulingTime([
        { source: "record", valueNanos: -1n },
        { source: "header", valueNanos: 12n },
      ]);
    expect(observed).toEqual({
      valueNanos: 12n,
      source: "header",
      diagnostics: ["record timestamp is missing or invalid", "scheduling time fell back to header"],
    });
    expect(() => normalizeSchedulingTime([{ source: "record" }])).toThrow(/no valid scheduling timestamp/);
    emitV1SemanticEvent({ schemaVersion: 1, domain: "time-tf", result: "pass", code: "header-time", facts: {
      source: observed.source, valueNanos: observed.valueNanos.toString(), diagnostics: observed.diagnostics.length,
    } });
  });

  it("selects valid clock timestamps with diagnosed fallback", () => {
    const observed = normalizeSchedulingTime([
      { source: "record", valueNanos: -1n },
      { source: "header" },
      { source: "clock", valueNanos: 42n },
    ]);
    expect(observed).toEqual({
      valueNanos: 42n,
      source: "clock",
      diagnostics: [
        "record timestamp is missing or invalid",
        "header timestamp is missing or invalid",
        "scheduling time fell back to clock",
      ],
    });
    emitV1SemanticEvent({ schemaVersion: 1, domain: "time-tf", result: "pass", code: "clock-time", facts: {
      source: observed.source, valueNanos: observed.valueNanos.toString(), diagnostics: observed.diagnostics.length,
    } });
  });

  it("sorts equal timestamps independently of arrival/chunk order", () => {
    const logical = [
      { valueNanos: 5n, sourceId: "b", channelId: "1", sourceSequence: 0n },
      { valueNanos: 5n, sourceId: "a", channelId: "2", sourceSequence: 2n },
      { valueNanos: 5n, sourceId: "a", channelId: "2", sourceSequence: 1n },
      { valueNanos: 4n, sourceId: "z", channelId: "9", sourceSequence: 9n },
    ];
    const expected = [9n, 1n, 2n, 0n];
    expect(stableTimelineSort(logical).map((message) => message.sourceSequence)).toEqual(expected);
    expect(stableTimelineSort([...logical].reverse()).map((message) => message.sourceSequence)).toEqual(expected);
  });
});

describe("bounded timeline queue", () => {
  it("evicts deterministically and clears stale work on epoch advance", () => {
    const queue = new BoundedTimelineQueue(1, 2, 5);
    queue.push({ valueNanos: 2n, sourceId: "a", channelId: "a", sourceSequence: 2n, epoch: 1, payloadBytes: 3 });
    queue.push({ valueNanos: 1n, sourceId: "a", channelId: "a", sourceSequence: 1n, epoch: 1, payloadBytes: 3 });
    expect(queue.drain().map((message) => message.sourceSequence)).toEqual([2n]);
    expect(queue.telemetry().droppedMessages).toBe(1);
    queue.push({ valueNanos: 3n, sourceId: "a", channelId: "a", sourceSequence: 3n, epoch: 1, payloadBytes: 1 });
    queue.advanceEpoch(2);
    expect(queue.telemetry()).toMatchObject({ messages: 0, payloadBytes: 0 });
    expect(() =>
      queue.push({ valueNanos: 4n, sourceId: "a", channelId: "a", sourceSequence: 4n, epoch: 1, payloadBytes: 1 }),
    ).toThrow(/stale-epoch/);
  });
});
