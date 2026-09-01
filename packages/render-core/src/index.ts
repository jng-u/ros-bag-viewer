export type PrimitiveTopology = "points" | "line-strip" | "lines";

export interface GeometryInput {
  readonly id: string;
  readonly topology: PrimitiveTopology;
  readonly positions: Float32Array;
  readonly color?: readonly [number, number, number, number];
}

export interface RendererBudget {
  readonly maxGpuBytes: number;
  readonly maxBufferBytes: number;
  readonly maxVerticesPerGeometry: number;
  readonly maxPooledBuffers: number;
}

export interface RendererTelemetry {
  readonly liveBuffers: number;
  readonly liveGpuBytes: number;
  readonly pooledBuffers: number;
  readonly pooledGpuBytes: number;
  readonly peakGpuBytes: number;
  readonly drawCalls: number;
  readonly disposedBuffers: number;
  readonly rejectedAllocations: number;
  readonly decimatedVertices: number;
}

export interface GeometryResource {
  readonly id: string;
  readonly topology: PrimitiveTopology;
  readonly vertexCount: number;
  readonly byteLength: number;
  readonly disposed: boolean;
  draw(): void;
  dispose(): void;
}

export interface CanvasContextSource {
  getContext(contextId: "webgl2", options?: Record<string, unknown>): unknown;
}

interface WebGl2Context {
  readonly ARRAY_BUFFER: number;
  readonly DYNAMIC_DRAW: number;
  readonly FLOAT: number;
  readonly VERTEX_SHADER: number;
  readonly FRAGMENT_SHADER: number;
  readonly COMPILE_STATUS: number;
  readonly LINK_STATUS: number;
  readonly POINTS: number;
  readonly LINE_STRIP: number;
  readonly LINES: number;
  createBuffer(): WebGLBuffer | null;
  deleteBuffer(buffer: WebGLBuffer | null): void;
  bindBuffer(target: number, buffer: WebGLBuffer | null): void;
  bufferData(target: number, size: number, usage: number): void;
  bufferSubData(target: number, offset: number, data: ArrayBufferView): void;
  createShader(type: number): WebGLShader | null;
  shaderSource(shader: WebGLShader, source: string): void;
  compileShader(shader: WebGLShader): void;
  getShaderParameter(shader: WebGLShader, pname: number): unknown;
  getShaderInfoLog(shader: WebGLShader): string | null;
  deleteShader(shader: WebGLShader | null): void;
  createProgram(): WebGLProgram | null;
  attachShader(program: WebGLProgram, shader: WebGLShader): void;
  linkProgram(program: WebGLProgram): void;
  getProgramParameter(program: WebGLProgram, pname: number): unknown;
  getProgramInfoLog(program: WebGLProgram): string | null;
  deleteProgram(program: WebGLProgram | null): void;
  getAttribLocation(program: WebGLProgram, name: string): number;
  getUniformLocation(program: WebGLProgram, name: string): WebGLUniformLocation | null;
  useProgram(program: WebGLProgram | null): void;
  enableVertexAttribArray(index: number): void;
  vertexAttribPointer(
    index: number,
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number,
  ): void;
  uniformMatrix4fv(location: WebGLUniformLocation | null, transpose: boolean, value: Float32List): void;
  uniform4fv(location: WebGLUniformLocation | null, value: Float32List): void;
  drawArrays(mode: number, first: number, count: number): void;
}

interface PooledBuffer {
  readonly buffer: WebGLBuffer;
  readonly byteLength: number;
}

const VERTEX_SHADER_SOURCE = `#version 300 es
in vec3 aPosition;
uniform mat4 uViewProjection;
void main() {
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
  gl_PointSize = 4.0;
}`;

const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 outColor;
void main() {
  outColor = uColor;
}`;

const IDENTITY_MATRIX = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function validateBudget(budget: RendererBudget): void {
  assertPositiveSafeInteger(budget.maxGpuBytes, "maxGpuBytes");
  assertPositiveSafeInteger(budget.maxBufferBytes, "maxBufferBytes");
  assertPositiveSafeInteger(budget.maxVerticesPerGeometry, "maxVerticesPerGeometry");
  if (!Number.isSafeInteger(budget.maxPooledBuffers) || budget.maxPooledBuffers < 0) {
    throw new Error("maxPooledBuffers must be a non-negative safe integer");
  }
  if (budget.maxBufferBytes > budget.maxGpuBytes) {
    throw new Error("maxBufferBytes cannot exceed maxGpuBytes");
  }
}

function compileShader(gl: WebGl2Context, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("WebGL2 could not create a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const diagnostic = gl.getShaderInfoLog(shader) ?? "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(`WebGL2 shader compilation failed: ${diagnostic}`);
  }
  return shader;
}

function createProgram(gl: WebGl2Context): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
  const program = gl.createProgram();
  if (program === null) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("WebGL2 could not create a program");
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const diagnostic = gl.getProgramInfoLog(program) ?? "unknown link error";
    gl.deleteProgram(program);
    throw new Error(`WebGL2 program link failed: ${diagnostic}`);
  }
  return program;
}

function primitiveMode(gl: WebGl2Context, topology: PrimitiveTopology): number {
  switch (topology) {
    case "points":
      return gl.POINTS;
    case "line-strip":
      return gl.LINE_STRIP;
    case "lines":
      return gl.LINES;
  }
}

function boundedPositions(
  positions: Float32Array,
  maxVertices: number,
): { positions: Float32Array; inputVertices: number } {
  if (positions.length % 3 !== 0) throw new Error("positions must contain xyz triples");
  const inputVertices = positions.length / 3;
  if (inputVertices <= maxVertices) return { positions, inputVertices };

  const stride = Math.ceil(inputVertices / maxVertices);
  const retained = Math.ceil(inputVertices / stride);
  const output = new Float32Array(retained * 3);
  let outputIndex = 0;
  for (let inputIndex = 0; inputIndex < inputVertices && outputIndex < retained; inputIndex += stride) {
    const source = inputIndex * 3;
    const target = outputIndex * 3;
    output[target] = positions[source] ?? 0;
    output[target + 1] = positions[source + 1] ?? 0;
    output[target + 2] = positions[source + 2] ?? 0;
    outputIndex += 1;
  }
  return { positions: output, inputVertices };
}

class ManagedGeometry implements GeometryResource {
  #disposed = false;

  constructor(
    readonly id: string,
    readonly topology: PrimitiveTopology,
    readonly vertexCount: number,
    readonly byteLength: number,
    readonly buffer: WebGLBuffer,
    readonly color: Float32Array,
    private readonly owner: WebGl2Renderer,
  ) {}

  get disposed(): boolean {
    return this.#disposed;
  }

  draw(): void {
    if (this.#disposed) throw new Error("cannot draw a disposed geometry");
    this.owner.drawResource(this);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.owner.releaseResource(this);
  }
}

export class WebGl2Renderer {
  readonly #gl: WebGl2Context;
  readonly #budget: RendererBudget;
  readonly #program: WebGLProgram;
  readonly #positionLocation: number;
  readonly #viewProjectionLocation: WebGLUniformLocation | null;
  readonly #colorLocation: WebGLUniformLocation | null;
  readonly #resources = new Map<string, ManagedGeometry>();
  readonly #pool: PooledBuffer[] = [];
  #viewProjection = IDENTITY_MATRIX;
  #disposed = false;
  #liveGpuBytes = 0;
  #pooledGpuBytes = 0;
  #peakGpuBytes = 0;
  #drawCalls = 0;
  #disposedBuffers = 0;
  #rejectedAllocations = 0;
  #decimatedVertices = 0;

  constructor(canvas: CanvasContextSource, budget: RendererBudget) {
    validateBudget(budget);
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: true }) as WebGl2Context | null;
    if (gl === null) throw new Error("WebGL2 is required");
    this.#gl = gl;
    this.#budget = budget;
    this.#program = createProgram(gl);
    this.#positionLocation = gl.getAttribLocation(this.#program, "aPosition");
    if (this.#positionLocation < 0) throw new Error("WebGL2 position attribute is unavailable");
    this.#viewProjectionLocation = gl.getUniformLocation(this.#program, "uViewProjection");
    this.#colorLocation = gl.getUniformLocation(this.#program, "uColor");
  }

  setViewProjection(matrix: Float32Array): void {
    this.#assertActive();
    if (matrix.length !== 16 || matrix.some((value) => !Number.isFinite(value))) {
      throw new Error("view projection must be a finite 4x4 matrix");
    }
    this.#viewProjection = matrix.slice();
  }

  upsert(input: GeometryInput): GeometryResource {
    this.#assertActive();
    if (!input.id) throw new Error("geometry id is required");
    if (input.positions.some((value) => !Number.isFinite(value))) {
      throw new Error("geometry positions must be finite");
    }

    const maxVerticesByBuffer = Math.floor(this.#budget.maxBufferBytes / Float32Array.BYTES_PER_ELEMENT / 3);
    const maxVertices = Math.min(this.#budget.maxVerticesPerGeometry, maxVerticesByBuffer);
    if (maxVertices < 1) throw new Error("renderer budget cannot hold one xyz vertex");
    const bounded = boundedPositions(input.positions, maxVertices);
    const byteLength = bounded.positions.byteLength;
    if (byteLength === 0) throw new Error("geometry requires at least one vertex");

    const previous = this.#resources.get(input.id);
    previous?.dispose();

    const buffer = this.#acquireBuffer(byteLength);
    const gl = this.#gl;
    try {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, bounded.positions);
    } catch (error) {
      this.#deleteLiveBuffer(buffer, byteLength);
      throw error;
    }

    const color = new Float32Array(input.color ?? [0.35, 0.85, 1, 1]);
    const resource = new ManagedGeometry(
      input.id,
      input.topology,
      bounded.positions.length / 3,
      byteLength,
      buffer,
      color,
      this,
    );
    this.#resources.set(input.id, resource);
    this.#decimatedVertices += bounded.inputVertices - resource.vertexCount;
    return resource;
  }

  draw(id: string): void {
    const resource = this.#resources.get(id);
    if (resource === undefined) throw new Error(`unknown geometry: ${id}`);
    resource.draw();
  }

  remove(id: string): void {
    this.#resources.get(id)?.dispose();
  }

  drawResource(resource: ManagedGeometry): void {
    this.#assertActive();
    if (this.#resources.get(resource.id) !== resource) throw new Error("geometry is not active");
    const gl = this.#gl;
    gl.useProgram(this.#program);
    gl.bindBuffer(gl.ARRAY_BUFFER, resource.buffer);
    gl.enableVertexAttribArray(this.#positionLocation);
    gl.vertexAttribPointer(this.#positionLocation, 3, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(this.#viewProjectionLocation, false, this.#viewProjection);
    gl.uniform4fv(this.#colorLocation, resource.color);
    gl.drawArrays(primitiveMode(gl, resource.topology), 0, resource.vertexCount);
    this.#drawCalls += 1;
  }

  releaseResource(resource: ManagedGeometry): void {
    if (this.#resources.get(resource.id) === resource) this.#resources.delete(resource.id);
    if (this.#disposed) {
      this.#deleteLiveBuffer(resource.buffer, resource.byteLength);
      return;
    }
    this.#liveGpuBytes -= resource.byteLength;
    if (
      this.#pool.length < this.#budget.maxPooledBuffers &&
      this.#pooledGpuBytes + resource.byteLength <= this.#budget.maxGpuBytes
    ) {
      this.#pool.push({ buffer: resource.buffer, byteLength: resource.byteLength });
      this.#pooledGpuBytes += resource.byteLength;
    } else {
      this.#gl.deleteBuffer(resource.buffer);
      this.#disposedBuffers += 1;
    }
  }

  telemetry(): RendererTelemetry {
    return {
      liveBuffers: this.#resources.size,
      liveGpuBytes: this.#liveGpuBytes,
      pooledBuffers: this.#pool.length,
      pooledGpuBytes: this.#pooledGpuBytes,
      peakGpuBytes: this.#peakGpuBytes,
      drawCalls: this.#drawCalls,
      disposedBuffers: this.#disposedBuffers,
      rejectedAllocations: this.#rejectedAllocations,
      decimatedVertices: this.#decimatedVertices,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const resource of [...this.#resources.values()]) resource.dispose();
    for (const entry of this.#pool.splice(0)) {
      this.#gl.deleteBuffer(entry.buffer);
      this.#disposedBuffers += 1;
    }
    this.#pooledGpuBytes = 0;
    this.#gl.deleteProgram(this.#program);
  }

  #acquireBuffer(byteLength: number): WebGLBuffer {
    const pooledIndex = this.#pool.findIndex((entry) => entry.byteLength === byteLength);
    if (pooledIndex >= 0) {
      const [entry] = this.#pool.splice(pooledIndex, 1);
      if (entry === undefined) throw new Error("buffer pool accounting failed");
      this.#pooledGpuBytes -= entry.byteLength;
      this.#liveGpuBytes += entry.byteLength;
      return entry.buffer;
    }

    while (this.#liveGpuBytes + this.#pooledGpuBytes + byteLength > this.#budget.maxGpuBytes) {
      const evicted = this.#pool.pop();
      if (evicted === undefined) {
        this.#rejectedAllocations += 1;
        throw new Error("GPU byte budget exceeded");
      }
      this.#pooledGpuBytes -= evicted.byteLength;
      this.#gl.deleteBuffer(evicted.buffer);
      this.#disposedBuffers += 1;
    }

    const buffer = this.#gl.createBuffer();
    if (buffer === null) {
      this.#rejectedAllocations += 1;
      throw new Error("WebGL2 could not create a buffer");
    }
    this.#gl.bindBuffer(this.#gl.ARRAY_BUFFER, buffer);
    try {
      this.#gl.bufferData(this.#gl.ARRAY_BUFFER, byteLength, this.#gl.DYNAMIC_DRAW);
    } catch (error) {
      this.#gl.deleteBuffer(buffer);
      this.#disposedBuffers += 1;
      throw error;
    }
    this.#liveGpuBytes += byteLength;
    this.#peakGpuBytes = Math.max(this.#peakGpuBytes, this.#liveGpuBytes + this.#pooledGpuBytes);
    return buffer;
  }

  #deleteLiveBuffer(buffer: WebGLBuffer, byteLength: number): void {
    this.#gl.deleteBuffer(buffer);
    this.#liveGpuBytes -= byteLength;
    this.#disposedBuffers += 1;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("renderer is disposed");
  }
}

export function createGridGeometry(id: string, halfExtent: number, divisions: number): GeometryInput {
  if (!Number.isFinite(halfExtent) || halfExtent <= 0) throw new Error("halfExtent must be positive");
  if (!Number.isInteger(divisions) || divisions < 1 || divisions > 1024) {
    throw new Error("grid divisions must be between 1 and 1024");
  }
  const lineCount = (divisions + 1) * 2;
  const positions = new Float32Array(lineCount * 2 * 3);
  let offset = 0;
  for (let index = 0; index <= divisions; index += 1) {
    const coordinate = -halfExtent + (index / divisions) * halfExtent * 2;
    positions.set([coordinate, 0, -halfExtent, coordinate, 0, halfExtent], offset);
    offset += 6;
    positions.set([-halfExtent, 0, coordinate, halfExtent, 0, coordinate], offset);
    offset += 6;
  }
  return { id, topology: "lines", positions, color: [0.25, 0.28, 0.32, 1] };
}
