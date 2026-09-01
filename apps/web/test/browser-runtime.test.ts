import { describe, expect, it } from "vitest";

import { detectBrowserSourceFormat, localFileVersion } from "../src/browser-runtime.js";

describe("browser recording entry", () => {
  it("detects visible local recording lanes without guessing unrelated files", () => {
    expect(detectBrowserSourceFormat("run.MCAP")).toBe("mcap");
    expect(detectBrowserSourceFormat("robot.bag")).toBe("ros1-bag");
    expect(detectBrowserSourceFormat("metadata.yaml")).toBe("ros2-sqlite");
    expect(detectBrowserSourceFormat("data_0.db3")).toBe("ros2-sqlite");
    expect(detectBrowserSourceFormat("notes.txt")).toBe("unknown");
  });

  it("builds a stable local-only version without reading the whole file", () => {
    expect(localFileVersion({ name: "run 1.mcap", size: 42, lastModified: 7 })).toBe("local:run%201.mcap:42:7");
  });
});
