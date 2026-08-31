import { describe, expect, it } from "vitest";

import { relayShell } from "../../apps/relay/src/index.js";
import { webShell } from "../../apps/web/src/index.js";

describe("workspace shell exports", () => {
  it("loads both private M0 application shells", () => {
    expect(webShell).toBe("web-shell");
    expect(relayShell).toBe("relay-shell");
  });
});
