import { decompress as decompressLz4 } from "lz4-lite";
import { decodeBzip } from "./browser-bzip.js";

interface DecompressRequest {
  readonly id: number;
  readonly codec: "bz2" | "lz4";
  readonly compressed: Uint8Array;
  readonly declaredSize: number;
}

self.addEventListener("message", (event: MessageEvent<DecompressRequest>) => {
  const { id, codec, compressed, declaredSize } = event.data;
  void (async () => {
    try {
      const output = codec === "bz2"
        ? await decodeBzip(compressed, declaredSize, new AbortController().signal)
        : decompressLz4(compressed, declaredSize);
      if (output.byteLength !== declaredSize) throw new Error(`${codec} decoded ${output.byteLength} bytes; expected ${declaredSize}`);
      self.postMessage({ id, ok: true, output }, { transfer: [output.buffer] });
    } catch (error) {
      self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});
