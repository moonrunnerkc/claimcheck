import { describe, expect, it } from "vitest";
import { formatVerdict } from "./format.js";
import type { Verdict } from "../core/verdict.js";

const verdict: Verdict = {
  tier: "block",
  bundleHash: "sha256:abc",
  checks: [
    { id: "kill-check", tier: "block", summary: "a no-op mutant survived", evidence: ["mut-1"] },
    { id: "regression", tier: "pass", summary: "no regression", evidence: [] },
  ],
};

describe("formatVerdict", () => {
  it("shows the overall tier and each check", () => {
    const out = formatVerdict(verdict);
    expect(out).toContain("ClaimCheck verdict: BLOCK");
    expect(out).toContain("[BLOCK] kill-check");
    expect(out).toContain("- mut-1");
    expect(out).toContain("sha256:abc");
  });

  it("always states the scope so the tool never overclaims", () => {
    expect(formatVerdict(verdict)).toContain(
      "does not prove the change is correct",
    );
  });
});
