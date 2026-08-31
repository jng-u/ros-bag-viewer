import { readFileSync, writeFileSync } from "node:fs";
const lock = readFileSync("pnpm-lock.yaml", "utf8");
const packages = [...lock.matchAll(/^  ([^\n:]+):/gm)].map((m) => m[1]);
writeFileSync("licenses.json", JSON.stringify({ generatedBy: "scripts/toolchain/licenses.mjs", packages }, null, 2) + "\n");
console.log(`license inventory: ${packages.length} lockfile entries (metadata review required)`);
