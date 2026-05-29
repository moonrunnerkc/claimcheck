import { checkoutPathsFrom } from "../git/git.js";
import { runVitest } from "../adapters/vitest-run.js";

/**
 * The fails-on-parent harness. It applies only the test-file portion of the
 * diff onto the parent worktree and runs the new tests there. A test that fails
 * on the unfixed parent caught the bug; a test that passes did not exercise it;
 * a test that cannot even run on the parent (it references symbols the PR
 * introduces) is indeterminate, never a block.
 */

export type FailsOnParentOutcome = "failed" | "passed" | "indeterminate";

export interface FailsOnParentOptions {
  /** Parent worktree directory; node_modules must be linked. */
  readonly parentDir: string;
  /** The head commit SHA to take the test files from. */
  readonly headSha: string;
  /** New or modified test files, repo-relative. */
  readonly testFiles: readonly string[];
  /** Vitest config to load, relative to the parent worktree. */
  readonly configFile?: string;
}

/**
 * Apply the head test files onto the parent and report whether they fail.
 *
 * @param options - parent worktree, head SHA, test files, env.
 * @returns "failed" (healthy), "passed" (test did not test the bug), or
 *   "indeterminate" (the test could not run on the parent).
 */
export async function runFailsOnParent(
  options: FailsOnParentOptions,
): Promise<FailsOnParentOutcome> {
  if (options.testFiles.length === 0) return "indeterminate";

  await checkoutPathsFrom(options.parentDir, options.headSha, options.testFiles);
  const result = await runVitest({
    cwd: options.parentDir,
    testFiles: options.testFiles,
    ...(options.configFile ? { configFile: options.configFile } : {}),
  });

  if (result.noTests) return "indeterminate";
  const failed = result.outcomes.filter((o) => o.status === "fail");
  const ran = result.outcomes.filter((o) => o.status !== "skip");

  // Outcomes were collected and at least one assertion failed: the test caught
  // the bug on the parent.
  if (failed.length > 0) return "failed";
  // Outcomes were collected and all ran and passed: the test passes on the
  // unfixed parent, so it does not constrain the bug.
  if (ran.length > 0) return "passed";
  // No assertion outcomes but a non-zero exit: the suite could not run on the
  // parent (a load or compile error from PR-introduced symbols).
  if (result.exitCode !== 0) return "indeterminate";
  return "indeterminate";
}
