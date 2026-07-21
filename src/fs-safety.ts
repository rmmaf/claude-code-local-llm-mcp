import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { log } from "./logger.js";

/** Error with a machine-readable code, surfaced to the orchestrator as structured JSON. */
export class ToolError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export interface SafePath {
  /** Normalized path relative to the project root (posix separators). */
  rel: string;
  /** Absolute resolved path. */
  abs: string;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Deepest ancestor of `abs` that exists on disk (used to realpath not-yet-created paths). */
async function deepestExistingAncestor(abs: string): Promise<string> {
  let current = abs;
  for (;;) {
    try {
      await fs.access(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Resolve a user-supplied relative path against the project root and enforce
 * containment: no absolute paths, no `..` escapes, no symlinks that resolve
 * outside the (realpath'd) root.
 */
export async function resolveSafePath(
  root: string,
  relPath: string,
  options: { mustExist: boolean }
): Promise<SafePath> {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    throw new ToolError("Empty path is not allowed.", "invalid_path", { path: relPath });
  }
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    throw new ToolError(
      `Absolute paths are not allowed: ${JSON.stringify(relPath)}. Pass paths relative to the project root.`,
      "absolute_path",
      { path: relPath }
    );
  }

  const abs = path.resolve(root, relPath);
  if (!isContained(root, abs)) {
    throw new ToolError(
      `Path escapes the project root: ${JSON.stringify(relPath)}.`,
      "path_escape",
      { path: relPath }
    );
  }

  // Symlink check: the realpath of the target (or, if it does not exist yet,
  // of its deepest existing ancestor) must stay inside the realpath'd root.
  const realRoot = await fs.realpath(root);
  const existing = await deepestExistingAncestor(abs);
  const realExisting = await fs.realpath(existing);
  const realTarget =
    existing === abs ? realExisting : path.join(realExisting, path.relative(existing, abs));
  if (realTarget !== realRoot && !isContained(realRoot, realTarget)) {
    throw new ToolError(
      `Path resolves outside the project root via a symlink: ${JSON.stringify(relPath)} -> ${realTarget}.`,
      "symlink_escape",
      { path: relPath, resolved: realTarget }
    );
  }
  if (realTarget === realRoot) {
    throw new ToolError(
      `Path resolves to the project root itself: ${JSON.stringify(relPath)}.`,
      "invalid_path",
      { path: relPath }
    );
  }

  if (options.mustExist) {
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new ToolError(
        `File does not exist: ${JSON.stringify(relPath)}.`,
        "file_not_found",
        { path: relPath }
      );
    }
    if (!stat.isFile()) {
      throw new ToolError(
        `Not a regular file: ${JSON.stringify(relPath)}.`,
        "not_a_file",
        { path: relPath }
      );
    }
  }

  return { rel: toPosix(path.relative(root, abs)), abs };
}

export interface ReadFileResult extends SafePath {
  content: string;
  bytes: number;
}

function looksBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, 8192);
  return window.includes(0);
}

/** Read a text file with per-file size cap and binary rejection. */
export async function readTextFileSafe(
  root: string,
  relPath: string,
  maxFileKb: number
): Promise<ReadFileResult> {
  const resolved = await resolveSafePath(root, relPath, { mustExist: true });
  const stat = await fs.stat(resolved.abs);
  if (stat.size > maxFileKb * 1024) {
    throw new ToolError(
      `File exceeds the ${maxFileKb} KB per-file limit: ${resolved.rel} is ${formatKb(stat.size)}. ` +
        `Narrow the scope or raise LOCAL_CODER_MAX_FILE_KB.`,
      "file_too_large",
      { files: [{ path: resolved.rel, kb: kb(stat.size) }], limit_kb: maxFileKb }
    );
  }
  const buffer = await fs.readFile(resolved.abs);
  if (looksBinary(buffer)) {
    throw new ToolError(
      `Binary file rejected (null byte detected): ${resolved.rel}. Only text files can be edited.`,
      "binary_file",
      { path: resolved.rel }
    );
  }
  return { ...resolved, content: buffer.toString("utf8"), bytes: stat.size };
}

export function kb(bytes: number): number {
  return Math.round((bytes / 1024) * 10) / 10;
}

function formatKb(bytes: number): string {
  return `${kb(bytes)} KB`;
}

/**
 * Enforce the per-file and total assembled-context caps across every file
 * going into the prompt. Names every offending file so the orchestrator can
 * narrow scope.
 */
export function enforceContextCaps(
  files: ReadonlyArray<{ rel: string; bytes: number }>,
  maxFileKb: number,
  maxContextKb: number
): void {
  const oversized = files.filter((f) => f.bytes > maxFileKb * 1024);
  if (oversized.length > 0) {
    throw new ToolError(
      `File(s) exceed the ${maxFileKb} KB per-file limit: ` +
        oversized.map((f) => `${f.rel} (${formatKb(f.bytes)})`).join(", ") +
        `. Narrow the scope or raise LOCAL_CODER_MAX_FILE_KB.`,
      "file_too_large",
      { files: oversized.map((f) => ({ path: f.rel, kb: kb(f.bytes) })), limit_kb: maxFileKb }
    );
  }
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  if (totalBytes > maxContextKb * 1024) {
    throw new ToolError(
      `Total context ${formatKb(totalBytes)} exceeds the ${maxContextKb} KB limit. Files: ` +
        files.map((f) => `${f.rel} (${formatKb(f.bytes)})`).join(", ") +
        `. Send fewer files or raise LOCAL_CODER_MAX_CONTEXT_KB.`,
      "context_too_large",
      {
        total_kb: kb(totalBytes),
        limit_kb: maxContextKb,
        files: files.map((f) => ({ path: f.rel, kb: kb(f.bytes) })),
      }
    );
  }
}

/**
 * Atomic write: temp file in the same directory, fsync, then rename over the
 * target. Creates parent directories when needed (scaffold).
 */
export async function atomicWriteFile(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(absPath)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await fs.open(tmp, "wx", 0o644);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, absPath);
  } catch (error) {
    // A failed write (e.g. ENOSPC) must not orphan the temp file any more
    // than a failed rename would.
    await fs.rm(tmp, { force: true }).catch(() => {
      log.warn(`failed to clean up temp file ${tmp}`);
    });
    throw error;
  }
}
