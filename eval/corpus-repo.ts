import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.js";

/**
 * Materialize a corpus case into a throwaway git repository with two commits:
 * the parent tree then the head tree. Commit metadata is pinned to fixed
 * identities and dates so the resulting SHAs are reproducible, which is what
 * lets the bundle hash be stable across runs of the same case.
 */

export interface MaterializedRepo {
  readonly repoPath: string;
  readonly baseSha: string;
  readonly headSha: string;
  /** Remove the temporary repository. */
  cleanup(): Promise<void>;
}

/** Fixed git identity and clock so commit SHAs are deterministic. */
const COMMIT_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "ClaimCheck Corpus",
  GIT_AUTHOR_EMAIL: "corpus@claimcheck.invalid",
  GIT_COMMITTER_NAME: "ClaimCheck Corpus",
  GIT_COMMITTER_EMAIL: "corpus@claimcheck.invalid",
  GIT_AUTHOR_DATE: "2020-01-01T00:00:00 +0000",
  GIT_COMMITTER_DATE: "2020-01-01T00:00:00 +0000",
};

async function gitIn(
  repoPath: string,
  args: readonly string[],
): Promise<string> {
  const result = await exec("git", args, { cwd: repoPath, env: COMMIT_ENV });
  return result.stdout.trim();
}

/** Copy the contents of a directory into the repo, then stage everything. */
async function copyTreeInto(treeDir: string, repoPath: string): Promise<void> {
  const entries = await readdir(treeDir, { withFileTypes: true });
  for (const entry of entries) {
    await cp(join(treeDir, entry.name), join(repoPath, entry.name), {
      recursive: true,
    });
  }
}

/** Delete the working tree contents except the .git directory. */
async function clearWorkingTree(repoPath: string): Promise<void> {
  const entries = await readdir(repoPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    await rm(join(repoPath, entry.name), { recursive: true, force: true });
  }
}

/**
 * Build a two-commit repository from a case directory containing `parent/` and
 * `head/` subtrees.
 *
 * @param caseDir - absolute path to the case directory.
 * @returns the repo path, the parent and head SHAs, and a cleanup callback.
 */
export async function materializeCase(caseDir: string): Promise<MaterializedRepo> {
  const repoPath = await mkdtemp(join(tmpdir(), "claimcheck-corpus-"));
  await gitIn(repoPath, ["init", "-q", "-b", "main"]);

  await copyTreeInto(join(caseDir, "parent"), repoPath);
  await gitIn(repoPath, ["add", "-A"]);
  await gitIn(repoPath, ["commit", "-q", "-m", "parent: pre-fix state"]);
  const baseSha = await gitIn(repoPath, ["rev-parse", "HEAD"]);

  await clearWorkingTree(repoPath);
  await copyTreeInto(join(caseDir, "head"), repoPath);
  await gitIn(repoPath, ["add", "-A"]);
  await gitIn(repoPath, ["commit", "-q", "-m", "head: claimed fix"]);
  const headSha = await gitIn(repoPath, ["rev-parse", "HEAD"]);

  return {
    repoPath,
    baseSha,
    headSha,
    cleanup: () => rm(repoPath, { recursive: true, force: true }),
  };
}
