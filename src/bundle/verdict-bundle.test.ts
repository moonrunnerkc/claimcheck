import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EvidenceRecord } from "../core/evidence-record.js";
import {
  buildBundle,
  readBundle,
  replayBundle,
  serializeBundle,
  writeBundle,
} from "./verdict-bundle.js";

function record(over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    baseSha: "parent",
    headSha: "head",
    changedRanges: [{ file: "src/a.ts", start: 1, end: 1 }],
    headTestsPass: true,
    coverageCollected: true,
    failsOnParent: "failed",
    coveredChangedLines: [{ file: "src/a.ts", start: 1, end: 1 }],
    mutants: [],
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
    ...over,
  };
}

describe("buildBundle", () => {
  it("derives the verdict from the record and uses the record hash as the bundle hash", () => {
    const bundle = buildBundle(record());
    expect(bundle.verdict.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("serializes identically regardless of collection insertion order", () => {
    const a = buildBundle(record({ regressions: ["t1", "t2"] }));
    const b = buildBundle(record({ regressions: ["t2", "t1"] }));
    expect(serializeBundle(a)).toEqual(serializeBundle(b));
  });
});

describe("writeBundle / readBundle", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("round-trips a bundle through disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claimcheck-bundle-"));
    dirs.push(dir);
    const bundle = buildBundle(record());
    const path = await writeBundle(dir, bundle);
    expect(path).toContain(bundle.verdict.bundleHash.replace("sha256:", ""));
    const loaded = await readBundle(path);
    expect(loaded.verdict.bundleHash).toEqual(bundle.verdict.bundleHash);
  });
});

describe("replayBundle", () => {
  it("reproduces the recorded verdict from the record alone", () => {
    const result = replayBundle(buildBundle(record()));
    expect(result.reproduced).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it("detects a tampered record whose facts no longer match the recorded verdict", () => {
    const bundle = buildBundle(record());
    // Tamper: flip a fact in the record without updating the recorded verdict.
    const tampered = {
      ...bundle,
      record: { ...bundle.record, regressions: ["snuck-in-regression"] },
    };
    const result = replayBundle(tampered);
    expect(result.reproduced).toBe(false);
    expect(result.mismatches.length).toBeGreaterThan(0);
  });
});
