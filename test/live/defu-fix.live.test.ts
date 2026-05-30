import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../src/util/exec.js";
import { runPipeline } from "../../src/core/pipeline.js";
import { fixClaim } from "../../src/core/claim.js";
import { replayBundle } from "../../src/bundle/verdict-bundle.js";

/**
 * The live, networked case study. It clones a real external vitest repository
 * (unjs/defu) and runs ClaimCheck against a real historical bug-fix PR using the
 * repo's OWN install and the repo's OWN vitest, not ClaimCheck's borrowed
 * toolchain. This tier is explicitly NOT part of the determinism guarantee: it
 * needs network and a Node version compatible with the repo's vitest. It runs
 * only via `npm run test:live` (which sets CLAIMCHECK_LIVE).
 *
 * The PR (unjs/defu#121, commit 1b9fcab) fixes isPlainObject so a Module-tagged
 * object is treated as plain, and adds one asterisk-import test. ClaimCheck's
 * correct verdict is BLOCK: the new test fails on the parent (it caught the
 * bug) and passes on head, but it does not constrain the changed lines. A
 * mutant that empties the Module-specific check still passes the whole defu
 * suite, which is verifiable independently and is the provable weak-test signal
 * the kill-check reports.
 */

const LIVE = process.env["CLAIMCHECK_LIVE"] === "1";
const DEFU = "https://github.com/unjs/defu";
const PARENT = "7c7a9a48ed675990c222101e623ccb7ba317d16e";
const HEAD = "1b9fcab2c1479f0295a5f867c6ec36a01fda2dfb";

describe.runIf(LIVE)("ClaimCheck on a real external vitest repo (unjs/defu#121)", () => {
  let repoPath: string;
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const c of cleanups.reverse()) await c();
  });

  async function clonedDefu(): Promise<string> {
    if (repoPath) return repoPath;
    const dir = await mkdtemp(join(tmpdir(), "claimcheck-live-defu-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await exec("git", ["clone", "--no-tags", DEFU, dir], { timeoutMs: 300_000 });
    // Make sure both commits are present (full clone includes them).
    await exec("git", ["-C", dir, "cat-file", "-e", HEAD], {});
    await exec("git", ["-C", dir, "cat-file", "-e", PARENT], {});
    repoPath = dir;
    return dir;
  }

  it("blocks the fix because its test does not constrain the changed lines", async () => {
    const repo = await clonedDefu();
    const { verdict, record, bundle } = await runPipeline({
      repoPath: repo,
      base: PARENT,
      head: HEAD,
      claim: fixClaim(),
    });

    const check = (id: string) => verdict.checks.find((c) => c.id === id);

    // The repo's own toolchain ran: its tests pass on head and the new test
    // fails on the unfixed parent (the borrowed toolchain could do neither).
    expect(check("passes-on-head")?.tier).toBe("pass");
    expect(check("fails-on-parent")?.tier).toBe("pass");
    expect(record.failsOnParent).toBe("failed");
    expect(check("test-touches-code")?.tier).toBe("pass");

    // The kill-check found a block-worthy mutant surviving on a covered changed
    // line of the real source file, so the verdict is BLOCK.
    expect(check("kill-check")?.tier).toBe("block");
    expect(verdict.tier).toBe("block");
    expect(
      record.mutants.some(
        (m) =>
          m.file === "src/_utils.ts" &&
          m.status === "survived" &&
          m.noopOrInversion,
      ),
    ).toBe(true);

    // The verdict is a pure function of the recorded facts: replaying the
    // bundle's record reproduces the same verdict and hash.
    const replay = replayBundle(bundle);
    expect(replay.reproduced).toBe(true);
    expect(replay.mismatches).toEqual([]);
  });
});
