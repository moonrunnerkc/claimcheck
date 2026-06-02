import type { CheckResult, Verdict, VerdictTier } from "./verdict.js";
import { worstTier } from "./verdict.js";
import type {
  AssertionReach,
  EvidenceRecord,
  MutantOutcome,
  OracleConclusion,
  StaticTailFinding,
  VacuousAssertion,
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
 * coverage-reliability. A passing run that recorded no coverage at all is a
 * measurement failure, not a real result: every coverage-scoped check
 * (test-touches-code, kill-check, assertion-reachability) then has nothing real
 * to act on and silently degrades. Surface that explicitly as WARN so an empty
 * coverage map never reads as a clean verdict without a trace, and so the
 * empty-coverage BLOCK escalations know not to fire. PASS when coverage was
 * collected, or when there is nothing to measure (no passing run, no changed
 * lines).
 */
function checkCoverageReliability(record: EvidenceRecord): CheckResult {
  const measurable =
    record.headTestsPass && record.changedRanges.length > 0;
  if (!measurable || record.coverageCollected) {
    return {
      id: "coverage-reliability",
      tier: "pass",
      summary: record.coverageCollected
        ? "Coverage was collected for the run."
        : "Coverage reliability not evaluated: no passing run or no changed lines.",
      evidence: [],
    };
  }
  return {
    id: "coverage-reliability",
    tier: "warn",
    summary:
      "The tests passed but coverage collection recorded nothing; the coverage-scoped checks could not run on real data. Verify the coverage provider works in this environment.",
    evidence: [`headSha=${record.headSha}`, "coverage map empty after a passing run"],
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

/**
 * Covered changed lines where at least two live mutants were generated and
 * every one of them survived. A single survivor could be an equivalent mutant,
 * but a line on which no mutation is ever caught is provably unconstrained by
 * the test, whatever the operators were.
 */
function fullyUnconstrainedLines(record: EvidenceRecord): string[] {
  const byLine = new Map<string, MutantOutcome[]>();
  for (const m of record.mutants) {
    if (!isLiveMutant(m)) continue;
    const key = `${m.file}:${m.startLine}`;
    const group = byLine.get(key) ?? [];
    group.push(m);
    byLine.set(key, group);
  }
  const lines: string[] = [];
  for (const [key, group] of byLine) {
    if (group.length >= 2 && group.every((m) => m.status === "survived")) {
      lines.push(key);
    }
  }
  return lines.sort((a, b) => a.localeCompare(b));
}

/** Does a mutant sit on a line the new tests covered and the PR changed? */
function isOnCoveredChangedLine(
  record: EvidenceRecord,
  m: MutantOutcome,
): boolean {
  return record.coveredChangedLines.some(
    (r) => r.file === m.file && m.startLine >= r.start && m.startLine <= r.end,
  );
}

/**
 * Does the mutation signal positively show the test constrains the changed
 * region: at least one live mutant on a covered changed line was killed and
 * none survived? When this holds, the test demonstrably distinguishes mutations
 * of the change, so a taint "unreachable" is a measurement gap (a value observed
 * through a side effect the value-taint did not follow), not a vacuous test.
 */
function mutationConstrainsChange(record: EvidenceRecord): boolean {
  const live = record.mutants.filter(isLiveMutant);
  const killed = live.filter((m) => m.status === "killed");
  const survived = live.filter((m) => m.status === "survived");
  return killed.length > 0 && survived.length === 0;
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
    // Taint was not collected. This check abstains rather than warns: it and
    // the kill-check are two methods for the same property, and an un-run
    // analytical method must not downgrade an otherwise clean verdict.
    return {
      id: "assertion-reachability",
      tier: "pass",
      summary: "Assertion reachability was not evaluated; relying on the kill-check.",
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
    // Cross-check at the change level, not just the exact line: if the mutation
    // signal shows the change is constrained (a mutant killed, none surviving),
    // taint's "unreachable" is a measurement gap, not a vacuous test, so it is a
    // disagreement (WARN), never a block. Without a contradicting mutation
    // signal, taint stands on its own and blocks.
    if (mutationConstrainsChange(record)) {
      return {
        id: "assertion-reachability",
        tier: "warn",
        summary:
          "Taint found a changed expression unreachable by assertions, but the kill-check shows the change is constrained (a mutant was killed and none survived); the value is likely observed through a side effect taint did not follow.",
        evidence: cleanlyVacuous.map(
          (t) =>
            `${t.file}:${t.line}:${t.column} ${t.expression} taint=unreachable mutation=constrained`,
        ),
      };
    }
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
  const unconstrained = fullyUnconstrainedLines(record);
  if (unconstrained.length > 0) {
    return {
      id: "kill-check",
      tier: "block",
      summary:
        "Every mutant on a covered changed line survived; the test does not constrain that line at all.",
      evidence: unconstrained.map((line) => `${line} fully unconstrained`),
    };
  }
  const weakSurvivors = survivingWeakMutants(record);
  // Escalation: a single surviving operator mutant on its own could be
  // equivalent, so it is normally WARN. But when the new test ALSO passes on the
  // unfixed parent, two independent signals agree that the test does not
  // exercise the claimed fix: it neither fails on the buggy code nor kills a
  // real mutation of the fix line. That combination is a provable lie, so it is
  // BLOCK. It stays narrow on purpose: the mutant must sit on a covered changed
  // line, and fails-on-parent must be "passed", not merely indeterminate.
  const weakOnFixLine = weakSurvivors.filter((m) =>
    isOnCoveredChangedLine(record, m),
  );
  if (weakOnFixLine.length > 0 && record.failsOnParent === "passed") {
    return {
      id: "kill-check",
      tier: "block",
      summary:
        "The new test passes on the unfixed parent and a real mutation of the fix line survives; the test does not constrain the claimed fix.",
      evidence: weakOnFixLine.map(
        (m) =>
          `${m.id} ${m.file}:${m.startLine} ${m.mutator} survived; fails-on-parent=passed`,
      ),
    };
  }
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
 * A coverage-ignore marker is provably block-worthy when an independent signal
 * agrees the marked line is unconstrained: taint observed the changed
 * expression on (or adjacent to) the marker line and found it never reaches an
 * assertion. Suppressing coverage on a line the test cannot observe anyway is
 * the mechanical signature of hiding an untested change.
 */
function coverageIgnoreConfirmedVacuous(
  record: EvidenceRecord,
): StaticTailFinding[] {
  const ignores = record.staticTail.filter((f) => f.kind === "coverage-ignore");
  if (ignores.length === 0 || record.taint.length === 0) return [];
  const unreachable = record.taint.filter((t) => !t.reachesAssertion);
  return ignores.filter((marker) =>
    unreachable.some(
      (t) => t.file === marker.file && Math.abs(t.line - marker.line) <= 1,
    ),
  );
}

/**
 * static-tail. Coverage-ignore markers, type suppression, and config/CI
 * weakening on the changed lines are WARN: mechanical evidence that a tool was
 * told to look away from the change. A coverage-ignore confirmed unconstrained
 * by taint is the provable conjunction and escalates to BLOCK.
 */
function checkStaticTail(record: EvidenceRecord): CheckResult {
  if (record.staticTail.length === 0) {
    return {
      id: "static-tail",
      tier: "pass",
      summary: "No coverage-ignore, type-suppression, or config-weakening on the changed lines.",
      evidence: [],
    };
  }
  const confirmed = coverageIgnoreConfirmedVacuous(record);
  if (confirmed.length > 0) {
    return {
      id: "static-tail",
      tier: "block",
      summary:
        "A coverage-ignore marker sits on a changed line that taint proves no assertion observes; the change is suppressed and untested.",
      evidence: confirmed.map(
        (f) => `${f.file}:${f.line} ${f.kind}: ${f.detail}; taint=unreachable`,
      ),
    };
  }
  return {
    id: "static-tail",
    tier: "warn",
    summary:
      "A changed line carries a coverage-ignore marker, a type-checker suppression, or a weakened coverage/CI gate; verify it is intentional.",
    evidence: record.staticTail.map(
      (f) => `${f.file}:${f.line} ${f.kind}: ${f.detail}`,
    ),
  };
}

/**
 * mock-the-sut is provably block-worthy when the mocked module is the changed
 * file under test and no changed line is executed by any active test: the real
 * fix never runs, so the test cannot constrain it. Both facts come from the run
 * alone (the diff and the observed coverage), so this is a clean BLOCK.
 */
function mockedOutSut(record: EvidenceRecord): VacuousAssertion[] {
  if (record.coveredChangedLines.length > 0) return [];
  // An empty covered set only proves the changed code never ran when coverage
  // was actually collected. If collection failed (a passing run that recorded
  // nothing), the emptiness is a measurement gap, not proof, so it must not
  // block. coverage-reliability surfaces that case as WARN instead.
  if (!record.coverageCollected) return [];
  return record.vacuousAssertions.filter(
    (v) => v.kind === "mock-the-sut" && v.mockedChangedFile.length > 0,
  );
}

/**
 * vacuous-assertion. Mocking the module under test, snapshotting changed output,
 * or asserting a tautology are WARN: each makes a test look like it constrains
 * the change without doing so, but each can be benign. Mocking the changed
 * module while no changed line runs is the provable conjunction and is BLOCK.
 */
function checkVacuousAssertion(record: EvidenceRecord): CheckResult {
  if (record.vacuousAssertions.length === 0) {
    return {
      id: "vacuous-assertion",
      tier: "pass",
      summary: "No mock-the-SUT, snapshot-acceptance, or tautological assertion in the new tests.",
      evidence: [],
    };
  }
  const mockedOut = mockedOutSut(record);
  if (mockedOut.length > 0) {
    return {
      id: "vacuous-assertion",
      tier: "block",
      summary:
        "The test mocks the changed module under test and no changed line runs; the test cannot exercise the claimed fix.",
      evidence: mockedOut.map(
        (v) => `${v.file}:${v.line} mock-the-sut: ${v.detail}; covered-changed-lines=0`,
      ),
    };
  }
  return {
    id: "vacuous-assertion",
    tier: "warn",
    summary:
      "A new test mocks the subject, accepts a snapshot of changed output, or asserts a tautology; confirm it constrains the change.",
    evidence: record.vacuousAssertions.map(
      (v) => `${v.file}:${v.line} ${v.kind}: ${v.detail}`,
    ),
  };
}

/** Test-weakening kinds that are ambiguous, so WARN rather than BLOCK. */
const AMBIGUOUS_WEAKENINGS = new Set(["expected-value-changed", "test-removed"]);

/**
 * test-weakening. Removing or loosening an existing assertion, skipping a test,
 * or marking it todo to fit the changed code is a BLOCK. Two kinds are
 * ambiguous and only WARN: a changed expected value (the behavior may
 * legitimately have changed) and a removed test (a test may have been
 * legitimately deleted, e.g. for removed functionality; that is not the same as
 * stripping an assertion from a test that still exists).
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
    (w) => !AMBIGUOUS_WEAKENINGS.has(w.kind),
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
      "An existing test's expected value changed or a test was removed; confirm the change is intended.",
    evidence: record.testWeakenings.map(
      (w) => `${w.file}:${w.line} ${w.kind}: ${w.detail}`,
    ),
  };
}

/**
 * quarantine. Tests excluded for nondeterminism (an uncontrollable source or a
 * residual flip under enforcement) do not affect the verdict, but their
 * presence is surfaced as WARN so the reviewer knows the verdict rests on a
 * reduced test set, with the exact reason attached.
 */
function checkQuarantine(record: EvidenceRecord): CheckResult {
  if (record.quarantined.length === 0) {
    return {
      id: "quarantine",
      tier: "pass",
      summary: "No test was quarantined for nondeterminism.",
      evidence: [],
    };
  }
  return {
    id: "quarantine",
    tier: "warn",
    summary:
      "A test was quarantined for nondeterminism and excluded from the verdict; the result rests on the remaining tests.",
    evidence: record.quarantined.map((q) => `${q.test}: ${q.reason}`),
  };
}

/**
 * degraded-run. A stage that could not complete (mutation failed to start, an
 * install errored, taint threw) leaves its check running on partial or empty
 * data. Surface that as WARN with the stable reason so a degraded run is never
 * read as a clean PASS, and so the pipeline degrades instead of crashing. It
 * never blocks: a stage that did not run cannot prove a lie.
 */
function checkDegradations(record: EvidenceRecord): CheckResult {
  if (record.degradations.length === 0) {
    return {
      id: "degraded-run",
      tier: "pass",
      summary: "Every analysis stage completed.",
      evidence: [],
    };
  }
  return {
    id: "degraded-run",
    tier: "warn",
    summary:
      "A stage could not complete, so its check ran on partial or empty data; the verdict rests on the stages that did run.",
    evidence: [...record.degradations],
  };
}

/** Map one oracle conclusion to its verdict tier. */
function tierForConclusion(conclusion: OracleConclusion): VerdictTier {
  switch (conclusion) {
    case "violated":
      return "block";
    case "indeterminate":
      return "warn";
    case "satisfied":
      return "pass";
  }
}

/**
 * oracle. Surfaces the oracle layer's findings under the same tiering as every
 * other check. A `violated` finding is a provable lie against an independent
 * source, so it is BLOCK; `indeterminate` is WARN; `satisfied` is PASS.
 *
 * Returns null when no oracle produced a finding, so the check is absent from
 * the verdict and a no-oracle run is byte-for-byte what it was before the layer
 * existed. The check is additive: it only ever raises the tier under
 * block-precedence, never lowers it.
 *
 * @param record - the canonical evidence record.
 * @returns the oracle check, or null when no oracle ran.
 */
function checkOracles(record: EvidenceRecord): CheckResult | null {
  const findings = record.oracleFindings ?? [];
  if (findings.length === 0) return null;
  const tier = worstTier(findings.map((f) => tierForConclusion(f.conclusion)));
  const violated = findings.filter((f) => f.conclusion === "violated");
  const indeterminate = findings.filter(
    (f) => f.conclusion === "indeterminate",
  );
  const summary =
    violated.length > 0
      ? "An imported oracle is violated on head: the change fails a correctness signal the agent did not write."
      : indeterminate.length > 0
        ? "An imported oracle could not be evaluated deterministically; recorded as a warning, not a guess."
        : "Every imported oracle is satisfied on head.";
  const evidence = findings.flatMap((f) => [
    `${f.oracle}: ${f.conclusion} - ${f.summary}`,
    ...f.evidence.map((e) => `${f.oracle}: ${e}`),
  ]);
  return { id: "oracle", tier, summary, evidence };
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
  const battery: CheckResult[] = [
    checkPassesOnHead(record),
    checkTestTouchesCode(record),
    checkCoverageReliability(record),
    checkFailsOnParent(record),
    checkAssertionReachability(record),
    checkKillCheck(record),
    checkRegression(record),
    checkErrorSuppression(record),
    checkStaticTail(record),
    checkVacuousAssertion(record),
    checkTestWeakening(record),
    checkQuarantine(record),
    checkDegradations(record),
  ];
  // The oracle check is appended only when an oracle produced a finding, so a
  // run with no oracle yields exactly the battery above, unchanged.
  const oracle = checkOracles(record);
  const checks: readonly CheckResult[] = oracle
    ? [...battery, oracle]
    : battery;
  const tier: VerdictTier = worstTier(checks.map((c) => c.tier));
  return {
    tier,
    checks,
    bundleHash: hashRecord(record),
  };
}
