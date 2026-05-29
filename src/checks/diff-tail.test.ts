import { describe, expect, it } from "vitest";
import {
  scanCiMatrix,
  scanCoverageThreshold,
  scanDiffTail,
  scanDroppedAsync,
  scanToleranceLoosening,
} from "./diff-tail.js";

describe("scanCoverageThreshold", () => {
  it("flags a lowered global line threshold in package.json", () => {
    const parent = JSON.stringify({
      jest: { coverageThreshold: { global: { lines: 90, branches: 80 } } },
    });
    const head = JSON.stringify({
      jest: { coverageThreshold: { global: { lines: 50, branches: 80 } } },
    });
    const found = scanCoverageThreshold("package.json", parent, head);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("coverage-threshold-lowered");
    expect(found[0]!.detail).toContain("lines");
    expect(found[0]!.detail).toContain("90");
    expect(found[0]!.detail).toContain("50");
  });

  it("does not flag an unchanged or raised threshold", () => {
    const parent = "{ statements: 80 }";
    const raised = "{ statements: 95 }";
    expect(scanCoverageThreshold(".nycrc.json", parent, raised)).toEqual([]);
    expect(scanCoverageThreshold(".nycrc.json", parent, parent)).toEqual([]);
  });
});

describe("scanCiMatrix", () => {
  it("flags a workflow that drops node versions from the matrix", () => {
    const parent = [
      "jobs:",
      "  test:",
      "    strategy:",
      "      matrix:",
      "        node: [18, 20, 22]",
      "        os: [ubuntu-latest, windows-latest]",
    ].join("\n");
    const head = [
      "jobs:",
      "  test:",
      "    strategy:",
      "      matrix:",
      "        node: [20]",
      "        os: [ubuntu-latest]",
    ].join("\n");
    const found = scanCiMatrix(".github/workflows/ci.yml", parent, head);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("ci-matrix-narrowed");
    expect(found[0]!.detail).toContain("5");
    expect(found[0]!.detail).toContain("2");
  });

  it("counts block-list matrix entries and flags their reduction", () => {
    const parent = [
      "    matrix:",
      "      include:",
      "        - node: 18",
      "        - node: 20",
      "        - node: 22",
    ].join("\n");
    const head = ["    matrix:", "      include:", "        - node: 20"].join("\n");
    const found = scanCiMatrix(".github/workflows/test.yaml", parent, head);
    expect(found).toHaveLength(1);
  });

  it("does not flag an unchanged or widened matrix", () => {
    const m = ["    matrix:", "      node: [18, 20]"].join("\n");
    const wider = ["    matrix:", "      node: [18, 20, 22]"].join("\n");
    expect(scanCiMatrix(".github/workflows/ci.yml", m, m)).toEqual([]);
    expect(scanCiMatrix(".github/workflows/ci.yml", m, wider)).toEqual([]);
  });
});

describe("scanDroppedAsync", () => {
  it("flags a removed await", () => {
    const parent = "async function f() { await save(); return 1; }";
    const head = "async function f() { save(); return 1; }";
    const found = scanDroppedAsync("src/f.ts", parent, head);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("dropped-async");
  });

  it("does not flag added or unchanged awaits", () => {
    const parent = "async function f() { await save(); }";
    const head = "async function f() { await save(); await flush(); }";
    expect(scanDroppedAsync("src/f.ts", parent, head)).toEqual([]);
  });
});

describe("scanToleranceLoosening", () => {
  it("flags a lowered toBeCloseTo precision", () => {
    const parent = "expect(rate).toBeCloseTo(0.333, 5);";
    const head = "expect(rate).toBeCloseTo(0.333, 1);";
    const found = scanToleranceLoosening("a.test.ts", parent, head);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("tolerance-loosened");
  });

  it("treats an omitted precision as the default of 2", () => {
    // head drops the explicit precision, raising slop from 4 digits to 2.
    const parent = "expect(x).toBeCloseTo(1, 4);";
    const head = "expect(x).toBeCloseTo(1);";
    const found = scanToleranceLoosening("a.test.ts", parent, head);
    expect(found).toHaveLength(1);
  });

  it("does not flag a tightened tolerance", () => {
    const parent = "expect(x).toBeCloseTo(1, 2);";
    const head = "expect(x).toBeCloseTo(1, 6);";
    expect(scanToleranceLoosening("a.test.ts", parent, head)).toEqual([]);
  });
});

describe("scanDiffTail dispatch", () => {
  it("routes by filename and runs only applicable scanners", () => {
    const found = scanDiffTail({
      path: ".github/workflows/ci.yml",
      parentContent: "    matrix:\n      node: [18, 20]",
      headContent: "    matrix:\n      node: [20]",
    });
    expect(found.map((f) => f.kind)).toEqual(["ci-matrix-narrowed"]);
  });

  it("is deterministic across runs", () => {
    const file = {
      path: "src/f.ts",
      parentContent: "async function f(){ await a(); await b(); }",
      headContent: "async function f(){ await a(); }",
    };
    expect(scanDiffTail(file)).toEqual(scanDiffTail(file));
  });
});
