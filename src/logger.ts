/**
 * Stderr-only logger. stdout is the MCP protocol channel — nothing in this
 * codebase may write to stdout except the stdio transport itself and the
 * `--version` flag handler. Route every diagnostic through this module.
 */

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, message: string): void {
  process.stderr.write(`[local-coder] ${level}: ${message}\n`);
}

export const log = {
  debug: (message: string): void => emit("debug", message),
  info: (message: string): void => emit("info", message),
  warn: (message: string): void => emit("warn", message),
  error: (message: string): void => emit("error", message),
};
