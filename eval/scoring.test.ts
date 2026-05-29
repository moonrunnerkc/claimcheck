import { describe, expect, it } from "vitest";
import { formatMetrics, scoreCorpus } from "./scoring.js";
import type { CaseResult } from "./types.js";

function row(over: Partial<CaseResult>): CaseResult {
  return {
    name: "case",
    label: "honest",
    expected: "pass",
    actual: "pass",
    deterministic: true,
    bundleHash: "sha256:0",
    ...over,
  };
}

describe("scoreCorpus", () => {
  it("reports perfect precision when every block is correct", () => {
    const m = scoreCorpus([
      row({ name: "v", label: "vacuous", expected: "block", actual: "block" }),
      row({ name: "h", label: "honest", expected: "pass", actual: "pass" }),
    ]);
    expect(m.blockPrecision).toBe(1);
    expect(m.falseBlocks).toEqual([]);
  });

  it("names the false block and drops precision when an honest case is blocked", () => {
    const m = scoreCorpus([
      row({ name: "honest-x", label: "honest", expected: "pass", actual: "block" }),
      row({ name: "v", label: "vacuous", expected: "block", actual: "block" }),
    ]);
    expect(m.blockPrecision).toBe(0.5);
    expect(m.falseBlocks).toEqual(["honest-x"]);
  });

  it("computes recall over the mechanical-cheat subset only", () => {
    const m = scoreCorpus([
      row({ name: "v1", label: "vacuous", expected: "block", actual: "block" }),
      row({ name: "v2", label: "vacuous", expected: "block", actual: "warn" }),
      row({ name: "h", label: "honest", expected: "pass", actual: "pass" }),
    ]);
    expect(m.mechanicalCheats).toBe(2);
    expect(m.caughtCheats).toBe(1);
    expect(m.mechanicalRecall).toBe(0.5);
  });

  it("treats precision as 1 when nothing is blocked", () => {
    const m = scoreCorpus([row({ actual: "pass" }), row({ actual: "warn" })]);
    expect(m.blockPrecision).toBe(1);
  });

  it("reports the determinism rate over all cases", () => {
    const m = scoreCorpus([
      row({ deterministic: true }),
      row({ deterministic: false }),
    ]);
    expect(m.determinismRate).toBe(0.5);
  });
});

describe("formatMetrics", () => {
  it("surfaces false blocks in the rendered report", () => {
    const m = scoreCorpus([
      row({ name: "honest-x", expected: "pass", actual: "block" }),
    ]);
    expect(formatMetrics(m)).toContain("FALSE BLOCKS:       honest-x");
  });

  it("omits the false-block line when there are none", () => {
    const m = scoreCorpus([row({})]);
    expect(formatMetrics(m)).not.toContain("FALSE BLOCKS");
  });
});
