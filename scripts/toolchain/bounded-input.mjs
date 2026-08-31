import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { parse, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
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
  if (process.platform !== "linux" || constants.O_DIRECTORY === undefined || constants.O_NOFOLLOW === undefined) {
    throw new Error(`${label} requires Linux O_DIRECTORY/O_NOFOLLOW pinned traversal`);
  }
  const absolutePath = resolve(path instanceof URL ? fileURLToPath(path) : path);
  const parsed = parse(absolutePath);
  const components = absolutePath.slice(parsed.root.length).split("/").filter(Boolean);
  if (components.some((part) => part === "." || part === ".." || part.includes("\0")) || components.length === 0) throw new Error(`${label} has invalid path components`);
  const descriptors = [];
  let parent;
  try {
    parent = openSync(parsed.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptors.push(parent);
    for (const component of components.slice(0, -1)) {
      const next = openSync(`/proc/self/fd/${parent}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!fstatSync(next).isDirectory()) { closeSync(next); throw new Error(`${label} must be a regular non-symlink file`); }
      descriptors.push(next); parent = next;
    }
    const descriptor = openSync(`/proc/self/fd/${parent}/${components.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    descriptors.push(descriptor);
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
    if (before.size > maxBytes) throw new Error(`${label} exceeds the byte ceiling`);
    const chunks = []; let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count)); total += count;
    }
    const after = fstatSync(descriptor);
    if (total > maxBytes || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || total !== after.size) throw new Error(`${label} changed while being read or exceeds the byte ceiling`);
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ELOOP" || error?.code === "ENOTDIR") throw new Error(`${label} has a non-directory or symlinked ancestor (non-symlink file required)`, { cause: error });
    throw error;
  } finally { for (const descriptor of descriptors.reverse()) { try { closeSync(descriptor); } catch { /* already closed */ } } }
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
