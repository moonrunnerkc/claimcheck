import { describe, expect, it } from "vitest";
import { instrumentSource, instrumentTest } from "./instrument.js";

describe("instrumentSource", () => {
  it("wraps a return expression on a covered changed line", () => {
    const src = "export function f(a, b) {\n  return a + b;\n}\n";
    const { code, tracked } = instrumentSource("f.ts", src, new Set([2]));
    expect(code).toContain('globalThis.__ccTrack((a + b), "f.ts:2:3")');
    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.text).toBe("a + b");
  });

  it("leaves returns on uncovered lines untouched", () => {
    const src = "function f() {\n  return 1;\n}\n";
    const { code, tracked } = instrumentSource("f.ts", src, new Set([99]));
    expect(code).toBe(src);
    expect(tracked).toEqual([]);
  });

  it("does not wrap a bare return with no value", () => {
    const src = "function f() {\n  return;\n}\n";
    const { tracked } = instrumentSource("f.ts", src, new Set([2]));
    expect(tracked).toEqual([]);
  });
});

describe("instrumentTest", () => {
  it("wraps the first argument of expect", () => {
    const src = 'expect(f(1, 2)).toBe(3);\n';
    expect(instrumentTest("t.ts", src)).toContain(
      "expect(globalThis.__ccObserve((f(1, 2)))).toBe(3)",
    );
  });

  it("leaves non-expect calls untouched", () => {
    const src = "doThing(1, 2);\n";
    expect(instrumentTest("t.ts", src)).toBe(src);
  });

  it("preserves the line on which the assertion sits", () => {
    const src = "line1();\nexpect(x).toBe(1);\n";
    const out = instrumentTest("t.ts", src);
    expect(out.split("\n")[1]).toContain("expect(globalThis.__ccObserve((x)))");
  });
});
