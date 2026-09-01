export interface CompressedImageDimensions {
  readonly width: number;
  readonly height: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) throw new Error("Compressed image header is truncated");
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function dimensions(width: number, height: number): CompressedImageDimensions {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Compressed image dimensions are invalid");
  }
  return { width, height };
}

function pngDimensions(bytes: Uint8Array): CompressedImageDimensions {
  if (bytes.byteLength < 24 || ascii(bytes, 1, 3) !== "PNG" || ascii(bytes, 12, 4) !== "IHDR") {
    throw new Error("Compressed PNG header is invalid or truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dimensions(view.getUint32(16, false), view.getUint32(20, false));
}

const JPEG_START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(bytes: Uint8Array): CompressedImageDimensions {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Compressed JPEG header is invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) throw new Error("Compressed JPEG segment is truncated");
    const segmentLength = view.getUint16(offset, false);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) throw new Error("Compressed JPEG segment length is invalid");
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (segmentLength < 7) throw new Error("Compressed JPEG frame header is truncated");
      return dimensions(view.getUint16(offset + 5, false), view.getUint16(offset + 3, false));
    }
    offset += segmentLength;
  }
  throw new Error("Compressed JPEG has no bounded frame dimensions before image data");
}

function uint24le(bytes: Uint8Array, offset: number): number {
  if (offset + 3 > bytes.byteLength) throw new Error("Compressed WebP header is truncated");
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function webpDimensions(bytes: Uint8Array): CompressedImageDimensions {
  if (bytes.byteLength < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    throw new Error("Compressed WebP header is invalid or truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const kind = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + length > bytes.byteLength) throw new Error("Compressed WebP chunk is truncated");
    if (kind === "VP8X") {
      if (length < 10) throw new Error("Compressed WebP VP8X header is truncated");
      return dimensions(uint24le(bytes, payload + 4) + 1, uint24le(bytes, payload + 7) + 1);
    }
    if (kind === "VP8 ") {
      if (length < 10 || bytes[payload + 3] !== 0x9d || bytes[payload + 4] !== 0x01 || bytes[payload + 5] !== 0x2a) {
        throw new Error("Compressed WebP VP8 frame header is invalid");
      }
      return dimensions(view.getUint16(payload + 6, true) & 0x3fff, view.getUint16(payload + 8, true) & 0x3fff);
    }
    if (kind === "VP8L") {
      if (length < 5 || bytes[payload] !== 0x2f) throw new Error("Compressed WebP VP8L frame header is invalid");
      const b1 = bytes[payload + 1]!;
      const b2 = bytes[payload + 2]!;
      const b3 = bytes[payload + 3]!;
      const b4 = bytes[payload + 4]!;
      return dimensions(1 + b1 + ((b2 & 0x3f) << 8), 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)));
    }
    offset = payload + length + (length & 1);
  }
  throw new Error("Compressed WebP has no bounded frame dimensions");
}

export function compressedImageDimensions(bytes: Uint8Array, mime: string): CompressedImageDimensions {
  switch (mime) {
    case "image/png": return pngDimensions(bytes);
    case "image/jpeg": return jpegDimensions(bytes);
    case "image/webp": return webpDimensions(bytes);
    default: throw new Error(`Unsupported compressed image MIME type: ${mime}`);
  }
}
