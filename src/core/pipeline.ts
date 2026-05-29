import type { Claim } from "./claim.js";
import type { EvidenceRecord } from "./evidence-record.js";
import type { Verdict } from "./verdict.js";
import { decide } from "./decision.js";
import { TOOL_VERSION } from "../version.js";
import { createWorktrees, linkNodeModules } from "../git/worktree.js";
import { unifiedDiff } from "../git/git.js";
import { analyzeDiff, sourceRanges, testFiles } from "../git/diff.js";
import { findToolchainModules } from "../adapters/toolchain.js";
import { collectCoverage, intersectChangedLines } from "../coverage/collect.js";
import { runFailsOnParent } from "../checks/fails-on-parent.js";
import { runStryker } from "../mutation/stryker-runner.js";
import { toMutateRanges } from "../mutation/mutant-select.js";

/**
 * The pipeline orchestrates the check battery and fills the canonical evidence
 * record, then hands it to the pure {@link decide} function. It performs all
 * the I/O (worktrees, test runs, mutation); the record it produces is the only
 * thing the verdict depends on.
 */

export interface PipelineOptions {
  /** Path to the git repository under analysis. */
  readonly repoPath: string;
  /** Parent ref or SHA. */
  readonly base: string;
  /** Head ref or SHA. */
  readonly head: string;
  /** The claim; v0.1 is always fix mode. */
  readonly claim: Claim;
}

export interface PipelineResult {
  readonly record: EvidenceRecord;
  readonly verdict: Verdict;
}

/**
 * Run the falsification pipeline against a PR and produce a verdict.
 *
 * @param options - repository path, base and head refs, and the claim.
 * @returns the canonical evidence record and the verdict derived from it.
 */
export async function runPipeline(
  options: PipelineOptions,
): Promise<PipelineResult> {
  const worktrees = await createWorktrees(
    options.repoPath,
    options.base,
    options.head,
  );
  try {
    const toolchain = await findToolchainModules();
    await linkNodeModules(worktrees.headDir, toolchain);
    await linkNodeModules(worktrees.parentDir, toolchain);

    const diffText = await unifiedDiff(
      options.repoPath,
      worktrees.baseSha,
      worktrees.headSha,
    );
    const changed = analyzeDiff(diffText);
    const changedRanges = sourceRanges(changed);
    const newTestFiles = testFiles(changed);

    // passes-on-head and the coverage map come from one run of the new tests.
    const coverage = await collectCoverage(worktrees.headDir, newTestFiles);
    const headTestsPass = coverage.run.passed && !coverage.run.noTests;
    const coveredChangedLines = intersectChangedLines(
      changedRanges,
      coverage.coveredLines,
    );

    const failsOnParent = await runFailsOnParent({
      parentDir: worktrees.parentDir,
      headSha: worktrees.headSha,
      testFiles: newTestFiles,
    });

    // kill-check: mutate only the covered changed lines, scoped to the new tests.
    const mutateRanges = toMutateRanges(coveredChangedLines);
    const mutants =
      headTestsPass && mutateRanges.length > 0
        ? await runStryker({
            worktreeDir: worktrees.headDir,
            mutateRanges,
            testFiles: newTestFiles,
          })
        : [];

    const record: EvidenceRecord = {
      baseSha: worktrees.baseSha,
      headSha: worktrees.headSha,
      changedRanges,
      headTestsPass,
      failsOnParent,
      coveredChangedLines,
      mutants,
      taint: [],
      nondeterminism: [],
      regressions: [],
      errorSuppressions: [],
      testWeakenings: [],
      quarantined: [],
      toolVersion: TOOL_VERSION,
    };

    return { record, verdict: decide(record) };
  } finally {
    await worktrees.cleanup();
  }
}
