import { describe, expect, it } from "vitest";
import { scanVacuousAssertions } from "./vacuous-assertion.js";

describe("scanVacuousAssertions", () => {
  it("flags mock-the-sut and resolves it to the changed source file", () => {
    const content = [
      'import { vi } from "vitest";',
      'vi.mock("./discount");',
      'import { applyDiscount } from "./discount";',
      'test("x", () => { expect(applyDiscount(100, 10)).toBe(90); });',
    ].join("\n");
    const found = scanVacuousAssertions({
      testFile: "src/discount.test.ts",
      content,
      changedSourceFiles: ["src/discount.ts"],
    });
    const mock = found.find((f) => f.kind === "mock-the-sut");
    expect(mock).toBeDefined();
    expect(mock!.mockedChangedFile).toBe("src/discount.ts");
  });

  it("records mock-the-sut without a changed file when mocking an unrelated module", () => {
    const content = 'import {vi} from "vitest";\nvi.mock("../other/logger");';
    const found = scanVacuousAssertions({
      testFile: "src/discount.test.ts",
      content,
      changedSourceFiles: ["src/discount.ts"],
    });
    const mock = found.find((f) => f.kind === "mock-the-sut");
    expect(mock).toBeDefined();
    expect(mock!.mockedChangedFile).toBe("");
  });

  it("does not treat a bare package mock as targeting a local source", () => {
    const content = 'import {vi} from "vitest";\nvi.mock("node:fs");';
    const found = scanVacuousAssertions({
      testFile: "src/discount.test.ts",
      content,
      changedSourceFiles: ["src/discount.ts"],
    });
    expect(found.find((f) => f.kind === "mock-the-sut")!.mockedChangedFile).toBe("");
  });

  it("flags snapshot acceptance over changed output", () => {
    const content = 'test("x", () => { expect(render()).toMatchSnapshot(); });';
    const found = scanVacuousAssertions({
      testFile: "src/r.test.ts",
      content,
      changedSourceFiles: ["src/r.ts"],
    });
    expect(found.map((f) => f.kind)).toContain("snapshot-acceptance");
  });

  it("flags a self-referential tautology expect(x).toBe(x)", () => {
    const content = 'test("x", () => { const x = f(); expect(x).toBe(x); });';
    const found = scanVacuousAssertions({
      testFile: "src/t.test.ts",
      content,
      changedSourceFiles: ["src/t.ts"],
    });
    expect(found.map((f) => f.kind)).toEqual(["tautology"]);
  });

  it("flags expect(true).toBe(true)", () => {
    const content = 'test("x", () => { expect(true).toBe(true); });';
    const found = scanVacuousAssertions({
      testFile: "src/t.test.ts",
      content,
      changedSourceFiles: ["src/t.ts"],
    });
    expect(found.map((f) => f.kind)).toEqual(["tautology"]);
  });

  it("does not flag a real assertion", () => {
    const content = 'test("x", () => { expect(applyDiscount(100, 10)).toBe(90); });';
    const found = scanVacuousAssertions({
      testFile: "src/d.test.ts",
      content,
      changedSourceFiles: ["src/d.ts"],
    });
    expect(found).toEqual([]);
  });

  it("is deterministic across runs", () => {
    const input = {
      testFile: "src/t.test.ts",
      content: 'vi.mock("./t");\nexpect(x).toBe(x);\nexpect(r()).toMatchSnapshot();',
      changedSourceFiles: ["src/t.ts"],
    };
    expect(scanVacuousAssertions(input)).toEqual(scanVacuousAssertions(input));
  });
});
