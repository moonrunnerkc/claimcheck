import { describe, expect, it } from "vitest";
import { clampUpper } from "./clamp";

describe("clampUpper", () => {
  it("clamps values above the max", () => {
    expect(clampUpper(10, 5)).toBe(5);
  });

  it("leaves values below the max unchanged", () => {
    expect(clampUpper(3, 5)).toBe(3);
  });
});
