export function viewerAssetPath(relativePath: string): string {
  return `${import.meta.env.BASE_URL}${relativePath}`;
}

export function shareServiceAvailable(): boolean {
  return import.meta.env.VITE_STATIC_HOST !== "true";
}

export function kittiDemoAvailable(): boolean {
  return import.meta.env.VITE_KITTI_DEMO_AVAILABLE === "true";
}
