import type { Detector } from "./detectors.js";
import { materializeCase } from "./corpus-repo.js";
import { loadCorpus } from "./corpus-loader.js";
import { scoreCorpus } from "./scoring.js";
import type { CaseResult, CorpusMetrics } from "./types.js";

/**
 * Run a detector over the whole corpus and score it. Each case is materialized,
 * the detector is run twice to measure determinism, and the cases are processed
 * in name order so the report is stable.
 *
 * @param detector - the detector under evaluation.
 * @returns the per-case results and the aggregate metrics.
 */
export async function runCorpus(
  detector: Detector,
): Promise<{ results: CaseResult[]; metrics: CorpusMetrics }> {
  const cases = await loadCorpus();
  const results: CaseResult[] = [];

  for (const corpusCase of cases) {
    const repo = await materializeCase(corpusCase.dir);
    try {
      const first = await detector.run(repo, corpusCase.mode);
      const second = await detector.run(repo, corpusCase.mode);
      const deterministic =
        first.tier === second.tier && first.bundleHash === second.bundleHash;
      results.push({
        name: corpusCase.name,
        label: corpusCase.label,
        expected: corpusCase.expectedTier,
        actual: first.tier,
        deterministic,
        bundleHash: first.bundleHash,
      });
    } finally {
      await repo.cleanup();
    }
  }

  return { results, metrics: scoreCorpus(results) };
}
