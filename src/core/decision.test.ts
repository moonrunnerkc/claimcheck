import { describe, expect, it } from "vitest";
import { decide } from "./decision.js";
import type {
  EvidenceRecord,
  MutantOutcome,
  AssertionReach,
} from "./evidence-record.js";

/** A clean, honest-fix record: every check should pass. */
function honestRecord(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    baseSha: "parent",
    headSha: "head",
    changedRanges: [{ file: "src/calc.ts", start: 5, end: 5 }],
    headTestsPass: true,
    failsOnParent: "failed",
    coveredChangedLines: [{ file: "src/calc.ts", start: 5, end: 5 }],
    mutants: [killedNoop()],
    taint: [reaches()],
    nondeterminism: [],
    regressions: [],
    errorSuppressions: [],
    testWeakenings: [],
    quarantined: [],
    toolVersion: "0.1.0",
    ...overrides,
  };
}

function killedNoop(): MutantOutcome {
  return {
    id: "m-noop",
    file: "src/calc.ts",
    startLine: 5,
    startColumn: 1,
    endLine: 5,
    endColumn: 20,
    mutator: "BlockStatement",
    replacement: "{}",
    status: "killed",
    prefilter: "none",
    noopOrInversion: true,
  };
}

function reaches(): AssertionReach {
  return {
    file: "src/calc.ts",
    line: 5,
    column: 3,
    expression: "a + b",
    reachesAssertion: true,
    chain: ["a + b", "result", "expect(result)"],
  };
}

function findCheck(record: EvidenceRecord, id: string) {
  const verdict = decide(record);
  const check = verdict.checks.find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return { verdict, check };
}

describe("decide", () => {
  it("passes an honest fix where tests constrain the change", () => {
    const verdict = decide(honestRecord());
    expect(verdict.tier).toBe("pass");
    expect(verdict.checks.every((c) => c.tier === "pass")).toBe(true);
  });

  it("blocks when a no-op mutant survives on a covered changed line", () => {
    const survivor: MutantOutcome = { ...killedNoop(), status: "survived" };
    const { verdict, check } = findCheck(
      honestRecord({ mutants: [survivor] }),
      "kill-check",
    );
    expect(check.tier).toBe("block");
    expect(verdict.tier).toBe("block");
  });

  it("only warns when a non-no-op mutant survives, since it may be equivalent", () => {
    const survivor: MutantOutcome = {
      ...killedNoop(),
      id: "m-arith",
      mutator: "ArithmeticOperator",
      noopOrInversion: false,
      status: "survived",
    };
    const { check } = findCheck(honestRecord({ mutants: [survivor] }), "kill-check");
    expect(check.tier).toBe("warn");
  });

  it("blocks a vacuous test where a changed value never reaches an assertion", () => {
    const vacuous: AssertionReach = { ...reaches(), reachesAssertion: false };
    // A surviving mutant on the same line agrees with taint, so it is no
    // contradiction: the test is cleanly vacuous.
    const survivor: MutantOutcome = { ...killedNoop(), status: "survived" };
    const { verdict, check } = findCheck(
      honestRecord({ taint: [vacuous], mutants: [survivor] }),
      "assertion-reachability",
    );
    expect(check.tier).toBe("block");
    expect(verdict.tier).toBe("block");
  });

  it("downgrades a taint-vs-kill contradiction to warn instead of resolving it", () => {
    const vacuous: AssertionReach = { ...reaches(), reachesAssertion: false };
    // The killed no-op mutant on the same line contradicts the taint result.
    const { check } = findCheck(
      honestRecord({ taint: [vacuous], mutants: [killedNoop()] }),
      "assertion-reachability",
    );
    expect(check.tier).toBe("warn");
  });

  it("blocks on a regression of a stable parent test", () => {
    const { verdict, check } = findCheck(
      honestRecord({ regressions: ["calc keeps negatives"] }),
      "regression",
    );
    expect(check.tier).toBe("block");
    expect(verdict.tier).toBe("block");
  });

  it("warns, never blocks, when the new test passes on the parent", () => {
    const { verdict, check } = findCheck(
      honestRecord({ failsOnParent: "passed" }),
      "fails-on-parent",
    );
    expect(check.tier).toBe("warn");
    // No block-tier check fired, so the worst tier is warn.
    expect(verdict.tier).toBe("warn");
  });

  it("warns when the new test cannot run on the parent", () => {
    const { check } = findCheck(
      honestRecord({ failsOnParent: "indeterminate" }),
      "fails-on-parent",
    );
    expect(check.tier).toBe("warn");
  });

  it("warns when no changed line is covered by the new tests", () => {
    const { check } = findCheck(
      honestRecord({ coveredChangedLines: [] }),
      "test-touches-code",
    );
    expect(check.tier).toBe("warn");
  });

  it("warns when the new tests do not pass on head", () => {
    const { check } = findCheck(
      honestRecord({ headTestsPass: false }),
      "passes-on-head",
    );
    expect(check.tier).toBe("warn");
  });

  it("blocks when an existing assertion is loosened", () => {
    const { verdict, check } = findCheck(
      honestRecord({
        testWeakenings: [
          {
            file: "test/calc.test.ts",
            line: 12,
            kind: "assertion-loosened",
            detail: "toBe(5) -> toBeGreaterThan(0)",
          },
        ],
      }),
      "test-weakening",
    );
    expect(check.tier).toBe("block");
    expect(verdict.tier).toBe("block");
  });

  it("only warns when an expected value changed, since the behavior may have changed", () => {
    const { check } = findCheck(
      honestRecord({
        testWeakenings: [
          {
            file: "test/calc.test.ts",
            line: 12,
            kind: "expected-value-changed",
            detail: "toBe(5) -> toBe(6)",
          },
        ],
      }),
      "test-weakening",
    );
    expect(check.tier).toBe("warn");
  });

  it("warns on an error-suppression pattern, never blocks on it alone", () => {
    const { verdict, check } = findCheck(
      honestRecord({
        errorSuppressions: [
          {
            file: "src/calc.ts",
            line: 5,
            column: 3,
            kind: "empty-catch",
            snippet: "catch (e) {}",
          },
        ],
      }),
      "error-suppression",
    );
    expect(check.tier).toBe("warn");
    expect(verdict.tier).toBe("warn");
  });

  it("is a pure function: identical records yield identical verdicts and hashes", () => {
    const first = decide(honestRecord());
    const second = decide(honestRecord());
    expect(first).toEqual(second);
    expect(first.bundleHash).toEqual(second.bundleHash);
  });
});
