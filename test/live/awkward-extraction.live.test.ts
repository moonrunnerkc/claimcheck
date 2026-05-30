import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../src/util/exec.js";
import { runPipeline } from "../../src/core/pipeline.js";
import { fixClaim } from "../../src/core/claim.js";
import { issueReproOracle } from "../../src/oracle/issue-repro.js";
import { fetchIssueText } from "../../src/oracle/github-issue.js";
import type { OracleContext, ReproInput } from "../../src/oracle/oracle.js";

/**
 * The awkward middle of repro extraction, against three real vitest-repo issues
 * chosen to break extraction rather than confirm it. Each issue's linked PR is a
 * real, merged bug fix whose parent reproduces the bug and whose head fixes it,
 * verified independently below by running a hand-authored faithful repro at each
 * commit. The question per case is not "does the fix work" (it does) but "does
 * extraction make the right call on the issue's machine-parseable content".
 *
 * This tier is NOT part of the determinism guarantee: it clones real repos and
 * runs their vitest. It runs only via `npm run test:live`.
 *
 * CASE A  rou3#124  (Shape 1: usage + output, no executable assertion)
 *   The repro is `console.log(findAllRoutes(...))` plus a ```sh``` output dump.
 *   Extraction must DECLINE (not-extractable, WARN), never fabricate an
 *   assertion from the console.log and the shown output. It does. CORRECT.
 *
 * CASE B  rou3#136  (Shape 2: partial repro, undefined imports and state)
 *   The repro is a test fragment that calls addRoute/removeRoute/findRoute on a
 *   `ctx` that the issue never creates and never imports (they live in the test
 *   file's beforeEach, not in the issue body). Extraction classifies it
 *   `runnable` because it carries `expect(...)`, synthesizes a test, and runs
 *   it. The synthesized test throws ReferenceError (ctx/addRoute undefined).
 *   The run-outcome classifier now reads a non-assertion throw as `errored`,
 *   not as a failed assertion, so the oracle declines with an honest evidence
 *   string ("repro failed to run") instead of fabricating a violation. The
 *   verdict is WARN. CORRECT. This was a hollow false-BLOCK before the
 *   classifier carried failure messages; the faithful repro below proves the
 *   fix is in fact correct, so WARN (not BLOCK, not satisfied) is the right
 *   call. The executed-the-code guard is exercised separately: a repro that
 *   runs green but touches none of the changed code also lands WARN.
 *
 * CASE C  defu#155  (Shape 3: multi-step, input not inlined)
 *   The repro is a 4-space-indented reproduce.mjs using `console.log(...)` and
 *   `// expected: false - actual: true` prose; the only fenced block is an empty
 *   ```sh```; the full PoC is in a private advisory. Extraction finds no JS
 *   fence with an assertion, returns `absent`, and the oracle ABSTAINS (null),
 *   contributing nothing. It does not fabricate an assertion from the prose.
 *   CORRECT, with one note: a repro is in fact present (indented), so the
 *   honest bucket is arguably not-extractable (WARN) rather than absent; the
 *   fenced-block scanner does not see indented code. Either way: no verdict, no
 *   fabrication.
 */

const LIVE = process.env["CLAIMCHECK_LIVE"] === "1";
const ROU3 = "https://github.com/unjs/rou3";

/** A GitHub token from the environment, if present, to lift the API rate limit. */
const TOKEN = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? undefined;

// rou3#124: findAllRoutes pulls in deeper param routes for an exact static hit.
const ROU3_124_PARENT = "122de5f432a6fd34418f966bb5fdee85de645745";
const ROU3_124_HEAD = "13c522ef283827b1f572d58c83492dcb1531424d";
// rou3#136: removeRoute does not remove a named wildcard route.
const ROU3_136_PARENT = "87f7125af7fdcdc8f41355a79069318d862eabc7";
const ROU3_136_HEAD = "379cfb6c088a83e2b88694833a39ef391d9a6838";

/** Faithful repro for #124, authored with the imports and ctx the issue omits. */
const ROU3_124_FAITHFUL: ReproInput = {
  kind: "repro-test",
  code: [
    'import { describe, it, expect } from "vitest";',
    'import { createRouter, addRoute, findAllRoutes } from "./src";',
    'describe("issue 124 faithful", () => {',
    '  it("an exact static match excludes deeper param routes", () => {',
    "    const ctx = createRouter();",
    '    addRoute(ctx, "get", "/path", "Static");',
    '    addRoute(ctx, "get", "/path/:name", "Param");',
    '    const all = findAllRoutes(ctx, "get", "/path");',
    '    expect(all.map((r) => r.data)).toEqual(["Static"]);',
    "  });",
    "});",
  ].join("\n"),
};

/** Faithful repro for #136, with the imports and ctx the issue fragment omits. */
const ROU3_136_FAITHFUL: ReproInput = {
  kind: "repro-test",
  code: [
    'import { describe, it, expect } from "vitest";',
    'import { createRouter, addRoute, findRoute, removeRoute } from "./src";',
    'describe("issue 136 faithful", () => {',
    '  it("removes a named wildcard route so it no longer matches", () => {',
    "    const ctx = createRouter();",
    '    addRoute(ctx, "GET", "/user/**:id");',
    '    removeRoute(ctx, "GET", "/user/**:id");',
    '    expect(findRoute(ctx, "GET", "/user/123")).toBeUndefined();',
    "  });",
    "});",
  ].join("\n"),
};

/** Build an oracle context that carries only issue text, for the decline path. */
function issueTextCtx(text: string): OracleContext {
  return {
    parentDir: "/nonexistent/parent",
    headDir: "/nonexistent/head",
    baseSha: "p",
    headSha: "h",
    changedRanges: [],
    configFile: "claimcheck.vitest.config.ts",
    prMetadata: { owner: null, repo: null, issueNumber: null },
    reproInput: { kind: "issue-text", text },
  };
}

describe.runIf(LIVE)("awkward repro extraction on real vitest repos", () => {
  let rou3Path = "";
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const c of cleanups.reverse()) await c();
  });

  async function clonedRou3(): Promise<string> {
    if (rou3Path) return rou3Path;
    const dir = await mkdtemp(join(tmpdir(), "claimcheck-awkward-rou3-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await exec("git", ["clone", "--no-tags", ROU3, dir], { timeoutMs: 300_000 });
    rou3Path = dir;
    return dir;
  }

  it("CASE A rou3#124: declines a usage-plus-output repro as not-machine-extractable (WARN)", async () => {
    const text = await fetchIssueText("unjs", "rou3", 124, TOKEN);
    const finding = await issueReproOracle().run(issueTextCtx(text));
    expect(finding?.conclusion).toBe("indeterminate");
    expect(finding?.evidence).toContain("repro present, not machine-extractable");
  });

  it("CASE A rou3#124: ground truth, a faithful repro fails on parent and passes on head", async () => {
    const repo = await clonedRou3();
    const { record } = await runPipeline({
      repoPath: repo,
      base: ROU3_124_PARENT,
      head: ROU3_124_HEAD,
      claim: fixClaim(),
      oracles: [issueReproOracle()],
      reproInput: ROU3_124_FAITHFUL,
    });
    const f = record.oracleFindings?.find((x) => x.oracle === "issue-repro");
    expect(f?.conclusion).toBe("satisfied");
    expect(f?.evidence).toContain("parent=fail");
    expect(f?.evidence).toContain("head=pass");
  }, 600_000);

  it("CASE B rou3#136: declines a partial repro that throws before exercising the code (WARN, honest evidence, no hollow BLOCK)", async () => {
    // The synthesized repro throws ReferenceError because ctx/addRoute/findRoute
    // /removeRoute are undefined in the issue fragment. The classifier reads
    // that throw as errored, so the oracle warns instead of fabricating a
    // violation, and the evidence string does not claim the bug reproduced.
    const repo = await clonedRou3();
    const text = await fetchIssueText("unjs", "rou3", 136, TOKEN);
    const { verdict, record } = await runPipeline({
      repoPath: repo,
      base: ROU3_136_PARENT,
      head: ROU3_136_HEAD,
      claim: fixClaim(),
      oracles: [issueReproOracle()],
      reproInput: { kind: "issue-text", text },
    });
    const f = record.oracleFindings?.find((x) => x.oracle === "issue-repro");
    expect(f?.conclusion).toBe("indeterminate");
    expect(f?.evidence).toContain("head=errored");
    expect(f?.evidence).toContain("repro failed to run, not an assertion failure");
    // The evidence must be honest: it must not claim the bug reproduced.
    expect(f?.evidence.join(" ")).not.toContain("reproduced");
    expect(verdict.tier).not.toBe("block");
  }, 600_000);

  it("CASE B rou3#136: the executed-the-code guard warns on a repro that passes but exercises no changed code", async () => {
    // A repro that runs green but touches none of the changed lines tested
    // nothing about the change. It must warn, not pass through as satisfied.
    const repo = await clonedRou3();
    const noop: ReproInput = {
      kind: "repro-test",
      code: 'import { expect, test } from "vitest";\ntest("noop", () => { expect(1 + 1).toBe(2); });\n',
    };
    const { record } = await runPipeline({
      repoPath: repo,
      base: ROU3_136_PARENT,
      head: ROU3_136_HEAD,
      claim: fixClaim(),
      oracles: [issueReproOracle()],
      reproInput: noop,
    });
    const f = record.oracleFindings?.find((x) => x.oracle === "issue-repro");
    expect(f?.conclusion).toBe("indeterminate");
    expect(f?.evidence).toContain("repro did not exercise the code under test");
  }, 600_000);

  it("CASE B rou3#136: ground truth, a faithful repro proves the fix is correct (satisfied, parent=fail)", async () => {
    const repo = await clonedRou3();
    const { record } = await runPipeline({
      repoPath: repo,
      base: ROU3_136_PARENT,
      head: ROU3_136_HEAD,
      claim: fixClaim(),
      oracles: [issueReproOracle()],
      reproInput: ROU3_136_FAITHFUL,
    });
    const f = record.oracleFindings?.find((x) => x.oracle === "issue-repro");
    expect(f?.conclusion).toBe("satisfied");
    expect(f?.evidence).toContain("parent=fail");
    expect(f?.evidence).toContain("head=pass");
  }, 600_000);

  it("CASE C defu#155: abstains on a multi-step repro whose input is not inlined (no finding)", async () => {
    // defu's current toolchain needs Node 20+, so the full pipeline is not run
    // here; the oracle abstains at the extraction step, before any repro runs,
    // so this is repo-independent. Ground truth (parent isAdmin=true,
    // head isAdmin=false) was established out of band against defu's source.
    const text = await fetchIssueText("unjs", "defu", 155, TOKEN);
    const finding = await issueReproOracle().run(issueTextCtx(text));
    expect(finding).toBeNull();
  });
});
