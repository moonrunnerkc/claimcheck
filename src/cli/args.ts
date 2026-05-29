/**
 * A tiny, dependency-free argument parser for the CLI. Supports `--flag value`,
 * `--flag=value`, and boolean `--flag`. Kept minimal on purpose; the CLI surface
 * is small and a parser library would be debt.
 */

export interface ParsedArgs {
  /** The first non-flag token, for example "run" or "replay". */
  readonly command: string | undefined;
  /** Remaining positional arguments after the command. */
  readonly positionals: readonly string[];
  /** Named options; boolean flags map to "true". */
  readonly options: Readonly<Record<string, string>>;
}

/**
 * Parse an argv tail (without node and script) into a command, positionals, and
 * options.
 *
 * @param argv - the arguments after the script name.
 * @returns the parsed structure.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        options[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          options[body] = next;
          i++;
        } else {
          options[body] = "true";
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return {
    command: positionals[0],
    positionals: positionals.slice(1),
    options,
  };
}

/**
 * Read a required option or throw with a message that names the flag.
 *
 * @param options - the parsed options.
 * @param name - the flag name without dashes.
 * @returns the option value.
 * @throws if the option is missing.
 */
export function requireOption(
  options: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = options[name];
  if (value === undefined || value === "true") {
    throw new Error(`missing required --${name} <value>`);
  }
  return value;
}
