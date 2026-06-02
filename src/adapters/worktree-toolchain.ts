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
  /** True when the mutation tooling was overlaid (the kill-check can run). */
  readonly mutationReady: boolean;
}

const INSTALL_TIMEOUT_MS = 600_000;
const COMMON_FLAGS = ["--no-audit", "--no-fund", "--legacy-peer-deps"];

/**
 * Stryker version whose vitest-runner matches the repo's installed vitest. The
 * runner drives the repo's OWN vitest, so the overlaid Stryker has to match it:
 * the 9.x runner peers vitest>=2 and the 8.7 runner supports vitest 1.x and 0.x.
 * Overlaying a 9.x runner onto a vitest-1 repo is unresolvable, which is the
 * real-world break this avoids.
 *
 * @param vitestMajor - the repo's installed vitest major version, or null.
 * @returns the Stryker core and vitest-runner version to install.
 */
function strykerVersionFor(vitestMajor: number | null): string {
  return vitestMajor !== null && vitestMajor < 2 ? "8.7.1" : "9.6.1";
}

/** Read the repo's installed vitest major version, or null when absent. */
async function repoVitestMajor(worktreeDir: string): Promise<number | null> {
  try {
    const raw = await readFile(
      join(worktreeDir, "node_modules", "vitest", "package.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version !== "string") return null;
    const major = Number.parseInt(parsed.version.split(".")[0] ?? "", 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

/** The install command for a strategy: the package manager's own install. */
function installCommand(strategy: InstallStrategy): {
  cmd: string;
  args: string[];
} {
  switch (strategy) {
    case "npm-ci":
      return { cmd: "npm", args: ["ci", ...COMMON_FLAGS] };
    case "pnpm":
      // Respect the lockfile; pnpm resolves workspace: deps npm cannot. Hoist
      // the layout flat so Stryker (overlaid later) can resolve its plugin and
      // the repo's vitest from a single node_modules.
      return {
        cmd: "pnpm",
        args: ["install", "--frozen-lockfile", "--config.node-linker=hoisted"],
      };
    case "yarn":
      return { cmd: "yarn", args: ["install"] };
    case "npm-install":
    case "symlink":
      return { cmd: "npm", args: ["install", ...COMMON_FLAGS] };
  }
}

/** Run an install command, returning null when its binary is not on PATH. */
async function tryInstall(
  worktreeDir: string,
  cmd: string,
  args: readonly string[],
): Promise<{ code: number; stderr: string } | null> {
  try {
    return await exec(cmd, args, {
      cwd: worktreeDir,
      timeoutMs: INSTALL_TIMEOUT_MS,
      allowNonZero: true,
    });
  } catch {
    // The package manager is not installed (spawn failed).
    return null;
  }
}

/**
 * Install the repo's dependencies with its own package manager, falling back to
 * a plain npm install when that manager is unavailable or its frozen install
 * fails (a missing pnpm/yarn binary, or a lockfile out of sync with
 * package.json). The fallback keeps a real repo running; a workspace repo that
 * genuinely needs pnpm and has no pnpm still fails here and degrades to WARN.
 */
async function installRepoDeps(
  worktreeDir: string,
  strategy: InstallStrategy,
): Promise<void> {
  const primary = installCommand(strategy);
  let result = await tryInstall(worktreeDir, primary.cmd, primary.args);
  if (!result || result.code !== 0) {
    result = await tryInstall(worktreeDir, "npm", ["install", ...COMMON_FLAGS]);
  }
  if (!result || result.code !== 0) {
    const detail = result ? result.stderr.trim().slice(0, 600) : `${primary.cmd} is not installed`;
    throw new Error(
      `dependency install failed in ${worktreeDir} (strategy ${strategy}); the repo's dependencies could not be installed. ${detail}`,
    );
  }
}

/**
 * Candidate overlay commands, in order, for adding the Stryker packages with
 * the repo's own package manager. npm cannot operate on a pnpm or yarn
 * node_modules (the "link:" protocol and the symlinked store are unsupported),
 * so the overlay has to match the install. A workspace variant is tried first
 * for pnpm/yarn (a single-package repo rejects it, so the plain form follows).
 */
function overlayCommands(
  strategy: InstallStrategy,
  specs: readonly string[],
): ReadonlyArray<{ cmd: string; args: string[] }> {
  switch (strategy) {
    case "pnpm":
      return [
        { cmd: "pnpm", args: ["add", "-w", "--save-dev", "--config.node-linker=hoisted", ...specs] },
        { cmd: "pnpm", args: ["add", "--save-dev", "--config.node-linker=hoisted", ...specs] },
      ];
    case "yarn":
      return [
        { cmd: "yarn", args: ["add", "-D", "-W", ...specs] },
        { cmd: "yarn", args: ["add", "-D", ...specs] },
      ];
    case "npm-ci":
    case "npm-install":
    case "symlink":
      return [{ cmd: "npm", args: ["install", "--no-save", ...COMMON_FLAGS, ...specs] }];
  }
}

/**
 * Overlay the Stryker tooling into the repo's node_modules, version-matched to
 * the repo's vitest and using the repo's own package manager. Non-fatal: the
 * kill-check is one check among many, so an overlay failure must not abort the
 * run. It returns whether the overlay succeeded; on failure the pipeline has no
 * Stryker binary and the kill-check degrades to WARN.
 *
 * @param worktreeDir - the worktree to overlay into; deps must be installed.
 * @param strategy - the install strategy, to pick the matching overlay command.
 * @returns true when the mutation tooling is in place.
 */
async function overlayMutationTooling(
  worktreeDir: string,
  strategy: InstallStrategy,
): Promise<boolean> {
  const version = strykerVersionFor(await repoVitestMajor(worktreeDir));
  const specs = [
    `@stryker-mutator/core@${version}`,
    `@stryker-mutator/vitest-runner@${version}`,
  ];
  for (const { cmd, args } of overlayCommands(strategy, specs)) {
    const result = await exec(cmd, args, {
      cwd: worktreeDir,
      timeoutMs: INSTALL_TIMEOUT_MS,
      allowNonZero: true,
    }).catch(() => null);
    if (result && result.code === 0) return true;
  }
  process.stderr.write(
    `claimcheck: could not overlay mutation tooling (${specs.join(", ")}) into ${worktreeDir}; the kill-check will not run.\n`,
  );
  return false;
}

/**
 * Prepare one worktree's toolchain according to its declared dependencies. The
 * dependency install is required (the tests cannot run without it); the
 * mutation overlay is best-effort (only the kill-check needs it).
 *
 * @param worktreeDir - the worktree to prepare.
 * @param toolchainModules - ClaimCheck's node_modules, for the symlink path.
 * @returns the chosen strategy, whether a real install ran, and whether the
 *   mutation tooling is in place.
 */
export async function prepareToolchain(
  worktreeDir: string,
  toolchainModules: string,
): Promise<ToolchainPrep> {
  const info = await inspectRepoInstall(worktreeDir);
  const strategy = chooseInstallStrategy(info);
  if (strategy === "symlink") {
    await linkNodeModules(worktreeDir, toolchainModules);
    return { strategy, installed: false, mutationReady: true };
  }
  await installRepoDeps(worktreeDir, strategy);
  const mutationReady = await overlayMutationTooling(worktreeDir, strategy);
  return { strategy, installed: true, mutationReady };
}
