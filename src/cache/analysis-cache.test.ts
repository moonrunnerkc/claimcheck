import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AnalysisCache, contentKey } from "./analysis-cache.js";

describe("contentKey", () => {
  it("is stable for the same inputs and order", () => {
    expect(contentKey(["a", "b"])).toEqual(contentKey(["a", "b"]));
  });

  it("changes when an input changes", () => {
    expect(contentKey(["a", "b"])).not.toEqual(contentKey(["a", "c"]));
  });

  it("is order-sensitive so distinct inputs do not collide", () => {
    expect(contentKey(["a", "b"])).not.toEqual(contentKey(["b", "a"]));
  });
});

describe("AnalysisCache", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("returns null on a miss and the stored value on a hit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claimcheck-cache-"));
    dirs.push(dir);
    const cache = new AnalysisCache(dir);
    expect(await cache.get("k")).toBeNull();
    await cache.set("k", { tier: "pass" });
    expect(await cache.get<{ tier: string }>("k")).toEqual({ tier: "pass" });
  });
});
