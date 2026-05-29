import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalizeRecord,
  hashRecord,
  type EvidenceRecord,
} from "./evidence-record.js";

function baseRecord(): EvidenceRecord {
  return {
    baseSha: "aaa",
    headSha: "bbb",
    changedRanges: [
      { file: "src/b.ts", start: 10, end: 12 },
      { file: "src/a.ts", start: 1, end: 3 },
    ],
    headTestsPass: true,
    failsOnParent: "failed",
    coveredChangedLines: [{ file: "src/a.ts", start: 1, end: 3 }],
    mutants: [
      {
        id: "m2",
        file: "src/a.ts",
        startLine: 2,
        startColumn: 1,
        endLine: 2,
        endColumn: 9,
        mutator: "ArithmeticOperator",
        replacement: "a - b",
        status: "killed",
        prefilter: "none",
        noopOrInversion: false,
      },
      {
        id: "m1",
        file: "src/a.ts",
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 5,
        mutator: "BlockStatement",
        replacement: "{}",
        status: "killed",
        prefilter: "none",
        noopOrInversion: true,
      },
    ],
    taint: [],
    nondeterminism: [],
    regressions: ["t2", "t1"],
    errorSuppressions: [],
    testWeakenings: [],
    staticTail: [],
    vacuousAssertions: [],
    quarantined: [],
    toolVersion: "0.1.0",
  };
}

describe("canonicalizeRecord", () => {
  it("sorts collections so insertion order cannot change the serialization", () => {
    const a = baseRecord();
    const shuffled: EvidenceRecord = {
      ...a,
      changedRanges: [...a.changedRanges].reverse(),
      mutants: [...a.mutants].reverse(),
      regressions: [...a.regressions].reverse(),
    };
    expect(canonicalJson(canonicalizeRecord(a))).toEqual(
      canonicalJson(canonicalizeRecord(shuffled)),
    );
  });

  it("orders changed ranges by file then start line", () => {
    const c = canonicalizeRecord(baseRecord());
    expect(c.changedRanges.map((r) => r.file)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("hashRecord", () => {
  it("is identical across reruns for structurally equal records", () => {
    expect(hashRecord(baseRecord())).toEqual(hashRecord(baseRecord()));
  });

  it("is invariant to insertion order of collections", () => {
    const a = baseRecord();
    const reordered: EvidenceRecord = {
      ...a,
      mutants: [...a.mutants].reverse(),
      regressions: [...a.regressions].reverse(),
    };
    expect(hashRecord(a)).toEqual(hashRecord(reordered));
  });

  it("changes when an observed fact changes", () => {
    const a = baseRecord();
    const mutated: EvidenceRecord = { ...a, headTestsPass: false };
    expect(hashRecord(a)).not.toEqual(hashRecord(mutated));
  });

  it("is prefixed with the algorithm name", () => {
    expect(hashRecord(baseRecord())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
