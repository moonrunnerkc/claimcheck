import { describe, expect, it } from "vitest";
import {
  selectMutateRanges,
  toMutateRanges,
  isNoopOrInversion,
  FALLBACK_MUTATE_LINE_CAP,
} from "./mutant-select.js";
import type { LineRange } from "../core/evidence-record.js";

const range = (file: string, start: number, end: number): LineRange => ({
  file,
  start,
  end,
});

describe("selectMutateRanges", () => {
  it("uses the covered changed lines when they exist", () => {
    const sel = selectMutateRanges(
      [range("src/a.ts", 5, 6)],
      [range("src/a.ts", 1, 10)],
      true,
    );
    expect(sel.ranges).toEqual(["src/a.ts:5-6"]);
    expect(sel.fallback).toBe(false);
  });

  it("falls back to the changed hunks when coverage did not map onto them", () => {
    const sel = selectMutateRanges([], [range("src/a.ts", 3, 4)], true);
    expect(sel.ranges).toEqual(["src/a.ts:3-4"]);
    expect(sel.fallback).toBe(true);
  });

  it("does not fall back when no coverage was collected at all", () => {
    const sel = selectMutateRanges([], [range("src/a.ts", 3, 4)], false);
    expect(sel.ranges).toEqual([]);
    expect(sel.fallback).toBe(false);
  });

  it("skips the fallback, with a reason, when the diff is too large", () => {
    const big = range("src/a.ts", 1, FALLBACK_MUTATE_LINE_CAP + 5);
    const sel = selectMutateRanges([], [big], true);
    expect(sel.ranges).toEqual([]);
    expect(sel.fallback).toBe(false);
    expect(sel.skipped).toContain("too large");
  });
});

describe("toMutateRanges / isNoopOrInversion", () => {
  it("formats path:start-end specifiers", () => {
    expect(toMutateRanges([range("src/x.ts", 2, 9)])).toEqual(["src/x.ts:2-9"]);
  });

  it("treats block, conditional, and boolean mutators as block-worthy", () => {
    expect(isNoopOrInversion("BlockStatement")).toBe(true);
    expect(isNoopOrInversion("ConditionalExpression")).toBe(true);
    expect(isNoopOrInversion("ArithmeticOperator")).toBe(false);
  });
});
