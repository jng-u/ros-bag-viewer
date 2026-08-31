import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { TextDecoder } from "node:util";

const READ_CHUNK_BYTES = 64 * 1024;

function assertByteCeiling(maxBytes, label) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error(`${label} has an invalid byte ceiling`);
}

export function utf8ByteLengthAtMost(value, maxBytes, label = "text") {
  assertByteCeiling(maxBytes, label);
  if (typeof value !== "string" || value.length > maxBytes) throw new Error(`${label} exceeds the byte ceiling`);
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let width;
    if (code < 0x80) width = 1;
    else if (code < 0x800) width = 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { width = 4; index += 1; }
      else width = 3;
    } else width = 3;
    if (width > maxBytes - bytes) throw new Error(`${label} exceeds the byte ceiling`);
    bytes += width;
  }
  return bytes;
}

export function readBoundedBytes(path, maxBytes, label = path) {
  assertByteCeiling(maxBytes, label);
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > maxBytes) throw new Error(`${label} exceeds the byte ceiling`);
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
    }
    const after = fstatSync(descriptor);
    if (total > maxBytes || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || total !== after.size) {
      throw new Error(`${label} changed while being read or exceeds the byte ceiling`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(descriptor);
  }
}

export function readBoundedText(path, maxBytes, label = path) {
  const bytes = readBoundedBytes(path, maxBytes, label);
  return decodeBoundedUtf8(bytes, maxBytes, label);
}

export function decodeBoundedUtf8(bytes, maxBytes, label = "UTF-8 input") {
  assertByteCeiling(maxBytes, label);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) throw new Error(`${label} exceeds the byte ceiling`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

export function readBoundedJson(path, maxBytes, label = path) {
  return JSON.parse(readBoundedText(path, maxBytes, label));
}

export function parseBoundedJsonBytes(bytes, maxBytes, label = "JSON") {
  try { return JSON.parse(decodeBoundedUtf8(bytes, maxBytes, label)); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is invalid JSON`, { cause: error });
    throw error;
  }
}

export function decodeBoundedBase64(value, maxBytes, label = "base64", variant = "base64") {
  assertByteCeiling(maxBytes, label);
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (value.length > maxEncodedLength) throw new Error(`${label} exceeds the byte ceiling`);
  const bytes = Buffer.from(value, variant);
  if (bytes.byteLength > maxBytes || bytes.toString(variant) !== value) throw new Error(`${label} is invalid or oversized`);
  return bytes;
}

export function parseBoundedJsonText(value, maxBytes, label = "JSON") {
  utf8ByteLengthAtMost(value, maxBytes, label);
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} is invalid JSON`); }
}
