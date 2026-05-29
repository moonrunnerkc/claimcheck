#!/usr/bin/env node
import { runPipeline } from "../core/pipeline.js";
import { fixClaim } from "../core/claim.js";
import { writeBundle, readBundle, replayBundle } from "../bundle/verdict-bundle.js";
import { formatVerdict } from "./format.js";
import {
  buildAnnotations,
  renderAnnotationList,
  renderGithubAnnotations,
} from "./annotations.js";
import { parseArgs, requireOption, type ParsedArgs } from "./args.js";
import { TOOL_VERSION } from "../version.js";

/**
 * The ClaimCheck CLI. Exit codes map to the verdict so CI can gate on them:
 * BLOCK exits non-zero (2), PASS exits 0, and WARN exits 0 by default (it
 * annotates rather than fails) unless --fail-on-warn is set.
 */

const USAGE = `claimcheck ${TOOL_VERSION}

Usage:
  claimcheck run --repo <path> --base <sha> --head <sha> [options]
  claimcheck replay <bundle.json>

run options:
  --repo <path>        git repository to analyze (required)
  --base <sha>         parent commit or ref (required)
  --head <sha>         head commit or ref (required)
  --bundle-out <dir>   write the verdict bundle into this directory
  --cache-dir <dir>    cache and reuse bundles for identical inputs
  --json               print the verdict as JSON instead of text
  --annotations <fmt>  also emit per-line annotations: "github" (workflow
                       commands) or "list" (human file:line list)
  --fail-on-warn       exit non-zero (1) on WARN as well as BLOCK
`;

/** Map a verdict to a CLI exit code, honoring --fail-on-warn. */
function exitCode(tier: string, failOnWarn: boolean): number {
  if (tier === "block") return 2;
  if (tier === "warn" && failOnWarn) return 1;
  return 0;
}

async function commandRun(args: ParsedArgs): Promise<number> {
  const repoPath = requireOption(args.options, "repo");
  const base = requireOption(args.options, "base");
  const head = requireOption(args.options, "head");
  const failOnWarn = args.options["fail-on-warn"] === "true";

  const result = await runPipeline({
    repoPath,
    base,
    head,
    claim: fixClaim(),
    ...(args.options["cache-dir"] ? { cacheDir: args.options["cache-dir"] } : {}),
  });

  const bundleOut = args.options["bundle-out"];
  let bundlePath: string | undefined;
  if (bundleOut) bundlePath = await writeBundle(bundleOut, result.bundle);

  const annotationFmt = args.options["annotations"];
  const annotations =
    annotationFmt === "github" || annotationFmt === "list"
      ? buildAnnotations(result.record, result.verdict)
      : [];

  if (args.options["json"] === "true") {
    process.stdout.write(
      `${JSON.stringify({ verdict: result.verdict, bundlePath, annotations }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`${formatVerdict(result.verdict)}\n`);
    if (annotationFmt === "github" && annotations.length > 0) {
      process.stdout.write(`${renderGithubAnnotations(annotations)}\n`);
    } else if (annotationFmt === "list" && annotations.length > 0) {
      process.stdout.write(`\nannotations:\n${renderAnnotationList(annotations)}\n`);
    }
    if (bundlePath) process.stdout.write(`\nbundle written to ${bundlePath}\n`);
  }
  return exitCode(result.verdict.tier, failOnWarn);
}

async function commandReplay(args: ParsedArgs): Promise<number> {
  const path = args.positionals[0];
  if (!path) throw new Error("replay requires a bundle path: claimcheck replay <bundle.json>");
  const bundle = await readBundle(path);
  const result = replayBundle(bundle);
  if (result.reproduced) {
    process.stdout.write(
      `replay OK: recorded verdict ${bundle.verdict.tier} reproduced from the record (${bundle.verdict.bundleHash})\n`,
    );
    return 0;
  }
  process.stdout.write(`replay FAILED; the bundle does not reproduce:\n`);
  for (const m of result.mismatches) process.stdout.write(`  - ${m}\n`);
  return 3;
}

/**
 * CLI entry point.
 *
 * @param argv - process arguments after node and the script path.
 * @returns the process exit code.
 */
export async function cli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case "run":
      return commandRun(args);
    case "replay":
      return commandReplay(args);
    case undefined:
    case "help":
      process.stdout.write(USAGE);
      return args.command === undefined ? 1 : 0;
    default:
      process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}`);
      return 64;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 70;
    });
}
