/**
 * Parse istanbul-format coverage JSON (as emitted by vitest's v8 provider with
 * the json reporter) into the set of source lines each file actually executed.
 * Line-level coverage is enough for the diff intersection; statement hit counts
 * are collapsed to "did this line run at all".
 */

interface Position {
  line: number;
  column: number;
}
interface StatementRange {
  start: Position;
  end: Position;
}
interface FileCoverage {
  statementMap?: Record<string, StatementRange>;
  s?: Record<string, number>;
}

function isPosition(value: unknown): value is Position {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Position).line === "number"
  );
}

/**
 * Reduce one file's istanbul coverage to the set of executed line numbers.
 *
 * @param file - the per-file coverage object.
 * @returns the 1-based line numbers with at least one executed statement.
 */
function executedLines(file: FileCoverage): Set<number> {
  const lines = new Set<number>();
  const statementMap = file.statementMap ?? {};
  const hits = file.s ?? {};
  for (const [id, range] of Object.entries(statementMap)) {
    if ((hits[id] ?? 0) <= 0) continue;
    if (!isPosition(range.start) || !isPosition(range.end)) continue;
    for (let line = range.start.line; line <= range.end.line; line++) {
      lines.add(line);
    }
  }
  return lines;
}

/**
 * Parse a full coverage-final.json into a map from absolute file path to its
 * executed line numbers.
 *
 * @param json - the parsed JSON contents of coverage-final.json.
 * @returns executed lines keyed by absolute file path.
 */
export function parseCoverage(json: unknown): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();
  if (typeof json !== "object" || json === null) return byFile;
  for (const [path, raw] of Object.entries(json as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    byFile.set(path, executedLines(raw as FileCoverage));
  }
  return byFile;
}
