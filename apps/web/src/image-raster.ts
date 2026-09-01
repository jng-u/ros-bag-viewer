import type { DecodedImage } from "@ros-web-viewer/m1-integration";

const BYTES_PER_PIXEL: Readonly<Record<string, number>> = {
  mono8: 1,
  rgb8: 3,
  bgr8: 3,
  rgba8: 4,
  bgra8: 4,
};

export function rawImageToRgba(message: DecodedImage["message"]): Uint8ClampedArray {
  const encoding = message.encoding.toLocaleLowerCase();
  const bytesPerPixel = BYTES_PER_PIXEL[encoding];
  if (bytesPerPixel === undefined) throw new Error(`unsupported raw image encoding: ${message.encoding}`);
  if (message.step < message.width * bytesPerPixel) throw new Error("Image step is too small for its encoding");
  if (message.step * message.height > message.data.byteLength) throw new Error("Image data is truncated");
  const output = new Uint8ClampedArray(message.width * message.height * 4);
  for (let y = 0; y < message.height; y += 1) {
    for (let x = 0; x < message.width; x += 1) {
      const input = y * message.step + x * bytesPerPixel;
      const target = (y * message.width + x) * 4;
      if (encoding === "mono8") {
        output[target] = message.data[input]!;
        output[target + 1] = message.data[input]!;
        output[target + 2] = message.data[input]!;
      } else if (encoding === "rgb8" || encoding === "rgba8") {
        output[target] = message.data[input]!;
        output[target + 1] = message.data[input + 1]!;
        output[target + 2] = message.data[input + 2]!;
      } else {
        output[target] = message.data[input + 2]!;
        output[target + 1] = message.data[input + 1]!;
        output[target + 2] = message.data[input]!;
      }
      output[target + 3] = encoding === "rgba8" || encoding === "bgra8" ? message.data[input + 3]! : 255;
    }
  }
  return output;
}
