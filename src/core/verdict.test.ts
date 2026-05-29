import { describe, expect, it } from "vitest";
import { exitCodeForTier, worstTier } from "./verdict.js";

describe("worstTier", () => {
  it("returns pass for an empty set", () => {
    expect(worstTier([])).toBe("pass");
  });

  it("lets block win over warn and pass", () => {
    expect(worstTier(["pass", "warn", "block", "warn"])).toBe("block");
  });

  it("lets warn win over pass", () => {
    expect(worstTier(["pass", "warn", "pass"])).toBe("warn");
  });

  it("returns pass when everything passed", () => {
    expect(worstTier(["pass", "pass"])).toBe("pass");
  });
});

describe("exitCodeForTier", () => {
  it("maps pass to 0, warn to 1, block to 2", () => {
    expect(exitCodeForTier("pass")).toBe(0);
    expect(exitCodeForTier("warn")).toBe(1);
    expect(exitCodeForTier("block")).toBe(2);
  });
});
