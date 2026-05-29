import { describe, expect, it } from "vitest";
import { applyDiscount } from "./discount";

describe("applyDiscount", () => {
  // Adjacent assertion: true on both the parent and head, so it passes on the
  // parent. On its own this would make fails-on-parent look like "passed".
  it("leaves the price unchanged at 0 percent", () => {
    expect(applyDiscount(100, 0)).toBe(100);
  });

  // Bug-catching assertion: fails on the unfixed parent (190 != 180), so
  // fails-on-parent is "failed" and the escalation cannot fire.
  it("subtracts the given percentage of the price", () => {
    expect(applyDiscount(200, 10)).toBe(180);
  });
});
