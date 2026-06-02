import type { Verdict, VerdictTier } from "../core/verdict.js";

/**
 * Human-facing rendering of a verdict. Every rendering carries the scope
 * statement so the tool never reads as claiming more than it proves: it shows
 * whether the tests constrain the change, not whether the change is correct.
 */

const TIER_LABEL: Readonly<Record<VerdictTier, string>> = {
  pass: "PASS",
  warn: "WARN",
  block: "BLOCK",
};

const SCOPE_NOTE =
  "ClaimCheck proves whether the PR's tests constrain the change it claims to make. " +
  "It does not prove the change is correct: a plausible-but-wrong fix with no failing " +
  "invariant and no surviving mutant on the changed lines will pass, and that is by design.";

/**
 * Is this verdict really a "nothing to evaluate" case rather than a real
 * signal? True when there is no source change, or no covered changed line for
 * the decisive checks to act on, and nothing blocked. This lets a WARN that
 * means "not applicable" read differently from one that means "evaluated, with
 * caveats".
 */
function isNotApplicable(verdict: Verdict): boolean {
  if (verdict.tier === "block") return false;
  const touches = verdict.checks.find((c) => c.id === "test-touches-code");
  if (!touches || touches.tier !== "warn") return false;
  return /changed no source lines|no changed source line is executed/i.test(
    touches.summary,
  );
}

/**
 * One human-facing line that collapses the tiered verdict into a plain
 * conclusion: a provable gap (BLOCK), a constrained change (PASS), a change the
 * tool does not apply to (not applicable), or an evaluated-but-inconclusive
 * result (WARN). This is the line a reviewer reads first.
 *
 * @param verdict - the verdict to summarize.
 * @returns the conclusion line.
 */
export function conclusionLine(verdict: Verdict): string {
  if (verdict.tier === "block") {
    return "BLOCK: the PR's tests do not constrain its claimed change (a gap provable from the run alone).";
  }
  if (verdict.tier === "pass") {
    return "PASS: the PR's tests constrain the claimed change.";
  }
  if (isNotApplicable(verdict)) {
    return "NOT APPLICABLE: the diff has no source change with tests for ClaimCheck to evaluate.";
  }
  return "INCONCLUSIVE: ClaimCheck could not fully evaluate this change; see the WARN items below.";
}

/**
 * Render a verdict as plain text: the conclusion line, the tier, each check
 * with its tier and summary, and the bundle hash, followed by the scope note.
 *
 * @param verdict - the verdict to render.
 * @returns the multi-line report.
 */
export function formatVerdict(verdict: Verdict): string {
  const lines = [
    conclusionLine(verdict),
    "",
    `ClaimCheck verdict: ${TIER_LABEL[verdict.tier]}`,
    "",
  ];
  for (const check of verdict.checks) {
    lines.push(`  [${TIER_LABEL[check.tier]}] ${check.id}: ${check.summary}`);
    for (const ev of check.evidence) lines.push(`        - ${ev}`);
  }
  lines.push("", `bundle: ${verdict.bundleHash}`, "", SCOPE_NOTE);
  return lines.join("\n");
}
