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
  const { stdout } = await execFileAsync(command, args, { timeout: 10_000 });
  return stdout;
};
