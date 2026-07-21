import { log } from "./logger.js";

/**
 * Strip <think>…</think> blocks (Qwen3 hybrid-thinking output). An unclosed
 * <think> — a truncation artifact — strips to the end of the string.
 */
export function stripThinkBlocks(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const unclosed = out.indexOf("<think>");
  if (unclosed !== -1) out = out.slice(0, unclosed);
  return out;
}

/**
 * Tolerate a markdown code fence wrapping the entire output — small models do
 * this even when told not to. Only a fence around the whole payload is
 * removed; fences inside file contents are preserved.
 */
export function stripOuterCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/);
  return match && match[1] !== undefined ? match[1] : text;
}

export interface ParsedFileBlocks {
  /** path (as written by the model) → complete file content */
  files: Map<string, string>;
  /** paths present in the output but not accepted by the caller's filter */
  extras: string[];
}

const FILE_BLOCK_RE = /<file\s+path=["']([^"']+)["']\s*>\r?\n?([\s\S]*?)<\/file>/g;

/**
 * Parse `<file path="...">content</file>` blocks out of raw model output.
 * `accept` decides which paths are kept; rejected paths are collected in
 * `extras` and logged to stderr (spec: silently drop, log). Content is kept
 * verbatim: everything between the opening tag's newline and `</file>`. The
 * newline before `</file>` is the file's own trailing newline.
 */
export function parseFileBlocks(
  rawOutput: string,
  accept: (path: string) => boolean
): ParsedFileBlocks {
  const cleaned = stripOuterCodeFence(stripThinkBlocks(rawOutput));
  const files = new Map<string, string>();
  const extras: string[] = [];

  for (const match of cleaned.matchAll(FILE_BLOCK_RE)) {
    const path = match[1];
    const content = match[2];
    if (path === undefined || content === undefined) continue;
    if (!accept(path)) {
      extras.push(path);
      log.warn(`model returned undeclared file ${JSON.stringify(path)}; dropping it`);
      continue;
    }
    if (files.has(path)) {
      log.warn(`model returned ${JSON.stringify(path)} more than once; keeping the last block`);
    }
    files.set(path, content);
  }
  return { files, extras };
}

/** The required output format, quoted back to the model on the corrective retry. */
export const FILE_BLOCK_FORMAT = `<file path="relative/path.ts">
...entire final file content...
</file>`;
