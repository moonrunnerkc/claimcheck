import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseInstallStrategy,
  inspectRepoInstall,
} from "./install-strategy.js";

describe("chooseInstallStrategy", () => {
  it("symlinks when the repo declares no dependencies", () => {
    expect(
      chooseInstallStrategy({ declaresDependencies: false, npmLockfile: null }),
    ).toBe("symlink");
  });

  it("uses npm ci when a lockfile is present", () => {
    expect(
      chooseInstallStrategy({
        declaresDependencies: true,
        npmLockfile: "package-lock.json",
      }),
    ).toBe("npm-ci");
  });

  it("falls back to npm install when deps are declared but no npm lockfile exists", () => {
    expect(
      chooseInstallStrategy({ declaresDependencies: true, npmLockfile: null }),
    ).toBe("npm-install");
  });
});

describe("inspectRepoInstall", () => {
  async function fixture(
    files: Record<string, string>,
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "claimcheck-inspect-"));
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(dir, name), body, "utf8");
    }
    return dir;
  }

  it("reports a dependency-free package as symlink-eligible", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ name: "x" }) });
    try {
      const info = await inspectRepoInstall(dir);
      expect(info.declaresDependencies).toBe(false);
      expect(chooseInstallStrategy(info)).toBe("symlink");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects declared devDependencies and an npm lockfile", async () => {
    const dir = await fixture({
      "package.json": JSON.stringify({ devDependencies: { vitest: "^1" } }),
      "package-lock.json": "{}",
    });
    try {
      const info = await inspectRepoInstall(dir);
      expect(info.declaresDependencies).toBe(true);
      expect(info.npmLockfile).toBe("package-lock.json");
      expect(chooseInstallStrategy(info)).toBe("npm-ci");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a non-npm lockfile (pnpm) as npm-install", async () => {
    const dir = await fixture({
      "package.json": JSON.stringify({ dependencies: { defu: "^6" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    try {
      const info = await inspectRepoInstall(dir);
      expect(info.npmLockfile).toBeNull();
      expect(chooseInstallStrategy(info)).toBe("npm-install");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles a missing package.json as nothing to install", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claimcheck-inspect-"));
    try {
      const info = await inspectRepoInstall(dir);
      expect(info).toEqual({ declaresDependencies: false, npmLockfile: null });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
