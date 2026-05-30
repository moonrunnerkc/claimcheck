import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "eval/*.test.ts"],
    // The corpus repos are fixtures, never collected as ClaimCheck's own tests.
    // The live tier (*.live.test.ts) is networked and non-hermetic: it is
    // excluded here and run only via the separate vitest.live.config.ts, so the
    // default suite stays offline and deterministic.
    exclude: [
      "node_modules/**",
      "dist/**",
      "eval/corpus/**",
      "**/*.live.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
