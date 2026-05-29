import { dirname, join } from "node:path/posix";
import ts from "typescript";
import type { VacuousAssertion } from "../core/evidence-record.js";

/**
 * AST detection of test-side patterns that make a test look like it constrains
 * the change when it does not. Three patterns, all read from the new test files:
 *
 * - mock-the-sut: the test replaces the very module it claims to test with a
 *   mock (`vi.mock`/`jest.mock`), so the real changed code never runs. When the
 *   mocked specifier resolves to a changed source file, the test cannot exercise
 *   the fix at all.
 * - snapshot-acceptance: `toMatchSnapshot`/`toMatchInlineSnapshot` over the
 *   changed code's output records whatever the code produces as "expected,"
 *   which auto-blesses a buggy value on the first run.
 * - tautology: `expect(x).toBe(x)`, `expect(true).toBe(true)`, and the like
 *   assert a value against itself and can never fail.
 *
 * These are WARN signals. The decision layer promotes mock-the-sut to BLOCK only
 * under a provable conjunction (the mocked module is the changed file and no
 * changed line is covered by any active test).
 */

const EQUALITY_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual"]);
const SNAPSHOT_MATCHERS = new Set([
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
  "toMatchFileSnapshot",
]);
const MOCK_METHODS = new Set(["mock", "doMock"]);
const MOCK_OBJECTS = new Set(["vi", "jest"]);
const SOURCE_EXT = /\.[cm]?[jt]sx?$/;

interface VacuousScanInput {
  /** Repo-relative path of the test file. */
  readonly testFile: string;
  /** Head content of the test file. */
  readonly content: string;
  /** Repo-relative paths of the source files the diff changed. */
  readonly changedSourceFiles: readonly string[];
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

/** Strip a TS/JS extension so paths compare regardless of `.js` vs `.ts`. */
function stripExt(path: string): string {
  return path.replace(SOURCE_EXT, "");
}

/**
 * Resolve a relative mock specifier against the test file's directory and check
 * whether it names one of the changed source files. Returns that file, or "".
 */
function resolveMockedChangedFile(
  testFile: string,
  specifier: string,
  changedSourceFiles: readonly string[],
): string {
  if (!specifier.startsWith(".")) return ""; // bare package, not a local module
  const resolved = stripExt(join(dirname(testFile), specifier));
  for (const source of changedSourceFiles) {
    if (stripExt(source) === resolved) return source;
  }
  return "";
}

/** Is this call `vi.mock(...)` / `jest.mock(...)` / `vi.doMock(...)`? */
function mockSpecifier(node: ts.CallExpression): string | null {
  const callee = node.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    MOCK_OBJECTS.has(callee.expression.text) &&
    MOCK_METHODS.has(callee.name.text)
  ) {
    const arg = node.arguments[0];
    if (arg && ts.isStringLiteralLike(arg)) return arg.text;
  }
  return null;
}

/** Does `expect(A).matcher(B)` assert a value against itself, by source text? */
function tautologyDetail(node: ts.CallExpression, sf: ts.SourceFile): string | null {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!EQUALITY_MATCHERS.has(callee.name.text)) return null;
  // The receiver must be an expect(...) call to read its argument.
  const receiver = callee.expression;
  if (
    !ts.isCallExpression(receiver) ||
    !ts.isIdentifier(receiver.expression) ||
    receiver.expression.text !== "expect"
  ) {
    return null;
  }
  const actual = receiver.arguments[0];
  const expected = node.arguments[0];
  if (!actual || !expected) return null;
  const left = actual.getText(sf).replace(/\s+/g, "");
  const right = expected.getText(sf).replace(/\s+/g, "");
  if (left === right) {
    return `expect(${actual.getText(sf)}).${callee.name.text}(${expected.getText(sf)}) asserts a value against itself`;
  }
  return null;
}

/**
 * Scan one new test file for vacuous patterns.
 *
 * @param input - the test file path, its head content, and the changed sources.
 * @returns the vacuous-assertion findings for that file.
 */
export function scanVacuousAssertions(
  input: VacuousScanInput,
): VacuousAssertion[] {
  const sf = parse(input.testFile, input.content);
  const found: VacuousAssertion[] = [];
  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const spec = mockSpecifier(node);
      if (spec !== null) {
        const mockedChangedFile = resolveMockedChangedFile(
          input.testFile,
          spec,
          input.changedSourceFiles,
        );
        found.push({
          file: input.testFile,
          line: lineOf(node),
          kind: "mock-the-sut",
          detail:
            mockedChangedFile.length > 0
              ? `the test mocks "${spec}", the changed module under test`
              : `the test mocks "${spec}"`,
          mockedChangedFile,
        });
      }
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        SNAPSHOT_MATCHERS.has(callee.name.text)
      ) {
        found.push({
          file: input.testFile,
          line: lineOf(node),
          kind: "snapshot-acceptance",
          detail: `${callee.name.text}() records the changed code's output as expected`,
          mockedChangedFile: "",
        });
      }
      const taut = tautologyDetail(node, sf);
      if (taut !== null) {
        found.push({
          file: input.testFile,
          line: lineOf(node),
          kind: "tautology",
          detail: taut,
          mockedChangedFile: "",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return found.sort(
    (a, b) =>
      a.line - b.line || a.kind.localeCompare(b.kind) || a.detail.localeCompare(b.detail),
  );
}
