import { describe, expect, it } from "vitest";
import type { TestOutcome, VitestResult } from "../adapters/vitest-run.js";
import { classifyRun, didNotRunReason } from "./repro-run.js";

/** Build a VitestResult around a set of outcomes, as a finished run. */
function run(outcomes: TestOutcome[], overrides: Partial<VitestResult> = {}): VitestResult {
  return {
    passed: !outcomes.some((o) => o.status === "fail"),
    noTests: false,
    failedToRun: false,
    outcomes,
    exitCode: 0,
    stderr: "",
    ...overrides,
  };
}

describe("didNotRunReason", () => {
  it("names a ReferenceError as a did-not-run failure", () => {
    expect(didNotRunReason(["ReferenceError: addRoute is not defined"])).toBe(
      "reference-error",
    );
  });

  it("treats a bare 'is not defined' message as a did-not-run failure", () => {
    expect(didNotRunReason(["ctx is not defined"])).toBe("reference-error");
  });

  it("names a module-resolution failure", () => {
    expect(didNotRunReason(["Error: Cannot find module './src'"])).toBe(
      "module-not-found",
    );
  });

  it("names a syntax error", () => {
    expect(didNotRunReason(["SyntaxError: Unexpected token"])).toBe("syntax-error");
  });

  it("returns null for a genuine assertion failure", () => {
    expect(
      didNotRunReason(["AssertionError: expected 1 to be 2 // Object.is equality"]),
    ).toBeNull();
  });

  it("returns null when there is no failure message", () => {
    expect(didNotRunReason([])).toBeNull();
  });
});

describe("classifyRun", () => {
  it("reads a thrown ReferenceError as errored, never as a failed assertion", () => {
    const result = run([
      {
        name: "repro",
        status: "fail",
        failureMessages: ["ReferenceError: addRoute is not defined"],
      },
    ]);
    expect(classifyRun(result)).toBe("errored");
  });

  it("reads an assertion that ran and failed as fail", () => {
    const result = run([
      {
        name: "repro",
        status: "fail",
        failureMessages: ["AssertionError: expected undefined to be defined"],
      },
    ]);
    expect(classifyRun(result)).toBe("fail");
  });

  it("reads a passing run as pass", () => {
    expect(classifyRun(run([{ name: "repro", status: "pass" }]))).toBe("pass");
  });

  it("treats a run that failed to load as errored", () => {
    expect(classifyRun(run([], { failedToRun: true }))).toBe("errored");
  });

  it("treats a run that found no tests as errored", () => {
    expect(classifyRun(run([], { noTests: true }))).toBe("errored");
  });

  it("treats an empty outcome set as errored, never a pass", () => {
    expect(classifyRun(run([]))).toBe("errored");
  });

  it("errors the whole run when any outcome threw, even alongside a pass", () => {
    const result = run([
      { name: "ok", status: "pass" },
      {
        name: "broken",
        status: "fail",
        failureMessages: ["ReferenceError: ctx is not defined"],
      },
    ]);
    expect(classifyRun(result)).toBe("errored");
  });
});
