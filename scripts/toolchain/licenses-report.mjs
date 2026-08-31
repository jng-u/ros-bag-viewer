import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const command = spawnSync("corepack", ["pnpm", "licenses", "list", "--json"], {
  encoding: "utf8",
});

if (command.status !== 0) {
  process.stderr.write(command.stderr);
  process.exit(command.status ?? 1);
}

const byLicense = JSON.parse(command.stdout);
const packages = Object.entries(byLicense)
  .flatMap(([license, entries]) =>
    entries.flatMap((entry) =>
      entry.versions.map((version) => ({
        name: entry.name,
        version,
        license,
        homepage: entry.homepage ?? null,
      })),
    ),
  )
  .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));

if (packages.length === 0 || packages.some(({ name, version, license }) => !name || !version || !license)) {
  throw new Error("license inventory is empty or incomplete");
}

mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/licenses.json",
  `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
);
console.log(`license inventory: ${packages.length} named package versions`);
