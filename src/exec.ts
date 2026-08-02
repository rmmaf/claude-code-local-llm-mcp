import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run a command and return its stdout. Injected into probes so tests (and the
 * MCP server under vitest) never actually shell out. Both the memory probes
 * and the `lms` size probe share this one primitive.
 */
export type CommandRunner = (command: string, args: string[]) => Promise<string>;

export const defaultRunner: CommandRunner = async (command, args) => {
  // 16 MiB buffer: `lms ls --json` can be sizable for a large model library;
  // the tiny memory-probe outputs are unaffected by the higher cap.
  const { stdout } = await execFileAsync(command, args, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

export interface ProcessResult {
  stdout: string;
  stderr: string;
  /** Exit code, or null when the process was killed by a signal or timed out. */
  code: number | null;
  timedOut: boolean;
}

export interface ProcessOptions {
  cwd: string;
  timeoutMs: number;
}

/**
 * Run a check command and return its full result WITHOUT throwing on a
 * non-zero exit.
 *
 * The distinction from `defaultRunner` is the point: for `lms` a non-zero exit
 * is a failure, but for a linter or a test suite it is the normal, expected,
 * information-bearing case. Throwing there would discard exactly the output
 * the caller asked for.
 */
export type ProcessRunner = (
  command: string,
  args: string[],
  options: ProcessOptions
) => Promise<ProcessResult>;

/**
 * Windows batch shims (`npx.cmd`, `npm.cmd`) cannot be spawned directly: since
 * the CVE-2024-27980 mitigation, Node fails them with `spawn EINVAL` unless a
 * shell is used. Going through the shell means we must quote the arguments
 * ourselves, because Node just joins them with spaces.
 */
function needsShell(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function quoteForShell(value: string): string {
  if (value !== "" && !/[\s"&|<>^()%!]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

export const defaultProcessRunner: ProcessRunner = async (command, args, options) =>
  new Promise((resolve, reject) => {
    const shell = needsShell(command);
    const child = execFile(
      shell ? `${quoteForShell(command)} ${args.map(quoteForShell).join(" ")}` : command,
      shell ? [] : args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        shell,
        // Checks are non-interactive: a prompt would otherwise hang until the
        // timeout with no output to explain why.
        stdio: ["ignore", "pipe", "pipe"],
      } as Parameters<typeof execFile>[2],
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
        // A missing tool is a configuration problem the caller must see, not a
        // check result. Direct spawn reports ENOENT; a shell swallows that and
        // reports its own "not recognized"/"not found" instead, so both forms
        // have to be caught or a typo'd command reads as a failing check.
        const notFound =
          failure?.code === "ENOENT" ||
          (shell &&
            failure !== null &&
            /is not recognized as an internal or external command|: not found|command not found/i.test(
              String(stderr)
            ));
        if (notFound) {
          reject(new Error(`command not found: ${command}`));
          return;
        }
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          code: typeof failure?.code === "number" ? failure.code : failure === null ? 0 : null,
          timedOut: failure?.killed === true,
        });
      }
    );
    child.on("error", reject);
  });
