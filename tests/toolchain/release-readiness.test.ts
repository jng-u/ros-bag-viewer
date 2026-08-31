import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
import { readBoundedJson } from "../../scripts/toolchain/bounded-input.mjs";

const root = process.cwd();
const evidence = JSON.parse(readFileSync(join(root, "docs/evidence/m5-release-readiness.json"), "utf8")) as {
  releaseDecision: string;
  evidenceBoundary: { browserOsRosNetworkProductionCertified: boolean };
  protocolSchemaV1: {
    status: string;
    frozen: boolean;
    productionCertification: boolean;
    command: string;
    executionManifest: string;
    generatedAndVerifiedBy: string;
  };
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
  it("rejects fixture bytes before JSON decoding", () => {
    const directory = mkdtempSync(join(tmpdir(), "bounded-json-"));
    try {
      const exact = join(directory, "exact.json");
      writeFileSync(exact, '{"ok":true}');
      expect(readBoundedJson(exact, 11, "exact fixture")).toEqual({ ok: true });
      const oversized = join(directory, "oversized.json");
      writeFileSync(oversized, `${" ".repeat(11)}{`);
      expect(() => readBoundedJson(oversized, 11, "oversized fixture")).toThrow(/byte ceiling/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
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
      const denied = [
        'LICENSE', 'LICENSE-MIT', 'LICENCE_APACHE', 'COPYING', 'COPYING.txt', 'NOTICE', 'NOTICE.md',
        '.env', '.env.production', '.env.production.local', '.npmrc', '.netrc', 'credentials.json',
        'nested/id_rsa', 'private.pem', 'deploy.key',
        'infra/main.tf.json', 'infra/prod.auto.tfvars', 'terraform.tfstate.backup', '.terraformrc',
        'Pulumi.production.yaml', '.pulumi/state.json', 'serverless.json', '.serverless/output.json',
        'Dockerfile.production', 'docker-compose.yaml', 'compose.prod.yml', 'cloudformation-template.json',
        'cfn-stack.yaml', 'samconfig.toml', 'cdk.json', 'cdk.out/manifest.json',
        '.git-credentials', '.pypirc', '.docker/config.json', 'application_default_credentials.json',
        'client-secret.json', 'client_secret.apps.googleusercontent.com.json', '.kube/config', 'kubeconfig.prod',
        'deploy/id_custom', 'deploy/private-key', 'deploy/private_key', 'deploy/private.pem', 'template.yaml', 'template.yml',
        'stack.yaml', 'packaged.yaml', 'sam-template.yaml', '.aws-sam/build/template.yaml', 'infra/cdk-stack.ts',
      ];
      const deniedContent = [
        ['notes.txt', '-----BEGIN ' + 'PRIVATE KEY-----'],
        ['config.json', '{"type":"service_' + 'account","private_' + 'key":"secret"}'],
        ['registry.conf', '//registry.example/:_auth' + 'Token=secret'],
        ['deployment.json', '{"Resources":{"Queue":{"Type":"AWS' + '::SQS::Queue"}}}'],
        ['deployment.yaml', 'Resources:\\n  Queue:\\n    Type: AWS' + '::SQS::Queue'],
        ['infra/app.ts', "import { Stack } from 'aws-" + "cdk-lib';"],
        ['large.txt', 'x'.repeat(1024 * 1024 + 8) + '\\n-----BEGIN ' + 'PRIVATE KEY-----'],
      ];
      const allowed = [
        ['LICENSES.md', ''], ['environment.md', ''], ['.env-example', ''],
        ['public.pem', '-----BEGIN CERTIFICATE-----'], ['generic-template.yaml.txt', 'Resources are documented here'],
      ];
      if (denied.some((name) => repositoryStopReason(name) === undefined)) process.exit(1);
      if (deniedContent.some(([name, content]) => repositoryStopReason(name, content) === undefined)) process.exit(2);
      if (allowed.some(([name, content]) => repositoryStopReason(name, content) !== undefined)) process.exit(3);
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
      env: { ...process.env, GITHUB_TOKEN: "must-not-leak", NPM_TOKEN: "must-not-leak", NODE_OPTIONS: "--no-warnings" },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/release readiness gate: ok \(blocked; production certification=false\)/);
    const manifest = JSON.parse(readFileSync(join(root, evidence.protocolSchemaV1.executionManifest), "utf8")) as {
      manifest: {
        source: { commit: string; tree: string };
        cases: Array<{
          command: { env: Record<string, string> };
          reporterRawDigest: string;
          normalizedAssertionDigest: string;
          executionEnvironmentDigest: string;
          semanticReceipt: { productionAssertion: { file: string; testName: string } };
        }>;
      };
    };
    expect(manifest.manifest.source.commit).toMatch(/^[a-f0-9]{40,64}$/u);
    expect(manifest.manifest.source.tree).toMatch(/^[a-f0-9]{40,64}$/u);
    expect(manifest.manifest.cases).toHaveLength(36);
    expect(manifest.manifest.cases.every(({ reporterRawDigest, normalizedAssertionDigest, executionEnvironmentDigest }) =>
      [reporterRawDigest, normalizedAssertionDigest, executionEnvironmentDigest]
        .every((value) => /^sha256:[a-f0-9]{64}$/u.test(value)))).toBe(true);
    expect(new Set(manifest.manifest.cases.map(({ semanticReceipt }) =>
      `${semanticReceipt.productionAssertion.file}\0${semanticReceipt.productionAssertion.testName}`)).size).toBe(36);
    for (const { command } of manifest.manifest.cases) {
      expect(Object.keys(command.env).sort()).toEqual([
        "CI", "LANG", "LC_ALL", "NODE_OPTIONS", "NO_COLOR", "PATH", "TZ",
        "V1_CONFORMANCE_CASE_ID", "V1_CONFORMANCE_RECEIPT_PATH",
      ]);
      expect(command.env).toMatchObject({ CI: "1", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NODE_OPTIONS: "", TZ: "UTC" });
      expect(JSON.stringify(command.env)).not.toMatch(/must-not-leak|GITHUB_TOKEN|NPM_TOKEN/u);
    }
    const tamper = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import { readFileSync } from 'node:fs';
      import { verifyConformanceExecutionManifest } from './scripts/toolchain/conformance-execution-manifest.mjs';
      const source = readFileSync('./artifacts/v1-conformance-execution.json', 'utf8');
      const mutations = [
        value => { value.manifest.cases[0].reporterRawBase64 = Buffer.from('tampered').toString('base64'); },
        value => { value.manifest.cases[0].normalizedAssertionDigest = 'sha256:' + '0'.repeat(64); },
        value => { value.manifest.cases[0].command.env.TZ = 'Asia/Seoul'; },
        value => { value.manifest.cases[0].semanticReceipt.productionReporterRawBase64 = Buffer.from('tampered').toString('base64'); },
        value => { value.manifest.cases[0].semanticReceipt.observedResult = 'rejected'; },
        value => { value.manifest.cases[0].productionCommand.env.TZ = 'Asia/Seoul'; },
        value => { value.manifest.cases[0].executionArtifacts[0].digest = 'sha256:' + '0'.repeat(64); },
      ];
      for (const mutate of mutations) {
        const value = JSON.parse(source); mutate(value);
        let rejected = false;
        try { verifyConformanceExecutionManifest(process.cwd(), value); } catch { rejected = true; }
        if (!rejected) process.exit(1);
      }
    `], { cwd: root, encoding: "utf8" });
    expect(tamper.stderr).toBe("");
    expect(tamper.status).toBe(0);
  }, 60_000);
});
