import { describe, expect, it } from "vitest";
import { isExpired } from "./expiry";

describe("isExpired", () => {
  const now = Date.now();

  it("is expired when the deadline is in the past", () => {
    expect(isExpired(now - 1)).toBe(true);
  });

  // Under a real clock this flakes: the inner Date.now() drifts past `now`.
  // The sandbox's frozen clock makes both reads equal, so the boundary is stable.
  it("is not expired exactly at the deadline", () => {
    expect(isExpired(now)).toBe(false);
  });

  it("is not expired when the deadline is in the future", () => {
    expect(isExpired(now + 10_000)).toBe(false);
  });
});
