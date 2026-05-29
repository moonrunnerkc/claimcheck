import ts from "typescript";
import type { ErrorSuppression, LineRange } from "../core/evidence-record.js";

/**
 * Static scan of the changed lines for swallowed errors: the mechanical version
 * of "hits an error and hides it." It flags catch clauses that drop the error,
 * empty catch blocks, and catch blocks that return a value on the error path.
 *
 * It is a WARN signal, never a block on its own, because such a path can be
 * intentional. The scan only looks at catch clauses whose location overlaps the
 * changed lines, so unrelated existing error handling is not flagged.
 */

/** Does the catch clause's line range overlap any changed range in this file? */
function overlapsChange(
  startLine: number,
  endLine: number,
  ranges: readonly LineRange[],
): boolean {
  return ranges.some((r) => startLine <= r.end && endLine >= r.start);
}

/** Does a block rethrow, or reference the caught error in any way? */
function handlesError(
  block: ts.Block,
  errorName: string | undefined,
  sf: ts.SourceFile,
): boolean {
  let handled = false;
  const visit = (node: ts.Node): void => {
    if (ts.isThrowStatement(node)) handled = true;
    if (
      errorName &&
      ts.isIdentifier(node) &&
      node.text === errorName &&
      node.parent !== block
    ) {
      handled = true;
    }
    ts.forEachChild(node, visit);
  };
  void sf;
  ts.forEachChild(block, visit);
  return handled;
}

/** Does a block return a value (a success result on the error path)? */
function returnsValue(block: ts.Block): boolean {
  return block.statements.some(
    (s) => ts.isReturnStatement(s) && s.expression !== undefined,
  );
}

/**
 * Scan changed source files for swallowed-error patterns on the changed lines.
 *
 * @param files - changed source files with their head content.
 * @param rangesByFile - changed line ranges keyed by repo-relative file path.
 * @returns the suppressions found, sorted by file then line.
 */
export function scanErrorSuppression(
  files: ReadonlyArray<{ path: string; content: string }>,
  rangesByFile: ReadonlyMap<string, readonly LineRange[]>,
): ErrorSuppression[] {
  const found: ErrorSuppression[] = [];
  for (const file of files) {
    const ranges = rangesByFile.get(file.path);
    if (!ranges || ranges.length === 0) continue;
    const sf = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      file.path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (ts.isCatchClause(node)) {
        const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const end = sf.getLineAndCharacterOfPosition(node.block.getEnd());
        const startLine = start.line + 1;
        if (overlapsChange(startLine, end.line + 1, ranges)) {
          const errorName =
            node.variableDeclaration &&
            ts.isIdentifier(node.variableDeclaration.name)
              ? node.variableDeclaration.name.text
              : undefined;
          const handled = handlesError(node.block, errorName, sf);
          const snippet = node.getText(sf).replace(/\s+/g, " ").slice(0, 80);
          if (node.block.statements.length === 0) {
            found.push({ file: file.path, line: startLine, column: start.character + 1, kind: "empty-catch", snippet });
          } else if (!handled && returnsValue(node.block)) {
            found.push({ file: file.path, line: startLine, column: start.character + 1, kind: "success-on-error-path", snippet });
          } else if (!handled) {
            found.push({ file: file.path, line: startLine, column: start.character + 1, kind: "catch-ignores-error", snippet });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
