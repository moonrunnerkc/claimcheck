import type { VerdictTier } from "../src/core/verdict.js";

/**
 * Ground-truth labels for corpus cases. Each label fixes the verdict a correct
 * detector must produce, recorded in the case's `expectedTier`.
 */
export type CaseLabel =
  | "honest"
  | "vacuous"
  | "regression"
  | "error-hider"
  | "flaky"
  | "equivalent-mutant";

/** A corpus case as loaded from disk. */
export interface CorpusCase {
  /** Directory name, used as the case id. */
  readonly name: string;
  readonly label: CaseLabel;
  /** The tier a correct detector must return. */
  readonly expectedTier: VerdictTier;
  /** v0.1 is fix mode only. */
  readonly mode: "fix";
  /** Human description of the bug and the claimed fix. */
  readonly description: string;
  /** Absolute path to the case directory holding `parent/` and `head/`. */
  readonly dir: string;
}

/** The metadata file shape stored at `<case>/meta.json`. */
export interface CaseMeta {
  readonly label: CaseLabel;
  readonly expectedTier: VerdictTier;
  readonly mode: "fix";
  readonly description: string;
}

/** One scored row: what the detector returned versus ground truth. */
export interface CaseResult {
  readonly name: string;
  readonly label: CaseLabel;
  readonly expected: VerdictTier;
  readonly actual: VerdictTier;
  /** True when reruns produced an identical verdict tier and bundle hash. */
  readonly deterministic: boolean;
  /** The bundle hash, for the determinism and replay report. */
  readonly bundleHash: string;
}

/** Aggregate metrics over a corpus run. */
export interface CorpusMetrics {
  readonly total: number;
  /** Cases the detector blocked. */
  readonly blocked: number;
  /** Cases the detector blocked that should be blocked. */
  readonly correctBlocks: number;
  /** Cases the detector blocked that should NOT be blocked: the cardinal sin. */
  readonly falseBlocks: readonly string[];
  /** correctBlocks / blocked, or 1 when nothing was blocked. */
  readonly blockPrecision: number;
  /** Cases whose ground truth is block. */
  readonly mechanicalCheats: number;
  /** Mechanical cheats the detector caught. */
  readonly caughtCheats: number;
  /** caughtCheats / mechanicalCheats, or 1 when there are none. */
  readonly mechanicalRecall: number;
  /** Fraction of cases that were deterministic across reruns. */
  readonly determinismRate: number;
  /** Fraction of cases where actual tier equals expected tier. */
  readonly accuracy: number;
}
