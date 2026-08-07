/**
 * contract-stability.ts — measure how stable the local model's WHOLE-FILE
 * output contract is, over real files of this repo, and write the rows as JSON.
 *
 *   lms server start
 *   # MATCH THE SERVER'S OWN ENV — `node scripts/set-server-env.mjs show` prints it.
 *   # A plain shell inherits neither, and the defaults (8192 / 300s) are not what
 *   # the MCP server runs with. The first attempt at this diagnostic measured a
 *   # 8192 cap: `src/tools/repair.ts` was refused as over-cap and the 10-file
 *   # ladder silently became 9. The config line printed at startup is what
 *   # catches it — read it before trusting a run.
 *   LOCAL_CODER_MAX_OUTPUT_TOKENS=16384 LOCAL_CODER_TIMEOUT_MS=600000 \
 *     npx tsx scripts/contract-stability.ts
 *   npx tsx scripts/contract-stability.ts --arm=single --repeats=3 --out=evidence/x.json
 *
 * The contract under test is the one `implement`/`fix` depend on, quoted from
 * IMPLEMENT_SYSTEM_PROMPT: "Return the COMPLETE final content of EVERY editable
 * file listed in the request". Every response is sorted into exactly one of
 * `complete` / `elided` / `truncated` by `src/contract-probe.ts` — the rules
 * live there, under `tsc` and under the test suite, because `tsconfig.json`
 * covers `src/**` and `tests/**` but NOT `scripts/**` — this file is unchecked —
 * and a scoring bug here would corrupt every number silently. This file is the
 * runner: corpus, requests, aggregation, artifact.
 *
 * A request that never produced a response (timeout, HTTP, unreachable) is
 * counted as `errored` and kept out of the three categories — a timeout is not
 * a contract verdict.
 *
 * WHY IT IMPORTS THE PROMPTS RATHER THAN RESTATING THEM. `buildUserMessage`,
 * `IMPLEMENT_SYSTEM_PROMPT` and `correctiveMessage` come from
 * `src/tools/shared.ts`, so the bytes sent here are the bytes the server sends.
 * A local copy would drift on the next prompt edit and start measuring a
 * contract nothing ships.
 *
 * WHAT IT DOES NOT MEASURE. Nothing here writes to the files under test — every
 * request is diff-mode-equivalent and the working tree is only read. And with
 * one response per case the run measures the contract's dependence on FILE SIZE
 * and BLOCK COUNT, not run-to-run variance at a fixed size; `--repeats=N` is the
 * only way the word "stability" covers both.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import {
  classifyResponse,
  PROBE_SPEC,
  SILENT_ELISION_MIN_RUN,
  type FileVerdict,
  type ProbeTarget,
  PROBE_MARKER,
} from "../src/contract-probe.js";
import { enforceOutputCap, readTextFileSafe } from "../src/fs-safety.js";
import { chatCompletion, type ChatMessage } from "../src/llm-client.js";
import { getLoadedLmsModels } from "../src/lms.js";
import { loadModelCatalog } from "../src/models-csv.js";
import { normalizeRel } from "../src/parse.js";
import { resolveModel } from "../src/selection.js";
import {
  buildUserMessage,
  correctiveMessage,
  IMPLEMENT_SYSTEM_PROMPT,
  promptInputBytes,
  resolveContextTokens,
  type LoadedFile,
} from "../src/tools/shared.js";

// ---------------------------------------------------------------- the corpus

/**
 * Ten real files of this repo, each roughly double the previous — 665 B to
 * 35.6 KB, a 53× span. Size is what varies; all ten are TypeScript from src/ so
 * one probe spec fits all of them and size stays the only moving part.
 *
 * The top end is set by the server's own pre-flight, not by taste: at
 * LOCAL_CODER_MAX_OUTPUT_TOKENS=16384, `enforceOutputCap` refuses anything over
 * ~51.6 KB, so a larger file would measure a request the server never sends.
 *
 * src/parse.ts is in the ladder deliberately: its source contains
 * `...entire final file content...` and line-anchored `<file>` literals, so it
 * is the case that catches a scorer naive enough to grep for ellipses without
 * comparing against the original. `tests/contract-probe.test.ts` pins that.
 */
const LADDER = [
  "src/logger.ts",
  "src/diff.ts",
  "src/telemetry.ts",
  "src/parse.ts",
  "src/server.ts",
  "src/fs-safety.ts",
  "src/cost/transcript.ts",
  "src/tools/gate.ts",
  "src/cost/report.ts",
  "src/tools/repair.ts",
];

/**
 * The multi-file arm. A single-file request declares one block, so the ladder
 * cannot observe the failure the contract sentence is actually aimed at —
 * returning the first file and forgetting the second. These groups vary block
 * count (2, 3, 2) and total size (2.4 KB, 14.8 KB, 21.7 KB) independently, and
 * each stays under the output cap.
 */
const GROUPS = [
  ["src/logger.ts", "src/diff.ts"],
  ["src/telemetry.ts", "src/parse.ts", "src/server.ts"],
  ["src/fs-safety.ts", "src/cost/transcript.ts"],
];

// -------------------------------------------------------------------- runner

interface AttemptRow {
  attempt: number;
  category: "complete" | "elided" | "truncated";
  reason: string;
  finish_reason: string | null;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  raw_bytes: number;
  /**
   * Hash of the raw response. At temperature 0.1 two responses to an identical
   * prompt may come back byte-identical; counting distinct hashes per case
   * separates "the contract is stable" from "the sampler barely moved", which a
   * category tally alone cannot tell apart.
   */
  raw_sha256_16: string;
  /** The whole response arrived wrapped in a markdown fence. */
  outer_fence: boolean;
  /** Paths returned that the request never declared. */
  extra_paths: string[];
  /**
   * Where this response's raw bytes were written, or null if the write failed.
   *
   * Scoring a response and then discarding it makes the artifact unable to show
   * its own evidence: `src/tools/repair.ts` elided 90 lines reproducibly, and
   * recovering WHICH 90 cost three further model runs and still missed, because
   * the failure mode flips between elided and truncated. Same reasoning as
   * `gate`'s spill — the verdict is small, the proof is large, keep both.
   */
  spill: string | null;
  files: FileVerdict[];
}

interface CaseRow {
  case_id: string;
  /** Same across repeats of one case — what the variance section groups by. */
  base_case_id: string;
  arm: "single" | "multi";
  repeat: number;
  paths: string[];
  block_count: number;
  total_bytes: number;
  estimated_output_tokens: number;
  usable_output_tokens: number;
  /** The verdict that counts: the first response, before any correction. */
  first: AttemptRow | null;
  /** The pipeline's one corrective retry, run only when `first` is not complete. */
  retry: AttemptRow | null;
  /**
   * Times LM Studio dropped the connection and the SAME request had to be
   * re-sent. Recorded, not hidden: on this 36 GB machine the largest ladder case
   * (`src/tools/repair.ts`, 815 lines) crashed the runtime once — a 16 GB model
   * plus the KV cache for a ~10k-token answer exhausts memory. That is an
   * infrastructure fault, so it must not be scored as a contract verdict, and it
   * must not silently vanish either.
   */
  infra_retries: number;
  error: { code: string; message: string } | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Refusals from `enforceOutputCap` — a request never sent, not a failed one. */
const PREFLIGHT_CODES = new Set(["output_would_truncate", "context_would_overflow"]);

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** HEAD and tree cleanliness — never fatal, a missing git is just nulls. */
function gitProvenance(root: string): { head: string | null; dirty: boolean | null } {
  const git = (a: string[]): string | null => {
    try {
      return execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  const status = git(["status", "--porcelain"]);
  return { head: git(["rev-parse", "HEAD"]), dirty: status === null ? null : status !== "" };
}

async function main(): Promise<void> {
  const repeats = Math.max(1, Math.trunc(Number(flag("repeats", "1")) || 1));
  const arm = flag("arm", "both");
  const stamp = new Date().toISOString();
  const runId = flag("run-id", `${stamp.slice(0, 10)}-contract-${stamp.slice(11, 19).replace(/:/g, "")}Z`);

  const config = loadConfig(process.env, process.cwd());
  config.models = await loadModelCatalog(config.modelsCsvPath);
  const modelFlag = flag("model", "");
  const { model, reason } = await resolveModel(modelFlag === "" ? undefined : modelFlag, config, {});

  // The MCP server runs with LOCAL_CODER_MAX_OUTPUT_TOKENS=16384 in its own env
  // block; a shell without it would measure a 8192 cap and call the difference
  // model instability. So the number is printed and recorded, not assumed.
  const budget = Math.floor(config.maxOutputTokens * config.outputUsableFraction);

  // The loaded context length, shared between input and output, is the real
  // ceiling on a whole-file answer — and it is NOT `maxOutputTokens`. Without
  // it the artifact cannot explain its own largest case, so it is probed and
  // recorded rather than inferred afterwards.
  const loaded = await getLoadedLmsModels();
  const loadedSelf = loaded?.find((m) => m.ids.some((id) => id === model)) ?? null;
  // Through the same resolver the server uses, so LOCAL_CODER_CONTEXT_TOKENS is
  // honoured here too and the diagnostic cannot judge against a window the
  // server would not have used.
  const contextTokens = await resolveContextTokens(config, modelFlag === "" ? undefined : modelFlag, {});
  const contextLength = contextTokens;
  if (contextLength !== null) {
    process.stderr.write(
      `  loaded context_length=${contextLength} (max ${loadedSelf?.maxContextLength ?? "?"}) — ` +
        `input+output share this\n`
    );
  }

  process.stderr.write(
    `contract-stability — model ${model}\n  (${reason})\n` +
      `  max_output_tokens=${config.maxOutputTokens} usable=${budget} ` +
      `temperature=${config.temperature} timeout_ms=${config.timeoutMs}\n` +
      `  arms=${arm} repeats=${repeats}\n\n`
  );

  const spillDir = path.resolve(config.root, flag("spill-dir", ".local-coder/contract-spill"));
  await fs.mkdir(spillDir, { recursive: true });

  const cases: Array<{ id: string; arm: "single" | "multi"; paths: string[] }> = [];
  // `--files=a.ts,b.ts` replaces the corpus with one ad-hoc case — for chasing a
  // single file's behaviour without paying for the whole ladder.
  const adHoc = flag("files", "");
  if (adHoc !== "") {
    const paths = adHoc.split(",").map((p) => p.trim()).filter((p) => p !== "");
    cases.push({ id: "AD", arm: paths.length > 1 ? "multi" : "single", paths });
  } else if (arm === "single" || arm === "both") {
    LADDER.forEach((p, i) =>
      cases.push({ id: `L${String(i + 1).padStart(2, "0")}`, arm: "single", paths: [p] })
    );
  }
  if (adHoc === "" && (arm === "multi" || arm === "both")) {
    GROUPS.forEach((g, i) => cases.push({ id: `G${i + 1}`, arm: "multi", paths: g }));
  }

  const rows: CaseRow[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const spec of cases) {
      const caseId = repeats > 1 ? `${spec.id}r${repeat}` : spec.id;
      const loaded: LoadedFile[] = [];
      for (const rel of spec.paths) {
        loaded.push(await readTextFileSafe(config.root, rel, config.maxFileKb));
      }
      const totalBytes = loaded.reduce((s, f) => s + f.bytes, 0);
      const row: CaseRow = {
        case_id: caseId,
        base_case_id: spec.id,
        arm: spec.arm,
        repeat,
        paths: loaded.map((f) => normalizeRel(f.rel)),
        block_count: loaded.length,
        total_bytes: totalBytes,
        estimated_output_tokens: Math.round(totalBytes / config.outputBytesPerToken),
        usable_output_tokens: budget,
        first: null,
        retry: null,
        infra_retries: 0,
        error: null,
      };
      rows.push(row);

      // Refuse exactly what the server refuses, for the same reason it does: a
      // request whose whole-file answer cannot fit is arithmetic, not instability.
      // BOTH pre-flights, output cap and context window — passing only the first
      // is how this diagnostic sent `src/tools/repair.ts` in the first place.
      try {
        enforceOutputCap(
          loaded.map((f) => ({ rel: f.rel, bytes: f.bytes })),
          config.maxOutputTokens,
          config.outputBytesPerToken,
          config.outputUsableFraction,
          {
            contextTokens,
            inputBytes: promptInputBytes(loaded, PROBE_SPEC),
            inputBytesPerToken: config.inputBytesPerToken,
          }
        );
      } catch (error) {
        const err = error as Error & { code?: string; details?: Record<string, unknown> };
        row.error = { code: err.code ?? "preflight_refused", message: err.message };
        process.stderr.write(
          `${caseId}  SKIP      refused by the ${err.code} pre-flight` +
            (err.details?.estimated_total_tokens !== undefined
              ? ` (~${String(err.details.estimated_total_tokens)} tokens needed, ` +
                `~${String(err.details.usable_context_tokens)} usable of a ` +
                `${String(err.details.context_tokens)}-token window)`
              : ` (~${row.estimated_output_tokens} output tokens > ${budget})`) +
            `\n`
        );
        continue;
      }

      const declared = new Map<string, ProbeTarget>(
        loaded.map((f) => [normalizeRel(f.rel), { bytes: f.bytes, content: f.content }])
      );
      const messages: ChatMessage[] = [
        { role: "system", content: IMPLEMENT_SYSTEM_PROMPT },
        {
          role: "user",
          content: buildUserMessage({ spec: PROBE_SPEC, files: spec.paths }, loaded, []),
        },
      ];

      for (let attempt = 1; attempt <= 2; attempt++) {
        // Reset per send, INSIDE the infra loop. Hoisting this above the loop
        // charged the crashed sends and their 30s waits to the response that
        // eventually succeeded: L10r1 of run 2026-08-04-mac-12-variance reads
        // 803s for a request that actually took ~700s of generation.
        let started = Date.now();
        let result;
        // Re-send on a dropped connection only. A crashed/reloading runtime is an
        // infrastructure fault and re-sending the identical request is sound; a
        // TIMEOUT is not retried, because slowness is a real signal about this
        // request's size and papering over it would erase the measurement.
        let attemptError: (Error & { code?: string }) | null = null;
        for (let infra = 0; infra <= 2; infra++) {
          try {
            started = Date.now();
            result = await chatCompletion({
              baseUrl: config.baseUrl,
              model,
              messages,
              temperature: config.temperature,
              maxTokens: config.maxOutputTokens,
              timeoutMs: config.timeoutMs,
            });
            attemptError = null;
            break;
          } catch (error) {
            attemptError = error as Error & { code?: string };
            if (attemptError.code !== "llm_unreachable" || infra === 2) break;
            row.infra_retries += 1;
            process.stderr.write(
              `${caseId}  RETRY     connection dropped (likely a runtime crash under memory ` +
                `pressure); waiting 30s and re-sending attempt ${attempt}\n`
            );
            await sleep(30_000);
          }
        }
        if (attemptError !== null || result === undefined) {
          const err = attemptError ?? new Error("no response");
          row.error = { code: (err as { code?: string }).code ?? "request_failed", message: err.message };
          process.stderr.write(`${caseId}  ERROR     attempt ${attempt}: ${err.message.slice(0, 160)}\n`);
          break;
        }
        const latencyMs = Date.now() - started;
        const verdict = classifyResponse(result.content, result.finishReason, declared);

        // Raw response to disk, under .local-coder/ (gitignored, per-machine) so
        // the versioned evidence/ artifact stays a summary. A failed write is
        // recorded as null and never fails the run — losing a verdict to a
        // bookkeeping error would be worse than losing the proof.
        const spillPath = path.join(spillDir, `${runId}.${caseId}.a${attempt}.txt`);
        let spill: string | null = null;
        try {
          await fs.writeFile(spillPath, result.content, "utf8");
          spill = path.relative(config.root, spillPath);
        } catch (error) {
          process.stderr.write(
            `${caseId}  warn: could not spill the raw response: ${(error as Error).message}\n`
          );
        }
        const attemptRow: AttemptRow = {
          attempt,
          category: verdict.category,
          reason: verdict.reason,
          finish_reason: result.finishReason,
          latency_ms: latencyMs,
          prompt_tokens: result.usage.prompt_tokens,
          completion_tokens: result.usage.completion_tokens,
          raw_bytes: Buffer.byteLength(result.content, "utf8"),
          raw_sha256_16: createHash("sha256").update(result.content).digest("hex").slice(0, 16),
          outer_fence: result.content.trim().startsWith("```"),
          extra_paths: verdict.extras,
          spill,
          files: verdict.files,
        };
        if (attempt === 1) row.first = attemptRow;
        else row.retry = attemptRow;

        const probed = verdict.files.filter((f) => f.probe_applied === true).length;
        process.stderr.write(
          `${caseId}  ${verdict.category.toUpperCase().padEnd(9)} ` +
            `a${attempt}  ${(latencyMs / 1000).toFixed(1).padStart(6)}s  ` +
            `${String(result.usage.completion_tokens).padStart(6)} out  ` +
            `probe ${probed}/${loaded.length}  ${verdict.reason.slice(0, 110)}\n`
        );

        if (verdict.category === "complete") break;
        if (attempt === 1) {
          // The shipped pipeline's one corrective retry, same shape: the bad
          // response stays in the transcript and the correction names what was
          // wrong with it.
          const missing = verdict.files.filter((f) => !f.returned).map((f) => f.path);
          const problem =
            verdict.category === "truncated"
              ? "the response was truncated (finish_reason=length) before all file blocks were complete"
              : "the response did not include every declared editable file";
          messages.push({ role: "assistant", content: result.content });
          messages.push({ role: "user", content: correctiveMessage(problem, missing) });
        }
      }
    }
  }

  // ------------------------------------------------------------- aggregation

  const scored = rows.filter((r) => r.first !== null);
  const tally = (list: CaseRow[], pick: (r: CaseRow) => AttemptRow | null) => {
    const out = { complete: 0, elided: 0, truncated: 0 };
    for (const r of list) {
      const a = pick(r);
      if (a !== null) out[a.category] += 1;
    }
    return out;
  };
  const firstPass = tally(scored, (r) => r.first);
  const notComplete = scored.filter((r) => r.first!.category !== "complete");
  const afterRetry = tally(notComplete, (r) => r.retry);

  /**
   * Per-case agreement across repeats — the only thing that answers "is the
   * contract stable at a fixed size", as opposed to "how does it degrade with
   * size". A pooled tally of 39 responses cannot distinguish 13 cases that each
   * flip once from 13 cases where 4 always fail and 9 always pass.
   *
   * `distinct_outputs` is reported next to the categories on purpose: unanimous
   * categories over byte-identical outputs is a near-deterministic sampler, not
   * demonstrated robustness, and the two deserve different confidence.
   */
  const variance =
    repeats <= 1
      ? null
      : (() => {
          const groups = new Map<string, CaseRow[]>();
          for (const r of scored) {
            const list = groups.get(r.base_case_id) ?? [];
            list.push(r);
            groups.set(r.base_case_id, list);
          }
          const detail = [...groups.entries()].map(([base, list]) => {
            const categories = list.map((r) => r.first!.category);
            return {
              base_case_id: base,
              arm: list[0]!.arm,
              paths: list[0]!.paths,
              total_bytes: list[0]!.total_bytes,
              responses: list.length,
              categories,
              unanimous: new Set(categories).size === 1,
              distinct_outputs: new Set(list.map((r) => r.first!.raw_sha256_16)).size,
              completion_tokens: list.map((r) => r.first!.completion_tokens),
              probe_applied: list.map(
                (r) => r.first!.files.filter((f) => f.probe_applied === true).length
              ),
            };
          });
          const comparable = detail.filter((d) => d.responses > 1);
          return {
            cases: detail.length,
            cases_with_multiple_responses: comparable.length,
            unanimous_cases: comparable.filter((d) => d.unanimous).length,
            divergent_cases: comparable
              .filter((d) => !d.unanimous)
              .map((d) => ({
                base_case_id: d.base_case_id,
                paths: d.paths,
                total_bytes: d.total_bytes,
                categories: d.categories,
              })),
            byte_identical_cases: comparable.filter((d) => d.distinct_outputs === 1).length,
            detail,
          };
        })();

  const summary = {
    responses_requested: rows.length,
    responses_scored: scored.length,
    /**
     * Refused by a pre-flight, so no model call happened and there is no verdict
     * to score. A refusal is a fact about the request, not about the contract —
     * it belongs in neither the three categories nor the error count.
     */
    refused_by_preflight: rows.filter((r) => r.error !== null && PREFLIGHT_CODES.has(r.error.code))
      .length,
    refusals: rows
      .filter((r) => r.error !== null && PREFLIGHT_CODES.has(r.error.code))
      .map((r) => ({ case_id: r.case_id, paths: r.paths, code: r.error!.code })),
    errored: rows.filter((r) => r.error !== null && !PREFLIGHT_CODES.has(r.error.code)).length,
    first_response: {
      ...firstPass,
      complete_rate: scored.length === 0 ? null : Number((firstPass.complete / scored.length).toFixed(3)),
    },
    corrective_retry: { eligible: notComplete.length, ...afterRetry, rescued: afterRetry.complete },
    /** Contract honoured but the task ignored — a pass that is not a success. */
    responses_with_a_verbatim_echo: scored.filter((r) =>
      r.first!.files.some((f) => f.verbatim_echo === true)
    ).length,
    responses_with_probe_in_every_file: scored.filter(
      (r) => r.first!.files.length > 0 && r.first!.files.every((f) => f.probe_applied === true)
    ).length,
    by_arm: (["single", "multi"] as const)
      .map((a) => {
        const subset = scored.filter((r) => r.arm === a);
        return { arm: a, n: subset.length, ...tally(subset, (r) => r.first) };
      })
      .filter((s) => s.n > 0),
    variance,
  };

  const artifact = {
    diagnostic: "contract-stability",
    contract:
      "IMPLEMENT_SYSTEM_PROMPT: return the COMPLETE final content of EVERY editable file listed in the request",
    run_id: runId,
    ts: stamp,
    // Which bytes of this repo were under test; the files are read from the
    // working tree, so its cleanliness is part of the provenance.
    repo: gitProvenance(config.root),
    model,
    model_selection_reason: reason,
    config: {
      base_url: config.baseUrl,
      temperature: config.temperature,
      max_output_tokens: config.maxOutputTokens,
      output_usable_fraction: config.outputUsableFraction,
      output_bytes_per_token: config.outputBytesPerToken,
      usable_output_tokens: budget,
      timeout_ms: config.timeoutMs,
      /**
       * The binding constraint, recorded next to the cap that ignores it.
       * `enforceOutputCap` checks estimated OUTPUT against max_output_tokens;
       * the model must fit input + output inside context_length.
       */
      loaded_context_length: contextLength,
      loaded_max_context_length: loadedSelf?.maxContextLength ?? null,
    },
    method: {
      spec: PROBE_SPEC,
      probe_marker: PROBE_MARKER,
      silent_elision_min_run: SILENT_ELISION_MIN_RUN,
      repeats,
      arms: arm,
      categories:
        "truncated (finish_reason=length | unclosed block | missing block) > " +
        "elided (a novel ellipsis / 'rest unchanged' comment, or >= silent_elision_min_run " +
        "consecutive original lines gone with no marker) > complete. First matching rule wins.",
      caveat:
        "One response per case measures size- and block-count-dependence, not run-to-run " +
        "variance at fixed size. Re-run with --repeats>1 for the latter.",
    },
    summary,
    rows,
  };

  const outPath = path.resolve(config.root, flag("out", `evidence/${runId}.contract-stability.json`));
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  process.stderr.write(
    `\n${JSON.stringify(summary, null, 2)}\n\nwrote ${path.relative(config.root, outPath)}\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
