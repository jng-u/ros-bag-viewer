export interface GenericRosDecodeInput {
  readonly typeName: string;
  readonly messageEncoding: string;
  readonly schemaEncoding?: string;
  readonly schemaDefinition?: string;
  readonly schemaData?: Uint8Array;
  readonly data: Uint8Array;
}

export interface GenericRosDecodeResult {
  readonly value: Readonly<Record<string, unknown>>;
  readonly numericFields: readonly { readonly path: string; readonly value: number }[];
}

export function numericValueAtPath(value: unknown, path: string): number | undefined {
  let current = value;
  for (const segment of path.split(".")) {
    const match = /^([A-Za-z][A-Za-z0-9_]*)(?:\[(\d+)\])?$/u.exec(segment);
    if (!match || !current || typeof current !== "object") return undefined;
    current = (current as Readonly<Record<string, unknown>>)[match[1]!];
    if (match[2] !== undefined) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(match[2])];
    }
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

interface FieldDefinition {
  readonly type: string;
  readonly name: string;
  readonly arrayLength?: number;
  readonly maxArrayLength?: number;
  readonly maxStringLength?: number;
  readonly sequence: boolean;
}

const MAX_FIELDS = 4096;
const MAX_ARRAY_LENGTH = 1_000_000;
const MAX_DECODED_VALUES = 200_000;
const MAX_STRING_BYTES = 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_SCHEMA_BYTES = 4 * 1024 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function normalizeType(type: string): string {
  return type.replace("/msg/", "/");
}

function definitionText(input: GenericRosDecodeInput): string {
  if (input.schemaData && input.schemaData.byteLength > MAX_SCHEMA_BYTES) throw new Error("Message schema byte limit exceeded");
  if (input.schemaDefinition && new TextEncoder().encode(input.schemaDefinition).byteLength > MAX_SCHEMA_BYTES) throw new Error("Message schema byte limit exceeded");
  const text = input.schemaDefinition ?? (input.schemaData ? textDecoder.decode(input.schemaData) : undefined);
  if (!text?.trim()) throw new Error("Message schema definition is unavailable");
  return text;
}

function parseFields(lines: readonly string[]): FieldDefinition[] {
  const fields: FieldDefinition[] = [];
  for (const source of lines) {
    const line = source.replace(/#.*/u, "").trim();
    if (!line || /^\S+\s+[A-Za-z][A-Za-z0-9_]*\s*=/u.test(line) || /^MSG:\s*/u.test(line) || /^={8,}$/u.test(line)) continue;
    const match = /^(\S+)\s+([A-Za-z][A-Za-z0-9_]*)$/u.exec(line);
    if (!match) throw new Error(`Unsupported message schema declaration: ${line}`);
    let rawType = match[1]!;
    let sequence = false;
    let arrayLength: number | undefined;
    let maxArrayLength: number | undefined;
    const array = /^(.*)\[(?:(<=)(\d+)|(\d*))\]$/u.exec(rawType);
    if (array) {
      rawType = array[1]!;
      if (array[2]) { sequence = true; maxArrayLength = Number(array[3]); }
      else if (array[4] === "") sequence = true;
      else arrayLength = Number(array[4]);
    }
    const boundedString = /^(string|wstring)<=(\d+)$/u.exec(rawType);
    const type = boundedString?.[1] ?? rawType;
    const maxStringLength = boundedString ? Number(boundedString[2]) : undefined;
    if ((arrayLength !== undefined && !Number.isSafeInteger(arrayLength))
      || (maxArrayLength !== undefined && (!Number.isSafeInteger(maxArrayLength) || maxArrayLength > MAX_ARRAY_LENGTH))
      || (maxStringLength !== undefined && (!Number.isSafeInteger(maxStringLength) || maxStringLength > MAX_STRING_BYTES))) {
      throw new Error(`Message schema bound is invalid: ${line}`);
    }
    fields.push({
      type: normalizeType(type),
      name: match[2]!,
      sequence,
      ...(arrayLength === undefined ? {} : { arrayLength }),
      ...(maxArrayLength === undefined ? {} : { maxArrayLength }),
      ...(maxStringLength === undefined ? {} : { maxStringLength }),
    });
    if (fields.length > MAX_FIELDS) throw new Error("Message schema field limit exceeded");
  }
  return fields;
}

function parseSchema(rootType: string, definition: string): Map<string, readonly FieldDefinition[]> {
  const definitions = new Map<string, readonly FieldDefinition[]>();
  let totalFields = 0;
  let currentType = normalizeType(rootType);
  let lines: string[] = [];
  const flush = () => {
    if (lines.length > 0) {
      const fields = parseFields(lines);
      totalFields += fields.length;
      if (totalFields > MAX_FIELDS || definitions.size >= 128) throw new Error("Message schema definition limit exceeded");
      definitions.set(currentType, fields);
    }
    lines = [];
  };
  for (const line of definition.split(/\r?\n/u)) {
    const section = /^MSG:\s*(\S+)\s*$/u.exec(line.trim());
    if (section) {
      flush();
      currentType = normalizeType(section[1]!);
      continue;
    }
    if (/^={8,}$/u.test(line.trim())) continue;
    lines.push(line);
  }
  flush();
  if (!definitions.has(normalizeType(rootType))) throw new Error(`Schema definition does not declare root type ${normalizeType(rootType)}`);
  return definitions;
}

abstract class RosReader {
  protected offset = 0;
  protected readonly view: DataView;

  constructor(protected readonly bytes: Uint8Array, protected readonly littleEndian: boolean) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  protected abstract align(size: number): void;
  protected abstract stringLengthIncludesTerminator(): boolean;

  protected take(size: number, alignment = size): number {
    this.align(alignment);
    if (!Number.isSafeInteger(size) || size < 0 || this.offset + size > this.bytes.byteLength) {
      throw new Error("Message payload ended before the schema-defined field");
    }
    const start = this.offset;
    this.offset += size;
    return start;
  }

  uint8(): number { return this.view.getUint8(this.take(1)); }
  int8(): number { return this.view.getInt8(this.take(1)); }
  uint16(): number { return this.view.getUint16(this.take(2), this.littleEndian); }
  int16(): number { return this.view.getInt16(this.take(2), this.littleEndian); }
  uint32(): number { return this.view.getUint32(this.take(4), this.littleEndian); }
  int32(): number { return this.view.getInt32(this.take(4), this.littleEndian); }
  float32(): number { return this.view.getFloat32(this.take(4), this.littleEndian); }
  float64(): number { return this.view.getFloat64(this.take(8), this.littleEndian); }
  uint64(): string { return this.view.getBigUint64(this.take(8), this.littleEndian).toString(); }
  int64(): string { return this.view.getBigInt64(this.take(8), this.littleEndian).toString(); }

  string(maxCharacters?: number): string {
    const declared = this.uint32();
    const payloadLength = this.stringLengthIncludesTerminator() ? Math.max(0, declared - 1) : declared;
    if (payloadLength > MAX_STRING_BYTES) throw new Error("Message string limit exceeded");
    const start = this.take(declared, 1);
    if (this.stringLengthIncludesTerminator() && declared > 0 && this.bytes[start + declared - 1] !== 0) {
      throw new Error("CDR string is missing its terminator");
    }
    const value = textDecoder.decode(this.bytes.subarray(start, start + payloadLength));
    if (maxCharacters !== undefined && [...value].length > maxCharacters) throw new Error("Message string exceeds its schema bound");
    return value;
  }

  wstring(maxCharacters?: number): string {
    if (this instanceof Ros1Reader) throw new Error("ROS1 wstring is unsupported");
    const declared = this.uint32();
    const characterCount = declared > 0 ? declared - 1 : 0;
    if (characterCount > MAX_STRING_BYTES / 4 || (maxCharacters !== undefined && characterCount > maxCharacters)) {
      throw new Error("Message wstring exceeds its schema bound");
    }
    const start = this.take(declared * 4, 4);
    const values: number[] = [];
    for (let index = 0; index < characterCount; index += 1) values.push(this.view.getUint32(start + index * 4, this.littleEndian));
    if (declared > 0 && this.view.getUint32(start + characterCount * 4, this.littleEndian) !== 0) throw new Error("CDR wstring is missing its terminator");
    let output = "";
    for (let offset = 0; offset < values.length; offset += 4_096) output += String.fromCodePoint(...values.slice(offset, offset + 4_096));
    return output;
  }

  ensureConsumed(): void {
    const remaining = this.bytes.subarray(this.offset);
    if (remaining.length > 7 || remaining.some((byte) => byte !== 0)) throw new Error(`Message has ${remaining.length} unexpected trailing bytes`);
  }
}

class Ros1Reader extends RosReader {
  constructor(bytes: Uint8Array) { super(bytes, true); }
  protected align(): void {}
  protected stringLengthIncludesTerminator(): boolean { return false; }
  override ensureConsumed(): void {
    if (this.offset !== this.bytes.byteLength) throw new Error(`ROS1 message has ${this.bytes.byteLength - this.offset} unexpected trailing bytes`);
  }
}

class CdrReader extends RosReader {
  constructor(bytes: Uint8Array) {
    if (bytes.byteLength < 4) throw new Error("CDR payload is missing its encapsulation header");
    if (bytes[0] !== 0 || (bytes[1] !== 0 && bytes[1] !== 1)) throw new Error("CDR encapsulation header is unsupported");
    super(bytes, bytes[1] === 1);
    this.offset = 4;
  }
  protected align(size: number): void {
    if (size <= 1) return;
    const relative = this.offset - 4;
    this.offset += (size - (relative % size)) % size;
  }
  protected stringLengthIncludesTerminator(): boolean { return true; }
  override ensureConsumed(): void {
    const remaining = this.bytes.subarray(this.offset);
    const relative = this.offset - 4;
    const padding = (4 - (relative % 4)) % 4;
    if (remaining.length !== 0 && (remaining.length !== padding || remaining.some((byte) => byte !== 0))) {
      throw new Error(`CDR message has ${remaining.length} unexpected trailing bytes`);
    }
  }
}

const primitiveTypes = new Set([
  "bool", "byte", "char", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64",
  "float32", "float64", "string", "wstring", "time", "duration", "builtin_interfaces/Time", "builtin_interfaces/Duration",
]);

function resolveNestedType(parentType: string, fieldType: string, definitions: ReadonlyMap<string, readonly FieldDefinition[]>): string {
  const normalized = normalizeType(fieldType);
  if (definitions.has(normalized)) return normalized;
  if (normalized === "Header" && definitions.has("std_msgs/Header")) return "std_msgs/Header";
  if (!normalized.includes("/")) {
    const namespace = normalizeType(parentType).split("/").slice(0, -1).join("/");
    const qualified = `${namespace}/${normalized}`;
    if (definitions.has(qualified)) return qualified;
  }
  return normalized;
}

function readPrimitive(reader: RosReader, type: string, maxStringLength?: number): unknown {
  switch (type) {
    case "bool": return reader.uint8() !== 0;
    case "uint8": return reader.uint8();
    case "char": return reader.uint8();
    case "byte":
    case "int8": return reader.int8();
    case "uint16": return reader.uint16();
    case "int16": return reader.int16();
    case "uint32": return reader.uint32();
    case "int32": return reader.int32();
    case "uint64": return reader.uint64();
    case "int64": return reader.int64();
    case "float32": return reader.float32();
    case "float64": return reader.float64();
    case "string": return reader.string(maxStringLength);
    case "wstring": return reader.wstring(maxStringLength);
    case "time": return { sec: reader instanceof Ros1Reader ? reader.uint32() : reader.int32(), nanosec: reader.uint32() };
    case "builtin_interfaces/Time": return { sec: reader.int32(), nanosec: reader.uint32() };
    case "duration":
    case "builtin_interfaces/Duration": return { sec: reader.int32(), nanosec: reader.uint32() };
    default: throw new Error(`Unsupported primitive field type: ${type}`);
  }
}

export function collectNumericFields(value: unknown, path = "", output: { path: string; value: number }[] = []): readonly { path: string; value: number }[] {
  if (output.length >= MAX_FIELDS) return output;
  if (typeof value === "number" && Number.isFinite(value)) {
    output.push({ path, value });
  } else if (Array.isArray(value)) {
    value.slice(0, 256).forEach((item, index) => collectNumericFields(item, `${path}[${index}]`, output));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) collectNumericFields(item, path ? `${path}.${key}` : key, output);
  }
  return output.slice(0, MAX_FIELDS);
}

export function decodeGenericRosMessage(input: GenericRosDecodeInput): GenericRosDecodeResult {
  if (input.data.byteLength > 64 * 1024 * 1024) throw new Error("Generic message payload limit exceeded");
  const schemaEncoding = input.schemaEncoding?.toLocaleLowerCase();
  if (schemaEncoding && schemaEncoding !== "ros1msg" && schemaEncoding !== "ros2msg") {
    throw new Error(`Unsupported generic schema encoding: ${input.schemaEncoding}`);
  }
  const definitions = parseSchema(input.typeName, definitionText(input));
  const encoding = input.messageEncoding.toLocaleLowerCase();
  if (encoding !== "ros1" && encoding !== "ros1msg" && encoding !== "cdr") {
    throw new Error(`Unsupported generic message encoding: ${input.messageEncoding}`);
  }
  const reader: RosReader = encoding === "ros1" || encoding === "ros1msg" ? new Ros1Reader(input.data) : new CdrReader(input.data);
  let decodedValues = 0;

  const readMessage = (type: string, depth: number): Readonly<Record<string, unknown>> => {
    if (depth > MAX_DEPTH) throw new Error("Message schema nesting limit exceeded");
    const normalized = normalizeType(type);
    const fields = definitions.get(normalized);
    if (!fields) throw new Error(`Schema definition is missing nested type ${normalized}`);
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      decodedValues += 1;
      if (decodedValues > MAX_DECODED_VALUES) throw new Error("Decoded message value limit exceeded");
      const count = field.sequence ? reader.uint32() : field.arrayLength;
      if (count !== undefined) {
        if (!Number.isSafeInteger(count) || count < 0 || count > MAX_ARRAY_LENGTH) throw new Error("Message array limit exceeded");
        if (field.maxArrayLength !== undefined && count > field.maxArrayLength) throw new Error("Message array exceeds its schema bound");
        decodedValues += count;
        if (decodedValues > MAX_DECODED_VALUES) throw new Error("Decoded message value limit exceeded");
        result[field.name] = Array.from({ length: count }, () => primitiveTypes.has(field.type)
          ? readPrimitive(reader, field.type, field.maxStringLength)
          : readMessage(resolveNestedType(normalized, field.type, definitions), depth + 1));
      } else {
        result[field.name] = primitiveTypes.has(field.type)
          ? readPrimitive(reader, field.type, field.maxStringLength)
          : readMessage(resolveNestedType(normalized, field.type, definitions), depth + 1);
      }
    }
    return result;
  };

  const value = readMessage(normalizeType(input.typeName), 0);
  reader.ensureConsumed();
  return { value, numericFields: collectNumericFields(value) };
}
