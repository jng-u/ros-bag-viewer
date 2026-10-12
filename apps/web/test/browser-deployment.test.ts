import { afterEach, describe, expect, it, vi } from "vitest";
import { kittiDemoAvailable, shareServiceAvailable, viewerAssetPath } from "../src/browser-deployment.js";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("browser deployment", () => {
  it.each(["/ros-bag-viewer", "/ros-bag-viewer/"])("normalizes the Pages action base path %s before Vite injects BASE_URL", async (basePath) => {
    vi.stubEnv("VITE_BASE_PATH", basePath);
    vi.resetModules();
    const config = await import("../vite.config.js");
    expect(config.default.base).toBe("/ros-bag-viewer/");
  });

  it("keeps root-hosted demo paths for Docker", () => {
    vi.stubEnv("BASE_URL", "/");
    expect(viewerAssetPath("demo.mcap")).toBe("/demo.mcap");
  });

  it("loads every demo under the GitHub Pages project path", () => {
    vi.stubEnv("BASE_URL", "/ros-bag-viewer/");
    for (const path of ["kitti-demo.mcap", "demo.mcap", "demo-ros1.bag", "demo-ros2/metadata.yaml", "demo-ros2/data_0.db3"]) {
      expect(viewerAssetPath(path)).toBe(`/ros-bag-viewer/${path}`);
    }
  });

  it("offers KITTI only when its optional recording is included in the build", () => {
    vi.stubEnv("VITE_KITTI_DEMO_AVAILABLE", undefined);
    expect(kittiDemoAvailable()).toBe(false);
    vi.stubEnv("VITE_KITTI_DEMO_AVAILABLE", "false");
    expect(kittiDemoAvailable()).toBe(false);
    vi.stubEnv("VITE_KITTI_DEMO_AVAILABLE", "true");
    expect(kittiDemoAvailable()).toBe(true);
  });

  it("disables server-backed sharing only for an explicit static build", () => {
    vi.stubEnv("VITE_STATIC_HOST", undefined);
    expect(shareServiceAvailable()).toBe(true);
    vi.stubEnv("VITE_STATIC_HOST", "false");
    expect(shareServiceAvailable()).toBe(true);
    vi.stubEnv("VITE_STATIC_HOST", "true");
    expect(shareServiceAvailable()).toBe(false);
  });
});
