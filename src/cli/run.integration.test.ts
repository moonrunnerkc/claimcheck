import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { materializeCase } from "../../eval/corpus-repo.js";
import { corpusDir } from "../../eval/corpus-loader.js";
import { cli } from "./run.js";
import { runPipeline } from "../core/pipeline.js";
import { fixClaim } from "../core/claim.js";

/**
 * End-to-end CLI and cache behavior. The CLI must exit non-zero on a blocked
 * case, write a replayable bundle, and the cache must reproduce an identical
 * verdict on a second run of identical inputs.
 */
describe("CLI run and replay", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const c of cleanups.reverse()) await c();
  });

  it("exits 2 on a blocked case and writes a bundle that replays", async () => {
    const repo = await materializeCase(join(corpusDir(), "vacuous-no-throw"));
    cleanups.push(repo.cleanup);
    const out = await mkdtemp(join(tmpdir(), "claimcheck-cli-"));
    cleanups.push(() => rm(out, { recursive: true, force: true }));

    const code = await cli([
      "run",
      "--repo",
      repo.repoPath,
      "--base",
      repo.baseSha,
      "--head",
      repo.headSha,
      "--bundle-out",
      out,
    ]);
    expect(code).toBe(2);

    const fs = await import("node:fs/promises");
    const written = (await fs.readdir(out)).filter((f) => f.endsWith(".bundle.json"));
    expect(written.length).toBe(1);
    const replayCode = await cli(["replay", join(out, written[0]!)]);
    expect(replayCode).toBe(0);
  }, 180_000);

  it("reproduces the bundle hash from cache on a second identical run", async () => {
    const repo = await materializeCase(join(corpusDir(), "honest-discount"));
    cleanups.push(repo.cleanup);
    const cacheDir = await mkdtemp(join(tmpdir(), "claimcheck-pcache-"));
    cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));

    const opts = {
      repoPath: repo.repoPath,
      base: repo.baseSha,
      head: repo.headSha,
      claim: fixClaim(),
      cacheDir,
    };
    const first = await runPipeline(opts);
    const second = await runPipeline(opts); // served from cache
    expect(second.verdict.bundleHash).toEqual(first.verdict.bundleHash);
    expect(second.verdict.tier).toEqual(first.verdict.tier);
  }, 180_000);
});
