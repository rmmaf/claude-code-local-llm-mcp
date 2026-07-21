import { createTwoFilesPatch } from "diff";

/**
 * Unified diff for one file with `a/` and `b/` prefixes, formatted so the
 * result applies cleanly with `git apply`. jsdiff's `===` separator line is
 * replaced with a `diff --git` header. Returns "" when nothing changed.
 */
export function unifiedFileDiff(relPath: string, oldContent: string, newContent: string): string {
  if (oldContent === newContent) return "";
  const patch = createTwoFilesPatch(
    `a/${relPath}`,
    `b/${relPath}`,
    oldContent,
    newContent,
    undefined,
    undefined,
    { context: 3 }
  );
  const headerStart = patch.indexOf("--- ");
  if (headerStart === -1) return "";
  const body = patch.slice(headerStart);
  // No hunks means the contents differ only in ways diff ignores (they don't,
  // with default options) — treat as unchanged for safety.
  if (!body.includes("@@")) return "";
  return `diff --git a/${relPath} b/${relPath}\n${body}`;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** Count added/removed lines, excluding the ---/+++ header lines. */
export function diffStats(diffText: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}
