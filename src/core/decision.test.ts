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
    coverageCollected: true,
    failsOnParent: "failed",
    coveredChangedLines: [{ file: "src/calc.ts", start: 5, end: 5 }],
    mutants: [killedNoop()],
    taint: [reaches()],
    nondeterminism: [],
    regressions: [],
    errorSuppressions: [],
    testWeakenings: [],
    staticTail: [],
    vacuousAssertions: [],
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

  it("blocks when every live mutant on a covered changed line survives", () => {
    // Two arithmetic survivors on the same line: not explainable as a single
    // equivalent mutant, so the line is provably unconstrained.
    const a: MutantOutcome = {
      ...killedNoop(),
      id: "m-a",
      mutator: "ArithmeticOperator",
      noopOrInversion: false,
      status: "survived",
    };
    const b: MutantOutcome = { ...a, id: "m-b", replacement: "a / b" };
    const { verdict, check } = findCheck(
      honestRecord({ mutants: [a, b] }),
      "kill-check",
    );
    expect(check.tier).toBe("block");
    expect(verdict.tier).toBe("block");
  });

  it("only warns when a single non-no-op mutant survives and the test failed on parent", () => {
    const survivor: MutantOutcome = {
      ...killedNoop(),
      id: "m-arith",
      mutator: "ArithmeticOperator",
      noopOrInversion: false,
      status: "survived",
    };
    // honestRecord has failsOnParent="failed", so the escalation must not fire.
    const { check } = findCheck(honestRecord({ mutants: [survivor] }), "kill-check");
    expect(check.tier).toBe("warn");
  });

  it("escalates to block when the test passes on parent AND a real mutant survives on the fix line", () => {
    const survivor: MutantOutcome = {
      ...killedNoop(),
      id: "m-arith",
      mutator: "ArithmeticOperator",
      noopOrInversion: false,
      status: "survived",
    };
    const { verdict, check } = findCheck(
      honestRecord({ mutants: [survivor], failsOnParent: "passed" }),
      "kill-check",
    );
    expect(check.tier).toBe("block");
    expect(verdict.tier).toBe("block");
  });

  it("does not escalate when the surviving mutant is off the covered changed lines", () => {
    const offLine: MutantOutcome = {
      ...killedNoop(),
      id: "m-off",
      startLine: 99,
      endLine: 99,
      mutator: "ArithmeticOperator",
      noopOrInversion: false,
      status: "survived",
    };
    const { check } = findCheck(
      honestRecord({ mutants: [offLine], failsOnParent: "passed" }),
      "kill-check",
    );
    expect(check.tier).toBe("warn");
  });

  it("does not escalate when fails-on-parent is only indeterminate", () => {
    const survivor: MutantOutcome = {
      ...killedNoop(),
      id: "m-arith",
      mutator: "ArithmeticOperator",
      noopOrInversion: false,
      status: "survived",
    };
    const { check } = findCheck(
      honestRecord({ mutants: [survivor], failsOnParent: "indeterminate" }),
      "kill-check",
    );
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

  it("warns, not blocks, when taint says unreachable but the kill-check shows the change is constrained", () => {
    // Real-repo case (zustand): the changed value reaches the assertion only
    // through a side effect (set() -> store state) that value-taint cannot
    // follow, so taint reports unreachable. But a mutant on the change was
    // killed and none survived, so the test demonstrably constrains the change.
    // No block-worthy mutant landed on the exact taint line, so the per-line
    // cross-check alone would have false-blocked.
    const vacuous: AssertionReach = { ...reaches(), line: 5, reachesAssertion: false };
    const killedElsewhere: MutantOutcome = {
      ...killedNoop(),
      id: "m-far",
      startLine: 7,
      endLine: 7,
      status: "killed",
    };
    const { verdict, check } = findCheck(
      honestRecord({ taint: [vacuous], mutants: [killedElsewhere] }),
      "assertion-reachability",
    );
    expect(check.tier).toBe("warn");
    expect(verdict.tier).not.toBe("block");
  });

  it("still blocks a cleanly vacuous test when no mutation contradicts taint", () => {
    // A surviving mutant (not killed) provides no positive constraint evidence,
    // so taint's unreachable stands and blocks.
    const vacuous: AssertionReach = { ...reaches(), reachesAssertion: false };
    const survivor: MutantOutcome = { ...killedNoop(), status: "survived" };
    const { check } = findCheck(
      honestRecord({ taint: [vacuous], mutants: [survivor] }),
      "assertion-reachability",
    );
    expect(check.tier).toBe("block");
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

  it("warns on a coverage-ignore marker on a changed line, never blocks alone", () => {
    const { verdict, check } = findCheck(
      honestRecord({
        staticTail: [
          {
            file: "src/calc.ts",
            line: 5,
            kind: "coverage-ignore",
            detail: "coverage-ignore marker on a changed line: /* istanbul ignore next */",
          },
        ],
      }),
      "static-tail",
    );
    expect(check.tier).toBe("warn");
    expect(verdict.tier).toBe("warn");
  });

  it("blocks a coverage-ignore that taint confirms reaches no assertion", () => {
    const vacuous: AssertionReach = { ...reaches(), reachesAssertion: false };
    const { verdict, check } = findCheck(
      honestRecord({
        // The killed no-op would contradict an unreachable taint on assertion-
        // reachability, so use a survivor to keep that check from interfering.
        mutants: [{ ...killedNoop(), status: "survived" }],
        taint: [vacuous],
        staticTail: [
          {
            file: "src/calc.ts",
            line: 5,
            kind: "coverage-ignore",
            detail: "coverage-ignore marker on a changed line",
          },
        ],
      }),
      "static-tail",
    );
    expect(check.tier).toBe("block");
    expect(verdict.tier).toBe("block");
  });

  it("warns on a type-suppression even when taint is unreachable (no conjunction for it)", () => {
    const vacuous: AssertionReach = { ...reaches(), reachesAssertion: false };
    const { check } = findCheck(
      honestRecord({
        mutants: [{ ...killedNoop(), status: "survived" }],
        taint: [vacuous],
        staticTail: [
          {
            file: "src/calc.ts",
            line: 5,
            kind: "type-suppression",
            detail: "type-checker suppression on a changed line: @ts-ignore",
          },
        ],
      }),
      "static-tail",
    );
    expect(check.tier).toBe("warn");
  });

  it("warns on a mock-the-sut when a changed line is still covered", () => {
    const { check } = findCheck(
      honestRecord({
        vacuousAssertions: [
          {
            file: "src/calc.test.ts",
            line: 2,
            kind: "mock-the-sut",
            detail: 'the test mocks "./calc"',
            mockedChangedFile: "src/calc.ts",
          },
        ],
      }),
      "vacuous-assertion",
    );
    expect(check.tier).toBe("warn");
  });

  it("blocks mock-the-sut of the changed module when no changed line is covered", () => {
    const { verdict, check } = findCheck(
      honestRecord({
        coveredChangedLines: [],
        vacuousAssertions: [
          {
            file: "src/calc.test.ts",
            line: 2,
            kind: "mock-the-sut",
            detail: 'the test mocks "./calc", the changed module under test',
            mockedChangedFile: "src/calc.ts",
          },
        ],
      }),
      "vacuous-assertion",
    );
    expect(check.tier).toBe("block");
    expect(verdict.tier).toBe("block");
  });

  it("does not block mock-the-sut when coverage collection failed", () => {
    // Empty covered lines plus a failed collection is a measurement gap, not
    // proof the changed code never ran, so it must degrade to WARN, not BLOCK.
    const { verdict, check } = findCheck(
      honestRecord({
        coveredChangedLines: [],
        coverageCollected: false,
        vacuousAssertions: [
          {
            file: "src/calc.test.ts",
            line: 2,
            kind: "mock-the-sut",
            detail: 'the test mocks "./calc"',
            mockedChangedFile: "src/calc.ts",
          },
        ],
      }),
      "vacuous-assertion",
    );
    expect(check.tier).toBe("warn");
    expect(verdict.tier).not.toBe("block");
  });

  it("warns when a passing run collected no coverage at all", () => {
    const { check } = findCheck(
      honestRecord({ coveredChangedLines: [], coverageCollected: false }),
      "coverage-reliability",
    );
    expect(check.tier).toBe("warn");
  });

  it("passes coverage-reliability when coverage was collected", () => {
    const { check } = findCheck(honestRecord(), "coverage-reliability");
    expect(check.tier).toBe("pass");
  });

  it("warns, never blocks, on a tautology or snapshot acceptance", () => {
    const { check } = findCheck(
      honestRecord({
        vacuousAssertions: [
          {
            file: "src/calc.test.ts",
            line: 3,
            kind: "tautology",
            detail: "expect(x).toBe(x) asserts a value against itself",
            mockedChangedFile: "",
          },
        ],
      }),
      "vacuous-assertion",
    );
    expect(check.tier).toBe("warn");
  });

  it("abstains (passes) on assertion-reachability when no taint was collected", () => {
    const { check } = findCheck(honestRecord({ taint: [] }), "assertion-reachability");
    expect(check.tier).toBe("pass");
  });

  it("is a pure function: identical records yield identical verdicts and hashes", () => {
    const first = decide(honestRecord());
    const second = decide(honestRecord());
    expect(first).toEqual(second);
    expect(first.bundleHash).toEqual(second.bundleHash);
  });

  it("emits no oracle check when no oracle produced a finding", () => {
    const verdict = decide(honestRecord());
    expect(verdict.checks.some((c) => c.id === "oracle")).toBe(false);
  });

  it("blocks when an oracle is violated on head", () => {
    const { verdict, check } = findCheck(
      honestRecord({
        oracleFindings: [
          {
            oracle: "issue-repro",
            conclusion: "violated",
            summary: "the reporter's repro fails on head",
            evidence: ["head=fail", "parent=fail"],
          },
        ],
      }),
      "oracle",
    );
    expect(check.tier).toBe("block");
    expect(verdict.tier).toBe("block");
  });

  it("warns when an oracle could not be evaluated deterministically", () => {
    const { verdict, check } = findCheck(
      honestRecord({
        oracleFindings: [
          {
            oracle: "issue-repro",
            conclusion: "indeterminate",
            summary: "repro present, not machine-extractable",
            evidence: [],
          },
        ],
      }),
      "oracle",
    );
    expect(check.tier).toBe("warn");
    expect(verdict.tier).toBe("warn");
  });

  it("keeps the verdict a pass when the only oracle is satisfied", () => {
    const { verdict, check } = findCheck(
      honestRecord({
        oracleFindings: [
          {
            oracle: "issue-repro",
            conclusion: "satisfied",
            summary: "the reporter's repro passes on head and failed on parent",
            evidence: ["head=pass", "parent=fail"],
          },
        ],
      }),
      "oracle",
    );
    expect(check.tier).toBe("pass");
    expect(verdict.tier).toBe("pass");
  });

  it("never lets a satisfied oracle lower an existing block", () => {
    const survivor: MutantOutcome = { ...killedNoop(), status: "survived" };
    const verdict = decide(
      honestRecord({
        mutants: [survivor],
        oracleFindings: [
          {
            oracle: "issue-repro",
            conclusion: "satisfied",
            summary: "repro passes on head",
            evidence: [],
          },
        ],
      }),
    );
    expect(verdict.tier).toBe("block");
  });
});
