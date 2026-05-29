import { describe, expect, it } from "vitest";
import {
  analyzeDiff,
  isSourceFile,
  isTestFile,
  mergeRanges,
  parseUnifiedDiff,
  sourceRanges,
  testFiles,
} from "./diff.js";

describe("isTestFile / isSourceFile", () => {
  it("recognizes test files by suffix and directory", () => {
    expect(isTestFile("src/calc.test.ts")).toBe(true);
    expect(isTestFile("test/calc.spec.js")).toBe(true);
    expect(isTestFile("pkg/__tests__/calc.ts")).toBe(true);
    expect(isTestFile("src/calc.ts")).toBe(false);
  });

  it("treats non-test JS/TS as source and excludes test files", () => {
    expect(isSourceFile("src/calc.ts")).toBe(true);
    expect(isSourceFile("src/calc.mjs")).toBe(true);
    expect(isSourceFile("src/calc.test.ts")).toBe(false);
    expect(isSourceFile("README.md")).toBe(false);
  });
});

describe("parseUnifiedDiff", () => {
  it("extracts head-side ranges from unified=0 hunk headers", () => {
    const diff = [
      "diff --git a/src/calc.ts b/src/calc.ts",
      "--- a/src/calc.ts",
      "+++ b/src/calc.ts",
      "@@ -5 +5,2 @@",
      "+const a = 1;",
      "+const b = 2;",
    ].join("\n");
    const byFile = parseUnifiedDiff(diff);
    expect(byFile.get("src/calc.ts")).toEqual([
      { file: "src/calc.ts", start: 5, end: 6 },
    ]);
  });

  it("ignores pure deletions, which have no head-side lines", () => {
    const diff = [
      "--- a/src/calc.ts",
      "+++ b/src/calc.ts",
      "@@ -5,3 +4,0 @@",
      "-gone",
    ].join("\n");
    expect(parseUnifiedDiff(diff).has("src/calc.ts")).toBe(false);
  });

  it("treats a hunk header without a count as a single line", () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "+changed"].join("\n");
    expect(parseUnifiedDiff(diff).get("x.ts")).toEqual([
      { file: "x.ts", start: 1, end: 1 },
    ]);
  });
});

describe("mergeRanges", () => {
  it("merges overlapping and adjacent ranges", () => {
    const merged = mergeRanges([
      { file: "a", start: 1, end: 3 },
      { file: "a", start: 4, end: 5 },
      { file: "a", start: 10, end: 12 },
    ]);
    expect(merged).toEqual([
      { file: "a", start: 1, end: 5 },
      { file: "a", start: 10, end: 12 },
    ]);
  });

  it("returns an empty list for no input", () => {
    expect(mergeRanges([])).toEqual([]);
  });
});

describe("analyzeDiff", () => {
  const diff = [
    "--- a/src/calc.ts",
    "+++ b/src/calc.ts",
    "@@ -5 +5,2 @@",
    "+fix line one",
    "+fix line two",
    "--- a/src/calc.test.ts",
    "+++ b/src/calc.test.ts",
    "@@ -0,0 +10,3 @@",
    "+test body",
  ].join("\n");

  it("separates source ranges from test files", () => {
    const files = analyzeDiff(diff);
    expect(sourceRanges(files)).toEqual([
      { file: "src/calc.ts", start: 5, end: 6 },
    ]);
    expect(testFiles(files)).toEqual(["src/calc.test.ts"]);
  });
});
