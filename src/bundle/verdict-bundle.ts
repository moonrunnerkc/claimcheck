import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceRecord } from "../core/evidence-record.js";
import {
  canonicalJson,
  canonicalizeRecord,
  hashRecord,
} from "../core/evidence-record.js";
import type { Verdict } from "../core/verdict.js";
import { decide } from "../core/decision.js";

/**
 * The verdict bundle: a content-addressed, replayable artifact derived entirely
 * from the canonical evidence record. The bundle hash is a function of the
 * recorded facts, so re-running the same inputs reproduces the same hash, and
 * replaying a bundle recomputes the same verdict from the record alone.
 */

/** The on-disk bundle schema version, bumped on a breaking format change. */
export const BUNDLE_SCHEMA_VERSION = 1;

export interface VerdictBundle {
  readonly schemaVersion: number;
  readonly record: EvidenceRecord;
  readonly verdict: Verdict;
}

/**
 * Build a bundle from an evidence record. The record is canonicalized so the
 * serialized bundle is byte-stable, and the verdict is computed from it.
 *
 * @param record - the evidence record assembled by the pipeline.
 * @returns the bundle, with a canonical record and the derived verdict.
 */
export function buildBundle(record: EvidenceRecord): VerdictBundle {
  const canonical = canonicalizeRecord(record);
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    record: canonical,
    verdict: decide(canonical),
  };
}

/**
 * Serialize a bundle to canonical JSON. Object keys are sorted recursively so
 * two structurally equal bundles serialize identically.
 *
 * @param bundle - the bundle to serialize.
 * @returns canonical JSON text.
 */
export function serializeBundle(bundle: VerdictBundle): string {
  return canonicalJson(bundle);
}

/**
 * Write a bundle into a directory, named by its bundle hash so the filename is
 * its content address.
 *
 * @param dir - directory to write into; created if absent.
 * @param bundle - the bundle to write.
 * @returns the absolute path written.
 */
export async function writeBundle(
  dir: string,
  bundle: VerdictBundle,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const name = `${bundle.verdict.bundleHash.replace("sha256:", "")}.bundle.json`;
  const path = join(dir, name);
  await writeFile(path, serializeBundle(bundle), "utf8");
  return path;
}

/**
 * Read and validate a bundle from disk.
 *
 * @param path - the bundle file path.
 * @returns the parsed bundle.
 * @throws if the file is not a bundle of a supported schema version.
 */
export async function readBundle(path: string): Promise<VerdictBundle> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`bundle at ${path} is not a JSON object`);
  }
  const obj = parsed as Partial<VerdictBundle>;
  if (obj.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    throw new Error(
      `bundle at ${path} has schema version ${String(obj.schemaVersion)}; this tool reads version ${BUNDLE_SCHEMA_VERSION}`,
    );
  }
  if (!obj.record || !obj.verdict) {
    throw new Error(`bundle at ${path} is missing its record or verdict`);
  }
  return obj as VerdictBundle;
}

export interface ReplayResult {
  /** True when the recomputed verdict matches the one recorded in the bundle. */
  readonly reproduced: boolean;
  /** The verdict recomputed from the bundle's record. */
  readonly recomputed: Verdict;
  /** Reasons the replay diverged, empty when reproduced. */
  readonly mismatches: readonly string[];
}

/**
 * Replay a bundle: recompute the verdict from its record alone and check that
 * the tier and bundle hash match what the bundle recorded. A mismatch means the
 * bundle was tampered with or produced by different detection logic.
 *
 * @param bundle - the bundle to replay.
 * @returns whether the recorded verdict was reproduced, and any mismatches.
 */
export function replayBundle(bundle: VerdictBundle): ReplayResult {
  const recomputed = decide(bundle.record);
  const recordHash = hashRecord(bundle.record);
  const mismatches: string[] = [];
  if (recomputed.tier !== bundle.verdict.tier) {
    mismatches.push(
      `tier: recorded ${bundle.verdict.tier}, recomputed ${recomputed.tier}`,
    );
  }
  if (recomputed.bundleHash !== bundle.verdict.bundleHash) {
    mismatches.push(
      `bundleHash: recorded ${bundle.verdict.bundleHash}, recomputed ${recomputed.bundleHash}`,
    );
  }
  if (recordHash !== bundle.verdict.bundleHash) {
    mismatches.push(
      `record hash ${recordHash} does not match recorded bundleHash ${bundle.verdict.bundleHash}`,
    );
  }
  return { reproduced: mismatches.length === 0, recomputed, mismatches };
}
