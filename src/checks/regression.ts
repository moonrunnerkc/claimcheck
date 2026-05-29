import { runVitest } from "../adapters/vitest-run.js";

/**
 * Differential regression. The tests the PR did not touch, that passed on the
 * parent, must still pass on head. One that flipped to failing is a regression:
 * the PR fixed the asked thing and quietly broke something else.
 *
 * Only assertion-level failures count. A test file that fails to load on head
 * is ambiguous and is left out, so an environmental hiccup never becomes a
 * false block. Quarantined tests are excluded entirely.
 */

export interface RegressionOptions {
  readonly parentDir: string;
  readonly headDir: string;
  /** All test files tracked at the parent commit, repo-relative. */
  readonly parentTestFiles: readonly string[];
  /** Test files the PR added or modified, repo-relative. */
  readonly changedTestFiles: readonly string[];
  /** Quarantined test names to exclude from the regression set. */
  readonly quarantinedTests: ReadonlySet<string>;
  readonly configFile: string;
}

/**
 * Find tests that passed on the parent and now fail on head.
 *
 * @param options - parent and head worktrees, the parent test set, the changed
 *   test set to exclude, quarantined names, and the sandbox config.
 * @returns the names of regressed tests, sorted.
 */
export async function runRegression(
  options: RegressionOptions,
): Promise<string[]> {
  const changed = new Set(options.changedTestFiles);
  const unchanged = options.parentTestFiles.filter((f) => !changed.has(f));
  if (unchanged.length === 0) return [];

  const parentRun = await runVitest({
    cwd: options.parentDir,
    testFiles: unchanged,
    configFile: options.configFile,
  });
  const headRun = await runVitest({
    cwd: options.headDir,
    testFiles: unchanged,
    configFile: options.configFile,
  });

  const passedOnParent = new Set(
    parentRun.outcomes.filter((o) => o.status === "pass").map((o) => o.name),
  );
  const failedOnHead = new Set(
    headRun.outcomes.filter((o) => o.status === "fail").map((o) => o.name),
  );

  const regressed: string[] = [];
  for (const name of passedOnParent) {
    if (failedOnHead.has(name) && !options.quarantinedTests.has(name)) {
      regressed.push(name);
    }
  }
  return regressed.sort((a, b) => a.localeCompare(b));
}
