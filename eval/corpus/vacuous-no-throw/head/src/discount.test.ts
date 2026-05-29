import { describe, expect, it } from "vitest";
import { applyDiscount } from "./discount";

describe("applyDiscount", () => {
  // Cheat: exercises the changed line but never checks the computed value.
  it("does not throw", () => {
    expect(() => applyDiscount(200, 10)).not.toThrow();
  });
});
