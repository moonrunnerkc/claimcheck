import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../src/util/exec.js";
import { runPipeline } from "../../src/core/pipeline.js";
import { fixClaim } from "../../src/core/claim.js";
import { extractRepro, issueReproOracle } from "../../src/oracle/issue-repro.js";
import { fetchIssueText } from "../../src/oracle/github-issue.js";
import type { ReproInput } from "../../src/oracle/oracle.js";

/**
 * Live case study for the issue-repro oracle against a real vitest repo
 * (unjs/defu) and the real bug it fixed: issue #119, "Objects exported with
 * '* as' export aren't merged recursively", fixed by PR #121 (commit 1b9fcab).
 * A `* as` namespace import is tagged `[object Module]`, and before the fix
 * isPlainObject excluded it, so defu dropped its keys on merge.
 *
 * The repro below is constructed faithfully from issue #119's own example:
 * merging a Module-tagged namespace nested under a key must keep that
 * namespace's keys. It is verified against defu's own behavior, not parsing:
 *   - parent (7c7a9a48): defu({pages:{bar:2}}, {pages:<module ns>}) yields
 *     {pages:{bar:2}}; the repro's assertion fails. The bug reproduces.
 *   - head (1b9fcab):   yields {pages:{foo:{nested:1},bar:2}}; the repro passes.
 * (Both confirmed by running the assertion under defu's vitest at each commit.)
 *
 * This tier is NOT part of the determinism guarantee: it clones a real repo,
 * installs it, and runs its vitest. It runs only via `npm run test:live`.
 */

const LIVE = process.env["CLAIMCHECK_LIVE"] === "1";
const DEFU = "https://github.com/unjs/defu";
const PARENT = "7c7a9a48ed675990c222101e623ccb7ba317d16e";
const FIX = "1b9fcab2c1479f0295a5f867c6ec36a01fda2dfb";

/** The reproduction, faithful to issue #119, as a self-contained vitest test. */
const ISSUE_119_REPRO: ReproInput = {
  kind: "repro-test",
  code: [
    'import { describe, it, expect } from "vitest";',
    'import { defu } from "./src/defu";',
    "",
    'describe("issue 119: namespace imports merge recursively", () => {',
    '  it("keeps the keys of a Module-tagged namespace", () => {',
    "    const ns: Record<string | symbol, unknown> = { foo: { nested: 1 } };",
    '    Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" });',
    "    const out = defu({ pages: { bar: 2 } }, { pages: ns });",
    "    expect(out).toEqual({ pages: { foo: { nested: 1 }, bar: 2 } });",
    "  });",
    "});",
  ].join("\n"),
};

/**
 * A plausible-but-wrong fix to isPlainObject: it splits the iterator and
 * toStringTag checks apart as if fixing the bug, but still returns false for a
 * Module-tagged object, so issue #119's repro still fails. It is behaviorally
 * identical to the parent, so the parent-era suite still passes on it. This is
 * the wrong-oracle shape: own tests pass, the reporter's repro does not.
 */
const WRONG_FIX_UTILS = `// Forked from sindresorhus/is-plain-obj (MIT)
// Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
export function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);

  if (
    prototype !== null &&
    prototype !== Object.prototype &&
    Object.getPrototypeOf(prototype) !== null
  ) {
    return false;
  }

  if (Symbol.iterator in value) {
    return false;
  }

  if (Symbol.toStringTag in value) {
    return false;
  }

  return true;
}
`;

const COMMIT_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "ClaimCheck Live",
  GIT_AUTHOR_EMAIL: "live@claimcheck.invalid",
  GIT_COMMITTER_NAME: "ClaimCheck Live",
  GIT_COMMITTER_EMAIL: "live@claimcheck.invalid",
  GIT_AUTHOR_DATE: "2020-01-01T00:00:00 +0000",
  GIT_COMMITTER_DATE: "2020-01-01T00:00:00 +0000",
};

describe.runIf(LIVE)("issue-repro oracle on a real vitest repo (unjs/defu#119)", () => {
  let repoPath: string;
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const c of cleanups.reverse()) await c();
  });

  async function clonedDefu(): Promise<string> {
    if (repoPath) return repoPath;
    const dir = await mkdtemp(join(tmpdir(), "claimcheck-live-oracle-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await exec("git", ["clone", "--no-tags", DEFU, dir], { timeoutMs: 300_000 });
    await exec("git", ["-C", dir, "cat-file", "-e", FIX], {});
    await exec("git", ["-C", dir, "cat-file", "-e", PARENT], {});
    repoPath = dir;
    return dir;
  }

  /** Build a wrong-fix commit on top of the parent and return its SHA. */
  async function wrongFixCommit(dir: string): Promise<string> {
    await exec("git", ["-C", dir, "checkout", "-q", "--detach", PARENT], {});
    await writeFile(join(dir, "src", "_utils.ts"), WRONG_FIX_UTILS, "utf8");
    await exec("git", ["-C", dir, "commit", "-q", "-am", "wrong fix: split symbol checks but still exclude Module"], { env: COMMIT_ENV });
    const sha = (await exec("git", ["-C", dir, "rev-parse", "HEAD"], {})).stdout.trim();
    await exec("git", ["-C", dir, "checkout", "-q", FIX], {});
    return sha;
  }

  it("does not false-block a real fix that satisfies the reporter's repro", async () => {
    const repo = await clonedDefu();
    const { verdict, record } = await runPipeline({
      repoPath: repo,
      base: PARENT,
      head: FIX,
      claim: fixClaim(),
      oracles: [issueReproOracle()],
      reproInput: ISSUE_119_REPRO,
    });

    const oracle = verdict.checks.find((c) => c.id === "oracle");
    expect(oracle?.tier).toBe("pass");

    const finding = record.oracleFindings?.find((f) => f.oracle === "issue-repro");
    expect(finding?.conclusion).toBe("satisfied");
    // Corroboration: the bug demonstrably reproduced on the parent.
    expect(finding?.evidence).toContain("parent=fail");
    expect(finding?.evidence).toContain("head=pass");
  });

  it("blocks a wrong fix whose own tests pass but fails the reporter's repro", async () => {
    const repo = await clonedDefu();
    const wrongFix = await wrongFixCommit(repo);
    const { verdict, record } = await runPipeline({
      repoPath: repo,
      base: PARENT,
      head: wrongFix,
      claim: fixClaim(),
      oracles: [issueReproOracle()],
      reproInput: ISSUE_119_REPRO,
    });

    const oracle = verdict.checks.find((c) => c.id === "oracle");
    expect(oracle?.tier).toBe("block");
    expect(verdict.tier).toBe("block");

    const finding = record.oracleFindings?.find((f) => f.oracle === "issue-repro");
    expect(finding?.conclusion).toBe("violated");
    expect(finding?.evidence).toContain("head=fail");
  });

  it("declines to guess: the real issue #119 body is present but not machine-extractable", async () => {
    // The networked path. Issue #119's only code fence is Nuxt-framework prose
    // with the expected/actual values written out in text, not an executable
    // assertion. The oracle must WARN, never fabricate an assertion from prose.
    const body = await fetchIssueText("unjs", "defu", 119);
    expect(body).toContain("namespace imports");
    expect(extractRepro({ kind: "issue-text", text: body }).kind).toBe(
      "not-extractable",
    );
  });
});
