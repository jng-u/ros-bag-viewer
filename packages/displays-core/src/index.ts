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
  readonly displayKind: "pointcloud2" | "path";
  readonly frameId: string;
  readonly primitive: "points" | "line-strip";
  readonly inputVertices: number;
  readonly renderedVertices: number;
  readonly droppedVertices: number;
  readonly bounds?: Bounds3;
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
  readonly kind: "pointcloud2" | "path";
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
  abstract readonly kind: "pointcloud2" | "path";
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
    this.#assertNotDisposed();
    if (this.config === undefined || this.#epoch === undefined) throw new Error("display has no configured source");
    if (epoch !== this.#epoch) throw new Error("stale source epoch");
    try {
      const converted = this.convert(message, this.config);
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
  ): { positions: Float32Array; color?: readonly [number, number, number, number]; summary: SemanticSceneSummary };

  #assertNotDisposed(): void {
    if (this.#state === "disposed") throw new Error("display is disposed");
  }
}

const FLOAT32_DATATYPE = 7;
const MAX_POINT_FIELDS = 64;

export class PointCloud2Display extends GeometryDisplay<PointCloud2Message, PointCloud2DisplayConfig> {
  readonly kind = "pointcloud2" as const;

  protected validateConfig(config: PointCloud2DisplayConfig): void {
    assertLimit(config.maxPoints, "maxPoints");
    assertLimit(config.maxInputBytes, "maxInputBytes");
    assertColor(config.color);
  }

  protected convert(message: PointCloud2Message, config: PointCloud2DisplayConfig) {
    assertLimit(message.width, "point cloud width");
    assertLimit(message.height, "point cloud height");
    assertLimit(message.pointStep, "pointStep");
    assertLimit(message.rowStep, "rowStep");
    if (message.data.byteLength > config.maxInputBytes) throw new Error("PointCloud2 input byte budget exceeded");
    const pointCount = message.width * message.height;
    if (!Number.isSafeInteger(pointCount)) throw new Error("PointCloud2 dimensions overflow");
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

    const sampleStride = Math.max(1, Math.ceil(pointCount / config.maxPoints));
    const capacity = Math.min(config.maxPoints, Math.ceil(pointCount / sampleStride));
    const positions = new Float32Array(capacity * 3);
    const view = new DataView(message.data.buffer, message.data.byteOffset, message.data.byteLength);
    let outputCount = 0;
    for (let pointIndex = 0; pointIndex < pointCount && outputCount < capacity; pointIndex += sampleStride) {
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
    if (outputCount === 0) throw new Error("PointCloud2 contains no finite sampled points");
    const bounded = positions.subarray(0, outputCount * 3);
    const summary: SemanticSceneSummary = {
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
    const sampleStride = Math.max(1, Math.ceil(inputCount / config.maxPoses));
    const capacity = Math.min(config.maxPoses, Math.ceil(inputCount / sampleStride));
    const positions = new Float32Array(capacity * 3);
    let outputCount = 0;
    for (let index = 0; index < inputCount && outputCount < capacity; index += sampleStride) {
      const position = message.poses[index]?.position;
      if (position === undefined || !finitePosition(position)) continue;
      const target = outputCount * 3;
      positions[target] = position.x;
      positions[target + 1] = position.y;
      positions[target + 2] = position.z;
      outputCount += 1;
    }
    if (outputCount === 0) throw new Error("Path contains no finite sampled poses");
    const bounded = positions.subarray(0, outputCount * 3);
    const summary: SemanticSceneSummary = {
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

export type DisplayKind = "pointcloud2" | "path";
export type AnyManagedDisplay =
  | ManagedDisplay<PointCloud2Message, PointCloud2DisplayConfig>
  | ManagedDisplay<PathMessage, PathDisplayConfig>;

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
  registry.register("pointcloud2", (id, renderer) => new PointCloud2Display(id, renderer));
  registry.register("path", (id, renderer) => new PathDisplay(id, renderer));
  return registry;
}
