import { describe, expect, it } from "vitest";
import { compareTestFile } from "./test-weakening.js";

const wrap = (body: string) =>
  `import { describe, expect, it } from "vitest";\nit("t", () => {\n${body}\n});\n`;

describe("compareTestFile", () => {
  it("flags a strict matcher loosened to a weak one", () => {
    const findings = compareTestFile(
      "t.test.ts",
      wrap("expect(f()).toBe(5);"),
      wrap("expect(f()).toBeGreaterThan(0);"),
    );
    expect(findings.some((w) => w.kind === "assertion-loosened")).toBe(true);
  });

  it("flags a changed expected value", () => {
    const findings = compareTestFile(
      "t.test.ts",
      wrap("expect(f()).toBe(5);"),
      wrap("expect(f()).toBe(6);"),
    );
    expect(findings.some((w) => w.kind === "expected-value-changed")).toBe(true);
  });

  it("flags a removed assertion", () => {
    const findings = compareTestFile(
      "t.test.ts",
      wrap("expect(f()).toBe(5);\n  expect(g()).toBe(1);"),
      wrap("expect(f()).toBe(5);"),
    );
    expect(findings.some((w) => w.kind === "assertion-removed")).toBe(true);
  });

  it("flags a test marked skipped in head", () => {
    const parent = 'it("t", () => { expect(f()).toBe(1); });\n';
    const head = 'it.skip("t", () => { expect(f()).toBe(1); });\n';
    const findings = compareTestFile("t.test.ts", parent, head);
    expect(findings.some((w) => w.kind === "test-skipped")).toBe(true);
  });

  it("flags a deleted test as the ambiguous test-removed, not assertion-removed", () => {
    const parent =
      'import { expect, it } from "vitest";\n' +
      'it("a", () => { expect(f()).toBe(1); });\n' +
      'it("b", () => { expect(g()).toBe(2); });\n';
    const head =
      'import { expect, it } from "vitest";\n' +
      'it("a", () => { expect(f()).toBe(1); });\n';
    const findings = compareTestFile("t.test.ts", parent, head);
    expect(findings.some((w) => w.kind === "test-removed")).toBe(true);
    expect(findings.some((w) => w.kind === "assertion-removed")).toBe(false);
  });

  it("still flags an assertion removed from a surviving test as assertion-removed", () => {
    const parent =
      'import { expect, it } from "vitest";\n' +
      'it("a", () => { expect(f()).toBe(1); expect(g()).toBe(2); });\n';
    const head =
      'import { expect, it } from "vitest";\n' +
      'it("a", () => { expect(f()).toBe(1); });\n';
    const findings = compareTestFile("t.test.ts", parent, head);
    expect(findings.some((w) => w.kind === "assertion-removed")).toBe(true);
    expect(findings.some((w) => w.kind === "test-removed")).toBe(false);
  });

  it("reports nothing when the assertions are unchanged", () => {
    const same = wrap("expect(f()).toBe(5);");
    expect(compareTestFile("t.test.ts", same, same)).toEqual([]);
  });
});
