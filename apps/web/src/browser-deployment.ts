export function viewerAssetPath(relativePath: string): string {
  return `${import.meta.env.BASE_URL}${relativePath}`;
}

export function shareServiceAvailable(): boolean {
  return import.meta.env.VITE_STATIC_HOST !== "true";
}
