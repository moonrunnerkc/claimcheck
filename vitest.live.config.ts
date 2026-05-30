import { defineConfig } from "vitest/config";

/**
 * The live, networked test tier. It is explicitly NOT part of the determinism
 * guarantee: it clones real external repositories and runs their own install
 * and test command, which requires network and a compatible Node version. It
 * is never run by the default hermetic suite (`npm test`); run it with
 * `npm run test:live`, and only where network exists.
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    // Real installs and mutation runs against a real repo are slow.
    testTimeout: 1_200_000,
    hookTimeout: 1_200_000,
    // One repo at a time; the installs are heavy and independent isolation is
    // not worth the extra disk and time.
    fileParallelism: false,
  },
});
