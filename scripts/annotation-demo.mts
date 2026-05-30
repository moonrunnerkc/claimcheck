import { join } from "node:path";
import { materializeCase } from "../eval/corpus-repo.js";
import { corpusDir } from "../eval/corpus-loader.js";
import { cli } from "../src/cli/run.js";

/**
 * Demonstrate the per-line annotation surface end to end: materialize a corpus
 * case into a throwaway repo and run the real CLI with --annotations github so
 * the emitted workflow commands are visible. Usage: tsx scripts/annotation-demo.mts <case-name>
 */
const name = process.argv[2] ?? "mock-the-sut";
const repo = await materializeCase(join(corpusDir(), name));
try {
  await cli([
    "run",
    "--repo",
    repo.repoPath,
    "--base",
    repo.baseSha,
    "--head",
    repo.headSha,
    "--annotations",
    "github",
  ]);
} finally {
  await repo.cleanup();
}
