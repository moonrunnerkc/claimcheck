/**
 * The v0.1 claim descriptor.
 *
 * ClaimCheck does not classify claims with NLP. It is told the PR is a fix and
 * takes that as given; inferring the claim type is a later version's job and
 * would reintroduce the model-guessing this tool exists to avoid.
 */

/** The only claim mode in v0.1. */
export type ClaimMode = "fix";

export interface Claim {
  readonly mode: ClaimMode;
  /** Optional free-text the reviewer attached; never parsed for meaning. */
  readonly description?: string;
}

/**
 * Build the fix-mode claim descriptor.
 *
 * @param description - optional human description, recorded but never parsed.
 * @returns a fix-mode claim.
 */
export function fixClaim(description?: string): Claim {
  return description === undefined
    ? { mode: "fix" }
    : { mode: "fix", description };
}
