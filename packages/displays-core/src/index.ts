export type DisplayState =
  | "registered"
  | "instantiated"
  | "configured"
  | "attached"
  | "rendering"
  | "suspended"
  | "error"
  | "disposed";

export type PrimitiveTopology = "points" | "line-strip" | "lines";

export type DisplayKind =
  | "camera-info"
  | "frame-tree"
  | "grid"
  | "image"
  | "laser-scan"
  | "marker"
  | "numeric-plot"
  | "occupancy-grid"
  | "odometry"
  | "path"
  | "pointcloud2"
  | "pose"
  | "raw-inspector";

export type SemanticPrimitive = PrimitiveTopology | "raster" | "tree" | "plot" | "table";

export interface GeometryInput {
  readonly id: string;
  readonly topology: PrimitiveTopology;
  readonly positions: Float32Array;
  readonly color?: readonly [number, number, number, number];
}

export interface GeometryResource {
  readonly id: string;
  readonly vertexCount: number;
  readonly disposed: boolean;
  draw(): void;
  dispose(): void;
}

export interface GeometryRendererPort {
  upsert(input: GeometryInput): GeometryResource;
  remove(id: string): void;
}

export interface Bounds3 {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface SemanticSceneSummary {
  readonly displayKind: DisplayKind;
  readonly frameId: string;
  readonly primitive: SemanticPrimitive;
  readonly inputVertices: number;
  readonly renderedVertices: number;
  readonly droppedVertices: number;
  readonly bounds?: Bounds3;
  readonly diagnostics?: readonly string[];
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

type GeometrySceneSummary = SemanticSceneSummary & { readonly primitive: PrimitiveTopology };

export interface PreparedPointCloud2 {
  readonly positions: Float32Array;
  readonly color?: readonly [number, number, number, number];
  readonly summary: GeometrySceneSummary;
}

export interface DisplayTelemetry {
  readonly state: DisplayState;
  readonly updates: number;
  readonly renders: number;
  readonly rejectedMessages: number;
  readonly decimatedVertices: number;
  readonly lastSummary?: SemanticSceneSummary;
  readonly lastError?: string;
}

export interface PointField {
  readonly name: string;
  readonly offset: number;
  readonly datatype: number;
  readonly count: number;
}

export interface PointCloud2Message {
  readonly frameId: string;
  readonly width: number;
  readonly height: number;
  readonly pointStep: number;
  readonly rowStep: number;
  readonly isBigEndian: boolean;
  readonly fields: readonly PointField[];
  readonly data: Uint8Array;
}

export interface PathPose {
  readonly position: Readonly<{ x: number; y: number; z: number }>;
}

export interface PathMessage {
  readonly frameId: string;
  readonly poses: readonly PathPose[];
}

export interface PointCloud2DisplayConfig {
  readonly maxPoints: number;
  readonly maxInputBytes: number;
  readonly color?: readonly [number, number, number, number];
}

export interface PathDisplayConfig {
  readonly maxPoses: number;
  readonly maxInputBytes: number;
  readonly color?: readonly [number, number, number, number];
}

export interface ManagedDisplay<TMessage, TConfig> {
  readonly id: string;
  readonly kind: DisplayKind;
  readonly state: DisplayState;
  configure(config: TConfig): void;
  attachSource(epoch: number): void;
  update(message: TMessage, epoch: number): SemanticSceneSummary;
  render(): void;
  suspend(): void;
  dispose(): void;
  telemetry(): DisplayTelemetry;
}

function assertLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function assertColor(color: readonly number[] | undefined): void {
  if (color === undefined) return;
  if (color.length !== 4 || color.some((component) => !Number.isFinite(component) || component < 0 || component > 1)) {
    throw new Error("display color must contain four finite components between 0 and 1");
  }
}

function boundsFor(positions: Float32Array): Bounds3 | undefined {
  if (positions.length === 0) return undefined;
  let minX = positions[0] ?? 0;
  let minY = positions[1] ?? 0;
  let minZ = positions[2] ?? 0;
  let maxX = minX;
  let maxY = minY;
  let maxZ = minZ;
  for (let index = 3; index < positions.length; index += 3) {
    const x = positions[index] ?? 0;
    const y = positions[index + 1] ?? 0;
    const z = positions[index + 2] ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function finitePosition(position: Readonly<{ x: number; y: number; z: number }>): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
}

abstract class GeometryDisplay<TMessage, TConfig> implements ManagedDisplay<TMessage, TConfig> {
  abstract readonly kind: DisplayKind;
  #state: DisplayState = "instantiated";
  #epoch?: number;
  #resource?: GeometryResource;
  #updates = 0;
  #renders = 0;
  #rejectedMessages = 0;
  #decimatedVertices = 0;
  #lastSummary?: SemanticSceneSummary;
  #lastError?: string;
  protected config?: TConfig;

  constructor(readonly id: string, protected readonly renderer: GeometryRendererPort) {
    if (!id) throw new Error("display id is required");
  }

  get state(): DisplayState {
    return this.#state;
  }

  configure(config: TConfig): void {
    this.#assertNotDisposed();
    this.validateConfig(config);
    this.config = config;
    this.#state = "configured";
  }

  attachSource(epoch: number): void {
    this.#assertNotDisposed();
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("source epoch must be a non-negative safe integer");
    if (this.config === undefined) throw new Error("display must be configured before attaching a source");
    this.#resource?.dispose();
    this.#resource = undefined;
    this.#epoch = epoch;
    this.#state = "attached";
  }

  update(message: TMessage, epoch: number): SemanticSceneSummary {
    return this.updateConverted(() => {
      if (this.config === undefined) throw new Error("display has no configured source");
      return this.convert(message, this.config);
    }, epoch);
  }

  protected updatePreparedGeometry(
    converted: { positions: Float32Array; color?: readonly [number, number, number, number]; summary: GeometrySceneSummary },
    epoch: number,
  ): SemanticSceneSummary {
    return this.updateConverted(() => converted, epoch);
  }

  private updateConverted(
    convert: () => { positions: Float32Array; color?: readonly [number, number, number, number]; summary: GeometrySceneSummary },
    epoch: number,
  ): SemanticSceneSummary {
    this.#assertNotDisposed();
    if (this.config === undefined || this.#epoch === undefined) throw new Error("display has no configured source");
    if (epoch !== this.#epoch) throw new Error("stale source epoch");
    try {
      const converted = convert();
      this.#resource?.dispose();
      this.#resource = this.renderer.upsert({
        id: this.id,
        topology: converted.summary.primitive,
        positions: converted.positions,
        color: converted.color,
      });
      this.#updates += 1;
      this.#decimatedVertices += converted.summary.droppedVertices;
      this.#lastSummary = converted.summary;
      this.#lastError = undefined;
      this.#state = "rendering";
      return converted.summary;
    } catch (error) {
      this.#rejectedMessages += 1;
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#state = "error";
      throw error;
    }
  }

  render(): void {
    this.#assertNotDisposed();
    if (this.#resource === undefined || this.#state !== "rendering") throw new Error("display is not ready to render");
    this.#resource.draw();
    this.#renders += 1;
  }

  suspend(): void {
    this.#assertNotDisposed();
    this.#state = "suspended";
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    this.#resource?.dispose();
    this.renderer.remove(this.id);
    this.#resource = undefined;
    this.#state = "disposed";
  }

  telemetry(): DisplayTelemetry {
    return {
      state: this.#state,
      updates: this.#updates,
      renders: this.#renders,
      rejectedMessages: this.#rejectedMessages,
      decimatedVertices: this.#decimatedVertices,
      ...(this.#lastSummary === undefined ? {} : { lastSummary: this.#lastSummary }),
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
    };
  }

  protected abstract validateConfig(config: TConfig): void;
  protected abstract convert(
    message: TMessage,
    config: TConfig,
  ): { positions: Float32Array; color?: readonly [number, number, number, number]; summary: GeometrySceneSummary };

  #assertNotDisposed(): void {
    if (this.#state === "disposed") throw new Error("display is disposed");
  }
}

const FLOAT32_DATATYPE = 7;
const MAX_POINT_FIELDS = 64;

export function preparePointCloud2(message: PointCloud2Message, config: PointCloud2DisplayConfig): PreparedPointCloud2 {
  assertLimit(config.maxPoints, "maxPoints");
  assertLimit(config.maxInputBytes, "maxInputBytes");
  assertColor(config.color);
  assertLimit(message.width, "point cloud width");
  assertLimit(message.height, "point cloud height");
  assertLimit(message.pointStep, "pointStep");
  assertLimit(message.rowStep, "rowStep");
  if (message.data.byteLength > config.maxInputBytes) throw new Error("PointCloud2 input byte budget exceeded");
  const pointCount = message.width * message.height;
  if (!Number.isSafeInteger(pointCount)) throw new Error("PointCloud2 dimensions overflow");
  if (pointCount > config.maxPoints) throw new Error("PointCloud2 point count exceeds the configured full-data limit");
  const packedRowBytes = message.width * message.pointStep;
  const requiredBytes = message.rowStep * message.height;
  if (!Number.isSafeInteger(packedRowBytes) || !Number.isSafeInteger(requiredBytes)) {
    throw new Error("PointCloud2 byte dimensions overflow");
  }
  if (message.rowStep < packedRowBytes) throw new Error("PointCloud2 rowStep is too small");
  if (requiredBytes > message.data.byteLength) throw new Error("PointCloud2 data is truncated");
  if (message.fields.length > MAX_POINT_FIELDS) throw new Error("PointCloud2 field count exceeds limit");

  const axes = ["x", "y", "z"].map((name) => {
    const field = message.fields.find((candidate) => candidate.name === name);
    if (field === undefined || field.datatype !== FLOAT32_DATATYPE || field.count !== 1) {
      throw new Error(`PointCloud2 requires scalar FLOAT32 field ${name}`);
    }
    if (!Number.isSafeInteger(field.offset) || field.offset < 0 || field.offset + 4 > message.pointStep) {
      throw new Error(`PointCloud2 field ${name} exceeds pointStep`);
    }
    return field;
  });

  const positions = new Float32Array(pointCount * 3);
  const view = new DataView(message.data.buffer, message.data.byteOffset, message.data.byteLength);
  let outputCount = 0;
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    const row = Math.floor(pointIndex / message.width);
    const column = pointIndex % message.width;
    const pointOffset = row * message.rowStep + column * message.pointStep;
    const x = view.getFloat32(pointOffset + (axes[0]?.offset ?? 0), !message.isBigEndian);
    const y = view.getFloat32(pointOffset + (axes[1]?.offset ?? 0), !message.isBigEndian);
    const z = view.getFloat32(pointOffset + (axes[2]?.offset ?? 0), !message.isBigEndian);
    if (!finitePosition({ x, y, z })) continue;
    const target = outputCount * 3;
    positions[target] = x;
    positions[target + 1] = y;
    positions[target + 2] = z;
    outputCount += 1;
  }
  if (outputCount === 0) throw new Error("PointCloud2 contains no finite points");
  const bounded = positions.slice(0, outputCount * 3);
  const summary: GeometrySceneSummary = {
    displayKind: "pointcloud2",
    frameId: message.frameId,
    primitive: "points",
    inputVertices: pointCount,
    renderedVertices: outputCount,
    droppedVertices: pointCount - outputCount,
    bounds: boundsFor(bounded),
  };
  return { positions: bounded, color: config.color, summary };
}

export class PointCloud2Display extends GeometryDisplay<PointCloud2Message, PointCloud2DisplayConfig> {
  readonly kind = "pointcloud2" as const;

  protected validateConfig(config: PointCloud2DisplayConfig): void {
    assertLimit(config.maxPoints, "maxPoints");
    assertLimit(config.maxInputBytes, "maxInputBytes");
    assertColor(config.color);
  }

  protected convert(message: PointCloud2Message, config: PointCloud2DisplayConfig) {
    return preparePointCloud2(message, config);
  }

  updatePrepared(prepared: PreparedPointCloud2, epoch: number): SemanticSceneSummary {
    if (!(prepared.positions instanceof Float32Array) || prepared.positions.length !== prepared.summary.renderedVertices * 3 || prepared.summary.displayKind !== "pointcloud2" || prepared.summary.primitive !== "points") {
      throw new Error("Prepared PointCloud2 geometry is invalid");
    }
    return this.updatePreparedGeometry(prepared, epoch);
  }
}

export class PathDisplay extends GeometryDisplay<PathMessage, PathDisplayConfig> {
  readonly kind = "path" as const;

  protected validateConfig(config: PathDisplayConfig): void {
    assertLimit(config.maxPoses, "maxPoses");
    assertLimit(config.maxInputBytes, "maxInputBytes");
    assertColor(config.color);
  }

  protected convert(message: PathMessage, config: PathDisplayConfig) {
    const inputCount = message.poses.length;
    if (!Number.isSafeInteger(inputCount) || inputCount < 1) throw new Error("Path requires at least one pose");
    const estimatedBytes = inputCount * 3 * Float64Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > config.maxInputBytes) {
      throw new Error("Path input byte budget exceeded");
    }
    if (inputCount > config.maxPoses) throw new Error("Path pose count exceeds the configured full-data limit");
    const positions = new Float32Array(inputCount * 3);
    let outputCount = 0;
    for (let index = 0; index < inputCount; index += 1) {
      const position = message.poses[index]?.position;
      if (position === undefined || !finitePosition(position)) continue;
      const target = outputCount * 3;
      positions[target] = position.x;
      positions[target + 1] = position.y;
      positions[target + 2] = position.z;
      outputCount += 1;
    }
    if (outputCount === 0) throw new Error("Path contains no finite poses");
    const bounded = positions.slice(0, outputCount * 3);
    const summary: GeometrySceneSummary = {
      displayKind: "path",
      frameId: message.frameId,
      primitive: "line-strip",
      inputVertices: inputCount,
      renderedVertices: outputCount,
      droppedVertices: inputCount - outputCount,
      bounds: boundsFor(bounded),
    };
    return { positions: bounded, color: config.color, summary };
  }
}

abstract class SummaryDisplay<TMessage, TConfig> implements ManagedDisplay<TMessage, TConfig> {
  abstract readonly kind: DisplayKind;
  #state: DisplayState = "instantiated";
  #epoch?: number;
  #updates = 0;
  #renders = 0;
  #rejectedMessages = 0;
  #decimatedVertices = 0;
  #lastSummary?: SemanticSceneSummary;
  #lastError?: string;
  protected config?: TConfig;

  constructor(readonly id: string) {
    if (!id) throw new Error("display id is required");
  }

  get state(): DisplayState {
    return this.#state;
  }

  configure(config: TConfig): void {
    this.#assertNotDisposed();
    this.validateConfig(config);
    this.config = config;
    this.#state = "configured";
  }

  attachSource(epoch: number): void {
    this.#assertNotDisposed();
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("source epoch must be a non-negative safe integer");
    if (this.config === undefined) throw new Error("display must be configured before attaching a source");
    this.#epoch = epoch;
    this.onAttach();
    this.#state = "attached";
  }

  update(message: TMessage, epoch: number): SemanticSceneSummary {
    this.#assertNotDisposed();
    if (this.config === undefined || this.#epoch === undefined) throw new Error("display has no configured source");
    if (epoch !== this.#epoch) throw new Error("stale source epoch");
    try {
      const summary = this.summarize(message, this.config);
      this.#updates += 1;
      this.#decimatedVertices += summary.droppedVertices;
      this.#lastSummary = summary;
      this.#lastError = undefined;
      this.#state = "rendering";
      return summary;
    } catch (error) {
      this.#rejectedMessages += 1;
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#state = "error";
      throw error;
    }
  }

  render(): void {
    this.#assertNotDisposed();
    if (this.#lastSummary === undefined || this.#state !== "rendering") throw new Error("display is not ready to render");
    this.#renders += 1;
  }

  suspend(): void {
    this.#assertNotDisposed();
    this.#state = "suspended";
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    this.onDispose();
    this.#state = "disposed";
  }

  telemetry(): DisplayTelemetry {
    return {
      state: this.#state,
      updates: this.#updates,
      renders: this.#renders,
      rejectedMessages: this.#rejectedMessages,
      decimatedVertices: this.#decimatedVertices,
      ...(this.#lastSummary === undefined ? {} : { lastSummary: this.#lastSummary }),
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
    };
  }

  protected onAttach(): void {}
  protected onDispose(): void {}
  protected abstract validateConfig(config: TConfig): void;
  protected abstract summarize(message: TMessage, config: TConfig): SemanticSceneSummary;

  #assertNotDisposed(): void {
    if (this.#state === "disposed") throw new Error("display is disposed");
  }
}

export interface LaserScanMessage {
  readonly frameId: string;
  readonly angleMin: number;
  readonly angleIncrement: number;
  readonly rangeMin: number;
  readonly rangeMax: number;
  readonly ranges: readonly number[] | Float32Array;
}

export interface LaserScanDisplayConfig {
  readonly maxRanges: number;
  readonly maxInputBytes: number;
  readonly color?: readonly [number, number, number, number];
}

export class LaserScanDisplay extends GeometryDisplay<LaserScanMessage, LaserScanDisplayConfig> {
  readonly kind = "laser-scan" as const;

  protected validateConfig(config: LaserScanDisplayConfig): void {
    assertLimit(config.maxRanges, "maxRanges");
    assertLimit(config.maxInputBytes, "maxInputBytes");
    assertColor(config.color);
  }

  protected convert(message: LaserScanMessage, config: LaserScanDisplayConfig) {
    if (!Number.isFinite(message.angleMin) || !Number.isFinite(message.angleIncrement) || message.angleIncrement === 0) {
      throw new Error("LaserScan angles must be finite and angleIncrement must be non-zero");
    }
    if (!Number.isFinite(message.rangeMin) || !Number.isFinite(message.rangeMax) || message.rangeMin < 0 || message.rangeMax <= message.rangeMin) {
      throw new Error("LaserScan range bounds are invalid");
    }
    const inputCount = message.ranges.length;
    if (inputCount < 1) throw new Error("LaserScan requires at least one range");
    const inputBytes = inputCount * Float32Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(inputBytes) || inputBytes > config.maxInputBytes) {
      throw new Error("LaserScan input byte budget exceeded");
    }
    if (inputCount > config.maxRanges) throw new Error("LaserScan range count exceeds the configured full-data limit");
    const positions = new Float32Array(inputCount * 3);
    let outputCount = 0;
    for (let index = 0; index < inputCount; index += 1) {
      const range = message.ranges[index];
      if (range === undefined || !Number.isFinite(range) || range < message.rangeMin || range > message.rangeMax) continue;
      const angle = message.angleMin + index * message.angleIncrement;
      positions[outputCount * 3] = range * Math.cos(angle);
      positions[outputCount * 3 + 1] = range * Math.sin(angle);
      positions[outputCount * 3 + 2] = 0;
      outputCount += 1;
    }
    if (outputCount === 0) throw new Error("LaserScan contains no finite in-range samples");
    const bounded = positions.slice(0, outputCount * 3);
    return {
      positions: bounded,
      color: config.color,
      summary: {
        displayKind: this.kind,
        frameId: message.frameId,
        primitive: "points" as const,
        inputVertices: inputCount,
        renderedVertices: outputCount,
        droppedVertices: inputCount - outputCount,
        bounds: boundsFor(bounded),
      },
    };
  }
}

export interface FrameTransform {
  readonly parentFrameId: string;
  readonly childFrameId: string;
  readonly translation: Readonly<{ x: number; y: number; z: number }>;
  readonly rotation?: Readonly<{ x: number; y: number; z: number; w: number }>;
}

export interface FrameTreeMessage {
  readonly transforms: readonly FrameTransform[];
}

export interface FrameTreeDisplayConfig {
  readonly fixedFrame: string;
  readonly maxTransforms: number;
  readonly maxInputBytes: number;
  readonly color?: readonly [number, number, number, number];
}

export class FrameTreeDisplay extends GeometryDisplay<FrameTreeMessage, FrameTreeDisplayConfig> {
  readonly kind = "frame-tree" as const;

  protected validateConfig(config: FrameTreeDisplayConfig): void {
    if (!config.fixedFrame) throw new Error("TF fixed frame is required");
    assertLimit(config.maxTransforms, "maxTransforms");
    assertLimit(config.maxInputBytes, "maxInputBytes");
    assertColor(config.color);
  }

  protected convert(message: FrameTreeMessage, config: FrameTreeDisplayConfig) {
    if (message.transforms.length > config.maxTransforms) throw new Error("TF transform count exceeds limit");
    const estimatedBytes = message.transforms.length * 128;
    if (estimatedBytes > config.maxInputBytes) throw new Error("TF input byte budget exceeded");
    const byChild = new Map<string, FrameTransform>();
    const frames = new Set<string>([config.fixedFrame]);
    for (const transform of message.transforms) {
      if (!transform.parentFrameId || !transform.childFrameId) throw new Error("TF frame names are required");
      if (transform.parentFrameId === transform.childFrameId) throw new Error(`TF cycle at frame ${transform.childFrameId}`);
      if (!finitePosition(transform.translation)) throw new Error(`TF transform for ${transform.childFrameId} is not finite`);
      if (byChild.has(transform.childFrameId)) throw new Error(`TF child frame is ambiguous: ${transform.childFrameId}`);
      byChild.set(transform.childFrameId, transform);
      frames.add(transform.parentFrameId);
      frames.add(transform.childFrameId);
    }
    if (!frames.has(config.fixedFrame)) throw new Error(`TF fixed frame is missing: ${config.fixedFrame}`);

    type ResolvedTransform = Readonly<{
      translation: readonly [number, number, number];
      rotation: readonly [number, number, number, number];
    }>;
    const normalizeQuaternion = (rotation: readonly [number, number, number, number]): readonly [number, number, number, number] => {
      const norm = Math.hypot(...rotation);
      if (!Number.isFinite(norm) || norm === 0) throw new Error("TF quaternion must be finite and non-zero");
      return [rotation[0] / norm, rotation[1] / norm, rotation[2] / norm, rotation[3] / norm];
    };
    const multiplyQuaternion = (
      left: readonly [number, number, number, number],
      right: readonly [number, number, number, number],
    ): readonly [number, number, number, number] => [
      left[3] * right[0] + left[0] * right[3] + left[1] * right[2] - left[2] * right[1],
      left[3] * right[1] - left[0] * right[2] + left[1] * right[3] + left[2] * right[0],
      left[3] * right[2] + left[0] * right[1] - left[1] * right[0] + left[2] * right[3],
      left[3] * right[3] - left[0] * right[0] - left[1] * right[1] - left[2] * right[2],
    ];
    const rotate = (
      rotation: readonly [number, number, number, number],
      translation: Readonly<{ x: number; y: number; z: number }>,
    ): readonly [number, number, number] => {
      const vector: readonly [number, number, number, number] = [translation.x, translation.y, translation.z, 0];
      const conjugate: readonly [number, number, number, number] = [-rotation[0], -rotation[1], -rotation[2], rotation[3]];
      const result = multiplyQuaternion(multiplyQuaternion(rotation, vector), conjugate);
      return [result[0], result[1], result[2]];
    };
    for (const frame of frames) {
      const visited = new Set<string>();
      let current = frame;
      while (byChild.has(current)) {
        if (visited.has(current)) throw new Error(`TF cycle detected at frame ${current}`);
        visited.add(current);
        current = byChild.get(current)!.parentFrameId;
      }
    }
    const identity: ResolvedTransform = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
    const compose = (fixedFromParent: ResolvedTransform, parentFromChild: ResolvedTransform): ResolvedTransform => {
      const translated = rotate(fixedFromParent.rotation, {
        x: parentFromChild.translation[0], y: parentFromChild.translation[1], z: parentFromChild.translation[2],
      });
      return {
        translation: [
          fixedFromParent.translation[0] + translated[0],
          fixedFromParent.translation[1] + translated[1],
          fixedFromParent.translation[2] + translated[2],
        ],
        rotation: normalizeQuaternion(multiplyQuaternion(fixedFromParent.rotation, parentFromChild.rotation)),
      };
    };
    const inverse = (parentFromChild: ResolvedTransform): ResolvedTransform => {
      const rotation = normalizeQuaternion([
        -parentFromChild.rotation[0], -parentFromChild.rotation[1], -parentFromChild.rotation[2], parentFromChild.rotation[3],
      ]);
      const translation = rotate(rotation, {
        x: -parentFromChild.translation[0], y: -parentFromChild.translation[1], z: -parentFromChild.translation[2],
      });
      return { translation, rotation };
    };
    const adjacency = new Map<string, { readonly frame: string; readonly transform: ResolvedTransform }[]>();
    for (const edge of message.transforms) {
      const parentFromChild: ResolvedTransform = {
        translation: [edge.translation.x, edge.translation.y, edge.translation.z],
        rotation: normalizeQuaternion(edge.rotation
          ? [edge.rotation.x, edge.rotation.y, edge.rotation.z, edge.rotation.w]
          : [0, 0, 0, 1]),
      };
      const fromParent = adjacency.get(edge.parentFrameId) ?? [];
      fromParent.push({ frame: edge.childFrameId, transform: parentFromChild });
      adjacency.set(edge.parentFrameId, fromParent);
      const fromChild = adjacency.get(edge.childFrameId) ?? [];
      fromChild.push({ frame: edge.parentFrameId, transform: inverse(parentFromChild) });
      adjacency.set(edge.childFrameId, fromChild);
    }
    const resolved = new Map<string, ResolvedTransform>([[config.fixedFrame, identity]]);
    const queue = [config.fixedFrame];
    for (let index = 0; index < queue.length; index += 1) {
      const frame = queue[index]!;
      const fixedFromFrame = resolved.get(frame)!;
      for (const neighbor of adjacency.get(frame) ?? []) {
        if (resolved.has(neighbor.frame)) continue;
        resolved.set(neighbor.frame, compose(fixedFromFrame, neighbor.transform));
        queue.push(neighbor.frame);
      }
    }
    for (const frame of frames) {
      if (!resolved.has(frame)) throw new Error(`TF frame ${frame} is disconnected from fixed frame ${config.fixedFrame}`);
    }

    const ordered = [...message.transforms].sort((left, right) => {
      const leftKey = `${left.parentFrameId}\u0000${left.childFrameId}`;
      const rightKey = `${right.parentFrameId}\u0000${right.childFrameId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const positions = new Float32Array(ordered.length * 6);
    ordered.forEach((edge, index) => {
      const parent = resolved.get(edge.parentFrameId)!;
      const child = resolved.get(edge.childFrameId)!;
      positions.set([...parent.translation, ...child.translation], index * 6);
    });
    if (ordered.length === 0) throw new Error("TF frame tree contains no transforms");
    return {
      positions,
      color: config.color,
      summary: {
        displayKind: this.kind,
        frameId: config.fixedFrame,
        primitive: "lines" as const,
        inputVertices: ordered.length * 2,
        renderedVertices: ordered.length * 2,
        droppedVertices: 0,
        bounds: boundsFor(positions),
        details: { frames: frames.size, transforms: ordered.length },
      },
    };
  }
}

export interface GridMessage {
  readonly frameId: string;
}

export interface GridDisplayConfig {
  readonly halfExtent: number;
  readonly divisions: number;
  readonly maxInputBytes: number;
  readonly color?: readonly [number, number, number, number];
}

export class GridDisplay extends GeometryDisplay<GridMessage, GridDisplayConfig> {
  readonly kind = "grid" as const;

  protected validateConfig(config: GridDisplayConfig): void {
    if (!Number.isFinite(config.halfExtent) || config.halfExtent <= 0) throw new Error("grid halfExtent must be positive");
    if (!Number.isSafeInteger(config.divisions) || config.divisions < 1 || config.divisions > 1024) {
      throw new Error("grid divisions must be between 1 and 1024");
    }
    assertLimit(config.maxInputBytes, "maxInputBytes");
    assertColor(config.color);
  }

  protected convert(message: GridMessage, config: GridDisplayConfig) {
    const vertices = (config.divisions + 1) * 4;
    const byteLength = vertices * 3 * Float32Array.BYTES_PER_ELEMENT;
    if (byteLength > config.maxInputBytes) throw new Error("grid input byte budget exceeded");
    const positions = new Float32Array(vertices * 3);
    let offset = 0;
    for (let index = 0; index <= config.divisions; index += 1) {
      const coordinate = -config.halfExtent + (index / config.divisions) * config.halfExtent * 2;
      positions.set([coordinate, 0, -config.halfExtent, coordinate, 0, config.halfExtent], offset);
      offset += 6;
      positions.set([-config.halfExtent, 0, coordinate, config.halfExtent, 0, coordinate], offset);
      offset += 6;
    }
    return {
      positions,
      color: config.color,
      summary: {
        displayKind: this.kind,
        frameId: message.frameId,
        primitive: "lines" as const,
        inputVertices: vertices,
        renderedVertices: vertices,
        droppedVertices: 0,
        bounds: boundsFor(positions),
        details: { divisions: config.divisions, halfExtent: config.halfExtent },
      },
    };
  }
}

export interface Quaternion {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface PoseMessage {
  readonly frameId: string;
  readonly position: Readonly<{ x: number; y: number; z: number }>;
  readonly orientation: Quaternion;
}

export interface PoseDisplayConfig {
  readonly axisLength: number;
  readonly maxInputBytes: number;
  readonly color?: readonly [number, number, number, number];
}

function poseLine(message: PoseMessage, axisLength: number): Float32Array {
  if (!finitePosition(message.position)) throw new Error("Pose position must be finite");
  const quaternion = message.orientation;
  const components = [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
  if (components.some((value) => !Number.isFinite(value))) throw new Error("Pose orientation must be finite");
  const norm = Math.hypot(...components);
  if (norm === 0) throw new Error("Pose orientation quaternion must be non-zero");
  const x = quaternion.x / norm;
  const y = quaternion.y / norm;
  const z = quaternion.z / norm;
  const w = quaternion.w / norm;
  const direction: readonly [number, number, number] = [
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
  ];
  return new Float32Array([
    message.position.x,
    message.position.y,
    message.position.z,
    message.position.x + direction[0] * axisLength,
    message.position.y + direction[1] * axisLength,
    message.position.z + direction[2] * axisLength,
  ]);
}

export class PoseDisplay extends GeometryDisplay<PoseMessage, PoseDisplayConfig> {
  readonly kind = "pose" as const;

  protected validateConfig(config: PoseDisplayConfig): void {
    if (!Number.isFinite(config.axisLength) || config.axisLength <= 0) throw new Error("axisLength must be positive");
    assertLimit(config.maxInputBytes, "maxInputBytes");
    assertColor(config.color);
  }

  protected convert(message: PoseMessage, config: PoseDisplayConfig) {
    if (config.maxInputBytes < 56) throw new Error("Pose input byte budget exceeded");
    const positions = poseLine(message, config.axisLength);
    return {
      positions,
      color: config.color,
      summary: {
        displayKind: this.kind,
        frameId: message.frameId,
        primitive: "lines" as const,
        inputVertices: 2,
        renderedVertices: 2,
        droppedVertices: 0,
        bounds: boundsFor(positions),
      },
    };
  }
}

export interface OdometryMessage {
  readonly frameId: string;
  readonly childFrameId: string;
  readonly pose: Omit<PoseMessage, "frameId">;
  readonly poseCovariance?: readonly number[];
}

export class OdometryDisplay extends GeometryDisplay<OdometryMessage, PoseDisplayConfig> {
  readonly kind = "odometry" as const;

  protected validateConfig(config: PoseDisplayConfig): void {
    if (!Number.isFinite(config.axisLength) || config.axisLength <= 0) throw new Error("axisLength must be positive");
    assertLimit(config.maxInputBytes, "maxInputBytes");
    assertColor(config.color);
  }

  protected convert(message: OdometryMessage, config: PoseDisplayConfig) {
    const covariance = message.poseCovariance;
    if (covariance !== undefined && (covariance.length !== 36 || covariance.some((value) => !Number.isFinite(value)))) {
      throw new Error("Odometry pose covariance must contain 36 finite values");
    }
    const inputBytes = 56 + (covariance?.length ?? 0) * Float64Array.BYTES_PER_ELEMENT;
    if (inputBytes > config.maxInputBytes) throw new Error("Odometry input byte budget exceeded");
    const positions = poseLine({ frameId: message.frameId, ...message.pose }, config.axisLength);
    return {
      positions,
      color: config.color,
      summary: {
        displayKind: this.kind,
        frameId: message.frameId,
        primitive: "lines" as const,
        inputVertices: 2,
        renderedVertices: 2,
        droppedVertices: 0,
        bounds: boundsFor(positions),
        details: { childFrameId: message.childFrameId, covarianceVisible: covariance !== undefined },
      },
    };
  }
}

export interface RawImageMessage {
  readonly frameId: string;
  readonly width: number;
  readonly height: number;
  readonly encoding: string;
  readonly step: number;
  readonly data: Uint8Array;
}

export interface CompressedImageMessage {
  readonly frameId: string;
  readonly format: string;
  readonly data: Uint8Array;
}

export interface ImageDisplayConfig {
  readonly maxInputBytes: number;
  readonly maxPixels: number;
  readonly supportedCompressedCodecs?: readonly string[];
}

const RAW_IMAGE_BYTES_PER_PIXEL: Readonly<Record<string, number>> = {
  mono8: 1,
  rgb8: 3,
  bgr8: 3,
  rgba8: 4,
  bgra8: 4,
};

export class ImageDisplay extends SummaryDisplay<RawImageMessage | CompressedImageMessage, ImageDisplayConfig> {
  readonly kind = "image" as const;

  protected validateConfig(config: ImageDisplayConfig): void {
    assertLimit(config.maxInputBytes, "maxInputBytes");
    assertLimit(config.maxPixels, "maxPixels");
    if (config.supportedCompressedCodecs?.some((codec) => !codec.trim())) throw new Error("compressed image codec names cannot be empty");
  }

  protected summarize(message: RawImageMessage | CompressedImageMessage, config: ImageDisplayConfig): SemanticSceneSummary {
    if (message.data.byteLength > config.maxInputBytes) throw new Error("Image input byte budget exceeded");
    if ("format" in message) {
      const codec = message.format.trim().toLowerCase().match(/(?:^|[;\s])(jpe?g|png|webp)(?:\s|$)/u)?.[1] ?? "";
      const supported = (config.supportedCompressedCodecs ?? ["jpeg", "jpg", "png", "webp"]).map((value) => value.toLowerCase());
      if (!supported.includes(codec)) throw new Error(`unsupported compressed image codec: ${message.format}`);
      return {
        displayKind: this.kind,
        frameId: message.frameId,
        primitive: "raster",
        inputVertices: message.data.byteLength,
        renderedVertices: message.data.byteLength,
        droppedVertices: 0,
        diagnostics: [`${codec} payload validated; raster decode is delegated to the bounded browser image decoder`],
        details: { compressed: true, codec, byteLength: message.data.byteLength },
      };
    }
    assertLimit(message.width, "image width");
    assertLimit(message.height, "image height");
    assertLimit(message.step, "image step");
    const pixelCount = message.width * message.height;
    if (!Number.isSafeInteger(pixelCount) || pixelCount > config.maxPixels) throw new Error("Image pixel budget exceeded");
    const bytesPerPixel = RAW_IMAGE_BYTES_PER_PIXEL[message.encoding.toLowerCase()];
    if (bytesPerPixel === undefined) throw new Error(`unsupported raw image encoding: ${message.encoding}`);
    if (message.step < message.width * bytesPerPixel) throw new Error("Image step is too small for its encoding");
    if (message.step * message.height > message.data.byteLength) throw new Error("Image data is truncated");
    return {
      displayKind: this.kind,
      frameId: message.frameId,
      primitive: "raster",
      inputVertices: pixelCount,
      renderedVertices: pixelCount,
      droppedVertices: 0,
      details: { compressed: false, encoding: message.encoding, width: message.width, height: message.height },
    };
  }
}

export interface CameraInfoMessage {
  readonly frameId: string;
  readonly width: number;
  readonly height: number;
  readonly distortionModel: string;
  readonly d: readonly number[];
  readonly k: readonly number[];
  readonly r: readonly number[];
  readonly p: readonly number[];
}

export interface CameraInfoDisplayConfig {
  readonly maxInputBytes: number;
  readonly supportedDistortionModels?: readonly string[];
}

export class CameraInfoDisplay extends SummaryDisplay<CameraInfoMessage, CameraInfoDisplayConfig> {
  readonly kind = "camera-info" as const;

  protected validateConfig(config: CameraInfoDisplayConfig): void {
    assertLimit(config.maxInputBytes, "maxInputBytes");
  }

  protected summarize(message: CameraInfoMessage, config: CameraInfoDisplayConfig): SemanticSceneSummary {
    assertLimit(message.width, "camera width");
    assertLimit(message.height, "camera height");
    if (message.k.length !== 9 || message.r.length !== 9 || message.p.length !== 12) {
      throw new Error("CameraInfo requires K[9], R[9], and P[12]");
    }
    const numbers = [...message.d, ...message.k, ...message.r, ...message.p];
    if (numbers.some((value) => !Number.isFinite(value))) throw new Error("CameraInfo matrices must be finite");
    if (numbers.length * Float64Array.BYTES_PER_ELEMENT > config.maxInputBytes) {
      throw new Error("CameraInfo input byte budget exceeded");
    }
    const supported = config.supportedDistortionModels ?? ["", "plumb_bob", "rational_polynomial", "equidistant"];
    const diagnostics = supported.includes(message.distortionModel)
      ? undefined
      : [`unsupported CameraInfo distortion model: ${message.distortionModel}`];
    return {
      displayKind: this.kind,
      frameId: message.frameId,
      primitive: "table",
      inputVertices: numbers.length,
      renderedVertices: numbers.length,
      droppedVertices: 0,
      ...(diagnostics === undefined ? {} : { diagnostics }),
      details: {
        width: message.width,
        height: message.height,
        distortionModel: message.distortionModel,
        calibrated: message.k[0] !== 0,
      },
    };
  }
}

export type MarkerType = "points" | "line-strip" | "line-list";

export interface MarkerMessage {
  readonly frameId: string;
  readonly namespace: string;
  readonly id: number;
  readonly action: "add" | "delete" | "delete-all";
  readonly type: MarkerType | string;
  readonly points: readonly Readonly<{ x: number; y: number; z: number }>[];
  readonly stampNanos?: bigint;
  readonly lifetimeNanos?: bigint;
}

export interface MarkerArrayMessage {
  readonly markers: readonly MarkerMessage[];
}

export interface MarkerDisplayConfig {
  readonly maxMarkers: number;
  readonly maxPoints: number;
  readonly maxInputBytes: number;
  readonly color?: readonly [number, number, number, number];
}

interface StoredMarker {
  readonly marker: MarkerMessage;
  readonly expiresAtNanos?: bigint;
}

export class MarkerStore {
  readonly #markers = new Map<string, StoredMarker>();

  apply(
    message: MarkerMessage | MarkerArrayMessage,
    defaultTimeNanos = 0n,
    maxMarkers = Number.MAX_SAFE_INTEGER,
  ): readonly MarkerMessage[] {
    assertLimit(maxMarkers, "maxMarkers");
    this.active(defaultTimeNanos);
    const updates = "markers" in message ? message.markers : [message];
    for (const marker of updates) {
      const timeNanos = marker.stampNanos ?? defaultTimeNanos;
      if (timeNanos < 0n) throw new Error("marker timestamp must be non-negative");
      if (marker.lifetimeNanos !== undefined && marker.lifetimeNanos < 0n) throw new Error("marker lifetime must be non-negative");
      if (marker.action === "delete-all") {
        this.#markers.clear();
        continue;
      }
      if (!Number.isSafeInteger(marker.id)) throw new Error("marker id must be a safe integer");
      const key = `${marker.namespace}\u0000${marker.id}`;
      if (marker.action === "delete") {
        this.#markers.delete(key);
        continue;
      }
      if (!this.#markers.has(key) && this.#markers.size >= maxMarkers) throw new Error("active marker count exceeds limit");
      const expiresAtNanos = marker.lifetimeNanos === undefined || marker.lifetimeNanos === 0n
        ? undefined
        : timeNanos + marker.lifetimeNanos;
      this.#markers.set(key, { marker, ...(expiresAtNanos === undefined ? {} : { expiresAtNanos }) });
    }
    return this.active(defaultTimeNanos);
  }

  active(timeNanos: bigint): readonly MarkerMessage[] {
    for (const [key, stored] of this.#markers) {
      if (stored.expiresAtNanos !== undefined && stored.expiresAtNanos <= timeNanos) this.#markers.delete(key);
    }
    return [...this.#markers.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, stored]) => stored.marker);
  }

  clear(): void {
    this.#markers.clear();
  }
}

export class MarkerDisplay extends GeometryDisplay<MarkerMessage | MarkerArrayMessage, MarkerDisplayConfig> {
  readonly kind = "marker" as const;
  readonly #store = new MarkerStore();

  override attachSource(epoch: number): void {
    super.attachSource(epoch);
    this.#store.clear();
  }

  activeMarkers(timeNanos: bigint): readonly MarkerMessage[] {
    return this.#store.active(timeNanos);
  }

  protected validateConfig(config: MarkerDisplayConfig): void {
    assertLimit(config.maxMarkers, "maxMarkers");
    assertLimit(config.maxPoints, "maxPoints");
    assertLimit(config.maxInputBytes, "maxInputBytes");
    assertColor(config.color);
  }

  protected convert(message: MarkerMessage | MarkerArrayMessage, config: MarkerDisplayConfig) {
    const markers = "markers" in message ? message.markers : [message];
    if (markers.length < 1) throw new Error("MarkerArray requires at least one marker");
    if (markers.length > config.maxMarkers) throw new Error("marker count exceeds limit");
    const updateTime = markers.reduce((latest, marker) => marker.stampNanos !== undefined && marker.stampNanos > latest ? marker.stampNanos : latest, 0n);
    const active = this.#store.apply(message, updateTime, config.maxMarkers);
    if (active.length === 0) throw new Error("marker actions left no renderable markers");
    if (new Set(active.map((marker) => marker.frameId)).size !== 1) throw new Error("mixed marker frames require separate displays");
    const types = new Set(active.map((marker) => marker.type));
    const allPoints = active.flatMap((marker) => [...marker.points]);
    if (allPoints.length < 1) throw new Error("marker contains no points");
    if (allPoints.length > config.maxPoints) throw new Error("marker point count exceeds the configured full-data limit");
    const inputBytes = allPoints.length * 3 * Float64Array.BYTES_PER_ELEMENT;
    if (inputBytes > config.maxInputBytes) throw new Error("marker input byte budget exceeded");
    if (allPoints.some((point) => !finitePosition(point))) throw new Error("marker points must be finite");
    const positions = new Float32Array(allPoints.length * 3);
    allPoints.forEach((point, index) => positions.set([point.x, point.y, point.z], index * 3));
    const topology: PrimitiveTopology = types.size === 1 && types.has("line-strip")
      ? "line-strip"
      : types.size === 1 && types.has("line-list") ? "lines" : "points";
    return {
      positions,
      color: config.color,
      summary: {
        displayKind: this.kind,
        frameId: active[0]?.frameId ?? "",
        primitive: topology,
        inputVertices: allPoints.length,
        renderedVertices: allPoints.length,
        droppedVertices: 0,
        bounds: boundsFor(positions),
        details: { markers: active.length, actionDeletes: markers.length - active.length, markerType: types.size === 1 ? [...types][0] : "mixed", markerTypes: [...types].sort().join(",") },
      },
    };
  }
}

export interface OccupancyGridMessage {
  readonly frameId: string;
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  readonly origin: Readonly<{ x: number; y: number; z: number }>;
  readonly orientation?: Quaternion;
  readonly data: readonly number[] | Int8Array;
}

export interface OccupancyGridDisplayConfig {
  readonly occupiedThreshold: number;
  readonly maxCells: number;
  readonly maxInputBytes: number;
  readonly color?: readonly [number, number, number, number];
}

export class OccupancyGridDisplay extends GeometryDisplay<OccupancyGridMessage, OccupancyGridDisplayConfig> {
  readonly kind = "occupancy-grid" as const;

  protected validateConfig(config: OccupancyGridDisplayConfig): void {
    if (!Number.isFinite(config.occupiedThreshold) || config.occupiedThreshold < 0 || config.occupiedThreshold > 100) {
      throw new Error("occupiedThreshold must be between 0 and 100");
    }
    assertLimit(config.maxCells, "maxCells");
    assertLimit(config.maxInputBytes, "maxInputBytes");
    assertColor(config.color);
  }

  protected convert(message: OccupancyGridMessage, config: OccupancyGridDisplayConfig) {
    assertLimit(message.width, "occupancy grid width");
    assertLimit(message.height, "occupancy grid height");
    if (!Number.isFinite(message.resolution) || message.resolution <= 0) throw new Error("occupancy grid resolution must be positive");
    if (!finitePosition(message.origin)) throw new Error("occupancy grid origin must be finite");
    const orientation = message.orientation ?? { x: 0, y: 0, z: 0, w: 1 };
    const orientationValues = [orientation.x, orientation.y, orientation.z, orientation.w];
    if (orientationValues.some((value) => !Number.isFinite(value))) throw new Error("occupancy grid orientation must be finite");
    const orientationNorm = Math.hypot(...orientationValues);
    if (orientationNorm === 0) throw new Error("occupancy grid orientation quaternion must be non-zero");
    const qx = orientation.x / orientationNorm;
    const qy = orientation.y / orientationNorm;
    const qz = orientation.z / orientationNorm;
    const qw = orientation.w / orientationNorm;
    const cellCount = message.width * message.height;
    if (!Number.isSafeInteger(cellCount) || message.data.length !== cellCount) throw new Error("OccupancyGrid data length does not match dimensions");
    if (message.data.length > config.maxInputBytes) throw new Error("OccupancyGrid input byte budget exceeded");
    if ([...message.data].some((value) => !Number.isInteger(value) || value < -1 || value > 100)) {
      throw new Error("OccupancyGrid values must be integers from -1 to 100");
    }
    const occupiedIndices: number[] = [];
    let unknown = 0;
    for (let index = 0; index < cellCount; index += 1) {
      const value = message.data[index] ?? -1;
      if (value < 0) unknown += 1;
      else if (value >= config.occupiedThreshold) occupiedIndices.push(index);
    }
    if (occupiedIndices.length === 0) throw new Error("OccupancyGrid contains no cells at or above occupiedThreshold");
    if (occupiedIndices.length > config.maxCells) throw new Error("OccupancyGrid occupied cell count exceeds the configured full-data limit");
    const positions = new Float32Array(occupiedIndices.length * 3);
    occupiedIndices.forEach((cellIndex, index) => {
      const column = cellIndex % message.width;
      const row = Math.floor(cellIndex / message.width);
      const localX = (column + 0.5) * message.resolution;
      const localY = (row + 0.5) * message.resolution;
      const rotatedX = (1 - 2 * (qy * qy + qz * qz)) * localX + 2 * (qx * qy - qz * qw) * localY;
      const rotatedY = 2 * (qx * qy + qz * qw) * localX + (1 - 2 * (qx * qx + qz * qz)) * localY;
      const rotatedZ = 2 * (qx * qz - qy * qw) * localX + 2 * (qy * qz + qx * qw) * localY;
      positions.set(
        [
          message.origin.x + rotatedX,
          message.origin.y + rotatedY,
          message.origin.z + rotatedZ,
        ],
        index * 3,
      );
    });
    return {
      positions,
      color: config.color,
      summary: {
        displayKind: this.kind,
        frameId: message.frameId,
        primitive: "points" as const,
        inputVertices: occupiedIndices.length,
        renderedVertices: occupiedIndices.length,
        droppedVertices: 0,
        bounds: boundsFor(positions),
        details: { width: message.width, height: message.height, resolution: message.resolution, unknownCells: unknown },
      },
    };
  }
}

export interface NumericPlotMessage {
  readonly frameId?: string;
  readonly timestampNanos: bigint;
  readonly value: unknown;
}

export interface NumericPlotDisplayConfig {
  readonly fieldPath: string;
  readonly arrayIndex?: number;
  readonly maxSamples: number;
  readonly maxInputBytes: number;
}

export interface NumericPlotSample {
  readonly timestampNanos: bigint;
  readonly value?: number;
  readonly gap: boolean;
}

function parseFieldPath(path: string): readonly string[] {
  const segments = path.split(".");
  if (segments.length === 0 || segments.some((segment) => !segment || segment.length > 128)) {
    throw new Error("numeric field path is invalid");
  }
  if (segments.length > 32) throw new Error("numeric field path exceeds depth limit");
  return segments;
}

export function extractNumericValue(value: unknown, fieldPath: string, arrayIndex?: number): number | undefined {
  let current = value;
  for (const segment of parseFieldPath(fieldPath)) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  if (arrayIndex !== undefined) {
    if (!Number.isSafeInteger(arrayIndex) || arrayIndex < 0) throw new Error("numeric arrayIndex must be a non-negative safe integer");
    if (!Array.isArray(current) && !ArrayBuffer.isView(current)) return undefined;
    current = (current as ArrayLike<unknown>)[arrayIndex];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

export class NumericPlotDisplay extends SummaryDisplay<NumericPlotMessage, NumericPlotDisplayConfig> {
  readonly kind = "numeric-plot" as const;
  readonly #samples: NumericPlotSample[] = [];

  samples(): readonly NumericPlotSample[] {
    return this.#samples.map((sample) => ({ ...sample }));
  }

  protected onAttach(): void {
    this.#samples.splice(0);
  }

  protected onDispose(): void {
    this.#samples.splice(0);
  }

  protected validateConfig(config: NumericPlotDisplayConfig): void {
    parseFieldPath(config.fieldPath);
    if (config.arrayIndex !== undefined && (!Number.isSafeInteger(config.arrayIndex) || config.arrayIndex < 0)) {
      throw new Error("numeric arrayIndex must be a non-negative safe integer");
    }
    assertLimit(config.maxSamples, "maxSamples");
    assertLimit(config.maxInputBytes, "maxInputBytes");
  }

  protected summarize(message: NumericPlotMessage, config: NumericPlotDisplayConfig): SemanticSceneSummary {
    const estimatedBytes = estimateStructuredBytes(message.value, config.maxInputBytes);
    if (estimatedBytes > config.maxInputBytes) throw new Error("numeric plot input byte budget exceeded");
    const value = extractNumericValue(message.value, config.fieldPath, config.arrayIndex);
    this.#samples.push({ timestampNanos: message.timestampNanos, ...(value === undefined ? {} : { value }), gap: value === undefined });
    if (this.#samples.length > config.maxSamples) this.#samples.splice(0, this.#samples.length - config.maxSamples);
    return {
      displayKind: this.kind,
      frameId: message.frameId ?? "",
      primitive: "plot",
      inputVertices: 1,
      renderedVertices: value === undefined ? 0 : 1,
      droppedVertices: value === undefined ? 1 : 0,
      ...(value === undefined ? { diagnostics: [`numeric field is missing, non-finite, or not scalar: ${config.fieldPath}`] } : {}),
      details: { fieldPath: config.fieldPath, retainedSamples: this.#samples.length, gap: value === undefined },
    };
  }
}

export type RawSchemaCapability = "schema-present" | "schema-resolvable" | "opaque";

export interface RawInspectorMessage {
  readonly frameId?: string;
  readonly typeName: string;
  readonly schemaCapability: RawSchemaCapability;
  readonly value?: unknown;
  readonly bytes?: Uint8Array;
}

export interface RawInspectorLimits {
  readonly maxInputBytes: number;
  readonly maxDepth: number;
  readonly maxFields: number;
  readonly maxArrayLength: number;
  readonly maxStringBytes: number;
  readonly maxPreviewBytes: number;
}

export interface RawInspection {
  readonly capability: RawSchemaCapability;
  readonly typeName: string;
  readonly tree?: unknown;
  readonly bytePreview?: readonly number[];
  readonly fieldsVisited: number;
  readonly truncated: boolean;
  readonly diagnostics: readonly string[];
}

function estimateStructuredBytes(value: unknown, stopAfter: number): number {
  const seen = new WeakSet<object>();
  let bytes = 0;
  const visit = (current: unknown, depth: number): void => {
    if (depth > 128) throw new Error("structured message nesting is excessive");
    if (bytes > stopAfter) return;
    if (current === null || current === undefined) {
      bytes += 4;
    } else if (typeof current === "string") {
      bytes += new TextEncoder().encode(current).byteLength;
    } else if (typeof current === "number" || typeof current === "bigint") {
      bytes += 8;
    } else if (typeof current === "boolean") {
      bytes += 1;
    } else if (typeof current === "object") {
      if (seen.has(current)) throw new Error("structured message contains a cycle");
      seen.add(current);
      if (ArrayBuffer.isView(current)) {
        bytes += current.byteLength;
      } else if (Array.isArray(current)) {
        for (const item of current) visit(item, depth + 1);
      } else {
        for (const [key, item] of Object.entries(current)) {
          bytes += key.length;
          visit(item, depth + 1);
        }
      }
      seen.delete(current);
    } else {
      bytes += 8;
    }
  };
  visit(value, 0);
  return bytes;
}

export function inspectRawMessage(message: RawInspectorMessage, limits: RawInspectorLimits): RawInspection {
  assertLimit(limits.maxInputBytes, "maxInputBytes");
  assertLimit(limits.maxDepth, "maxDepth");
  assertLimit(limits.maxFields, "maxFields");
  assertLimit(limits.maxArrayLength, "maxArrayLength");
  assertLimit(limits.maxStringBytes, "maxStringBytes");
  assertLimit(limits.maxPreviewBytes, "maxPreviewBytes");
  if (!message.typeName) throw new Error("raw inspector typeName is required");
  const diagnostics: string[] = [];
  if (message.schemaCapability === "opaque") {
    if (message.bytes === undefined) throw new Error("opaque raw inspection requires bytes");
    if (message.bytes.byteLength > limits.maxInputBytes) throw new Error("raw inspector input byte budget exceeded");
    const previewLength = Math.min(message.bytes.byteLength, limits.maxPreviewBytes);
    diagnostics.push("schema unavailable; import a bounded schema pack to decode typed fields");
    if (previewLength < message.bytes.byteLength) diagnostics.push("opaque byte preview truncated");
    return {
      capability: message.schemaCapability,
      typeName: message.typeName,
      bytePreview: [...message.bytes.subarray(0, previewLength)],
      fieldsVisited: 0,
      truncated: previewLength < message.bytes.byteLength,
      diagnostics,
    };
  }
  if (message.value === undefined) throw new Error("schema-backed raw inspection requires a decoded value");
  if (estimateStructuredBytes(message.value, limits.maxInputBytes) > limits.maxInputBytes) {
    throw new Error("raw inspector input byte budget exceeded");
  }
  let fieldsVisited = 0;
  let truncated = false;
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > limits.maxDepth || fieldsVisited >= limits.maxFields) {
      truncated = true;
      return "[truncated]";
    }
    if (typeof value === "string") {
      const encoded = new TextEncoder().encode(value);
      if (encoded.byteLength <= limits.maxStringBytes) return value;
      truncated = true;
      return new TextDecoder().decode(encoded.subarray(0, limits.maxStringBytes));
    }
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) throw new Error("raw inspector value contains a cycle");
    seen.add(value);
    if (ArrayBuffer.isView(value)) {
      const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const length = Math.min(source.length, limits.maxArrayLength);
      if (length < source.length) truncated = true;
      seen.delete(value);
      return [...source.subarray(0, length)];
    }
    if (Array.isArray(value)) {
      const length = Math.min(value.length, limits.maxArrayLength);
      if (length < value.length) truncated = true;
      const result = value.slice(0, length).map((item) => visit(item, depth + 1));
      seen.delete(value);
      return result;
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (fieldsVisited >= limits.maxFields) {
        truncated = true;
        break;
      }
      fieldsVisited += 1;
      output[key] = visit((value as Readonly<Record<string, unknown>>)[key], depth + 1);
    }
    seen.delete(value);
    return output;
  };
  const tree = visit(message.value, 0);
  if (truncated) diagnostics.push("raw inspector output truncated by configured limits");
  return { capability: message.schemaCapability, typeName: message.typeName, tree, fieldsVisited, truncated, diagnostics };
}

export class RawInspectorDisplay extends SummaryDisplay<RawInspectorMessage, RawInspectorLimits> {
  readonly kind = "raw-inspector" as const;
  #inspection?: RawInspection;

  inspection(): RawInspection | undefined {
    return this.#inspection;
  }

  protected onAttach(): void {
    this.#inspection = undefined;
  }

  protected onDispose(): void {
    this.#inspection = undefined;
  }

  protected validateConfig(config: RawInspectorLimits): void {
    assertLimit(config.maxInputBytes, "maxInputBytes");
    assertLimit(config.maxDepth, "maxDepth");
    assertLimit(config.maxFields, "maxFields");
    assertLimit(config.maxArrayLength, "maxArrayLength");
    assertLimit(config.maxStringBytes, "maxStringBytes");
    assertLimit(config.maxPreviewBytes, "maxPreviewBytes");
  }

  protected summarize(message: RawInspectorMessage, config: RawInspectorLimits): SemanticSceneSummary {
    const inspection = inspectRawMessage(message, config);
    this.#inspection = inspection;
    return {
      displayKind: this.kind,
      frameId: message.frameId ?? "",
      primitive: "tree",
      inputVertices: inspection.fieldsVisited + (message.bytes?.byteLength ?? 0),
      renderedVertices: inspection.fieldsVisited + (inspection.bytePreview?.length ?? 0),
      droppedVertices: inspection.truncated ? 1 : 0,
      ...(inspection.diagnostics.length === 0 ? {} : { diagnostics: inspection.diagnostics }),
      details: { capability: inspection.capability, typeName: inspection.typeName, truncated: inspection.truncated },
    };
  }
}

export interface RegisteredDisplay {
  readonly id: string;
  readonly kind: DisplayKind;
  readonly state: DisplayState;
  render(): void;
  suspend(): void;
  dispose(): void;
  telemetry(): DisplayTelemetry;
}

export type AnyManagedDisplay = RegisteredDisplay;

export class DisplayRegistry {
  readonly #factories = new Map<DisplayKind, (id: string, renderer: GeometryRendererPort) => AnyManagedDisplay>();

  register(kind: DisplayKind, factory: (id: string, renderer: GeometryRendererPort) => AnyManagedDisplay): void {
    if (this.#factories.has(kind)) throw new Error(`display kind already registered: ${kind}`);
    this.#factories.set(kind, factory);
  }

  create(kind: DisplayKind, id: string, renderer: GeometryRendererPort): AnyManagedDisplay {
    const factory = this.#factories.get(kind);
    if (factory === undefined) throw new Error(`display kind is not registered: ${kind}`);
    return factory(id, renderer);
  }

  kinds(): readonly DisplayKind[] {
    return [...this.#factories.keys()].sort();
  }
}

export function createDefaultDisplayRegistry(): DisplayRegistry {
  const registry = new DisplayRegistry();
  registry.register("camera-info", (id) => new CameraInfoDisplay(id));
  registry.register("frame-tree", (id, renderer) => new FrameTreeDisplay(id, renderer));
  registry.register("grid", (id, renderer) => new GridDisplay(id, renderer));
  registry.register("image", (id) => new ImageDisplay(id));
  registry.register("laser-scan", (id, renderer) => new LaserScanDisplay(id, renderer));
  registry.register("marker", (id, renderer) => new MarkerDisplay(id, renderer));
  registry.register("numeric-plot", (id) => new NumericPlotDisplay(id));
  registry.register("occupancy-grid", (id, renderer) => new OccupancyGridDisplay(id, renderer));
  registry.register("odometry", (id, renderer) => new OdometryDisplay(id, renderer));
  registry.register("pointcloud2", (id, renderer) => new PointCloud2Display(id, renderer));
  registry.register("path", (id, renderer) => new PathDisplay(id, renderer));
  registry.register("pose", (id, renderer) => new PoseDisplay(id, renderer));
  registry.register("raw-inspector", (id) => new RawInspectorDisplay(id));
  return registry;
}
