import { afterAll, describe, expect, it } from "vitest";
import { materializeCase } from "../../eval/corpus-repo.js";
import { corpusDir } from "../../eval/corpus-loader.js";
import { join } from "node:path";
import { createWorktrees, linkNodeModules } from "../git/worktree.js";
import { findToolchainModules } from "../adapters/toolchain.js";
import { collectCoverage, intersectChangedLines } from "./collect.js";

/**
 * End-to-end coverage collection against a real worktree. This proves the
 * vitest runner, the istanbul parser, and the diff intersection compose: the
 * fix line of the honest case must be reported as covered by its test.
 */
describe("collectCoverage against a real worktree", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    // LIFO: remove worktrees before the repo they belong to.
    for (const c of cleanups.reverse()) await c();
  });

  it("reports the changed fix line as covered by the new test", async () => {
    const repo = await materializeCase(join(corpusDir(), "honest-discount"));
    cleanups.push(repo.cleanup);
    const wt = await createWorktrees(repo.repoPath, repo.baseSha, repo.headSha);
    cleanups.push(wt.cleanup);
    await linkNodeModules(wt.headDir, await findToolchainModules());

    const collection = await collectCoverage(wt.headDir, ["src/discount.test.ts"]);
    expect(collection.run.passed).toBe(true);
    expect(collection.run.outcomes.some((o) => o.status === "pass")).toBe(true);

    const covered = collection.coveredLines.get("src/discount.ts");
    expect(covered).toBeDefined();
    // The fix is on line 2 of discount.ts (the return statement).
    expect(covered?.has(2)).toBe(true);

    const intersected = intersectChangedLines(
      [{ file: "src/discount.ts", start: 2, end: 2 }],
      collection.coveredLines,
    );
    expect(intersected).toEqual([{ file: "src/discount.ts", start: 2, end: 2 }]);
  }, 60_000);
});
