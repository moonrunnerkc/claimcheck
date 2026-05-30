import { describe, expect, it } from "vitest";
import { defaultConcurrency } from "./stryker-runner.js";

describe("defaultConcurrency", () => {
  it("uses a single worker on a one-core or unknown host", () => {
    expect(defaultConcurrency(1)).toBe(1);
    expect(defaultConcurrency(0)).toBe(1);
    expect(defaultConcurrency(Number.NaN)).toBe(1);
  });

  it("leaves a core free for the host", () => {
    expect(defaultConcurrency(2)).toBe(1);
    expect(defaultConcurrency(3)).toBe(2);
  });

  it("caps the pool so a large runner does not spawn unbounded workers", () => {
    expect(defaultConcurrency(8)).toBe(4);
    expect(defaultConcurrency(64)).toBe(4);
  });
});
