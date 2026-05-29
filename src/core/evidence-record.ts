import { createHash } from "node:crypto";

/**
 * The canonical evidence record and the helpers that keep it canonical.
 *
 * The verdict is a pure function of this record and nothing else. To make the
 * verdict and the bundle hash deterministic, every collection here is sorted
 * by a stable key before serialization, and serialization uses sorted object
 * keys. Two runs that observe the same facts produce byte-identical JSON and
 * therefore the same hash.
 */

/** A half-open-free, 1-based inclusive line range within a single file. */
export interface LineRange {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The fate of one mutant, including the pre-filter classification that
 * explains whether its survival carries signal.
 */
export type MutantStatus =
  | "killed"
  | "survived"
  | "no-coverage"
  | "timeout"
  | "runtime-error"
  | "compile-error";

/** Why a mutant was excluded from the kill-check before it ran, if at all. */
export type MutantPrefilter =
  | "none"
  | "trivially-equivalent"
  | "unreachable"
  | "subsumed";

export interface MutantOutcome {
  /** Stable id, derived from location and replacement so it is reproducible. */
  readonly id: string;
  readonly file: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  /** Stryker mutator name, for example "ConditionalExpression". */
  readonly mutator: string;
  /** Source text the mutant replaced the original with. */
  readonly replacement: string;
  readonly status: MutantStatus;
  readonly prefilter: MutantPrefilter;
  /**
   * True only for the strongest signal: the mutant reduces a covered changed
   * line to a no-op or inverts its condition, so survival cannot be an
   * equivalent-mutant artifact.
   */
  readonly noopOrInversion: boolean;
}

/**
 * Whether a changed expression's value reaches an assertion in the observed
 * sandbox run, computed by def-use taint.
 */
export interface AssertionReach {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** Source text of the tracked expression, for the human-facing evidence. */
  readonly expression: string;
  readonly reachesAssertion: boolean;
  /** The def-use chain from the changed value to the assertion, if reached. */
  readonly chain: readonly string[];
}

/** Kinds of nondeterminism the static scan recognizes. */
export type NdKind =
  | "unseeded-random"
  | "wall-clock"
  | "high-res-timer"
  | "timer-scheduling"
  | "network"
  | "filesystem-mutable"
  | "environment"
  | "unordered-iteration";

export interface NdSource {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly kind: NdKind;
  /** The source snippet that triggered the flag. */
  readonly snippet: string;
  /** True when the sandbox can pin this source; false means quarantine. */
  readonly controlled: boolean;
}

export interface QuarantineNote {
  readonly test: string;
  readonly reason: string;
}

/**
 * The single source of truth for the verdict. Normalized and sorted so equal
 * facts always serialize identically. Nothing outside this record may
 * influence {@link import("./decision.js").decide}.
 */
export interface EvidenceRecord {
  readonly baseSha: string;
  readonly headSha: string;
  readonly changedRanges: readonly LineRange[];
  /** True when the new/modified tests pass against head (passes-on-head). */
  readonly headTestsPass: boolean;
  /**
   * Tri-state result of running the new tests against the parent source with
   * only the test-file diff applied. "failed" is the healthy case (the test
   * caught the bug); "passed" means the test did not test the bug;
   * "indeterminate" means it could not run on parent (new symbols).
   */
  readonly failsOnParent: "failed" | "passed" | "indeterminate";
  /** Changed lines that the new tests actually execute (coverage ∩ diff). */
  readonly coveredChangedLines: readonly LineRange[];
  readonly mutants: readonly MutantOutcome[];
  readonly taint: readonly AssertionReach[];
  readonly nondeterminism: readonly NdSource[];
  readonly regressions: readonly string[];
  readonly errorSuppressions: readonly ErrorSuppression[];
  readonly testWeakenings: readonly TestWeakening[];
  readonly quarantined: readonly QuarantineNote[];
  readonly toolVersion: string;
}

/** A swallowed-error pattern found on a changed line. */
export interface ErrorSuppression {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly kind: "empty-catch" | "catch-ignores-error" | "success-on-error-path";
  readonly snippet: string;
}

/** An existing test whose assertion was loosened by the diff. */
export interface TestWeakening {
  readonly file: string;
  readonly line: number;
  readonly kind:
    | "assertion-removed"
    | "assertion-loosened"
    | "expected-value-changed"
    | "test-skipped"
    | "test-todo";
  readonly detail: string;
}

/**
 * Compare two line ranges for a total, stable ordering.
 */
function compareRange(a: LineRange, b: LineRange): number {
  return a.file.localeCompare(b.file) || a.start - b.start || a.end - b.end;
}

/**
 * Produce a canonical, deeply-sorted copy of an evidence record.
 *
 * Sorting every collection by a stable key is what makes the downstream hash a
 * pure function of the observed facts rather than of observation order.
 *
 * @param record - the record assembled by the pipeline.
 * @returns a new record with every collection sorted deterministically.
 */
export function canonicalizeRecord(record: EvidenceRecord): EvidenceRecord {
  return {
    baseSha: record.baseSha,
    headSha: record.headSha,
    headTestsPass: record.headTestsPass,
    failsOnParent: record.failsOnParent,
    toolVersion: record.toolVersion,
    changedRanges: [...record.changedRanges].sort(compareRange),
    coveredChangedLines: [...record.coveredChangedLines].sort(compareRange),
    mutants: [...record.mutants].sort((a, b) => a.id.localeCompare(b.id)),
    taint: [...record.taint].sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
    ),
    nondeterminism: [...record.nondeterminism].sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.column - b.column ||
        a.kind.localeCompare(b.kind),
    ),
    regressions: [...record.regressions].sort((a, b) => a.localeCompare(b)),
    errorSuppressions: [...record.errorSuppressions].sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    ),
    testWeakenings: [...record.testWeakenings].sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    ),
    quarantined: [...record.quarantined].sort(
      (a, b) => a.test.localeCompare(b.test) || a.reason.localeCompare(b.reason),
    ),
  };
}

/**
 * Serialize any JSON-safe value with object keys sorted recursively, so that
 * structurally equal values always produce the same string.
 *
 * @param value - a JSON-serializable value.
 * @returns canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, sortKeys(val)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Content address of an evidence record: the SHA-256 of its canonical JSON.
 * Canonicalizes first so insertion order never affects the hash.
 *
 * @param record - the evidence record.
 * @returns a lowercase hex sha256 prefixed with "sha256:".
 */
export function hashRecord(record: EvidenceRecord): string {
  const canonical = canonicalizeRecord(record);
  const json = canonicalJson(canonical);
  const digest = createHash("sha256").update(json, "utf8").digest("hex");
  return `sha256:${digest}`;
}
