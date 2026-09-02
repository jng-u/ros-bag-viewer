import type { SemanticSceneSummary } from "@ros-web-viewer/displays-core";

import type { DisplayKind, TopicSummary } from "./shell.js";

export type ViewerLayerStatus = "error" | "loading" | "ready" | "waiting";
export type PointCloudColorMode = "axis" | "intensity" | "rgb" | "uniform";

export interface ViewerLayer {
  readonly id: string;
  readonly topic: TopicSummary;
  readonly kind: DisplayKind;
  readonly visible: boolean;
  readonly status: ViewerLayerStatus;
  readonly colorIndex: number;
  readonly color?: readonly [number, number, number, number];
  readonly pointSize?: number;
  readonly pointCloudColorMode?: PointCloudColorMode;
  readonly pointCloudColorAxis?: "x" | "y" | "z";
  readonly fieldPath?: string;
  readonly plotGroupId?: string;
  readonly messageTimeNanos?: bigint;
  readonly summary?: SemanticSceneSummary;
  readonly error?: string;
}

export class ViewerLayerRegistry {
  #layers: ViewerLayer[] = [];
  #selectedId?: string;
  #nextId = 1;
  #nextPlotGroupId = 1;

  get layers(): readonly ViewerLayer[] { return this.#layers; }
  get visibleLayers(): readonly ViewerLayer[] { return this.#layers.filter(({ visible }) => visible); }
  get selected(): ViewerLayer | undefined { return this.#layers.find(({ id }) => id === this.#selectedId); }

  createPlotGroupId(): string { return `plot-group-${this.#nextPlotGroupId++}`; }

  add(topic: TopicSummary, kind: DisplayKind, fieldPath?: string, plotGroupId?: string): ViewerLayer {
    const resolvedPlotGroupId = kind === "numeric-plot"
      ? plotGroupId ?? this.#layers.find((layer) => layer.topic.id === topic.id && layer.kind === kind && layer.fieldPath === fieldPath)?.plotGroupId ?? this.createPlotGroupId()
      : undefined;
    const existing = this.#layers.find((layer) => layer.topic.id === topic.id && layer.kind === kind && layer.fieldPath === fieldPath && layer.plotGroupId === resolvedPlotGroupId);
    if (existing) {
      this.#selectedId = existing.id;
      return existing;
    }
    const layer: ViewerLayer = {
      id: `layer-${this.#nextId++}`,
      topic,
      kind,
      visible: true,
      status: "waiting",
      colorIndex: this.#layers.length,
      ...(fieldPath ? { fieldPath } : {}),
      ...(resolvedPlotGroupId ? { plotGroupId: resolvedPlotGroupId } : {}),
    };
    this.#layers = [...this.#layers, layer];
    this.#selectedId = layer.id;
    return layer;
  }

  clear(): void {
    this.#layers = [];
    this.#selectedId = undefined;
    this.#nextId = 1;
    this.#nextPlotGroupId = 1;
  }

  remove(id: string): void {
    if (!this.#layers.some((layer) => layer.id === id)) throw new Error(`unknown viewer layer ${id}`);
    this.#layers = this.#layers.filter((layer) => layer.id !== id);
    if (this.#selectedId === id) this.#selectedId = this.#layers.at(-1)?.id;
  }

  select(id: string): void {
    if (!this.#layers.some((layer) => layer.id === id)) throw new Error(`unknown viewer layer ${id}`);
    this.#selectedId = id;
  }

  toggle(id: string): void {
    this.#replace(id, (layer) => ({ ...layer, visible: !layer.visible }));
  }

  move(id: string, direction: -1 | 1): void {
    const index = this.#layers.findIndex((layer) => layer.id === id);
    if (index < 0) throw new Error(`unknown viewer layer ${id}`);
    const target = index + direction;
    if (target < 0 || target >= this.#layers.length) return;
    const next = [...this.#layers];
    [next[index], next[target]] = [next[target]!, next[index]!];
    this.#layers = next;
  }

  moveTo(id: string, targetIndex: number): void {
    const sourceIndex = this.#layers.findIndex((layer) => layer.id === id);
    if (sourceIndex < 0) throw new Error(`unknown viewer layer ${id}`);
    if (!Number.isSafeInteger(targetIndex)) throw new Error("viewer layer target index is invalid");
    const boundedTarget = Math.max(0, Math.min(this.#layers.length - 1, targetIndex));
    if (sourceIndex === boundedTarget) return;
    const next = [...this.#layers];
    const [moved] = next.splice(sourceIndex, 1);
    if (!moved) throw new Error(`unknown viewer layer ${id}`);
    next.splice(boundedTarget, 0, moved);
    this.#layers = next;
  }

  setColor(id: string, color: readonly [number, number, number, number]): void {
    if (color.some((component) => !Number.isFinite(component) || component < 0 || component > 1)) throw new Error("layer color is invalid");
    this.#replace(id, (layer) => ({ ...layer, color }));
  }

  setPointCloudStyle(id: string, patch: Readonly<{ pointSize?: number; pointCloudColorMode?: PointCloudColorMode; pointCloudColorAxis?: "x" | "y" | "z" }>): void {
    if (patch.pointSize !== undefined && (!Number.isFinite(patch.pointSize) || patch.pointSize < 1 || patch.pointSize > 64)) throw new Error("point size is invalid");
    this.#replace(id, (layer) => ({ ...layer, ...patch }));
  }

  update(id: string, patch: Partial<Pick<ViewerLayer, "error" | "messageTimeNanos" | "status" | "summary">>): void {
    this.#replace(id, (layer) => {
      const next = { ...layer, ...patch };
      if ("error" in patch && patch.error === undefined) delete (next as { error?: string }).error;
      return next;
    });
  }

  #replace(id: string, update: (layer: ViewerLayer) => ViewerLayer): void {
    let found = false;
    this.#layers = this.#layers.map((layer) => {
      if (layer.id !== id) return layer;
      found = true;
      return update(layer);
    });
    if (!found) throw new Error(`unknown viewer layer ${id}`);
  }
}
