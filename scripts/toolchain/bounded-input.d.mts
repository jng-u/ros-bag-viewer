export function readBoundedBytes(path: string, maxBytes: number, label?: string): Buffer;
export function readBoundedText(path: string, maxBytes: number, label?: string): string;
export function readBoundedJson(path: string, maxBytes: number, label?: string): unknown;
