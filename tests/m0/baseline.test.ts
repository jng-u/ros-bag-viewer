import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), "utf8");

function markdownFiles(path: string): string[] {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => join(absolute, entry));
}

function packageFiles(): string[] {
  const found = [join(root, "package.json")];
  for (const directory of ["apps", "packages"]) {
    const base = join(root, directory);
    if (!existsSync(base)) continue;
    for (const child of readdirSync(base)) {
      const candidate = join(base, child, "package.json");
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

describe("M0 repository and evidence gate", () => {
  it("contains every required repository, evidence, and contract artifact", () => {
    const required = [
      ".git",
      "README.md",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "eslint.config.mjs",
      "vitest.config.ts",
      ".github/workflows/ci.yml",
      "docs/architecture.md",
      "docs/compatibility.md",
      "docs/threat-model.md",
      "docs/ux-baseline.md",
      "benchmarks/corpus-manifest.json",
      "packages/core-model/src/index.ts",
    ];

    expect(required.filter((path) => !existsSync(join(root, path)))).toEqual([]);
    expect(markdownFiles("docs/adr").length).toBeGreaterThan(0);
  });

  it("records explicit approval evidence for time/TF and threat-model stop gates", () => {
    const adr = markdownFiles("docs/adr")
      .map((path) => readFileSync(path, "utf8"))
      .find((text) => /scheduling/i.test(text) && /TF[\s/-]*(query|time)/i.test(text));
    const security = read("docs/threat-model.md");

    expect(adr, "a time/TF ADR is required").toBeDefined();
    expect(adr).toMatch(/approved|accepted/i);
    expect(security).toMatch(/browser/i);
    expect(security).toMatch(/relay/i);
    expect(security).toMatch(/object store/i);
    expect(security).toMatch(/edge/i);
    expect(security).toMatch(/ROS graph/i);
    const normalizedSecurity = security.replace(/[*_`]/g, "");
    expect(normalizedSecurity).toMatch(/status\s*:\s*[^\n]*(approved|accepted)/i);
  });

  it("defines the four contracts required before M1", () => {
    const contracts = read("packages/core-model/src/index.ts");
    for (const term of [
      "SourceBundle",
      "SchemaCapability",
      "SchemaResolution",
      "PayloadLease",
      "SourceEpoch",
      "DisplayLifecycle",
      "DisplayState",
      "NormalizedMessageEnvelope",
      "retain()",
      "instantiate()",
    ]) {
      expect(contracts, `missing ${term}`).toContain(term);
    }
  });
});

describe("M0 corpus evidence gate", () => {
  interface CorpusEntry {
    id: string;
    sourceUrl: string;
    license: string;
    licenseEvidence: string;
    ciUse: string;
    redistributionPolicy: string;
    sha256: string;
    byteSize: number;
    durationNs: number;
    storage: string;
    compression: string;
    indexing: string;
    topics: unknown[];
    types: unknown[];
    expectedFrames: number;
    expectedMessages: number;
  }

  const manifest = JSON.parse(read("benchmarks/corpus-manifest.json")) as {
    status: string;
    statusReason: string;
    entries: CorpusEntry[];
    deferredCandidates?: Array<{ status: string; missingEvidence: string[] }>;
  };

  it("requires complete provenance and usage fields for every admitted corpus entry", () => {
    expect(manifest.entries.length).toBeGreaterThan(0);
    for (const entry of manifest.entries) {
      for (const field of [
        "id",
        "sourceUrl",
        "license",
        "licenseEvidence",
        "ciUse",
        "redistributionPolicy",
        "storage",
        "compression",
        "indexing",
      ] as const) {
        expect(entry[field], `${entry.id}.${field}`).toBeTruthy();
      }
      expect(entry.sha256, `${entry.id}.sha256`).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.byteSize).toBeGreaterThanOrEqual(0);
      expect(entry.durationNs).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(entry.topics)).toBe(true);
      expect(Array.isArray(entry.types)).toBe(true);
      expect(entry.expectedFrames).toBeGreaterThanOrEqual(0);
      expect(entry.expectedMessages).toBeGreaterThanOrEqual(0);
      expect(["allowed", "manual-local-only"]).toContain(entry.ciUse);
      if (entry.license === "NOASSERTION") expect(entry.ciUse).toBe("manual-local-only");
      expect(["allowed", "prohibited-download-by-hash"]).toContain(entry.redistributionPolicy);
      if (entry.sourceUrl.includes("://") && entry.license !== "NOASSERTION") {
        expect(entry.licenseEvidence, `${entry.id}.licenseEvidence`).toMatch(/^https:\/\//);
      } else if (entry.license === "NOASSERTION") {
        expect(entry.licenseEvidence, `${entry.id}.licenseEvidence`).toMatch(/no top-level license|not redistribut/iu);
      }
    }
  });

  it("verifies checked-in fixture size and digest instead of trusting the manifest", () => {
    for (const entry of manifest.entries.filter(({ sourceUrl }) => !sourceUrl.includes("://"))) {
      const content = readFileSync(join(root, entry.sourceUrl));
      expect(content.byteLength, `${entry.id}.byteSize`).toBe(entry.byteSize);
      expect(createHash("sha256").update(content).digest("hex"), `${entry.id}.sha256`).toBe(entry.sha256);
    }
  });

  it("admits only licensed CI-safe entries and keeps unresolved candidates deferred", () => {
    expect(manifest.status).toBe("approved-for-m0");
    expect(manifest.statusReason).toMatch(/license|CI use|CI-use|redistribut|permit/i);
    expect(manifest.deferredCandidates?.length).toBeGreaterThan(0);
    expect(manifest.entries.some((entry) => entry.id.includes("cartographer"))).toBe(true);
    expect(manifest.entries.some((entry) => entry.id.includes("ros2"))).toBe(true);
    expect(manifest.entries.some((entry) => entry.storage === "mcap")).toBe(true);
    for (const candidate of manifest.deferredCandidates ?? []) {
      expect(candidate.status).toMatch(/^deferred-/);
      expect(candidate.missingEvidence.length).toBeGreaterThan(0);
    }
  });
});

describe("M0 desktop UX baseline", () => {
  const ux = read("docs/ux-baseline.md");

  it("defines information architecture, primary flows, and compact tokens", () => {
    for (const term of [
      "Desktop information architecture",
      "Session bar",
      "Topic browser",
      "Display workspace",
      "Inspector",
      "Timeline",
      "Open a source",
      "Discover a topic and add a display",
      "Configure a display",
      "Share a session",
      "Connect live",
      "Compact iridescence-inspired tokens",
    ]) {
      expect(ux, `missing UX requirement: ${term}`).toContain(term);
    }
  });

  it("defines accessibility, state, motion, and performance evidence", () => {
    for (const pattern of [
      /keyboard/i,
      /focus/i,
      /error/i,
      /aria/i,
      /contrast/i,
      /prefers-reduced-motion/i,
      /p95 frame time/i,
      /long tasks/i,
      /memory/i,
      /1440×900 CSS pixels at DPR 1/i,
      /accessibility-tree/i,
      /Evidence checklist/i,
      /missing item is not an implicit pass/i,
    ]) {
      expect(ux).toMatch(pattern);
    }
  });

  it("explicitly excludes expansion beyond the approved desktop scope", () => {
    expect(ux).toMatch(/do not define mobile or VR layouts/i);
    expect(ux).toMatch(/photorealistic/i);
    expect(ux).toMatch(/do not select a renderer helper/i);
  });
});

describe("M0 forbidden-scope guard", () => {
  it("does not select a public license or publishable package identity", () => {
    const rootNames = readdirSync(root).map((entry) => entry.toLowerCase());
    expect(rootNames.filter((name) => /^licen[cs]e(?:\.|$)/.test(name))).toEqual([]);
    for (const path of packageFiles()) {
      const packageJson = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(packageJson.private, `${path} must remain private`).toBe(true);
      expect(packageJson.publishConfig, `${path} must not configure publication`).toBeUndefined();
      expect(packageJson.homepage, `${path} must not claim a public product site`).toBeUndefined();
    }
  });

  it("contains no paid-infrastructure or credential configuration", () => {
    const forbiddenNames = new Set([
      "terraform",
      "pulumi.yaml",
      "serverless.yml",
      "serverless.yaml",
      ".env",
      ".env.local",
    ]);
    const violations: string[] = [];
    const walk = (directory: string): void => {
      for (const name of readdirSync(directory)) {
        if ([".git", "node_modules", "dist"].includes(name)) continue;
        const path = join(directory, name);
        const relative = path.slice(root.length + 1);
        if (forbiddenNames.has(name.toLowerCase()) || name.endsWith(".tf")) violations.push(relative);
        if (statSync(path).isDirectory()) walk(path);
      }
    };
    walk(root);
    expect(violations).toEqual([]);
  });

  it("locks only the approved local source, display, secure-live, and hosted dependency chain", () => {
    const locked: string[] = [];
    for (const path of packageFiles()) {
      const packageJson = JSON.parse(readFileSync(path, "utf8")) as { dependencies?: Record<string, string> };
      for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
        locked.push(`${basename(join(path, ".."))}:${dependency}`);
      }
    }
    expect(locked, "M4 may add only reviewed private workspace links to the M3 dependency chain").toEqual([
      "relay:@ros-web-viewer/protocol",
      "web:@ros-web-viewer/core-model",
      "web:@ros-web-viewer/displays-core",
      "web:@ros-web-viewer/m1-integration",
      "web:@ros-web-viewer/render-core",
      "web:@ros-web-viewer/source-mcap",
      "web:@ros-web-viewer/source-ros1bag",
      "web:@ros-web-viewer/source-ros2-sqlite",
      "web:@ros-web-viewer/tf",
      "web:@ros-web-viewer/worker-runtime",
      "web:@sqlite.org/sqlite-wasm",
      "web:lz4-lite",
      "web:seek-bzip",
      "hosted-core:@ros-web-viewer/core-model",
      "hosted-core:@ros-web-viewer/worker-runtime",
      "m1-integration:@ros-web-viewer/source-mcap",
      "m1-integration:@ros-web-viewer/worker-runtime",
      "source-mcap:@mcap/core",
    ]);
    const web = JSON.parse(readFileSync(join(root, "apps/web/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(web.dependencies["@ros-web-viewer/core-model"]).toBe("workspace:*");
    const relay = JSON.parse(readFileSync(join(root, "apps/relay/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(relay.dependencies["@ros-web-viewer/protocol"]).toBe("workspace:*");
    const integration = JSON.parse(readFileSync(join(root, "packages/m1-integration/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(web.dependencies["@ros-web-viewer/m1-integration"]).toBe("workspace:*");
    expect(integration.dependencies["@ros-web-viewer/source-mcap"]).toBe("workspace:*");
    expect(integration.dependencies["@ros-web-viewer/worker-runtime"]).toBe("workspace:*");
    const sourceMcap = JSON.parse(readFileSync(join(root, "packages/source-mcap/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(sourceMcap.dependencies["@mcap/core"]).toBe("2.2.1");
  });
});
