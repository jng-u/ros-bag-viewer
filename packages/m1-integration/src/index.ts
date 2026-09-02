import { McapSourceSession, type Decompressor, type McapChannelInfo, type McapLimits } from "@ros-web-viewer/source-mcap";
import {
  BlobRangeSource,
  BoundedByteReader,
  DEFAULT_WORKER_LIMITS,
  SourceEpochController,
  type ReadTelemetry,
  type WorkerResourceLimits,
} from "@ros-web-viewer/worker-runtime";

export interface SemanticDecodeLimits {
  readonly maxMessageBytes: number;
  readonly maxStringBytes: number;
  readonly maxPointFields: number;
  readonly maxPointDataBytes: number;
  readonly maxPoints: number;
  readonly maxPathPoses: number;
}

export const DEFAULT_SEMANTIC_DECODE_LIMITS: SemanticDecodeLimits = {
  maxMessageBytes: 16 * 1024 * 1024,
  maxStringBytes: 64 * 1024,
  maxPointFields: 64,
  maxPointDataBytes: 16 * 1024 * 1024,
  maxPoints: 1_000_000,
  maxPathPoses: 100_000,
};

const MAX_IMAGE_PIXELS = 16_000_000;

export interface SemanticMcapMessage {
  readonly channel: {
    readonly schema: {
      readonly name: string;
      readonly capability: "schema-present" | "opaque";
      readonly definition?: string;
      readonly data?: Uint8Array;
      readonly encoding?: string;
    };
    readonly messageEncoding?: string;
  };
  readonly data: Uint8Array;
}

export interface DecodedPointCloud2 {
  readonly kind: "pointcloud2";
  readonly message: {
    readonly frameId: string;
    readonly stampNanos: bigint;
    readonly width: number;
    readonly height: number;
    readonly pointStep: number;
    readonly rowStep: number;
    readonly isBigEndian: boolean;
    readonly fields: readonly { readonly name: string; readonly offset: number; readonly datatype: number; readonly count: number }[];
    readonly data: Uint8Array;
  };
}

export interface DecodedPath {
  readonly kind: "path";
  readonly message: {
    readonly frameId: string;
    readonly stampNanos: bigint;
    readonly poses: readonly { readonly position: { readonly x: number; readonly y: number; readonly z: number } }[];
  };
}

export interface DecodedImage {
  readonly kind: "image";
  readonly message: {
    readonly frameId: string;
    readonly stampNanos: bigint;
    readonly width: number;
    readonly height: number;
    readonly encoding: string;
    readonly step: number;
    readonly isBigEndian: boolean;
    readonly data: Uint8Array;
  };
}

export interface DecodedCompressedImage {
  readonly kind: "compressed-image";
  readonly message: {
    readonly frameId: string;
    readonly stampNanos: bigint;
    readonly format: string;
    readonly data: Uint8Array;
  };
}

export interface DecodedLaserScan {
  readonly kind: "laser-scan";
  readonly message: {
    readonly frameId: string;
    readonly stampNanos: bigint;
    readonly angleMin: number;
    readonly angleIncrement: number;
    readonly rangeMin: number;
    readonly rangeMax: number;
    readonly ranges: Float32Array;
  };
}

export interface DecodedPose {
  readonly kind: "pose";
  readonly message: {
    readonly frameId: string;
    readonly stampNanos: bigint;
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
    readonly orientation: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
  };
}

export interface DecodedOdometry {
  readonly kind: "odometry";
  readonly message: {
    readonly frameId: string;
    readonly stampNanos: bigint;
    readonly childFrameId: string;
    readonly pose: Omit<DecodedPose["message"], "frameId" | "stampNanos">;
    readonly poseCovariance: readonly number[];
  };
}

export interface DecodedOccupancyGrid {
  readonly kind: "occupancy-grid";
  readonly message: {
    readonly frameId: string;
    readonly stampNanos: bigint;
    readonly width: number;
    readonly height: number;
    readonly resolution: number;
    readonly origin: { readonly x: number; readonly y: number; readonly z: number };
    readonly orientation: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
    readonly data: Int8Array;
  };
}

export interface DecodedFrameTree {
  readonly kind: "frame-tree";
  readonly message: {
    readonly transforms: readonly {
      readonly parentFrameId: string;
      readonly childFrameId: string;
      readonly stampNanos: bigint;
      readonly translation: { readonly x: number; readonly y: number; readonly z: number };
      readonly rotation: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
    }[];
  };
}

export interface DecodedCameraInfo {
  readonly kind: "camera-info";
  readonly message: {
    readonly frameId: string;
    readonly stampNanos: bigint;
    readonly width: number;
    readonly height: number;
    readonly distortionModel: string;
    readonly d: readonly number[];
    readonly k: readonly number[];
    readonly r: readonly number[];
    readonly p: readonly number[];
  };
}

export interface DecodedMarker {
  readonly kind: "marker";
  readonly message: {
    readonly markers: readonly {
      readonly frameId: string;
      readonly namespace: string;
      readonly id: number;
      readonly action: "add" | "delete" | "delete-all";
      readonly type: "points" | "line-strip" | "line-list" | string;
      readonly points: readonly { readonly x: number; readonly y: number; readonly z: number }[];
      readonly stampNanos: bigint;
      readonly lifetimeNanos: bigint;
    }[];
  };
}

export interface DecodedNumeric {
  readonly kind: "numeric";
  readonly message: { readonly fieldPath: string; readonly value: number; readonly sourceTimeNanos: bigint };
}

export type DecodedSemanticMessage =
  | DecodedPointCloud2
  | DecodedPath
  | DecodedImage
  | DecodedCompressedImage
  | DecodedLaserScan
  | DecodedPose
  | DecodedOdometry
  | DecodedOccupancyGrid
  | DecodedFrameTree
  | DecodedCameraInfo
  | DecodedMarker
  | DecodedNumeric;

export type SemanticDisplayPort =
  | {
      readonly kind: "pointcloud2";
      update(message: DecodedPointCloud2["message"], epoch: number): unknown;
      render(): void;
    }
  | {
      readonly kind: "path";
      update(message: DecodedPath["message"], epoch: number): unknown;
      render(): void;
    };

export interface PayloadLeasePort {
  assertUsable(epoch: number): void;
  release(): void;
}

function assertSemanticDecodeLimits(limits: SemanticDecodeLimits): void {
  const names = [
    "maxMessageBytes",
    "maxStringBytes",
    "maxPointFields",
    "maxPointDataBytes",
    "maxPoints",
    "maxPathPoses",
  ] as const;
  for (const name of names) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
    if (value > DEFAULT_SEMANTIC_DECODE_LIMITS[name]) {
      throw new Error(`${name} cannot exceed the hard semantic decode limit`);
    }
  }
  if (limits.maxStringBytes > limits.maxMessageBytes) {
    throw new Error("maxStringBytes cannot exceed maxMessageBytes");
  }
  if (limits.maxPointDataBytes > limits.maxMessageBytes) {
    throw new Error("maxPointDataBytes cannot exceed maxMessageBytes");
  }
}

class CdrReader {
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  readonly #littleEndian: boolean;
  readonly #origin = 4;
  readonly #limits: SemanticDecodeLimits;
  #offset = 4;

  constructor(bytes: Uint8Array, limits: SemanticDecodeLimits) {
    if (bytes.byteLength > limits.maxMessageBytes) throw new Error("CDR message exceeds maxMessageBytes");
    if (bytes.byteLength < 4) throw new Error("CDR message is missing the encapsulation header");
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const representation = this.#view.getUint16(0, false);
    if (representation !== 0 && representation !== 1) throw new Error(`unsupported CDR representation ${representation}`);
    this.#littleEndian = representation === 1;
    this.#limits = limits;
  }

  uint8(): number {
    this.#require(1);
    return this.#view.getUint8(this.#offset++);
  }

  uint32(): number {
    this.#align(4);
    this.#require(4);
    const value = this.#view.getUint32(this.#offset, this.#littleEndian);
    this.#offset += 4;
    return value;
  }

  int32(): number {
    this.#align(4);
    this.#require(4);
    const value = this.#view.getInt32(this.#offset, this.#littleEndian);
    this.#offset += 4;
    return value;
  }

  float32(allowNonFinite = false): number {
    this.#align(4);
    this.#require(4);
    const value = this.#view.getFloat32(this.#offset, this.#littleEndian);
    this.#offset += 4;
    if (!allowNonFinite && !Number.isFinite(value)) throw new Error("CDR geometry contains a non-finite value");
    return value;
  }

  float64(): number {
    this.#align(8);
    this.#require(8);
    const value = this.#view.getFloat64(this.#offset, this.#littleEndian);
    this.#offset += 8;
    if (!Number.isFinite(value)) throw new Error("CDR geometry contains a non-finite value");
    return value;
  }

  string(): string {
    const length = this.uint32();
    if (length < 1 || length > this.#limits.maxStringBytes) throw new Error("CDR string length exceeds limits");
    this.#require(length);
    if (this.#bytes[this.#offset + length - 1] !== 0) throw new Error("CDR string is not null terminated");
    const value = new TextDecoder("utf-8", { fatal: true }).decode(this.#bytes.subarray(this.#offset, this.#offset + length - 1));
    this.#offset += length;
    return value;
  }

  byteSequence(maxBytes: number): Uint8Array {
    const length = this.uint32();
    if (length > maxBytes) throw new Error("CDR byte sequence exceeds limits");
    this.#require(length);
    const value = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  float32Sequence(maxValues: number, allowNonFinite = false): Float32Array {
    const length = this.uint32();
    if (length > maxValues) throw new Error("CDR float32 sequence exceeds limits");
    const values = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      this.#align(4);
      this.#require(4);
      const value = this.#view.getFloat32(this.#offset, this.#littleEndian);
      this.#offset += 4;
      if (!allowNonFinite && !Number.isFinite(value)) throw new Error("CDR geometry contains a non-finite value");
      values[index] = value;
    }
    return values;
  }

  float64Array(length: number): number[] {
    return Array.from({ length }, () => this.float64());
  }

  float64Sequence(maxValues: number): number[] {
    const length = this.uint32();
    if (length > maxValues) throw new Error("CDR float64 sequence exceeds limits");
    return this.float64Array(length);
  }

  header(): { readonly frameId: string; readonly stampNanos: bigint } {
    const seconds = this.int32();
    const nanoseconds = this.uint32();
    if (nanoseconds >= 1_000_000_000) throw new Error("ROS header nanoseconds are invalid");
    return { frameId: this.string(), stampNanos: BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds) };
  }

  ensureConsumed(): void {
    const remaining = this.#bytes.byteLength - this.#offset;
    const relative = this.#offset - this.#origin;
    const transportAlignment = (4 - (relative % 4)) % 4;
    if (remaining !== 0 && remaining !== transportAlignment) {
      throw new Error("CDR message has unexpected trailing bytes");
    }
  }

  #align(alignment: number): void {
    const relative = this.#offset - this.#origin;
    this.#offset += (alignment - (relative % alignment)) % alignment;
  }

  #require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.#offset + length > this.#bytes.byteLength) {
      throw new Error("CDR message is truncated");
    }
  }
}

class Ros1Reader {
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  readonly #limits: SemanticDecodeLimits;
  #offset = 0;

  constructor(bytes: Uint8Array, limits: SemanticDecodeLimits) {
    if (bytes.byteLength > limits.maxMessageBytes) throw new Error("ROS1 message exceeds maxMessageBytes");
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#limits = limits;
  }

  uint8(): number {
    this.#require(1);
    return this.#view.getUint8(this.#offset++);
  }

  uint32(): number {
    this.#require(4);
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  int32(): number {
    this.#require(4);
    const value = this.#view.getInt32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  float32(allowNonFinite = false): number {
    this.#require(4);
    const value = this.#view.getFloat32(this.#offset, true);
    this.#offset += 4;
    if (!allowNonFinite && !Number.isFinite(value)) throw new Error("ROS1 geometry contains a non-finite value");
    return value;
  }

  float64(): number {
    this.#require(8);
    const value = this.#view.getFloat64(this.#offset, true);
    this.#offset += 8;
    if (!Number.isFinite(value)) throw new Error("ROS1 geometry contains a non-finite value");
    return value;
  }

  string(): string {
    const length = this.uint32();
    if (length > this.#limits.maxStringBytes) throw new Error("ROS1 string length exceeds limits");
    this.#require(length);
    const value = new TextDecoder("utf-8", { fatal: true }).decode(this.#bytes.subarray(this.#offset, this.#offset + length));
    this.#offset += length;
    return value;
  }

  byteSequence(maxBytes: number): Uint8Array {
    const length = this.uint32();
    if (length > maxBytes) throw new Error("ROS1 byte sequence exceeds limits");
    this.#require(length);
    const value = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  float32Sequence(maxValues: number, allowNonFinite = false): Float32Array {
    const length = this.uint32();
    if (length > maxValues) throw new Error("ROS1 float32 sequence exceeds limits");
    const values = new Float32Array(length);
    for (let index = 0; index < length; index += 1) values[index] = this.float32(allowNonFinite);
    return values;
  }

  float64Array(length: number): number[] {
    return Array.from({ length }, () => this.float64());
  }

  float64Sequence(maxValues: number): number[] {
    const length = this.uint32();
    if (length > maxValues) throw new Error("ROS1 float64 sequence exceeds limits");
    return this.float64Array(length);
  }

  header(): { readonly frameId: string; readonly stampNanos: bigint } {
    this.uint32(); // seq
    const seconds = this.uint32();
    const nanoseconds = this.uint32();
    if (nanoseconds >= 1_000_000_000) throw new Error("ROS1 header nanoseconds are invalid");
    return { frameId: this.string(), stampNanos: BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds) };
  }

  ensureConsumed(): void {
    if (this.#offset !== this.#bytes.byteLength) throw new Error("ROS1 message has unexpected trailing bytes");
  }

  #require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.#offset + length > this.#bytes.byteLength) {
      throw new Error("ROS1 message is truncated");
    }
  }
}

function normalizedSchemaName(name: string): string {
  return name.replace("/msg/", "/");
}

type SemanticReader = CdrReader | Ros1Reader;
type Position = { readonly x: number; readonly y: number; readonly z: number };
type Orientation = { readonly x: number; readonly y: number; readonly z: number; readonly w: number };

function readPosition(reader: SemanticReader): Position {
  return { x: reader.float64(), y: reader.float64(), z: reader.float64() };
}

function readOrientation(reader: SemanticReader): Orientation {
  return { x: reader.float64(), y: reader.float64(), z: reader.float64(), w: reader.float64() };
}

function readPose(reader: SemanticReader): { readonly position: Position; readonly orientation: Orientation } {
  return { position: readPosition(reader), orientation: readOrientation(reader) };
}

function readDuration(reader: SemanticReader): bigint {
  const seconds = reader.int32();
  const nanoseconds = reader.uint32();
  if (nanoseconds >= 1_000_000_000) throw new Error("ROS duration nanoseconds are invalid");
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds);
}

function rotateAndTranslate(point: Position, pose: { readonly position: Position; readonly orientation: Orientation }): Position {
  const { x, y, z, w } = pose.orientation;
  const norm = Math.hypot(x, y, z, w);
  if (norm === 0) throw new Error("Marker orientation quaternion must be non-zero");
  const qx = x / norm;
  const qy = y / norm;
  const qz = z / norm;
  const qw = w / norm;
  return {
    x: pose.position.x + (1 - 2 * (qy * qy + qz * qz)) * point.x + 2 * (qx * qy - qz * qw) * point.y + 2 * (qx * qz + qy * qw) * point.z,
    y: pose.position.y + 2 * (qx * qy + qz * qw) * point.x + (1 - 2 * (qx * qx + qz * qz)) * point.y + 2 * (qy * qz - qx * qw) * point.z,
    z: pose.position.z + 2 * (qx * qz - qy * qw) * point.x + 2 * (qy * qz + qx * qw) * point.y + (1 - 2 * (qx * qx + qy * qy)) * point.z,
  };
}

function markerType(rawType: number): string {
  switch (rawType) {
    case 8: return "points";
    case 4: return "line-strip";
    case 5: return "line-list";
    case 6: return "cube-list";
    case 7: return "sphere-list";
    case 11: return "triangle-list";
    case 12: return "arrow-strip";
    case 0:
    case 1:
    case 2:
    case 3:
    case 9:
    case 10:
      return "pose-point";
    default:
      return `marker-type-${rawType}`;
  }
}

function readMarker(reader: SemanticReader, limits: SemanticDecodeLimits, hasRos2ExtensionFields: boolean): DecodedMarker["message"]["markers"][number] {
  const header = reader.header();
  const namespace = reader.string();
  const id = reader.int32();
  const rawType = reader.int32();
  const rawAction = reader.int32();
  const pose = readPose(reader);
  readPosition(reader); // scale
  reader.float32(); reader.float32(); reader.float32(); reader.float32(); // color
  const lifetimeNanos = readDuration(reader);
  reader.uint8(); // frame_locked
  const pointCount = reader.uint32();
  if (pointCount > limits.maxPathPoses) throw new Error("Marker point count exceeds limits");
  const points = Array.from({ length: pointCount }, () => rotateAndTranslate(readPosition(reader), pose));
  const colorCount = reader.uint32();
  if (colorCount > limits.maxPathPoses) throw new Error("Marker color count exceeds limits");
  for (let index = 0; index < colorCount; index += 1) {
    reader.float32(); reader.float32(); reader.float32(); reader.float32();
  }
  if (reader instanceof CdrReader && hasRos2ExtensionFields) {
    // Current ROS 2 visualization_msgs/Marker adds bounded texture and embedded
    // mesh fields before the legacy text/mesh flags. They are intentionally
    // decoded-and-discarded because the baseline renderer does not fetch or
    // execute external resources.
    reader.string(); // texture_resource
    reader.header(); // texture.header
    reader.string(); // texture.format
    reader.byteSequence(limits.maxMessageBytes); // texture.data
    const uvCount = reader.uint32();
    if (uvCount > limits.maxPathPoses) throw new Error("Marker UV coordinate count exceeds limits");
    for (let index = 0; index < uvCount; index += 1) { reader.float32(); reader.float32(); }
  }
  reader.string(); // text
  reader.string(); // mesh_resource
  if (reader instanceof CdrReader && hasRos2ExtensionFields) {
    reader.string(); // mesh_file.filename
    reader.byteSequence(limits.maxMessageBytes); // mesh_file.data
  }
  reader.uint8(); // mesh_use_embedded_materials
  const type = markerType(rawType);
  const action = rawAction === 0 ? "add" : rawAction === 2 ? "delete" : rawAction === 3 ? "delete-all" : "add";
  const renderPoints = type === "pose-point" && points.length === 0 ? [pose.position] : points;
  return { frameId: header.frameId, namespace, id, action, type, points: renderPoints, stampNanos: header.stampNanos, lifetimeNanos };
}

export function availableDisplaysForSchema(
  schemaName: string,
  capability: "schema-present" | "opaque" = "schema-present",
): readonly (
  | "camera-info"
  | "frame-tree"
  | "image"
  | "laser-scan"
  | "marker"
  | "numeric-plot"
  | "occupancy-grid"
  | "odometry"
  | "path"
  | "point-cloud"
  | "pose"
  | "raw"
)[] {
  if (capability === "opaque") return [];
  const inspectable = <T extends Exclude<ReturnType<typeof availableDisplaysForSchema>[number], "numeric-plot" | "raw">>(kind: T) => [kind, "numeric-plot", "raw"] as const;
  switch (normalizedSchemaName(schemaName)) {
    case "sensor_msgs/PointCloud2":
      return inspectable("point-cloud");
    case "sensor_msgs/Image":
    case "sensor_msgs/CompressedImage":
      return inspectable("image");
    case "nav_msgs/Path":
      return inspectable("path");
    case "sensor_msgs/LaserScan":
      return inspectable("laser-scan");
    case "geometry_msgs/Pose":
    case "geometry_msgs/PoseStamped":
    case "geometry_msgs/PoseWithCovarianceStamped":
      return inspectable("pose");
    case "nav_msgs/Odometry":
      return ["odometry", "pose", "numeric-plot", "raw"];
    case "nav_msgs/OccupancyGrid":
      return inspectable("occupancy-grid");
    case "tf2_msgs/TFMessage":
      return inspectable("frame-tree");
    case "sensor_msgs/CameraInfo":
      return inspectable("camera-info");
    case "visualization_msgs/Marker":
    case "visualization_msgs/MarkerArray":
      return inspectable("marker");
    case "std_msgs/Float32":
    case "std_msgs/Float64":
    case "std_msgs/Int32":
    case "std_msgs/UInt32":
      return ["numeric-plot", "raw"];
    default:
      return ["numeric-plot", "raw"];
  }
}

export function decodeSemanticMessage(
  input: SemanticMcapMessage,
  limits: SemanticDecodeLimits = DEFAULT_SEMANTIC_DECODE_LIMITS,
): DecodedSemanticMessage {
  assertSemanticDecodeLimits(limits);
  if (input.channel.schema.capability !== "schema-present") throw new Error("semantic decoding requires a present schema");
  const encoding = input.channel.messageEncoding?.toLocaleLowerCase();
  const reader = encoding === "ros1" || encoding === "ros1msg"
    ? new Ros1Reader(input.data, limits)
    : new CdrReader(input.data, limits);
  const schema = normalizedSchemaName(input.channel.schema.name);
  if (schema === "sensor_msgs/PointCloud2") {
    const header = reader.header();
    const height = reader.uint32();
    const width = reader.uint32();
    const pointCount = height * width;
    if (!Number.isSafeInteger(pointCount) || pointCount > limits.maxPoints) throw new Error("PointCloud2 point count exceeds limits");
    const fieldCount = reader.uint32();
    if (fieldCount > limits.maxPointFields) throw new Error("PointCloud2 field count exceeds limits");
    const fields = Array.from({ length: fieldCount }, () => ({
      name: reader.string(),
      offset: reader.uint32(),
      datatype: reader.uint8(),
      count: reader.uint32(),
    }));
    const isBigEndian = reader.uint8() !== 0;
    const pointStep = reader.uint32();
    const rowStep = reader.uint32();
    const data = reader.byteSequence(limits.maxPointDataBytes);
    reader.uint8(); // is_dense is display-irrelevant but must be consumed.
    reader.ensureConsumed();
    if (rowStep * height !== data.byteLength || pointStep * width > rowStep) {
      throw new Error("PointCloud2 dimensions do not match its bounded data sequence");
    }
    return {
      kind: "pointcloud2",
      message: { frameId: header.frameId, stampNanos: header.stampNanos, width, height, pointStep, rowStep, isBigEndian, fields, data },
    };
  }
  if (schema === "nav_msgs/Path") {
    const header = reader.header();
    const poseCount = reader.uint32();
    if (poseCount > limits.maxPathPoses) throw new Error("Path pose count exceeds limits");
    const poses = Array.from({ length: poseCount }, () => {
      reader.header();
      const position = { x: reader.float64(), y: reader.float64(), z: reader.float64() };
      reader.float64();
      reader.float64();
      reader.float64();
      reader.float64();
      return { position };
    });
    reader.ensureConsumed();
    return { kind: "path", message: { frameId: header.frameId, stampNanos: header.stampNanos, poses } };
  }
  if (schema === "sensor_msgs/Image") {
    const header = reader.header();
    const height = reader.uint32();
    const width = reader.uint32();
    const pixelCount = height * width;
    if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_IMAGE_PIXELS) throw new Error("Image pixel count exceeds limits");
    const encoding = reader.string();
    const isBigEndian = reader.uint8() !== 0;
    const step = reader.uint32();
    const data = reader.byteSequence(limits.maxMessageBytes);
    reader.ensureConsumed();
    if (!Number.isSafeInteger(step * height) || step * height > data.byteLength) throw new Error("Image dimensions exceed its bounded data sequence");
    return { kind: "image", message: { frameId: header.frameId, stampNanos: header.stampNanos, width, height, encoding, step, isBigEndian, data } };
  }
  if (schema === "sensor_msgs/CompressedImage") {
    const header = reader.header();
    const format = reader.string();
    const data = reader.byteSequence(limits.maxMessageBytes);
    reader.ensureConsumed();
    return { kind: "compressed-image", message: { frameId: header.frameId, stampNanos: header.stampNanos, format, data } };
  }
  if (schema === "sensor_msgs/LaserScan") {
    const header = reader.header();
    const angleMin = reader.float32();
    reader.float32(); // angle_max
    const angleIncrement = reader.float32();
    reader.float32(); // time_increment
    reader.float32(); // scan_time
    const rangeMin = reader.float32();
    const rangeMax = reader.float32();
    const ranges = reader.float32Sequence(limits.maxPoints, true);
    reader.float32Sequence(limits.maxPoints, true); // intensities may also contain NaN/Inf sensor sentinels
    reader.ensureConsumed();
    return { kind: "laser-scan", message: { frameId: header.frameId, stampNanos: header.stampNanos, angleMin, angleIncrement, rangeMin, rangeMax, ranges } };
  }
  if (schema === "geometry_msgs/Pose" || schema === "geometry_msgs/PoseStamped" || schema === "geometry_msgs/PoseWithCovarianceStamped") {
    const header = schema === "geometry_msgs/Pose" ? undefined : reader.header();
    const pose = readPose(reader);
    if (schema === "geometry_msgs/PoseWithCovarianceStamped") reader.float64Array(36);
    reader.ensureConsumed();
    return { kind: "pose", message: { frameId: header?.frameId ?? "", stampNanos: header?.stampNanos ?? 0n, ...pose } };
  }
  if (schema === "nav_msgs/Odometry") {
    const header = reader.header();
    const childFrameId = reader.string();
    const pose = readPose(reader);
    const poseCovariance = reader.float64Array(36);
    readPosition(reader); // linear twist
    readPosition(reader); // angular twist
    reader.float64Array(36); // twist covariance
    reader.ensureConsumed();
    return { kind: "odometry", message: { frameId: header.frameId, stampNanos: header.stampNanos, childFrameId, pose, poseCovariance } };
  }
  if (schema === "nav_msgs/OccupancyGrid") {
    const header = reader.header();
    readDuration(reader); // map_load_time
    const resolution = reader.float32();
    const width = reader.uint32();
    const height = reader.uint32();
    const cellCount = width * height;
    if (!Number.isSafeInteger(cellCount) || cellCount > limits.maxPointDataBytes) throw new Error("OccupancyGrid cell count exceeds limits");
    const originPose = readPose(reader);
    const bytes = reader.byteSequence(limits.maxPointDataBytes);
    reader.ensureConsumed();
    if (bytes.byteLength !== cellCount) throw new Error("OccupancyGrid dimensions do not match its data sequence");
    const data = new Int8Array(bytes.byteLength);
    for (let index = 0; index < bytes.byteLength; index += 1) data[index] = (bytes[index] ?? 0) << 24 >> 24;
    return { kind: "occupancy-grid", message: { frameId: header.frameId, stampNanos: header.stampNanos, width, height, resolution, origin: originPose.position, orientation: originPose.orientation, data } };
  }
  if (schema === "tf2_msgs/TFMessage") {
    const count = reader.uint32();
    if (count > limits.maxPathPoses) throw new Error("TF transform count exceeds limits");
    const transforms = Array.from({ length: count }, () => {
      const header = reader.header();
      const childFrameId = reader.string();
      const translation = readPosition(reader);
      const rotation = readOrientation(reader);
      return { parentFrameId: header.frameId, childFrameId, stampNanos: header.stampNanos, translation, rotation };
    });
    reader.ensureConsumed();
    return { kind: "frame-tree", message: { transforms } };
  }
  if (schema === "sensor_msgs/CameraInfo") {
    const header = reader.header();
    const height = reader.uint32();
    const width = reader.uint32();
    const distortionModel = reader.string();
    const d = reader.float64Sequence(256);
    const k = reader.float64Array(9);
    const r = reader.float64Array(9);
    const p = reader.float64Array(12);
    reader.uint32(); reader.uint32(); // binning x/y
    reader.uint32(); reader.uint32(); reader.uint32(); reader.uint32(); reader.uint8(); // ROI
    reader.ensureConsumed();
    return { kind: "camera-info", message: { frameId: header.frameId, stampNanos: header.stampNanos, width, height, distortionModel, d, k, r, p } };
  }
  if (schema === "visualization_msgs/Marker" || schema === "visualization_msgs/MarkerArray") {
    const schemaDefinition = input.channel.schema.definition
      ?? (input.channel.schema.data ? new TextDecoder("utf-8", { fatal: true }).decode(input.channel.schema.data) : "");
    const parseMarkers = (candidate: SemanticReader, hasRos2ExtensionFields: boolean): DecodedMarker => {
      const markerCount = schema === "visualization_msgs/Marker" ? 1 : candidate.uint32();
      if (markerCount > limits.maxPointFields * 1024) throw new Error("MarkerArray marker count exceeds limits");
      const markers = Array.from({ length: markerCount }, () => readMarker(candidate, limits, hasRos2ExtensionFields));
      candidate.ensureConsumed();
      return { kind: "marker", message: { markers } };
    };
    if (reader instanceof Ros1Reader) return parseMarkers(reader, false);
    if (schemaDefinition) {
      const hasRos2ExtensionFields = /texture_resource|uv_coordinates|mesh_file/u.test(schemaDefinition);
      return parseMarkers(reader, hasRos2ExtensionFields);
    }
    let extended: DecodedMarker | undefined;
    let legacy: DecodedMarker | undefined;
    let extendedError: unknown;
    let legacyError: unknown;
    try { extended = parseMarkers(new CdrReader(input.data, limits), true); } catch (error) { extendedError = error; }
    try { legacy = parseMarkers(new CdrReader(input.data, limits), false); } catch (error) { legacyError = error; }
    if (extended && legacy) throw new Error("ROS2 Marker layout is ambiguous without a schema definition");
    if (extended) return extended;
    if (legacy) return legacy;
    throw new Error(`ROS2 Marker does not match the current or legacy bounded layout: ${extendedError instanceof Error ? extendedError.message : String(extendedError)}; ${legacyError instanceof Error ? legacyError.message : String(legacyError)}`);
  }
  if (schema === "std_msgs/Float32" || schema === "std_msgs/Float64" || schema === "std_msgs/Int32" || schema === "std_msgs/UInt32") {
    let value: number;
    switch (schema) {
      case "std_msgs/Float32": value = reader.float32(); break;
      case "std_msgs/Float64": value = reader.float64(); break;
      case "std_msgs/Int32": value = reader.int32(); break;
      case "std_msgs/UInt32": value = reader.uint32(); break;
    }
    reader.ensureConsumed();
    return { kind: "numeric", message: { fieldPath: "data", value, sourceTimeNanos: 0n } };
  }
  throw new Error(`no native semantic decoder for ${input.channel.schema.name}`);
}

export function decodeRenderAndRelease(
  input: SemanticMcapMessage,
  epoch: number,
  lease: PayloadLeasePort,
  display: SemanticDisplayPort,
  limits: SemanticDecodeLimits = DEFAULT_SEMANTIC_DECODE_LIMITS,
): unknown {
  lease.assertUsable(epoch);
  try {
    const decoded = decodeSemanticMessage(input, limits);
    let summary: unknown;
    if (decoded.kind === "pointcloud2") {
      if (display.kind !== "pointcloud2") throw new Error("decoded pointcloud2 cannot update path display");
      summary = display.update(decoded.message, epoch);
    } else if (decoded.kind === "path") {
      if (display.kind !== "path") throw new Error("decoded path cannot update pointcloud2 display");
      summary = display.update(decoded.message, epoch);
    } else {
      throw new Error("image messages require a raster display port");
    }
    display.render();
    return summary;
  } finally {
    lease.release();
  }
}

export interface LocalMcapSelection {
  readonly name: string;
  readonly sizeBytes: number;
  readonly immutableVersion: string;
  readonly blob?: Blob;
}

export interface LocalMcapTopicSummary {
  readonly id: string;
  readonly name: string;
  readonly typeName: string;
  readonly compatibility: "native-display" | "schema-backed-generic" | "opaque-inspectable";
  readonly schemaCapability: "schema-present" | "opaque";
  readonly availableDisplays: ReturnType<typeof availableDisplaysForSchema>;
}

export interface LocalMcapOpenResult {
  readonly sourceLabel: string;
  readonly sourceHash: string;
  readonly durationNanos: bigint;
  readonly epoch: number;
  readonly indexState: "indexed" | "sequential";
  readonly topics: readonly LocalMcapTopicSummary[];
  readonly diagnostic?: string;
}

export interface LocalMcapSeekResult {
  readonly epoch: number;
  readonly currentTimeNanos: bigint;
  readonly diagnostic?: string;
}

const DEFAULT_DESKTOP_MCAP_LIMITS: McapLimits = {
  sequentialReadBytes: 256 * 1024,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxDecompressedBytes: 64 * 1024 * 1024,
  maxDecompressionRatio: 100,
  maxMessageIndexCacheBytes: 8 * 1024 * 1024,
};

function topicSummary(channel: McapChannelInfo): LocalMcapTopicSummary {
  const displays = availableDisplaysForSchema(channel.schema.name, channel.schema.capability);
  return {
    id: String(channel.id),
    name: channel.topic,
    typeName: channel.schema.name,
    compatibility:
      displays.some((display) => display !== "raw")
        ? "native-display"
        : channel.schema.capability === "schema-present"
          ? "schema-backed-generic"
          : "opaque-inspectable",
    schemaCapability: channel.schema.capability,
    availableDisplays: displays,
  };
}

export class LocalMcapDesktopRuntime {
  readonly #epoch = new SourceEpochController();
  readonly #workerLimits: WorkerResourceLimits;
  readonly #mcapLimits: McapLimits;
  readonly #decompressors: Readonly<Record<string, Decompressor>>;
  #blob?: Blob;
  #mode?: "indexed" | "unindexed-degraded";
  #startTime = 0n;
  #duration = 0n;
  #lastReadTelemetry?: Readonly<ReadTelemetry>;

  constructor(
    workerLimits: WorkerResourceLimits = DEFAULT_WORKER_LIMITS,
    mcapLimits: McapLimits = DEFAULT_DESKTOP_MCAP_LIMITS,
    decompressors: Readonly<Record<string, Decompressor>> = {},
  ) {
    this.#workerLimits = workerLimits;
    this.#mcapLimits = mcapLimits;
    this.#decompressors = decompressors;
  }

  async openLocalMcap(selection: LocalMcapSelection): Promise<LocalMcapOpenResult> {
    if (selection.name.trim().length === 0) throw new Error("local MCAP selection name cannot be empty");
    if (selection.immutableVersion.trim().length === 0) {
      throw new Error("local MCAP selection immutable version cannot be empty");
    }
    if (!Number.isSafeInteger(selection.sizeBytes) || selection.sizeBytes < 0) {
      throw new Error("local MCAP selection size must be a non-negative safe integer");
    }
    if (!selection.blob) throw new Error("local MCAP selection is missing its Blob handle");
    if (selection.sizeBytes !== selection.blob.size) throw new Error("local MCAP selection size does not match its Blob");
    this.#epoch.advance("local MCAP opened");
    this.#blob = undefined;
    this.#mode = undefined;
    this.#startTime = 0n;
    this.#duration = 0n;
    this.#lastReadTelemetry = undefined;
    const { reader, session } = await this.#openSession(selection.blob);
    const channels = new Map<number, McapChannelInfo>();
    for (const channel of session.channels()) channels.set(channel.id, channel);
    let minimumTime: bigint | undefined;
    let maximumTime: bigint | undefined;
    const accept = (logTimeNanos: bigint, channel: McapChannelInfo): void => {
      channels.set(channel.id, channel);
      minimumTime = minimumTime === undefined || logTimeNanos < minimumTime ? logTimeNanos : minimumTime;
      maximumTime = maximumTime === undefined || logTimeNanos > maximumTime ? logTimeNanos : maximumTime;
    };
    if (session.mode === "indexed") {
      const range = session.timeRange();
      if (range) {
        minimumTime = range.startTimeNanos;
        maximumTime = range.endTimeNanos;
      }
      if (channels.size === 0) {
        for await (const message of session.readIndexed()) accept(message.logTimeNanos, message.channel);
      }
    } else {
      for await (const event of session.scanUnindexed()) {
        if (event.kind === "message") accept(event.message.logTimeNanos, event.message.channel);
      }
    }
    this.#lastReadTelemetry = reader.snapshotTelemetry();
    this.#startTime = minimumTime ?? 0n;
    this.#duration = minimumTime === undefined || maximumTime === undefined ? 0n : maximumTime - minimumTime;
    this.#blob = selection.blob;
    this.#mode = session.mode;
    return {
      sourceLabel: selection.name,
      sourceHash: selection.immutableVersion,
      durationNanos: this.#duration,
      epoch: this.#epoch.epoch,
      indexState: session.mode === "indexed" ? "indexed" : "sequential",
      topics: [...channels.values()].sort((left, right) => left.id - right.id).map(topicSummary),
      ...(session.diagnostic === undefined ? {} : { diagnostic: session.diagnostic }),
    };
  }

  async seek(timeNanos: bigint): Promise<LocalMcapSeekResult> {
    if (!this.#blob || !this.#mode) throw new Error("open a local MCAP source before seeking");
    const boundedTime = timeNanos < 0n ? 0n : timeNanos > this.#duration ? this.#duration : timeNanos;
    this.#epoch.advance("local MCAP seek");
    const { reader, session } = await this.#openSession(this.#blob);
    this.#lastReadTelemetry = reader.snapshotTelemetry();
    if (this.#mode === "unindexed-degraded" || session.mode !== "indexed") {
      return {
        epoch: this.#epoch.epoch,
        currentTimeNanos: 0n,
        diagnostic: "Unindexed MCAP remains in sequential degraded mode; random seek is unavailable.",
      };
    }
    const absolute = this.#startTime + boundedTime;
    await session.readIndexed({ startTime: absolute, endTime: absolute + 1n }).next();
    this.#lastReadTelemetry = reader.snapshotTelemetry();
    return { epoch: this.#epoch.epoch, currentTimeNanos: boundedTime };
  }

  readTelemetry(): Readonly<ReadTelemetry> | undefined {
    return this.#lastReadTelemetry;
  }

  async #openSession(blob: Blob): Promise<{ readonly reader: BoundedByteReader; readonly session: McapSourceSession }> {
    const reader = new BoundedByteReader(new BlobRangeSource(blob), this.#epoch, this.#workerLimits);
    const session = await McapSourceSession.open(reader, { limits: this.#mcapLimits, decompressors: this.#decompressors });
    return { reader, session };
  }
}
