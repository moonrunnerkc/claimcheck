import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../src/util/exec.js";
import { runPipeline } from "../../src/core/pipeline.js";
import { fixClaim } from "../../src/core/claim.js";
import { replayBundle } from "../../src/bundle/verdict-bundle.js";

/**
 * Live case study proving the PASS tier on real third-party code. unjs/ufo#242
 * (commit 62199a0, vitest ^2.0.3) fixes withProtocol to handle a relative
 * protocol and adds a thorough table of cases. The correct verdict is PASS: the
 * new test fails on the parent, passes on head, every block-worthy mutant on the
 * changed lines is killed, and no signal contradicts. Verified independently by
 * mutation: emptying the added fallback fails ufo's own `withProtocol >
 * //example.com` test, so the test genuinely constrains the change.
 */

const LIVE = process.env["CLAIMCHECK_LIVE"] === "1";
const UFO = "https://github.com/unjs/ufo";
const PARENT = "1954caebf751d22f04fff059fc09412de3c6b86d";
const HEAD = "62199a0cc84727b7b4666aaca8ff04cca2f68f3a";

describe.runIf(LIVE)("ClaimCheck PASS on a real honest fix (ufo#242)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const c of cleanups.reverse()) await c();
  });

  it("passes a real fix whose test kills every mutant on the changed lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claimcheck-live-ufo-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await exec("git", ["clone", "--no-tags", UFO, dir], { timeoutMs: 300_000 });

    const { verdict, record, bundle } = await runPipeline({
      repoPath: dir,
      base: PARENT,
      head: HEAD,
      claim: fixClaim(),
    });
    const check = (id: string) => verdict.checks.find((c) => c.id === id);

    expect(verdict.tier).toBe("pass");
    expect(check("passes-on-head")?.tier).toBe("pass");
    expect(check("test-touches-code")?.tier).toBe("pass");
    expect(record.failsOnParent).toBe("failed");
    // The kill-check ran for real and killed every block-worthy mutant.
    expect(check("kill-check")?.tier).toBe("pass");
    expect(record.mutants.some((m) => m.status === "killed")).toBe(true);
    expect(record.mutants.some((m) => m.status === "survived")).toBe(false);

    const replay = replayBundle(bundle);
    expect(replay.reproduced).toBe(true);
  });
});
