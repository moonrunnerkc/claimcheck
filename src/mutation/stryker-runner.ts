import { readFile, rm, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import { exec } from "../util/exec.js";
import type { MutantOutcome, MutantStatus } from "../core/evidence-record.js";
import { isNoopOrInversion, mutantId } from "./mutant-select.js";
import { scopedSandboxConfig, writeSandboxSetup } from "../determinism/sandbox.js";

/**
 * Orchestrate Stryker over explicit per-line mutate ranges and parse its
 * mutation report into the canonical {@link MutantOutcome} shape. ClaimCheck
 * owns the range selection and the result interpretation; Stryker owns the
 * mutation mechanics.
 */

export interface StrykerRunOptions {
  /** Worktree to mutate in; node_modules must be linked and tests must pass. */
  readonly worktreeDir: string;
  /** Stryker `path:start-end` mutate specifiers, scoped to covered changed lines. */
  readonly mutateRanges: readonly string[];
  /** Test files the kill-check holds responsible, relative to the worktree. */
  readonly testFiles: readonly string[];
  /** Extra environment, for example the sandbox preload. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Override the worker count; defaults to {@link defaultConcurrency}. */
  readonly concurrency?: number;
}

/**
 * Choose how many Stryker workers to run. Mutants are independent and each runs
 * in its own sandbox, so concurrency changes only the runtime, never the
 * verdict: a mutant's kill/survive outcome does not depend on how many of its
 * siblings run alongside it, and the evidence record sorts mutants by id. The
 * count is clamped to leave a core for the host and capped so a large CI runner
 * does not spawn an unbounded pool.
 *
 * @param cpuCount - the number of logical CPUs available.
 * @returns a worker count in [1, 4].
 */
export function defaultConcurrency(cpuCount: number): number {
  if (!Number.isFinite(cpuCount) || cpuCount <= 1) return 1;
  return Math.max(1, Math.min(4, Math.floor(cpuCount) - 1));
}

interface SchemaLocation {
  start?: { line?: unknown; column?: unknown };
  end?: { line?: unknown; column?: unknown };
}
interface SchemaMutant {
  mutatorName?: unknown;
  replacement?: unknown;
  status?: unknown;
  location?: SchemaLocation;
}
interface SchemaFile {
  mutants?: unknown;
}
interface MutationReport {
  files?: Record<string, SchemaFile>;
}

const STATUS_MAP: Readonly<Record<string, MutantStatus>> = {
  Killed: "killed",
  Survived: "survived",
  NoCoverage: "no-coverage",
  Timeout: "timeout",
  RuntimeError: "runtime-error",
  CompileError: "compile-error",
};

function num(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/** Parse the Stryker mutation report into canonical mutant outcomes. */
function parseReport(report: unknown): MutantOutcome[] {
  const out: MutantOutcome[] = [];
  if (typeof report !== "object" || report === null) return out;
  const files = (report as MutationReport).files ?? {};
  for (const [file, fileReport] of Object.entries(files)) {
    const mutants = fileReport?.mutants;
    if (!Array.isArray(mutants)) continue;
    for (const raw of mutants as SchemaMutant[]) {
      const mutator = typeof raw.mutatorName === "string" ? raw.mutatorName : "Unknown";
      const replacement = typeof raw.replacement === "string" ? raw.replacement : "";
      const statusKey = typeof raw.status === "string" ? raw.status : "";
      const status = STATUS_MAP[statusKey];
      if (!status) continue; // Ignored or unknown: not a kill-check signal
      const startLine = num(raw.location?.start?.line, 0);
      const startColumn = num(raw.location?.start?.column, 0);
      const endLine = num(raw.location?.end?.line, startLine);
      const endColumn = num(raw.location?.end?.column, startColumn);
      out.push({
        id: mutantId(file, startLine, startColumn, endLine, endColumn, mutator, replacement),
        file,
        startLine,
        startColumn,
        endLine,
        endColumn,
        mutator,
        replacement,
        status,
        prefilter: "none",
        noopOrInversion: isNoopOrInversion(mutator),
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Write a scoped Stryker config, run Stryker, parse the report, and clean up.
 *
 * @param options - worktree, mutate ranges, responsible test files, env.
 * @returns the mutant outcomes; empty when no ranges were given.
 * @throws if Stryker fails to start or produces no parseable report.
 */
export async function runStryker(
  options: StrykerRunOptions,
): Promise<MutantOutcome[]> {
  if (options.mutateRanges.length === 0) return [];

  const configPath = join(options.worktreeDir, "claimcheck.stryker.json");
  const vitestConfigPath = join(options.worktreeDir, "claimcheck.stryker.vitest.config.ts");
  const reportPath = join(options.worktreeDir, "reports", "mutation", "mutation.json");
  // Scope the runner to the tests the kill-check holds responsible, and load the
  // deterministic sandbox so mutants run under the same pinned conditions as the
  // baseline. Other tests in the repo (including ones the PR deliberately
  // regresses) must not enter Stryker's initial run, or a pre-existing failure
  // would abort it.
  const vitestConfig = await scopedSandboxConfig(
    options.worktreeDir,
    options.testFiles.length > 0 ? options.testFiles : ["**/*.{test,spec}.*"],
  );
  const config = {
    testRunner: "vitest",
    coverageAnalysis: "perTest",
    mutate: [...options.mutateRanges],
    reporters: ["json"],
    concurrency: options.concurrency ?? defaultConcurrency(cpus().length),
    timeoutMS: 60_000,
    disableTypeChecks: true,
    tempDirName: ".stryker-tmp",
    cleanTempDir: true,
    vitest: { configFile: "claimcheck.stryker.vitest.config.ts" },
  };

  const bin = join(options.worktreeDir, "node_modules", ".bin", "stryker");
  try {
    await writeSandboxSetup(options.worktreeDir);
    await writeFile(vitestConfigPath, vitestConfig, "utf8");
    await writeFile(configPath, JSON.stringify(config), "utf8");
    await exec(bin, ["run", configPath], {
      cwd: options.worktreeDir,
      ...(options.env ? { env: options.env } : {}),
      timeoutMs: options.timeoutMs ?? 300_000,
      allowNonZero: true,
    });
    let report: unknown;
    try {
      report = JSON.parse(await readFile(reportPath, "utf8"));
    } catch (cause) {
      throw new Error(
        `Stryker produced no mutation report at ${reportPath}; the run likely failed to start. Check the worktree has a passing test suite and a linked node_modules.`,
        { cause },
      );
    }
    return parseReport(report);
  } finally {
    await rm(configPath, { force: true });
    await rm(vitestConfigPath, { force: true });
    await rm(join(options.worktreeDir, "reports"), { recursive: true, force: true });
    await rm(join(options.worktreeDir, ".stryker-tmp"), { recursive: true, force: true });
  }
}
