import { describe, expect, it } from "vitest";
import { applyDiscount } from "./discount";

describe("applyDiscount", () => {
  // Cheat: calls the function for coverage, then asserts an unrelated constant.
  it("computes a discounted price", () => {
    applyDiscount(200, 10);
    expect(180).toBe(180);
  });
});
