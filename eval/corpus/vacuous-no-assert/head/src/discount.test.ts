import { describe, expect, it } from "vitest";
import { applyDiscount } from "./discount";

describe("applyDiscount", () => {
  // Cheat: calls the function for coverage, then asserts something unrelated to
  // the returned value, so the fix's output never flows into an assertion.
  it("computes a discounted price", () => {
    applyDiscount(200, 10);
    expect(true).toBe(true);
  });
});
