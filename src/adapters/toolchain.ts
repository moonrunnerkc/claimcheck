import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate ClaimCheck's own node_modules so it can be linked into target
 * worktrees. The target repos in the corpus carry no dependencies; they borrow
 * the test runner and coverage provider from the tool itself.
 */

async function hasVitest(dir: string): Promise<boolean> {
  try {
    await access(join(dir, "node_modules", ".bin", "vitest"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk up from this module to find the directory whose node_modules contains
 * the vitest binary.
 *
 * @returns the absolute path to that node_modules directory.
 * @throws if no node_modules with vitest is found up to the filesystem root.
 */
export async function findToolchainModules(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (await hasVitest(dir)) return join(dir, "node_modules");
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        "could not locate a node_modules containing vitest; run \"npm ci\" in the ClaimCheck checkout",
      );
    }
    dir = parent;
  }
}
