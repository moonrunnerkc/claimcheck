import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeVitestConfig,
  detectRepoVitestConfig,
} from "./sandbox.js";

/**
 * The config composer is what stopped ClaimCheck from displacing a repo's own
 * vitest config. A dependency-free worktree (the corpus) gets the standalone
 * config exactly as before; a worktree with its own config gets one that
 * extends it, so the repo's aliases, environment, and setup files survive.
 */
async function worktree(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claimcheck-cfg-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, "utf8");
  }
  return dir;
}

describe("detectRepoVitestConfig", () => {
  it("finds a repo vitest.config.ts", async () => {
    const dir = await worktree({ "vitest.config.ts": "export default {}" });
    try {
      expect(await detectRepoVitestConfig(dir)).toBe("vitest.config.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to vite.config and supports .mts", async () => {
    const dir = await worktree({ "vite.config.mts": "export default {}" });
    try {
      expect(await detectRepoVitestConfig(dir)).toBe("vite.config.mts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never mistakes ClaimCheck's own generated config for the repo's", async () => {
    const dir = await worktree({
      "claimcheck.vitest.config.ts": "export default {}",
    });
    try {
      expect(await detectRepoVitestConfig(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("composeVitestConfig", () => {
  it("emits the standalone config when the repo has none", async () => {
    const dir = await worktree();
    try {
      const body = await composeVitestConfig(dir, {
        setupFiles: ["claimcheck.sandbox.js"],
      });
      expect(body).toContain('setupFiles: ["./claimcheck.sandbox.js"]');
      expect(body).not.toContain("mergeConfig");
      expect(body).not.toContain("import repoConfig");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("extends the repo's config when present, preserving it via mergeConfig", async () => {
    const dir = await worktree({ "vitest.config.ts": "export default {}" });
    try {
      const body = await composeVitestConfig(dir, {
        setupFiles: ["claimcheck.sandbox.js"],
        include: ["tests/a.test.ts"],
      });
      expect(body).toContain('import repoConfig from "./vitest.config.ts"');
      expect(body).toContain("mergeConfig(base,");
      // The sandbox setup is appended on top of the repo's own setup files.
      expect(body).toContain('setupFiles: ["./claimcheck.sandbox.js"]');
      // The run is scoped from the root so the repo's test.dir cannot misroute it.
      expect(body).toContain('dir: "."');
      expect(body).toContain('include: ["tests/a.test.ts"]');
      // Handles both object and function default exports.
      expect(body).toContain("typeof repoConfig === \"function\"");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
