import type { Bounds3 } from "@ros-web-viewer/displays-core";

type Vec3 = readonly [number, number, number];
export type CameraPreset = "front" | "orbit" | "top";

const FOV_RADIANS = 48 * Math.PI / 180;
const MIN_DISTANCE = 0.01;
const MAX_DISTANCE = 1_000_000;

function add(left: Vec3, right: Vec3): Vec3 { return [left[0] + right[0], left[1] + right[1], left[2] + right[2]]; }
function subtract(left: Vec3, right: Vec3): Vec3 { return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]; }
function scale(value: Vec3, factor: number): Vec3 { return [value[0] * factor, value[1] * factor, value[2] * factor]; }
function dot(left: Vec3, right: Vec3): number { return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]; }
function cross(left: Vec3, right: Vec3): Vec3 {
  return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
}
function normalized(value: Vec3): Vec3 {
  const length = Math.hypot(...value);
  if (!Number.isFinite(length) || length === 0) throw new Error("camera vector must be finite and non-zero");
  return scale(value, 1 / length);
}

function multiply(left: Float32Array, right: Float32Array): Float32Array {
  const output = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let index = 0; index < 4; index += 1) value += left[index * 4 + row]! * right[column * 4 + index]!;
      output[column * 4 + row] = value;
    }
  }
  return output;
}

function perspective(aspect: number, near: number, far: number): Float32Array {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error("camera aspect must be positive");
  const focal = 1 / Math.tan(FOV_RADIANS / 2);
  return new Float32Array([
    focal / aspect, 0, 0, 0,
    0, focal, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
}

function lookAt(eye: Vec3, target: Vec3): Float32Array {
  const forward = normalized(subtract(target, eye));
  const right = normalized(cross(forward, [0, 0, 1]));
  const up = cross(right, forward);
  return new Float32Array([
    right[0], up[0], -forward[0], 0,
    right[1], up[1], -forward[1], 0,
    right[2], up[2], -forward[2], 0,
    -dot(right, eye), -dot(up, eye), dot(forward, eye), 1,
  ]);
}

export class OrbitCamera {
  #target: Vec3 = [0, 0, 0];
  #distance = 12;
  #yaw = -Math.PI / 4;
  #pitch = Math.PI / 5;

  snapshot(): { readonly target: Vec3; readonly distance: number; readonly yaw: number; readonly pitch: number } {
    return { target: [...this.#target] as Vec3, distance: this.#distance, yaw: this.#yaw, pitch: this.#pitch };
  }

  frame(bounds: Bounds3): void {
    this.#target = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    const radius = Math.max(Math.hypot(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ) / 2, 0.1);
    this.#distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, radius / Math.sin(FOV_RADIANS / 2) * 1.2));
  }

  orbit(deltaX: number, deltaY: number): void {
    this.#yaw -= deltaX * 0.006;
    this.#pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this.#pitch - deltaY * 0.006));
  }

  pan(deltaX: number, deltaY: number, viewportHeight: number): void {
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return;
    const eye = this.#eye();
    const forward = normalized(subtract(this.#target, eye));
    const right = normalized(cross(forward, [0, 0, 1]));
    const up = cross(right, forward);
    const unitsPerPixel = 2 * this.#distance * Math.tan(FOV_RADIANS / 2) / viewportHeight;
    this.#target = add(this.#target, add(scale(right, -deltaX * unitsPerPixel), scale(up, deltaY * unitsPerPixel)));
  }

  zoom(deltaY: number): void {
    this.#distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, this.#distance * Math.exp(deltaY * 0.001)));
  }

  preset(preset: CameraPreset): void {
    if (preset === "top") {
      this.#yaw = 0;
      this.#pitch = Math.PI / 2 - 0.001;
    } else if (preset === "front") {
      this.#yaw = -Math.PI / 2;
      this.#pitch = 0;
    } else {
      this.#yaw = -Math.PI / 4;
      this.#pitch = Math.PI / 5;
    }
  }

  viewProjection(aspect: number): Float32Array {
    const near = Math.max(0.001, this.#distance / 10_000);
    const far = Math.max(100, this.#distance * 10_000);
    return multiply(perspective(aspect, near, far), lookAt(this.#eye(), this.#target));
  }

  #eye(): Vec3 {
    const horizontal = Math.cos(this.#pitch) * this.#distance;
    return [
      this.#target[0] + Math.cos(this.#yaw) * horizontal,
      this.#target[1] + Math.sin(this.#yaw) * horizontal,
      this.#target[2] + Math.sin(this.#pitch) * this.#distance,
    ];
  }
}
