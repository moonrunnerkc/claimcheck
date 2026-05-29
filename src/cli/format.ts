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
 * Render a verdict as plain text: the tier, each check with its tier and
 * summary, and the bundle hash, followed by the scope note.
 *
 * @param verdict - the verdict to render.
 * @returns the multi-line report.
 */
export function formatVerdict(verdict: Verdict): string {
  const lines = [`ClaimCheck verdict: ${TIER_LABEL[verdict.tier]}`, ""];
  for (const check of verdict.checks) {
    lines.push(`  [${TIER_LABEL[check.tier]}] ${check.id}: ${check.summary}`);
    for (const ev of check.evidence) lines.push(`        - ${ev}`);
  }
  lines.push("", `bundle: ${verdict.bundleHash}`, "", SCOPE_NOTE);
  return lines.join("\n");
}
