import path from "node:path";

import { log } from "./logger.js";

/**
 * Strip <think>…</think> blocks (Qwen3 hybrid-thinking output). An unclosed
 * <think> — a truncation artifact — strips to the end of the string.
 *
 * Note: parseFileBlocks does NOT run this over the whole output (that would
 * corrupt file content legitimately containing those literals); it ignores
 * everything outside file blocks instead, which drops reasoning for free.
 * This helper is exported for callers that need it on non-file text.
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

/** Normalize a model-emitted or declared path ("./src/x.ts" ≡ "src/x.ts", backslashes → /). */
export function normalizeRel(p: string): string {
  return path.posix.normalize(p.trim().replace(/\\/g, "/")).replace(/^\.\//, "");
}

export interface ParsedFileBlocks {
  /** normalized path → complete file content */
  files: Map<string, string>;
  /** paths present in the output but not accepted by the caller's filter */
  extras: string[];
}

// Opening tags must start a line; the closing tag must sit alone on its own
// line. This is exactly the format the model is taught, and line-anchoring is
// what lets file content mention the tags inline (regexes, docs, test
// strings) without being truncated.
const OPEN_TAG_RE = /^<file\s+path=["']([^"']+)["']\s*>[ \t]*\r?\n?/gm;
const CLOSE_TAG_RE = /^<\/file>[ \t]*\r?$/gm;

function lastLineAnchoredClose(segment: string): number | null {
  CLOSE_TAG_RE.lastIndex = 0;
  let last: number | null = null;
  for (const match of segment.matchAll(CLOSE_TAG_RE)) {
    last = match.index;
  }
  return last;
}

/**
 * Parse `<file path="...">content</file>` blocks out of raw model output.
 *
 * Strategy: split the output at line-anchored opening tags; within each
 * segment the content runs to the LAST line-anchored `</file>` (so embedded
 * `</file>` literals inside content survive as long as the block is properly
 * closed). Everything outside blocks — reasoning, `<think>` spans, prose — is
 * ignored. A segment with no closing tag (truncation, or a stray opening tag
 * quoted inside reasoning) is dropped with a stderr warning, which routes
 * declared files into the missing-file retry path.
 *
 * `accept` decides which paths are kept; rejected paths land in `extras` and
 * are logged (spec: silently drop, log). Map keys are normalized so duplicate
 * spellings ("x.ts" vs "./x.ts") collapse to one entry (last block wins).
 * Content is verbatim between the opening tag's newline and the closing tag
 * line; the newline before `</file>` is the file's own trailing newline.
 */
export function parseFileBlocks(
  rawOutput: string,
  accept: (path: string) => boolean
): ParsedFileBlocks {
  const cleaned = stripOuterCodeFence(rawOutput);
  const files = new Map<string, string>();
  const extras: string[] = [];

  const opens = [...cleaned.matchAll(OPEN_TAG_RE)];
  for (let i = 0; i < opens.length; i++) {
    const open = opens[i];
    if (open === undefined) continue;
    const rawPath = open[1];
    if (rawPath === undefined) continue;
    const contentStart = open.index + open[0].length;
    const segmentEnd = i + 1 < opens.length ? opens[i + 1]!.index : cleaned.length;
    const segment = cleaned.slice(contentStart, segmentEnd);

    const closeIndex = lastLineAnchoredClose(segment);
    if (closeIndex === null) {
      log.warn(
        `unclosed <file> block for ${JSON.stringify(rawPath)} (truncated output or a tag quoted in prose); dropping it`
      );
      continue;
    }
    const content = segment.slice(0, closeIndex);

    if (!accept(rawPath)) {
      extras.push(rawPath);
      log.warn(`model returned undeclared file ${JSON.stringify(rawPath)}; dropping it`);
      continue;
    }
    const key = normalizeRel(rawPath);
    if (files.has(key)) {
      log.warn(`model returned ${JSON.stringify(key)} more than once; keeping the last block`);
    }
    files.set(key, content);
  }
  return { files, extras };
}

/** The required output format, quoted back to the model on the corrective retry. */
export const FILE_BLOCK_FORMAT = `<file path="relative/path.ts">
...entire final file content...
</file>`;
