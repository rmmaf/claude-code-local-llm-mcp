import { promises as fs } from "node:fs";

import type { Config } from "../config.js";
import { diffStats, unifiedFileDiff } from "../diff.js";
import {
  atomicWriteFile,
  enforceContextCaps,
  readTextFileSafe,
  resolveSafePath,
  ToolError,
} from "../fs-safety.js";
import type { CommandRunner } from "../exec.js";
import { chatCompletion, type ChatMessage, type FetchLike, type Usage } from "../llm-client.js";
import { log } from "../logger.js";
import { FILE_BLOCK_FORMAT, normalizeRel, parseFileBlocks } from "../parse.js";
import { resolveModel } from "../selection.js";

export { normalizeRel };

/** Injection points for tests: mocked fetch, canned memory probes. */
export interface ToolDeps {
  fetchImpl?: FetchLike;
  /**
   * Separate from `fetchImpl` on purpose: model resolution probes `/models`
   * before generating, and sharing one fetch let that probe eat a queued test
   * response meant for the chat call.
   */
  modelsFetchImpl?: FetchLike;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  /**
   * Called with the exact bytes of every file `mode: "apply"` writes, as each
   * write lands. `repair` uses it to know precisely what it wrote — inferring
   * that by reading the file back cannot distinguish our write from someone
   * else's, and a rollback that guesses wrong destroys the other one.
   */
  onFileWritten?: (rel: string, content: string) => void;
  /**
   * Bytes the caller expects each file to still hold. `mode: "apply"` verifies
   * them immediately before writing and refuses the whole write on a mismatch.
   * Generation takes minutes, so without this the model's output silently
   * overwrites anything an editor or formatter did in the meantime.
   */
  expectedContent?: ReadonlyMap<string, string>;
  /**
   * Milliseconds left in the caller's wall-clock budget, re-read before EVERY
   * model request. The corrective retry is a second request; giving it the
   * timeout computed for the first is how a hard deadline gets doubled.
   */
  remainingMs?: () => number;
}

export interface GenerationArgs {
  spec: string;
  files: string[];
  context_files?: string[] | undefined;
  model?: string | undefined;
  mode?: "diff" | "apply" | undefined;
  /** fix only: the failing test/compiler/linter output. */
  error_output?: string | undefined;
}

export interface GenerationResult {
  summary: string;
  diff: string;
  files_changed: string[];
  applied: boolean;
  model: string;
  selection_reason: string;
  latency_ms: number;
  usage: Usage;
}

const IMPLEMENT_SYSTEM_PROMPT = `You are a senior software engineer implementing a precise specification.
Rules:
- Follow the specification exactly. Change only what the specification requires.
- Preserve each file's existing code style, formatting, naming, and imports.
- Return the COMPLETE final content of EVERY editable file listed in the request, even files you leave unchanged.
- Use exactly this output format, one block per editable file:
${FILE_BLOCK_FORMAT}
- Output nothing but <file> blocks: no prose, no explanations, no markdown fences, no diff syntax.`;

const FIX_SYSTEM_PROMPT = `${IMPLEMENT_SYSTEM_PROMPT}
- You are fixing a concrete reported failure. Make the MINIMAL targeted change that resolves the error output. Do not refactor, rewrite, reformat, or "improve" anything the fix does not require.`;

interface LoadedFile {
  rel: string;
  abs: string;
  content: string;
  bytes: number;
}

async function loadFiles(
  root: string,
  paths: string[],
  maxFileKb: number
): Promise<LoadedFile[]> {
  const loaded: LoadedFile[] = [];
  for (const rel of paths) {
    loaded.push(await readTextFileSafe(root, rel, maxFileKb));
  }
  return loaded;
}

/**
 * Pre-flight the size caps across ALL files at once so the error names every
 * offender, not just the first (readTextFileSafe alone would stop at one).
 */
export async function statAll(root: string, paths: string[]): Promise<Array<{ rel: string; bytes: number }>> {
  const out: Array<{ rel: string; bytes: number }> = [];
  for (const rel of paths) {
    const resolved = await resolveSafePath(root, rel, { mustExist: true });
    const stat = await fs.stat(resolved.abs);
    out.push({ rel: resolved.rel, bytes: stat.size });
  }
  return out;
}

/**
 * Embed file content between its tag lines losslessly for files that end in a
 * newline, and with one appended newline otherwise (the closing tag must sit
 * on its own line). The trailing-newline-only delta this can introduce is
 * canceled out by effectivelyUnchanged() on the way back.
 */
function embedContent(content: string): string {
  if (content === "" || content.endsWith("\n")) return content;
  return `${content}\n`;
}

function buildUserMessage(
  args: GenerationArgs,
  editable: LoadedFile[],
  context: LoadedFile[]
): string {
  const parts: string[] = ["# Task specification", "", args.spec.trim(), ""];
  if (args.error_output !== undefined) {
    parts.push(
      "# Error output to resolve (make the minimal change that fixes this)",
      "",
      args.error_output.trim(),
      ""
    );
  }
  if (context.length > 0) {
    parts.push("# Read-only context files (reference only — never return these)", "");
    for (const file of context) {
      parts.push(`<context path="${file.rel}">\n${embedContent(file.content)}</context>`, "");
    }
  }
  parts.push("# Editable files — return the complete final content of every one of these", "");
  for (const file of editable) {
    parts.push(`<file path="${file.rel}">\n${embedContent(file.content)}</file>`, "");
  }
  parts.push(
    `Respond with exactly ${editable.length} <file> block(s), one per editable file listed above, and nothing else.`
  );
  return parts.join("\n");
}

/**
 * A returned file counts as unchanged when it is byte-identical to disk, or
 * differs only by the trailing newline the block format forces onto files
 * that do not end in one — otherwise a verbatim echo of such a file would
 * produce a phantom one-character diff (and a pointless write in apply mode).
 */
function effectivelyUnchanged(oldContent: string, newContent: string): boolean {
  if (oldContent === newContent) return true;
  return !oldContent.endsWith("\n") && newContent === `${oldContent}\n`;
}

function correctiveMessage(problem: string, missing: string[]): string {
  const missingNote =
    missing.length > 0
      ? `The following declared file(s) were missing from your response: ${missing.join(", ")}. `
      : "";
  return (
    `Your previous response was not usable: ${problem}. ${missingNote}` +
    `Respond again with the COMPLETE final content of EVERY editable file, using exactly this format and nothing else:\n\n` +
    `${FILE_BLOCK_FORMAT}\n\nNo prose, no markdown fences, no diff syntax.`
  );
}

interface ModelAttemptOutcome {
  files: Map<string, string>;
  raw: string;
  finishReason: string | null;
}

function wordCap(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter((w) => w !== "");
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")} …`;
}

function composeSummary(
  kind: "implement" | "fix",
  spec: string,
  changes: Array<{ rel: string; added: number; removed: number }>,
  applied: boolean
): string {
  const specExcerpt = wordCap(spec.trim().split(/\r?\n/)[0] ?? "", 30);
  if (changes.length === 0) {
    return wordCap(
      `The model returned every editable file unchanged for: ${specExcerpt}. No diff produced; nothing was written.`,
      120
    );
  }
  const verb = kind === "fix" ? "Fixed" : "Implemented";
  const fileList = changes.map((c) => `${c.rel} (+${c.added}/-${c.removed})`).join(", ");
  const action = applied ? "Changes were applied to disk." : "Diff only — nothing written yet.";
  return wordCap(`${verb}: ${specExcerpt}. Changed ${fileList}. ${action}`, 120);
}

/**
 * The implement/fix pipeline: validate paths → read files → prompt the local
 * model → parse `<file>` blocks (one corrective retry) → compute unified
 * diffs against disk → optionally apply atomically.
 */
export async function runGeneration(
  kind: "implement" | "fix",
  args: GenerationArgs,
  config: Config,
  deps: ToolDeps = {}
): Promise<GenerationResult> {
  const started = Date.now();
  const mode = args.mode ?? "diff";

  const editablePaths = [...new Set(args.files.map(normalizeRel))];
  const contextPaths = [...new Set((args.context_files ?? []).map(normalizeRel))].filter((p) => {
    if (editablePaths.includes(p)) {
      log.warn(`context file ${p} is also an editable file; treating it as editable only`);
      return false;
    }
    return true;
  });

  // Size caps across the whole assembled context, all offenders named at once.
  const statted = await statAll(config.root, [...editablePaths, ...contextPaths]);
  enforceContextCaps(statted, config.maxFileKb, config.maxContextKb);

  const editable = await loadFiles(config.root, editablePaths, config.maxFileKb);
  const context = await loadFiles(config.root, contextPaths, config.maxFileKb);

  const { model, reason } = await resolveModel(args.model, config, deps);

  const declared = new Map(editable.map((f) => [normalizeRel(f.rel), f]));
  const messages: ChatMessage[] = [
    { role: "system", content: kind === "fix" ? FIX_SYSTEM_PROMPT : IMPLEMENT_SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage(args, editable, context) },
  ];

  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
  let outcome: ModelAttemptOutcome | null = null;
  let lastProblem = "";
  let lastMissing: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    // Re-read the budget per attempt. The corrective retry is a whole second
    // model request; reusing the first attempt's timeout lets a caller's hard
    // deadline be exceeded by nearly another full request.
    const remaining = deps.remainingMs?.() ?? Number.POSITIVE_INFINITY;
    if (attempt > 1 && remaining <= 0) {
      log.warn("no budget left for the corrective retry; giving up on this generation");
      break;
    }

    const result = await chatCompletion({
      baseUrl: config.baseUrl,
      model,
      messages,
      temperature: config.temperature,
      maxTokens: config.maxOutputTokens,
      timeoutMs: Math.max(1, Math.min(config.timeoutMs, remaining)),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    usage.prompt_tokens += result.usage.prompt_tokens;
    usage.completion_tokens += result.usage.completion_tokens;

    const parsed = parseFileBlocks(result.content, (p) => declared.has(normalizeRel(p)));
    const returned = parsed.files; // keys already normalized by the parser
    const missing = [...declared.keys()].filter((p) => !returned.has(p));

    if (result.finishReason === "length") {
      lastProblem =
        "the response was truncated (finish_reason=length) before all file blocks were complete";
      lastMissing = missing;
    } else if (missing.length > 0) {
      lastProblem =
        returned.size === 0
          ? "no valid <file> blocks were found in the response"
          : "the response did not include every declared editable file";
      lastMissing = missing;
    } else {
      outcome = { files: returned, raw: result.content, finishReason: result.finishReason };
      break;
    }

    log.warn(`attempt ${attempt} malformed (${lastProblem}); missing: [${lastMissing.join(", ")}]`);
    if (attempt === 1) {
      messages.push({ role: "assistant", content: result.content });
      messages.push({ role: "user", content: correctiveMessage(lastProblem, lastMissing) });
    }
  }

  if (outcome === null) {
    throw new ToolError(
      `The local model failed to produce valid output after a corrective retry: ${lastProblem}. ` +
        (lastMissing.length > 0 ? `Missing files: ${lastMissing.join(", ")}. ` : "") +
        "Consider narrowing the spec, sending fewer files, or raising LOCAL_CODER_MAX_OUTPUT_TOKENS if truncated.",
      "model_output_malformed",
      { problem: lastProblem, missing_files: lastMissing, model }
    );
  }

  const diffs: string[] = [];
  const changes: Array<{ rel: string; abs: string; added: number; removed: number; content: string }> = [];
  for (const [rel, file] of declared) {
    const updated = outcome.files.get(rel);
    if (updated === undefined || effectivelyUnchanged(file.content, updated)) continue;
    const fileDiff = unifiedFileDiff(file.rel, file.content, updated);
    if (fileDiff === "") continue;
    const stats = diffStats(fileDiff);
    diffs.push(fileDiff);
    changes.push({ rel: file.rel, abs: file.abs, ...stats, content: updated });
  }

  if (mode === "apply") {
    // Compare-and-swap across ALL files before writing any of them, so a
    // conflict on the second file cannot leave the first one written. An
    // unreadable file counts as a mismatch: if we cannot confirm the bytes, we
    // do not get to overwrite them.
    if (deps.expectedContent !== undefined) {
      const conflicts: string[] = [];
      for (const change of changes) {
        const expected = deps.expectedContent.get(normalizeRel(change.rel));
        if (expected === undefined) continue;
        const current = await fs.readFile(change.abs, "utf8").catch(() => null);
        if (current !== expected) conflicts.push(change.rel);
      }
      if (conflicts.length > 0) {
        throw new ToolError(
          `Refusing to write: ${conflicts.join(", ")} changed on disk after this call started. ` +
            `Something else is editing ${conflicts.length === 1 ? "that file" : "those files"}, and ` +
            `overwriting would destroy the change.`,
          "concurrent_modification",
          { files: conflicts }
        );
      }
    }

    for (const change of changes) {
      // Re-check immediately before this file's own write. The sweep above
      // catches the common case before anything is touched; this narrows the
      // remaining check-to-write window from "the whole sweep" to a single
      // syscall pair. It cannot be closed entirely without file locking —
      // rename() is atomic but not conditional — so the guarantee is a narrowed
      // window, not an eliminated one, and the tool description says so.
      const expected = deps.expectedContent?.get(normalizeRel(change.rel));
      if (expected !== undefined) {
        const current = await fs.readFile(change.abs, "utf8").catch(() => null);
        if (current !== expected) {
          throw new ToolError(
            `Refusing to write: ${change.rel} changed on disk between the check and the write.`,
            "concurrent_modification",
            { files: [change.rel] }
          );
        }
      }
      await atomicWriteFile(change.abs, change.content);
      // Report each write as it lands, so a throw part-way through still leaves
      // the caller knowing exactly which files carry its bytes.
      deps.onFileWritten?.(change.rel, change.content);
      log.info(`applied changes to ${change.rel} (+${change.added}/-${change.removed})`);
    }
  }

  return {
    summary: composeSummary(kind, args.spec, changes, mode === "apply"),
    diff: diffs.join(""),
    files_changed: changes.map((c) => c.rel),
    applied: mode === "apply" && changes.length > 0,
    model,
    selection_reason: reason,
    latency_ms: Date.now() - started,
    usage,
  };
}
