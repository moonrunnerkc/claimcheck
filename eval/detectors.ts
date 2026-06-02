import type { Verdict } from "../src/core/verdict.js";
import { decide } from "../src/core/decision.js";
import type { EvidenceRecord } from "../src/core/evidence-record.js";
import { runPipeline } from "../src/core/pipeline.js";
import { fixClaim } from "../src/core/claim.js";
import type { MaterializedRepo } from "./corpus-repo.js";

/**
 * A detector turns a materialized case repository into a verdict. The harness
 * scores any detector the same way, so the Phase 0 stub and the real pipeline
 * are interchangeable behind this interface.
 */
export interface Detector {
  readonly name: string;
  run(repo: MaterializedRepo, mode: "fix"): Promise<Verdict>;
}

/**
 * A stub detector that observes nothing and asserts nothing: it builds an empty
 * evidence record from the SHAs and runs the real decision function over it.
 * It exists to prove the harness end to end and to anchor the determinism check
 * before any real check is wired in.
 */
export const stubDetector: Detector = {
  name: "stub",
  run(repo: MaterializedRepo): Promise<Verdict> {
    const record: EvidenceRecord = {
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      changedRanges: [],
      headTestsPass: true,
      coverageCollected: true,
      failsOnParent: "failed",
      coveredChangedLines: [],
      mutants: [],
      taint: [],
      nondeterminism: [],
      regressions: [],
      errorSuppressions: [],
      testWeakenings: [],
      staticTail: [],
      vacuousAssertions: [],
      quarantined: [],
      toolVersion: "0.1.0-stub",
    };
    return Promise.resolve(decide(record));
  },
};

/**
 * The real ClaimCheck pipeline as a detector. Runs the full battery against the
 * materialized case repository.
 */
export const pipelineDetector: Detector = {
  name: "pipeline",
  async run(repo: MaterializedRepo, mode: "fix"): Promise<Verdict> {
    const { verdict } = await runPipeline({
      repoPath: repo.repoPath,
      base: repo.baseSha,
      head: repo.headSha,
      claim: fixClaim(),
    });
    void mode;
    return verdict;
  },
};
