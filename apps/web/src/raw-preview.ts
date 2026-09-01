export interface RawPreview {
  readonly text: string;
  readonly shownBytes: number;
  readonly truncatedBytes: number;
}

export function formatRawPreview(data: Uint8Array, maxBytes = 4096): RawPreview {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("raw preview limit must be a positive safe integer");
  const shownBytes = Math.min(data.byteLength, maxBytes);
  const rows: string[] = [];
  for (let offset = 0; offset < shownBytes; offset += 16) {
    const row = data.subarray(offset, Math.min(offset + 16, shownBytes));
    const hex = Array.from(row, (value) => value.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = Array.from(row, (value) => value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : ".").join("");
    rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return { text: rows.join("\n"), shownBytes, truncatedBytes: data.byteLength - shownBytes };
}
