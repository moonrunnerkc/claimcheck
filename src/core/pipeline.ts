import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Claim } from "./claim.js";
import type {
  EvidenceRecord,
  NdSource,
  QuarantineNote,
} from "./evidence-record.js";
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
import {
  scanNondeterminism,
  type ScanInput,
} from "../analysis/nondeterminism-scan.js";
import { prepareSandbox } from "../determinism/sandbox.js";
import { detectResidualFlakes } from "../determinism/flake-fallback.js";

/**
 * The pipeline orchestrates the check battery and fills the canonical evidence
 * record, then hands it to the pure {@link decide} function. It performs all
 * the I/O (worktrees, sandboxed test runs, mutation); the record it produces is
 * the only thing the verdict depends on. Every test execution runs under the
 * deterministic sandbox.
 */

export interface PipelineOptions {
  readonly repoPath: string;
  readonly base: string;
  readonly head: string;
  readonly claim: Claim;
}

export interface PipelineResult {
  readonly record: EvidenceRecord;
  readonly verdict: Verdict;
}

/** Read the head contents of the changed source files and the new test files. */
async function readScanInputs(
  worktreeDir: string,
  paths: readonly string[],
): Promise<ScanInput[]> {
  const inputs: ScanInput[] = [];
  for (const path of paths) {
    try {
      inputs.push({ path, content: await readFile(join(worktreeDir, path), "utf8") });
    } catch {
      // File absent at head (deleted): nothing to scan.
    }
  }
  return inputs;
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
    const { configFile } = await prepareSandbox(worktrees.headDir);
    await prepareSandbox(worktrees.parentDir);

    const diffText = await unifiedDiff(
      options.repoPath,
      worktrees.baseSha,
      worktrees.headSha,
    );
    const changed = analyzeDiff(diffText);
    const changedRanges = sourceRanges(changed);
    const newTestFiles = testFiles(changed);
    const changedSourceFiles = changed
      .filter((f) => f.isSource)
      .map((f) => f.path);

    // Layer 1: name the nondeterminism sources in the changed code and its
    // tests. A test file carrying an uncontrollable source is quarantined.
    const nondeterminism: NdSource[] = scanNondeterminism(
      await readScanInputs(worktrees.headDir, [
        ...changedSourceFiles,
        ...newTestFiles,
      ]),
    );
    // A new test is unreliable under the sandbox when the code it exercises (or
    // the test itself) carries an uncontrollable source the sandbox denies. In
    // v0.1's single-fix scope, an uncontrollable source in any changed source
    // file taints the new tests, so they are quarantined with that reason
    // rather than counted as real failures.
    const uncontrolled = nondeterminism.filter((s) => !s.controlled);
    const uncontrolledKind = uncontrolled[0]?.kind;
    const quarantinedTestFiles = new Set<string>(
      uncontrolledKind ? newTestFiles : [],
    );
    for (const s of uncontrolled) {
      if (newTestFiles.includes(s.file)) quarantinedTestFiles.add(s.file);
    }
    const quarantined: QuarantineNote[] = [...quarantinedTestFiles]
      .sort((a, b) => a.localeCompare(b))
      .map((file) => ({
        test: file,
        reason: `uncontrollable nondeterminism source (${uncontrolledKind ?? "network"})`,
      }));
    const activeTestFiles = newTestFiles.filter(
      (f) => !quarantinedTestFiles.has(f),
    );

    // Layer 2 fallback: quarantine any active test that still flips under the
    // sandbox before it can influence the verdict.
    const flakes = await detectResidualFlakes({
      worktreeDir: worktrees.headDir,
      testFiles: activeTestFiles,
      configFile,
    });
    const flakyNames = new Set(flakes.map((f) => f.test));
    quarantined.push(...flakes);

    // passes-on-head and the coverage map come from one sandboxed run.
    const coverage = await collectCoverage(
      worktrees.headDir,
      activeTestFiles,
      configFile,
    );
    const trustedOutcomes = coverage.run.outcomes.filter(
      (o) => !flakyNames.has(o.name),
    );
    const headTestsPass =
      activeTestFiles.length > 0 &&
      !coverage.run.noTests &&
      !trustedOutcomes.some((o) => o.status === "fail");
    const coveredChangedLines = intersectChangedLines(
      changedRanges,
      coverage.coveredLines,
    );

    const failsOnParent = await runFailsOnParent({
      parentDir: worktrees.parentDir,
      headSha: worktrees.headSha,
      testFiles: activeTestFiles,
      configFile,
    });

    const mutateRanges = toMutateRanges(coveredChangedLines);
    const mutants =
      headTestsPass && mutateRanges.length > 0
        ? await runStryker({
            worktreeDir: worktrees.headDir,
            mutateRanges,
            testFiles: activeTestFiles,
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
      nondeterminism,
      regressions: [],
      errorSuppressions: [],
      testWeakenings: [],
      quarantined,
      toolVersion: TOOL_VERSION,
    };

    return { record, verdict: decide(record) };
  } finally {
    await worktrees.cleanup();
  }
}
