import { defineConfig } from "vite";

const basePath = process.env.VITE_BASE_PATH || "/";

export default defineConfig({
  base: basePath.endsWith("/") ? basePath : `${basePath}/`,
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
  server: {
    host: "0.0.0.0",
    port: 4173,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
  },
});
