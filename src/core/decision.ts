import type { CheckResult, Verdict, VerdictTier } from "./verdict.js";
import { worstTier } from "./verdict.js";
import type {
  AssertionReach,
  EvidenceRecord,
  MutantOutcome,
} from "./evidence-record.js";
import { hashRecord } from "./evidence-record.js";

/**
 * The pure, total decision function. Same record in, same verdict out, with no
 * I/O, no clock, no iteration-order dependence. Every check is a deterministic
 * function of the canonical evidence record.
 *
 * The tiering rules encode the scope boundary: BLOCK is reserved for failures
 * provable from the run alone. Anything ambiguous is WARN.
 */

/** A mutant that ran on a covered changed line and was not pre-filtered out. */
function isLiveMutant(m: MutantOutcome): boolean {
  return m.prefilter === "none";
}

/**
 * passes-on-head sanity gate. If the new tests do not pass on head, the rest of
 * the analysis is built on sand, so this is WARN (the PR is broken, but a
 * broken PR is not the provable lie BLOCK is reserved for, and an environmental
 * failure must never become a false block).
 */
function checkPassesOnHead(record: EvidenceRecord): CheckResult {
  if (record.headTestsPass) {
    return {
      id: "passes-on-head",
      tier: "pass",
      summary: "New and modified tests pass against head.",
      evidence: [`headSha=${record.headSha}`],
    };
  }
  return {
    id: "passes-on-head",
    tier: "warn",
    summary:
      "New or modified tests do not pass on head; the PR is broken and downstream checks are unreliable.",
    evidence: [`headSha=${record.headSha}`],
  };
}

/**
 * test-touches-code. The new tests must execute the changed source lines. Empty
 * coverage of changed lines is WARN: the test may validate something, but it
 * does not demonstrably exercise the claimed fix.
 */
function checkTestTouchesCode(record: EvidenceRecord): CheckResult {
  if (record.changedRanges.length === 0) {
    return {
      id: "test-touches-code",
      tier: "warn",
      summary: "The diff changed no source lines; nothing to constrain.",
      evidence: [],
    };
  }
  if (record.coveredChangedLines.length === 0) {
    return {
      id: "test-touches-code",
      tier: "warn",
      summary:
        "No changed source line is executed by the new or modified tests.",
      evidence: record.changedRanges.map(
        (r) => `${r.file}:${r.start}-${r.end} uncovered`,
      ),
    };
  }
  return {
    id: "test-touches-code",
    tier: "pass",
    summary: "The new or modified tests execute the changed source lines.",
    evidence: record.coveredChangedLines.map(
      (r) => `${r.file}:${r.start}-${r.end} covered`,
    ),
  };
}

/**
 * fails-on-parent. The new tests, run against the unfixed parent, must fail. A
 * pass means the test never exercised the bug. This is the main false-positive
 * risk (a real fix may add a test that also covers new behavior), so a pass is
 * WARN, never BLOCK. Indeterminate (references new symbols) is also WARN.
 */
function checkFailsOnParent(record: EvidenceRecord): CheckResult {
  switch (record.failsOnParent) {
    case "failed":
      return {
        id: "fails-on-parent",
        tier: "pass",
        summary: "The new tests fail against the unfixed parent, as expected.",
        evidence: [`baseSha=${record.baseSha}`],
      };
    case "passed":
      return {
        id: "fails-on-parent",
        tier: "warn",
        summary:
          "The new tests pass against the unfixed parent; they may not exercise the bug.",
        evidence: [`baseSha=${record.baseSha}`],
      };
    case "indeterminate":
      return {
        id: "fails-on-parent",
        tier: "warn",
        summary:
          "The new tests could not run on the parent (they reference symbols introduced by the PR).",
        evidence: [`baseSha=${record.baseSha}`],
      };
  }
}

/** Mutants that survived, ran live, and reduce the line to a no-op/inversion. */
function survivingNoopMutants(record: EvidenceRecord): MutantOutcome[] {
  return record.mutants.filter(
    (m) => isLiveMutant(m) && m.status === "survived" && m.noopOrInversion,
  );
}

/** Live mutants that survived but are not no-op/inversion (could be equivalent). */
function survivingWeakMutants(record: EvidenceRecord): MutantOutcome[] {
  return record.mutants.filter(
    (m) => isLiveMutant(m) && m.status === "survived" && !m.noopOrInversion,
  );
}

/** Was any live mutant covering this file/line killed? Used for cross-checking. */
function killedMutantNear(
  record: EvidenceRecord,
  reach: AssertionReach,
): boolean {
  return record.mutants.some(
    (m) =>
      isLiveMutant(m) &&
      m.status === "killed" &&
      m.file === reach.file &&
      m.startLine <= reach.line &&
      m.endLine >= reach.line,
  );
}

/**
 * assertion-reachability. If a changed expression's value never flows into an
 * assertion the test evaluates, the test is vacuous with respect to the claim,
 * which is a BLOCK on its own. Cross-checked with the kill-check: if a mutant on
 * that same line was killed, an assertion observed a side effect taint did not
 * capture, so the contradiction is surfaced as WARN, not resolved by fiat.
 */
function checkAssertionReachability(record: EvidenceRecord): CheckResult {
  const unreachable = record.taint.filter((t) => !t.reachesAssertion);
  if (record.taint.length === 0) {
    return {
      id: "assertion-reachability",
      tier: "warn",
      summary:
        "No changed expression could be tracked by taint; assertion reachability is unknown.",
      evidence: [],
    };
  }
  if (unreachable.length === 0) {
    return {
      id: "assertion-reachability",
      tier: "pass",
      summary:
        "Every tracked changed expression flows into an assertion the test evaluates.",
      evidence: record.taint.map(
        (t) => `${t.file}:${t.line}:${t.column} ${t.expression} -> assertion`,
      ),
    };
  }
  const contradicted = unreachable.filter((t) => killedMutantNear(record, t));
  const cleanlyVacuous = unreachable.filter(
    (t) => !killedMutantNear(record, t),
  );
  if (cleanlyVacuous.length > 0) {
    return {
      id: "assertion-reachability",
      tier: "block",
      summary:
        "A changed expression's value never reaches an assertion; the test cannot distinguish the fix from its absence.",
      evidence: cleanlyVacuous.map(
        (t) => `${t.file}:${t.line}:${t.column} ${t.expression} -> no assertion`,
      ),
    };
  }
  return {
    id: "assertion-reachability",
    tier: "warn",
    summary:
      "Taint found a changed expression unreachable by assertions, but a mutant on that line was killed; an assertion likely observes a side effect taint did not track.",
    evidence: contradicted.map(
      (t) =>
        `${t.file}:${t.line}:${t.column} ${t.expression} taint=unreachable mutant=killed`,
    ),
  };
}

/**
 * kill-check. A logic-altering mutant that reduces a covered changed line to a
 * no-op or inverts its condition, and survives, confirms the test does not
 * constrain the fix: BLOCK. A surviving mutant that is merely some other
 * operator could be equivalent, so it is WARN.
 */
function checkKillCheck(record: EvidenceRecord): CheckResult {
  const liveMutants = record.mutants.filter(isLiveMutant);
  if (liveMutants.length === 0) {
    return {
      id: "kill-check",
      tier: "warn",
      summary:
        "No live mutant was generated on the covered changed lines; the kill-check could not run.",
      evidence: [],
    };
  }
  const noopSurvivors = survivingNoopMutants(record);
  if (noopSurvivors.length > 0) {
    return {
      id: "kill-check",
      tier: "block",
      summary:
        "A no-op or condition-inverting mutant survived on a covered changed line; the test passes whether or not the fix is real.",
      evidence: noopSurvivors.map(
        (m) => `${m.id} ${m.file}:${m.startLine} ${m.mutator} survived`,
      ),
    };
  }
  const weakSurvivors = survivingWeakMutants(record);
  if (weakSurvivors.length > 0) {
    return {
      id: "kill-check",
      tier: "warn",
      summary:
        "A mutant survived on a covered changed line but may be equivalent; treated as a weak signal.",
      evidence: weakSurvivors.map(
        (m) => `${m.id} ${m.file}:${m.startLine} ${m.mutator} survived`,
      ),
    };
  }
  return {
    id: "kill-check",
    tier: "pass",
    summary: "Every live mutant on the covered changed lines was killed.",
    evidence: liveMutants.map((m) => `${m.id} ${m.mutator} killed`),
  };
}

/**
 * regression. Any test that was stable and passed on the parent and now fails
 * on head is a regression: BLOCK. Quarantined flaky tests never reach here.
 */
function checkRegression(record: EvidenceRecord): CheckResult {
  if (record.regressions.length === 0) {
    return {
      id: "regression",
      tier: "pass",
      summary: "No stable parent test regressed on head.",
      evidence: [],
    };
  }
  return {
    id: "regression",
    tier: "block",
    summary: "A test that passed on the parent now fails on head.",
    evidence: [...record.regressions],
  };
}

/**
 * error-suppression. Swallowed exceptions and success-on-error-path patterns on
 * changed lines are WARN: mechanical evidence of hiding a failure, but the path
 * may be intentional, so it never blocks on its own.
 */
function checkErrorSuppression(record: EvidenceRecord): CheckResult {
  if (record.errorSuppressions.length === 0) {
    return {
      id: "error-suppression",
      tier: "pass",
      summary: "No swallowed-error pattern on the changed lines.",
      evidence: [],
    };
  }
  return {
    id: "error-suppression",
    tier: "warn",
    summary:
      "A changed line swallows an error or returns success on an error path; verify the path is intentional.",
    evidence: record.errorSuppressions.map(
      (e) => `${e.file}:${e.line} ${e.kind}: ${e.snippet}`,
    ),
  };
}

/**
 * test-weakening. Removing or loosening an existing assertion, skipping a test,
 * or marking it todo to fit the changed code is a BLOCK. Changing an expected
 * value is ambiguous (the behavior may legitimately have changed), so it is
 * WARN.
 */
function checkTestWeakening(record: EvidenceRecord): CheckResult {
  if (record.testWeakenings.length === 0) {
    return {
      id: "test-weakening",
      tier: "pass",
      summary: "No existing test assertion was weakened by the diff.",
      evidence: [],
    };
  }
  const blocking = record.testWeakenings.filter(
    (w) => w.kind !== "expected-value-changed",
  );
  if (blocking.length > 0) {
    return {
      id: "test-weakening",
      tier: "block",
      summary:
        "An existing test was weakened to fit the change (assertion removed/loosened, or test skipped).",
      evidence: blocking.map((w) => `${w.file}:${w.line} ${w.kind}: ${w.detail}`),
    };
  }
  return {
    id: "test-weakening",
    tier: "warn",
    summary:
      "An existing test's expected value changed; confirm the behavior change is intended.",
    evidence: record.testWeakenings.map(
      (w) => `${w.file}:${w.line} ${w.kind}: ${w.detail}`,
    ),
  };
}

/**
 * Compute the verdict from the canonical evidence record. Pure and total: the
 * verdict tier is the worst tier across every check under block-precedence, and
 * the bundle hash is the content address of the record.
 *
 * @param record - the canonical evidence record assembled by the pipeline.
 * @returns the verdict: tier, per-check results, and the bundle hash.
 */
export function decide(record: EvidenceRecord): Verdict {
  const checks: readonly CheckResult[] = [
    checkPassesOnHead(record),
    checkTestTouchesCode(record),
    checkFailsOnParent(record),
    checkAssertionReachability(record),
    checkKillCheck(record),
    checkRegression(record),
    checkErrorSuppression(record),
    checkTestWeakening(record),
  ];
  const tier: VerdictTier = worstTier(checks.map((c) => c.tier));
  return {
    tier,
    checks,
    bundleHash: hashRecord(record),
  };
}
