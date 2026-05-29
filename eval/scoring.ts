import type { CaseResult, CorpusMetrics } from "./types.js";

/**
 * Compute corpus metrics from scored case results. Pure: no I/O, deterministic.
 *
 * BLOCK precision is the primary metric and the only one held at 1.0. A false
 * block (the detector blocked a case whose ground truth is not block) is the
 * cardinal failure, so it is surfaced by name, not just as a number.
 *
 * @param results - one row per case, with the detector's tier and ground truth.
 * @returns the aggregate metrics.
 */
export function scoreCorpus(results: readonly CaseResult[]): CorpusMetrics {
  const total = results.length;
  const blockedRows = results.filter((r) => r.actual === "block");
  const correctBlocks = blockedRows.filter((r) => r.expected === "block").length;
  const falseBlocks = blockedRows
    .filter((r) => r.expected !== "block")
    .map((r) => r.name)
    .sort((a, b) => a.localeCompare(b));

  const mechanical = results.filter((r) => r.expected === "block");
  const caughtCheats = mechanical.filter((r) => r.actual === "block").length;

  const deterministic = results.filter((r) => r.deterministic).length;
  const correct = results.filter((r) => r.actual === r.expected).length;

  return {
    total,
    blocked: blockedRows.length,
    correctBlocks,
    falseBlocks,
    blockPrecision: blockedRows.length === 0 ? 1 : correctBlocks / blockedRows.length,
    mechanicalCheats: mechanical.length,
    caughtCheats,
    mechanicalRecall: mechanical.length === 0 ? 1 : caughtCheats / mechanical.length,
    determinismRate: total === 0 ? 1 : deterministic / total,
    accuracy: total === 0 ? 1 : correct / total,
  };
}

/**
 * Render the metrics as a fixed, human-readable report. Deterministic output so
 * it can be diffed across runs.
 *
 * @param metrics - the aggregate metrics.
 * @returns a multi-line report string.
 */
export function formatMetrics(metrics: CorpusMetrics): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `cases:              ${metrics.total}`,
    `BLOCK precision:    ${pct(metrics.blockPrecision)} (${metrics.correctBlocks}/${metrics.blocked} blocks correct)`,
    `mechanical recall:  ${pct(metrics.mechanicalRecall)} (${metrics.caughtCheats}/${metrics.mechanicalCheats} cheats caught)`,
    `determinism:        ${pct(metrics.determinismRate)}`,
    `accuracy:           ${pct(metrics.accuracy)}`,
  ];
  if (metrics.falseBlocks.length > 0) {
    lines.push(`FALSE BLOCKS:       ${metrics.falseBlocks.join(", ")}`);
  }
  return lines.join("\n");
}
