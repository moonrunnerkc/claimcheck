import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSandboxSetup, SANDBOX_SETUP_FILE } from "./sandbox.js";
import { scanNondeterminism } from "../analysis/nondeterminism-scan.js";
import { exec } from "../util/exec.js";

/**
 * The crypto pins are verified in a real child process: loading the setup file
 * must make crypto.randomUUID and crypto.getRandomValues deterministic, so a
 * test that uses them is stable under enforcement rather than quarantined.
 */
async function runUnderSandbox(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claimcheck-sbx-"));
  try {
    await writeSandboxSetup(dir);
    const setup = join(dir, SANDBOX_SETUP_FILE);
    // Load the setup from inside the main module, not via --require: the Web
    // Crypto global is initialized lazily and is absent during a --require
    // preload, but present once a module runs, which mirrors how vitest loads
    // the setup file (after the test environment globals are ready).
    const program = `require(${JSON.stringify(setup)});\n${script}`;
    const result = await exec(process.execPath, ["-e", program], { cwd: dir });
    return result.stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("sandbox crypto pins", () => {
  const script = [
    "const a = crypto.randomUUID();",
    "const b = crypto.randomUUID();",
    "const buf = new Uint8Array(4); crypto.getRandomValues(buf);",
    "console.log(JSON.stringify({ a, b, buf: Array.from(buf) }));",
  ].join("");

  it("makes crypto.randomUUID deterministic across separate processes", async () => {
    const first = await runUnderSandbox(script);
    const second = await runUnderSandbox(script);
    expect(first).toEqual(second);
  });

  it("returns distinct UUIDs within a run but a fixed, valid shape", async () => {
    const out = JSON.parse(await runUnderSandbox(script)) as {
      a: string;
      b: string;
      buf: number[];
    };
    expect(out.a).not.toEqual(out.b);
    expect(out.a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(out.buf).toHaveLength(4);
  });
});

describe("nondeterminism scan recognizes the pinned crypto globals", () => {
  it("marks crypto.randomUUID and getRandomValues as controlled", () => {
    const content = [
      "export function id() { return crypto.randomUUID(); }",
      "export function bytes() { const b = new Uint8Array(8); crypto.getRandomValues(b); return b; }",
    ].join("\n");
    const sources = scanNondeterminism([{ path: "src/id.ts", content }]);
    const crypto = sources.filter((s) => s.snippet.includes("crypto"));
    expect(crypto.length).toBeGreaterThanOrEqual(2);
    expect(crypto.every((s) => s.kind === "unseeded-random")).toBe(true);
    expect(crypto.every((s) => s.controlled)).toBe(true);
  });
});
