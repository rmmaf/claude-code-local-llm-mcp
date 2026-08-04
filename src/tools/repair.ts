import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

import { z } from "zod";

import type { Failure } from "../checks/parsers.js";
import type { Config } from "../config.js";
import { diffStats, unifiedFileDiff } from "../diff.js";
import { defaultProcessRunner, type ProcessRunner } from "../exec.js";
import { atomicWriteFile, enforceContextCaps, readTextFileSafe, ToolError } from "../fs-safety.js";
import { log } from "../logger.js";
import { createTelemetryWriter, type TelemetryWriter } from "../telemetry.js";
import { runGate, type CheckReport, type GateResult } from "./gate.js";
import { normalizeRel, runGeneration, statAll, type ToolDeps } from "./shared.js";

export const repairToolName = "repair";

export const repairToolDescription = `Fix failing checks locally, in a loop, and return ONE diff.

This is the highest-leverage tool here. The write -> test -> fail -> fix -> test cycle normally costs 4-12 of your turns, and every one of them re-reads the entire accumulated context. This runs that whole loop on the local model and returns a single result, so those turns never happen.

Call it when the gate is red and the fix is mechanical: type errors, failing assertions, lint violations, missing imports. Do NOT call it for design work or for changes whose correctness the checks cannot verify.

Safety: the exact bytes of every file are snapshotted before the first round. If the loop cannot get to green — including when it stops on an error — the files are restored to their original contents and the best attempt is returned as an UNAPPLIED diff, so the working tree is never left broken. If a file the model wants to rewrite changed on disk since the round began, the round is abandoned before writing (\`stopped_because: "concurrent_edit"\`) and the file is left as found and named in \`restore_conflicts\`. The check runs immediately before each write, so the exposure is a syscall pair rather than the minutes generation takes — narrowed, not eliminated: only file locking could close it, and a file nobody rewrites is not checked at all (it is caught at rollback instead).

Returns { passed, rounds_used, diff, files_changed, applied, restore_conflicts, restore_failed, check_side_effects, unverified, remaining_failures, rounds: [...] }. Read the honesty fields before trusting the diff: \`unverified\` is files whose final bytes could not be read back, \`restore_failed\` is files a rollback could not put back (they may still hold model output), and \`check_side_effects\` is paths your CHECKS rewrote — a formatter or codegen step — which this tool neither diffs nor rolls back (\`null\` means it could not tell, which is not "none").`;

export const repairInputSchema = {
  files: z.array(z.string()).min(1).describe("Editable files, relative to the project root."),
  spec: z.string().min(1).describe("What must be true when the checks pass. Be concrete."),
  checks: z.enum(["all", "lint", "types", "test"]).optional().describe("Which checks gate the loop. Default 'all'."),
  max_rounds: z.number().int().positive().max(10).optional().describe("Local fix attempts before giving up (default 3)."),
  budget_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Hard wall-clock ceiling for the whole call, first gate run included (default 300)."),
  context_files: z.array(z.string()).optional().describe("Read-only reference files."),
  model: z.string().optional().describe("Override the local model."),
};

export interface RepairArgs {
  files: string[];
  spec: string;
  checks?: "all" | "lint" | "types" | "test" | undefined;
  max_rounds?: number | undefined;
  budget_seconds?: number | undefined;
  context_files?: string[] | undefined;
  model?: string | undefined;
}

export interface RepairDeps extends ToolDeps {
  processRunner?: ProcessRunner;
  /**
   * Runner for the VCS inventory, deliberately SEPARATE from `processRunner`.
   * That one belongs to the checks and tests script it as a queue; borrowing it
   * for a `git` call silently ate the next check's scripted result.
   */
  vcsRunner?: ProcessRunner;
  telemetry?: TelemetryWriter;
  now?: () => number;
}

export interface RoundTrace {
  round: number;
  failures_before: number;
  failures_after: number;
  files_touched: string[];
  model_latency_ms: number;
  gate_ms: number;
  /** Set when the local model could not produce usable output this round. */
  error?: string;
}

export interface RepairResult {
  passed: boolean;
  rounds_used: number;
  /** Cumulative diff from the original bytes to the final state. */
  diff: string;
  files_changed: string[];
  /** False when the loop failed and the tree was restored. */
  applied: boolean;
  /** Files a rollback deliberately did NOT touch because something else wrote them. */
  restore_conflicts: string[];
  /** Files a rollback TRIED to put back and could not. These may still hold model output. */
  restore_failed: string[];
  /**
   * Paths the project's checks changed that this loop never edited — a
   * formatter, codegen, a lifecycle script. Neither diffed nor rolled back.
   * `null` means it could not be determined (no git), which is not the same as
   * an empty list.
   */
  check_side_effects: string[] | null;
  /**
   * Files whose final bytes could not be read back. Their entry in `diff` is
   * this loop's last write rather than an observation of the tree.
   */
  unverified: string[];
  remaining_failures: Failure[];
  rounds: RoundTrace[];
  /** Why the loop stopped: green, rounds exhausted, budget, a hard error, or a conflict. */
  stopped_because: "passed" | "max_rounds" | "budget" | "model_failed" | "concurrent_edit";
  /** Unique id for this call, echoed in telemetry so the cost meter joins exactly. */
  invocation_id: string;
  model: string | null;
  bytes_raw: number;
  bytes_returned: number;
}

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_BUDGET_SECONDS = 300;
/** Failures fed back to the model per round. More context, worse focus. */
const FAILURES_IN_PROMPT = 12;

function countFailures(gate: GateResult): number {
  return gate.checks.reduce((sum, check) => sum + check.failure_count, 0);
}

function allFailures(gate: GateResult): Failure[] {
  return gate.checks.flatMap((check) => check.failures);
}

/**
 * Render gate failures as the error output the fix prompt expects.
 *
 * Compact on purpose: the local model has a fraction of the context of the
 * orchestrator, and a wall of build output is exactly what makes small models
 * lose the thread.
 */
function renderFailures(gate: GateResult): string {
  const parts: string[] = [];
  for (const check of gate.checks) {
    if (check.passed) continue;
    if (check.error !== undefined) {
      parts.push(`[${check.name}] could not run: ${check.error}`);
      continue;
    }
    parts.push(`[${check.name}] ${check.failure_count} failure(s):`);
    for (const failure of check.failures.slice(0, FAILURES_IN_PROMPT)) {
      const where = failure.path === null ? "" : `${failure.path}${failure.line === null ? "" : `:${failure.line}`} `;
      const code = failure.code === null ? "" : `[${failure.code}] `;
      parts.push(`  ${where}${code}${failure.message}`);
    }
    if (check.failure_count > FAILURES_IN_PROMPT) {
      parts.push(`  ... and ${check.failure_count - FAILURES_IN_PROMPT} more of the same kind`);
    }
  }
  return parts.join("\n");
}

interface Snapshot {
  rel: string;
  abs: string;
  /** Bytes before round 1 — what a rollback puts back. */
  content: string;
  /**
   * The exact bytes this loop last wrote, recorded at the moment of writing
   * (initially the original). Rollback only overwrites a file still holding
   * exactly these, so an edit made by someone else while the loop ran is
   * reported instead of being destroyed.
   *
   * It must never be filled by reading the file back: a read cannot tell our
   * write from a concurrent one, and adopting the latter is precisely how a
   * rollback ends up deleting someone else's work.
   */
  lastWritten: string;
}

/**
 * Capture the exact bytes of every file the loop may touch.
 *
 * This is the whole safety story. The loop writes to the real working tree —
 * a scratch worktree would break every project whose checks need the full
 * tree — so being able to put it back byte-for-byte is what makes that safe.
 */
async function snapshot(root: string, files: string[], maxFileKb: number): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  for (const rel of files) {
    // readTextFileSafe, not a raw read: it applies the per-file cap and the
    // binary sniff. Snapshotting used to bypass both, so a huge file was pulled
    // into memory here and only rejected later, inside runGeneration.
    const loaded = await readTextFileSafe(root, rel, maxFileKb);
    out.push({ rel: loaded.rel, abs: loaded.abs, content: loaded.content, lastWritten: loaded.content });
  }
  return out;
}

/**
 * Put the tree back, but only where the bytes on disk are still the ones this
 * loop wrote. A repair can run for minutes; an editor, formatter or watcher
 * touching the same file in that window must not have its work silently
 * overwritten by a rollback. Returns the files left as found.
 */
interface RestoreOutcome {
  /** Left as found on purpose: something else owns those bytes now. */
  conflicts: string[];
  /** Tried to roll back and could not. These may still hold the model's bytes. */
  failed: string[];
}

async function restore(snapshots: Snapshot[]): Promise<RestoreOutcome> {
  const conflicts: string[] = [];
  const failed: string[] = [];
  for (const file of snapshots) {
    const current = await fs.readFile(file.abs, "utf8").catch(() => null);
    if (current === null) {
      // Unreadable or gone. We cannot tell whether it still holds our bytes, so
      // we neither write over it nor pretend the rollback covered it.
      conflicts.push(file.rel);
      log.warn(`repair: could not read ${file.rel} to roll it back; reporting it as a conflict`);
      continue;
    }
    if (current === file.content) continue;
    if (current !== file.lastWritten) {
      conflicts.push(file.rel);
      log.warn(`repair: ${file.rel} changed outside this loop; left as found instead of rolled back`);
      continue;
    }
    // Per file, and never fatal. Letting one locked file reject the whole
    // rollback abandoned every remaining file AND lost the record of which ones
    // were left holding model output — the caller could not even find out.
    try {
      await atomicWriteFile(file.abs, file.content);
      log.info(`repair: restored ${file.rel} to its original contents`);
    } catch (error) {
      failed.push(file.rel);
      log.warn(
        `repair: could NOT restore ${file.rel}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { conflicts, failed };
}

/**
 * Which paths the project's VCS currently considers changed, and by how much.
 *
 * Used to notice files the *checks* rewrote — a formatter, `eslint --fix`, a
 * codegen or lifecycle script. The loop snapshots only `args.files`, so those
 * edits are in neither the returned diff nor the rollback, and a caller reading
 * `files_changed` would be told less than actually happened.
 *
 * `--numstat` rather than just `--porcelain` because a file that was ALREADY
 * dirty when the loop began is the common case in real work; only its
 * added/removed counts reveal that a check touched it again. Git's ignore rules
 * do the filtering for free, which is the right filter: build output is not the
 * user's work. Known gap: an edit whose added/removed counts happen to match the
 * previous ones is invisible.
 *
 * Returns null when the answer is unknown — not a git repo, git missing, git
 * failing. "We did not look" must never render as "nothing changed".
 */
async function treeFingerprint(root: string, runner: ProcessRunner): Promise<Map<string, string> | null> {
  const git = process.platform === "win32" ? "git.exe" : "git";
  try {
    const [status, numstat] = await Promise.all([
      runner(git, ["status", "--porcelain"], { cwd: root, timeoutMs: 15_000 }),
      runner(git, ["diff", "--numstat"], { cwd: root, timeoutMs: 15_000 }),
    ]);
    if (status.code !== 0 || numstat.code !== 0) return null;

    const out = new Map<string, string>();
    for (const line of status.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const raw = line.slice(3).trim();
      const path = raw.includes(" -> ") ? (raw.split(" -> ").pop() ?? raw) : raw;
      const cleaned = path.replace(/^"|"$/g, "");
      if (cleaned !== "") out.set(normalizeRel(cleaned), line.slice(0, 2));
    }
    for (const line of numstat.stdout.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const path = parts[2];
      if (path === undefined || path === "") continue;
      out.set(normalizeRel(path), `${out.get(normalizeRel(path)) ?? ""}|${parts[0]}/${parts[1]}`);
    }
    return out;
  } catch {
    return null;
  }
}

/** Paths whose state changed between two fingerprints, excluding the loop's own files. */
function sideEffects(
  before: Map<string, string> | null,
  after: Map<string, string> | null,
  ours: Set<string>
): string[] | null {
  if (before === null || after === null) return null;
  const changed = new Set<string>();
  for (const [path, mark] of after) {
    if (before.get(path) !== mark) changed.add(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.add(path);
  }
  return [...changed].filter((p) => !ours.has(p)).sort();
}

/**
 * Render the cumulative diff from the original bytes to `contents`.
 *
 * Pure, so the caller decides where `contents` comes from — see the two cases at
 * the end of the loop. What it must never do again is what the first version
 * did: write the proposed content to the working tree so it could read it back
 * and diff it. That write was unconditional, so a concurrent edit was destroyed
 * to produce a *report* that was then thrown away.
 */
function renderDiff(snapshots: Snapshot[], contents: string[]): { diff: string; changed: string[] } {
  const diffs: string[] = [];
  const changed: string[] = [];
  for (const [index, file] of snapshots.entries()) {
    const updated = contents[index];
    if (updated === undefined || updated === file.content) continue;
    const text = unifiedFileDiff(file.rel, file.content, updated);
    if (text === "") continue;
    diffs.push(text);
    changed.push(file.rel);
  }
  return { diff: diffs.join(""), changed };
}

function summarizeGate(gate: GateResult): CheckReport[] {
  return gate.checks;
}

/**
 * Run the local fix loop and return a single result.
 *
 * Every round is a Claude turn that does not happen, and a turn avoided is
 * worth more than bytes avoided: it removes a full re-read of the entire
 * accumulated context, not just the tokens of one message.
 */
export async function runRepair(
  args: RepairArgs,
  config: Config,
  deps: RepairDeps = {}
): Promise<RepairResult> {
  const now = deps.now ?? (() => Date.now());
  const telemetry = deps.telemetry ?? createTelemetryWriter(config.root);
  const started = now();

  const files = [...new Set(args.files.map(normalizeRel))];
  const contextPaths = [...new Set((args.context_files ?? []).map(normalizeRel))];

  // Enforce the size caps BEFORE anything is read. runGeneration enforces them
  // too, but only after snapshot() has already pulled every editable file into
  // memory — which is exactly what the caps exist to prevent.
  enforceContextCaps(
    await statAll(config.root, [...files, ...contextPaths.filter((p) => !files.includes(p))]),
    config.maxFileKb,
    config.maxContextKb
  );

  const snapshots = await snapshot(config.root, files, config.maxFileKb);
  const vcs = deps.vcsRunner ?? defaultProcessRunner;
  const fingerprintBefore = await treeFingerprint(config.root, vcs);
  const ours = new Set(snapshots.map((s) => s.rel));
  const progress = { checksRan: false };

  try {
    return await repairLoop(args, config, deps, {
      now,
      telemetry,
      started,
      snapshots,
      files,
      invocationId: randomUUID(),
      vcs,
      fingerprintBefore,
      progress,
    });
  } catch (error) {
    // The tool's contract is that a failed loop leaves the tree as it found it.
    // Without this, anything thrown after the model has already written — a
    // locked file, a check config the repair itself invalidated — would hand the
    // caller an error and keep the half-repaired bytes on disk.
    const rollback = await restore(snapshots).catch(() => null);
    // The checks' own edits have to be reported here too. They live outside the
    // snapshot, so the rollback does not touch them, and on this path the caller
    // gets ONLY an error — anything not inside it is lost.
    // The whole inventory is meaningless until a check has run: with nothing
    // executed, a difference cannot have been *caused* by the checks, and
    // reporting one would blame them for an edit made elsewhere. So the guard
    // sits on the inventory itself rather than on each warning, which is where
    // it belongs — gating only the "unknown" branch left the "found something"
    // branch free to make the same false claim.
    const side =
      progress.checksRan && fingerprintBefore !== null
        ? sideEffects(fingerprintBefore, await treeFingerprint(config.root, vcs), ours)
        : null;

    const rollbackTroubled =
      rollback === null || rollback.failed.length > 0 || rollback.conflicts.length > 0;
    const sideTroubled = side !== null && side.length > 0;
    // "Could not tell" must not read as "nothing changed" — but only once there
    // was something it could have missed.
    const sideUnknown = side === null && progress.checksRan;
    if (!rollbackTroubled && !sideTroubled && !sideUnknown) throw error;

    const original = error instanceof Error ? error.message : String(error);
    const notes: string[] = [];
    if (rollback === null) {
      notes.push("The rollback could not be completed at all — assume every editable file may still hold model output.");
    } else if (rollbackTroubled) {
      notes.push(
        `Rollback incomplete. Left holding model output: ${rollback.failed.join(", ") || "none"}. ` +
          `Left as found because something else wrote them: ${rollback.conflicts.join(", ") || "none"}.`
      );
    }
    if (sideTroubled) {
      notes.push(
        `Your checks also changed files this tool never edited and does not roll back: ${side?.join(", ")}.`
      );
    } else if (sideUnknown) {
      notes.push(
        "The working tree could not be inventoried (no VCS available), so whether your checks changed " +
          "other files is UNKNOWN — which is not the same as nothing having changed. Check it yourself."
      );
    }
    throw new ToolError(`${original}\n\n${notes.join("\n")}`, "repair_aborted", {
      original_error: original,
      restore_failed: rollback?.failed ?? null,
      restore_conflicts: rollback?.conflicts ?? null,
      check_side_effects: side,
      files: snapshots.map((s) => s.rel),
    });
  }
}

interface RepairContext {
  now: () => number;
  telemetry: TelemetryWriter;
  started: number;
  snapshots: Snapshot[];
  files: string[];
  invocationId: string;
  /** Separate from the check runner on purpose — see RepairDeps.vcsRunner. */
  vcs: ProcessRunner;
  /** Taken before the first gate, so both exit paths can diff against it. */
  fingerprintBefore: Map<string, string> | null;
  /**
   * Mutable, and read by the error path. `runGate` can throw while still reading
   * its config — invalid `checks.json`, no check in the requested category — and
   * on that path nothing has executed, so nothing can have touched the tree.
   */
  progress: { checksRan: boolean };
}

async function repairLoop(
  args: RepairArgs,
  config: Config,
  deps: RepairDeps,
  ctx: RepairContext
): Promise<RepairResult> {
  const { now, telemetry, started, snapshots, files, invocationId, vcs, fingerprintBefore } = ctx;

  const maxRounds = args.max_rounds ?? DEFAULT_MAX_ROUNDS;
  const budgetMs = (args.budget_seconds ?? DEFAULT_BUDGET_SECONDS) * 1000;
  const category = args.checks ?? "all";

  // A hard deadline for the whole call, not a between-rounds checkpoint. The
  // first gate run counts against it, and every check and every model request is
  // capped by what is left — otherwise `budget_seconds: 1` could still sit
  // through a 300 s check timeout and then a full 300 s model request.
  const deadline = started + budgetMs;
  const remainingMs = (): number => deadline - now();

  const gateDeps = {
    ...(deps.processRunner ? { processRunner: deps.processRunner } : {}),
    // The inner gate runs must not each write a telemetry row; the repair call
    // is the unit of work, and double-counting would inflate the saving.
    telemetry: { record: async () => {} },
    now,
  };
  const runGateNow = (): Promise<GateResult> =>
    runGate({ checks: category }, config, { ...gateDeps, budgetMs: Math.max(1, remainingMs()) });

  // Every byte this loop puts on disk is recorded here as it is written, which
  // is the only way to tell our writes from a concurrent one at rollback time.
  const byRel = new Map(snapshots.map((s) => [s.rel, s]));
  /**
   * Declared up here, ahead of its siblings below, because the callback in
   * `generationDeps` closes over it. Set from `onModelResolved` and NOT from
   * `generation.model`: the assignment after a successful return is exactly the
   * line a thrown round jumps over, so every failed round used to report
   * `model: null` about a request that had a model all along.
   */
  let model: string | null = null;
  const generationDeps: RepairDeps = {
    ...deps,
    onFileWritten: (rel, content) => {
      const file = byRel.get(normalizeRel(rel));
      if (file !== undefined) file.lastWritten = content;
    },
    onModelResolved: (resolved) => {
      model = resolved;
    },
  };

  /**
   * A gate that RETURNED is not a gate that ran anything, and an absent `error`
   * is not proof that something did: `error` also covers a check that executed
   * and then failed while its output was parsed. `executed` is set the instant
   * the process comes back, which is the only signal that answers "could this
   * have touched the tree?".
   */
  const markChecksRan = (result: GateResult): void => {
    if (result.checks.some((check) => check.executed)) ctx.progress.checksRan = true;
  };

  let rawBytes = 0;
  let gate = await runGateNow();
  markChecksRan(gate);
  rawBytes += gate.bytes_raw;

  const rounds: RoundTrace[] = [];
  let stoppedBecause: RepairResult["stopped_because"] = "max_rounds";

  // The best state the loop ever produced, kept in memory. Nothing below writes
  // to the tree in order to report — only the model's own edits touch disk.
  let best = { failures: countFailures(gate), contents: snapshots.map((s) => s.content) };

  if (gate.passed) {
    stoppedBecause = "passed";
  } else {
    for (let round = 1; round <= maxRounds; round++) {
      if (remainingMs() <= 0) {
        stoppedBecause = "budget";
        break;
      }

      const before = countFailures(gate);
      const modelStarted = now();
      let touched: string[] = [];
      let roundError: string | undefined;
      let concurrentEdit = false;
      let budgetCutItOff = false;
      /**
       * What `remaining` was when the request that may time out was issued —
       * the INPUT to `min(config.timeoutMs, remaining)` in `shared.ts`, captured
       * as it is read rather than reconstructed from the result.
       *
       * The output cannot answer this. `min` maps both "the budget had exactly
       * `config.timeoutMs` left" and "the budget had more than that" onto the
       * same applied value, and `Math.max(1, ...)` folds every sub-millisecond
       * remainder onto 1 — so a tie is indistinguishable from a comfortable
       * budget downstream. The tie is not a corner case either: `config.timeoutMs`
       * and `DEFAULT_BUDGET_SECONDS` share a default, so round 1 hits it whenever
       * the first gate costs nothing.
       *
       * Re-declared per round, so a later round cannot be judged on an earlier
       * one's reading. `resolveModel` reads it too, before the attempt loop, and
       * is harmlessly overwritten — it swallows its own timeout, so no
       * `llm_timeout` of its making ever reaches the catch below.
       */
      let remainingAtIssue: number | null = null;
      const trackedRemaining = (): number => {
        const value = remainingMs();
        remainingAtIssue = value;
        return value;
      };

      try {
        const generation = await runGeneration(
          "fix",
          {
            spec: args.spec,
            files,
            ...(args.context_files ? { context_files: args.context_files } : {}),
            ...(args.model ? { model: args.model } : {}),
            error_output: renderFailures(gate),
            mode: "apply",
          },
          config,
          {
            ...generationDeps,
            // Re-derived each round: the bytes we believe are on disk right now.
            // Generation runs for minutes, so this is checked again immediately
            // before the write rather than trusted from here.
            expectedContent: new Map(snapshots.map((s) => [s.rel, s.lastWritten])),
            remainingMs: trackedRemaining,
          }
        );
        // `model` is not read back from the result: `onModelResolved` already
        // set it, from the same resolution, on the success and failure paths
        // alike. One source, so the two cannot drift.
        touched = generation.files_changed;
      } catch (error) {
        roundError = error instanceof Error ? error.message : String(error);
        concurrentEdit = error instanceof ToolError && error.code === "concurrent_modification";
        // WHICH ceiling fired, from the budget that was actually on the clock
        // when the request went out — not from a clock read here, which by now
        // has moved, and not from the applied timeout, which `min` has already
        // made ambiguous. `<=` and not `<`: on a tie both ceilings bind at the
        // same instant, the budget is spent either way, and one iteration later
        // the loop's own between-rounds branch would call that `budget`.
        budgetCutItOff =
          error instanceof ToolError &&
          error.code === "llm_timeout" &&
          remainingAtIssue !== null &&
          remainingAtIssue <= config.timeoutMs;
        log.warn(
          concurrentEdit
            ? `repair round ${round}: aborting without writing — ${roundError}`
            : `repair round ${round}: local model failed: ${roundError}`
        );
      }

      const modelLatency = now() - modelStarted;

      if (roundError !== undefined) {
        rounds.push({
          round,
          failures_before: before,
          failures_after: before,
          files_touched: [],
          model_latency_ms: modelLatency,
          gate_ms: 0,
          error: roundError,
        });
        // A request THIS CALL'S DEADLINE cut off is a budget stop, not a model
        // failure. The `budget` branch above only runs between rounds, so a
        // timeout inside generation used to be filed as `model_failed` — and
        // `config.timeoutMs` defaults to exactly `DEFAULT_BUDGET_SECONDS`, so
        // round 1 alone can consume the whole budget and then blame the model.
        // Measured: 3 of 4 `model_failed` rows sat at 300-326 s against a 300 s
        // budget, `run 2026-08-03-mac-06`.
        //
        // Everything else here is the model's own failure, including a request
        // that hit `config.timeoutMs` with budget to spare: the ceiling it broke
        // was its own, and `budget` would claim an exhaustion that never
        // happened. Both mislabels corrupt the same telemetry, so neither is the
        // safe default — which is why the branch above reads the budget that was
        // on the clock instead of guessing from what happened afterwards.
        stoppedBecause = concurrentEdit ? "concurrent_edit" : budgetCutItOff ? "budget" : "model_failed";
        break;
      }

      const gateStarted = now();
      gate = await runGateNow();
      markChecksRan(gate);
      rawBytes += gate.bytes_raw;
      const after = countFailures(gate);

      rounds.push({
        round,
        failures_before: before,
        failures_after: after,
        files_touched: touched,
        model_latency_ms: modelLatency,
        gate_ms: now() - gateStarted,
      });

      // Keep the best state seen, so a round that makes things worse cannot
      // discard a round that made them better. From what we wrote, never from
      // disk: reading back would let a concurrent edit become "our best
      // attempt" and then be rolled over.
      if (after < best.failures) {
        best = { failures: after, contents: snapshots.map((s) => s.lastWritten) };
      }

      if (gate.passed) {
        stoppedBecause = "passed";
        break;
      }
    }
  }

  // The two paths need OPPOSITE sources, and getting that backwards is a lie
  // either way round:
  //
  //   applied: true  — a claim about the working tree, so the diff must describe
  //     the tree. Reading it back is the only way to catch a check that rewrites
  //     files (`eslint --fix`, a formatter, a codegen step) or anything else
  //     that landed after our last write. `lastWritten` would report the bytes
  //     we handed over rather than the bytes that are there.
  //   applied: false — an explicitly UNAPPLIED proposal that exists only in
  //     memory, and the tree is about to be restored. Reading disk here is what
  //     used to make the loop write the best attempt out just to read it back.
  const applied = gate.passed;
  const unverified: string[] = [];
  let finalContents: string[];
  if (applied) {
    finalContents = [];
    for (const file of snapshots) {
      try {
        finalContents.push(await fs.readFile(file.abs, "utf8"));
      } catch (error) {
        // Falling back to the ORIGINAL bytes here would render as "unchanged",
        // which is a false negative about work the loop may well have done.
        // Report our last write as the best available account, and say plainly
        // that it was not observed.
        unverified.push(file.rel);
        log.warn(
          `repair: could not read ${file.rel} to confirm the applied state: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        finalContents.push(file.lastWritten);
      }
    }
  } else {
    finalContents = best.contents;
  }
  const { diff, changed } = renderDiff(snapshots, finalContents);
  const rollback: RestoreOutcome = applied ? { conflicts: [], failed: [] } : await restore(snapshots);
  const checkSideEffects = sideEffects(
    fingerprintBefore,
    await treeFingerprint(config.root, vcs),
    new Set(snapshots.map((s) => s.rel))
  );

  const result: RepairResult = {
    passed: gate.passed,
    rounds_used: rounds.length,
    diff,
    files_changed: changed,
    applied,
    restore_conflicts: rollback.conflicts,
    restore_failed: rollback.failed,
    check_side_effects: checkSideEffects,
    unverified,
    remaining_failures: gate.passed ? [] : allFailures(gate).slice(0, FAILURES_IN_PROMPT),
    rounds,
    stopped_because: stoppedBecause,
    invocation_id: invocationId,
    model,
    bytes_raw: rawBytes,
    bytes_returned: 0,
  };
  result.bytes_returned = JSON.stringify(result).length;

  await telemetry.record({
    tool: "repair",
    invocation_id: invocationId,
    bytes_raw: rawBytes,
    bytes_returned: result.bytes_returned,
    // A floor: each round is at least one write turn plus one verify turn that
    // did not happen, and we count only one.
    turns_collapsed: rounds.length,
    latency_ms: now() - started,
    detail: {
      passed: result.passed,
      stopped_because: stoppedBecause,
      // Which model produced the timings in `rounds` below. It went only to the
      // caller before (`repair.ts` result payload), so a latency read from the
      // log had no subject — and B7 is a latency premise. `null` now means the
      // call ended before any generation started, not that the name was lost.
      model,
      files: changed,
      stats: diff === "" ? null : diffStats(diff),
      checks: summarizeGate(gate).map((c) => ({ name: c.name, passed: c.passed })),
      // The per-round trace, which until now went only to the caller. B7 asks
      // for the median of `model_latency_ms + gate_ms` per round; the row used
      // to carry the call total and the round count, so dividing one by the
      // other was the best anyone could do — and that charges the first gate,
      // the rollback and the tree fingerprint to the rounds. B7 was therefore
      // not measurable from telemetry on ANY past run, which is why it still
      // has no data (`run 2026-08-03-mac-06`). `error` comes along because
      // `stopped_because` cannot separate a truncated response — B0 — from
      // output that was merely wrong, and the distinction decides whether a
      // failed round counts against `repair` or against the output contract.
      rounds: rounds.map((r) => ({
        round: r.round,
        model_ms: r.model_latency_ms,
        gate_ms: r.gate_ms,
        failures_before: r.failures_before,
        failures_after: r.failures_after,
        ...(r.error === undefined ? {} : { error: r.error }),
      })),
    },
  });

  if (rounds.length === 0 && stoppedBecause === "passed") {
    log.info("repair: checks were already green; nothing to do");
  }

  return result;
}

/** Re-exported so the server can surface the same error type as the other tools. */
export { ToolError };
