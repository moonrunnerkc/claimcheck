import ts from "typescript";
import type { LineRange, StaticTailFinding } from "../core/evidence-record.js";

/**
 * Static scan of the changed source lines for soft-tail cheats: markers that
 * tell a tool to stop looking at a line, and type escapes that turn off the
 * checker for it. These are the same shape as the error-suppression scan: a
 * deterministic pattern on a changed line. They are WARN signals on their own;
 * the decision layer promotes a coverage-ignore to BLOCK when an independent
 * signal (taint) agrees the line is unconstrained.
 *
 * Two families are detected here, both directly on the head text of the changed
 * lines:
 *
 * - coverage-ignore markers (`istanbul ignore`, `c8 ignore`, `v8 ignore`,
 *   `node:coverage disable`). An agent that cannot make a line covered can make
 *   the coverage tool stop counting it instead.
 * - type suppression and widening (`@ts-ignore`, `@ts-nocheck`,
 *   `@ts-expect-error`, an `any` type annotation, or an `as any` cast) added on
 *   a changed line. These turn off the type checker exactly where the change is.
 */

/** Coverage-tool ignore markers, matched case-insensitively inside a comment. */
const COVERAGE_IGNORE =
  /\b(?:istanbul\s+ignore|c8\s+ignore|v8\s+ignore|node:coverage\s+disable)\b/i;

/** Compiler-suppression pragmas that disable type checking. */
const TS_SUPPRESSION = /@ts-(?:ignore|nocheck|expect-error)\b/;

/** Does a 1-based line fall inside any changed range for this file? */
function inChangedRange(line: number, ranges: readonly LineRange[]): boolean {
  return ranges.some((r) => line >= r.start && line <= r.end);
}

/** 1-based line of a node's start position. */
function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/**
 * Scan the comment ranges attached around each token for coverage-ignore and
 * type-suppression pragmas that sit on a changed line. Comments are not AST
 * nodes, so they are read from the raw text via the scanner's comment ranges.
 */
function scanComments(
  file: string,
  sf: ts.SourceFile,
  ranges: readonly LineRange[],
  found: StaticTailFinding[],
): void {
  const text = sf.getFullText();
  const seen = new Set<number>();
  const consider = (pos: number): void => {
    for (const kind of [
      ts.getLeadingCommentRanges(text, pos),
      ts.getTrailingCommentRanges(text, pos),
    ]) {
      for (const range of kind ?? []) {
        if (seen.has(range.pos)) continue;
        seen.add(range.pos);
        const body = text.slice(range.pos, range.end);
        const line = lineOf(sf, range.pos);
        if (!inChangedRange(line, ranges)) continue;
        if (COVERAGE_IGNORE.test(body)) {
          found.push({
            file,
            line,
            kind: "coverage-ignore",
            detail: `coverage-ignore marker on a changed line: ${snippet(body)}`,
          });
        }
        if (TS_SUPPRESSION.test(body)) {
          found.push({
            file,
            line,
            kind: "type-suppression",
            detail: `type-checker suppression on a changed line: ${snippet(body)}`,
          });
        }
      }
    }
  };
  const walk = (node: ts.Node): void => {
    consider(node.getFullStart());
    ts.forEachChild(node, walk);
  };
  walk(sf);
  // The trailing comments of the last token attach to end-of-file.
  consider(sf.endOfFileToken.getFullStart());
}

/** Collapse whitespace and clip a snippet for human-facing evidence. */
function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Is this type node an `any` (directly, or `as any` / `<any>` cast)? */
function isAnyType(node: ts.TypeNode | undefined): boolean {
  return node !== undefined && node.kind === ts.SyntaxKind.AnyKeyword;
}

/**
 * Scan AST nodes for `any` widening introduced on a changed line: an explicit
 * `: any` annotation on a declaration or parameter, or an `as any` / `<any>`
 * assertion. A genuine fix rarely needs to widen the type of the line it
 * changes; doing so silences the checker exactly there.
 */
function scanWidening(
  file: string,
  sf: ts.SourceFile,
  ranges: readonly LineRange[],
  found: StaticTailFinding[],
): void {
  const flag = (node: ts.Node, how: string): void => {
    const line = lineOf(sf, node.getStart(sf));
    if (!inChangedRange(line, ranges)) return;
    found.push({
      file,
      line,
      kind: "type-widening",
      detail: `${how} on a changed line: ${snippet(node.getText(sf))}`,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) && isAnyType(node.type)) {
      flag(node, "'as any' cast");
    } else if (ts.isTypeAssertionExpression(node) && isAnyType(node.type)) {
      flag(node, "'<any>' assertion");
    } else if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node)) &&
      isAnyType(node.type)
    ) {
      flag(node, "'any' type annotation");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * Scan changed source files for coverage-ignore markers, type suppression, and
 * `any` widening on the changed lines.
 *
 * @param files - changed source files with their head content.
 * @param rangesByFile - changed line ranges keyed by repo-relative file path.
 * @returns the findings, sorted by file then line then kind.
 */
export function scanStaticTail(
  files: ReadonlyArray<{ path: string; content: string }>,
  rangesByFile: ReadonlyMap<string, readonly LineRange[]>,
): StaticTailFinding[] {
  const found: StaticTailFinding[] = [];
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
    scanComments(file.path, sf, ranges, found);
    scanWidening(file.path, sf, ranges, found);
  }
  return found.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.kind.localeCompare(b.kind),
  );
}
