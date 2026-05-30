import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../src/util/exec.js";
import { runPipeline } from "../../src/core/pipeline.js";
import { fixClaim } from "../../src/core/claim.js";

/**
 * Live case proving the taint + kill-check cross-check still produces a TRUE
 * block when a changed value is observed only through indirection AND the test
 * is genuinely vacuous. The zustand fix proved the cross-check stops a FALSE
 * block on an honest side-effect fix; this proves it did not cost recall on
 * that same category.
 *
 * Built on real zustand code: starting from the unfixed parent (a56e76d) it
 * applies the real persist fix and adds a deliberately weak rehydration test
 * that creates a persisted store (so the deserialize path runs and the loaded
 * value flows into the store only via set()) but asserts nothing about the
 * rehydrated value. The correct verdict is BLOCK. Verified by mutation: the
 * weak test still passes when the deserialize line is mutated, while zustand's
 * own strong test fails 10 cases on the same mutation.
 */

const LIVE = process.env["CLAIMCHECK_LIVE"] === "1";
const ZUSTAND = "https://github.com/pmndrs/zustand";
const PARENT = "a56e76db5261291dcf9a88573dac58f67edb93db";
const FIX_SOURCE = "dad36416dcad6c4ce39e6415fe288f94cd4fdf1c";

const WEAK_TEST = `import { describe, expect, it } from 'vitest'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

// Deliberately weak: creates a persisted store from seeded storage so the
// changed deserialize path runs (the loaded value reaches the store only via
// set(), a side effect), but asserts nothing about the rehydrated value.
describe('persist weak rehydration', () => {
  it('builds a persisted store from stored state', () => {
    const storage = {
      getItem: () =>
        JSON.stringify({ state: { count: 42, name: 'x' }, version: 0 }),
      setItem: () => {},
      removeItem: () => {},
    }
    const useBoundStore = create(
      persist(() => ({ count: 0, name: 'empty' }), {
        name: 'weak-storage',
        storage: createJSONStorage(() => storage),
      }),
    )
    expect(useBoundStore.getState()).toBeTruthy()
  })
})
`;

describe.runIf(LIVE)("cross-check still BLOCKs a real vacuous-through-indirection test", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const c of cleanups.reverse()) await c();
  });

  it("blocks an indirection-observed change whose test does not constrain it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claimcheck-live-zv-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await exec("git", ["clone", "--no-tags", ZUSTAND, dir], { timeoutMs: 300_000 });

    const env = {
      GIT_AUTHOR_NAME: "ClaimCheck Live",
      GIT_AUTHOR_EMAIL: "claimcheck@test.invalid",
      GIT_COMMITTER_NAME: "ClaimCheck Live",
      GIT_COMMITTER_EMAIL: "claimcheck@test.invalid",
      GIT_AUTHOR_DATE: "2024-09-01T00:00:00 +0000",
      GIT_COMMITTER_DATE: "2024-09-01T00:00:00 +0000",
    };
    const git = (args: string[]) => exec("git", ["-C", dir, ...args], { env });

    // Start from the unfixed parent, apply the real persist fix, add a weak test.
    await git(["checkout", "-q", PARENT]);
    const fixed = await exec(
      "git",
      ["-C", dir, "show", `${FIX_SOURCE}:src/middleware/persist.ts`],
      {},
    );
    await writeFile(join(dir, "src/middleware/persist.ts"), fixed.stdout, "utf8");
    await writeFile(join(dir, "tests/persistWeak.test.tsx"), WEAK_TEST, "utf8");
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "persist fix with a deliberately weak test"]);
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();

    const { verdict, record } = await runPipeline({
      repoPath: dir,
      base: PARENT,
      head,
      claim: fixClaim(),
    });
    const check = (id: string) => verdict.checks.find((c) => c.id === id);

    // The weak test covers the changed deserialize lines (so the kill-check can
    // run) but does not constrain them, so a block-worthy mutant survives and
    // taint finds the value unreachable: a true BLOCK, not a PASS escape.
    expect(check("test-touches-code")?.tier).toBe("pass");
    expect(verdict.tier).toBe("block");
    const blocked =
      check("kill-check")?.tier === "block" ||
      check("assertion-reachability")?.tier === "block";
    expect(blocked).toBe(true);
    // The mutation signal did not falsely show the change constrained: a live
    // mutant survived, which is why assertion-reachability was not downgraded.
    expect(
      record.mutants.some((m) => m.prefilter === "none" && m.status === "survived"),
    ).toBe(true);
  });
});
