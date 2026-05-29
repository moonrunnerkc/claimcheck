import { describe, expect, it } from "vitest";
import { half } from "./math";

describe("half", () => {
  it("halves a number", () => {
    expect(half(4)).toBe(2);
  });
});
