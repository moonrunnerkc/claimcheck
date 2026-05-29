import ts from "typescript";

/**
 * Source instrumentation for def-use taint. Two transforms, both position-based
 * so they never shift line numbers: wrap the value of `return` statements on
 * covered changed lines, and wrap the first argument of every `expect(...)`
 * call. At runtime the wrappers tag tracked values and observe asserted ones,
 * and the match between them is the assertion-reachability signal.
 *
 * Scope discipline: this is dynamic taint over the single observed run for the
 * common fix shape (a returned expression asserted by the test), not
 * whole-program static data-flow, which would be unsound here and overbuilt.
 */

/** A changed expression selected for tracking. */
export interface TrackedExpr {
  readonly exprId: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/** Apply non-overlapping edits to source text, processed right-to-left. */
function applyEdits(source: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of ordered) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  return out;
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

/**
 * Wrap the value of `return` statements that start on a covered changed line so
 * the returned value is tagged at runtime.
 *
 * @param file - repo-relative path, used to build expression ids.
 * @param content - the source text.
 * @param coveredLines - the 1-based lines the new tests execute and changed.
 * @returns the instrumented code and the tracked expressions.
 */
export function instrumentSource(
  file: string,
  content: string,
  coveredLines: ReadonlySet<number>,
): { code: string; tracked: TrackedExpr[] } {
  const sf = parse(file, content);
  const edits: Edit[] = [];
  const tracked: TrackedExpr[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) {
      const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const line = pos.line + 1;
      if (coveredLines.has(line)) {
        const exprId = `${file}:${line}:${pos.character + 1}`;
        const exprStart = node.expression.getStart(sf);
        const exprEnd = node.expression.getEnd();
        tracked.push({
          exprId,
          file,
          line,
          column: pos.character + 1,
          text: node.expression.getText(sf).slice(0, 80),
        });
        edits.push({
          start: exprStart,
          end: exprEnd,
          replacement: `globalThis.__ccTrack((${content.slice(exprStart, exprEnd)}), ${JSON.stringify(exprId)})`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { code: applyEdits(content, edits), tracked };
}

/**
 * Wrap the first argument of every `expect(...)` call so the asserted value is
 * observed at runtime.
 *
 * @param file - repo-relative path.
 * @param content - the test source text.
 * @returns the instrumented test code.
 */
export function instrumentTest(file: string, content: string): string {
  const sf = parse(file, content);
  const edits: Edit[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "expect" &&
      node.arguments.length >= 1
    ) {
      const arg = node.arguments[0]!;
      const start = arg.getStart(sf);
      const end = arg.getEnd();
      edits.push({
        start,
        end,
        replacement: `globalThis.__ccObserve((${content.slice(start, end)}))`,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return applyEdits(content, edits);
}
