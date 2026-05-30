import { describe, expect, it } from "vitest";
import {
  FUTURE_ORACLES,
  differentialUnchangedOracle,
  metamorphicRelationOracle,
  propertyContractOracle,
} from "./stubs.js";
import type { OracleContext } from "./oracle.js";

/** A context the no-ops ignore; they must not read it. */
function ctx(): OracleContext {
  return {
    parentDir: "/nonexistent/parent",
    headDir: "/nonexistent/head",
    baseSha: "parent",
    headSha: "head",
    changedRanges: [],
    configFile: "claimcheck.vitest.config.ts",
    prMetadata: { owner: null, repo: null, issueNumber: null },
    reproInput: { kind: "repro-test", code: "expect(1).toBe(1)" },
  };
}

describe("registered no-op oracles", () => {
  it("each returns null (not configured) and contributes nothing", async () => {
    for (const oracle of [
      metamorphicRelationOracle(),
      differentialUnchangedOracle(),
      propertyContractOracle(),
    ]) {
      expect(await oracle.run(ctx())).toBeNull();
    }
  });

  it("exposes all three under stable ids in the registry", () => {
    expect(FUTURE_ORACLES.map((o) => o.id)).toEqual([
      "metamorphic-relation",
      "differential-unchanged",
      "property-contract",
    ]);
  });

  it("ignores even a present repro input: these seams are not wired", async () => {
    const results = await Promise.all(
      FUTURE_ORACLES.map((o) => o.run(ctx())),
    );
    expect(results).toEqual([null, null, null]);
  });
});
