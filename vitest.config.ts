import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/toolchain/**/*.test.ts",
      "tests/m0/**/*.test.ts",
      "tests/m1/**/*.test.ts",
      "tests/m3-live/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
    ],
  },
});
