import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runVitest, type VitestResult } from "../adapters/vitest-run.js";
import { scopedSandboxConfig } from "../determinism/sandbox.js";

/**
 * Running a synthesized repro and classifying its outcome, shared by every
 * oracle that executes code rather than living in one oracle.
 *
 * The classification rule is general and load-bearing: a repro that threw before
 * exercising the code under test, or that could not be collected, did NOT
 * reproduce anything. It failed to run, which is a warning with a reason, never
 * a satisfied or a violated verdict. This is the same discipline as the
 * hollow-PASS guard on the agent's own tests: an execution that never tested
 * anything must never be read as a meaningful result. Reading a thrown
 * ReferenceError as "the reporter's invariant failed" is the hollow false-BLOCK.
 */

/** The filename a synthesized repro test is written to inside a worktree. */
export const REPRO_TEST_FILE = "claimcheck.repro.test.ts";
/** The scoped vitest config the repro runs under, pinning the sandbox. */
export const REPRO_CONFIG_FILE = "claimcheck.repro.vitest.config.ts";

/**
 * Outcome of executing a repro once. `errored` means it failed to run (a throw
 * before the code under test, or a collection failure), kept distinct from
 * `fail`, which is an assertion that ran and failed.
 */
export type ReproOutcome = "pass" | "fail" | "errored";

/**
 * Failure-message signatures that mean the code did not run, as opposed to an
 * assertion that ran and failed. Each maps to a stable, path-free token so any
 * recorded reason is deterministic and never leaks a machine path or a stack.
 */
const DID_NOT_RUN_SIGNATURES: ReadonlyArray<{
  readonly token: string;
  readonly re: RegExp;
}> = [
  { token: "reference-error", re: /\bReferenceError\b|\bis not defined\b/ },
  { token: "syntax-error", re: /\bSyntaxError\b/ },
  {
    token: "module-not-found",
    re: /Cannot find (?:module|package)|Failed to resolve (?:import|entry)|ERR_MODULE_NOT_FOUND|Failed to load url/,
  },
];

/**
 * Classify one failing outcome's runner messages as a did-not-run error.
 *
 * @param messages - the runner's failure messages for a single failing outcome.
 * @returns a stable token naming the did-not-run cause (for example
 *   "reference-error"), or null when the failure is a genuine assertion failure.
 */
export function didNotRunReason(messages: readonly string[]): string | null {
  const text = messages.join("\n");
  for (const sig of DID_NOT_RUN_SIGNATURES) {
    if (sig.re.test(text)) return sig.token;
  }
  return null;
}

/**
 * Classify a whole vitest run into a single repro outcome. A run that failed to
 * load, found no test, or produced no outcome errored. A failing outcome whose
 * failure is a non-assertion runtime error (it threw before testing anything)
 * errored, never `fail`: reading that throw as a failed invariant is the hollow
 * false-verdict bug. A run with a real assertion failure is `fail`; a passing
 * run is `pass`.
 *
 * @param result - the parsed runner result.
 * @returns the repro outcome.
 */
export function classifyRun(result: VitestResult): ReproOutcome {
  if (result.failedToRun || result.noTests || result.outcomes.length === 0) {
    return "errored";
  }
  const failing = result.outcomes.filter((o) => o.status === "fail");
  // A failing outcome that threw a non-assertion runtime error means the repro
  // did not run as a test; one such outcome taints the whole run.
  if (failing.some((o) => didNotRunReason(o.failureMessages ?? []) !== null)) {
    return "errored";
  }
  if (failing.length > 0) return "fail";
  if (result.outcomes.some((o) => o.status === "pass")) return "pass";
  return "errored";
}

/** Write the repro test and its scoped sandbox config into a worktree. */
async function writeReproFiles(
  worktreeDir: string,
  testSource: string,
): Promise<{ testPath: string; configPath: string }> {
  const testPath = join(worktreeDir, REPRO_TEST_FILE);
  const configPath = join(worktreeDir, REPRO_CONFIG_FILE);
  await writeFile(testPath, testSource, "utf8");
  const configBody = await scopedSandboxConfig(worktreeDir, [REPRO_TEST_FILE]);
  await writeFile(configPath, configBody, "utf8");
  return { testPath, configPath };
}

/**
 * Run the synthesized repro once inside a worktree under the sandbox, then
 * remove it so it never leaks into another step's discovery.
 *
 * @param worktreeDir - the worktree to run in; node_modules must be linked.
 * @param testSource - the runnable vitest test source.
 * @returns whether the repro passed, failed, or could not be executed.
 */
export async function runReproOnce(
  worktreeDir: string,
  testSource: string,
): Promise<ReproOutcome> {
  const { testPath, configPath } = await writeReproFiles(worktreeDir, testSource);
  try {
    const result = await runVitest({
      cwd: worktreeDir,
      testFiles: [REPRO_TEST_FILE],
      configFile: REPRO_CONFIG_FILE,
    });
    return classifyRun(result);
  } finally {
    await rm(testPath, { force: true });
    await rm(configPath, { force: true });
  }
}
