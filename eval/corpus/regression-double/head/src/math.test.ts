import { describe, expect, it } from "vitest";
import { double } from "./math";

describe("double", () => {
  it("doubles a number", () => {
    expect(double(4)).toBe(8);
  });
});
