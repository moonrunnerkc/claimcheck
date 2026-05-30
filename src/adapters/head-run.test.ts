import { describe, expect, it } from "vitest";
import { headRunPasses, type VitestResult, type TestOutcome } from "./vitest-run.js";

/**
 * The permanent guard against the hollow-PASS bug. headRunPasses must never
 * return true for a run that did not actually execute the tests: an empty
 * outcome set on a non-zero exit (failedToRun) is the exact shape that once
 * read as passes-on-head, and it must stay false forever.
 */

function run(over: Partial<VitestResult> = {}): VitestResult {
  return {
    passed: true,
    noTests: false,
    failedToRun: false,
    outcomes: [],
    exitCode: 0,
    stderr: "",
    ...over,
  };
}

function outcome(name: string, status: TestOutcome["status"]): TestOutcome {
  return { name, status };
}

const NONE: ReadonlySet<string> = new Set();

describe("headRunPasses", () => {
  it("passes when active tests ran and none failed", () => {
    expect(
      headRunPasses(run({ outcomes: [outcome("a", "pass")] }), 1, NONE),
    ).toBe(true);
  });

  it("never passes a run that failed to load, even with an empty outcome set", () => {
    // The hollow-PASS regression: zero outcomes + non-zero exit must be false.
    expect(
      headRunPasses(
        run({ failedToRun: true, passed: false, exitCode: 1, outcomes: [] }),
        1,
        NONE,
      ),
    ).toBe(false);
  });

  it("never passes when there were no active test files", () => {
    expect(headRunPasses(run({ outcomes: [outcome("a", "pass")] }), 0, NONE)).toBe(
      false,
    );
  });

  it("never passes when the runner found no test files", () => {
    expect(headRunPasses(run({ noTests: true }), 1, NONE)).toBe(false);
  });

  it("does not pass when a non-quarantined test failed", () => {
    expect(
      headRunPasses(
        run({ outcomes: [outcome("a", "pass"), outcome("b", "fail")] }),
        1,
        NONE,
      ),
    ).toBe(false);
  });

  it("ignores a failure from a quarantined (flaky) test", () => {
    expect(
      headRunPasses(
        run({ outcomes: [outcome("a", "pass"), outcome("flaky", "fail")] }),
        1,
        new Set(["flaky"]),
      ),
    ).toBe(true);
  });

  it("an empty-but-loaded run with active tests is a pass (no failures to find)", () => {
    // exitCode 0, not failedToRun, not noTests: a clean run that asserted nothing
    // is not the hollow-PASS case and is allowed to pass.
    expect(headRunPasses(run({ outcomes: [] }), 1, NONE)).toBe(true);
  });

  it("treats any non-zero exit with no outcomes as not-passing across the board", () => {
    // Exhaustive over the active/quarantine axes: failedToRun dominates.
    for (const active of [1, 3]) {
      for (const flaky of [NONE, new Set(["x"])]) {
        expect(
          headRunPasses(
            run({ failedToRun: true, passed: false, exitCode: 1 }),
            active,
            flaky,
          ),
        ).toBe(false);
      }
    }
  });
});
