/**
 * Core verdict and check-result types shared across the whole pipeline.
 *
 * These are the load-bearing contracts. The scope boundary lives in the
 * semantics of the tiers: a verdict speaks only to whether the PR's tests
 * constrain the claimed change, never to abstract correctness.
 */

/**
 * The three verdict tiers, in increasing severity.
 *
 * - `pass`: every check passed; the tests demonstrably constrain the change.
 * - `warn`: a signal is present but ambiguous, or a check could not run
 *   deterministically. Annotates the PR; does not fail the gate.
 * - `block`: a check produced an unambiguous failure provable from the run
 *   alone. Reserved for a provable lie. False blocks are the cardinal sin.
 */
export type VerdictTier = "pass" | "warn" | "block";

/**
 * The outcome of a single check in the battery.
 */
export interface CheckResult {
  /** Stable check identifier, for example "kill-check". */
  readonly id: string;
  /** The tier this check contributes to the verdict. */
  readonly tier: VerdictTier;
  /** One line stating what happened, written for a human reviewer. */
  readonly summary: string;
  /**
   * Concrete, replayable evidence: SHAs, mutant ids, test names, taint chains.
   * Sorted by the producing check so equal facts serialize identically.
   */
  readonly evidence: readonly string[];
}

/**
 * The final verdict. `tier` is the worst tier across all checks under
 * block-precedence, computed by {@link decide}. `bundleHash` is the content
 * address of the evidence record the verdict was derived from.
 */
export interface Verdict {
  readonly tier: VerdictTier;
  readonly checks: readonly CheckResult[];
  readonly bundleHash: string;
}

/** Severity ordering used for block-precedence reduction. Higher wins. */
const TIER_RANK: Readonly<Record<VerdictTier, number>> = {
  pass: 0,
  warn: 1,
  block: 2,
};

/**
 * Reduce a set of tiers to the worst one under block-precedence.
 *
 * @param tiers - the tiers contributed by individual checks.
 * @returns the highest-severity tier; `pass` when the set is empty.
 */
export function worstTier(tiers: readonly VerdictTier[]): VerdictTier {
  let worst: VerdictTier = "pass";
  for (const tier of tiers) {
    if (TIER_RANK[tier] > TIER_RANK[worst]) {
      worst = tier;
    }
  }
  return worst;
}

/**
 * Map a verdict tier to a process exit code for the CLI and the Action.
 *
 * @param tier - the final verdict tier.
 * @returns 0 for pass, 1 for warn, 2 for block.
 */
export function exitCodeForTier(tier: VerdictTier): number {
  switch (tier) {
    case "pass":
      return 0;
    case "warn":
      return 1;
    case "block":
      return 2;
  }
}
