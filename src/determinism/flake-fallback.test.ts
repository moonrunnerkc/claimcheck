import { describe, expect, it } from "vitest";
import { findFlips } from "./flake-fallback.js";

describe("findFlips", () => {
  it("flags a test that passed once and failed once", () => {
    const flips = findFlips([
      [{ name: "a", status: "pass" }],
      [{ name: "a", status: "fail" }],
    ]);
    expect(flips).toEqual(["a"]);
  });

  it("ignores tests that were stable across runs", () => {
    const flips = findFlips([
      [
        { name: "a", status: "pass" },
        { name: "b", status: "fail" },
      ],
      [
        { name: "a", status: "pass" },
        { name: "b", status: "fail" },
      ],
    ]);
    expect(flips).toEqual([]);
  });

  it("ignores skipped statuses", () => {
    const flips = findFlips([
      [{ name: "a", status: "skip" }],
      [{ name: "a", status: "pass" }],
    ]);
    expect(flips).toEqual([]);
  });

  it("returns flips sorted for a stable record", () => {
    const flips = findFlips([
      [
        { name: "z", status: "pass" },
        { name: "a", status: "pass" },
      ],
      [
        { name: "z", status: "fail" },
        { name: "a", status: "fail" },
      ],
    ]);
    expect(flips).toEqual(["a", "z"]);
  });
});
