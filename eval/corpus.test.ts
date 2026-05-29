import { describe, expect, it } from "vitest";
import { loadCorpus } from "./corpus-loader.js";
import { materializeCase } from "./corpus-repo.js";
import { runCorpus } from "./run-corpus.js";
import { stubDetector } from "./detectors.js";

describe("loadCorpus", () => {
  it("loads the labeled cases with valid metadata", async () => {
    const cases = await loadCorpus();
    expect(cases.length).toBeGreaterThanOrEqual(7);
    const labels = new Set(cases.map((c) => c.label));
    expect(labels).toContain("honest");
    expect(labels).toContain("vacuous");
    expect(labels).toContain("regression");
    expect(labels).toContain("error-hider");
    expect(labels).toContain("flaky");
    expect(labels).toContain("equivalent-mutant");
  });

  it("returns cases in a stable name order", async () => {
    const a = await loadCorpus();
    const b = await loadCorpus();
    expect(a.map((c) => c.name)).toEqual(b.map((c) => c.name));
  });
});

describe("materializeCase", () => {
  it("builds reproducible parent and head SHAs across runs", async () => {
    const cases = await loadCorpus();
    const honest = cases.find((c) => c.name === "honest-discount")!;
    const first = await materializeCase(honest.dir);
    const second = await materializeCase(honest.dir);
    try {
      expect(first.baseSha).toEqual(second.baseSha);
      expect(first.headSha).toEqual(second.headSha);
      expect(first.baseSha).not.toEqual(first.headSha);
      expect(first.baseSha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });
});

describe("runCorpus with the stub detector", () => {
  it("scores every case deterministically end to end", async () => {
    const { results, metrics } = await runCorpus(stubDetector);
    expect(results.length).toBeGreaterThanOrEqual(7);
    // The stub observes nothing, so it never blocks: precision is trivially 1.
    expect(metrics.blockPrecision).toBe(1);
    expect(metrics.falseBlocks).toEqual([]);
    expect(metrics.determinismRate).toBe(1);
  });
});
