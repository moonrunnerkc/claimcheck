import { describe, expect, it } from "vitest";
import type { EvidenceRecord, OracleFinding } from "../core/evidence-record.js";
import { buildBundle, serializeBundle } from "../bundle/verdict-bundle.js";
import { runOracles, type OracleContext } from "./oracle.js";
import { FUTURE_ORACLES } from "./stubs.js";
import { issueReproOracle } from "./issue-repro.js";

/**
 * The graceful-degradation guarantee, pinned at the boundary the constitution
 * names: the bundle hash. With no oracle configured and no oracle input the
 * evidence record is byte-for-byte what it was before the oracle layer existed,
 * so the bundle hash is unchanged. The layer is purely additive.
 *
 * The canonicalization mechanism (an absent oracleFindings field hashes the same
 * as an empty one) is pinned separately in evidence-record.test.ts against
 * hashRecord. These tests pin the same property one level up, through
 * buildBundle and serializeBundle, and pin the leg the pipeline actually relies
 * on: that the configured-but-abstaining oracle set contributes no findings, so
 * the pipeline omits the key entirely and the bundle is identical.
 */

/** A representative record with no oracle field, standing in for any run. */
function preOracleRecord(): EvidenceRecord {
  return {
    baseSha: "aaa",
    headSha: "bbb",
    changedRanges: [{ file: "src/a.ts", start: 1, end: 3 }],
    headTestsPass: true,
    coverageCollected: true,
    failsOnParent: "failed",
    coveredChangedLines: [{ file: "src/a.ts", start: 1, end: 3 }],
    mutants: [
      {
        id: "m1",
        file: "src/a.ts",
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 5,
        mutator: "BlockStatement",
        replacement: "{}",
        status: "killed",
        prefilter: "none",
        noopOrInversion: true,
      },
    ],
    taint: [],
    nondeterminism: [],
    regressions: [],
    errorSuppressions: [],
    testWeakenings: [],
    staticTail: [],
    vacuousAssertions: [],
    quarantined: [],
    degradations: [],
    toolVersion: "0.1.0",
  };
}

/** A context carrying no repro, as the pipeline assembles when none is supplied. */
function ctxWithoutRepro(): OracleContext {
  return {
    parentDir: "/nonexistent/parent",
    headDir: "/nonexistent/head",
    baseSha: "aaa",
    headSha: "bbb",
    changedRanges: [],
    configFile: "claimcheck.vitest.config.ts",
    prMetadata: { owner: null, repo: null, issueNumber: null },
    reproInput: null,
  };
}

describe("oracle-layer graceful degradation", () => {
  it("leaves the bundle hash byte-for-byte unchanged when the oracle field is absent versus empty", () => {
    const pre = buildBundle(preOracleRecord());
    const withEmpty = buildBundle({ ...preOracleRecord(), oracleFindings: [] });
    expect(withEmpty.verdict.bundleHash).toEqual(pre.verdict.bundleHash);
    expect(serializeBundle(withEmpty)).toEqual(serializeBundle(pre));
  });

  it("contributes no findings when the full registered oracle set runs with no repro input", async () => {
    // This is exactly what the pipeline calls: every configured oracle that has
    // nothing to evaluate must abstain, so findings.length is 0 and the pipeline
    // omits the oracleFindings key.
    const oracles = [...FUTURE_ORACLES, issueReproOracle()];
    const findings: OracleFinding[] = await runOracles(oracles, ctxWithoutRepro());
    expect(findings).toEqual([]);
  });

  it("produces a bundle identical to a pre-oracle run when the oracle set abstains", async () => {
    // Reconstruct the pipeline's own conditional: the key is added only when
    // findings exist. An abstaining set yields none, so the bundle is identical.
    const findings = await runOracles(
      [...FUTURE_ORACLES, issueReproOracle()],
      ctxWithoutRepro(),
    );
    const base = preOracleRecord();
    const record: EvidenceRecord =
      findings.length > 0 ? { ...base, oracleFindings: findings } : base;
    const pre = buildBundle(base);
    const afterAbstain = buildBundle(record);
    expect(afterAbstain.verdict.bundleHash).toEqual(pre.verdict.bundleHash);
    expect(serializeBundle(afterAbstain)).toEqual(serializeBundle(pre));
  });

  it("does change the bundle hash once a real finding is recorded, so the guard is not vacuous", () => {
    const pre = buildBundle(preOracleRecord());
    const withFinding = buildBundle({
      ...preOracleRecord(),
      oracleFindings: [
        {
          oracle: "issue-repro",
          conclusion: "violated",
          summary: "repro fails on head",
          evidence: ["head=fail"],
        },
      ],
    });
    expect(withFinding.verdict.bundleHash).not.toEqual(pre.verdict.bundleHash);
  });
});
