import type { EvidenceRecord } from "../core/evidence-record.js";
import type { Verdict, VerdictTier } from "../core/verdict.js";

/**
 * Turn a verdict and its evidence record into per-line annotations, then render
 * them as GitHub Actions workflow commands or a plain list. This is the output
 * layer that lands a finding on the reviewer's diff at the exact line with the
 * reason, instead of leaving it buried in the verdict blob.
 *
 * Each located finding is mapped to the check that produced it, and the
 * annotation's severity is that check's tier in the verdict, so the annotation
 * surface never disagrees with the gate. PASS checks contribute nothing.
 */

export interface Annotation {
  /** Repo-relative file, or "" for a finding with no single file location. */
  readonly file: string;
  /** 1-based line, or 0 when the finding is file-level (no single line). */
  readonly line: number;
  /** Severity, taken from the producing check's tier. Never "pass". */
  readonly tier: Exclude<VerdictTier, "pass">;
  /** The check that produced the finding. */
  readonly check: string;
  /** Human-facing reason. */
  readonly message: string;
}

interface Located {
  readonly check: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/** Pull every located finding out of the record, tagged with its check id. */
function locatedFindings(record: EvidenceRecord): Located[] {
  const out: Located[] = [];

  for (const t of record.taint) {
    if (t.reachesAssertion) continue;
    out.push({
      check: "assertion-reachability",
      file: t.file,
      line: t.line,
      message: `the changed expression "${t.expression}" never reaches an assertion; the test cannot distinguish the fix from its absence`,
    });
  }

  for (const m of record.mutants) {
    if (m.prefilter !== "none" || m.status !== "survived") continue;
    out.push({
      check: "kill-check",
      file: m.file,
      line: m.startLine,
      message: `mutant ${m.id} (${m.mutator} -> ${m.replacement}) survived on a covered changed line; the test does not constrain it`,
    });
  }

  for (const e of record.errorSuppressions) {
    out.push({
      check: "error-suppression",
      file: e.file,
      line: e.line,
      message: `${e.kind}: ${e.snippet}`,
    });
  }

  for (const f of record.staticTail) {
    out.push({ check: "static-tail", file: f.file, line: f.line, message: f.detail });
  }

  for (const v of record.vacuousAssertions) {
    out.push({
      check: "vacuous-assertion",
      file: v.file,
      line: v.line,
      message: `${v.kind}: ${v.detail}`,
    });
  }

  for (const w of record.testWeakenings) {
    out.push({
      check: "test-weakening",
      file: w.file,
      line: w.line,
      message: `${w.kind}: ${w.detail}`,
    });
  }

  for (const name of record.regressions) {
    out.push({
      check: "regression",
      file: "",
      line: 0,
      message: `test regressed: "${name}" passed on the parent and fails on head`,
    });
  }

  return out.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.check.localeCompare(b.check) ||
      a.message.localeCompare(b.message),
  );
}

/**
 * Build the per-line annotations for a verdict. Each located finding inherits
 * its check's tier; findings whose check passed are dropped.
 *
 * @param record - the evidence record the verdict was derived from.
 * @param verdict - the verdict, used for the per-check tier.
 * @returns the annotations, sorted by file then line.
 */
export function buildAnnotations(
  record: EvidenceRecord,
  verdict: Verdict,
): Annotation[] {
  const tierByCheck = new Map<string, VerdictTier>(
    verdict.checks.map((c) => [c.id, c.tier]),
  );
  const annotations: Annotation[] = [];
  for (const f of locatedFindings(record)) {
    const tier = tierByCheck.get(f.check);
    if (tier === undefined || tier === "pass") continue;
    annotations.push({
      file: f.file,
      line: f.line,
      tier,
      check: f.check,
      message: f.message,
    });
  }
  return annotations;
}

/** Escape a workflow-command message body per the Actions command rules. */
function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Escape a workflow-command property value (stricter than the body). */
function escapeProp(value: string): string {
  return escapeData(value).replace(/,/g, "%2C").replace(/:/g, "%3A");
}

/**
 * Render annotations as GitHub Actions workflow commands. A WARN becomes
 * `::warning` and a BLOCK becomes `::error`, so they appear inline on the PR
 * diff. Findings with a file get `file=` and `line=` properties; file-level
 * findings (a regressed test name) are emitted without a location.
 *
 * @param annotations - the annotations to render.
 * @returns the newline-joined command lines (empty string when none).
 */
export function renderGithubAnnotations(
  annotations: readonly Annotation[],
): string {
  const lines = annotations.map((a) => {
    const command = a.tier === "block" ? "error" : "warning";
    const props: string[] = [`title=ClaimCheck ${a.check}`];
    if (a.file.length > 0) {
      props.unshift(`file=${escapeProp(a.file)}`);
      if (a.line > 0) props.splice(1, 0, `line=${a.line}`);
    }
    return `::${command} ${props.join(",")}::${escapeData(a.message)}`;
  });
  return lines.join("\n");
}

/**
 * Render annotations as a human-readable list anchored at file:line, for the
 * CLI and the job summary.
 *
 * @param annotations - the annotations to render.
 * @returns the newline-joined list (empty string when none).
 */
export function renderAnnotationList(
  annotations: readonly Annotation[],
): string {
  return annotations
    .map((a) => {
      const loc = a.file.length > 0 ? `${a.file}:${a.line > 0 ? a.line : "-"}` : "(no location)";
      const label = a.tier === "block" ? "BLOCK" : "WARN";
      return `  [${label}] ${loc} ${a.check}: ${a.message}`;
    })
    .join("\n");
}
