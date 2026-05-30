import type { Oracle } from "./oracle.js";

/**
 * The oracle seam admits more than one independent correctness source. Three
 * are registered here behind the seam as documented no-ops: each is a real
 * {@link Oracle} that cleanly returns null ("not configured") and contributes
 * nothing to the verdict. They are seams, not half-wired implementations, so the
 * shape they will take is fixed but no detection logic exists yet.
 *
 * The load-bearing truth they share with the issue-repro oracle: importing an
 * oracle moves the trust boundary, it does not delete it. Detection completeness
 * is bounded by oracle completeness. A wrong fix that happens to satisfy every
 * imported relation still passes; that is not a gap to be closed by guessing, it
 * is the permanent shape of the problem.
 */

/**
 * metamorphic-relation oracle (future). Asserts a known input/output relation
 * the change must preserve (for example, sort(reverse(x)) == sort(x), or that an
 * idempotent operation applied twice equals applying it once). The relation is
 * the trusted source; it is supplied, never inferred, because inferring a
 * metamorphic relation from the PR is the model-guessing this tool avoids.
 */
export function metamorphicRelationOracle(): Oracle {
  return {
    id: "metamorphic-relation",
    run() {
      return Promise.resolve(null);
    },
  };
}

/**
 * differential-on-unchanged-inputs oracle (future). Runs inputs the change
 * claims not to affect against both parent and head and asserts identical
 * output. A fix that silently alters behavior the PR said it left alone is the
 * catch. The set of unchanged inputs is the trusted source and must be supplied.
 */
export function differentialUnchangedOracle(): Oracle {
  return {
    id: "differential-unchanged",
    run() {
      return Promise.resolve(null);
    },
  };
}

/**
 * property/contract oracle (future). Checks a stated invariant or type/contract
 * the change must uphold across generated or supplied inputs (for example, a
 * parser round-trips, a balance never goes negative). The property is the
 * trusted source; it is declared, not discovered from the diff.
 */
export function propertyContractOracle(): Oracle {
  return {
    id: "property-contract",
    run() {
      return Promise.resolve(null);
    },
  };
}

/**
 * The oracles registered behind the seam but not yet implemented. They are
 * inert: running them is safe and adds nothing, so wiring them changes no
 * verdict. The issue-repro oracle is constructed separately because it needs a
 * repro input.
 */
export const FUTURE_ORACLES: readonly Oracle[] = [
  metamorphicRelationOracle(),
  differentialUnchangedOracle(),
  propertyContractOracle(),
];
