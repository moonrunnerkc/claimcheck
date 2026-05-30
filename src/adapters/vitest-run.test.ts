import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVitest } from "./vitest-run.js";
import { findToolchainModules } from "./toolchain.js";

/**
 * Real runs of the adapter against a throwaway worktree. The load-failure case
 * is the regression guard for the hollow-PASS bug: a suite that cannot load
 * must report failedToRun, never an empty-but-passing result.
 */
describe("runVitest", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function worktreeWith(file: string, body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "claimcheck-vr-"));
    dirs.push(dir);
    const toolchain = await findToolchainModules();
    await symlink(toolchain, join(dir, "node_modules"), "dir");
    await writeFile(join(dir, file), body, "utf8");
    return dir;
  }

  it("reports a passing run with outcomes", async () => {
    const dir = await worktreeWith(
      "ok.test.ts",
      `import { it, expect } from "vitest";\nit("adds", () => { expect(1 + 1).toBe(2); });\n`,
    );
    const result = await runVitest({ cwd: dir, testFiles: ["ok.test.ts"] });
    expect(result.passed).toBe(true);
    expect(result.failedToRun).toBe(false);
    expect(result.outcomes.some((o) => o.status === "pass")).toBe(true);
  }, 60_000);

  it("flags a suite that cannot load as failedToRun, not as an empty pass", async () => {
    const dir = await worktreeWith(
      "bad.test.ts",
      `import "claimcheck-nonexistent-dependency-xyz";\nimport { it, expect } from "vitest";\nit("never runs", () => { expect(true).toBe(true); });\n`,
    );
    const result = await runVitest({ cwd: dir, testFiles: ["bad.test.ts"] });
    expect(result.outcomes).toHaveLength(0);
    expect(result.noTests).toBe(false);
    expect(result.passed).toBe(false);
    // The load error must surface, so the pipeline does not read the empty
    // outcome set as passes-on-head.
    expect(result.failedToRun).toBe(true);
  }, 60_000);
});
