import type { DecodedFrameTree } from "@ros-web-viewer/m1-integration";
import type { RigidTransform } from "@ros-web-viewer/tf";
import { TfBuffer } from "@ros-web-viewer/tf";

export const IDENTITY_TRANSFORM = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

type Transform = DecodedFrameTree["message"]["transforms"][number];
type Quaternion = readonly [number, number, number, number];
type Vector3 = readonly [number, number, number];
interface ResolvedTransform { readonly translation: Vector3; readonly rotation: Quaternion }

function normalizeFrame(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/gu, "");
  if (!normalized) throw new Error("TF frame name is empty");
  return normalized;
}

function normalizeQuaternion(value: Quaternion): Quaternion {
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("TF quaternion must be finite and non-zero");
  return [value[0] / norm, value[1] / norm, value[2] / norm, value[3] / norm];
}

function multiplyQuaternion(left: Quaternion, right: Quaternion): Quaternion {
  return [
    left[3] * right[0] + left[0] * right[3] + left[1] * right[2] - left[2] * right[1],
    left[3] * right[1] - left[0] * right[2] + left[1] * right[3] + left[2] * right[0],
    left[3] * right[2] + left[0] * right[1] - left[1] * right[0] + left[2] * right[3],
    left[3] * right[3] - left[0] * right[0] - left[1] * right[1] - left[2] * right[2],
  ];
}

function rotate(rotation: Quaternion, value: Vector3): Vector3 {
  const vector: Quaternion = [value[0], value[1], value[2], 0];
  const conjugate: Quaternion = [-rotation[0], -rotation[1], -rotation[2], rotation[3]];
  const result = multiplyQuaternion(multiplyQuaternion(rotation, vector), conjugate);
  return [result[0], result[1], result[2]];
}

function matrixFor({ translation, rotation }: ResolvedTransform): Float32Array {
  const [x, y, z, w] = rotation;
  const xx = x * x; const yy = y * y; const zz = z * z;
  const xy = x * y; const xz = x * z; const yz = y * z;
  const wx = w * x; const wy = w * y; const wz = w * z;
  return new Float32Array([
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    translation[0], translation[1], translation[2], 1,
  ]);
}

export function matrixForRigidTransform(transform: RigidTransform): Float32Array {
  return matrixFor({
    translation: [transform.translation.x, transform.translation.y, transform.translation.z],
    rotation: [transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w],
  });
}

export interface FrameTransformResolver {
  matrixFromFixed(frameId: string, queryTimeNanos?: bigint): Float32Array;
}

export class FrameResolver {
  readonly #fixedFrame: string;
  readonly #edges = new Map<string, Transform>();
  readonly #resolved = new Map<string, ResolvedTransform>();

  constructor(fixedFrame: string, transforms: readonly Transform[]) {
    this.#fixedFrame = normalizeFrame(fixedFrame);
    this.#resolved.set(this.#fixedFrame, { translation: [0, 0, 0], rotation: [0, 0, 0, 1] });
    for (const transform of transforms) {
      const parentFrameId = normalizeFrame(transform.parentFrameId);
      const childFrameId = normalizeFrame(transform.childFrameId);
      if (parentFrameId === childFrameId) throw new Error(`TF cycle at frame ${childFrameId}`);
      if (this.#edges.has(childFrameId)) throw new Error(`TF child frame is ambiguous: ${childFrameId}`);
      this.#edges.set(childFrameId, { ...transform, parentFrameId, childFrameId });
    }
  }

  matrixFromFixed(frameId: string): Float32Array {
    return matrixFor(this.#resolve(normalizeFrame(frameId), new Set()));
  }

  #resolve(frame: string, resolving: Set<string>): ResolvedTransform {
    const existing = this.#resolved.get(frame);
    if (existing) return existing;
    if (resolving.has(frame)) throw new Error(`TF cycle detected at frame ${frame}`);
    const edge = this.#edges.get(frame);
    if (!edge) throw new Error(`TF frame ${frame} is disconnected from fixed frame ${this.#fixedFrame}`);
    resolving.add(frame);
    const parent = this.#resolve(edge.parentFrameId, resolving);
    resolving.delete(frame);
    const localRotation = normalizeQuaternion([edge.rotation.x, edge.rotation.y, edge.rotation.z, edge.rotation.w]);
    const rotated = rotate(parent.rotation, [edge.translation.x, edge.translation.y, edge.translation.z]);
    const value: ResolvedTransform = {
      translation: [parent.translation[0] + rotated[0], parent.translation[1] + rotated[1], parent.translation[2] + rotated[2]],
      rotation: normalizeQuaternion(multiplyQuaternion(parent.rotation, localRotation)),
    };
    this.#resolved.set(frame, value);
    return value;
  }
}

export class HistoricalFrameResolver implements FrameTransformResolver {
  readonly #fixedFrame: string;
  readonly #epoch: number;
  readonly #buffer: TfBuffer;

  constructor(fixedFrame: string, epoch: number, buffer: TfBuffer) {
    this.#fixedFrame = normalizeFrame(fixedFrame);
    this.#epoch = epoch;
    this.#buffer = buffer;
  }

  matrixFromFixed(frameId: string, queryTimeNanos?: bigint): Float32Array {
    if (queryTimeNanos === undefined) throw new Error(`TF query time is required for frame ${frameId}`);
    const normalizedFrame = normalizeFrame(frameId);
    const result = this.#buffer.lookup(this.#fixedFrame, normalizedFrame, queryTimeNanos, this.#epoch);
    if (!result.ok) throw new Error(`${result.reason}: ${result.diagnostic}`);
    return matrixForRigidTransform(result.transform);
  }
}

export function transformBounds(bounds: Readonly<{ min: readonly [number, number, number]; max: readonly [number, number, number] }>, matrix: Float32Array) {
  const points: Vector3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) {
    points.push([
      matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
      matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
      matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
    ]);
  }
  return {
    min: [Math.min(...points.map((point) => point[0])), Math.min(...points.map((point) => point[1])), Math.min(...points.map((point) => point[2]))] as const,
    max: [Math.max(...points.map((point) => point[0])), Math.max(...points.map((point) => point[1])), Math.max(...points.map((point) => point[2]))] as const,
  };
}
