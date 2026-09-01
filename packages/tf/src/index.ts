export interface Vector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Quaternion {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface RigidTransform {
  readonly translation: Vector3;
  readonly rotation: Quaternion;
}

export interface TfSample extends RigidTransform {
  readonly parentFrame: string;
  readonly childFrame: string;
  readonly timeNanos: bigint;
  readonly isStatic: boolean;
  readonly epoch: number;
}

export type TfLookupResult =
  | { readonly ok: true; readonly transform: RigidTransform; readonly interpolated: boolean }
  | { readonly ok: false; readonly reason: "missing" | "cycle" | "extrapolation" | "stale-epoch"; readonly diagnostic: string };

export interface TfSnapshot {
  readonly samples: readonly TfSample[];
  readonly diagnostics: readonly string[];
}

const IDENTITY: RigidTransform = {
  translation: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
};

function normalize(q: Quaternion): Quaternion {
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(length) || length === 0) throw new Error("TF quaternion must be finite and non-zero");
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

function conjugate(q: Quaternion): Quaternion {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function multiplyQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function rotate(q: Quaternion, value: Vector3): Vector3 {
  const normalized = normalize(q);
  const vector = { x: value.x, y: value.y, z: value.z, w: 0 };
  const result = multiplyQuaternion(multiplyQuaternion(normalized, vector), conjugate(normalized));
  return { x: result.x, y: result.y, z: result.z };
}

function compose(parentFromMiddle: RigidTransform, middleFromChild: RigidTransform): RigidTransform {
  const rotated = rotate(parentFromMiddle.rotation, middleFromChild.translation);
  return {
    translation: {
      x: parentFromMiddle.translation.x + rotated.x,
      y: parentFromMiddle.translation.y + rotated.y,
      z: parentFromMiddle.translation.z + rotated.z,
    },
    rotation: normalize(multiplyQuaternion(parentFromMiddle.rotation, middleFromChild.rotation)),
  };
}

function inverse(transform: RigidTransform): RigidTransform {
  const rotation = conjugate(normalize(transform.rotation));
  const translation = rotate(rotation, {
    x: -transform.translation.x,
    y: -transform.translation.y,
    z: -transform.translation.z,
  });
  return { translation, rotation };
}

function interpolate(before: TfSample, after: TfSample, timeNanos: bigint): RigidTransform {
  const span = after.timeNanos - before.timeNanos;
  const alpha = span === 0n ? 0 : Number(timeNanos - before.timeNanos) / Number(span);
  const first = normalize(before.rotation);
  let second = normalize(after.rotation);
  const dot = first.x * second.x + first.y * second.y + first.z * second.z + first.w * second.w;
  if (dot < 0) second = { x: -second.x, y: -second.y, z: -second.z, w: -second.w };
  return {
    translation: {
      x: before.translation.x + (after.translation.x - before.translation.x) * alpha,
      y: before.translation.y + (after.translation.y - before.translation.y) * alpha,
      z: before.translation.z + (after.translation.z - before.translation.z) * alpha,
    },
    rotation: normalize({
      x: first.x + (second.x - first.x) * alpha,
      y: first.y + (second.y - first.y) * alpha,
      z: first.z + (second.z - first.z) * alpha,
      w: first.w + (second.w - first.w) * alpha,
    }),
  };
}

export class TfBuffer {
  readonly #maxSamples: number;
  readonly #maxInterpolationSpanNanos: bigint;
  readonly #maxHistoryNanos: bigint;
  readonly #samplesByChild = new Map<string, TfSample[]>();
  #epoch: number;
  #totalSamples = 0;

  constructor(epoch: number, maxSamples: number, maxInterpolationSpanNanos = 30_000_000_000n, maxHistoryNanos = 120_000_000_000n) {
    if (maxSamples < 1) throw new Error("TF sample limit must be positive");
    if (maxInterpolationSpanNanos <= 0n) throw new Error("TF interpolation span must be positive");
    if (maxHistoryNanos <= 0n) throw new Error("TF history span must be positive");
    this.#epoch = epoch;
    this.#maxSamples = maxSamples;
    this.#maxInterpolationSpanNanos = maxInterpolationSpanNanos;
    this.#maxHistoryNanos = maxHistoryNanos;
  }

  add(sample: TfSample): void {
    if (sample.epoch !== this.#epoch) throw new Error("cannot add a stale-epoch TF sample");
    if (!sample.parentFrame || !sample.childFrame || sample.parentFrame === sample.childFrame) {
      throw new Error("TF frames must be distinct and non-empty");
    }
    normalize(sample.rotation);
    const samples = this.#samplesByChild.get(sample.childFrame) ?? [];
    if (sample.isStatic) {
      for (let index = samples.length - 1; index >= 0; index -= 1) {
        if (samples[index]!.isStatic) {
          samples.splice(index, 1);
          this.#totalSamples -= 1;
        }
      }
    }
    samples.push(sample);
    this.#totalSamples += 1;
    samples.sort((left, right) => (left.timeNanos === right.timeNanos ? 0 : left.timeNanos < right.timeNanos ? -1 : 1));
    const newestDynamicTime = [...samples].reverse().find((candidate) => !candidate.isStatic)?.timeNanos;
    if (newestDynamicTime !== undefined) {
      const cutoff = newestDynamicTime > this.#maxHistoryNanos ? newestDynamicTime - this.#maxHistoryNanos : 0n;
      for (let index = samples.length - 1; index >= 0; index -= 1) {
        const candidate = samples[index]!;
        if (!candidate.isStatic && candidate.timeNanos < cutoff) { samples.splice(index, 1); this.#totalSamples -= 1; }
      }
    }
    this.#samplesByChild.set(sample.childFrame, samples);
    while (this.#totalSamples > this.#maxSamples) this.#evictOldest();
  }

  advanceEpoch(epoch: number): void {
    if (epoch <= this.#epoch) throw new Error("TF epoch must advance monotonically");
    this.#epoch = epoch;
    this.#samplesByChild.clear();
    this.#totalSamples = 0;
  }

  #evictOldest(): void {
    let selectedChild: string | undefined;
    let selectedIndex = -1;
    let selectedTime: bigint | undefined;
    for (const [child, samples] of this.#samplesByChild) {
      const dynamicIndex = samples.findIndex((sample) => !sample.isStatic);
      const index = dynamicIndex >= 0 ? dynamicIndex : 0;
      const candidate = samples[index];
      if (candidate && (selectedTime === undefined || candidate.timeNanos < selectedTime)) {
        selectedChild = child; selectedIndex = index; selectedTime = candidate.timeNanos;
      }
    }
    if (selectedChild === undefined) return;
    const samples = this.#samplesByChild.get(selectedChild)!;
    samples.splice(selectedIndex, 1);
    this.#totalSamples -= 1;
    if (samples.length === 0) this.#samplesByChild.delete(selectedChild);
  }

  lookup(targetFrame: string, sourceFrame: string, timeNanos: bigint, epoch: number): TfLookupResult {
    if (epoch !== this.#epoch) return { ok: false, reason: "stale-epoch", diagnostic: "TF query belongs to a stale source epoch" };
    if (targetFrame === sourceFrame) return { ok: true, transform: IDENTITY, interpolated: false };
    const sourceChain = this.#chainToRoot(sourceFrame, timeNanos);
    if (!sourceChain.ok) return sourceChain;
    const targetChain = this.#chainToRoot(targetFrame, timeNanos);
    if (!targetChain.ok) return targetChain;
    const common = sourceChain.frames.find((frame) => targetChain.transforms.has(frame));
    if (!common) return { ok: false, reason: "missing", diagnostic: `no TF path between ${sourceFrame} and ${targetFrame}` };
    const commonFromSource = sourceChain.transforms.get(common) ?? IDENTITY;
    const commonFromTarget = targetChain.transforms.get(common) ?? IDENTITY;
    return {
      ok: true,
      transform: compose(inverse(commonFromTarget), commonFromSource),
      interpolated: sourceChain.interpolated || targetChain.interpolated,
    };
  }

  /** Selects one bounded, query-time transform per child for frame-tree rendering. */
  snapshot(timeNanos: bigint, epoch: number): TfSnapshot {
    if (epoch !== this.#epoch) return { samples: [], diagnostics: ["TF snapshot belongs to a stale source epoch"] };
    const samples: TfSample[] = [];
    const diagnostics: string[] = [];
    for (const childFrame of [...this.#samplesByChild.keys()].sort()) {
      const selected = this.#select(childFrame, timeNanos);
      if (!selected.ok) {
        diagnostics.push(selected.diagnostic);
        continue;
      }
      samples.push({
        ...selected.transform,
        parentFrame: selected.sample.parentFrame,
        childFrame,
        timeNanos,
        isStatic: selected.sample.isStatic,
        epoch,
      });
    }
    return { samples, diagnostics };
  }

  /** Latest-per-child snapshot for a live tree view, where future brackets do not exist yet. */
  latestSnapshot(epoch: number): TfSnapshot {
    if (epoch !== this.#epoch) return { samples: [], diagnostics: ["TF snapshot belongs to a stale source epoch"] };
    const samples: TfSample[] = [];
    for (const childFrame of [...this.#samplesByChild.keys()].sort()) {
      const history = this.#samplesByChild.get(childFrame) ?? [];
      const selected = history.find((sample) => sample.isStatic) ?? history.at(-1);
      if (selected) samples.push(selected);
    }
    return { samples, diagnostics: [] };
  }

  #chainToRoot(frame: string, timeNanos: bigint):
    | { readonly ok: true; readonly frames: string[]; readonly transforms: Map<string, RigidTransform>; readonly interpolated: boolean }
    | Extract<TfLookupResult, { ok: false }> {
    const transforms = new Map<string, RigidTransform>([[frame, IDENTITY]]);
    const frames = [frame];
    const visited = new Set([frame]);
    let current = frame;
    let rootFromFrame = IDENTITY;
    let wasInterpolated = false;
    while (this.#samplesByChild.has(current)) {
      const selected = this.#select(current, timeNanos);
      if (!selected.ok) return selected;
      const { sample, transform, interpolated } = selected;
      if (visited.has(sample.parentFrame)) {
        return { ok: false, reason: "cycle", diagnostic: `TF cycle detected at ${sample.parentFrame}` };
      }
      rootFromFrame = compose(transform, rootFromFrame);
      current = sample.parentFrame;
      visited.add(current);
      frames.push(current);
      transforms.set(current, rootFromFrame);
      wasInterpolated ||= interpolated;
    }
    return { ok: true, frames, transforms, interpolated: wasInterpolated };
  }

  #select(childFrame: string, timeNanos: bigint):
    | { readonly ok: true; readonly sample: TfSample; readonly transform: RigidTransform; readonly interpolated: boolean }
    | Extract<TfLookupResult, { ok: false }> {
    const samples = this.#samplesByChild.get(childFrame) ?? [];
    const staticSample = samples.find((sample) => sample.isStatic);
    if (staticSample) return { ok: true, sample: staticSample, transform: staticSample, interpolated: false };
    let before: TfSample | undefined;
    let after: TfSample | undefined;
    for (const sample of samples) {
      if (sample.timeNanos <= timeNanos) before = sample;
      if (sample.timeNanos >= timeNanos) {
        after = sample;
        break;
      }
    }
    if (!before || !after) {
      const first = samples.find((sample) => !sample.isStatic)?.timeNanos;
      const last = [...samples].reverse().find((sample) => !sample.isStatic)?.timeNanos;
      const available = first === undefined || last === undefined ? "none" : `${first}-${last}`;
      return {
        ok: false,
        reason: "extrapolation",
        diagnostic: `historical TF lookup for ${childFrame} at ${timeNanos} requires bracketing samples (available ${available}); latest fallback is forbidden`,
      };
    }
    if (before.parentFrame !== after.parentFrame) {
      return { ok: false, reason: "missing", diagnostic: `TF parent changed across interpolation for ${childFrame}` };
    }
    if (after.timeNanos - before.timeNanos > this.#maxInterpolationSpanNanos) {
      return {
        ok: false,
        reason: "extrapolation",
        diagnostic: `historical TF lookup for ${childFrame} exceeds the interpolation horizon`,
      };
    }
    return {
      ok: true,
      sample: before,
      transform: before.timeNanos === after.timeNanos ? before : interpolate(before, after, timeNanos),
      interpolated: before.timeNanos !== after.timeNanos,
    };
  }
}
