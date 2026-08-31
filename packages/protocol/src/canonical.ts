const encoder = new TextEncoder();

export type CanonicalDataErrorCode = "byte-limit" | "cycle-or-repeat" | "depth-limit" | "invalid-data" | "item-limit";

export class CanonicalDataError extends Error {
  constructor(readonly code: CanonicalDataErrorCode, message: string) {
    super(message);
  }
}

function jsonStringByteLength(value: string): number {
  let length = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      length += 2;
    } else if (code < 0x20) {
      length += 6;
    } else if (code < 0x80) {
      length += 1;
    } else if (code < 0x800) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { length += 4; index += 1; } else length += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      length += 6;
    } else {
      length += 3;
    }
  }
  return length;
}

export function canonicalizePlainData(
  value: unknown,
  options: Readonly<{ label: string; maxDepth?: number; maxItems?: number; maxBytes?: number }>,
): unknown {
  const counter = { value: 0 };
  const bytes = { value: 0 };
  const seen = new WeakSet<object>();
  const maxDepth = options.maxDepth ?? 64;
  const maxItems = options.maxItems ?? 100_000;
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;

  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || !Number.isSafeInteger(maxItems) || maxItems <= 0 ||
      !(maxBytes === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxBytes) && maxBytes > 0))) {
    throw new CanonicalDataError("invalid-data", `${options.label} has invalid canonicalization limits`);
  }

  const charge = (amount: number): void => {
    if (amount > maxBytes - bytes.value) throw new CanonicalDataError("byte-limit", `${options.label} exceeds the byte limit`);
    bytes.value += amount;
  };

  const visit = (item: unknown, label: string, depth: number): unknown => {
    if (++counter.value > maxItems) throw new CanonicalDataError("item-limit", `${options.label} exceeds the item limit`);
    if (depth > maxDepth) throw new CanonicalDataError("depth-limit", `${options.label} exceeds the depth limit`);
    if (item === null) { charge(4); return item; }
    if (typeof item === "string") { charge(jsonStringByteLength(item)); return item; }
    if (typeof item === "boolean") { charge(item ? 4 : 5); return item; }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new CanonicalDataError("invalid-data", `${label} contains a non-finite number`);
      const normalized = Object.is(item, -0) ? 0 : item;
      charge(String(normalized).length);
      return normalized;
    }
    if (typeof item !== "object") throw new CanonicalDataError("invalid-data", `${label} contains executable or unsupported data`);
    if (seen.has(item)) throw new CanonicalDataError("cycle-or-repeat", `${label} contains a cycle or repeated reference`);
    seen.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) throw new CanonicalDataError("invalid-data", `${label} must be an ordinary array`);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(item, "length");
      const length = lengthDescriptor?.value;
      if (!lengthDescriptor || "get" in lengthDescriptor || !Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff) {
        throw new CanonicalDataError("invalid-data", `${label} has an invalid length`);
      }
      if (length > maxItems - counter.value) throw new CanonicalDataError("item-limit", `${options.label} exceeds the item limit`);
      const keys = Reflect.ownKeys(item);
      if (keys.some((key) => typeof key !== "string")) throw new CanonicalDataError("invalid-data", `${label} contains symbols`);
      if (keys.length !== length + 1 || !(keys as string[]).includes("length")) {
        throw new CanonicalDataError("invalid-data", `${label} must be dense and unaugmented`);
      }
      for (const key of keys as string[]) {
        if (key === "length") continue;
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
          throw new CanonicalDataError("invalid-data", `${label} must be dense and unaugmented`);
        }
      }
      charge(2 + Math.max(0, length - 1));
      const descriptors: PropertyDescriptor[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) throw new CanonicalDataError("invalid-data", `${label}[${index}] contains an accessor`);
        descriptors.push(descriptor);
      }
      const output: unknown[] = [];
      for (let index = 0; index < descriptors.length; index += 1) {
        output.push(visit(descriptors[index]!.value, `${label}[${index}]`, depth + 1));
      }
      return Object.freeze(output);
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) throw new CanonicalDataError("invalid-data", `${label} must contain plain data`);
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== "string")) throw new CanonicalDataError("invalid-data", `${label} contains symbols`);
    if (keys.length > maxItems - counter.value) throw new CanonicalDataError("item-limit", `${options.label} exceeds the item limit`);
    charge(2 + Math.max(0, keys.length - 1));
    const output: Record<string, unknown> = {};
    for (const key of (keys as string[]).sort()) {
      if (key === "__proto__") throw new CanonicalDataError("invalid-data", `${label} contains a __proto__ field`);
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) throw new CanonicalDataError("invalid-data", `${label}.${key} contains hidden or accessor data`);
      charge(jsonStringByteLength(key));
      charge(1);
      Object.defineProperty(output, key, {
        value: visit(descriptor.value, `${label}.${key}`, depth + 1),
        enumerable: true,
      });
    }
    return Object.freeze(output);
  };

  return visit(value, options.label, 0);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

export function sha256(value: string): `sha256:${string}` {
  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const bytes = encoder.encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const first = words[index - 15]!;
      const second = words[index - 2]!;
      const sigma0 = rotateRight(first, 7) ^ rotateRight(first, 18) ^ (first >>> 3);
      const sigma1 = rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temporary1 = (h! + sum1 + choice + constants[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temporary1) >>> 0; d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    for (let index = 0; index < 8; index += 1) hash[index] = (hash[index]! + [a, b, c, d, e, f, g, h][index]!) >>> 0;
  }
  return `sha256:${[...hash].map((word) => word.toString(16).padStart(8, "0")).join("")}`;
}
