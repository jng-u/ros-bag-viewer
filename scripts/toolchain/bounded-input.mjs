import { readFileSync, statSync } from "node:fs";

export function readBoundedBytes(path, maxBytes, label = path) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error(`${label} has an invalid byte ceiling`);
  const before = statSync(path);
  if (!before.isFile()) throw new Error(`${label} must be a regular file`);
  if (before.size > maxBytes) throw new Error(`${label} exceeds the byte ceiling`);
  const bytes = readFileSync(path);
  const after = statSync(path);
  if (bytes.byteLength > maxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) {
    throw new Error(`${label} changed while being read or exceeds the byte ceiling`);
  }
  return bytes;
}

export function readBoundedText(path, maxBytes, label = path) {
  return readBoundedBytes(path, maxBytes, label).toString("utf8");
}

export function readBoundedJson(path, maxBytes, label = path) {
  return JSON.parse(readBoundedText(path, maxBytes, label));
}
