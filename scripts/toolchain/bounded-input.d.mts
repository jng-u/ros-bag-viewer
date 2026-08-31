export function utf8ByteLengthAtMost(value: string, maxBytes: number, label?: string): number;
export function readBoundedBytes(path: string | URL, maxBytes: number, label?: string): Buffer;
export function readBoundedText(path: string | URL, maxBytes: number, label?: string): string;
export function decodeBoundedUtf8(bytes: Uint8Array, maxBytes: number, label?: string): string;
export function readBoundedJson(path: string | URL, maxBytes: number, label?: string): unknown;
export function parseBoundedJsonBytes(bytes: Uint8Array, maxBytes: number, label?: string): unknown;
export function decodeBoundedBase64(value: string, maxBytes: number, label?: string, variant?: "base64" | "base64url"): Buffer;
export function parseBoundedJsonText(value: string, maxBytes: number, label?: string): unknown;
