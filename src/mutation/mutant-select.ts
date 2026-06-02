import { createHash } from "node:crypto";
import type { LineRange } from "../core/evidence-record.js";

/**
 * Mutant selection and classification. ClaimCheck does not reimplement a
 * mutation engine; it tells Stryker which lines to mutate and then decides
 * which surviving mutants carry a block-worthy signal.
 *
 * The block-worthy class is deliberately narrow: only mutants that reduce a
 * changed line to a no-op or neutralize its condition. A surviving operator
 * swap (arithmetic, relational boundary, logical) might be an equivalent
 * mutant, so it is a weak signal and only ever warns. This asymmetry is what
 * keeps BLOCK precision at 1.0: ClaimCheck never blocks on a mutant it cannot
 * prove is meaningful.
 */

/**
 * Stryker mutators whose surviving mutants are block-worthy because they cannot
 * be equivalent when they land on the line the PR claims is the fix: emptying a
 * block is a pure no-op, and forcing a condition constant or flipping a boolean
 * neutralizes the branch the fix introduced.
 */
const BLOCK_WORTHY_MUTATORS: ReadonlySet<string> = new Set([
  "BlockStatement",
  "ConditionalExpression",
  "BooleanLiteral",
]);

/**
 * Turn covered changed line ranges into Stryker `--mutate` range specifiers.
 * Restricting mutation to these ranges is what bounds the runtime; it is the
 * core of avoiding a whole-file `--since` re-mutation.
 *
 * @param coveredChangedLines - the changed lines the new tests execute.
 * @returns one `path:start-end` specifier per range.
 */
export function toMutateRanges(
  coveredChangedLines: readonly LineRange[],
): string[] {
  return coveredChangedLines.map((r) => `${r.file}:${r.start}-${r.end}`);
}

/** Upper bound on changed source lines the per-hunk fallback will mutate. */
export const FALLBACK_MUTATE_LINE_CAP = 200;

/** Total inclusive lines across a set of ranges. */
function lineSpan(ranges: readonly LineRange[]): number {
  return ranges.reduce((n, r) => n + (r.end - r.start + 1), 0);
}

/**
 * The outcome of choosing what to mutate: the ranges, and whether they came
 * from the per-hunk fallback rather than the covered intersection.
 */
export interface MutateSelection {
  readonly ranges: string[];
  /** True when coverage did not map onto the change and the hunks were used. */
  readonly fallback: boolean;
  /** A stable reason when the fallback was skipped (too large), else null. */
  readonly skipped: string | null;
}

/**
 * Choose Stryker mutate ranges. Normally the covered changed lines: tight and
 * cheap. When coverage was collected but none of it mapped onto the changed
 * lines (line-number skew on transpiled or .tsx sources, re-exports), fall back
 * to mutating the changed hunks directly and let Stryker's per-test coverage
 * decide kill vs survive; a genuinely uncovered mutant comes back no-coverage
 * and never blocks. The fallback is bounded so a large diff cannot blow up CI.
 *
 * @param coveredChangedLines - changed lines the new tests executed.
 * @param changedRanges - all changed source line ranges from the diff.
 * @param coverageCollected - whether any coverage was recorded at all.
 * @returns the mutate ranges and whether the fallback was used or skipped.
 */
export function selectMutateRanges(
  coveredChangedLines: readonly LineRange[],
  changedRanges: readonly LineRange[],
  coverageCollected: boolean,
): MutateSelection {
  const covered = toMutateRanges(coveredChangedLines);
  if (covered.length > 0) {
    return { ranges: covered, fallback: false, skipped: null };
  }
  if (!coverageCollected || changedRanges.length === 0) {
    return { ranges: [], fallback: false, skipped: null };
  }
  if (lineSpan(changedRanges) > FALLBACK_MUTATE_LINE_CAP) {
    return {
      ranges: [],
      fallback: false,
      skipped:
        "coverage did not map onto the changed lines and the diff is too large to mutate the hunks directly",
    };
  }
  return { ranges: toMutateRanges(changedRanges), fallback: true, skipped: null };
}

/**
 * Decide whether a mutant is block-worthy: a no-op or condition inversion that
 * cannot be an equivalent-mutant artifact.
 *
 * @param mutatorName - the Stryker mutator that produced the mutant.
 * @returns true when survival of this mutant is a provable lie, not a maybe.
 */
export function isNoopOrInversion(mutatorName: string): boolean {
  return BLOCK_WORTHY_MUTATORS.has(mutatorName);
}

/**
 * Compute a stable, reproducible id for a mutant from its location and
 * replacement, so the same mutant gets the same id across runs and the evidence
 * record hashes deterministically.
 *
 * @param file - repo-relative file path.
 * @param startLine - 1-based start line.
 * @param startColumn - 1-based start column.
 * @param endLine - 1-based end line.
 * @param endColumn - 1-based end column.
 * @param mutator - the Stryker mutator name.
 * @param replacement - the replacement source text.
 * @returns a short, stable hex id prefixed with "mut-".
 */
export function mutantId(
  file: string,
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
  mutator: string,
  replacement: string,
): string {
  const key = `${file}|${startLine}:${startColumn}-${endLine}:${endColumn}|${mutator}|${replacement}`;
  return `mut-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}
