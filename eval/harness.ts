import { runCorpus } from "./run-corpus.js";
import { formatMetrics } from "./scoring.js";
import { stubDetector } from "./detectors.js";
import type { Detector } from "./detectors.js";

/**
 * CLI entry for `npm run eval`. Runs a detector over the corpus, prints the
 * per-case table and the aggregate metrics, and exits non-zero if BLOCK
 * precision is below 1.0, since a single false block fails the gate.
 *
 * The default detector is the Phase 0 stub. Later phases pass the real pipeline
 * detector here.
 *
 * @param detector - the detector to evaluate; defaults to the stub.
 */
export async function main(detector: Detector = stubDetector): Promise<void> {
  const { results, metrics } = await runCorpus(detector);

  const rows = [...results].sort((a, b) => a.name.localeCompare(b.name));
  const width = Math.max(4, ...rows.map((r) => r.name.length));
  process.stdout.write(`detector: ${detector.name}\n\n`);
  process.stdout.write(
    `${"case".padEnd(width)}  ${"label".padEnd(16)}  expected  actual    ok\n`,
  );
  for (const r of rows) {
    const ok = r.actual === r.expected ? "+" : "x";
    process.stdout.write(
      `${r.name.padEnd(width)}  ${r.label.padEnd(16)}  ${r.expected.padEnd(8)}  ${r.actual.padEnd(8)}  ${ok}\n`,
    );
  }
  process.stdout.write(`\n${formatMetrics(metrics)}\n`);

  if (metrics.blockPrecision < 1) {
    process.stdout.write(
      `\nFAIL: BLOCK precision is ${metrics.blockPrecision}; false blocks must be zero.\n`,
    );
    process.exitCode = 1;
  }
}

// Run when invoked directly (npm run eval), not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });
}
