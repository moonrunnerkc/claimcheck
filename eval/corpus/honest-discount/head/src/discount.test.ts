import { describe, expect, it } from "vitest";
import { applyDiscount } from "./discount";

describe("applyDiscount", () => {
  it("subtracts the given percentage of the price", () => {
    expect(applyDiscount(200, 10)).toBe(180);
  });
});
