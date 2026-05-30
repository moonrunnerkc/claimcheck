import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../src/util/exec.js";
import { runPipeline } from "../../src/core/pipeline.js";
import { fixClaim } from "../../src/core/claim.js";
import { replayBundle } from "../../src/bundle/verdict-bundle.js";

/**
 * Live case study for the config-override fix. pmndrs/zustand has a non-trivial
 * vitest config (a `zustand` -> ./src alias, jsdom, globals, a custom test dir).
 * Before the fix, ClaimCheck replaced that config and the suite could not even
 * resolve `zustand`, so nothing ran and the verdict was hollow. This test pins
 * that the repo's tests now run under their OWN config and the verdict reflects
 * real behavior.
 *
 * PR: pmndrs/zustand#2678 (commit dad3641, vitest ^1.6.0), a fix to the persist
 * middleware with an added persistSync test. The correct verdict is WARN, not a
 * block: the new test fails on the parent and passes on head, the kill-check
 * kills every mutant on the changed lines (the test constrains the change), and
 * assertion-reachability only disagrees on values observed through a side
 * effect taint cannot follow, which is surfaced as a WARN, never a false block.
 */

const LIVE = process.env["CLAIMCHECK_LIVE"] === "1";
const ZUSTAND = "https://github.com/pmndrs/zustand";
const PARENT = "a56e76db5261291dcf9a88573dac58f67edb93db";
const HEAD = "dad36416dcad6c4ce39e6415fe288f94cd4fdf1c";

describe.runIf(LIVE)("ClaimCheck on a real repo with a non-trivial vitest config (zustand#2678)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const c of cleanups.reverse()) await c();
  });

  it("runs the repo's tests under their own config and reflects real behavior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claimcheck-live-zustand-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await exec("git", ["clone", "--no-tags", ZUSTAND, dir], { timeoutMs: 300_000 });

    const { verdict, record, bundle } = await runPipeline({
      repoPath: dir,
      base: PARENT,
      head: HEAD,
      claim: fixClaim(),
    });
    const check = (id: string) => verdict.checks.find((c) => c.id === id);

    // The repo's own jsdom + alias config was in effect: the tests resolved
    // `zustand` (alias), ran, and passed; the changed source lines were covered;
    // the new test failed on the unfixed parent. Under our displaced config none
    // of this was possible (the suite could not resolve `zustand`).
    expect(check("passes-on-head")?.tier).toBe("pass");
    expect(check("test-touches-code")?.tier).toBe("pass");
    expect(record.failsOnParent).toBe("failed");
    expect(
      record.coveredChangedLines.some((r) => r.file === "src/middleware/persist.ts"),
    ).toBe(true);

    // The test constrains the change: every mutant on the changed lines is
    // killed, so the verdict is WARN (a taint disagreement), never a false block.
    expect(check("kill-check")?.tier).toBe("pass");
    expect(verdict.tier).not.toBe("block");

    const replay = replayBundle(bundle);
    expect(replay.reproduced).toBe(true);
  });
});
