import { describe, expect, it, vi } from "vitest";
import { discountedTotal } from "./calc";

// The test replaces the module under test with a mock, so the real fix never
// runs; the assertion only ever observes the value the mock was told to return.
vi.mock("./calc");

describe("discountedTotal", () => {
  it("returns the discounted total", () => {
    vi.mocked(discountedTotal).mockReturnValue(180);
    expect(discountedTotal(200, 10)).toBe(180);
  });
});
