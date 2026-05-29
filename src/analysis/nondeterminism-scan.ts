import ts from "typescript";
import type { NdKind, NdSource } from "../core/evidence-record.js";

/**
 * Layer 1 of determinism: a static scan that names the nondeterminism sources
 * in the changed code and the tests covering it, and says which the sandbox can
 * control. It explains the cause rather than sampling for the symptom, and it
 * is itself deterministic.
 *
 * The scan is intentionally conservative about what it flags as uncontrollable.
 * Only live network access drives quarantine; clock, randomness, timers, and
 * environment are pinned by the sandbox, so flagging them never costs a test.
 * Filesystem and iteration-order heuristics are omitted in v0.1 rather than
 * risk quarantining a test that reads a fixture.
 */

/** Whether the Layer 2 sandbox can pin a given source kind. */
const CONTROLLED: Readonly<Record<NdKind, boolean>> = {
  "unseeded-random": true,
  "wall-clock": true,
  "high-res-timer": true,
  "timer-scheduling": true,
  environment: true,
  network: false,
  "filesystem-mutable": false,
  "unordered-iteration": false,
};

export interface ScanInput {
  /** Repo-relative file path. */
  readonly path: string;
  /** File contents at head. */
  readonly content: string;
}

/** Resolve a member expression like `Date.now` to its dotted text. */
function memberText(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) {
    const left = node.expression;
    if (ts.isIdentifier(left)) return `${left.text}.${node.name.text}`;
  }
  return null;
}

/** Classify a node into a nondeterminism kind, or null if it is benign. */
function classify(node: ts.Node): NdKind | null {
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
    // `new Date()` with no arguments reads the wall clock.
    if (node.expression.text === "Date" && (node.arguments?.length ?? 0) === 0) {
      return "wall-clock";
    }
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const dotted = memberText(callee);
    if (dotted === "Date.now") return "wall-clock";
    if (dotted === "performance.now") return "high-res-timer";
    if (dotted === "process.hrtime") return "high-res-timer";
    if (dotted === "Math.random") return "unseeded-random";
    if (ts.isIdentifier(callee)) {
      if (callee.text === "setTimeout" || callee.text === "setInterval") {
        return "timer-scheduling";
      }
      if (callee.text === "fetch") return "network";
    }
  }
  // `process.env` reads.
  if (memberText(node) === "process.env") return "environment";
  return null;
}

/** Detect a network import (http/https/axios/node-fetch) on a module specifier. */
function networkImport(spec: string): boolean {
  return /^(node:)?(http|https)$|^(axios|node-fetch|got|undici)$/.test(spec);
}

/**
 * Scan a set of files for nondeterminism sources.
 *
 * @param files - the changed source files and the tests covering them.
 * @returns one entry per source found, sorted by file then position.
 */
export function scanNondeterminism(files: readonly ScanInput[]): NdSource[] {
  const sources: NdSource[] = [];
  for (const file of files) {
    const sf = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      file.path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      let kind = classify(node);
      if (
        !kind &&
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        networkImport(node.moduleSpecifier.text)
      ) {
        kind = "network";
      }
      if (kind) {
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        sources.push({
          file: file.path,
          line: pos.line + 1,
          column: pos.character + 1,
          kind,
          snippet: node.getText(sf).slice(0, 80),
          controlled: CONTROLLED[kind],
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sources.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
}

/**
 * Reduce a scan to the set of uncontrollable sources, which drive quarantine.
 *
 * @param sources - the scanned nondeterminism sources.
 * @returns the subset the sandbox cannot pin.
 */
export function uncontrollable(sources: readonly NdSource[]): NdSource[] {
  return sources.filter((s) => !s.controlled);
}
