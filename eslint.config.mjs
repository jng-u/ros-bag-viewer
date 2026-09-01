import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  Buffer: "readonly",
  console: "readonly",
  process: "readonly",
  setTimeout: "readonly",
};

export default tseslint.config(
  { ignores: ["**/dist/**", "**/dist-web/**", "artifacts/**", "node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts}"],
    languageOptions: { globals: nodeGlobals },
    rules: { "no-console": "off" },
  },
  {
    files: ["apps/web/src/main.ts"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        ResizeObserver: "readonly",
      },
    },
  },
);
