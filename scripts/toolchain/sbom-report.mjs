import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const command = spawnSync("corepack", ["pnpm", "list", "--json", "--depth", "Infinity"], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

if (command.status !== 0) {
  process.stderr.write(command.stderr);
  process.exit(command.status ?? 1);
}

const roots = JSON.parse(command.stdout);
const components = new Map();

function addDependencies(dependencies = {}) {
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (!dependency.version) continue;
    const key = `${name}@${dependency.version}`;
    components.set(key, {
      type: "library",
      name,
      version: dependency.version,
      purl: `pkg:npm/${name.replace("@", "%40")}@${dependency.version}`,
    });
    addDependencies(dependency.dependencies);
    addDependencies(dependency.devDependencies);
    addDependencies(dependency.optionalDependencies);
  }
}

for (const root of roots) {
  addDependencies(root.dependencies);
  addDependencies(root.devDependencies);
  addDependencies(root.optionalDependencies);
}

const sortedComponents = [...components.values()].sort((left, right) =>
  `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
);
if (sortedComponents.length === 0) throw new Error("SBOM contains no dependency components");

mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/sbom.cdx.json",
  `${JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000000",
    version: 1,
    metadata: { component: { type: "application", name: "internal-m0-workspace" } },
    components: sortedComponents,
  }, null, 2)}\n`,
);
console.log(`SBOM generated: ${sortedComponents.length} unique package versions`);
