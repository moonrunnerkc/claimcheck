import type { OracleFinding } from "../core/evidence-record.js";
import type { Oracle, OracleContext, ReproInput } from "./oracle.js";
import { runReproOnce, runReproWithCoverage } from "./repro-run.js";

/**
 * The issue-repro oracle. A bug-fix PR usually links an issue whose body holds
 * a human-written reproduction: the failing input and the wrong-versus-expected
 * behavior, written by the reporter before any fix existed. That text is a
 * correctness signal the agent did not author, so it is a trusted oracle. The
 * oracle extracts a machine-parseable repro, runs it against head to assert the
 * fixed behavior holds, and runs it against parent to corroborate that the bug
 * reproduced there.
 *
 * The catch it enables: a fix whose own tests pass but which fails the
 * reporter's repro is a wrong-oracle catch, proven against an independent human
 * source rather than the agent's tests. That is a BLOCK.
 *
 * Extraction is deliberately narrow. Only a fenced code block carrying an
 * executable assertion is treated as a repro. Freeform prose intent is never
 * parsed by heuristic or model: that would reintroduce the guessing this tool
 * exists to avoid. A repro that is present but not machine-extractable yields a
 * WARN, never a fabricated assertion.
 */

export const ISSUE_REPRO_ORACLE_ID = "issue-repro";

/** Result of extracting a repro from the input. */
type Extraction =
  | { readonly kind: "runnable"; readonly code: string }
  | { readonly kind: "not-extractable" }
  | { readonly kind: "absent" };

/** Languages whose fenced blocks may hold a runnable JS/TS repro. */
const JS_LANGS = new Set([
  "",
  "js",
  "jsx",
  "ts",
  "tsx",
  "javascript",
  "typescript",
  "mjs",
  "cjs",
]);

/** Does this code carry an executable assertion we can run as the oracle? */
function hasExecutableAssertion(code: string): boolean {
  return /\bexpect\s*\(/.test(code) || /\bassert\s*(\.|\()/.test(code);
}

/** Pull every fenced code block out of issue text, with its language tag. */
function fencedBlocks(text: string): Array<{ lang: string; code: string }> {
  const blocks: Array<{ lang: string; code: string }> = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    const lang = (match[1] ?? "").trim().toLowerCase();
    const code = match[2] ?? "";
    blocks.push({ lang, code });
  }
  return blocks;
}

/**
 * Extract a runnable repro from the input. A supplied `repro-test` is taken as
 * runnable. For raw issue text, the first JS/TS fenced block carrying an
 * executable assertion is the repro; a JS/TS block present but without an
 * assertion is "present, not machine-extractable" (WARN); no code block at all
 * means there is nothing to extract (the oracle abstains).
 *
 * @param input - the supplied repro or the raw issue text.
 * @returns the extraction outcome.
 */
export function extractRepro(input: ReproInput): Extraction {
  if (input.kind === "repro-test") {
    return { kind: "runnable", code: input.code };
  }
  const blocks = fencedBlocks(input.text);
  const candidates = blocks.filter((b) => JS_LANGS.has(b.lang));
  const runnable = candidates.find((b) => hasExecutableAssertion(b.code));
  if (runnable) return { kind: "runnable", code: runnable.code };
  if (candidates.length > 0) return { kind: "not-extractable" };
  return { kind: "absent" };
}

/** Does the source already import from vitest? */
function importsVitest(code: string): boolean {
  return /from\s*["']vitest["']/.test(code);
}

/** Is the source a complete test (it has a test wrapper), or a bare script? */
function hasTestWrapper(code: string): boolean {
  return /\b(it|test|describe)\s*\(/.test(code);
}

/**
 * Turn extracted repro code into a self-contained vitest test, without altering
 * the human-written assertions. A complete test is used verbatim with a vitest
 * import added if missing. A bare assertion script has its import statements
 * hoisted to module scope and the remainder wrapped in a single test, so a
 * top-level `expect`/`assert` becomes an executed assertion.
 *
 * @param code - the extracted repro source.
 * @returns runnable vitest test source.
 */
export function toRunnableTest(code: string): string {
  if (hasTestWrapper(code)) {
    return importsVitest(code)
      ? `${code}\n`
      : `import { describe, it, test, expect, vi } from "vitest";\n${code}\n`;
  }
  const lines = code.split("\n");
  const imports: string[] = [];
  const body: string[] = [];
  for (const line of lines) {
    if (/^\s*import\s.+["'][^"']+["'];?\s*$/.test(line)) imports.push(line);
    else body.push(line);
  }
  const header: string[] = [];
  if (!importsVitest(code)) header.push(`import { expect, test } from "vitest";`);
  if (/\bassert\b/.test(code) && !/["']node:assert/.test(code)) {
    header.push(`import assert from "node:assert/strict";`);
  }
  return [
    ...header,
    ...imports,
    `test("issue repro", async () => {`,
    ...body,
    `});`,
    ``,
  ].join("\n");
}

/** A short, deterministic excerpt of the repro for replayable evidence. */
function reproExcerpt(code: string): string {
  const firstReal = code
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return `repro: ${firstReal ?? "<empty>"} (${code.split("\n").length} lines)`;
}

function indeterminate(summary: string, evidence: readonly string[]): OracleFinding {
  return {
    oracle: ISSUE_REPRO_ORACLE_ID,
    conclusion: "indeterminate",
    summary,
    evidence: [...evidence],
  };
}

/**
 * The issue-repro oracle. Reads the repro from the context and runs it under two
 * guards before trusting any outcome. First the executed-the-code guard: the
 * head run is collected with coverage and must execute at least one changed
 * line, else the repro tested nothing about the change (WARN), mirroring
 * test-touches-code for the agent's own tests. Second, a repro that threw before
 * exercising the code (a ReferenceError, a module-resolution failure) is
 * classified errored, never a failed assertion, so it routes to WARN and never
 * to a violation. Only a repro that ran, exercised the change, and stayed
 * deterministic is read as satisfied or violated.
 *
 * @returns the oracle.
 */
export function issueReproOracle(): Oracle {
  return {
    id: ISSUE_REPRO_ORACLE_ID,
    async run(ctx: OracleContext): Promise<OracleFinding | null> {
      if (!ctx.reproInput) return null;
      const extracted = extractRepro(ctx.reproInput);
      if (extracted.kind === "absent") return null;
      if (extracted.kind === "not-extractable") {
        return indeterminate(
          "A reproduction is present in the issue but is not machine-extractable (no executable assertion); the oracle declines rather than guessing an assertion.",
          ["repro present, not machine-extractable"],
        );
      }

      const testSource = toRunnableTest(extracted.code);
      const excerpt = reproExcerpt(extracted.code);

      // Head run 1, with coverage. A repro that threw before testing anything is
      // errored (WARN), and a repro that ran but touched none of the changed
      // code tested nothing about the change (WARN). Either way the outcome
      // carries no signal and must never become a violation.
      const head1 = await runReproWithCoverage(
        ctx.headDir,
        testSource,
        ctx.changedRanges,
      );
      if (head1.outcome === "errored") {
        return indeterminate(
          "The reproduction failed to run on head: it threw before exercising the code under test, rather than running an assertion that failed. Recorded as a warning, never read as a violation.",
          [excerpt, "head=errored", "repro failed to run, not an assertion failure"],
        );
      }
      if (head1.coveredChanged.length === 0) {
        return indeterminate(
          "The reproduction ran on head but executed none of the changed code under test, so its outcome says nothing about the change. Recorded as a warning.",
          [excerpt, `head=${head1.outcome}`, "repro did not exercise the code under test"],
        );
      }

      // Head run 2, for stability under the sandbox.
      const headB = await runReproOnce(ctx.headDir, testSource);
      if (headB === "errored") {
        return indeterminate(
          "The reproduction could not be executed deterministically on head; recorded as a warning, never a guess.",
          [excerpt, `head=${head1.outcome}/${headB}`],
        );
      }
      if (head1.outcome !== headB) {
        return indeterminate(
          "The reproduction's outcome is nondeterministic under the sandbox; quarantined as a warning.",
          [excerpt, `head=${head1.outcome}/${headB}`],
        );
      }

      const parent = await runReproOnce(ctx.parentDir, testSource);
      const head = head1.outcome;

      if (head === "fail") {
        return {
          oracle: ISSUE_REPRO_ORACLE_ID,
          conclusion: "violated",
          summary:
            "The reporter's reproduction fails on head: the change does not satisfy a correctness signal the agent did not write, even though the PR's own tests pass.",
          evidence: [
            excerpt,
            "head=fail",
            `parent=${parent}`,
            parent === "fail"
              ? "the bug reproduced on parent and still reproduces on head"
              : parent === "pass"
                ? "the change introduced a failure of the reporter's reproduction"
                : "the reproduction could not be evaluated on parent",
          ],
        };
      }

      return {
        oracle: ISSUE_REPRO_ORACLE_ID,
        conclusion: "satisfied",
        summary:
          parent === "fail"
            ? "The reporter's reproduction passes on head and failed on parent: the change satisfies the imported signal and the bug demonstrably reproduced before it."
            : "The reporter's reproduction passes on head.",
        evidence: [excerpt, "head=pass", `parent=${parent}`],
      };
    },
  };
}
