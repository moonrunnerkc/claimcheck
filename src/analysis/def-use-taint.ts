import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssertionReach, LineRange } from "../core/evidence-record.js";
import { runVitest } from "../adapters/vitest-run.js";
import {
  SANDBOX_SETUP_FILE,
  composeVitestConfig,
  writeSandboxSetup,
} from "../determinism/sandbox.js";
import { instrumentSource, instrumentTest, type TrackedExpr } from "./instrument.js";

/**
 * Assertion-reachability by def-use taint over the single observed run. The
 * changed return expressions are tagged and the asserted values observed; a
 * changed value reaches an assertion when its tag (for objects) or its value
 * (for primitives) shows up at an `expect`. Reaching is the safe direction:
 * value-equality can over-report reachable, but the decision layer's cross-check
 * with the kill-check guards against a taint false-"unreachable" becoming a
 * block.
 */

const TAINT_SETUP_FILE = "claimcheck.taint.ts";

/** The taint setup file body: defines the tag/observe globals and flushes them. */
const TAINT_SETUP_BODY = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";
const state = { tracked: [], observed: [], tags: new WeakMap() };
globalThis.__ccTrack = function (value, exprId) {
  try {
    const isObj = value !== null && (typeof value === "object" || typeof value === "function");
    if (isObj) state.tags.set(value, exprId);
    state.tracked.push({ exprId, primitive: isObj ? undefined : value });
  } catch (_e) {}
  return value;
};
globalThis.__ccObserve = function (value) {
  try {
    const isObj = value !== null && (typeof value === "object" || typeof value === "function");
    state.observed.push({ exprId: isObj ? state.tags.get(value) : undefined, primitive: isObj ? undefined : value });
  } catch (_e) {}
  return value;
};
const out = process.env.CC_TAINT_OUT;
afterAll(() => {
  if (!out) return;
  globalThis.__ccDumpSeq = (globalThis.__ccDumpSeq || 0) + 1;
  try {
    writeFileSync(
      join(out, "taint-" + process.pid + "-" + globalThis.__ccDumpSeq + ".json"),
      JSON.stringify({ tracked: state.tracked, observed: state.observed }),
    );
  } catch (_e) {}
});
`;

interface RuntimeEntry {
  exprId?: string;
  primitive?: unknown;
}
interface RuntimeFile {
  tracked: RuntimeEntry[];
  observed: RuntimeEntry[];
}

export interface TaintRunOptions {
  readonly worktreeDir: string;
  /** Changed source files, repo-relative. */
  readonly sourceFiles: readonly string[];
  /** Active (non-quarantined) test files, repo-relative. */
  readonly testFiles: readonly string[];
  /** Covered changed lines, to pick which return expressions to track. */
  readonly coveredChangedLines: readonly LineRange[];
}

/** Group covered changed lines into a per-file set of line numbers. */
function coveredByFile(lines: readonly LineRange[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const r of lines) {
    const set = map.get(r.file) ?? new Set<number>();
    for (let l = r.start; l <= r.end; l++) set.add(l);
    map.set(r.file, set);
  }
  return map;
}

/**
 * Instrument the worktree, run the tests once under the sandbox, and compute
 * assertion reachability for each tracked changed expression.
 *
 * @param options - worktree, source/test files, and covered changed lines.
 * @returns one reachability entry per executed tracked expression.
 */
export async function runTaint(
  options: TaintRunOptions,
): Promise<AssertionReach[]> {
  const covered = coveredByFile(options.coveredChangedLines);
  const tracked: TrackedExpr[] = [];

  for (const file of options.sourceFiles) {
    const lines = covered.get(file);
    if (!lines || lines.size === 0) continue;
    const content = await readFile(join(options.worktreeDir, file), "utf8");
    const result = instrumentSource(file, content, lines);
    if (result.tracked.length === 0) continue;
    await writeFile(join(options.worktreeDir, file), result.code, "utf8");
    tracked.push(...result.tracked);
  }
  if (tracked.length === 0) return [];

  for (const file of options.testFiles) {
    const content = await readFile(join(options.worktreeDir, file), "utf8");
    await writeFile(join(options.worktreeDir, file), instrumentTest(file, content), "utf8");
  }

  await writeSandboxSetup(options.worktreeDir);
  await writeFile(join(options.worktreeDir, TAINT_SETUP_FILE), TAINT_SETUP_BODY, "utf8");
  // Extend the repo's own config (when present) so taint runs under the repo's
  // real environment, with both the sandbox and the taint setup appended.
  const configBody = await composeVitestConfig(options.worktreeDir, {
    setupFiles: [SANDBOX_SETUP_FILE, TAINT_SETUP_FILE],
    include: options.testFiles,
  });
  const configName = "claimcheck.taint.config.ts";
  await writeFile(join(options.worktreeDir, configName), configBody, "utf8");

  const outDir = await mkdtemp(join(tmpdir(), "claimcheck-taint-"));
  try {
    await runVitest({
      cwd: options.worktreeDir,
      testFiles: options.testFiles,
      configFile: configName,
      env: { CC_TAINT_OUT: outDir },
    });
    const runtime = await readRuntime(outDir);
    return reachability(tracked, runtime);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

/** Merge the per-worker taint dumps. */
async function readRuntime(outDir: string): Promise<RuntimeFile> {
  const merged: RuntimeFile = { tracked: [], observed: [] };
  let files: string[] = [];
  try {
    files = await readdir(outDir);
  } catch {
    return merged;
  }
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(outDir, name), "utf8")) as RuntimeFile;
      if (Array.isArray(parsed.tracked)) merged.tracked.push(...parsed.tracked);
      if (Array.isArray(parsed.observed)) merged.observed.push(...parsed.observed);
    } catch {
      // Skip an unreadable dump.
    }
  }
  return merged;
}

/** Compute reachability per tracked expression from the runtime dumps. */
function reachability(
  tracked: readonly TrackedExpr[],
  runtime: RuntimeFile,
): AssertionReach[] {
  const executed = new Set(runtime.tracked.map((t) => t.exprId));
  const observedExprIds = new Set(
    runtime.observed.map((o) => o.exprId).filter((id): id is string => !!id),
  );
  const observedPrimitives = new Set(
    runtime.observed
      .filter((o) => o.primitive !== undefined)
      .map((o) => JSON.stringify(o.primitive)),
  );
  const primByExpr = new Map<string, Set<string>>();
  for (const t of runtime.tracked) {
    if (!t.exprId || t.primitive === undefined) continue;
    const set = primByExpr.get(t.exprId) ?? new Set<string>();
    set.add(JSON.stringify(t.primitive));
    primByExpr.set(t.exprId, set);
  }

  const byId = new Map<string, TrackedExpr>();
  for (const t of tracked) byId.set(t.exprId, t);

  const out: AssertionReach[] = [];
  for (const [exprId, meta] of byId) {
    if (!executed.has(exprId)) continue; // never ran in the observed execution
    const viaObject = observedExprIds.has(exprId);
    const prims = primByExpr.get(exprId);
    const viaPrimitive = prims
      ? [...prims].some((p) => observedPrimitives.has(p))
      : false;
    const reaches = viaObject || viaPrimitive;
    out.push({
      file: meta.file,
      line: meta.line,
      column: meta.column,
      expression: meta.text,
      reachesAssertion: reaches,
      chain: reaches ? [meta.text, "expect(...)"] : [],
    });
  }
  return out.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
}
