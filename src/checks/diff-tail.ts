import ts from "typescript";
import type { StaticTailFinding } from "../core/evidence-record.js";

/**
 * Parent-vs-head soft-tail detection: cheats that are only visible by comparing
 * the two sides of the diff rather than by reading the head alone. Four
 * deterministic comparisons, all WARN signals:
 *
 * - coverage-threshold-lowered: a numeric coverage gate in a test/coverage
 *   config was reduced, so the suite is allowed to cover less than before.
 * - ci-matrix-narrowed: a CI workflow dropped matrix entries, so the change is
 *   exercised on fewer runtimes/OSes than the parent was.
 * - dropped-async: an `await` was removed, turning a synchronized call into a
 *   fire-and-forget whose rejection no longer surfaces.
 * - tolerance-loosened: a `toBeCloseTo` precision was reduced, widening the slop
 *   a numeric assertion will accept.
 *
 * None of these block on their own; they annotate the reviewer's diff with a
 * mechanical reason, the same way the error-suppression scan does.
 */

/** Coverage/test config files whose numeric thresholds are worth comparing. */
const COVERAGE_CONFIG =
  /(^|\/)(package\.json|\.nycrc(\.json)?|nyc\.config\.[cm]?js|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|stryker\.conf(ig)?\.(json|[cm]?js))$/;

/** GitHub Actions workflow files. */
const WORKFLOW = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;

const TS_LIKE = /\.[cm]?[jt]sx?$/;
const TEST_LIKE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Threshold keys whose decrease means a weaker coverage gate. */
const THRESHOLD_KEY =
  /\b(lines|branches|functions|statements|break)\b["']?\s*[:=]\s*(\d+(?:\.\d+)?)/gi;

/** Highest value seen for each threshold key, the strictest the config sets. */
function thresholdMaxima(text: string): Map<string, number> {
  const maxima = new Map<string, number>();
  for (const match of text.matchAll(THRESHOLD_KEY)) {
    const key = match[1]!.toLowerCase();
    const value = Number(match[2]);
    const prev = maxima.get(key);
    if (prev === undefined || value > prev) maxima.set(key, value);
  }
  return maxima;
}

/** Detect a lowered coverage threshold in a config file. */
export function scanCoverageThreshold(
  path: string,
  parentContent: string,
  headContent: string,
): StaticTailFinding[] {
  const before = thresholdMaxima(parentContent);
  const after = thresholdMaxima(headContent);
  const findings: StaticTailFinding[] = [];
  for (const [key, prev] of before) {
    const next = after.get(key);
    if (next !== undefined && next < prev) {
      findings.push({
        file: path,
        line: 0,
        kind: "coverage-threshold-lowered",
        detail: `coverage threshold "${key}" lowered from ${prev} to ${next}`,
      });
    }
  }
  return findings;
}

/**
 * Count the matrix entries in a workflow file. A matrix value is either a block
 * list (`- entry` lines indented under a key) or an inline array (`key: [a, b]`)
 * sitting under a `matrix:` mapping. Indentation bounds the matrix block.
 */
function matrixEntryCount(text: string): number {
  const lines = text.split("\n");
  let count = 0;
  let matrixIndent = -1;
  for (const raw of lines) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (matrixIndent >= 0 && indent <= matrixIndent) {
      matrixIndent = -1; // left the matrix block
    }
    if (/^\s*matrix\s*:/.test(raw)) {
      matrixIndent = indent;
      // An inline matrix on the same line, for example matrix: {a: [1,2]}.
      count += inlineArrayElements(raw);
      continue;
    }
    if (matrixIndent >= 0 && indent > matrixIndent) {
      if (/^\s*-\s+\S/.test(raw)) {
        count += 1;
      } else {
        count += inlineArrayElements(raw);
      }
    }
  }
  return count;
}

/** Count comma-separated elements inside any `[ ... ]` on a line. */
function inlineArrayElements(line: string): number {
  let total = 0;
  for (const match of line.matchAll(/\[([^\]]*)\]/g)) {
    const inner = match[1]!.trim();
    if (inner.length === 0) continue;
    total += inner.split(",").filter((s) => s.trim().length > 0).length;
  }
  return total;
}

/** Detect a narrowed CI matrix (fewer entries on head than on parent). */
export function scanCiMatrix(
  path: string,
  parentContent: string,
  headContent: string,
): StaticTailFinding[] {
  const before = matrixEntryCount(parentContent);
  const after = matrixEntryCount(headContent);
  if (before > 0 && after < before) {
    return [
      {
        file: path,
        line: 0,
        kind: "ci-matrix-narrowed",
        detail: `CI matrix entries reduced from ${before} to ${after}; the change runs on fewer configurations`,
      },
    ];
  }
  return [];
}

function parse(file: string, content: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Count `await` expressions in a TS/JS file. */
function awaitCount(file: string, content: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(parse(file, content));
  return count;
}

/** Detect dropped `await` (fire-and-forget) introduced by the diff. */
export function scanDroppedAsync(
  path: string,
  parentContent: string,
  headContent: string,
): StaticTailFinding[] {
  const before = awaitCount(path, parentContent);
  const after = awaitCount(path, headContent);
  if (before > after) {
    return [
      {
        file: path,
        line: 0,
        kind: "dropped-async",
        detail: `${before - after} await expression(s) removed; a rejected promise may no longer surface`,
      },
    ];
  }
  return [];
}

/** Collect the precision (numDigits) of every toBeCloseTo call in a test file. */
function closeToPrecisions(file: string, content: string): number[] {
  const out: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "toBeCloseTo"
    ) {
      const arg = node.arguments[1];
      // numDigits defaults to 2 when omitted (Jest/vitest semantics).
      const precision =
        arg && ts.isNumericLiteral(arg) ? Number(arg.text) : 2;
      out.push(precision);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file, content));
  return out.sort((a, b) => a - b);
}

/** Detect a loosened numeric tolerance (lower toBeCloseTo precision). */
export function scanToleranceLoosening(
  path: string,
  parentContent: string,
  headContent: string,
): StaticTailFinding[] {
  const before = closeToPrecisions(path, parentContent);
  const after = closeToPrecisions(path, headContent);
  if (before.length === 0 || after.length === 0) return [];
  if (after[0]! < before[0]!) {
    return [
      {
        file: path,
        line: 0,
        kind: "tolerance-loosened",
        detail: `toBeCloseTo precision lowered from ${before[0]} to ${after[0]} digits; the assertion accepts more slop`,
      },
    ];
  }
  return [];
}

/**
 * Run every parent-vs-head soft-tail comparison applicable to one changed file,
 * dispatched by filename.
 *
 * @param file - the changed file path with its parent and head content.
 * @returns the soft-tail findings for that file.
 */
export function scanDiffTail(file: {
  path: string;
  parentContent: string;
  headContent: string;
}): StaticTailFinding[] {
  const findings: StaticTailFinding[] = [];
  const { path, parentContent, headContent } = file;
  if (COVERAGE_CONFIG.test(path)) {
    findings.push(...scanCoverageThreshold(path, parentContent, headContent));
  }
  if (WORKFLOW.test(path)) {
    findings.push(...scanCiMatrix(path, parentContent, headContent));
  }
  if (TS_LIKE.test(path)) {
    findings.push(...scanDroppedAsync(path, parentContent, headContent));
  }
  if (TEST_LIKE.test(path)) {
    findings.push(...scanToleranceLoosening(path, parentContent, headContent));
  }
  return findings;
}
