/**
 * UNIT 5, the pure core — `RunArchive` + `GitAudit` in, both artifacts out.
 * Specified by `docs/b12-scorer/UNIT-5.md` as adjudicated in `FINDINGS.md`
 * (F23–F25) and by the plan gate recorded there: every rule here is a function
 * of values, every hostile case is constructible without a filesystem, and
 * NOTHING THROWS to avoid producing an artifact — `admissionRule` 1 owes one
 * from registration onward, and an exception is the one outcome the frozen
 * design does not allow.
 *
 * TWO REGISTERED CONVENTIONS LIVE HERE, both labelled on the artifact rather
 * than buried (the `selection.basis` precedent, `FINDINGS.md` F20):
 *
 * - **Disposition precedence.** More than one void predicate can be true of one
 *   observation and the closed list is a single field. The name is picked by
 *   the order `design.admissionRule`'s opening sentence enumerates the list —
 *   A CONVENTION, not a frozen rule (the plan gate refuted "derived") — and
 *   every predicate that fired is published per observation so the pick is
 *   checkable.
 * - **A re-run's scored attempt.** `admissionRule` 12 archives both attempts
 *   and publishes both fractions but does not say which one is the
 *   observation. The LAST attempt is — a re-run exists to replace — and every
 *   attempt still gets terms, so both fractions ARE published.
 *
 * WHAT THIS FILE DOES NOT DECIDE: `voidConditions` 21's instruction-set-hash
 * composition and 12's pinned-vs-passed basis (owner adjudications, recorded);
 * the clause 4–6 audit (an INPUT — facts about git history, not this archive);
 * F23's second bracket (its own pass — clause 8 fires here until it lands);
 * F25's encoding gap (reported by name, never given a minted disposition).
 */

import {
  breakdownOfRequests,
  buildCounterfactual,
  buildSessionReport,
  invocationOwners,
  isLocalToolResult,
  scopeTelemetry,
} from "../report.js";
import { rateKey } from "../rates.js";
import type { Transcript } from "../transcript.js";
import { aggregate, ADMITTED_OBSERVATIONS } from "./aggregate.js";
import { runCoverage } from "./coverage.js";
import { fileScopeViolations } from "./filescope.js";
import { computeTerms } from "./terms.js";
import type {
  ArchiveCheck,
  ArchivedObservation,
  B12Counterfactual,
  B12Observation,
  B12RunResult,
  CounterfactualObservation,
  DeclarationFailure,
  Disposition,
  GitAudit,
  IdentifiedRow,
  ManifestTask,
  ObservationTerms,
  RunArchive,
} from "./types.js";

/**
 * The registered precedence — the closed list's own published order, minus the
 * two non-void members. A convention with a label, not a derivation.
 */
export const DISPOSITION_PRECEDENCE: readonly Exclude<
  Disposition,
  "scored" | "not_started"
>[] = [
  "void(execution_error)",
  "void(version_drift)",
  "void(instrument_write)",
  "void(rate_key_mixed)",
  "void(withheld)",
  "void(sibling_inheritance)",
  "void(task_failed)",
  "void(pacing)",
];

export const DISPOSITION_CONVENTION =
  "first matching predicate in the closed list's published order — a REGISTERED CONVENTION (FINDINGS.md, UNIT 5 pass), checkable via firedPredicates";

/** The instruction components clause 12 compares; `memory` belongs to clause 13. */
const CLAUSE_12_COMPONENTS = ["claudeMd", "settings", "settingsLocal", "mcpConfigPassed", "policyBlob"] as const;

/**
 * `admissionRule` 7's three named triggers, textual. The archive keeps
 * `tool_use` inputs verbatim (the reduction keeps `message.content`), so the
 * scan is over what the session actually asked its tools to do. Best-effort BY
 * NATURE — the frozen text names the acts, not a detection procedure — and the
 * miss direction is stated: a trigger spelled unrecognisably scans clean, which
 * is why the harness-side run-level VOID exists too.
 */
export function instrumentWriteTriggers(lineageRecords: readonly unknown[]): string[] {
  const markers = ["session-token-walk", "cost/cli", ".local-coder/telemetry.jsonl"];
  const hits = new Set<string>();
  for (const raw of lineageRecords) {
    if (typeof raw !== "object" || raw === null) continue;
    const message = (raw as { message?: { content?: unknown } }).message;
    if (message === undefined || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use") continue;
      // Windows spellings normalised before matching: a serialized `\\` path
      // would otherwise hide `.local-coder\telemetry.jsonl` from the scan.
      const serialized = JSON.stringify(b.input ?? "").replace(/\\\\/g, "/");
      for (const marker of markers) {
        if (serialized.includes(marker)) hits.add(marker);
      }
    }
  }
  return [...hits].sort();
}

/** Milliseconds per cache TTL — the two classes the rates name. */
const TTL_MS = { "5m": 300_000, "1h": 3_600_000 } as const;

export interface PacingFacts {
  maxGapMs: number;
  shortestTtlMs: number;
  cacheWriteShare: number;
  /** Null when within every ceiling; the reason otherwise. */
  exceeded: string | null;
}

/**
 * `admissionRule` 11 over one observation's OWN originated requests: the
 * inter-request gap against the shortest cache TTL in play, and the cacheWrite
 * share of `billed_o` against the manifest's frozen ceiling.
 */
export function pacingFacts(
  transcript: Transcript,
  owned: ReadonlySet<string>,
  rates: import("../rates.js").Rates,
  cacheWriteShareCeiling: number | null
): PacingFacts {
  const own = transcript.requests
    .filter((r) => owned.has(r.requestId))
    .sort((a, b) => a.timestampMs - b.timestampMs);
  let maxGapMs = 0;
  for (let i = 1; i < own.length; i++) {
    maxGapMs = Math.max(maxGapMs, own[i]!.timestampMs - own[i - 1]!.timestampMs);
  }
  // "The shortest cache TTL in play": 5m the moment any request wrote to the
  // 5-minute class, else 1h. A run with no cache writes still re-reads under
  // some TTL; 1h is the permissive reading and the gap rule stays evaluable.
  const anyFiveMin = own.some((r) => r.usage.cacheWrite5m > 0);
  const shortestTtlMs = anyFiveMin ? TTL_MS["5m"] : TTL_MS["1h"];

  const units = breakdownOfRequests(transcript.requests, rates, new Set(owned)).units;
  const cacheWriteShare = units.total === 0 ? 0 : units.cacheWrite / units.total;

  let exceeded: string | null = null;
  if (own.length > 1 && maxGapMs > shortestTtlMs) {
    exceeded = `max inter-request gap ${maxGapMs}ms exceeds the shortest cache TTL in play (${shortestTtlMs}ms)`;
  } else if (cacheWriteShareCeiling !== null && cacheWriteShare > cacheWriteShareCeiling) {
    exceeded = `cacheWrite share ${cacheWriteShare.toFixed(4)} exceeds the frozen ceiling ${cacheWriteShareCeiling}`;
  }
  return { maxGapMs, shortestTtlMs, cacheWriteShare, exceeded };
}

/** One scored-track candidate, everything its disposition was decided from. */
interface Assessed {
  obs: ArchivedObservation;
  task: ManifestTask | null;
  fired: Array<{ name: Disposition; detail: string }>;
  disposition: Disposition | null;
  declReasons: string[];
  terms: ObservationTerms | null;
  pacing: PacingFacts | null;
  /**
   * Artifact 1's frozen `max_rounds` against what this observation's repair
   * calls ran under. A FACT and not a disposition: the amendment that makes it
   * violable is RUN-LEVEL, so nothing here excludes this observation — the
   * clause reads the union across all of them. Empty means "no disagreement
   * among the rows that exist", which is not the same as "no repair ran".
   */
  repairRounds: string[];
  provenanceUnavailable: boolean | null;
  requestsPerSegment: Array<{ thread: string; segment: number; requests: number }>;
}

export interface AssembleInput {
  archive: RunArchive;
  gitAudit: GitAudit;
  /** The emitter's own invocation, for `voidConditions` 19. Null when unknown —
   * reported as such, never defaulted to the pinned string. */
  scoringCommandActual: string | null;
}

export interface AssembleOutput {
  counterfactual: B12Counterfactual;
  result: B12RunResult;
}

const pinnedStr = (pinned: Record<string, unknown>, key: string): string | null =>
  typeof pinned[key] === "string" ? (pinned[key] as string) : null;
const pinnedNum = (pinned: Record<string, unknown>, key: string): number | null =>
  typeof pinned[key] === "number" && Number.isFinite(pinned[key] as number)
    ? (pinned[key] as number)
    : null;

export function assembleRun(input: AssembleInput): AssembleOutput {
  const { archive, gitAudit } = input;
  const { manifest, rates } = archive;
  const pinned = manifest.pinned;
  const problems = [...archive.problems];
  const checks: ArchiveCheck[] = [];
  const declarationFailures: DeclarationFailure[] = [];
  const taskById = new Map(manifest.tasks.map((t) => [t.id, t]));

  // ONE ID, ONE DECLARATION (the seventh diff round's second finding).
  // `taskById` collapses by id, so a manifest declaring the same id twice
  // would let POSITION silently decide which declaration governs — and the
  // selection below, which walks manifest ENTRIES, would fetch the same
  // scored attempt once per entry and price one session twice while every
  // check stayed clean. The duplication fires here, the selection walks each
  // id once, and the governing declaration is reported as undecidable.
  // The check itself lives in `buildArchiveChecks`, in table order beside
  // artifact 1's other predicates; the set is computed once, here, because the
  // selection and the declaration reporting both read it.
  const idCounts = new Map<string, number>();
  for (const t of manifest.tasks) idCounts.set(t.id, (idCounts.get(t.id) ?? 0) + 1);
  const duplicatedTaskIds = new Set([...idCounts].filter(([, n]) => n > 1).map(([id]) => id));

  // `admissionRule` 13: the control arm never enters the primary verdict — its
  // observations (present only once the post-verdict A/B has run) are outside
  // every arithmetic domain here, and their presence is reported.
  const allTreatment = archive.observations.filter((o) => o.arm === "treatment");
  const control = archive.observations.filter((o) => o.arm === "control");

  // A SUSPECT SOURCE PRICES NOTHING. An observation whose telemetry is
  // corrupt, drifted or missing (the first diff round's third finding), whose
  // own evidence names another task, arm, run or session than the directory
  // it was scored from (the fifth round's first finding — the directory picks
  // the manifest task, so cross-wired evidence would price one task's work
  // under another's name), or whose files `git status` shows differing from
  // HEAD (the second round's first finding — the replay must read the
  // COMMITTED archive, and a dirty path is positive evidence it is not), is
  // refused terms and kept out of the universe; the matching check fires, so
  // the run VOIDS instead of scoring around the tampering.
  // `evidenceCommitted: null` — committedness UNSHOWABLE, no repository to
  // ask — is not evidence of tampering: the run-level check still fires, but
  // terms are computed and published under the void, because the partial
  // bracket is owed either way.
  const suspect = (o: ArchivedObservation): string[] => [
    ...(o.telemetryIntact ? [] : ["the telemetry identity source is not intact"]),
    ...(o.attributionIntact
      ? []
      : ["the archive cannot say which telemetry rows are this arm's, or its lineage is short a file that could not be read"]),
    ...(o.identityIntact
      ? []
      : ["the observation's identity is cross-wired or unshowable — evidence that cannot be bound to its task, arm, run and session may not price anything"]),
    ...(o.evidenceCommitted === false ? ["on-disk files differ from HEAD — the replay is not reading the committed archive"] : []),
  ];
  const treatment = allTreatment.filter((o) => suspect(o).length === 0);
  const integrityFailures: DeclarationFailure[] = allTreatment
    .filter((o) => suspect(o).length > 0)
    .map((o) => ({
      taskId: o.taskId,
      arm: o.arm,
      attempt: o.attempt,
      reasons: [...suspect(o), ...o.problems],
    }));
  checks.push({
    clause: "design.artifacts 6 — archive integrity",
    fired: integrityFailures.length > 0,
    detail:
      integrityFailures.length > 0
        ? `${integrityFailures.length} observation(s) carry a corrupt, drifted or missing telemetry.jsonl or an identity that does not bind to the directory scored — no terms are computed from a suspect source, and the ledger's domain is short by their rows`
        : "every observation's telemetry.jsonl is intact and byte-consistent with archive.json's sealed copy, and every identity binds to its directory",
  });
  checks.push({
    clause: "admissionRule 13 — control arms",
    fired: false,
    detail:
      control.length === 0
        ? "no control observations in the archive"
        : `${control.length} control observation(s) present — outside the primary verdict by rule, reported only`,
  });

  // ---- run-level joins, each computed ONCE --------------------------------
  const universe: IdentifiedRow[] = treatment.flatMap((o) => o.identified);
  const universeRecords = universe.map((r) => r.record);
  const lineages: Transcript[] = treatment
    .map((o) => o.transcript)
    .filter((t): t is Transcript => t !== null);
  // Run-level, each lineage ONE owner — `unitOfMeasurement`'s rule, and the
  // reason `computeTerms` takes the set instead of deriving it.
  const ambiguousIds = invocationOwners(lineages);
  // `voidConditions` 19's "the id set the ambiguity check saw", published.
  const ambiguityIdSet = [
    ...new Set(
      lineages.flatMap((t) =>
        t.toolResults
          .filter(isLocalToolResult)
          .map((r) => r.invocationId)
          .filter((id): id is string => id !== null)
      )
    ),
  ].sort();

  const cacheWriteCeiling = pinnedNum(pinned, "pacingCacheWriteShareCeiling");
  const pinnedVersion = pinnedStr(pinned, "claudeCodeVersion");
  const pinnedBinarySha = pinnedStr(pinned, "claudeBinarySha256");

  // ---- per-attempt assessment ---------------------------------------------
  // Temporal order for the cumulative-origination replay: runlog order first
  // (the machine-written rows), archive order as the fallback.
  const runlogOrder = new Map<string, number>();
  archive.runlog.rows.forEach((row, i) => {
    const key = `${row.taskId}/${row.arm}`;
    if (!runlogOrder.has(key)) runlogOrder.set(key, i);
  });
  const temporal = [...treatment].sort((a, b) => {
    const ka = runlogOrder.get(`${a.taskId}/${a.arm}`) ?? Number.MAX_SAFE_INTEGER;
    const kb = runlogOrder.get(`${b.taskId}/${b.arm}`) ?? Number.MAX_SAFE_INTEGER;
    return ka !== kb ? ka - kb : a.attempt - b.attempt;
  });

  const assessed: Assessed[] = [];
  // `admissionRule` 4's cumulative union: every prior snapshot, both sides, and
  // every previously completed observation's originated set.
  const cumulative = new Set<string>();
  for (const obs of temporal) {
    assessed.push(
      assessObservation(obs, {
        task: taskById.get(obs.taskId) ?? null,
        rates,
        universe,
        universeRecords,
        ambiguousIds,
        cumulative,
        cacheWriteShareCeiling: cacheWriteCeiling,
        pinnedVersion,
        pinnedBinarySha,
        duplicatedTaskIds,
        declarationFailures,
        problems,
      })
    );
    for (const id of obs.snapshotBefore?.requestIds ?? []) cumulative.add(id);
    for (const id of obs.snapshotAfter?.requestIds ?? []) cumulative.add(id);
    for (const id of obs.record?.originatedRequestIds ?? []) cumulative.add(id);
  }

  // ---- admissionRule 12: attempts, and the one discretionary re-run --------
  const byTask = new Map<string, Assessed[]>();
  for (const a of assessed) {
    const list = byTask.get(a.obs.taskId) ?? [];
    list.push(a);
    byTask.set(a.obs.taskId, list);
  }
  for (const list of byTask.values()) list.sort((a, b) => a.obs.attempt - b.obs.attempt);

  const reruns: B12RunResult["reruns"] = [];
  let discretionaryReruns = 0;
  const overBudget = new Set<Assessed>();
  for (const [taskId, list] of byTask) {
    if (list.length > 1) {
      reruns.push({
        taskId,
        arm: "treatment",
        attempts: list.length,
        // THE REGISTERED CONVENTION: the last attempt is the observation.
        scoredAttempt: list[list.length - 1]!.obs.attempt,
      });
    }
    for (let i = 1; i < list.length; i++) {
      // A re-run consumes the discretionary budget unless the attempt it
      // replaces was `void(version_drift)` — clause 12's own carve-out.
      if (list[i - 1]!.disposition !== "void(version_drift)") {
        discretionaryReruns++;
        if (discretionaryReruns > 1) overBudget.add(list[i]!);
      }
    }
  }
  checks.push({
    clause: "admissionRule 12 — one discretionary re-run",
    fired: discretionaryReruns > 1,
    detail:
      discretionaryReruns > 1
        ? `${discretionaryReruns} discretionary re-runs against a budget of 1 — the excess attempts are barred from admission; no voidConditions clause names this, so the run's fate falls to clause 3's own arithmetic`
        : `${discretionaryReruns} discretionary re-run(s) used of 1`,
  });

  // ---- selection: the first 20 that admit, IN THE COMMITTED ORDER ---------
  // The scored-track attempt per task is the LAST one; every other attempt's
  // terms go to `dropped`, which is how "both fractions published" is a fact.
  const scoredTrack = new Map<string, Assessed>();
  for (const [taskId, list] of byTask) scoredTrack.set(taskId, list[list.length - 1]!);

  const admitted: ObservationTerms[] = [];
  const dropped: ObservationTerms[] = [];
  const admittedAssessed: Assessed[] = [];
  const walked = new Set<string>();
  for (const task of manifest.tasks) {
    // One id, one admission — a duplicated declaration already fired the task
    // identity check above; walking it again would price the session twice.
    if (walked.has(task.id)) continue;
    walked.add(task.id);
    const a = scoredTrack.get(task.id);
    if (a === undefined) continue; // not_started — appended to dispositions below
    const admissible =
      a.terms !== null &&
      a.disposition === "scored" &&
      a.obs.record?.valid === true &&
      !overBudget.has(a) &&
      // The SAME constant clause 2's closure test reads. A bare 20 here and a
      // named one there is two spellings of one rule, and the pair drifting
      // would make the closure test silently wrong about when the cap is hit.
      admitted.length < ADMITTED_OBSERVATIONS;
    if (admissible) {
      admitted.push(a.terms!);
      admittedAssessed.push(a);
    }
  }
  for (const a of assessed) {
    if (a.terms === null) continue;
    if (!admitted.includes(a.terms)) dropped.push(a.terms);
  }

  const coverage = runCoverage(universe, [...admitted, ...dropped]);
  const base = aggregate({
    runId: archive.runId,
    admitted,
    dropped,
    coverage,
    priorRuns: archive.register.priorRuns,
  });

  // ---- the archive-level clauses, each with its own predicate -------------
  buildArchiveChecks({
    archive,
    assessed,
    admittedAssessed,
    checks,
    scoringCommandActual: input.scoringCommandActual,
    duplicatedTaskIds,
    gitAudit,
    brackets: { rLo: base.rLo, rHi: base.rHi, uncappedBracket: base.uncappedBracket },
  });

  const uncheckedClauses = gitAudit.ran
    ? []
    : [
        "voidConditions 4 (beyond rates.json, which is checked here)",
        "voidConditions 5",
        "voidConditions 6",
      ];
  // A COMMITTED AUDIT THAT CANNOT SAY WHICH REGIME APPLIES LEAVES A CLAUSE
  // UNCHECKED, and this list is the only thing that says so. Found 2026-08-14 by
  // review: the repair-max-rounds clause printed "the regime is UNKNOWN" inside
  // an unfired check while `uncheckedClauses` — computed from `gitAudit.ran`
  // alone — stayed empty, so `final` went true and `emit` printed FINAL over a
  // rule nobody had established. An audit predating the amendment's keys is
  // exactly that case, and it is not hypothetical: every audit committed before
  // this key existed is one.
  //
  // NOT A VOID. An unproven rule may not kill a run any more than it may bless
  // one; what it may do is stop the verdict being called FINAL, which is the
  // same distinction `{ran: false}` already carries for clauses 4–6.
  if (gitAudit.ran && regimeOf(gitAudit.inputs, REPAIR_ROUNDS_GOVERNS) === "unknown") {
    uncheckedClauses.push(
      "amendment 2026-08-14 (repair's frozen max_rounds) — the committed audit carries no USABLE clause5.repairRoundsAmendment.governs (absent, or not one of \"yes\"/\"no\"), so which regime applies is unknown"
    );
  }
  if (gitAudit.ran && gitAudit.verdict === "void") {
    checks.push({
      clause: "voidConditions 4–6 — the git audit",
      fired: true,
      detail: `the committed audit returned void: ${gitAudit.reasons.join("; ") || "(no reason recorded)"}`,
    });
  } else if (gitAudit.ran) {
    checks.push({ clause: "voidConditions 4–6 — the git audit", fired: false, detail: "the committed audit returned clean" });
  }

  // ---- verdict: archive-level voids override the arithmetic's -------------
  // Registered convention: a fired archive-level clause names the run's void
  // before any arithmetic verdict — the arithmetic presupposes an archive the
  // clauses have not disqualified. First fired check in table order names it;
  // the whole table is on the face.
  const firedChecks = checks.filter((c) => c.fired);
  const verdict = firedChecks.length > 0 ? ("void" as const) : base.verdict;
  const voidClause =
    firedChecks.length > 0 ? `${firedChecks[0]!.clause}: ${firedChecks[0]!.detail}` : base.voidClause;

  // ---- artifact 7 ----------------------------------------------------------
  // The share's denominator is the METRIC'S denominator — Σ(A + S), because
  // the frozen name is "per-task DENOMINATOR share" and the ratio's
  // denominator is A + S (aggregate.ts's poolRatio), not A alone (the
  // seventh adversarial round caught this computing aO / ΣaO). Horizon: the
  // DECIDING lo horizon, the same convention `aPlusSPositive` registers one
  // field above and the per-task recomputation already uses.
  const admittedSumAPlusSLo = admitted.reduce((sum, t) => sum + t.aO + t.sLo, 0);
  const counterfactualObservations = assessed
    .filter((a) => a.terms !== null)
    .map((a) => counterfactualOf(a, admitted.includes(a.terms!), admittedSumAPlusSLo));

  // not_started: lawful, and reported with its disposition — the preregistration
  // lists it in the closed set beside `scored` and the eight voids, and
  // UNIT-5.md says a manifest task with no observation directory IS lawful.
  // These are manifest entries with NO observation — they never had terms, so
  // they are appended here rather than synthesised as zero-valued observations
  // (a zero A_o is a measurement; absence is not).
  // One id, one row — a duplicated declaration is the task identity check's
  // firing above, never a second `not_started`.
  const notStarted = [
    ...new Map(manifest.tasks.filter((t) => !byTask.has(t.id)).map((t) => [t.id, t])).values(),
  ].map((t) => ({ taskId: t.id, arm: "treatment" as const, disposition: "not_started" as const }));

  const result: B12RunResult = {
    ...base,
    verdict,
    voidClause,
    dispositions: [...base.dispositions, ...notStarted],
    schema: "b12-result/1",
    manifestSha256: archive.manifestSha256,
    manifestBlobSha256: archive.git.manifestBlobSha256,
    archiveChecks: checks,
    uncheckedClauses,
    // THE PRE-DATA RULE, ON THE FACE (R37#1). PREMISES.md: "a verdict emitted
    // without one is not final". `uncheckedClauses` carried that fact and
    // nothing SAID it — a reader, a replayer and the CLI all saw an ordinary
    // `verdict: hold|fall|open` and nothing marking it provisional. Derived
    // from `uncheckedClauses` rather than from `gitAudit.ran` so there is one
    // source: any clause no input allowed anyone to check makes the verdict
    // not final, whatever produced that gap.
    final: uncheckedClauses.length === 0,
    gitAudit,
    declarationFailures,
    integrityFailures,
    dispositionPrecedence: DISPOSITION_CONVENTION,
    ambiguityIdSet,
    scoringCommand: {
      pinned: pinnedStr(pinned, "scoringCommand"),
      actual: input.scoringCommandActual,
    },
    reruns,
    archiveProblems: [...problems, ...archive.observations.flatMap((o) => o.problems.map((p) => `${o.dir}: ${p}`))],
  };

  return {
    counterfactual: {
      schema: "b12-counterfactual/1",
      runId: archive.runId,
      observations: counterfactualObservations,
      declarationFailures,
    },
    result,
  };
}

interface AssessContext {
  task: ManifestTask | null;
  rates: import("../rates.js").Rates;
  universe: IdentifiedRow[];
  universeRecords: import("../../telemetry.js").TelemetryRecord[];
  ambiguousIds: ReadonlySet<string>;
  cumulative: ReadonlySet<string>;
  cacheWriteShareCeiling: number | null;
  pinnedVersion: string | null;
  pinnedBinarySha: string | null;
  duplicatedTaskIds: ReadonlySet<string>;
  declarationFailures: DeclarationFailure[];
  problems: string[];
}

/**
 * Decide one attempt's disposition and compute its terms.
 *
 * The predicates run over the ARCHIVE — record, rebuilt lineage, snapshots —
 * never over anything live; every clause citation is on the predicate that
 * implements it. `firedPredicates` carries every match so the precedence
 * convention is checkable, and F25's cases leave with a declaration failure
 * and NO terms — the frozen text supplies no disposition, and `computeTerms`
 * requires one.
 */
function assessObservation(obs: ArchivedObservation, ctx: AssessContext): Assessed {
  const record = obs.record;
  const fired: Array<{ name: Disposition; detail: string }> = [];
  const declReasons: string[] = [];

  if (ctx.task === null) {
    ctx.problems.push(`${obs.dir}: the manifest names no task ${obs.taskId} — extra material outside the committed order`);
  }
  if (ctx.task !== null && ctx.task.verificationStratum === null) {
    declReasons.push(
      `the manifest declares no verificationStratum for ${obs.taskId} — FINDINGS.md F25: mandated declaration, no disposition for its absence`
    );
  }
  if (ctx.task !== null && ctx.duplicatedTaskIds.has(obs.taskId)) {
    declReasons.push(
      `the manifest declares task ${obs.taskId} more than once — which declaration governs this observation cannot be decided (design.artifacts 1; reported, never defaulted)`
    );
  }

  if (record === null || obs.transcript === null) {
    const why = record === null ? "observation.json is unreadable" : "the lineage transcript could not be rebuilt";
    ctx.declarationFailures.push({
      taskId: obs.taskId,
      arm: obs.arm,
      attempt: obs.attempt,
      reasons: [...declReasons, `${why} — no disposition can be decided and no terms exist (reported, never defaulted)`],
    });
    return {
      obs,
      task: ctx.task,
      fired,
      disposition: null,
      declReasons,
      terms: null,
      pacing: null,
      // No disposition could be decided here, so there is nothing for a fact to
      // qualify. Empty is the honest value: it says nothing was compared, and the
      // run-level clause reads a union that this contributes nothing to.
      repairRounds: [],
      provenanceUnavailable: null,
      requestsPerSegment: [],
    };
  }

  const transcript = obs.transcript;
  const owned = new Set(record.originatedRequestIds);

  // clause 12's narrow enumeration, over what the archive can show: the
  // harness's own outcome classification, and a lineage whose admitted record
  // set holds no billed request at all — "a transcript ending with no
  // assistant turn" in the metered sense. The third member, an unhandled
  // exception in the transcript, has no vendor-stable spelling to scan for and
  // is covered by the outcome half whenever it killed the session.
  if (record.outcome !== null && ["spawn_failed", "killed_by_signal", "exited_nonzero"].includes(record.outcome)) {
    fired.push({ name: "void(execution_error)", detail: `harness outcome ${record.outcome} (admissionRule 12's enumeration)` });
  } else if (transcript.requests.length === 0) {
    fired.push({ name: "void(execution_error)", detail: "the lineage holds no billed assistant turn (admissionRule 12)" });
  }

  // FAIL CLOSED (the sixth diff round's second finding): the pin is the
  // commitment, so an archived binary that cannot SHOW its version or sha
  // against an existing pin is not the pinned binary — absence fires exactly
  // like drift, with the absent side named. Version and sha are compared
  // INDEPENDENTLY; a drift in one is not permission to skip the other. The
  // harness refuses to WRITE an observation without both (`claudeBinary`), so
  // absence here is a partial or tampered archive, never a lawful shape.
  //
  // The version comparison REPLAYS the harness's own gate (`assertPinned`:
  // the recorded string is raw `claude --version` output and must CONTAIN the
  // pin) — a second, stricter rule here would fire on every lawful run, the
  // two-implementations drift this repository documents. The sha comparison
  // is strict equality on both sides already.
  const versionReasons: string[] = [];
  if (ctx.pinnedVersion !== null) {
    if (record.binaryVersion === null) {
      versionReasons.push("the archive carries no binary version to hold against the pin");
    } else if (!record.binaryVersion.includes(ctx.pinnedVersion)) {
      versionReasons.push(`version ${record.binaryVersion} does not carry the pinned ${ctx.pinnedVersion}`);
    }
  }
  if (ctx.pinnedBinarySha !== null) {
    if (record.binarySha256 === null) {
      versionReasons.push("the archive carries no binary sha256 to hold against the pin");
    } else if (record.binarySha256 !== ctx.pinnedBinarySha) {
      versionReasons.push("binary sha256 differs from the manifest's pin");
    }
  }
  if (versionReasons.length > 0) {
    fired.push({ name: "void(version_drift)", detail: `${versionReasons.join("; ")} (voidConditions 7)` });
  }

  const triggers = instrumentWriteTriggers(obs.lineageRecords);
  if (triggers.length > 0) {
    fired.push({ name: "void(instrument_write)", detail: `the session touched ${triggers.join(", ")} (admissionRule 7 — run-level)` });
  }

  const ownKeys = [
    ...new Set(
      transcript.requests.filter((r) => owned.has(r.requestId)).map((r) => rateKey(r.model, r.speed))
    ),
  ].sort();
  if (ownKeys.length > 1) {
    fired.push({ name: "void(rate_key_mixed)", detail: `this window spans ${ownKeys.join(", ")} (admissionRule 9)` });
  }

  // `admissionRule` 5 pins withholding to the shipped counter; `admissionRule`
  // 6 then admits `ambiguous > 0` to the fall arithmetic — so the DISPOSITION
  // fires on `provenanceUnavailable` alone, and ambiguity stays `scored` with
  // the hold exclusion derived inside `aggregate` (the plan gate's R4, held).
  const scopedRecords = scopeTelemetry(transcript, ctx.universeRecords);
  const scopedSet = new Set(scopedRecords);
  const identifiedScoped = ctx.universe.filter((r) => scopedSet.has(r.record));
  const report = buildCounterfactual(
    transcript,
    scopedRecords,
    ctx.rates,
    buildSessionReport(transcript, ctx.rates),
    ctx.ambiguousIds
  );
  if (report.provenanceUnavailable) {
    fired.push({ name: "void(withheld)", detail: "provenanceUnavailable — local results with no invocation join (admissionRule 5)" });
  }

  const inherited = record.originatedRequestIds.filter((id) => ctx.cumulative.has(id));
  if (inherited.length > 0) {
    fired.push({
      name: "void(sibling_inheritance)",
      detail: `${inherited.length} originated id(s) already in the cumulative union of prior snapshots and completed observations (admissionRule 4)`,
    });
  }

  if (record.accepted === false) {
    fired.push({ name: "void(task_failed)", detail: "the acceptance predicate did not exit as declared at the end commit (admissionRule 3)" });
  }

  const pacing = pacingFacts(transcript, owned, ctx.rates, ctx.cacheWriteShareCeiling);
  if (pacing.exceeded !== null) {
    fired.push({ name: "void(pacing)", detail: `${pacing.exceeded} (admissionRule 11)` });
  }

  // F25's second case: no predicate ran, so `void(task_failed)` cannot describe
  // it, and nothing fired, so `scored` would claim a TASK where the frozen text
  // defines none. No disposition exists; reported, and no terms.
  if (fired.length === 0 && record.accepted === null) {
    ctx.declarationFailures.push({
      taskId: obs.taskId,
      arm: obs.arm,
      attempt: obs.attempt,
      reasons: [
        ...declReasons,
        "no acceptance predicate ever ran (accepted is null) — a task is scored only against its committed predicate (admissionRule 3) and the closed list has no member for its absence (FINDINGS.md F25)",
      ],
    });
    return {
      obs,
      task: ctx.task,
      fired,
      disposition: null,
      declReasons,
      terms: null,
      pacing,
      // No disposition could be decided here, so there is nothing for a fact to
      // qualify. Empty is the honest value: it says nothing was compared, and the
      // run-level clause reads a union that this contributes nothing to.
      repairRounds: [],
      provenanceUnavailable: report.provenanceUnavailable,
      requestsPerSegment: requestsPerSegment(transcript, owned),
    };
  }

  // The treatment arm's calibrated `O_o` — with provenance, resolved by the
  // harness, refused here when a hostile archive dropped it (`holdsIf` 6 needs
  // it computed for EVERY observation; a default would be an estimate).
  const installed = record.installedChars;
  if (installed === null || installed.value === null || !Number.isFinite(installed.value)) {
    ctx.declarationFailures.push({
      taskId: obs.taskId,
      arm: obs.arm,
      attempt: obs.attempt,
      reasons: [
        ...declReasons,
        "the treatment record carries no calibrated installedChars — holdsIf 6 requires O_o computed, never estimated, and terms cannot be built without it",
      ],
    });
    return {
      obs,
      task: ctx.task,
      fired,
      disposition: null,
      declReasons,
      terms: null,
      pacing,
      // No disposition could be decided here, so there is nothing for a fact to
      // qualify. Empty is the honest value: it says nothing was compared, and the
      // run-level clause reads a union that this contributes nothing to.
      repairRounds: [],
      provenanceUnavailable: report.provenanceUnavailable,
      requestsPerSegment: requestsPerSegment(transcript, owned),
    };
  }

  if (declReasons.length > 0) {
    // Stratum-only failures still get terms: the synthetic non-member string
    // below flows into `partitionByStrata.unknownStratum`, which makes both
    // declared cells unevaluable — the shipped defence-in-depth, not a new
    // rule. The failure itself is reported beside it.
    ctx.declarationFailures.push({ taskId: obs.taskId, arm: obs.arm, attempt: obs.attempt, reasons: [...declReasons] });
  }

  const disposition: Disposition =
    fired.length > 0 ? pickDisposition(fired) : "scored";

  const b12obs: B12Observation = {
    taskId: obs.taskId,
    arm: "treatment",
    sessionId: record.sessionId,
    runId: record.runId,
    originatedRequestIds: record.originatedRequestIds,
    accepted: record.accepted,
    valid: record.valid === true,
    invalidReasons: record.invalidReasons,
    censored: record.censored === true,
    baseCommit: record.baseCommit ?? "",
    endCommit: record.endCommit ?? "",
    treeHashAtStart: record.treeHashAtStart ?? "",
    verificationStratum: (ctx.task?.verificationStratum ??
      "undeclared (FINDINGS.md F25)") as B12Observation["verificationStratum"],
  };

  const terms = computeTerms({
    observation: b12obs,
    transcript,
    telemetry: identifiedScoped,
    rates: ctx.rates,
    installedChars: installed.value,
    ambiguousIds: ctx.ambiguousIds,
    disposition,
  });

  return {
    obs,
    task: ctx.task,
    fired,
    disposition,
    declReasons,
    terms,
    pacing,
    repairRounds: repairRoundsMismatches(ctx.task?.repairMaxRounds ?? null, scopedRecords),
    provenanceUnavailable: report.provenanceUnavailable,
    requestsPerSegment: requestsPerSegment(transcript, owned),
  };
}

/**
 * Artifact 1's frozen `max_rounds` against the rows that say what ran.
 *
 * Read over the SCOPED telemetry — the same subset the counterfactual is priced
 * from — and not over the whole worktree log the harness sees. That is the
 * difference that matters between this and its driver-side twin in
 * `scripts/b12-run.mjs`: a row this run does not own cannot reach a verdict from
 * here, so the scoring side cannot void a run on a foreign row.
 *
 * FAIL-CLOSED ON AN ABSENT FIELD. A repair row carrying no numeric
 * `detail.max_rounds` cannot be compared, and "cannot tell" may not wear the
 * same answer as "matched".
 *
 * BUT NOT ON AN ABSENT ROW, and the amendment says so in its own text: the
 * telemetry writer swallows append failures by design, and a tool whose preflight
 * refuses emits no row while its result still sits in the transcript. Absence of
 * a row is therefore not evidence of compliance, and no guard can be built on
 * the contrary premise without voiding lawful observations.
 */
/** Which regime a committed audit establishes. Absent and invalid are the same. */
export type Regime = "governs" | "does-not-govern" | "unknown";

/** The key every amendment's governance answer is published under. */
export const REPAIR_ROUNDS_GOVERNS = "clause5.repairRoundsAmendment.governs";

/**
 * PRESENCE IS NOT VALIDITY, and reading it as validity was the defect.
 *
 * `audit.ts` writes this key with `facts…governs ? "yes" : "no"`, so those two
 * strings are the entire domain. The first version tested `=== "yes"` for
 * governance and `=== undefined` for unknown, which leaves everything in
 * between — `"true"`, `"YES"`, `""`, a boolean surviving a hand-built `inputs`,
 * a typo, a future encoding — landing in the `!governs` branch and printing the
 * CONFIDENT sentence "does not govern this run". A value nobody can interpret is
 * not evidence that the amendment is inapplicable; it is evidence that the
 * question was not answered, and answering it the permissive way is exactly what
 * `uncheckedClauses` exists to prevent. Named 2026-08-14 by adversarial review.
 *
 * Both readers go through here so they cannot drift: the clause that decides and
 * the `uncheckedClauses` entry that stops the verdict being called FINAL.
 */
export function regimeOf(inputs: Readonly<Record<string, string>> | null, key: string): Regime {
  if (inputs === null) return "unknown";
  const raw = inputs[key];
  if (raw === "yes") return "governs";
  if (raw === "no") return "does-not-govern";
  return "unknown";
}

export function repairRoundsMismatches(
  declared: number | null,
  scoped: ReadonlyArray<{ tool: string; detail?: Record<string, unknown> | undefined }>
): string[] {
  const rows = scoped.filter((r) => r.tool === "repair");
  if (rows.length === 0) return [];
  if (declared === null || !Number.isFinite(declared)) {
    return [
      `${rows.length} repair row(s) exist but the manifest declares repairMaxRounds ${String(declared)}, which is not a number — artifact 1's frozen max_rounds has nothing to compare against`,
    ];
  }
  const out: string[] = [];
  rows.forEach((row, i) => {
    const got = row.detail?.max_rounds;
    if (typeof got !== "number" || !Number.isFinite(got)) {
      out.push(
        `repair row ${i + 1} of ${rows.length} carries no numeric detail.max_rounds, so the frozen repairMaxRounds (${declared}) cannot be checked against what ran`
      );
    } else if (got !== declared) {
      out.push(`repair ran at max_rounds ${got} against a frozen repairMaxRounds of ${declared}`);
    }
  });
  return out;
}

/** First match in the registered precedence; the full list is published beside it. */
function pickDisposition(fired: ReadonlyArray<{ name: Disposition }>): Disposition {
  for (const name of DISPOSITION_PRECEDENCE) {
    if (fired.some((f) => f.name === name)) return name;
  }
  // Unreachable while `fired` holds only precedence members; stated, not defaulted.
  throw new Error("pickDisposition: a fired predicate names no member of the registered precedence");
}

/** Covariate: this window's own billed requests per thread+segment. */
function requestsPerSegment(
  transcript: Transcript,
  owned: ReadonlySet<string>
): Array<{ thread: string; segment: number; requests: number }> {
  const counts = new Map<string, { thread: string; segment: number; requests: number }>();
  for (const r of transcript.requests) {
    if (!owned.has(r.requestId)) continue;
    const key = `${r.thread}#${r.segment}`;
    const cell = counts.get(key) ?? { thread: r.thread, segment: r.segment, requests: 0 };
    cell.requests++;
    counts.set(key, cell);
  }
  return [...counts.values()].sort((a, b) =>
    a.thread === b.thread ? a.segment - b.segment : a.thread < b.thread ? -1 : 1
  );
}

/** Artifact 7's per-observation entry, from what was already computed. */
function counterfactualOf(a: Assessed, isAdmitted: boolean, admittedSumAPlusSLo: number): CounterfactualObservation {
  const terms = a.terms!;
  const record = a.obs.record;
  const classes = ["ambiguous", "unverifiable", "excludedForeign", "unmatched"] as const;
  const ambiguousCount = terms.refusals.ambiguous.count + terms.unattributedRefusals.ambiguous.count;
  return {
    taskId: a.obs.taskId,
    arm: a.obs.arm,
    attempt: a.obs.attempt,
    disposition: terms.disposition,
    firedPredicates: a.fired.map((f) => `${f.name}: ${f.detail}`),
    aO: terms.aO,
    sLo: terms.sLo,
    sHi: terms.sHi,
    oO: terms.oO,
    // `A_o + S_o > 0` per ADMITTED observation, on the deciding (lo) horizon's
    // denominator — asserted and REPORTED, deciding nothing (PREMISES.md § B12).
    aPlusSPositive: isAdmitted ? terms.aO + terms.sLo > 0 : null,
    rows: terms.rows,
    refusals: terms.refusals,
    unattributedRefusals: terms.unattributedRefusals,
    subagentShare: terms.subagentShare,
    requestsPerSegment: a.requestsPerSegment,
    rateKeys: terms.rateKeys,
    // REGISTERED FORMULA (FINDINGS.md, R7#12): share_t = (A_t + S_t,lo) /
    // Σ_admitted (A + S_lo) — the task's share of the metric's OWN
    // denominator on the deciding lo horizon. A COVARIATE: reported beside
    // the manifest's perTaskDenominatorShareCap, deciding nothing — a live
    // predicate here would mint a void the frozen text never wrote.
    perTaskDenominatorShare:
      isAdmitted && admittedSumAPlusSLo > 0 ? (terms.aO + terms.sLo) / admittedSumAPlusSLo : null,
    binaryVersion: record?.binaryVersion ?? null,
    binarySha256: record?.binarySha256 ?? null,
    baseCommit: record?.baseCommit ?? null,
    endCommit: record?.endCommit ?? null,
    treeHashAtStart: record?.treeHashAtStart ?? null,
    instructionComponents: record?.instructionHashes ?? null,
    aggregateHash: {
      absent: true,
      reason:
        "voidConditions 21's instruction-set-hash composition is UNADJUDICATED — components only, no minted canonical hash (FINDINGS.md F24)",
    },
    memorySnapshotSha256: record?.memorySnapshotSha256 ?? null,
    mcpConfigPinned: record?.mcpConfigPinned ?? null,
    mcpConfigPassed: record?.mcpConfigPassedSha256 ?? null,
    holdExcluded: ambiguousCount > 0,
    gateRepairCalls: terms.rows.filter(({ row }) => row.tool === "gate" || row.tool === "repair").length,
    wouldHaveAddedSum: classes.reduce((sum, name) => sum + terms.refusals[name].units, 0),
    wouldHaveAddedUnsized: classes.reduce((sum, name) => sum + terms.refusals[name].unsized, 0),
  };
}

interface ChecksContext {
  archive: RunArchive;
  assessed: Assessed[];
  admittedAssessed: Assessed[];
  checks: ArchiveCheck[];
  scoringCommandActual: string | null;
  duplicatedTaskIds: ReadonlySet<string>;
  /**
   * Which regime governs. Only the repair-max-rounds amendment's `governs` is
   * read here; the whole audit is passed rather than the boolean so the clause
   * can print the amendment's PATH, and a reader of the face can tell WHICH
   * document did or did not apply without holding this file open.
   */
  gitAudit: GitAudit;
  /**
   * The four bracket bounds off the aggregate result, for clause 8's live
   * predicate — checked as VALUES on the constructed result, because NaN
   * survives every sum and serializes as `null`.
   */
  brackets: { rLo: number; rHi: number; uncappedBracket: { rLo: number; rHi: number } };
}

/**
 * The archive-level clauses of UNIT-5.md step 7 — 3's order half, 7, 8, 9, 11,
 * 12, 13, 14, 19, 20 — plus artifact 1's manifest facts and the rates
 * byte-identity, each with its own predicate over the archive, each on the face
 * fired or not. `aggregate`'s `decide()` owns 1, 3's count half, 10, 16, 17, 18.
 *
 * CLAUSE 3 IS SPLIT ACROSS THE TWO AND SAYS SO. Its count half ("fewer than 20
 * admitted", "a stratum under 5") is arithmetic over the finished set and lives
 * in `decide()`; its ORDER half is a replay over the runlog and lives here.
 *
 * CLAUSE 2 IS OWNED BY NEITHER. Its number used to sit on clause 3's order
 * predicate, which made an unimplemented clause look implemented; the number
 * has been moved and the gap is now stated where the check would go.
 */
function buildArchiveChecks(ctx: ChecksContext): void {
  const { archive, assessed, checks } = ctx;
  const pinned = archive.manifest.pinned;
  const push = (clause: string, fired: boolean, detail: string): void => {
    checks.push({ clause, fired, detail });
  };

  // artifact 1 — the manifest's own committedness and freeze. THE BYTES, not
  // the path: `manifestMatchesHead === false` means a blob exists at the path
  // while the bytes being scored are somebody's uncommitted edit (the second
  // diff-round finding).
  const gitP = archive.git;
  push(
    "design.artifacts 1 — manifest blob",
    gitP.manifestBlobSha256 === null ||
      gitP.manifestMatchesHead === false ||
      gitP.manifestCommitsAfterStart === null ||
      gitP.manifestCommitsAfterStart.length > 0,
    gitP.manifestBlobSha256 === null
      ? "HEAD carries no manifest blob — the manifest is not committed evidence"
      : gitP.manifestMatchesHead === false
        ? "the manifest bytes being scored are NOT HEAD's blob — an uncommitted edit is not the sealed manifest"
        : gitP.manifestCommitsAfterStart === null
          ? "the freeze window could not be established (no trustworthy session start, or git could not answer) — a freeze that cannot be shown held is not a freeze"
          : gitP.manifestCommitsAfterStart.length > 0
            ? `${gitP.manifestCommitsAfterStart.length} commit(s) touched the manifest after the earliest session start (${gitP.manifestCommitsAfterStart.join(", ")})`
            : `blob ${gitP.manifestBlobSha256} in HEAD, byte-identical to the scored bytes, untouched since the earliest session start`
  );

  // design.artifacts 1 — task identity (the seventh diff round). One id, one
  // declaration: the by-id joins collapse duplicates by POSITION and the
  // selection walks manifest entries, so a duplicated id fires rather than
  // pricing one session once per declaration.
  push(
    "design.artifacts 1 — task identity",
    ctx.duplicatedTaskIds.size > 0,
    ctx.duplicatedTaskIds.size > 0
      ? `the manifest declares ${[...ctx.duplicatedTaskIds].sort().join(", ")} more than once — a selection walking manifest entries would admit the same observation once per declaration, and which declaration governs it cannot be decided`
      : "every manifest task id is declared exactly once"
  );

  // voidConditions 1 — the register's SHOWABILITY (the third adversarial
  // round). `aggregate`'s decide() voids on an abandoned prior run it can SEE;
  // this fires when the register itself cannot be shown — a manifest with no
  // row, a run's surviving traces with no manifest, unreadable rows,
  // uncommitted registration state — because a register that cannot be listed
  // with confidence is the omission clause 1 calls "itself a VOID". A row
  // ALONE is undecidable against the log's ordinary measurement rows and is
  // `collectRegister`'s registered limit, not a silent pass here.
  push(
    "voidConditions 1 — the register",
    archive.register.discrepancies.length > 0,
    archive.register.discrepancies.length > 0
      ? `the register cannot be shown complete: ${archive.register.discrepancies.join("; ")}`
      : `${archive.register.priorRuns.length} previously registered run(s), every one enumerated from HEAD with its committed result state`
  );

  // design.artifacts 6 — the replay reads COMMITTED evidence, shown rather
  // than assumed. `unshowable` fires too: no repository to ask is not clean.
  const committed = archive.evidenceCommitted;
  push(
    "design.artifacts 6 — committed evidence",
    committed.state !== "clean",
    committed.state === "clean"
      ? "git status shows the manifest, the runlog and every observation directory byte-identical to HEAD"
      : committed.state === "dirty"
        ? `${committed.dirty.length} path(s) differ from HEAD (${committed.dirty.slice(0, 5).join(", ")}${committed.dirty.length > 5 ? ", …" : ""}) — the replay is not reading the committed archive`
        : "committedness is UNSHOWABLE — git could not answer, and absence of proof is never read as clean"
  );

  // VOIDCONDITIONS 2 IS NOT IMPLEMENTED HERE, AND THE OBVIOUS PREDICATE IS
  // WRONG. Read this before writing one.
  //
  // The clause is an optional-stopping guard — the preregistration names the
  // property in the PILOT's words, "mechanically incapable of optional
  // stopping". Nothing implements it. The check that used to carry its number
  // ran `committedOrderReplay`, which is clause 3's predicate by that
  // function's own docstring, and its detail said the partial-set half was
  // "carried by the analysis-session obligations" — by a person. The number is
  // now on the right predicate, so the gap is at least visible.
  //
  // WHAT IS STILL OPEN. `aggregate` runs unconditionally above, before any
  // check here, so an operator can `emit` mid-run and read rLo, rHi and rHiPlus
  // off the artifact even though the verdict is void. That is the peek.
  //
  // THE PREDICATE THAT LOOKS RIGHT AND IS NOT. `admittedCount >= 20 ||
  // notStartedCount === 0` was written, reviewed and REFUTED on 2026-08-13. It
  // over-fires on a lawful shape and costs the run: `runPlan` phase 5 budgets
  // 20-26 supervised sessions over an ordered manifest of 30 (PREMISES.md), so
  // 26 completed observations with 19 admitted and 4 tasks never reached is a
  // run that genuinely cannot grow — and that predicate voids it, at `emit`,
  // after every session is paid for. It also under-fires: `notStartedCount`
  // counts tasks with no ARCHIVED ATTEMPT, which is not the same question as
  // whether a lawful future event can still change the admitted set —
  // `admissionRule` 12's discretionary re-run, an observation whose disposition
  // is null, and invalid or dropped attempts all leave the set mutable while
  // reading as observed.
  //
  // WHAT A CORRECT ONE MUST ACCOUNT FOR: the 20-admission cap, the 26-session
  // ceiling, remaining discretionary and version-drift re-runs, disposition
  // EXISTENCE rather than `byTask` membership, and manifest cardinality — this
  // file has no `tasks.length === 30` check, so an undersized manifest reaches
  // the cap trivially.
  //
  // THE FROZEN TEXT DOES NOT CONTRADICT ITSELF, and an earlier version of this
  // comment said it did. Clause 2's "partial set" is a set that CAN STILL GROW;
  // `admissionRule` 1's "partial bracket" is a bracket published WITHOUT the
  // verdict it would have carried, which is PREMISES.md's own use of the word
  // ("the artifact reads `partial` and renders no verdict"). Registered
  // 2026-08-13 in docs/b12-scorer/FINDINGS.md, under the rationale that document
  // already registered for the pilot's "No units": what must not exist is
  // anything a STOPPING DECISION could read. `narrowPriorRun` had already chosen
  // it — "the partial bracket either way" — and PREMISES.md assigns the disputed
  // case elsewhere by name: "A run that walks all 30 and admits 19 is VOID under
  // `voidConditions` 3". Cardinality is clause 3's; clause 2 is not a duplicate
  // of it.
  //
  // So the predicate is not blocked on an amendment. It is just not written, and
  // the half with teeth is not here anyway: "no interim bracket is derivable
  // from committed data" is a property of the run's COMMIT HISTORY — the commit
  // first introducing a bracket must be the one carrying the verdict — which
  // `git log` decides and this function cannot see.

  // voidConditions 3's ORDER half, replayed from the runlog. Its count half is
  // `decide()`'s, at aggregate.ts's frozen-count refusal — two mechanisms, one
  // clause number, in two different containers: this one lands in
  // `archiveChecks`, that one in `voidClause`.
  const orderProblem = committedOrderReplay(archive);
  push(
    "voidConditions 3 — committed order",
    orderProblem !== null,
    orderProblem ?? "every first execution in the runlog respects the manifest's committed order"
  );

  // voidConditions 4 — rates.json byte-identity, the one clause-4 item the
  // archive itself can check; the rest belongs to the git audit input. FAIL
  // CLOSED (the fourth adversarial round): with the frozen blob unreachable
  // AND the pin absent, this check once read clean and its detail CLAIMED an
  // identity nothing had shown — an unverified pricing input is not a frozen
  // one.
  const pinnedRates = typeof pinned.ratesSha256 === "string" ? pinned.ratesSha256 : null;
  const frozen = gitP.ratesSha256AtFrozenCommit;
  const ratesUnverifiable =
    archive.ratesSha256 === "" || pinnedRates === null || frozen === null;
  const ratesMismatch =
    !ratesUnverifiable && (archive.ratesSha256 !== frozen || archive.ratesSha256 !== pinnedRates);
  push(
    "voidConditions 4 — rates.json frozen",
    ratesUnverifiable || ratesMismatch,
    ratesMismatch
      ? `rates.json (${archive.ratesSha256}) does not match ${archive.ratesSha256 !== frozen ? `the frozen commit's blob (${frozen})` : `the manifest pin (${pinnedRates})`}`
      : ratesUnverifiable
        ? `the byte-identity cannot be SHOWN: ${archive.ratesSha256 === "" ? "rates.json is absent; " : ""}${pinnedRates === null ? "the manifest pins no ratesSha256; " : ""}${frozen === null ? "the frozen commit's blob could not be read; " : ""}unverified pricing is not frozen pricing`
        : "rates.json is byte-identical to the frozen commit's blob and the manifest pin"
  );

  // voidConditions 7 — version pin, per observation, plus the pin's presence.
  const versionDrifted = assessed.filter((a) => a.fired.some((f) => f.name === "void(version_drift)"));
  const pinsAbsent = typeof pinned.claudeCodeVersion !== "string" || typeof pinned.claudeBinarySha256 !== "string";
  push(
    "voidConditions 7 — version and binary pin",
    pinsAbsent || versionDrifted.length > 0,
    pinsAbsent
      ? "the manifest pins no version/binary sha — nothing to hold the run to"
      : versionDrifted.length > 0
        ? `${versionDrifted.length} observation(s) drifted from the pin (a version boundary splits the run into blocks — reported, not pooled)`
        : "every observation matches the pinned version and binary sha; DISABLE_AUTOUPDATER is asserted by the harness before each observation"
  );

  // admissionRule 7 — every declared scope clear of the instrument set, over
  // EVERY manifest task: "no manifest task's file scope" is the whole
  // pre-registered list, not the admitted twenty. The harness carries the
  // registration-time twin; this is the scorer-side replay of the same rule.
  const scopeViolations = fileScopeViolations(
    archive.manifest.tasks.map((t) => ({ id: t.id, fileScope: t.fileScope }))
  );
  push(
    "admissionRule 7 — file scopes clear of the instrument",
    scopeViolations.length > 0,
    scopeViolations.length > 0
      ? scopeViolations.slice(0, 5).join("; ") + (scopeViolations.length > 5 ? "; …" : "")
      : "every declared scope parses under the grammar and none intersects src/cost/**, the walk script, evidence/**, or the governance documents"
  );

  // voidConditions 8 — the measured cap, and BOTH BRACKETS. LIVE since F23's
  // repair: fires iff `!(Number.isFinite(cap) && cap > 0)` OR any of the four
  // bracket bounds is not a proper finite number ON THE CONSTRUCTED RESULT —
  // a VALUE check, because NaN survives every sum and serializes as `null`,
  // and a check on the fields' spelled presence is the theatre
  // FINDINGS.md:546-553 refused. The same truth table is asserted over the
  // real serializer's bytes by the test wave.
  const cap = pinned.clientTruncationCap;
  const capValid = typeof cap === "number" && Number.isFinite(cap) && cap > 0;
  const bounds = [
    ctx.brackets.rLo,
    ctx.brackets.rHi,
    ctx.brackets.uncappedBracket.rLo,
    ctx.brackets.uncappedBracket.rHi,
  ];
  const badBound = bounds.some((v) => typeof v !== "number" || !Number.isFinite(v));
  push(
    "voidConditions 8 — measured cap and both brackets",
    !capValid || badBound,
    !capValid
      ? "NO measured clientTruncationCap is pinned as a finite positive number — the capped bracket is priced against nothing"
      : badBound
        ? "a bracket bound is not a finite number — the artifact cannot carry a bracket it cannot state"
        : "the cap is pinned and the artifact carries both brackets, capped and uncapped, four finite bounds"
  );

  // voidConditions 9 — instrument contamination, run-level.
  const contaminated = assessed.filter((a) => a.fired.some((f) => f.name === "void(instrument_write)"));
  push(
    "voidConditions 9 — instrument contamination",
    contaminated.length > 0,
    contaminated.length > 0
      ? `${contaminated.length} observation(s) touched the instrument — run-level by rule 7`
      : "no archived lineage touched the meter, the walk script, or the telemetry log; the verdict-session half is carried by the analysis-session obligations (PREMISES.md § B12)"
  );

  // voidConditions 11 — base commit per task; the pair half belongs to the A/B.
  const wrongBase = assessed.filter(
    (a) => a.task?.baseCommit != null && a.obs.record?.baseCommit != null && a.obs.record.baseCommit !== a.task.baseCommit
  );
  push(
    "voidConditions 11 — declared base commit",
    wrongBase.length > 0,
    wrongBase.length > 0
      ? `${wrongBase.length} observation(s) started from a tree that is not the manifest-declared base commit`
      : "every observation's baseCommit matches its manifest declaration; cleanliness was asserted by the harness at start (treeHashAtStart recorded); pair tree hashes belong to the A/B pass"
  );

  // voidConditions 12 — instruction components, intra-arm, from the archived
  // pre/post hashes. Components ONLY; the pair-level comparison is blocked on
  // the VOID-21/VOID-12 adjudications (FINDINGS.md F24, registered).
  // ABSENT EVIDENCE FIRES TOO (the diff review's fifth finding): a record that
  // carries no hashes cannot show the clause held, and an uncheckable clause
  // published as clean is the shape the audit handling refuses one level up.
  const driftedInstruction: string[] = [];
  const missingPolicy: string[] = [];
  const missingHashes: string[] = [];
  for (const a of assessed) {
    const hashes = a.obs.record?.instructionHashes;
    if (hashes == null) {
      missingHashes.push(a.obs.dir);
    } else {
      for (const component of CLAUSE_12_COMPONENTS) {
        if ((hashes.pre[component] ?? null) !== (hashes.post[component] ?? null)) {
          driftedInstruction.push(`${a.obs.dir}: ${component}`);
        }
      }
    }
    if (a.obs.record?.policyBlobSha256 == null) missingPolicy.push(a.obs.dir);
  }
  push(
    "voidConditions 12 — instruction set",
    driftedInstruction.length > 0 || missingPolicy.length > 0 || missingHashes.length > 0,
    driftedInstruction.length > 0
      ? `component hash moved between start and end: ${driftedInstruction.join("; ")}`
      : missingPolicy.length > 0
        ? `the per-arm policy blob hash is absent from ${missingPolicy.length} record(s), which the clause voids by name`
        : missingHashes.length > 0
          ? `${missingHashes.length} record(s) carry no instruction hashes at all — the clause cannot be shown to hold`
          : "every component hash held from start to end and every record carries its policy blob hash; the pair-level comparison awaits the registered VOID-12/VOID-21 adjudications"
  );

  // voidConditions 13 — memory: no writes, restored from the committed
  // snapshot. Absent evidence fires here too: a missing pin, a missing per-
  // record snapshot hash, or missing pre/post memory hashes leave the clause
  // unshowable, and unshowable is not clean.
  const memoryPin = typeof pinned.memorySnapshotSha256 === "string" ? pinned.memorySnapshotSha256 : null;
  const memoryDrift: string[] = [];
  if (memoryPin === null) memoryDrift.push("the manifest pins no memory snapshot hash");
  for (const a of assessed) {
    const hashes = a.obs.record?.instructionHashes;
    if (hashes == null || hashes.pre["memory"] == null || hashes.post["memory"] == null) {
      memoryDrift.push(`${a.obs.dir}: no pre/post memory hashes — the no-write half cannot be shown`);
    } else if (hashes.pre["memory"] !== hashes.post["memory"]) {
      memoryDrift.push(`${a.obs.dir}: written during the session`);
    }
    if (a.obs.record?.memorySnapshotSha256 == null) {
      memoryDrift.push(`${a.obs.dir}: no restoration hash — the restored-from-snapshot half cannot be shown`);
    } else if (memoryPin !== null && a.obs.record.memorySnapshotSha256 !== memoryPin) {
      memoryDrift.push(`${a.obs.dir}: not restored from the pinned snapshot`);
    }
  }
  push(
    "voidConditions 13 — memory restoration",
    memoryDrift.length > 0,
    memoryDrift.length > 0 ? memoryDrift.join("; ") : "every session's memory hash held pre to post and matches the pinned snapshot"
  );

  // voidConditions 14 — snapshot scope. The counts are mechanical; "every slug
  // this repository owns" is assertable only at run time and the harness owns
  // it — a registered limit, stated rather than dressed as a check.
  const badSnapshots = assessed.filter(
    (a) =>
      a.obs.snapshotBefore === null ||
      a.obs.snapshotAfter === null ||
      (a.obs.snapshotBefore.slugsWalked ?? 0) === 0 ||
      a.obs.snapshotBefore.requestIds.length === 0
  );
  push(
    "voidConditions 14 — snapshot scope",
    badSnapshots.length > 0,
    badSnapshots.length > 0
      ? `${badSnapshots.length} observation(s) carry a missing or zero-count snapshot`
      : "every observation carries both snapshots with non-zero slug and id counts; the every-slug half is asserted by the harness at run time (registered limit)"
  );

  // voidConditions 19 — the scoring command, and the ambiguity id set. The id
  // set is NOT taken on faith (the diff review's fourth finding): the archive
  // carries each observation's `invocationIds` inventory, sealed by the
  // capture, and the set the ambiguity check derived from the rebuilt
  // transcripts must EQUAL it — a dropped tool result would silently shrink
  // the universe the clause exists to pin.
  const idMismatches: string[] = [];
  for (const a of ctx.assessed) {
    if (a.obs.transcript === null) continue;
    const derived = new Set(
      a.obs.transcript.toolResults
        .filter(isLocalToolResult)
        .map((r) => r.invocationId)
        .filter((id): id is string => id !== null)
    );
    const sealed = new Set(a.obs.invocationIds);
    const missing = [...sealed].filter((id) => !derived.has(id));
    const extra = [...derived].filter((id) => !sealed.has(id));
    if (missing.length > 0 || extra.length > 0) {
      idMismatches.push(
        `${a.obs.dir}: ${missing.length} sealed id(s) absent from the rebuilt transcript, ${extra.length} derived id(s) absent from the sealed inventory`
      );
    }
  }
  // FAIL CLOSED (the fifth diff round's second finding): the clause certifies
  // that the REGISTERED command scored the run, and a certification needs both
  // sides — an absent pin or an unsupplied invocation is an unverified
  // command, never a clean one.
  const pinnedCommand = typeof pinned.scoringCommand === "string" ? pinned.scoringCommand : null;
  const commandFired =
    pinnedCommand === null || ctx.scoringCommandActual === null || pinnedCommand !== ctx.scoringCommandActual;
  push(
    "voidConditions 19 — scoring command and ambiguity set",
    commandFired || idMismatches.length > 0,
    commandFired
      ? pinnedCommand !== null && ctx.scoringCommandActual !== null
        ? `the scoring invocation (${ctx.scoringCommandActual}) differs from the committed string (${pinnedCommand})`
        : `${pinnedCommand === null ? "no scoring command is pinned in the manifest; " : ""}${ctx.scoringCommandActual === null ? "the actual invocation was not supplied; " : ""}an invocation that cannot be shown to be the registered one is not the registered one`
      : idMismatches.length > 0
        ? `the id set the ambiguity check saw is not the archive's sealed inventory: ${idMismatches.join("; ")}`
        : "the scoring invocation equals the committed string, and the ambiguity set equals every observation's sealed invocation-id inventory, published on the face"
  );

  // voidConditions 20 — pacing, per observation, and the ceiling's presence.
  const ceilingPinned = typeof pinned.pacingCacheWriteShareCeiling === "number";
  const paced = assessed.filter((a) => a.pacing !== null && a.pacing.exceeded !== null);
  push(
    "voidConditions 20 — pacing",
    !ceilingPinned || paced.length > 0,
    !ceilingPinned
      ? "no pacing ceiling is pinned — the ceiling must be committed before the first observation"
      : paced.length > 0
        ? `${paced.length} observation(s) exceeded a pacing ceiling`
        : "every observation is inside the gap and cacheWrite-share ceilings"
  );

  // THE 2026-08-14 PRE-DATA AMENDMENT — repair's frozen max_rounds, run-level.
  //
  // Not one of the 23 frozen conditions and never described as one. It is named
  // here as an amendment so a reader of the face can always tell which regime
  // produced the verdict, which is the same courtesy the conformance-paths
  // amendment gets in the audit artifact.
  //
  // GATED ON `governs`, which `audit.ts` computed against the run's freeze
  // anchor. An ungoverned run reaches the same line and is told, in the detail,
  // that the amendment exists and did not apply to it — because "no mismatch"
  // and "the rule was not in force" are two different clean answers, and a
  // clause that prints one when it means the other is how a regime silently
  // changes.
  //
  // RUN-LEVEL AND NOT AN EXCLUSION, on voidConditions 9's own stated ground:
  // triggering it costs the run rather than buying an exclusion. `repair` is
  // treatment-only, so dropping the offending observation instead would drop
  // treatment attempts alone and hand the vacated admission slot to the next
  // task in committed order — a selection channel whose sign cannot be
  // established before the run. Every observation keeps its disposition here;
  // what dies is the run.
  // Read off the COMMITTED audit's published face, the same flat input map every
  // other git fact arrives through — never re-derived here, because this file
  // cannot ask git anything and a second derivation is a second answer.
  //
  // `{ran: false}` IS NOT "does not govern" AND IS NOT "governs". With no
  // committed audit the regime is UNKNOWN, and the clause says so rather than
  // picking the reading that fires nothing. It still does not fire — an unproven
  // rule may not void a run — but the detail refuses to call that a clean pass,
  // which is the distinction `uncheckedClauses` exists to preserve.
  const rmrInputs = ctx.gitAudit.ran ? ctx.gitAudit.inputs : null;
  const rmrPath = rmrInputs?.["clause5.repairRoundsAmendment.path"] ?? "(no committed audit)";
  const rmrRegime = regimeOf(rmrInputs, REPAIR_ROUNDS_GOVERNS);
  const rmrGoverns = rmrRegime === "governs";
  const rmrUnknown = rmrRegime === "unknown";
  const offenders = assessed.filter((a) => a.repairRounds.length > 0);
  const wouldHave =
    offenders.length > 0 ? `; ${offenders.length} observation(s) WOULD have fired it, reported and deciding nothing` : "";
  push(
    "amendment 2026-08-14 — repair's frozen max_rounds",
    rmrGoverns && offenders.length > 0,
    rmrUnknown
      ? `no committed audit says whether the repair-max-rounds amendment governs this run, so the regime is UNKNOWN and this clause may not be read as passed${wouldHave}`
      : !rmrGoverns
        ? `the amendment (${rmrPath}) does not govern this run — its introducing commit is not an ancestor of the freeze anchor, so artifact 1's max_rounds is carried but not enforced here${wouldHave}`
        : offenders.length > 0
        ? `${offenders.length} observation(s) ran repair at a max_rounds other than the frozen one: ${offenders
            .map((a) => `${a.obs.taskId}/${a.obs.arm} — ${a.repairRounds.join("; ")}`)
            .join(" | ")}`
        : "every repair row that exists ran at its task's frozen max_rounds (a call whose row never landed is invisible to this, by the amendment's own text)"
  );
}

/**
 * `voidConditions` 3's order half, replayed RETROSPECTIVELY over the runlog:
 * the sequence of FIRST executions must respect the manifest's committed
 * order. The harness's `committedOrderViolation` answers the PROSPECTIVE form
 * ("may this run start now") before a session is spent; this is the other
 * half of the same rule, over the same rows, and the tests hold both.
 */
export function committedOrderReplay(archive: RunArchive): string | null {
  if (archive.runlog.corruptLines > 0) {
    return `the runlog carries ${archive.runlog.corruptLines} corrupt line(s), so the committed order cannot be fully replayed`;
  }

  // A row naming another run inside `evidence/<runId>.b12.runlog.jsonl` is
  // foreign evidence — this run's order cannot be replayed over it (the fifth
  // diff round's first finding, the run half of the identity binding).
  for (const row of archive.runlog.rows) {
    if (row.runId !== archive.runId) {
      return `the runlog carries a row naming run ${row.runId} — foreign evidence in ${archive.runId}'s log, over which this run's order cannot be replayed`;
    }
  }

  // ABSENT EVIDENCE IS NOT COMPLIANCE (the diff review's second finding). The
  // harness appends one machine-written row per observation (`design.artifacts`
  // 10), so every archived treatment attempt must have its row and every row
  // its directory — a runlog short of the archive, or long of it, means the
  // order CANNOT be shown followed, and an unreplayable clause may not be
  // published as a clean one.
  const rowCount = new Map<string, number>();
  for (const row of archive.runlog.rows) {
    if (row.arm !== "treatment") continue;
    rowCount.set(row.taskId, (rowCount.get(row.taskId) ?? 0) + 1);
  }
  const attemptCount = new Map<string, number>();
  for (const obs of archive.observations) {
    if (obs.arm !== "treatment") continue;
    attemptCount.set(obs.taskId, (attemptCount.get(obs.taskId) ?? 0) + 1);
  }
  for (const [taskId, attempts] of attemptCount) {
    const rows = rowCount.get(taskId) ?? 0;
    if (rows !== attempts) {
      return `task ${taskId} has ${attempts} archived attempt(s) but ${rows} runlog row(s) — the committed order cannot be replayed over missing or extra evidence`;
    }
  }
  for (const [taskId, rows] of rowCount) {
    if (!attemptCount.has(taskId)) {
      return `the runlog records ${rows} row(s) for task ${taskId} but no observation directory survives — evidence was destroyed`;
    }
  }

  // THE SESSION BINDING (the fifth diff round's first finding). Count equality
  // says every attempt HAS a row; it does not say the rows are THESE attempts'
  // rows. The harness stamps both sides with the session that executed, so per
  // task the two inventories must agree as MULTISETS — order-free, because
  // `admissionRule` 12 already says re-runs are not order events. An empty
  // session on either side is a binding that cannot be shown, and refuses.
  const sessionsOf = new Map<string, string[]>();
  for (const row of archive.runlog.rows) {
    if (row.arm !== "treatment") continue;
    if (row.sessionId === "") {
      return `a runlog row for task ${row.taskId} carries no sessionId — a row that cannot be bound to its session cannot be shown to be any attempt's row`;
    }
    const list = sessionsOf.get(row.taskId);
    if (list) list.push(row.sessionId);
    else sessionsOf.set(row.taskId, [row.sessionId]);
  }
  for (const obs of archive.observations) {
    if (obs.arm !== "treatment") continue;
    const session = obs.record?.sessionId ?? "";
    if (session === "") {
      return `the archived attempt at ${obs.dir} carries no sessionId — it cannot be bound to its runlog row`;
    }
    const rows = sessionsOf.get(obs.taskId) ?? [];
    const at = rows.indexOf(session);
    if (at === -1) {
      return `the archived attempt at ${obs.dir} ran as session ${session}, which no runlog row for ${obs.taskId} records — the rows cannot be shown to be these attempts' rows`;
    }
    rows.splice(at, 1);
  }

  const order = new Map(archive.manifest.tasks.map((t, i) => [t.id, i]));
  const seen = new Set<string>();
  for (const row of archive.runlog.rows) {
    if (row.arm !== "treatment") continue;
    if (seen.has(row.taskId)) continue; // re-runs are not order events (admissionRule 12)
    const index = order.get(row.taskId);
    if (index === undefined) {
      return `the runlog names task ${row.taskId}, which the manifest's committed order does not contain`;
    }
    for (const [id, i] of order) {
      if (i < index && !seen.has(id)) {
        return `task ${row.taskId} first ran before its predecessor ${id} — the committed order was not followed`;
      }
    }
    seen.add(row.taskId);
  }
  return null;
}
