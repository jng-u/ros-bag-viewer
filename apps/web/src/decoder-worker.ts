import { decodeSemanticMessage } from "@ros-web-viewer/m1-integration";
import { preparePointCloud2, type PointCloud2DisplayConfig } from "@ros-web-viewer/displays-core";
import { decodeGenericRosMessage, type GenericRosDecodeInput } from "./generic-ros-decoder.js";
import { rawImageToRgba } from "./image-raster.js";
import type { BrowserSample } from "./browser-runtime.js";
import type { DecodedSemanticMessage } from "@ros-web-viewer/m1-integration";

type Request =
  | { readonly id: number; readonly operation: "semantic"; readonly sample: BrowserSample }
  | { readonly id: number; readonly operation: "semantic-prepared"; readonly sample: BrowserSample; readonly pointCloudConfig: PointCloud2DisplayConfig }
  | { readonly id: number; readonly operation: "generic"; readonly input: GenericRosDecodeInput }
;

interface PreparedSemanticMessage {
  readonly decoded: DecodedSemanticMessage;
  readonly pointCloud?: ReturnType<typeof preparePointCloud2>;
  readonly rawImageRgba?: Uint8ClampedArray;
}

function decodePrepared(request: Extract<Request, { readonly operation: "semantic-prepared" }>): PreparedSemanticMessage {
  const decoded = decodeSemanticMessage({ channel: request.sample.channel, data: request.sample.data });
  if (decoded.kind === "pointcloud2") return { decoded, pointCloud: preparePointCloud2(decoded.message, request.pointCloudConfig) };
  if (decoded.kind === "image") return { decoded, rawImageRgba: rawImageToRgba(decoded.message) };
  return { decoded };
}

function execute(request: Request): unknown {
  switch (request.operation) {
    case "semantic":
      return decodeSemanticMessage({ channel: request.sample.channel, data: request.sample.data });
    case "semantic-prepared":
      return decodePrepared(request);
    case "generic":
      return decodeGenericRosMessage(request.input);
  }
}

function addBuffer(target: Set<ArrayBuffer>, value: unknown): void {
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) target.add(value.buffer);
}

function transferableBuffers(value: unknown): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  const semantic = value && typeof value === "object" && "decoded" in value
    ? (value as PreparedSemanticMessage)
    : undefined;
  const decoded = semantic?.decoded ?? (value && typeof value === "object" && "kind" in value ? value as DecodedSemanticMessage : undefined);
  if (decoded && "data" in decoded.message) addBuffer(buffers, decoded.message.data);
  addBuffer(buffers, semantic?.pointCloud?.positions);
  addBuffer(buffers, semantic?.pointCloud?.colors);
  addBuffer(buffers, semantic?.rawImageRgba);
  return [...buffers];
}

self.addEventListener("message", (event: MessageEvent<Request>) => {
  try {
    const value = execute(event.data);
    self.postMessage({ id: event.data.id, ok: true, value }, { transfer: transferableBuffers(value) });
  } catch (error) {
    self.postMessage({ id: event.data.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
