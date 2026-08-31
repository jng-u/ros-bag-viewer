import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type V1SemanticEvent = Readonly<{
  schemaVersion: 1;
  domain: "display-extension" | "rejection" | "schema" | "source" | "time-tf";
  result: "pass" | "rejected";
  code: string;
  facts: Readonly<Record<string, boolean | number | string>>;
}>;

const codePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const factKeyPattern = /^[a-z][A-Za-z0-9]*$/u;
const maxEventBytes = 8 * 1024;

function utf8BytesAtMost(value: string, maximum: number): number {
  if (value.length > maximum) throw new Error("v1 semantic event exceeds the byte ceiling");
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let width: number;
    if (code < 0x80) width = 1;
    else if (code < 0x800) width = 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { width = 4; index += 1; }
      else width = 3;
    } else width = 3;
    if (width > maximum - bytes) throw new Error("v1 semantic event exceeds the byte ceiling");
    bytes += width;
  }
  return bytes;
}

export function emitV1SemanticEvent(event: V1SemanticEvent): void {
  const path = process.env.V1_CONFORMANCE_PRODUCTION_EVENT_PATH;
  if (path === undefined) return;
  if (event.schemaVersion !== 1 || !codePattern.test(event.code) || Object.keys(event.facts).length === 0) {
    throw new Error("v1 semantic event is invalid");
  }
  for (const [key, value] of Object.entries(event.facts)) {
    if (!factKeyPattern.test(key) || !["boolean", "number", "string"].includes(typeof value) ||
        (typeof value === "number" && !Number.isFinite(value))) throw new Error("v1 semantic event fact is invalid");
  }
  const raw = `${JSON.stringify(event)}\n`;
  utf8BytesAtMost(raw, maxEventBytes);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw, { flag: "wx" });
}
