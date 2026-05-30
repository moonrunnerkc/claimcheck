import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { exec } from "../util/exec.js";

/**
 * Run vitest inside a worktree and parse its machine-readable output. This is
 * the single place that shells out to the target repo's test runner; the
 * adapter layers coverage and sandbox concerns on top of it.
 */

/** Status of one test, normalized across runner vocabularies. */
export type TestStatus = "pass" | "fail" | "skip";

export interface TestOutcome {
  /** Fully-qualified test name, stable across runs. */
  readonly name: string;
  readonly status: TestStatus;
}

export interface VitestResult {
  /** True when the run completed and no test failed. */
  readonly passed: boolean;
  /** True when vitest found no test files to run. */
  readonly noTests: boolean;
  /**
   * True when the runner exited non-zero and produced no test outcomes, and it
   * was not a clean "no test files" result: the suite failed to load or
   * collect (a missing dependency, a transform error, a config error). This is
   * distinct from a test failing; it means the run never happened, so the
   * caller must not read the empty outcome set as a pass.
   */
  readonly failedToRun: boolean;
  readonly outcomes: readonly TestOutcome[];
  readonly exitCode: number;
  readonly stderr: string;
}

export interface VitestRunOptions {
  /** Worktree directory to run in; must already have node_modules linked. */
  readonly cwd: string;
  /** Test files to run, relative to cwd. Empty means let vitest discover. */
  readonly testFiles: readonly string[];
  /** When set, collect V8 coverage into this directory as istanbul JSON. */
  readonly coverageDir?: string;
  /** Extra environment, for example the sandbox preload via NODE_OPTIONS. */
  readonly env?: Readonly<Record<string, string>>;
  /** Vitest config to load, relative to cwd; pins the deterministic sandbox. */
  readonly configFile?: string;
  readonly timeoutMs?: number;
}

interface AssertionResult {
  fullName?: unknown;
  title?: unknown;
  status?: unknown;
}
interface FileResult {
  assertionResults?: unknown;
}
interface VitestJson {
  testResults?: unknown;
}

function normalizeStatus(raw: unknown): TestStatus {
  if (raw === "passed") return "pass";
  if (raw === "pending" || raw === "skipped" || raw === "todo") return "skip";
  return "fail";
}

/** Parse vitest's jest-style JSON report into normalized test outcomes. */
function parseOutcomes(json: unknown): TestOutcome[] {
  const outcomes: TestOutcome[] = [];
  if (typeof json !== "object" || json === null) return outcomes;
  const results = (json as VitestJson).testResults;
  if (!Array.isArray(results)) return outcomes;
  for (const file of results as FileResult[]) {
    const assertions = file?.assertionResults;
    if (!Array.isArray(assertions)) continue;
    for (const a of assertions as AssertionResult[]) {
      const name =
        typeof a.fullName === "string" && a.fullName.length > 0
          ? a.fullName
          : typeof a.title === "string"
            ? a.title
            : "<unnamed>";
      outcomes.push({ name, status: normalizeStatus(a.status) });
    }
  }
  return outcomes.sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * Run vitest once and return parsed outcomes plus pass/fail.
 *
 * @param options - where and what to run, and whether to collect coverage.
 * @returns the parsed result; never throws on test failure, only on a runner
 *   that could not start.
 */
export async function runVitest(
  options: VitestRunOptions,
): Promise<VitestResult> {
  const reportDir = await mkdtemp(join(tmpdir(), "claimcheck-vitest-"));
  const resultsFile = join(reportDir, "results.json");
  const bin = join(options.cwd, "node_modules", ".bin", "vitest");

  const args = [
    "run",
    "--root",
    options.cwd,
    "--reporter=json",
    "--outputFile",
    resultsFile,
    "--no-color",
  ];
  if (options.configFile) {
    args.push("--config", options.configFile);
  }
  if (options.coverageDir) {
    args.push(
      "--coverage.enabled=true",
      "--coverage.provider=v8",
      "--coverage.reporter=json",
      "--coverage.reportsDirectory",
      options.coverageDir,
      "--coverage.all=false",
    );
  }
  for (const file of options.testFiles) {
    args.push(isAbsolute(file) ? relative(options.cwd, file) : file);
  }

  try {
    const result = await exec(bin, args, {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      timeoutMs: options.timeoutMs ?? 120_000,
      allowNonZero: true,
    });

    let outcomes: TestOutcome[] = [];
    try {
      outcomes = parseOutcomes(JSON.parse(await readFile(resultsFile, "utf8")));
    } catch {
      // No results file: vitest failed to start or found no tests.
    }
    const noTests =
      outcomes.length === 0 &&
      /No test files found|no test (files|suite)/i.test(
        result.stderr + result.stdout,
      );
    const passed =
      result.code === 0 && !outcomes.some((o) => o.status === "fail");
    // A non-zero exit with no outcomes that is not a clean "no test files"
    // result means the suite could not load or collect. Surfacing this stops a
    // load error from masquerading as a pass via an empty outcome set.
    const failedToRun =
      result.code !== 0 && outcomes.length === 0 && !noTests;

    return {
      passed,
      noTests,
      failedToRun,
      outcomes,
      exitCode: result.code,
      stderr: result.stderr,
    };
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
}
