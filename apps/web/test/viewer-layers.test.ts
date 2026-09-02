import { describe, expect, it } from "vitest";

import { ViewerLayerRegistry } from "../src/viewer-layers.js";

const points = {
  id: "points",
  name: "/points",
  typeName: "sensor_msgs/msg/PointCloud2",
  compatibility: "native-display" as const,
  schemaCapability: "schema-present" as const,
  availableDisplays: ["point-cloud", "raw"] as const,
};

describe("viewer layer registry", () => {
  it("keeps multiple named layers visible and independently selectable", () => {
    const registry = new ViewerLayerRegistry();
    const geometry = registry.add(points, "point-cloud");
    const raw = registry.add(points, "raw");
    expect(registry.layers.map(({ id }) => id)).toEqual([geometry.id, raw.id]);
    expect(registry.visibleLayers).toHaveLength(2);
    registry.toggle(geometry.id);
    expect(registry.visibleLayers.map(({ id }) => id)).toEqual([raw.id]);
    registry.select(raw.id);
    expect(registry.selected?.id).toBe(raw.id);
    registry.remove(raw.id);
    expect(registry.layers.map(({ id }) => id)).toEqual([geometry.id]);
  });

  it("deduplicates the same topic/display pair instead of replacing the scene", () => {
    const registry = new ViewerLayerRegistry();
    const first = registry.add(points, "point-cloud");
    expect(registry.add(points, "point-cloud").id).toBe(first.id);
    expect(registry.layers).toHaveLength(1);
  });

  it("keeps independent custom numeric fields from one topic", () => {
    const registry = new ViewerLayerRegistry();
    const score = registry.add(points, "numeric-plot", "score");
    const residual = registry.add(points, "numeric-plot", "residuals[0]");
    expect(score.id).not.toBe(residual.id);
    expect(registry.add(points, "numeric-plot", "score").id).toBe(score.id);
    expect(registry.layers.map(({ fieldPath }) => fieldPath)).toEqual(["score", "residuals[0]"]);
  });

  it("stores an explicit per-display color without changing scene membership", () => {
    const registry = new ViewerLayerRegistry();
    const layer = registry.add(points, "point-cloud");
    registry.setColor(layer.id, [0.1, 0.2, 0.3, 1]);
    expect(registry.layers).toEqual([expect.objectContaining({ id: layer.id, color: [0.1, 0.2, 0.3, 1] })]);
    expect(() => registry.setColor(layer.id, [2, 0, 0, 1])).toThrow(/color/);
  });

  it("reorders layers without changing selection or visibility", () => {
    const registry = new ViewerLayerRegistry();
    const first = registry.add(points, "point-cloud");
    const second = registry.add(points, "raw");
    registry.move(second.id, -1);
    expect(registry.layers.map(({ id }) => id)).toEqual([second.id, first.id]);
    expect(registry.selected?.id).toBe(second.id);
    registry.move(second.id, -1);
    expect(registry.layers.map(({ id }) => id)).toEqual([second.id, first.id]);
  });

  it("moves a drawable directly to an arbitrary drop index", () => {
    const registry = new ViewerLayerRegistry();
    const first = registry.add(points, "point-cloud");
    const second = registry.add({ ...points, id: "path", name: "/path" }, "path");
    const third = registry.add({ ...points, id: "scan", name: "/scan" }, "laser-scan");

    registry.moveTo(first.id, 2);

    expect(registry.layers.map(({ id }) => id)).toEqual([second.id, third.id, first.id]);
    expect(registry.selected?.id).toBe(third.id);
  });
});
