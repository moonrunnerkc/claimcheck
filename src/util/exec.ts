import { spawn } from "node:child_process";

/** Result of running a child process to completion. */
export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly cwd?: string;
  /** Extra environment entries merged over a deterministic base env. */
  readonly env?: Readonly<Record<string, string>>;
  /** Milliseconds before the process is killed; defaults to 120000. */
  readonly timeoutMs?: number;
  /** When true, a non-zero exit code does not throw. */
  readonly allowNonZero?: boolean;
}

/**
 * Run a command and capture its output, with a deterministic base environment.
 *
 * The base env pins locale and disables update notifiers and color so that
 * tool output is byte-stable across machines. Callers layer their own env on
 * top, including the sandbox's clock and randomness pins.
 *
 * @param command - the executable to run.
 * @param args - its arguments, passed without shell interpretation.
 * @param options - cwd, extra env, timeout, and error handling.
 * @returns the exit code and captured stdout/stderr.
 * @throws if the process exits non-zero and `allowNonZero` is not set, or if it
 *   times out; the error message includes the command and the captured stderr.
 */
export function exec(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const baseEnv: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    NO_COLOR: "1",
    CI: "true",
    FORCE_COLOR: "0",
    NO_UPDATE_NOTIFIER: "1",
  };
  const env = { ...baseEnv, ...(options.env ?? {}) };

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(
        new Error(`failed to spawn "${command}"; is it installed and on PATH?`, {
          cause,
        }),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (timedOut) {
        reject(
          new Error(
            `command "${command} ${args.join(" ")}" timed out after ${timeoutMs}ms; raise timeoutMs or reduce the work`,
          ),
        );
        return;
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowNonZero) {
        reject(
          new Error(
            `command "${command} ${args.join(" ")}" exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      resolve({ code: exitCode, stdout, stderr });
    });
  });
}
