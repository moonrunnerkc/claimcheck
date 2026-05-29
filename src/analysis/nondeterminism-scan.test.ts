import { describe, expect, it } from "vitest";
import { scanNondeterminism, uncontrollable } from "./nondeterminism-scan.js";

describe("scanNondeterminism", () => {
  it("flags the wall clock and marks it controllable", () => {
    const sources = scanNondeterminism([
      { path: "src/a.ts", content: "export const t = Date.now();\n" },
    ]);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.kind).toBe("wall-clock");
    expect(sources[0]?.controlled).toBe(true);
    expect(sources[0]?.line).toBe(1);
  });

  it("flags new Date() with no args but not new Date(ms)", () => {
    const sources = scanNondeterminism([
      { path: "a.ts", content: "const a = new Date(); const b = new Date(0);" },
    ]);
    expect(sources.filter((s) => s.kind === "wall-clock")).toHaveLength(1);
  });

  it("flags Math.random as controllable unseeded randomness", () => {
    const sources = scanNondeterminism([
      { path: "a.ts", content: "const r = Math.random();" },
    ]);
    expect(sources[0]?.kind).toBe("unseeded-random");
    expect(sources[0]?.controlled).toBe(true);
  });

  it("flags fetch and network imports as uncontrollable", () => {
    const sources = scanNondeterminism([
      {
        path: "a.ts",
        content: 'import axios from "axios";\nawait fetch("http://x");\n',
      },
    ]);
    const network = sources.filter((s) => s.kind === "network");
    expect(network.length).toBe(2);
    expect(uncontrollable(sources).length).toBe(2);
  });

  it("flags setTimeout as a controllable timer source", () => {
    const sources = scanNondeterminism([
      { path: "a.ts", content: "setTimeout(() => {}, 10);" },
    ]);
    expect(sources[0]?.kind).toBe("timer-scheduling");
    expect(sources[0]?.controlled).toBe(true);
  });

  it("returns nothing for deterministic code", () => {
    expect(
      scanNondeterminism([{ path: "a.ts", content: "export const x = 1 + 2;" }]),
    ).toEqual([]);
  });
});
