import { describe, expect, it } from "vitest";
import { scanStaticTail } from "./static-tail.js";
import type { LineRange } from "../core/evidence-record.js";

/** Build the ranges map for a single file covering the given inclusive lines. */
function ranges(file: string, start: number, end: number): Map<string, LineRange[]> {
  return new Map([[file, [{ file, start, end }]]]);
}

describe("scanStaticTail", () => {
  it("flags an istanbul ignore marker added on a changed line", () => {
    const content = [
      "export function f(x: number): number {",
      "  /* istanbul ignore next */",
      "  if (x < 0) return 0;",
      "  return x;",
      "}",
    ].join("\n");
    const found = scanStaticTail(
      [{ path: "src/f.ts", content }],
      ranges("src/f.ts", 2, 2),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("coverage-ignore");
    expect(found[0]!.line).toBe(2);
  });

  it("recognizes c8, v8, and node:coverage ignore spellings", () => {
    const content = [
      "// c8 ignore start",
      "/* v8 ignore next */",
      "// node:coverage disable",
    ].join("\n");
    const found = scanStaticTail(
      [{ path: "src/g.ts", content }],
      ranges("src/g.ts", 1, 3),
    );
    expect(found.map((f) => f.kind)).toEqual([
      "coverage-ignore",
      "coverage-ignore",
      "coverage-ignore",
    ]);
  });

  it("flags @ts-ignore and @ts-expect-error suppression on a changed line", () => {
    const content = [
      "function h() {",
      "  // @ts-ignore",
      "  return broken.value;",
      "}",
    ].join("\n");
    const found = scanStaticTail(
      [{ path: "src/h.ts", content }],
      ranges("src/h.ts", 2, 2),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("type-suppression");
  });

  it("flags an 'as any' cast introduced on a changed line", () => {
    const content = "const v = (payload as any).id;";
    const found = scanStaticTail(
      [{ path: "src/i.ts", content }],
      ranges("src/i.ts", 1, 1),
    );
    expect(found.some((f) => f.kind === "type-widening")).toBe(true);
  });

  it("flags an explicit ': any' annotation on a changed line", () => {
    const content = "let total: any = compute();";
    const found = scanStaticTail(
      [{ path: "src/j.ts", content }],
      ranges("src/j.ts", 1, 1),
    );
    expect(found.some((f) => f.kind === "type-widening")).toBe(true);
  });

  it("ignores markers and casts outside the changed lines", () => {
    const content = [
      "/* istanbul ignore next */", // line 1, not changed
      "const ok = (x as any) + 1;", // line 2, not changed
      "const clean = compute();", // line 3, the only changed line
    ].join("\n");
    const found = scanStaticTail(
      [{ path: "src/k.ts", content }],
      ranges("src/k.ts", 3, 3),
    );
    expect(found).toEqual([]);
  });

  it("returns nothing for a clean changed line", () => {
    const content = "export const double = (n: number): number => n * 2;";
    const found = scanStaticTail(
      [{ path: "src/clean.ts", content }],
      ranges("src/clean.ts", 1, 1),
    );
    expect(found).toEqual([]);
  });

  it("is deterministic: same inputs, identical findings", () => {
    const content = "/* c8 ignore next */\nconst v = (p as any).id;";
    const a = scanStaticTail([{ path: "src/d.ts", content }], ranges("src/d.ts", 1, 2));
    const b = scanStaticTail([{ path: "src/d.ts", content }], ranges("src/d.ts", 1, 2));
    expect(a).toEqual(b);
  });
});
