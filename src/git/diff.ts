import type { LineRange } from "../core/evidence-record.js";

/**
 * Diff parsing: turn a unified diff into per-file changed line ranges on the
 * head side, and classify files as test or source. This mapping is load-bearing
 * IP: it is what lets the kill-check mutate only the lines the PR actually
 * changed instead of whole files.
 */

/** A changed file with its head-side added/modified line ranges. */
export interface ChangedFile {
  readonly path: string;
  readonly isTest: boolean;
  /** Whether the file is a TS/JS source the adapter can analyze. */
  readonly isSource: boolean;
  /** Added or modified line ranges on the head side, merged and sorted. */
  readonly ranges: readonly LineRange[];
}

const TEST_PATH = /(^|\/)(__tests__|tests?)\//;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const JS_TS_FILE = /\.[cm]?[jt]sx?$/;

/**
 * Is this path a test file by convention?
 *
 * @param path - repo-relative path.
 * @returns true for `*.test.ts`, `*.spec.js`, or anything under a tests dir.
 */
export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path) || TEST_PATH.test(path);
}

/**
 * Is this path a TS/JS source file the v0.1 adapter can analyze?
 *
 * @param path - repo-relative path.
 * @returns true for non-test `.ts`/`.tsx`/`.js`/`.jsx`/`.cjs`/`.mjs` files.
 */
export function isSourceFile(path: string): boolean {
  return JS_TS_FILE.test(path) && !isTestFile(path);
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const FILE_HEADER = /^\+\+\+ b\/(.+)$/;

/**
 * Parse a unified diff (produced with `--unified=0`) into head-side changed
 * line ranges per file. Pure deletions contribute no head lines and so are
 * excluded; only added and modified lines appear.
 *
 * @param diffText - the raw unified diff.
 * @returns a map from file path to its merged, sorted line ranges.
 */
export function parseUnifiedDiff(diffText: string): Map<string, LineRange[]> {
  const byFile = new Map<string, LineRange[]>();
  let currentFile: string | null = null;

  for (const line of diffText.split("\n")) {
    const fileMatch = FILE_HEADER.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1] ?? null;
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const hunk = HUNK_HEADER.exec(line);
    if (hunk && currentFile && currentFile !== "/dev/null") {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count === 0) continue; // pure deletion: no head-side lines
      const range: LineRange = {
        file: currentFile,
        start,
        end: start + count - 1,
      };
      const ranges = byFile.get(currentFile) ?? [];
      ranges.push(range);
      byFile.set(currentFile, ranges);
    }
  }

  for (const [file, ranges] of byFile) {
    byFile.set(file, mergeRanges(ranges));
  }
  return byFile;
}

/**
 * Merge overlapping or adjacent line ranges within a single file.
 *
 * @param ranges - ranges for one file, in any order.
 * @returns non-overlapping ranges sorted by start line.
 */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: LineRange[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const range = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (range.start <= last.end + 1) {
      merged[merged.length - 1] = {
        file: last.file,
        start: last.start,
        end: Math.max(last.end, range.end),
      };
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Analyze a unified diff into classified changed files.
 *
 * @param diffText - the raw unified diff between parent and head.
 * @returns one entry per changed file with its classification and ranges.
 */
export function analyzeDiff(diffText: string): ChangedFile[] {
  const byFile = parseUnifiedDiff(diffText);
  const files: ChangedFile[] = [];
  for (const [path, ranges] of byFile) {
    files.push({
      path,
      isTest: isTestFile(path),
      isSource: isSourceFile(path),
      ranges,
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Collect the changed source line ranges across all non-test source files.
 *
 * @param files - analyzed changed files.
 * @returns flattened source ranges, sorted by file and start.
 */
export function sourceRanges(files: readonly ChangedFile[]): LineRange[] {
  return files
    .filter((f) => f.isSource)
    .flatMap((f) => f.ranges)
    .sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
}

/**
 * Collect the paths of changed test files.
 *
 * @param files - analyzed changed files.
 * @returns sorted test file paths.
 */
export function testFiles(files: readonly ChangedFile[]): string[] {
  return files
    .filter((f) => f.isTest)
    .map((f) => f.path)
    .sort((a, b) => a.localeCompare(b));
}
