import { promises as fs } from "node:fs";

import type { Config } from "../config.js";
import { diffStats, unifiedFileDiff } from "../diff.js";
import {
  atomicWriteFile,
  enforceContextCaps,
  enforceOutputCap,
  readTextFileSafe,
  resolveSafePath,
  ToolError,
} from "../fs-safety.js";
import type { CommandRunner } from "../exec.js";
import { chatCompletion, type ChatMessage, type FetchLike, type Usage } from "../llm-client.js";
import { getLoadedLmsModels, pickLoadedContextTokens } from "../lms.js";
import { log } from "../logger.js";
import { FILE_BLOCK_FORMAT, normalizeRel, parseFileBlocks } from "../parse.js";
import { resolveModel } from "../selection.js";

export { normalizeRel };

/**
 * Resolve the context window the pre-flight will judge against: the SMALLER of
 * what was configured and what `lms ps` reports, or whichever one is knowable,
 * or null so the check is skipped.
 *
 * THE EXPLICIT SETTING NO LONGER SHORT-CIRCUITS THE PROBE, and the reason is
 * observed. `LOCAL_CODER_CONTEXT_TOKENS` is a belief; `lms ps` is an
 * observation. On 2026-08-04 a model explicitly loaded at 32,768 was found
 * loaded at 16,384 — the default — with the server still up and nobody having
 * touched the configuration. (What triggered the reload is NOT established: two
 * workloads were competing for memory at the time. The reload itself is the
 * fact, and it is enough.) A declared window can go stale on its own, which is
 * exactly the state that admits a request the model cannot honour and returns a
 * closed, well-formed, shorter file. Short-circuiting meant the person who
 * configured the value was the one guaranteed never to find out.
 *
 * `Math.min` because the failure is asymmetric: too small costs a refusal the
 * caller can retry, too large costs content nobody notices is gone. A
 * disagreement is warned about rather than silently resolved, because either
 * number could be the stale one.
 *
 * The probe costs ~120 ms measured, against generations that run for seconds to
 * minutes. `deps.contextTokens` still short-circuits entirely — that is the
 * suite's injection point, not a user-facing setting.
 */
export async function resolveContextTokens(
  config: Config,
  wanted: string | undefined,
  deps: { runner?: CommandRunner; contextTokens?: number | null; fetchImpl?: FetchLike } = {}
): Promise<number | null> {
  if (deps.contextTokens !== undefined) return deps.contextTokens;
  // `typeof`, not `!== null`: a Config literal built without the field (nothing
  // type-checks those) arrives as undefined, and returning that would hand
  // `enforceOutputCap` a NaN budget.
  const configured = typeof config.contextTokens === "number" ? config.contextTokens : null;
  // Probe only with a runner we were actually handed, or the real one when the
  // caller injected no fetch either. Same rule `selection.ts` applies to its
  // `/models` probe and for the same reason: a suite that injected a fake fetch
  // must not reach out to the real machine, or the offline tests turn green only
  // where LM Studio happens to be running.
  const canProbe = !(deps.runner === undefined && deps.fetchImpl !== undefined);
  const probed = canProbe
    ? pickLoadedContextTokens(await getLoadedLmsModels(deps.runner), wanted)
    : null;
  if (configured === null) return probed;
  if (probed === null) return configured;
  if (probed !== configured) {
    log.warn(
      `context window disagreement: LOCAL_CODER_CONTEXT_TOKENS=${configured} but \`lms ps\` reports ` +
        `${probed} loaded. Using ${Math.min(configured, probed)}. A runtime crash reloads a model at ` +
        `its default context, so the configured value can be stale without anyone changing it.`
    );
  }
  return Math.min(configured, probed);
}

/** Bytes of everything that enters the prompt — every file sent, plus the spec. */
export function promptInputBytes(
  statted: ReadonlyArray<{ bytes: number }>,
  spec: string,
  errorOutput?: string | undefined
): number {
  return (
    statted.reduce((sum, f) => sum + f.bytes, 0) +
    Buffer.byteLength(spec, "utf8") +
    (errorOutput === undefined ? 0 : Buffer.byteLength(errorOutput, "utf8"))
  );
}

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
  /**
   * The model this generation resolved to, reported the moment it is known and
   * BEFORE the first request goes out. The returned `GenerationResult` also
   * carries it, and for a caller that lets the throw propagate that is enough —
   * but `repair` catches it and keeps going, so on every failed round the name
   * was resolved, used to make the request, and then thrown away with the stack.
   * Measured: 3 of 4 rows in `run 2026-08-04-mac-07` carried `model: null`, and
   * they were precisely the failures — which is what B6 counts and what B7 times.
   */
  onModelResolved?: (model: string) => void;
  /**
   * The context files that actually went INTO the prompt, reported once the
   * message is assembled — not the `context_files` argument.
   *
   * The two differ: a path passed as both context and editable is dropped here
   * and treated as editable only, and a caller recording its own argument would
   * report a file the model never saw as context. That is the same class of
   * error as `run 2026-08-04-mac-19-32k`'s declared-vs-loaded window, and B12's
   * PHASE-3 EXPOSURE B registers a VOID condition on this exact fact — which,
   * until this callback existed, no artifact could evaluate.
   *
   * Fired AFTER `loadFiles`, deliberately, unlike `onModelResolved`: a request
   * refused by the caps never assembled a prompt, and recording paths for it
   * would record an intent as an observation. A caller that never hears from
   * this had no round put a prompt together at all, which is different from a
   * round that assembled one carrying no context files.
   */
  onContextResolved?: (paths: string[]) => void;
  /**
   * Called with each model response the moment it is parsed — before the diff,
   * the compare-and-swap or the write, any of which can throw.
   *
   * A caller that instead reads `GenerationResult.attempts` only sees responses
   * from generations that reached the return, so a `concurrent_modification` or
   * a failed write silently removes an already-measured response from B16's
   * denominator. Those are exactly the racy, partial-failure paths where the
   * data is most worth having. Exceptions from this callback are logged and
   * swallowed: it is bookkeeping.
   */
  onAttempt?: (attempt: GenerationAttempt) => void;
  /**
   * Context window to judge the request against, bypassing both the config
   * setting and the `lms` probe. `repair` passes its own already-resolved value
   * so the loop does not re-probe once per round, and tests use it to exercise
   * the pre-flight without a fake runner. `null` explicitly disables the check.
   */
  contextTokens?: number | null;
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

/**
 * One model request, kept separate from every other one in the same generation.
 *
 * WHY PER ATTEMPT AND NOT SUMMED. A generation makes up to two requests — the
 * first, and the corrective retry — and `usage` below is their SUM. A context
 * window is a per-request ceiling, so comparing the sum against it is a category
 * error that fires in both directions: the retry's prompt carries the whole bad
 * response plus the corrective message, so any round that retries inflates the
 * total far past what either request actually cost, while a round that ends in
 * `model_output_malformed` used to report nothing at all — and that is precisely
 * the case most likely to BE context exhaustion. B16 reads these rows; a
 * detector that drops its positives and invents negatives measures nothing.
 */
export interface GenerationAttempt {
  attempt: number;
  /** Null when the server reported no usable `usage` — not zero. */
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /**
   * The server's stop reason, kept as its own INDEPENDENT field. It is reported
   * and never folded into `envelope`, for the reason B14 exists: the moment a
   * signal is allowed to stand in for an outcome, a quirk of the signal becomes
   * a verdict about the work.
   */
  finish_reason: string | null;
  /**
   * What the ENVELOPE looked like — whether every declared block arrived and
   * closed — derived from the parsed blocks and from nothing else.
   *
   * In particular NOT from `finish_reason`. A response can reach `max_tokens`
   * immediately after closing its last block: the envelope is complete, and
   * labelling it by the stop reason would file a sound response as a failure.
   * Over a 20-request denominator with a 10% bar, a handful of those is enough
   * to fail B16 on an artefact of the label.
   *
   * Also not a full contract verdict: `src/contract-probe.ts` additionally
   * scores `elided`, and that tier reads a run of deleted lines as dropped
   * content, which is invalid here because deleting lines is exactly what
   * `repair` is asked to do. The envelope half is unambiguous for any caller;
   * the elision half is only measurable under the diagnostic's probe spec,
   * whose task is a pure append.
   */
  envelope: "complete" | "missing_blocks" | "no_blocks";
  missing_files: string[];
  /**
   * The window THIS request was judged against, carried on the attempt rather
   * than on the round. A caller cannot supply it from its own scope: the model
   * is resolved per generation, so a loop that pinned one window across rounds
   * would score a later round against a window belonging to an earlier round's
   * model. The number and the request it describes travel together or not at all.
   */
  context_tokens: number | null;
}

export interface GenerationResult {
  summary: string;
  diff: string;
  files_changed: string[];
  applied: boolean;
  model: string;
  selection_reason: string;
  latency_ms: number;
  /**
   * SUMMED ACROSS ATTEMPTS. Fine for billing, wrong for anything compared
   * against a context window — use `attempts` for that. See `GenerationAttempt`.
   */
  usage: Usage;
  /** Every model request this generation made, in order. */
  attempts: GenerationAttempt[];
  /**
   * The window these requests were judged against, or null when it could not be
   * determined. Returned because `prompt_tokens + completion_tokens` of a single
   * attempt against THIS number is what `contextExhausted` reads, and it is the
   * only signal that catches a response which came back well-formed and short.
   */
  context_tokens: number | null;
}

/**
 * Exported for `scripts/contract-stability.ts`, which measures how often the
 * local model honours this contract. That diagnostic must send the SAME bytes
 * this pipeline sends — a copy in the script would drift and quietly start
 * measuring a prompt the server does not use. Same reason `buildUserMessage`,
 * `correctiveMessage` and `LoadedFile` are exported below.
 */
export const IMPLEMENT_SYSTEM_PROMPT = `You are a senior software engineer implementing a precise specification.
Rules:
- Follow the specification exactly. Change only what the specification requires.
- Preserve each file's existing code style, formatting, naming, and imports.
- Return the COMPLETE final content of EVERY editable file listed in the request, even files you leave unchanged.
- Use exactly this output format, one block per editable file:
${FILE_BLOCK_FORMAT}
- Output nothing but <file> blocks: no prose, no explanations, no markdown fences, no diff syntax.`;

const FIX_SYSTEM_PROMPT = `${IMPLEMENT_SYSTEM_PROMPT}
- You are fixing a concrete reported failure. Make the MINIMAL targeted change that resolves the error output. Do not refactor, rewrite, reformat, or "improve" anything the fix does not require.`;

export interface LoadedFile {
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

export function buildUserMessage(
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

export function correctiveMessage(problem: string, missing: string[]): string {
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
  // And the same for what comes BACK, which the input caps say nothing about.
  // Selected by membership rather than by position: statAll returns rel as
  // resolveSafePath spells it, so trusting the input order to survive the round
  // trip would put a context file in the output budget the first time the two
  // spellings differ.
  const editableSet = new Set(editablePaths);
  // Resolved once and kept: the pre-flight judges against this number, and the
  // returned result reports it, so a caller can tell a response that fit from
  // one that filled the window. Re-resolving for the report could disagree with
  // what was actually enforced.
  // THE MODEL FIRST, THEN ITS WINDOW. Resolving the window from `args.model`
  // asks about a model that may not be the one this request runs on: with
  // nothing named, `args.model` is undefined and the probe would answer with
  // whatever single model happens to be loaded, while auto-selection sends the
  // work to a different catalog entry. A 32k model loaded and a 16k model
  // selected admits a request that overflows — and an overflowing request is
  // what comes back closed, well-formed and short. The inverse pairing refuses
  // work that would have fit.
  const { model, reason } = await resolveModel(args.model, config, deps);
  // Announced before anything below can throw, so a caller that survives the
  // throw still has something to attribute the attempt to — including a
  // pre-flight refusal, which is a fact about a specific model's window.
  deps.onModelResolved?.(model);
  const contextTokens = await resolveContextTokens(config, model, deps);
  const editableStats = statted.filter((f) => editableSet.has(normalizeRel(f.rel)));
  enforceOutputCap(
    editableStats,
    config.maxOutputTokens,
    config.outputBytesPerToken,
    config.outputUsableFraction,
    {
      contextTokens,
      // Every file sent, editable AND context, plus the spec — all of it shares
      // the window with the answer.
      inputBytes: promptInputBytes(statted, args.spec, args.error_output),
      inputBytesPerToken: config.inputBytesPerToken,
    }
  );

  const editable = await loadFiles(config.root, editablePaths, config.maxFileKb);
  const context = await loadFiles(config.root, contextPaths, config.maxFileKb);
  // Read off what was LOADED, not off `contextPaths`, for the same reason
  // `editableStats` above is selected by membership rather than by position:
  // `rel` is spelled as the loader resolved it, and a list rebuilt from the
  // argument would drift from the prompt the first time the two spellings
  // differ. This is exactly what `buildUserMessage` is about to send.
  deps.onContextResolved?.(context.map((f) => f.rel));

  const declared = new Map(editable.map((f) => [normalizeRel(f.rel), f]));
  const messages: ChatMessage[] = [
    { role: "system", content: kind === "fix" ? FIX_SYSTEM_PROMPT : IMPLEMENT_SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage(args, editable, context) },
  ];

  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
  // Every request, recorded as it happens rather than reconstructed afterwards —
  // the malformed path throws, and anything gathered only at the return is lost
  // exactly when it matters most.
  const attempts: GenerationAttempt[] = [];
  let outcome: ModelAttemptOutcome | null = null;
  let lastProblem = "";
  let lastMissing: string[] = [];
  let retrySkippedForContext = false;

  for (let attempt = 1; attempt <= 2; attempt++) {
    // Re-read the budget per attempt. The corrective retry is a whole second
    // model request; reusing the first attempt's timeout lets a caller's hard
    // deadline be exceeded by nearly another full request.
    const remaining = deps.remainingMs?.() ?? Number.POSITIVE_INFINITY;
    if (attempt > 1 && remaining <= 0) {
      log.warn("no budget left for the corrective retry; giving up on this generation");
      break;
    }

    // THE RETRY IS ITS OWN REQUEST AND GETS ITS OWN PRE-FLIGHT. The check above
    // the loop cleared attempt 1; attempt 2 carries that whole response plus the
    // corrective message on top of it, so it is strictly larger and was going
    // out unchecked. That is not only a hole in B16's denominator — "requests
    // the pre-flight admitted" would have included one it never saw — it is the
    // live failure this pre-flight exists to stop: an oversized request comes
    // back as a closed, well-formed, SHORTER file, and `repair` writes it over
    // the source.
    //
    // Measured from the real messages rather than re-derived from the files,
    // because the appended response is the whole reason the size moved. That
    // double-counts `PROMPT_OVERHEAD_TOKENS` by ~200 (the message bytes already
    // include the system prompt and tag lines) — conservative, in the direction
    // that skips a doubtful retry rather than sending one.
    if (attempt > 1 && contextTokens !== null) {
      const accumulated = messages.reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf8"), 0);
      try {
        enforceOutputCap(
          editableStats,
          config.maxOutputTokens,
          config.outputBytesPerToken,
          config.outputUsableFraction,
          { contextTokens, inputBytes: accumulated, inputBytesPerToken: config.inputBytesPerToken }
        );
      } catch (error) {
        if (!(error instanceof ToolError) || error.code !== "context_would_overflow") throw error;
        retrySkippedForContext = true;
        log.warn(
          `the corrective retry would not fit the ${contextTokens}-token window ` +
            `(~${accumulated} B of prompt after appending the bad response); not sending it`
        );
        break;
      }
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

    const record: GenerationAttempt = {
      attempt,
      prompt_tokens: result.usageKnown ? result.usage.prompt_tokens : null,
      completion_tokens: result.usageKnown ? result.usage.completion_tokens : null,
      finish_reason: result.finishReason,
      // Blocks only. `finish_reason` is reported beside this, never inside it.
      envelope:
        missing.length === 0 ? "complete" : returned.size === 0 ? "no_blocks" : "missing_blocks",
      missing_files: missing,
      context_tokens: contextTokens,
    };
    attempts.push(record);
    // Handed over the moment it exists, because everything below — the diff, the
    // compare-and-swap, the write — can throw, and a response measured and then
    // lost to an apply-stage failure is a response silently dropped from B16's
    // denominator. Wrapped for the same reason the telemetry writer never
    // throws: bookkeeping must not turn a working call into an error.
    try {
      deps.onAttempt?.(record);
    } catch (error) {
      log.warn(
        `onAttempt callback failed (continuing): ${error instanceof Error ? error.message : String(error)}`
      );
    }

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
      `The local model failed to produce valid output${
        retrySkippedForContext ? "" : " after a corrective retry"
      }: ${lastProblem}. ` +
        (lastMissing.length > 0 ? `Missing files: ${lastMissing.join(", ")}. ` : "") +
        (retrySkippedForContext
          ? "The corrective retry was NOT sent: appending the bad response to the prompt would " +
            "have overflowed the model's context window, and an overflowing request is what " +
            "produces a closed-but-shortened file. "
          : "") +
        "Consider narrowing the spec or sending fewer files. If it truncated, raising " +
        "LOCAL_CODER_MAX_OUTPUT_TOKENS only helps when that cap is what bound the answer — " +
        "prompt and answer share the model's context window, so past ~25 KB of editable source " +
        "at a 16k window the window is the binding limit and the fix is to reload the model with " +
        "a larger context (see `status` → context_window).",
      "model_output_malformed",
      // `attempts` and `context_tokens` ride on the ERROR, not only on the
      // success return. This is the path where a response came back short, so
      // it is B16's most informative case and the one a caller cannot otherwise
      // see: by the time this throws, up to two real responses have been
      // received, measured and discarded.
      {
        problem: lastProblem,
        missing_files: lastMissing,
        model,
        attempts,
        context_tokens: contextTokens,
        retry_skipped_for_context: retrySkippedForContext,
      }
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
    attempts,
    context_tokens: contextTokens,
  };
}
