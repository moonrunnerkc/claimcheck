import { materializeCase } from "./eval/corpus-repo.ts";
import { corpusDir } from "./eval/corpus-loader.ts";
import { runPipeline } from "./src/core/pipeline.ts";
import { fixClaim } from "./src/core/claim.ts";
import { join } from "node:path";
for (const name of ["vacuous-no-throw","vacuous-no-assert"]) {
  const repo = await materializeCase(join(corpusDir(), name));
  const { record, verdict } = await runPipeline({ repoPath: repo.repoPath, base: repo.baseSha, head: repo.headSha, claim: fixClaim() });
  console.log("===", name, "tier", verdict.tier);
  console.log("coveredChangedLines", record.coveredChangedLines);
  console.log("taint", JSON.stringify(record.taint));
  console.log("reach check", verdict.checks.find(c=>c.id==="assertion-reachability")?.tier);
  await repo.cleanup();
}
