import { mkdir, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runSyntheticLoadProof } from "./proof-harness.js";

describe("M3 evidence generator", () => {
  it.skipIf(process.env.UPDATE_M3_EVIDENCE !== "1")(
    "writes deterministic local synthetic evidence only when explicitly requested",
    async () => {
      const loadProfiles = await Promise.all([runSyntheticLoadProof("ros1"), runSyntheticLoadProof("ros2")]);
      const artifact = {
        schemaVersion: 1,
        gate: "G004 M3 secure-live local contract",
        evidenceKind: "deterministic-local-synthetic-contract",
        generatedBy:
          "UPDATE_M3_EVIDENCE=1 vitest run --config tests/m3-live/vitest.config.ts tests/m3-live/generate-evidence.test.ts",
        runtime: process.version,
        networkExecution: false,
        containerExecution: false,
        productionSecurityClaim: false,
        negativeCases: [
          "invalid-origin",
          "invalid-session",
          "invalid-browser-credential",
          "invalid-relay-identity",
          "expiry",
          "replay",
          "write-operation",
          "topic-and-type-escalation",
          "size-and-quota",
          "public-direct-edge-identity",
        ],
        loadProfiles,
        assertions: {
          browserProtocolIsSubscribeOnly: true,
          directBrowserOrPublicEdgeIdentityDenied: true,
          rosWriteSurfaceAbsent: true,
          relayAndEdgeQueuesBounded: true,
          dropsAndBackpressureVisible: true,
          reconnectEpochsIncrease: true,
          telemetryIsBoundedAndRedacted: true,
        },
        limitations: [
          "All protocol, load, latency, and reachability results are in-process deterministic synthetic contract evidence.",
          "No real socket, firewall, container, ROS graph, browser, public network, TLS handshake, or production identity provider was exercised.",
          "The fixed 2 ms transit latency is a same-clock harness value, not a hardware or network measurement.",
          "Production promotion still requires network isolation tests, real ROS1/ROS2 environments, browser/OS coverage, penetration testing, and operational review.",
        ],
      };
      const destination = new URL("../../docs/evidence/m3-live.json", import.meta.url);
      await mkdir(new URL(".", destination), { recursive: true });
      await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      expect(artifact.loadProfiles).toHaveLength(2);
    },
  );
});
