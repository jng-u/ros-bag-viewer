import { describe, expect, it } from "vitest";

import {
  WebGl2Renderer,
  createGridGeometry,
  type CanvasContextSource,
  type RendererBudget,
} from "../src/index.js";

class MockWebGl2 {
  readonly ARRAY_BUFFER = 0x8892;
  readonly DYNAMIC_DRAW = 0x88e8;
  readonly FLOAT = 0x1406;
  readonly VERTEX_SHADER = 0x8b31;
  readonly FRAGMENT_SHADER = 0x8b30;
  readonly COMPILE_STATUS = 0x8b81;
  readonly LINK_STATUS = 0x8b82;
  readonly POINTS = 0;
  readonly LINES = 1;
  readonly LINE_STRIP = 3;

  createdBuffers = 0;
  deletedBuffers = 0;
  bufferAllocations: number[] = [];
  bufferUploads: number[] = [];
  draws: Array<{ mode: number; count: number }> = [];

  createBuffer(): WebGLBuffer {
    this.createdBuffers += 1;
    return { id: this.createdBuffers } as unknown as WebGLBuffer;
  }

  deleteBuffer(buffer: WebGLBuffer | null): void {
    void buffer;
    this.deletedBuffers += 1;
  }

  bindBuffer(): void {}

  bufferData(_target: number, size: number): void {
    this.bufferAllocations.push(size);
  }

  bufferSubData(_target: number, _offset: number, data: ArrayBufferView): void {
    this.bufferUploads.push(data.byteLength);
  }

  createShader(): WebGLShader {
    return {} as WebGLShader;
  }

  shaderSource(): void {}
  compileShader(): void {}
  getShaderParameter(): boolean {
    return true;
  }
  getShaderInfoLog(): null {
    return null;
  }
  deleteShader(): void {}

  createProgram(): WebGLProgram {
    return {} as WebGLProgram;
  }

  attachShader(): void {}
  linkProgram(): void {}
  getProgramParameter(): boolean {
    return true;
  }
  getProgramInfoLog(): null {
    return null;
  }
  deleteProgram(): void {}
  getAttribLocation(): number {
    return 0;
  }
  getUniformLocation(): WebGLUniformLocation {
    return {} as WebGLUniformLocation;
  }
  useProgram(): void {}
  enableVertexAttribArray(): void {}
  vertexAttribPointer(): void {}
  uniformMatrix4fv(): void {}
  uniform4fv(): void {}

  drawArrays(mode: number, _first: number, count: number): void {
    this.draws.push({ mode, count });
  }
}

const budget: RendererBudget = {
  maxGpuBytes: 1024,
  maxBufferBytes: 256,
  maxVerticesPerGeometry: 8,
  maxPooledBuffers: 2,
};

function renderer(overrides: Partial<RendererBudget> = {}) {
  const gl = new MockWebGl2();
  const canvas: CanvasContextSource = { getContext: () => gl };
  return { gl, renderer: new WebGl2Renderer(canvas, { ...budget, ...overrides }) };
}

describe("WebGl2Renderer", () => {
  it("allocates fixed-capacity buffers, uploads bounded data, and draws semantic primitives", () => {
    const { gl, renderer: value } = renderer();
    const points = value.upsert({
      id: "cloud",
      topology: "points",
      positions: new Float32Array([0, 0, 0, 1, 2, 3]),
    });

    points.draw();

    expect(gl.bufferAllocations).toEqual([24]);
    expect(gl.bufferUploads).toEqual([24]);
    expect(gl.draws).toEqual([{ mode: gl.POINTS, count: 2 }]);
    expect(value.telemetry()).toMatchObject({
      liveBuffers: 1,
      liveGpuBytes: 24,
      peakGpuBytes: 24,
      drawCalls: 1,
    });
  });

  it("deterministically decimates before allocation", () => {
    const { gl, renderer: value } = renderer({ maxVerticesPerGeometry: 2 });
    const geometry = value.upsert({
      id: "bounded-cloud",
      topology: "points",
      positions: new Float32Array([
        0, 0, 0,
        1, 0, 0,
        2, 0, 0,
        3, 0, 0,
        4, 0, 0,
      ]),
    });

    expect(geometry.vertexCount).toBe(2);
    expect(gl.bufferAllocations).toEqual([24]);
    expect(value.telemetry().decimatedVertices).toBe(3);
  });

  it("reuses exact-capacity pooled buffers and deletes every buffer on disposal", () => {
    const { gl, renderer: value } = renderer();
    value.upsert({
      id: "path-a",
      topology: "line-strip",
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    }).dispose();
    value.upsert({
      id: "path-b",
      topology: "line-strip",
      positions: new Float32Array([0, 0, 0, 2, 0, 0]),
    });

    expect(gl.createdBuffers).toBe(1);
    expect(gl.bufferAllocations).toEqual([24]);
    expect(gl.bufferUploads).toEqual([24, 24]);

    value.dispose();

    expect(gl.deletedBuffers).toBe(1);
    expect(value.telemetry()).toMatchObject({
      liveBuffers: 0,
      liveGpuBytes: 0,
      pooledBuffers: 0,
      pooledGpuBytes: 0,
      disposedBuffers: 1,
    });
  });

  it("rejects allocations that cannot fit after pooled eviction", () => {
    const { renderer: value } = renderer({ maxGpuBytes: 24, maxBufferBytes: 24 });
    value.upsert({
      id: "first",
      topology: "points",
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    });

    expect(() =>
      value.upsert({
        id: "second",
        topology: "points",
        positions: new Float32Array([0, 0, 0]),
      }),
    ).toThrow(/GPU byte budget exceeded/);
    expect(value.telemetry()).toMatchObject({ liveGpuBytes: 24, rejectedAllocations: 1 });
  });

  it("creates a bounded grid using line primitives", () => {
    const grid = createGridGeometry("grid", 10, 2);
    expect(grid.topology).toBe("lines");
    expect(grid.positions.length / 3).toBe(12);
    expect(() => createGridGeometry("grid", 10, 1025)).toThrow(/between 1 and 1024/);
  });
});
