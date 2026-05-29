import { exec } from "../util/exec.js";

/**
 * Thin, deterministic wrapper over the git CLI. Every call pins the
 * environment through {@link exec} so output does not vary by locale or config
 * noise. These are the primitives the worktree and diff layers build on.
 */

/** Run git in a repository and return stdout, trimmed of the trailing newline. */
async function git(
  repoPath: string,
  args: readonly string[],
  allowNonZero = false,
): Promise<string> {
  const result = await exec("git", args, { cwd: repoPath, allowNonZero });
  return result.stdout.replace(/\n$/, "");
}

/**
 * Resolve a ref (branch, tag, or SHA) to its full commit SHA.
 *
 * @param repoPath - path to the git repository.
 * @param ref - the ref to resolve.
 * @returns the 40-character commit SHA.
 * @throws if the ref does not resolve.
 */
export async function revParse(repoPath: string, ref: string): Promise<string> {
  const sha = await git(repoPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      `git rev-parse did not return a commit SHA for "${ref}"; got "${sha}". Check the ref exists in this repository.`,
    );
  }
  return sha;
}

/**
 * Create a detached worktree of a repository at a specific commit.
 *
 * @param repoPath - path to the source repository.
 * @param worktreeDir - directory to create the worktree in; must not exist.
 * @param sha - the commit to check out.
 */
export async function addWorktree(
  repoPath: string,
  worktreeDir: string,
  sha: string,
): Promise<void> {
  await git(repoPath, ["worktree", "add", "--detach", worktreeDir, sha]);
}

/**
 * Remove a worktree created by {@link addWorktree}, forcing past dirty state.
 *
 * @param repoPath - path to the source repository.
 * @param worktreeDir - the worktree directory to remove.
 */
export async function removeWorktree(
  repoPath: string,
  worktreeDir: string,
): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", worktreeDir], true);
}

/**
 * Produce the unified diff between two commits, optionally restricted to a set
 * of pathspecs. Uses zero context and no color so the patch parses cleanly.
 *
 * @param repoPath - path to the repository.
 * @param base - the parent commit.
 * @param head - the head commit.
 * @param pathspecs - optional path filter; all paths when omitted.
 * @returns the raw unified diff text.
 */
export async function unifiedDiff(
  repoPath: string,
  base: string,
  head: string,
  pathspecs?: readonly string[],
): Promise<string> {
  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--unified=0",
    "--no-renames",
    base,
    head,
  ];
  if (pathspecs && pathspecs.length > 0) {
    args.push("--", ...pathspecs);
  }
  return git(repoPath, args, true);
}

/**
 * List the files changed between two commits with their status letters.
 *
 * @param repoPath - path to the repository.
 * @param base - the parent commit.
 * @param head - the head commit.
 * @returns one entry per changed file: status (A/M/D) and path.
 */
export async function changedFiles(
  repoPath: string,
  base: string,
  head: string,
): Promise<ReadonlyArray<{ status: string; path: string }>> {
  const out = await git(
    repoPath,
    ["diff", "--no-color", "--no-renames", "--name-status", base, head],
    true,
  );
  if (out.trim() === "") return [];
  return out
    .split("\n")
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status ?? "", path: rest.join("\t") };
    })
    .filter((e) => e.path !== "");
}

/**
 * List every file tracked at a commit.
 *
 * @param repoPath - path to the repository.
 * @param sha - the commit.
 * @returns repo-relative paths, sorted.
 */
export async function listFiles(
  repoPath: string,
  sha: string,
): Promise<string[]> {
  const out = await git(repoPath, ["ls-tree", "-r", "--name-only", sha], true);
  if (out.trim() === "") return [];
  return out.split("\n").filter((p) => p !== "").sort((a, b) => a.localeCompare(b));
}

/**
 * Check out specific paths from a commit into a worktree's working tree and
 * index, leaving the rest of the worktree untouched. Used to apply only the
 * test-file portion of a diff onto the parent for the fails-on-parent harness.
 *
 * @param worktreeDir - the worktree to mutate.
 * @param sha - the commit to take the paths from.
 * @param paths - repo-relative paths to check out.
 */
export async function checkoutPathsFrom(
  worktreeDir: string,
  sha: string,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  await git(worktreeDir, ["checkout", sha, "--", ...paths]);
}

/**
 * Read a file's contents at a specific commit.
 *
 * @param repoPath - path to the repository.
 * @param sha - the commit.
 * @param filePath - repo-relative path.
 * @returns the file contents, or null if the path does not exist at that commit.
 */
export async function showFile(
  repoPath: string,
  sha: string,
  filePath: string,
): Promise<string | null> {
  const result = await exec("git", ["show", `${sha}:${filePath}`], {
    cwd: repoPath,
    allowNonZero: true,
  });
  return result.code === 0 ? result.stdout : null;
}
