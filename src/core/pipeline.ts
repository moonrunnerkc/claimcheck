import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Claim } from "./claim.js";
import type {
  ErrorSuppression,
  EvidenceRecord,
  LineRange,
  NdSource,
  QuarantineNote,
  StaticTailFinding,
  TestWeakening,
  VacuousAssertion,
} from "./evidence-record.js";
import type { Verdict } from "./verdict.js";
import { buildBundle, type VerdictBundle } from "../bundle/verdict-bundle.js";
import { TOOL_VERSION } from "../version.js";
import { createWorktrees } from "../git/worktree.js";
import { prepareToolchain } from "../adapters/worktree-toolchain.js";
import { listFiles, showFile, unifiedDiff } from "../git/git.js";
import { analyzeDiff, isTestFile, sourceRanges, testFiles } from "../git/diff.js";
import { runRegression } from "../checks/regression.js";
import { scanErrorSuppression } from "../checks/error-suppression.js";
import { scanStaticTail } from "../checks/static-tail.js";
import { scanDiffTail } from "../checks/diff-tail.js";
import { scanVacuousAssertions } from "../checks/vacuous-assertion.js";
import { compareTestFile } from "../checks/test-weakening.js";
import { findToolchainModules } from "../adapters/toolchain.js";
import { collectCoverage, intersectChangedLines } from "../coverage/collect.js";
import { headRunPasses } from "../adapters/vitest-run.js";
import { runFailsOnParent } from "../checks/fails-on-parent.js";
import { runStryker } from "../mutation/stryker-runner.js";
import { selectMutateRanges } from "../mutation/mutant-select.js";
import {
  scanNondeterminism,
  type ScanInput,
} from "../analysis/nondeterminism-scan.js";
import { prepareSandbox } from "../determinism/sandbox.js";
import { detectResidualFlakes } from "../determinism/flake-fallback.js";
import { runTaint } from "../analysis/def-use-taint.js";
import { classifyMutants } from "../analysis/mutant-equivalence.js";
import { revParse } from "../git/git.js";
import { AnalysisCache, contentKey } from "../cache/analysis-cache.js";
import type { Oracle, PrMetadata, ReproInput } from "../oracle/oracle.js";
import { runOracles } from "../oracle/oracle.js";
import type { OracleFinding } from "./evidence-record.js";

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
  /** When set, cache and reuse the bundle for identical (base, head, version). */
  readonly cacheDir?: string;
  /**
   * Oracles to run after the battery, before taint rewrites the worktree. When
   * absent or empty, no oracle runs and the record is byte-for-byte identical to
   * a pre-oracle run. Purely additive: oracle findings can tighten the verdict,
   * never weaken it.
   */
  readonly oracles?: readonly Oracle[];
  /** The reproduction or issue text an oracle evaluates; absent means none. */
  readonly reproInput?: ReproInput;
  /** PR provenance an oracle may use to locate its external source. */
  readonly prMetadata?: PrMetadata;
}

export interface PipelineResult {
  readonly record: EvidenceRecord;
  readonly verdict: Verdict;
  /** The content-addressed, replayable bundle derived from the record. */
  readonly bundle: VerdictBundle;
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
  // Cache hit short-circuit: the verdict is a pure function of the resolved
  // commits and the tool version, so an identical key reproduces the result.
  let cache: AnalysisCache | null = null;
  let cacheKey: string | null = null;
  if (options.cacheDir) {
    const baseSha = await revParse(options.repoPath, options.base);
    const headSha = await revParse(options.repoPath, options.head);
    cache = new AnalysisCache(options.cacheDir);
    cacheKey = contentKey([baseSha, headSha, TOOL_VERSION]);
    const hit = await cache.get<VerdictBundle>(cacheKey);
    if (hit) {
      return { record: hit.record, verdict: hit.verdict, bundle: hit };
    }
  }

  const worktrees = await createWorktrees(
    options.repoPath,
    options.base,
    options.head,
  );
  // Stable, deterministic notes for stages that fail to complete. A failing
  // stage degrades to a neutral result and a WARN, never a crash: an analysis
  // that did not run cannot prove a lie, so it must not block, but it also must
  // not silently pass. The reason is fixed text (never a raw error message,
  // which would not be byte-stable); the raw error goes to stderr only.
  const degradations: string[] = [];
  async function attempt<T>(
    reason: string,
    run: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      degradations.push(reason);
      process.stderr.write(
        `claimcheck: ${reason} (${err instanceof Error ? err.message : String(err)})\n`,
      );
      return fallback;
    }
  }

  try {
    // Prepare each worktree's toolchain: a dependency-free repo (the corpus)
    // borrows ClaimCheck's modules by symlink and stays offline; a real repo is
    // installed with its own lockfile so its tests resolve their dependencies.
    // An install failure degrades rather than crashing: the tests then fail to
    // run, which passes-on-head already reports as WARN.
    const toolchain = await findToolchainModules();
    // Each worktree installs independently: a head failure must not skip the
    // parent setup that fails-on-parent and regression depend on.
    await attempt(
      "head toolchain install did not complete; head tests may not resolve their dependencies",
      async () => {
        await prepareToolchain(worktrees.headDir, toolchain);
      },
      undefined,
    );
    await attempt(
      "parent toolchain install did not complete; fails-on-parent and regression may not run",
      async () => {
        await prepareToolchain(worktrees.parentDir, toolchain);
      },
      undefined,
    );
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
    const headTestsPass = headRunPasses(
      coverage.run,
      activeTestFiles.length,
      flakyNames,
    );
    const coveredChangedLines = intersectChangedLines(
      changedRanges,
      coverage.coveredLines,
    );

    const failsOnParent = await attempt(
      "fails-on-parent could not run on the parent worktree",
      () =>
        runFailsOnParent({
          parentDir: worktrees.parentDir,
          headSha: worktrees.headSha,
          testFiles: activeTestFiles,
          configFile,
        }),
      "indeterminate" as const,
    );

    // Normally mutate the covered changed lines. When coverage was collected
    // but did not map onto the change, fall back to the changed hunks so the
    // kill-check still runs; note either the fallback or a skip for legibility.
    const mutateSelection = selectMutateRanges(
      coveredChangedLines,
      changedRanges,
      coverage.coveredLines.size > 0,
    );
    const mutateRanges = mutateSelection.ranges;
    if (mutateSelection.fallback) {
      degradations.push(
        "coverage did not map onto the changed lines; the kill-check mutated the changed hunks directly",
      );
    } else if (mutateSelection.skipped) {
      degradations.push(mutateSelection.skipped);
    }
    const rawMutants =
      headTestsPass && mutateRanges.length > 0
        ? await attempt(
            "mutation run did not complete; the kill-check ran without mutants",
            () =>
              runStryker({
                worktreeDir: worktrees.headDir,
                mutateRanges,
                testFiles: activeTestFiles,
              }),
            [] as Awaited<ReturnType<typeof runStryker>>,
          )
        : [];
    // Analytical pre-filter: classify unreachable and trivially-equivalent
    // mutants so their survival is never read as a weak test.
    const sourceByFile = new Map<string, string>();
    for (const file of changedSourceFiles) {
      try {
        sourceByFile.set(file, await readFile(join(worktrees.headDir, file), "utf8"));
      } catch {
        // Source absent at head; skip.
      }
    }
    const mutants = classifyMutants(rawMutants, sourceByFile);

    // Differential regression: parent tests the PR did not touch must still pass.
    const parentTestFiles = (await listFiles(options.repoPath, worktrees.baseSha))
      .filter(isTestFile);
    const regressions = await attempt(
      "regression check could not run; parent tests were not re-verified on head",
      () =>
        runRegression({
          parentDir: worktrees.parentDir,
          headDir: worktrees.headDir,
          parentTestFiles,
          changedTestFiles: newTestFiles,
          quarantinedTests: flakyNames,
          configFile,
        }),
      [] as string[],
    );

    // Error-suppression: swallowed errors on the changed source lines.
    const rangesByFile = new Map<string, LineRange[]>();
    for (const f of changed) {
      if (f.isSource) rangesByFile.set(f.path, [...f.ranges]);
    }
    const errorSuppressions: ErrorSuppression[] = scanErrorSuppression(
      [...sourceByFile.entries()].map(([path, content]) => ({ path, content })),
      rangesByFile,
    );

    // Test-weakening: existing tests the PR modified, compared parent vs head.
    const testWeakenings: TestWeakening[] = [];
    const parentTestSet = new Set(parentTestFiles);
    for (const file of newTestFiles) {
      if (!parentTestSet.has(file)) continue; // newly added test, nothing to weaken
      const parentContent = await showFile(options.repoPath, worktrees.baseSha, file);
      const headContent = await showFile(options.repoPath, worktrees.headSha, file);
      if (parentContent === null || headContent === null) continue;
      testWeakenings.push(...compareTestFile(file, parentContent, headContent));
    }

    // Soft-tail static scan: coverage-ignore markers, type suppression, and
    // `any` widening on the changed source lines.
    const staticTail: StaticTailFinding[] = scanStaticTail(
      [...sourceByFile.entries()].map(([path, content]) => ({ path, content })),
      rangesByFile,
    );
    // Parent-vs-head soft-tail: lowered coverage thresholds, narrowed CI
    // matrices, dropped awaits, loosened numeric tolerances. Applies to every
    // changed file, dispatched by name; the source on-line scan above already
    // covers head-only patterns, so the two do not overlap.
    for (const f of changed) {
      const parentContent = await showFile(options.repoPath, worktrees.baseSha, f.path);
      const headContent = await showFile(options.repoPath, worktrees.headSha, f.path);
      if (parentContent === null || headContent === null) continue;
      staticTail.push(...scanDiffTail({ path: f.path, parentContent, headContent }));
    }

    // Test-side vacuity: mocking the changed module, snapshotting changed
    // output, or asserting a tautology. Scanned on the head content of every
    // new test file, before taint rewrites them.
    const vacuousAssertions: VacuousAssertion[] = [];
    for (const file of newTestFiles) {
      const content = await showFile(options.repoPath, worktrees.headSha, file);
      if (content === null) continue;
      vacuousAssertions.push(
        ...scanVacuousAssertions({
          testFile: file,
          content,
          changedSourceFiles,
        }),
      );
    }

    // Oracle layer: import a correctness signal that is not the agent's own
    // tests. Runs before taint because the repro executes the worktree's real
    // source, and taint rewrites that source in place. Skipped entirely when no
    // oracle is configured, so the record stays byte-for-byte unchanged.
    let oracleFindings: OracleFinding[] | undefined;
    if (options.oracles && options.oracles.length > 0) {
      const findings = await runOracles(options.oracles, {
        parentDir: worktrees.parentDir,
        headDir: worktrees.headDir,
        baseSha: worktrees.baseSha,
        headSha: worktrees.headSha,
        changedRanges,
        configFile,
        prMetadata: options.prMetadata ?? {
          owner: null,
          repo: null,
          issueNumber: null,
        },
        reproInput: options.reproInput ?? null,
      });
      if (findings.length > 0) oracleFindings = findings;
    }

    // Assertion-reachability by def-use taint. Runs last because it rewrites
    // source and test files in place; nothing reads the worktree after it.
    const taint =
      headTestsPass && coveredChangedLines.length > 0
        ? await attempt(
            "assertion-reachability taint did not complete; relying on the kill-check",
            () =>
              runTaint({
                worktreeDir: worktrees.headDir,
                sourceFiles: changedSourceFiles,
                testFiles: activeTestFiles,
                coveredChangedLines,
              }),
            [] as Awaited<ReturnType<typeof runTaint>>,
          )
        : [];

    const record: EvidenceRecord = {
      baseSha: worktrees.baseSha,
      headSha: worktrees.headSha,
      changedRanges,
      headTestsPass,
      // A non-empty coverage map means collection worked; an empty one from a
      // passing run is a measurement failure, not a real "nothing covered".
      coverageCollected: coverage.coveredLines.size > 0,
      failsOnParent,
      coveredChangedLines,
      mutants,
      taint,
      nondeterminism,
      regressions,
      errorSuppressions,
      testWeakenings,
      staticTail,
      vacuousAssertions,
      quarantined,
      degradations,
      ...(oracleFindings ? { oracleFindings } : {}),
      toolVersion: TOOL_VERSION,
    };

    const bundle = buildBundle(record);
    if (cache && cacheKey) await cache.set(cacheKey, bundle);
    return { record: bundle.record, verdict: bundle.verdict, bundle };
  } finally {
    await worktrees.cleanup();
  }
}
