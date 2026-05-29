import { mkdtemp, rm, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, removeWorktree, revParse } from "./git.js";

/**
 * Isolated parent and head worktrees for a repository, created without touching
 * the checkout the user is on. Both are detached at their respective commits so
 * the pipeline can read and run each side of the change independently.
 */
export interface Worktrees {
  readonly baseSha: string;
  readonly headSha: string;
  /** Worktree checked out at the parent commit. */
  readonly parentDir: string;
  /** Worktree checked out at the head commit. */
  readonly headDir: string;
  /** Remove both worktrees and the scratch directory. */
  cleanup(): Promise<void>;
}

/** Does a path exist? */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make a node_modules available inside a worktree by symlinking a toolchain's
 * node_modules into it, so the target repo's tests can resolve the test runner
 * without a per-worktree install. No-op if the worktree already has one.
 *
 * @param worktreeDir - the worktree to link into.
 * @param toolchainModules - absolute path to a node_modules directory to link.
 */
export async function linkNodeModules(
  worktreeDir: string,
  toolchainModules: string,
): Promise<void> {
  const target = join(worktreeDir, "node_modules");
  if (await exists(target)) return;
  if (!(await exists(toolchainModules))) {
    throw new Error(
      `toolchain node_modules not found at ${toolchainModules}; run "npm ci" first`,
    );
  }
  await symlink(toolchainModules, target, "dir");
}

/**
 * Create detached parent and head worktrees for a repository in a fresh scratch
 * directory.
 *
 * @param repoPath - path to the source repository.
 * @param base - the parent ref or SHA.
 * @param head - the head ref or SHA.
 * @returns the worktrees and a cleanup callback.
 */
export async function createWorktrees(
  repoPath: string,
  base: string,
  head: string,
): Promise<Worktrees> {
  const baseSha = await revParse(repoPath, base);
  const headSha = await revParse(repoPath, head);
  const scratch = await mkdtemp(join(tmpdir(), "claimcheck-wt-"));
  const parentDir = join(scratch, "parent");
  const headDir = join(scratch, "head");

  await addWorktree(repoPath, parentDir, baseSha);
  await addWorktree(repoPath, headDir, headSha);

  return {
    baseSha,
    headSha,
    parentDir,
    headDir,
    cleanup: async () => {
      await removeWorktree(repoPath, parentDir);
      await removeWorktree(repoPath, headDir);
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
