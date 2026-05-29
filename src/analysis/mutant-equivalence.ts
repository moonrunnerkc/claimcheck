import type { MutantOutcome } from "../core/evidence-record.js";

/**
 * Analytical mutant pre-filtering. Before the kill-check carries a mutant's
 * survival as signal, classify the ones whose survival means nothing, by
 * analysis rather than by running them:
 *
 * - unreachable: the covering test provably does not reach the mutant in the
 *   observed run (Stryker reports it as no-coverage), so "survived" here is
 *   "survived because unreached," never "survived because the test is weak."
 * - trivially-equivalent: the mutated text normalizes back to the original, so
 *   no test could ever kill it.
 *
 * It does not attempt general equivalent-mutant detection, which is
 * undecidable; it handles the tractable subset that causes most of the noise.
 * Subsumption pruning is deliberately omitted in v0.1: it shrinks runtime, not
 * correctness, and the diff-scoped mutant set is already small.
 */

/** Convert a 1-based line/column to a 0-based string offset. */
function offsetOf(content: string, line: number, column: number): number {
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line && offset < content.length) {
    const nl = content.indexOf("\n", offset);
    if (nl === -1) return content.length;
    offset = nl + 1;
    currentLine++;
  }
  return offset + (column - 1);
}

/** Collapse insignificant whitespace so equal code compares equal. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Read the original source text a mutant replaced, or null if the location is
 * out of bounds.
 */
function originalText(content: string, m: MutantOutcome): string | null {
  const start = offsetOf(content, m.startLine, m.startColumn);
  const end = offsetOf(content, m.endLine, m.endColumn);
  if (start < 0 || end > content.length || end < start) return null;
  return content.slice(start, end);
}

/**
 * Classify each mutant's pre-filter category from its status and the source it
 * mutated. Pure: same inputs, same classification.
 *
 * @param mutants - mutant outcomes from the runner (prefilter "none").
 * @param sourceByFile - head source contents keyed by repo-relative path.
 * @returns the mutants with their pre-filter category assigned.
 */
export function classifyMutants(
  mutants: readonly MutantOutcome[],
  sourceByFile: ReadonlyMap<string, string>,
): MutantOutcome[] {
  return mutants.map((m) => {
    if (m.status === "no-coverage") {
      return { ...m, prefilter: "unreachable" };
    }
    const content = sourceByFile.get(m.file);
    if (content) {
      const original = originalText(content, m);
      if (original !== null && normalize(original) === normalize(m.replacement)) {
        return { ...m, prefilter: "trivially-equivalent" };
      }
    }
    return m;
  });
}
