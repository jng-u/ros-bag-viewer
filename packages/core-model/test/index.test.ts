import { describe, expect, it } from "vitest";

import {
  ReferenceCountedPayloadLease,
  assertBundle,
  assertEpoch,
  type SourceBundle,
  type SourceEntryId,
  type SourceEpoch,
  type SourceId,
} from "../src/index.js";

const epoch = 1 as SourceEpoch;
const sourceId = "source-1" as SourceId;
const entryId = "entry-1" as SourceEntryId;

function bundle(relativePath = "recordings/part-0.mcap"): SourceBundle {
  return {
    bundleId: "bundle-1",
    version: 1,
    entries: [
      {
        entryId,
        relativePath,
        sizeBytes: 10n,
        immutableVersion: "sha256:abc",
        byteSource: { kind: "local-blob", sourceId },
      },
    ],
    relations: [],
  };
}

describe("SourceBundle contract", () => {
  it("accepts normalized immutable entries", () => {
    expect(() => assertBundle(bundle())).not.toThrow();
  });

  it.each(["", "/absolute.mcap", "../escape.mcap", "a//b.mcap", "a\\b.mcap"])(
    "rejects unsafe path %j",
    (relativePath) => {
      expect(() => assertBundle(bundle(relativePath))).toThrow();
    },
  );

  it("rejects relations to unknown entries", () => {
    const value = bundle();
    expect(() =>
      assertBundle({
        ...value,
        relations: [
          {
            fromEntryId: entryId,
            toEntryId: "missing" as SourceEntryId,
            kind: "metadata-for",
          },
        ],
      }),
    ).toThrow(/unknown entry/);
  });
});

describe("payload lease contract", () => {
  it("accounts for retains and releases", () => {
    const lease = new ReferenceCountedPayloadLease(epoch, 32);
    lease.retain();
    expect(lease.retainCount).toBe(2);
    lease.release();
    expect(() => assertEpoch(lease, epoch)).not.toThrow();
    lease.release();
    expect(() => assertEpoch(lease, epoch)).toThrow(/active source epoch/);
    expect(() => lease.release()).toThrow(/more than retained/);
  });

  it("rejects stale epochs and invalidation", () => {
    const lease = new ReferenceCountedPayloadLease(epoch, 4);
    expect(() => assertEpoch(lease, 2 as SourceEpoch)).toThrow(/active source epoch/);
    lease.invalidate();
    expect(() => assertEpoch(lease, epoch)).toThrow(/active source epoch/);
  });
});
