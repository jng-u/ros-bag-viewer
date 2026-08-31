import { readFileSync, writeFileSync } from "node:fs";
const lock = readFileSync("pnpm-lock.yaml", "utf8");
const packages = [...lock.matchAll(/^  ([^\n:]+):/gm)].map((m) => ({ name: m[1] }));
writeFileSync("sbom.cdx.json", JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1, components: packages }, null, 2) + "\n");
console.log(`SBOM generated: ${packages.length} components`);
