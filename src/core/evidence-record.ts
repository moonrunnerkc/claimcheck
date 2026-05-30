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
 * The conclusion an oracle reached by running an independent correctness signal
 * against the change. The trust comes from the source (a human-written
 * reproduction, a metamorphic relation, a contract), not from the agent.
 *
 * - `satisfied`: the imported signal holds on head. Contributes PASS.
 * - `violated`: the imported signal fails on head. The change does not satisfy
 *   a source the agent did not write, so it is a provable lie: BLOCK.
 * - `indeterminate`: the signal was present but could not be evaluated
 *   deterministically (not machine-extractable, nondeterministic, or it failed
 *   to execute). WARN, never a guess.
 *
 * An oracle that is not configured or has no input contributes no finding at
 * all, so the record stays byte-for-byte identical to a run with no oracle.
 */
export type OracleConclusion = "satisfied" | "violated" | "indeterminate";

/**
 * One oracle's recorded result. The decision layer maps {@link OracleConclusion}
 * to a verdict tier; the oracle records only the facts it observed by running.
 */
export interface OracleFinding {
  /** Stable oracle id, for example "issue-repro". */
  readonly oracle: string;
  readonly conclusion: OracleConclusion;
  /** One line stating what the oracle ran and what it found, for a human. */
  readonly summary: string;
  /** Concrete, replayable evidence: the repro source, the observed outcomes. */
  readonly evidence: readonly string[];
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
  /**
   * Soft-tail static findings: coverage-ignore markers and type suppression on
   * the changed lines, plus parent-vs-head config weakening (lowered coverage
   * thresholds, narrowed CI matrices). All deterministic WARN signals, some
   * promotable to BLOCK by a provable conjunction in the decision layer.
   */
  readonly staticTail: readonly StaticTailFinding[];
  /**
   * Test-side patterns that make a test look like it constrains the change when
   * it does not: mocking the very module under test, accepting changed output
   * into a snapshot, or asserting a tautology.
   */
  readonly vacuousAssertions: readonly VacuousAssertion[];
  readonly quarantined: readonly QuarantineNote[];
  /**
   * Findings from the oracle layer: correctness signal imported from a source
   * that is not the agent. Optional and additive. The field is omitted entirely
   * when no oracle produced a finding, so a run with no oracle configured (the
   * offline corpus, every legacy run) serializes byte-for-byte as it did before
   * the layer existed, and the bundle hash is unchanged.
   */
  readonly oracleFindings?: readonly OracleFinding[];
  readonly toolVersion: string;
}

/** Categories of soft-tail static cheat detectable from the diff alone. */
export type StaticTailKind =
  | "coverage-ignore"
  | "type-suppression"
  | "type-widening"
  | "dropped-async"
  | "tolerance-loosened"
  | "coverage-threshold-lowered"
  | "ci-matrix-narrowed";

/**
 * One soft-tail finding. `line` is 1-based; it is 0 for a config-level finding
 * that has no single meaningful source line.
 */
export interface StaticTailFinding {
  readonly file: string;
  readonly line: number;
  readonly kind: StaticTailKind;
  /** Human-facing description of what was found and where. */
  readonly detail: string;
}

/** Categories of test-side vacuity detectable by AST. */
export type VacuousKind = "mock-the-sut" | "snapshot-acceptance" | "tautology";

/** A test-side pattern that weakens or voids the test's constraint on the change. */
export interface VacuousAssertion {
  readonly file: string;
  readonly line: number;
  readonly kind: VacuousKind;
  readonly detail: string;
  /**
   * For mock-the-sut, the changed source file the test replaced with a mock, if
   * the mocked specifier resolves to one. Empty otherwise. Drives the
   * conjunction escalation in the decision layer.
   */
  readonly mockedChangedFile: string;
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
  // The oracle findings field is included only when it carries findings. An
  // omitted key and a `[]` value serialize differently, so a run with no oracle
  // must omit the key to stay byte-identical to a pre-oracle record.
  const oracle =
    record.oracleFindings && record.oracleFindings.length > 0
      ? {
          oracleFindings: [...record.oracleFindings].sort((a, b) =>
            a.oracle.localeCompare(b.oracle) ||
            a.conclusion.localeCompare(b.conclusion) ||
            a.summary.localeCompare(b.summary),
          ),
        }
      : {};
  return {
    baseSha: record.baseSha,
    headSha: record.headSha,
    headTestsPass: record.headTestsPass,
    failsOnParent: record.failsOnParent,
    toolVersion: record.toolVersion,
    ...oracle,
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
    staticTail: [...record.staticTail].sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.kind.localeCompare(b.kind) ||
        a.detail.localeCompare(b.detail),
    ),
    vacuousAssertions: [...record.vacuousAssertions].sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.kind.localeCompare(b.kind) ||
        a.detail.localeCompare(b.detail),
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
