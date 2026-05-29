import type { QuarantineNote } from "../core/evidence-record.js";
import { runVitest, type TestOutcome } from "../adapters/vitest-run.js";

/**
 * The fallback for the limits of static analysis. For tests Layer 1 cannot
 * fully resolve, run them K times inside the sandbox; a test that is stable
 * under enforced determinism is trusted, and one that still flips is
 * quarantined with that exact reason. Sampling is the safety net here, never
 * the primary mechanism.
 */

const FALLBACK_REASON = "residual nondeterminism under enforcement";

/**
 * Given the per-run outcomes of repeated executions, find the tests whose
 * pass/fail status was not stable across runs. Pure and deterministic.
 *
 * @param runs - one outcome list per execution.
 * @returns the names of tests that flipped between pass and fail.
 */
export function findFlips(runs: readonly (readonly TestOutcome[])[]): string[] {
  const seen = new Map<string, Set<"pass" | "fail">>();
  for (const run of runs) {
    for (const outcome of run) {
      if (outcome.status === "skip") continue;
      const set = seen.get(outcome.name) ?? new Set<"pass" | "fail">();
      set.add(outcome.status);
      seen.set(outcome.name, set);
    }
  }
  const flipped: string[] = [];
  for (const [name, statuses] of seen) {
    if (statuses.has("pass") && statuses.has("fail")) flipped.push(name);
  }
  return flipped.sort((a, b) => a.localeCompare(b));
}

export interface FlakeDetectionOptions {
  readonly worktreeDir: string;
  readonly testFiles: readonly string[];
  readonly configFile: string;
  /** Number of repeated executions; defaults to 2. */
  readonly runs?: number;
}

/**
 * Run the given tests repeatedly under the sandbox and quarantine any that
 * still flip. The pinned sandbox should make most clock- and random-dependent
 * tests stable, so a flip here is genuine residual nondeterminism.
 *
 * @param options - worktree, test files, sandbox config, and run count.
 * @returns quarantine notes for the tests that flipped.
 */
export async function detectResidualFlakes(
  options: FlakeDetectionOptions,
): Promise<QuarantineNote[]> {
  const runs = options.runs ?? 2;
  const outcomes: TestOutcome[][] = [];
  for (let i = 0; i < runs; i++) {
    const result = await runVitest({
      cwd: options.worktreeDir,
      testFiles: options.testFiles,
      configFile: options.configFile,
    });
    outcomes.push([...result.outcomes]);
  }
  return findFlips(outcomes).map((test) => ({ test, reason: FALLBACK_REASON }));
}
