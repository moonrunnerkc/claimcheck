import { describe, expect, it } from "vitest";
import { classifyMutants } from "./mutant-equivalence.js";
import type { MutantOutcome } from "../core/evidence-record.js";

function mutant(over: Partial<MutantOutcome>): MutantOutcome {
  return {
    id: "m",
    file: "src/a.ts",
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 6,
    mutator: "ArithmeticOperator",
    replacement: "a - b",
    status: "survived",
    prefilter: "none",
    noopOrInversion: false,
    ...over,
  };
}

describe("classifyMutants", () => {
  it("marks no-coverage mutants as unreachable", () => {
    const [out] = classifyMutants([mutant({ status: "no-coverage" })], new Map());
    expect(out?.prefilter).toBe("unreachable");
  });

  it("marks a mutant whose replacement equals the original as trivially equivalent", () => {
    const source = new Map([["src/a.ts", "a + b\n"]]);
    // The span (1:1-1:6) is "a + b"; a replacement of "a  +  b" normalizes equal.
    const [out] = classifyMutants(
      [mutant({ replacement: "a  +  b" })],
      source,
    );
    expect(out?.prefilter).toBe("trivially-equivalent");
  });

  it("leaves a genuinely altering mutant as none", () => {
    const source = new Map([["src/a.ts", "a + b\n"]]);
    const [out] = classifyMutants([mutant({ replacement: "a - b" })], source);
    expect(out?.prefilter).toBe("none");
  });

  it("does not classify when the source is unavailable", () => {
    const [out] = classifyMutants([mutant({})], new Map());
    expect(out?.prefilter).toBe("none");
  });
});
