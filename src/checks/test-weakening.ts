import ts from "typescript";
import type { TestWeakening } from "../core/evidence-record.js";

/**
 * Diff-level test-weakening detection: an existing test whose assertion was
 * loosened, whose expected value was changed to match new output, or which was
 * skipped or marked todo to fit the changed code. This catches the agent
 * editing the test to fit a broken fix. Full test-machinery tamper forensics is
 * a separate tool's job; this is the diff-level slice, comparing the parent and
 * head versions of each changed test file.
 */

const STRICT_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual", "toBeCloseTo"]);
const LOOSE_MATCHERS = new Set([
  "toBeTruthy",
  "toBeFalsy",
  "toBeDefined",
  "toBeUndefined",
  "toBeNull",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toContain",
  "toMatch",
  "toBeInstanceOf",
]);
const SKIP_MARKERS = new Set(["skip", "todo"]);
const SKIP_IDENTIFIERS = new Set(["xit", "xtest", "xdescribe"]);

interface Extract {
  expectCount: number;
  strict: number;
  loose: number;
  /** Literal expected values from strict matchers, as a sorted multiset. */
  strictLiterals: string[];
  skips: { kind: "test-skipped" | "test-todo"; line: number }[];
  firstLooseLine: number | null;
}

function parse(file: string, content: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Extract the assertion and skip shape of a test file. */
function extract(file: string, content: string): Extract {
  const sf = parse(file, content);
  const result: Extract = {
    expectCount: 0,
    strict: 0,
    loose: 0,
    strictLiterals: [],
    skips: [],
    firstLooseLine: null,
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "expect") {
        result.expectCount++;
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text;
        if (STRICT_MATCHERS.has(name)) {
          result.strict++;
          const arg = node.arguments[0];
          if (arg) result.strictLiterals.push(arg.getText(sf));
        } else if (LOOSE_MATCHERS.has(name)) {
          result.loose++;
          if (result.firstLooseLine === null) {
            result.firstLooseLine =
              sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          }
        }
        // it.skip / describe.todo style markers.
        if (SKIP_MARKERS.has(name) && ts.isIdentifier(callee.expression)) {
          const base = callee.expression.text;
          if (base === "it" || base === "test" || base === "describe") {
            result.skips.push({
              kind: name === "todo" ? "test-todo" : "test-skipped",
              line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            });
          }
        }
      }
      if (ts.isIdentifier(callee) && SKIP_IDENTIFIERS.has(callee.text)) {
        result.skips.push({
          kind: "test-skipped",
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  result.strictLiterals.sort((a, b) => a.localeCompare(b));
  return result;
}

/**
 * Compare the parent and head versions of one test file and report any
 * weakening. Pure: same inputs, same findings.
 *
 * @param file - the test file path.
 * @param parentContent - the test file at the parent.
 * @param headContent - the test file at head.
 * @returns the weakenings detected, possibly empty.
 */
export function compareTestFile(
  file: string,
  parentContent: string,
  headContent: string,
): TestWeakening[] {
  const before = extract(file, parentContent);
  const after = extract(file, headContent);
  const findings: TestWeakening[] = [];

  if (after.skips.length > before.skips.length) {
    const added = after.skips[after.skips.length - 1]!;
    findings.push({
      file,
      line: added.line,
      kind: added.kind,
      detail: `a test was marked ${added.kind === "test-todo" ? "todo" : "skipped"} in head`,
    });
  }

  if (after.expectCount < before.expectCount) {
    findings.push({
      file,
      line: 1,
      kind: "assertion-removed",
      detail: `expect() calls dropped from ${before.expectCount} to ${after.expectCount}`,
    });
  }

  // A strict matcher was traded for a loose one: the assertion got weaker.
  if (after.strict < before.strict && after.loose > before.loose) {
    findings.push({
      file,
      line: after.firstLooseLine ?? 1,
      kind: "assertion-loosened",
      detail: `strict matchers ${before.strict}->${after.strict}, loose matchers ${before.loose}->${after.loose}`,
    });
  }

  // Same number of strict assertions, but the expected literals changed.
  if (
    after.strict === before.strict &&
    after.strict > 0 &&
    after.strictLiterals.join("|") !== before.strictLiterals.join("|")
  ) {
    findings.push({
      file,
      line: 1,
      kind: "expected-value-changed",
      detail: `expected values changed from [${before.strictLiterals.join(", ")}] to [${after.strictLiterals.join(", ")}]`,
    });
  }

  return findings;
}
