import { describe, expect, it } from "vitest";
import { formatVerdict, conclusionLine } from "./format.js";
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

  it("leads with a plain-language conclusion line", () => {
    expect(formatVerdict(verdict)).toContain("BLOCK: the PR's tests do not constrain");
  });

  it("always states the scope so the tool never overclaims", () => {
    expect(formatVerdict(verdict)).toContain(
      "does not prove the change is correct",
    );
  });
});

describe("conclusionLine", () => {
  it("calls a pass a constrained change", () => {
    expect(conclusionLine({ ...verdict, tier: "pass" })).toContain("PASS:");
  });

  it("calls a block a provable gap", () => {
    expect(conclusionLine(verdict)).toContain("BLOCK:");
  });

  it("calls a no-source-change warn not applicable", () => {
    const na: Verdict = {
      tier: "warn",
      bundleHash: "sha256:x",
      checks: [
        {
          id: "test-touches-code",
          tier: "warn",
          summary: "The diff changed no source lines; nothing to constrain.",
          evidence: [],
        },
      ],
    };
    expect(conclusionLine(na)).toContain("NOT APPLICABLE");
  });

  it("calls an evaluated warn inconclusive", () => {
    const inconclusive: Verdict = {
      tier: "warn",
      bundleHash: "sha256:y",
      checks: [
        { id: "kill-check", tier: "warn", summary: "a mutant may be equivalent", evidence: [] },
      ],
    };
    expect(conclusionLine(inconclusive)).toContain("INCONCLUSIVE");
  });
});
