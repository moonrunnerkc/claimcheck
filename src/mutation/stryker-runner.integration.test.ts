import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { materializeCase } from "../../eval/corpus-repo.js";
import { corpusDir } from "../../eval/corpus-loader.js";
import { createWorktrees, linkNodeModules } from "../git/worktree.js";
import { findToolchainModules } from "../adapters/toolchain.js";
import { runStryker } from "./stryker-runner.js";

/**
 * Real Stryker runs against the corpus. These are the load-bearing assertions
 * of the kill-check: an honest test kills the no-op mutant on its fix line, and
 * a vacuous test lets it survive.
 */
describe("runStryker against the corpus", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const c of cleanups.reverse()) await c();
  });

  async function mutateHead(
    caseName: string,
    range: string,
    testFile: string,
  ) {
    const repo = await materializeCase(join(corpusDir(), caseName));
    cleanups.push(repo.cleanup);
    const wt = await createWorktrees(repo.repoPath, repo.baseSha, repo.headSha);
    cleanups.push(wt.cleanup);
    await linkNodeModules(wt.headDir, await findToolchainModules());
    return runStryker({
      worktreeDir: wt.headDir,
      mutateRanges: [range],
      testFiles: [testFile],
    });
  }

  it("kills every block-worthy mutant when the test pins the value", async () => {
    const mutants = await mutateHead(
      "honest-discount",
      "src/discount.ts:2-2",
      "src/discount.test.ts",
    );
    expect(mutants.length).toBeGreaterThan(0);
    const blockWorthySurvivors = mutants.filter(
      (m) => m.noopOrInversion && m.status === "survived",
    );
    expect(blockWorthySurvivors).toEqual([]);
  }, 180_000);

  it("leaves the fix line fully unconstrained when the test never checks the value", async () => {
    const mutants = await mutateHead(
      "vacuous-no-throw",
      "src/discount.ts:2-2",
      "src/discount.test.ts",
    );
    const live = mutants.filter((m) => m.prefilter === "none");
    // The "does not throw" test catches no mutation of the return expression.
    expect(live.length).toBeGreaterThanOrEqual(2);
    expect(live.every((m) => m.status === "survived")).toBe(true);
  }, 180_000);
});
