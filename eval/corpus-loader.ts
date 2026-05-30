import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaseLabel, CaseMeta, CorpusCase } from "./types.js";
import type { VerdictTier } from "../src/core/verdict.js";

/**
 * Load labeled corpus cases from `eval/corpus/`. Each case is a directory
 * holding `meta.json`, a `parent/` tree, and a `head/` tree.
 */

const VALID_LABELS: ReadonlySet<CaseLabel> = new Set([
  "honest",
  "vacuous",
  "regression",
  "error-hider",
  "flaky",
  "equivalent-mutant",
  "test-weakening",
  "soft-tail",
]);
const VALID_TIERS: ReadonlySet<VerdictTier> = new Set(["pass", "warn", "block"]);

/** Absolute path to the corpus directory. */
export function corpusDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "corpus");
}

/** Validate untrusted meta.json into a typed {@link CaseMeta}. */
function parseMeta(raw: unknown, caseName: string): CaseMeta {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`corpus case "${caseName}": meta.json must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const label = obj["label"];
  const expectedTier = obj["expectedTier"];
  const mode = obj["mode"];
  const description = obj["description"];
  if (typeof label !== "string" || !VALID_LABELS.has(label as CaseLabel)) {
    throw new Error(
      `corpus case "${caseName}": label must be one of ${[...VALID_LABELS].join(", ")}`,
    );
  }
  if (
    typeof expectedTier !== "string" ||
    !VALID_TIERS.has(expectedTier as VerdictTier)
  ) {
    throw new Error(
      `corpus case "${caseName}": expectedTier must be pass, warn, or block`,
    );
  }
  if (mode !== "fix") {
    throw new Error(`corpus case "${caseName}": mode must be "fix" in v0.1`);
  }
  if (typeof description !== "string" || description.length === 0) {
    throw new Error(`corpus case "${caseName}": description is required`);
  }
  return {
    label: label as CaseLabel,
    expectedTier: expectedTier as VerdictTier,
    mode: "fix",
    description,
  };
}

/**
 * Load every corpus case, sorted by name for deterministic iteration.
 *
 * @returns the loaded cases.
 * @throws if a case is missing meta.json, parent/, or head/.
 */
export async function loadCorpus(): Promise<CorpusCase[]> {
  const root = corpusDir();
  const entries = await readdir(root, { withFileTypes: true });
  const cases: CorpusCase[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const metaPath = join(dir, "meta.json");
    let rawMeta: string;
    try {
      rawMeta = await readFile(metaPath, "utf8");
    } catch {
      throw new Error(
        `corpus case "${entry.name}": missing meta.json at ${metaPath}`,
      );
    }
    const meta = parseMeta(JSON.parse(rawMeta), entry.name);
    await assertDir(join(dir, "parent"), entry.name, "parent");
    await assertDir(join(dir, "head"), entry.name, "head");
    cases.push({ name: entry.name, dir, ...meta });
  }
  return cases;
}

async function assertDir(
  path: string,
  caseName: string,
  which: string,
): Promise<void> {
  try {
    const s = await stat(path);
    if (!s.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(
      `corpus case "${caseName}": missing ${which}/ tree at ${path}`,
    );
  }
}
