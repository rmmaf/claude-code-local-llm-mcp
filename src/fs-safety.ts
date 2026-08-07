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
 * What the context pre-flight needs on top of the editable files.
 *
 * `inputBytes` is EVERYTHING that goes into the prompt — editable files, context
 * files, and the spec — because all of it competes with the answer for the same
 * window. That is the opposite of the output estimate, which counts editable
 * files only.
 */
export interface ContextWindowCheck {
  /** Loaded context length in tokens, or null to skip the check. */
  contextTokens: number | null;
  /** Total bytes of the whole prompt: every file sent, plus the spec. */
  inputBytes: number;
  /**
   * Bytes of prompt per input token. Deliberately NOT the output divisor — see
   * `Config.inputBytesPerToken`. Omitted, it falls back to the output divisor,
   * which is safe but over-refuses.
   */
  inputBytesPerToken?: number;
}

/**
 * Tokens the prompt costs beyond the bytes it carries: the system prompt, the
 * `<file path=…>` tag lines, and the closing "respond with exactly N blocks"
 * instruction.
 *
 * Fitted, not guessed. Least squares over the 14 measured requests of
 * `evidence/2026-08-04-mac-11` and `-mac-12-variance` gives
 * `prompt_tokens ≈ 287 + bytes/4.11`, and ~85 of that intercept is the probe
 * spec's own text — which `inputBytes` already counts — leaving ~200 for the
 * fixed scaffolding. Residuals are within ±3% for every request over 9 KB, and
 * the worst under-prediction across all 14 is 2.9%, which `usableFraction`
 * covers.
 */
const PROMPT_OVERHEAD_TOKENS = 200;

/**
 * Refuse a request whose whole-file answer would not fit in one response.
 *
 * The output contract (`shared.ts`) asks the model for the COMPLETE content of
 * every editable file, so the answer is the SUM of those files — regenerated on
 * every attempt and every `repair` round — against `maxOutputTokens`. Over the
 * cap the response comes back truncated, and `repair` files that under
 * `stopped_because: "model_failed"`: the same label a genuine loop failure gets.
 * That shared label is why B6 cannot be measured (`PREMISES.md`), and refusing
 * up front is what un-shares it. A refusal is a fact about the request; a
 * truncation is a fact about nothing.
 *
 * EDITABLE FILES ONLY, which is the one way this differs from
 * `enforceContextCaps` next door: context files go INTO the prompt and are never
 * echoed back, so they cost input budget and no output budget at all.
 *
 * The token figure is an ESTIMATE and is reported as one. It cannot be exact
 * without the model's tokenizer, and it would still be wrong for a model that
 * spends part of the same budget on reasoning tokens. B16 measures how often it
 * is wrong in the direction that matters (B14 until its detector —
 * `finish_reason: "length"` — turned out to be blind to this failure).
 *
 * SECOND CHECK — THE CONTEXT WINDOW, when `window` is supplied. The output cap
 * above is necessary and NOT sufficient, because input and output share one
 * window and this function used to see only half of it:
 * `run 2026-08-04-mac-12-variance` sent `src/tools/repair.ts` (35.6 KB) past a
 * cap that computed ~10187 estimated output tokens against ~14745 usable and
 * said yes — while the real request needed 8756 prompt tokens plus a ~8300-token
 * answer in a 16384-token window. The model stopped when the window filled:
 * 8756 + 7673 = 16429. It returned a `<file>` block that was properly closed,
 * carried `finish_reason: "stop"`, and was missing 90 lines.
 *
 * That is the failure this check exists to prevent, and it is worse than a
 * truncation: every signal the pipeline reads says the response is fine.
 * `parseFileBlocks` finds the block, `finishReason` is not `"length"`, no file
 * is missing, so no corrective retry fires and `runGeneration` returns a diff
 * that DELETES the 90 lines. Only a human reading the diff would catch it.
 *
 * Skipped when the window is unknown, never guessed — see
 * `pickLoadedContextTokens`. A pre-flight that refuses work must be sure.
 */
export function enforceOutputCap(
  editable: ReadonlyArray<{ rel: string; bytes: number }>,
  maxOutputTokens: number,
  bytesPerToken: number,
  usableFraction: number,
  window?: ContextWindowCheck
): void {
  const budget = Math.floor(maxOutputTokens * usableFraction);
  const totalBytes = editable.reduce((sum, f) => sum + f.bytes, 0);
  const estimate = Math.round(totalBytes / bytesPerToken);
  if (estimate > budget) {
    throw new ToolError(
      `The whole-file answer for these files is estimated at ~${estimate} output tokens, ` +
        `over the ~${budget} usable of ${maxOutputTokens}. Editable files: ` +
        editable.map((f) => `${f.rel} (${formatKb(f.bytes)})`).join(", ") +
        `. The response would be truncated mid-file, so nothing is sent. ` +
        `Send fewer files, split the change, or raise LOCAL_CODER_MAX_OUTPUT_TOKENS.`,
      "output_would_truncate",
      {
        estimated_output_tokens: estimate,
        usable_output_tokens: budget,
        max_output_tokens: maxOutputTokens,
        bytes_per_token: bytesPerToken,
        files: editable.map((f) => ({ path: f.rel, kb: kb(f.bytes) })),
      }
    );
  }

  // The context pre-flight. Skipped entirely when the window is unknown — see
  // `pickLoadedContextTokens` for why a guess is worse than no check.
  //
  // The guard tests for a finite positive NUMBER rather than `!== null`, because
  // the failure it prevents is asymmetric and was observed: a Config literal
  // built without `contextTokens` arrives as `undefined`, makes the budget NaN, and
  // every `<=` against NaN is false, so a check meant to refuse ONE oversized
  // request refuses EVERY request instead. An unknown window must fail open.
  //
  // BOTH ROUTES TO IT ARE NOW CLOSED, and the guard stays anyway. The literal
  // that produced it was in `tests/`, which `tsconfig.json` did not cover until
  // 2026-08-07 and now does. And `loadConfig` cannot produce it either: the
  // field comes from `optionalNumberFromEnv`, which returns `null` on anything
  // not finite and positive. So this is defence against a `Config` some future
  // caller builds by hand — not against a live path, which is worth saying
  // rather than leaving a reader to assume there is one.
  if (window === undefined) return;
  const { contextTokens } = window;
  if (typeof contextTokens !== "number" || !Number.isFinite(contextTokens) || contextTokens <= 0) {
    return;
  }
  const contextBudget = Math.floor(contextTokens * usableFraction);
  const inputDivisor =
    typeof window.inputBytesPerToken === "number" && window.inputBytesPerToken > 0
      ? window.inputBytesPerToken
      : bytesPerToken;
  const inputEstimate = Math.round(window.inputBytes / inputDivisor) + PROMPT_OVERHEAD_TOKENS;
  const total = inputEstimate + estimate;
  if (total <= contextBudget) return;
  throw new ToolError(
    `This request needs ~${total} tokens (~${inputEstimate} of prompt plus ~${estimate} for the ` +
      `whole-file answer) but the loaded model's context is ${contextTokens} tokens, ` +
      `~${contextBudget} of it usable. Input and output SHARE that window, so raising ` +
      `LOCAL_CODER_MAX_OUTPUT_TOKENS cannot help. Editable files: ` +
      editable.map((f) => `${f.rel} (${formatKb(f.bytes)})`).join(", ") +
      `. Send fewer or smaller files, or reload the model with a larger context ` +
      `(\`lms load --context-length\`) and set LOCAL_CODER_CONTEXT_TOKENS to match.`,
    "context_would_overflow",
    {
      estimated_total_tokens: total,
      estimated_input_tokens: inputEstimate,
      estimated_output_tokens: estimate,
      usable_context_tokens: contextBudget,
      context_tokens: contextTokens,
      bytes_per_token: bytesPerToken,
      input_bytes_per_token: inputDivisor,
      input_bytes: window.inputBytes,
      files: editable.map((f) => ({ path: f.rel, kb: kb(f.bytes) })),
    }
  );
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
