import { describe, expect, it } from "vitest";
import {
  buildAnnotations,
  renderAnnotationList,
  renderGithubAnnotations,
} from "./annotations.js";
import type { EvidenceRecord } from "../core/evidence-record.js";
import { decide } from "../core/decision.js";

function record(over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    baseSha: "parent",
    headSha: "head",
    changedRanges: [{ file: "src/a.ts", start: 5, end: 5 }],
    headTestsPass: true,
    coverageCollected: true,
    failsOnParent: "failed",
    coveredChangedLines: [{ file: "src/a.ts", start: 5, end: 5 }],
    mutants: [],
    taint: [],
    nondeterminism: [],
    regressions: [],
    errorSuppressions: [],
    testWeakenings: [],
    staticTail: [],
    vacuousAssertions: [],
    quarantined: [],
    degradations: [],
    toolVersion: "0.1.0",
    ...over,
  };
}

describe("buildAnnotations", () => {
  it("maps a static-tail finding to a warning annotation at its line", () => {
    const rec = record({
      staticTail: [
        {
          file: "src/a.ts",
          line: 5,
          kind: "coverage-ignore",
          detail: "coverage-ignore marker on a changed line",
        },
      ],
    });
    const annotations = buildAnnotations(rec, decide(rec));
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      file: "src/a.ts",
      line: 5,
      tier: "warn",
      check: "static-tail",
    });
  });

  it("inherits the BLOCK tier when a check blocks", () => {
    const rec = record({
      regressions: ["a keeps negatives"],
    });
    const annotations = buildAnnotations(rec, decide(rec));
    const reg = annotations.find((a) => a.check === "regression");
    expect(reg!.tier).toBe("block");
    expect(reg!.file).toBe("");
    expect(reg!.line).toBe(0);
  });

  it("drops findings whose check passed", () => {
    // A killed mutant produces no kill-check finding and the check passes.
    const rec = record({
      mutants: [
        {
          id: "m1",
          file: "src/a.ts",
          startLine: 5,
          startColumn: 1,
          endLine: 5,
          endColumn: 9,
          mutator: "ArithmeticOperator",
          replacement: "a - b",
          status: "killed",
          prefilter: "none",
          noopOrInversion: false,
        },
      ],
    });
    const annotations = buildAnnotations(rec, decide(rec));
    expect(annotations.find((a) => a.check === "kill-check")).toBeUndefined();
  });
});

describe("renderGithubAnnotations", () => {
  it("emits ::error for block and ::warning for warn with file and line", () => {
    const rec = record({
      staticTail: [
        { file: "src/a.ts", line: 5, kind: "type-suppression", detail: "@ts-ignore on a changed line" },
      ],
    });
    const out = renderGithubAnnotations(buildAnnotations(rec, decide(rec)));
    expect(out).toContain("::warning ");
    expect(out).toContain("file=src/a.ts");
    expect(out).toContain("line=5");
    expect(out).toContain("title=ClaimCheck static-tail");
  });

  it("escapes newlines and commas in the command payload", () => {
    const rec = record({
      testWeakenings: [
        { file: "t.test.ts", line: 3, kind: "assertion-loosened", detail: "a, b\nc" },
      ],
    });
    const out = renderGithubAnnotations(buildAnnotations(rec, decide(rec)));
    expect(out).toContain("%0A"); // newline escaped in the message body
    expect(out).not.toMatch(/::error [^:]*\n/); // no raw newline splits the command
  });

  it("emits a location-free command for a regressed test", () => {
    const rec = record({ regressions: ["x"] });
    const out = renderGithubAnnotations(buildAnnotations(rec, decide(rec)));
    expect(out).toMatch(/^::error title=ClaimCheck regression::/);
  });
});

describe("renderAnnotationList", () => {
  it("anchors each finding at file:line with its tier and check", () => {
    const rec = record({
      vacuousAssertions: [
        {
          file: "src/a.test.ts",
          line: 2,
          kind: "tautology",
          detail: "expect(x).toBe(x) asserts a value against itself",
          mockedChangedFile: "",
        },
      ],
    });
    const out = renderAnnotationList(buildAnnotations(rec, decide(rec)));
    expect(out).toContain("[WARN] src/a.test.ts:2 vacuous-assertion");
  });

  it("is deterministic across runs", () => {
    const rec = record({
      staticTail: [
        { file: "src/a.ts", line: 5, kind: "coverage-ignore", detail: "x" },
      ],
    });
    const first = renderGithubAnnotations(buildAnnotations(rec, decide(rec)));
    const second = renderGithubAnnotations(buildAnnotations(rec, decide(rec)));
    expect(first).toEqual(second);
  });
});
