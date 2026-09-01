type BrowserBufferInput = number | ArrayLike<number>;

class BrowserBuffer extends Uint8Array {
  constructor(input: BrowserBufferInput) {
    if (typeof input === "number") {
      super(input);
      return;
    }
    super(Array.from(input));
  }

  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.byteLength): number {
    const source = this.subarray(sourceStart, sourceEnd);
    target.set(source, targetStart);
    return source.byteLength;
  }

  override toString(encoding?: string): string {
    if (encoding !== "hex") return super.toString();
    let output = "";
    for (const value of this) output += value.toString(16).padStart(2, "0");
    return output;
  }
}

function installSeekBzipBufferCompatibility(): void {
  const scope = globalThis as unknown as { Buffer?: unknown };
  if (typeof scope.Buffer === "undefined") scope.Buffer = BrowserBuffer;
}

let bunzipPromise: Promise<typeof import("seek-bzip").default> | undefined;

async function bunzip(): Promise<typeof import("seek-bzip").default> {
  installSeekBzipBufferCompatibility();
  bunzipPromise ??= import("seek-bzip").then(({ default: decoder }) => decoder);
  return bunzipPromise;
}

export async function decodeBzip(compressed: Uint8Array, declaredSize: number, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) throw new DOMException("BZip2 decode aborted", "AbortError");
  const decoder = await bunzip();
  if (signal.aborted) throw new DOMException("BZip2 decode aborted", "AbortError");
  const output = new Uint8Array(declaredSize);
  let offset = 0;
  decoder.decode(compressed, {
    writeByte(value) {
      if (offset >= output.byteLength) throw new Error("BZip2 output exceeds its declared size");
      output[offset++] = value;
    },
    write(bytes, sourceOffset, length) {
      if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0 || !Number.isSafeInteger(length) || length < 0 || sourceOffset + length > bytes.length) {
        throw new Error("BZip2 decoder returned an invalid source range");
      }
      if (offset + length > output.byteLength) throw new Error("BZip2 output exceeds its declared size");
      for (let index = 0; index < length; index += 1) output[offset + index] = bytes[sourceOffset + index]!;
      offset += length;
      return length;
    },
  });
  if (signal.aborted) throw new DOMException("BZip2 decode aborted", "AbortError");
  if (offset !== declaredSize) throw new Error(`BZip2 decoded ${offset} bytes; expected ${declaredSize}`);
  return output;
}
