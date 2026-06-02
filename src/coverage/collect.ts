import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { LineRange } from "../core/evidence-record.js";
import { mergeRanges } from "../git/diff.js";
import { parseCoverage } from "./istanbul.js";
import { runVitest, type VitestResult } from "../adapters/vitest-run.js";

/**
 * Run the new tests with coverage and intersect that coverage with the changed
 * source line ranges. The intersection is what keeps mutation targeting small
 * and turns the kill-check into a precise statement about the lines the agent
 * claims implement the fix.
 */

export interface CoverageCollection {
  readonly run: VitestResult;
  /** Executed lines keyed by repo-relative file path. */
  readonly coveredLines: Map<string, Set<number>>;
}

/**
 * Run the given test files in a worktree and collect line coverage, keyed by
 * repo-relative path.
 *
 * @param worktreeDir - the worktree to run in; node_modules must be linked.
 * @param testFiles - repo-relative test files to run.
 * @param configFile - optional vitest config (the deterministic sandbox).
 * @returns the test run result and per-file executed lines.
 */
export async function collectCoverage(
  worktreeDir: string,
  testFiles: readonly string[],
  configFile?: string,
): Promise<CoverageCollection> {
  const coverageDir = await mkdtemp(join(tmpdir(), "claimcheck-cov-"));
  try {
    const run = await runVitest({
      cwd: worktreeDir,
      testFiles,
      coverageDir,
      ...(configFile ? { configFile } : {}),
    });
    let coveredLines = new Map<string, Set<number>>();
    try {
      const raw = await readFile(join(coverageDir, "coverage-final.json"), "utf8");
      const absolute = parseCoverage(JSON.parse(raw));
      // The v8 provider reports canonical real paths (on macOS /tmp resolves to
      // /private/tmp), so relativize against the worktree's real path, not the
      // symlinked one, or every covered file looks "outside" and is dropped.
      const realRoot = await realpath(worktreeDir).catch(() => worktreeDir);
      coveredLines = toRelative(absolute, realRoot);
    } catch {
      // No coverage file produced (e.g. no tests ran); leave the map empty.
    }
    return { run, coveredLines };
  } finally {
    await rm(coverageDir, { recursive: true, force: true });
  }
}

/** Re-key absolute coverage paths to repo-relative, dropping outside paths. */
function toRelative(
  absolute: Map<string, Set<number>>,
  worktreeDir: string,
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [absPath, lines] of absolute) {
    const rel = relative(worktreeDir, absPath);
    if (rel.startsWith("..")) continue; // outside the worktree (e.g. node_modules)
    out.set(rel, lines);
  }
  return out;
}

/**
 * Intersect changed source ranges with executed lines, yielding the changed
 * lines the new tests actually run, merged into contiguous ranges.
 *
 * @param changed - changed source line ranges from the diff.
 * @param coveredLines - executed lines keyed by repo-relative path.
 * @returns the covered subset of the changed lines, as merged ranges.
 */
export function intersectChangedLines(
  changed: readonly LineRange[],
  coveredLines: ReadonlyMap<string, Set<number>>,
): LineRange[] {
  const singles: LineRange[] = [];
  for (const range of changed) {
    const covered = coveredLines.get(range.file);
    if (!covered) continue;
    for (let line = range.start; line <= range.end; line++) {
      if (covered.has(line)) {
        singles.push({ file: range.file, start: line, end: line });
      }
    }
  }
  const byFile = new Map<string, LineRange[]>();
  for (const single of singles) {
    const list = byFile.get(single.file) ?? [];
    list.push(single);
    byFile.set(single.file, list);
  }
  const merged: LineRange[] = [];
  for (const list of byFile.values()) {
    merged.push(...mergeRanges(list));
  }
  return merged.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
}
