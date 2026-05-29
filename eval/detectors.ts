import type { Verdict } from "../src/core/verdict.js";
import { decide } from "../src/core/decision.js";
import type { EvidenceRecord } from "../src/core/evidence-record.js";
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
      failsOnParent: "failed",
      coveredChangedLines: [],
      mutants: [],
      taint: [],
      nondeterminism: [],
      regressions: [],
      errorSuppressions: [],
      testWeakenings: [],
      quarantined: [],
      toolVersion: "0.1.0-stub",
    };
    return Promise.resolve(decide(record));
  },
};
