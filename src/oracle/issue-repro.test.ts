import { describe, expect, it } from "vitest";
import { extractRepro, toRunnableTest } from "./issue-repro.js";

/**
 * These cover the decidable surface of the oracle: the extraction contract and
 * the test synthesis. The execution path (running the repro against head and
 * parent) is covered by the live tier against a real repo, where real behavior
 * is the only honest oracle for it.
 */

describe("extractRepro", () => {
  it("takes a supplied repro as runnable verbatim", () => {
    const extracted = extractRepro({
      kind: "repro-test",
      code: "expect(1).toBe(1)",
    });
    expect(extracted).toEqual({ kind: "runnable", code: "expect(1).toBe(1)" });
  });

  it("pulls a fenced JS block carrying an executable assertion", () => {
    const text = [
      "The merge drops keys. Repro:",
      "```ts",
      'import { defu } from "../src";',
      "expect(defu({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });",
      "```",
    ].join("\n");
    const extracted = extractRepro({ kind: "issue-text", text });
    expect(extracted.kind).toBe("runnable");
    if (extracted.kind === "runnable") {
      expect(extracted.code).toContain("expect(defu");
    }
  });

  it("recognizes a node assert repro as runnable", () => {
    const text = "```js\nassert.equal(add(2, 2), 4);\n```";
    expect(extractRepro({ kind: "issue-text", text }).kind).toBe("runnable");
  });

  it("declines a fenced block with no executable assertion as not-extractable", () => {
    const text = [
      "Steps to reproduce:",
      "```ts",
      "const out = defu({ a: 1 }, { b: 2 });",
      "console.log(out);",
      "```",
    ].join("\n");
    expect(extractRepro({ kind: "issue-text", text }).kind).toBe(
      "not-extractable",
    );
  });

  it("abstains when the issue has no code block at all", () => {
    const text =
      "When I merge two objects the second one wins, which is wrong. Please fix.";
    expect(extractRepro({ kind: "issue-text", text }).kind).toBe("absent");
  });

  it("ignores non-JS fenced blocks (a stack trace is not a repro)", () => {
    const text = [
      "```",
      "Error: boom",
      "    at foo (index.js:10:5)",
      "```",
    ].join("\n");
    // Empty-lang fence with no assertion: present but not machine-extractable.
    expect(extractRepro({ kind: "issue-text", text }).kind).toBe(
      "not-extractable",
    );
  });

  it("does not treat a shell fence as a JS repro", () => {
    const text = "```bash\nnpm test\n```";
    expect(extractRepro({ kind: "issue-text", text }).kind).toBe("absent");
  });
});

describe("toRunnableTest", () => {
  it("leaves a complete vitest test intact when it already imports vitest", () => {
    const code = [
      'import { test, expect } from "vitest";',
      'test("x", () => { expect(1).toBe(1); });',
    ].join("\n");
    expect(toRunnableTest(code)).toBe(`${code}\n`);
  });

  it("adds a vitest import to a test wrapper that lacks one", () => {
    const code = 'test("x", () => { expect(1).toBe(1); });';
    const out = toRunnableTest(code);
    expect(out).toContain('from "vitest"');
    expect(out).toContain('test("x"');
  });

  it("hoists imports and wraps a bare assertion script in a test", () => {
    const code = [
      'import { defu } from "../src";',
      "expect(defu({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });",
    ].join("\n");
    const out = toRunnableTest(code);
    // The import must be at module scope, before the test wrapper.
    const importIdx = out.indexOf('import { defu }');
    const testIdx = out.indexOf('test("issue repro"');
    expect(importIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeGreaterThan(importIdx);
    expect(out).toContain('from "vitest"');
  });

  it("adds a node:assert import for a bare assert script", () => {
    const code = "assert.equal(add(2, 2), 4);";
    const out = toRunnableTest(code);
    expect(out).toContain('from "node:assert/strict"');
    expect(out).toContain('test("issue repro"');
  });
});
