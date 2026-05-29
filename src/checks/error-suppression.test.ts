import { describe, expect, it } from "vitest";
import { scanErrorSuppression } from "./error-suppression.js";
import type { LineRange } from "../core/evidence-record.js";

function ranges(file: string, start: number, end: number): Map<string, LineRange[]> {
  return new Map([[file, [{ file, start, end }]]]);
}

describe("scanErrorSuppression", () => {
  it("flags an empty catch on a changed line", () => {
    const content = "try {\n  risky();\n} catch (e) {}\n";
    const found = scanErrorSuppression(
      [{ path: "a.ts", content }],
      ranges("a.ts", 3, 3),
    );
    expect(found[0]?.kind).toBe("empty-catch");
  });

  it("flags a catch that returns a success value on the error path", () => {
    const content = "function f() {\n  try {\n    return risky();\n  } catch (e) {\n    return 0;\n  }\n}\n";
    const found = scanErrorSuppression(
      [{ path: "a.ts", content }],
      ranges("a.ts", 4, 6),
    );
    expect(found[0]?.kind).toBe("success-on-error-path");
  });

  it("does not flag a catch that rethrows", () => {
    const content = "try {\n  risky();\n} catch (e) {\n  throw e;\n}\n";
    const found = scanErrorSuppression(
      [{ path: "a.ts", content }],
      ranges("a.ts", 3, 5),
    );
    expect(found).toEqual([]);
  });

  it("ignores catch clauses outside the changed lines", () => {
    const content = "try {\n  risky();\n} catch (e) {}\n";
    const found = scanErrorSuppression(
      [{ path: "a.ts", content }],
      ranges("a.ts", 99, 99),
    );
    expect(found).toEqual([]);
  });
});
