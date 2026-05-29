import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { materializeCase } from "../../eval/corpus-repo.js";
import { corpusDir } from "../../eval/corpus-loader.js";
import { runPipeline } from "./pipeline.js";
import { fixClaim } from "./claim.js";

/**
 * End-to-end pipeline runs against the corpus. These pin the Phase 1 gate: an
 * honest fix passes, a vacuous fix is blocked, and the verdict is reproducible
 * down to the bundle hash.
 */
describe("runPipeline against the corpus", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const c of cleanups.reverse()) await c();
  });

  async function run(caseName: string) {
    const repo = await materializeCase(join(corpusDir(), caseName));
    cleanups.push(repo.cleanup);
    return runPipeline({
      repoPath: repo.repoPath,
      base: repo.baseSha,
      head: repo.headSha,
      claim: fixClaim(),
    });
  }

  it("passes an honest fix whose test pins the changed value", async () => {
    const { verdict } = await run("honest-discount");
    expect(verdict.tier).toBe("pass");
  }, 180_000);

  it("blocks a vacuous fix whose test never checks the value", async () => {
    const { verdict } = await run("vacuous-no-throw");
    expect(verdict.tier).toBe("block");
    const kill = verdict.checks.find((c) => c.id === "kill-check");
    expect(kill?.tier).toBe("block");
    // Phase 3 gate: assertion-reachability catches it independent of mutation.
    const reach = verdict.checks.find((c) => c.id === "assertion-reachability");
    expect(reach?.tier).toBe("block");
  }, 180_000);

  it("catches both vacuous fixes by assertion-reachability alone", async () => {
    for (const name of ["vacuous-no-throw", "vacuous-no-assert"]) {
      const { verdict } = await run(name);
      const reach = verdict.checks.find((c) => c.id === "assertion-reachability");
      expect(reach?.tier, name).toBe("block");
    }
  }, 240_000);

  it("does not let taint false-flag the honest or equivalent-mutant fix", async () => {
    for (const name of ["honest-discount", "equivalent-mutant-clamp"]) {
      const { verdict } = await run(name);
      const reach = verdict.checks.find((c) => c.id === "assertion-reachability");
      expect(reach?.tier, name).not.toBe("block");
    }
  }, 240_000);

  it("blocks the other vacuous fix via the coverage-but-no-assertion path", async () => {
    const { verdict } = await run("vacuous-no-assert");
    expect(verdict.tier).toBe("block");
  }, 180_000);

  it("does not block an honest fix that leaves an equivalent mutant", async () => {
    const { verdict } = await run("equivalent-mutant-clamp");
    expect(verdict.tier).not.toBe("block");
  }, 180_000);

  it("passes a flaky-clock fix once the sandbox pins the wall clock", async () => {
    const { verdict, record } = await run("flaky-clock");
    expect(verdict.tier).toBe("pass");
    // The clock source was found and recorded as controllable.
    expect(record.nondeterminism.some((s) => s.kind === "wall-clock")).toBe(true);
  }, 180_000);

  it("quarantines a test that needs uncontrollable network and warns", async () => {
    const { verdict, record } = await run("quarantine-network");
    expect(verdict.tier).toBe("warn");
    expect(record.quarantined.length).toBeGreaterThan(0);
    expect(record.quarantined[0]?.reason).toContain("network");
  }, 180_000);

  it("reproduces an identical bundle hash across reruns", async () => {
    const first = await run("honest-discount");
    const second = await run("honest-discount");
    expect(first.verdict.bundleHash).toEqual(second.verdict.bundleHash);
  }, 240_000);
});
