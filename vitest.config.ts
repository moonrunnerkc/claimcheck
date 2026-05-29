import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "eval/*.test.ts"],
    // The corpus repos are fixtures, never collected as ClaimCheck's own tests.
    exclude: ["node_modules/**", "dist/**", "eval/corpus/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
