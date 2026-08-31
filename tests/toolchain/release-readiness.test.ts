import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TRUSTED_EXTENSION_CAPABILITIES,
  TRUSTED_EXTENSION_OPERATIONS,
} from "../../packages/extension-api/src/index.js";
import {
  V1_FROZEN_EXTENSION_CAPABILITIES,
  V1_FROZEN_EXTENSION_OPERATIONS,
} from "../../packages/protocol/src/conformance-v1.js";

const root = process.cwd();
const evidence = JSON.parse(readFileSync(join(root, "docs/evidence/m5-release-readiness.json"), "utf8")) as {
  releaseDecision: string;
  evidenceBoundary: { browserOsRosNetworkProductionCertified: boolean };
  protocolSchemaV1: { status: string; frozen: boolean; productionCertification: boolean; command: string };
  acceptanceCriteria: Array<{
    id: string;
    status: string;
    evidenceClass: string;
    commands: string[];
    artifacts: string[];
    limitation: string;
    exception?: { owner: string; expiresOn: string; effect: string };
    prohibitedActions?: string[];
  }>;
  failureRecovery: Array<{ scenario: string; status: string; evidence: string[]; recovery: string }>;
  accessibility: { automatedStatus: string; manualBrowserReviewStatus: string; exceptionId: string };
  security: { productionCertification: boolean };
  supplyChain: { publicationLicenseSelected: boolean; productionSupplyChainCertification: boolean };
  benchmark: { browserBenchmarkResult: boolean; productionHardwareResult: boolean };
};

describe("M5 release hardening", () => {
  it("freezes the protocol fixture to the exact extension API surface", () => {
    expect(V1_FROZEN_EXTENSION_OPERATIONS).toEqual(TRUSTED_EXTENSION_OPERATIONS);
    expect(V1_FROZEN_EXTENSION_CAPABILITIES).toEqual(TRUSTED_EXTENSION_CAPABILITIES);
  });

  it("maps AC-01 through AC-17 to machine evidence without converting limitations into certification", () => {
    expect(evidence.acceptanceCriteria.map(({ id }) => id)).toEqual(
      Array.from({ length: 17 }, (_, index) => `AC-${String(index + 1).padStart(2, "0")}`),
    );
    for (const criterion of evidence.acceptanceCriteria) {
      expect(criterion.status.length, `${criterion.id}.status`).toBeGreaterThan(0);
      expect(criterion.evidenceClass.length, `${criterion.id}.evidenceClass`).toBeGreaterThan(0);
      expect(criterion.commands.length, `${criterion.id}.commands`).toBeGreaterThan(0);
      expect(criterion.artifacts.length, `${criterion.id}.artifacts`).toBeGreaterThan(0);
      expect(criterion.limitation.length, `${criterion.id}.limitation`).toBeGreaterThan(0);
    }
    expect(evidence.acceptanceCriteria.slice(0, 14).every(({ status }) => status.startsWith("pass-"))).toBe(true);
    expect(evidence.releaseDecision).toBe("blocked");
    expect(evidence.evidenceBoundary.browserOsRosNetworkProductionCertified).toBe(false);
    expect(evidence.protocolSchemaV1).toMatchObject({
      status: "pass-local-synthetic",
      frozen: true,
      productionCertification: false,
    });
    expect(evidence.protocolSchemaV1.command).toContain("packages/protocol/test/conformance-v1.test.ts");
  });

  it("keeps AC-15 and AC-16 exceptions release-blocking, owned, and concretely expiring", () => {
    for (const id of ["AC-15", "AC-16"]) {
      const criterion = evidence.acceptanceCriteria.find((entry) => entry.id === id);
      expect(criterion?.status).toBe("release-blocking-exception");
      expect(criterion?.exception?.owner).toMatch(/owner$/);
      expect(criterion?.exception?.expiresOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(criterion?.exception?.effect).toBe("blocks-release");
    }
    expect(evidence.accessibility.manualBrowserReviewStatus).toBe("missing-release-blocker");
  });

  it("keeps AC-17 unauthorized and names every prohibited public or external action", () => {
    const ac17 = evidence.acceptanceCriteria.find(({ id }) => id === "AC-17");
    expect(ac17?.status).toBe("unauthorized");
    expect(ac17?.prohibitedActions).toEqual([
      "public-name-selection",
      "license-selection",
      "package-publication",
      "repository-publication",
      "paid-infrastructure",
      "credential-provisioning",
      "external-deployment",
      "production-deployment",
    ]);
  });

  it("covers context, parser/source, live reconnect, hosted expiration, and cleanup recovery truthfully", () => {
    expect(evidence.failureRecovery.map(({ scenario }) => scenario)).toEqual([
      "webgl-context-loss",
      "parser-or-source-failure",
      "relay-or-edge-disconnect",
      "hosted-expiry-revocation-deletion",
      "resource-cleanup",
    ]);
    for (const recovery of evidence.failureRecovery) {
      expect(recovery.evidence.length, recovery.scenario).toBeGreaterThan(0);
      expect(recovery.recovery.length, recovery.scenario).toBeGreaterThan(0);
    }
    expect(evidence.failureRecovery[0]?.status).toBe("release-blocked-not-browser-tested");
  });

  it("does not relabel semantic accessibility, adversarial, supply-chain, or modeled benchmark gates as production proof", () => {
    expect(evidence.accessibility.automatedStatus).toBe("pass-local-semantic");
    expect(evidence.security.productionCertification).toBe(false);
    expect(evidence.supplyChain.publicationLicenseSelected).toBe(false);
    expect(evidence.supplyChain.productionSupplyChainCertification).toBe(false);
    expect(evidence.benchmark.browserBenchmarkResult).toBe(false);
    expect(evidence.benchmark.productionHardwareResult).toBe(false);
  });

  it("passes the executable repository and evidence stop gate", () => {
    const stopProbe = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import { repositoryStopReason } from './scripts/toolchain/repository-stop-policy.mjs';
      const denied = ['LICENSE', 'LICENSE-MIT', 'LICENCE_APACHE', '.env', '.env.production', '.env.production.local'];
      const allowed = ['LICENSES.md', 'environment.md', '.env-example'];
      if (denied.some((name) => repositoryStopReason(name) === undefined)) process.exit(1);
      if (allowed.some((name) => repositoryStopReason(name) !== undefined)) process.exit(2);
    `], { cwd: root, encoding: "utf8" });
    expect(stopProbe.stderr).toBe("");
    expect(stopProbe.status).toBe(0);
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts["evidence:m3"]).toBe(
      "UPDATE_M3_EVIDENCE=1 vitest run --config tests/m3-live/vitest.config.ts tests/m3-live/generate-evidence.test.ts",
    );
    const result = spawnSync(process.execPath, ["scripts/toolchain/release-readiness-gate.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/release readiness gate: ok \(blocked; production certification=false\)/);
  });
});
