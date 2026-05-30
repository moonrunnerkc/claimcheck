import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "../util/exec.js";
import { linkNodeModules } from "../git/worktree.js";
import {
  chooseInstallStrategy,
  inspectRepoInstall,
  type InstallStrategy,
} from "./install-strategy.js";

/**
 * Prepare a worktree's node_modules so the target's tests can run. This is the
 * production fix for the borrowed-toolchain limitation: a dependency-free repo
 * (the corpus) borrows ClaimCheck's toolchain by symlink and stays offline,
 * while a real repo is installed with its own lockfile so the runner resolves
 * the modules under test. After a real install, ClaimCheck's mutation tooling
 * is overlaid into the repo's node_modules so the kill-check runs Stryker
 * against the repo's OWN vitest, co-located, rather than ClaimCheck's.
 *
 * The install path is networked and is deliberately never exercised by the
 * hermetic corpus suite, which only ever takes the symlink branch.
 */

export interface ToolchainPrep {
  readonly strategy: InstallStrategy;
  /** True when a real dependency install ran (the networked path). */
  readonly installed: boolean;
}

/** Mutation packages overlaid into a real-installed worktree for the kill-check. */
const MUTATION_PACKAGES = [
  "@stryker-mutator/core",
  "@stryker-mutator/vitest-runner",
] as const;

const INSTALL_TIMEOUT_MS = 600_000;
const COMMON_FLAGS = ["--no-audit", "--no-fund", "--legacy-peer-deps"];

/** Read the version of a package installed in ClaimCheck's toolchain. */
async function toolchainVersion(
  toolchainModules: string,
  pkg: string,
): Promise<string | null> {
  try {
    const raw = await readFile(
      join(toolchainModules, pkg, "package.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Run the repo's own dependency install, falling back from ci to install. */
async function installRepoDeps(
  worktreeDir: string,
  strategy: InstallStrategy,
): Promise<void> {
  const verb = strategy === "npm-ci" ? "ci" : "install";
  let result = await exec("npm", [verb, ...COMMON_FLAGS], {
    cwd: worktreeDir,
    timeoutMs: INSTALL_TIMEOUT_MS,
    allowNonZero: true,
  });
  // npm ci aborts when the lockfile is out of sync with package.json; the
  // honest fallback is a plain install so a real repo still runs.
  if (result.code !== 0 && verb === "ci") {
    result = await exec("npm", ["install", ...COMMON_FLAGS], {
      cwd: worktreeDir,
      timeoutMs: INSTALL_TIMEOUT_MS,
      allowNonZero: true,
    });
  }
  if (result.code !== 0) {
    throw new Error(
      `npm ${verb} failed in ${worktreeDir}; the repo's dependencies could not be installed. npm said: ${result.stderr.trim().slice(0, 600)}`,
    );
  }
}

/** Overlay ClaimCheck's Stryker tooling into the repo's node_modules. */
async function overlayMutationTooling(
  worktreeDir: string,
  toolchainModules: string,
): Promise<void> {
  const specs: string[] = [];
  for (const pkg of MUTATION_PACKAGES) {
    const version = await toolchainVersion(toolchainModules, pkg);
    specs.push(version ? `${pkg}@${version}` : pkg);
  }
  const result = await exec(
    "npm",
    ["install", "--no-save", ...COMMON_FLAGS, ...specs],
    { cwd: worktreeDir, timeoutMs: INSTALL_TIMEOUT_MS, allowNonZero: true },
  );
  if (result.code !== 0) {
    throw new Error(
      `could not overlay mutation tooling (${specs.join(", ")}) into ${worktreeDir}; the kill-check would not run. npm said: ${result.stderr.trim().slice(0, 400)}`,
    );
  }
}

/**
 * Prepare one worktree's toolchain according to its declared dependencies.
 *
 * @param worktreeDir - the worktree to prepare.
 * @param toolchainModules - ClaimCheck's node_modules, for the symlink path and
 *   for pinning the overlaid mutation tooling to the same versions.
 * @returns the chosen strategy and whether a real install ran.
 */
export async function prepareToolchain(
  worktreeDir: string,
  toolchainModules: string,
): Promise<ToolchainPrep> {
  const info = await inspectRepoInstall(worktreeDir);
  const strategy = chooseInstallStrategy(info);
  if (strategy === "symlink") {
    await linkNodeModules(worktreeDir, toolchainModules);
    return { strategy, installed: false };
  }
  await installRepoDeps(worktreeDir, strategy);
  await overlayMutationTooling(worktreeDir, toolchainModules);
  return { strategy, installed: true };
}
