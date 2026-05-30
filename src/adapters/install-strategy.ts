import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

/**
 * Decide how to make a target worktree's dependencies available before
 * ClaimCheck runs its tests in it. The dependency-free corpus borrows
 * ClaimCheck's own toolchain by symlink, which keeps the hermetic suite offline
 * and deterministic. A real repository declares its own dependencies and must
 * be installed with its own lockfile, or the test runner cannot resolve the
 * modules under test (the failure observed against unjs/defu, whose tests
 * import expect-type and a fixtures directory absent from ClaimCheck).
 */

/**
 * - `npm-ci`: the repo declares dependencies and ships an npm lockfile; install
 *   reproducibly from it.
 * - `npm-install`: the repo declares dependencies but ships no npm lockfile
 *   (for example a pnpm or yarn lockfile); install from package.json.
 * - `symlink`: the repo declares no dependencies; borrow ClaimCheck's toolchain.
 */
export type InstallStrategy = "npm-ci" | "npm-install" | "symlink";

export interface RepoInstallInfo {
  /** True when package.json lists any dependencies or devDependencies. */
  readonly declaresDependencies: boolean;
  /** The npm lockfile name if present, else null. */
  readonly npmLockfile: string | null;
}

/** Lockfiles npm can install reproducibly from, in precedence order. */
const NPM_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"] as const;

/**
 * Choose an install strategy from a repo's declared dependencies and lockfile.
 * Pure: same info in, same strategy out.
 *
 * @param info - whether the repo declares dependencies and its npm lockfile.
 * @returns the strategy to prepare the worktree with.
 */
export function chooseInstallStrategy(info: RepoInstallInfo): InstallStrategy {
  if (!info.declaresDependencies) return "symlink";
  return info.npmLockfile !== null ? "npm-ci" : "npm-install";
}

interface PackageJsonShape {
  dependencies?: unknown;
  devDependencies?: unknown;
}

/** Does an object hold at least one own key? */
function hasAnyKey(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value as Record<string, unknown>).length > 0
  );
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
 * Inspect a worktree's package.json and lockfiles to build the install info the
 * strategy decision needs.
 *
 * @param worktreeDir - the worktree to inspect.
 * @returns whether it declares dependencies and which npm lockfile it ships.
 */
export async function inspectRepoInstall(
  worktreeDir: string,
): Promise<RepoInstallInfo> {
  let declaresDependencies = false;
  try {
    const raw = await readFile(join(worktreeDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as PackageJsonShape;
    declaresDependencies =
      hasAnyKey(pkg.dependencies) || hasAnyKey(pkg.devDependencies);
  } catch {
    // No package.json (or unparseable): nothing to install.
    return { declaresDependencies: false, npmLockfile: null };
  }
  let npmLockfile: string | null = null;
  for (const name of NPM_LOCKFILES) {
    if (await exists(join(worktreeDir, name))) {
      npmLockfile = name;
      break;
    }
  }
  return { declaresDependencies, npmLockfile };
}
