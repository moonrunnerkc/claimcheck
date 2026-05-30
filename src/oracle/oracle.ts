import type { LineRange, OracleFinding } from "../core/evidence-record.js";

/**
 * The oracle seam. An oracle imports a correctness signal from a source that is
 * not the agent under test (a human-written reproduction, a metamorphic
 * relation, a documented contract) and reports whether the change satisfies it.
 *
 * The whole point of an oracle is to move the trust boundary: the existing
 * battery proves the PR's own tests constrain the change, but it trusts the
 * agent to have written tests that assert the right thing. An oracle replaces
 * that trust for the slice it covers with trust in an independent source. It
 * never deletes the boundary; detection stays bounded by oracle completeness.
 *
 * The same discipline as every other check applies without exception: an oracle
 * that cannot evaluate its signal deterministically returns an `indeterminate`
 * finding (WARN), never a guess; an oracle with nothing to evaluate returns
 * `null` and contributes nothing, leaving the verdict byte-for-byte unchanged.
 * The layer is purely additive: a finding can tighten a verdict (to WARN or
 * BLOCK) but can never weaken or replace an existing check.
 */

/** Pull-request provenance an oracle may use to locate its external source. */
export interface PrMetadata {
  readonly owner: string | null;
  readonly repo: string | null;
  /** The linked issue number, when the PR references one. */
  readonly issueNumber: number | null;
}

/**
 * A reproduction handed to the oracle. Either an already-extracted runnable
 * repro, or raw issue text the oracle must extract from. The networked step
 * that fetches issue text lives in the live tier; the deterministic core only
 * ever sees one of these as input, so the hermetic suite never hits the network.
 */
export type ReproInput =
  | { readonly kind: "repro-test"; readonly code: string }
  | { readonly kind: "issue-text"; readonly text: string };

/**
 * Everything an oracle needs to run, assembled by the pipeline after the
 * worktrees and the deterministic sandbox are in place. Both worktrees carry
 * the same sandbox config filename, so one `configFile` serves both sides.
 */
export interface OracleContext {
  readonly parentDir: string;
  readonly headDir: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly changedRanges: readonly LineRange[];
  /** The sandbox vitest config filename, relative to each worktree. */
  readonly configFile: string;
  readonly prMetadata: PrMetadata;
  /** The repro to evaluate, or null when none was supplied. */
  readonly reproInput: ReproInput | null;
}

/**
 * An oracle. Deterministic by contract: the same context must produce the same
 * finding. Returns `null` to contribute nothing (not configured, no input).
 */
export interface Oracle {
  /** Stable id recorded on every finding, for example "issue-repro". */
  readonly id: string;
  /**
   * Evaluate the imported signal against the change.
   *
   * @param ctx - the run context (worktrees, changed ranges, PR metadata, repro).
   * @returns a finding to record, or null to contribute nothing to the verdict.
   */
  run(ctx: OracleContext): Promise<OracleFinding | null>;
}

/**
 * Run a set of oracles in order and collect their findings, dropping the nulls.
 * Order is fixed by the caller; canonicalization sorts the result, so the
 * recorded set is independent of execution order.
 *
 * @param oracles - the configured oracles.
 * @param ctx - the shared run context.
 * @returns the findings that ran and produced a result.
 */
export async function runOracles(
  oracles: readonly Oracle[],
  ctx: OracleContext,
): Promise<OracleFinding[]> {
  const findings: OracleFinding[] = [];
  for (const oracle of oracles) {
    const finding = await oracle.run(ctx);
    if (finding) findings.push(finding);
  }
  return findings;
}
