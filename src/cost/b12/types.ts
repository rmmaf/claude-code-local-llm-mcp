/**
 * The vocabulary of B12's scorer. TYPES ONLY — no arithmetic lives here.
 *
 * This file exists so the four units under `src/cost/b12/` agree about what
 * they are passing each other before any of them is implemented, and so `tsc`
 * enforces that agreement while the bodies are still `throw`. **Both clauses
 * record why the file was written, not where things stand: all four bodies are
 * implemented and their oracles green since `coverage.ts` landed, and the count
 * was three until UNIT 4 joined them.** It sits under
 * `src/` on purpose: `tsconfig.json` covers `src/**` and `tests/**` but not
 * `scripts/**`, so a scoring type defined in a script would be checked by
 * nothing — and this vocabulary is production code besides. `contract-probe.ts`
 * is here for the same reason. **Until 2026-08-07 the config covered `src/**`
 * ALONE and this sentence named `tests/` too, which was the true reason then:
 * no test file in the repository was type-checked by anything.**
 *
 * Two shapes below encode a rule rather than a value, and both are deliberate:
 * `Evaluable<T>` makes "not evaluable" unrepresentable as a number, and
 * `DeliveryScore` makes `unexercised` unrepresentable as zero. The frozen design
 * forbids both collapses by name, and a type is the only place a prohibition
 * cannot be forgotten.
 */

import type { CreditedRow, RowDisposition } from "../report.js";
import type { TelemetryRecord } from "../../telemetry.js";

/**
 * A quantity that may not exist, where the absence is a RESULT and not a
 * failure — and specifically not a zero.
 *
 * The design says it twice, about two different quantities: `R_hi+` is NOT
 * EVALUABLE when any refused magnitude is null, and "an unknown may not be
 * summed as zero"; a delivery below its observation floor is `unexercised` and
 * "NOT SCORED, never 0". `number | null` would have carried the first and let a
 * reader `?? 0` their way out of it. This does not.
 */
export type Evaluable<T> = { evaluable: true; value: T } | { evaluable: false; reason: string };

/** The closed disposition list, quoted from `design.admissionRule`. */
export type Disposition =
  | "scored"
  | "void(execution_error)"
  | "void(version_drift)"
  | "void(instrument_write)"
  | "void(rate_key_mixed)"
  | "void(withheld)"
  | "void(sibling_inheritance)"
  | "void(task_failed)"
  | "void(pacing)"
  | "not_started";

/** The two arms an observation can belong to. */
export type Arm = "treatment" | "control";

/**
 * The fields of `evidence/<runId>/obs-<taskId>-<arm>/observation.json` that the
 * scorer reads. `scripts/b12-run.mjs` writes more than this AND LESS: the extra
 * fields are provenance the arithmetic never touches, but `verificationStratum`
 * below is not written by it at all and has to be joined from the manifest.
 *
 * `originatedRequestIds` IS THE UNIT. Everything else here is a guard on it.
 */
export interface B12Observation {
  taskId: string;
  arm: Arm;
  sessionId: string;
  runId: string | null;
  /** Ids present in the post-snapshot and absent from the pre-snapshot. */
  originatedRequestIds: string[];
  /** Null when the task declared no acceptance command. */
  accepted: boolean | null;
  /** False when the harness itself refused the observation. */
  valid: boolean;
  invalidReasons: string[];
  /** True when the arm hit its wall-clock budget: an outcome, not a failure. */
  censored: boolean;
  baseCommit: string;
  endCommit: string;
  treeHashAtStart: string;
  /**
   * Declared in the manifest before the run — never inferred from the result.
   *
   * **NOTHING WRITES IT YET, and nothing validates it.** `scripts/b12-run.mjs`
   * emits no such field into `observation.json` (grep it), so whoever wires the
   * reader will be joining this from the manifest by `taskId`. Until then the
   * union below is a claim about a document, not a guarantee from the compiler,
   * which is why `partitionByStrata` carries an `unknownStratum` bucket rather
   * than trusting the type.
   */
  verificationStratum: "test-red" | "types-only";
}

/**
 * A telemetry row plus an identity that survives a null `invocation_id`.
 *
 * `TelemetryRecord` carries nothing usable as run-level identity: `invocation_id`
 * is optional and absent on every row written before it existed, and two rows can
 * otherwise be byte-identical. So identity is (ARTIFACT, ORDINAL), stamped when
 * the run reads the log, and it is a property of the READ rather than of the row.
 *
 * `key` is `JSON.stringify([source, ordinal])` and not `${source}#${ordinal}`,
 * because a path may contain `#` and two different rows would then share a key —
 * which is the one thing an identity may not do.
 */
export interface IdentifiedRow {
  key: string;
  record: TelemetryRecord;
}

/** A priced row with the identity of the telemetry row it came from. */
export interface KeyedRow {
  key: string;
  row: CreditedRow;
}

/**
 * One physical telemetry row that NO observation owns, resolved once.
 *
 * THE SOURCE OF TRUTH FOR THE RUN-LEVEL LEDGER, which is derived from a list of
 * these rather than accumulated alongside one. Counts and sums cannot say WHICH
 * rows they hold, so an artifact carrying only totals cannot be checked against
 * the claim that each physical row entered exactly once — and that claim is the
 * whole of the fix.
 */
export interface CoveredRow {
  key: string;
  /**
   * The class it was entered under. When `conflict` is non-null this is the
   * disposition of its first occurrence in sorted observation order — ARBITRARY,
   * DETERMINISTIC, AND DECIDING NOTHING, because a conflicted row is unsized and
   * `rHiPlus` refuses on it either way.
   */
  disposition: RowDisposition;
  /** Null when nothing could size it, or when the slices disagreed. Never 0 for either. */
  units: number | null;
  /** Why it could not be resolved. Null when every occurrence agreed. */
  conflict: string | null;
  /** The observations whose slices held it, as `taskId/arm`. */
  slices: readonly string[];
}

/**
 * The run-level answer to "was every telemetry row counted exactly once".
 *
 * WITHOUT IT `R_hi⁺` IS WRONG IN BOTH DIRECTIONS AT ONCE. `scopeTelemetry` admits
 * a row on a ±60,000 ms window as well as on an exact id match, so one physical
 * row can sit in two observations' slices and be summed twice; and a credited row
 * no window owns is dropped from every `S_o` and from every refusal class, so it
 * is summed zero times. The first inflates or deflates by the row's sign, the
 * second deflates the fall-side figure — `FINDINGS.md` F12 and F9.
 *
 * Every field here is COMPUTED AND REPORTED. None of them silently repairs
 * anything: the ledger's job is to say what it could not account for, and
 * `rHiPlus`'s job is to refuse rather than to publish a figure over a set it
 * cannot enumerate.
 */
export interface RunTelemetryCoverage {
  /** Keys exactly one observation owns, mapped to that observation's `taskId/arm`. */
  ownedBy: ReadonlyMap<string, string>;
  /**
   * Keys two or more observations claim, assigned to NONE of them. Reachable:
   * `windowInvocationIds` maps tool-use ids to invocation ids with no one-to-one
   * guarantee, and a resumed or forked session carries the original records
   * forward. Reported rather than thrown — `aggregate()` owes an artifact whether
   * it scores or voids, and a throw produces none.
   */
  contested: ReadonlyArray<{ key: string; claimants: readonly string[] }>;
  /**
   * Keys in the run's telemetry that no observation's slice ever saw.
   *
   * THE REASON THE UNIVERSE IS AN ARGUMENT. A coverage built from the
   * observations alone cannot see these at all: `computeTerms` receives a slice
   * that `scopeTelemetry` has already narrowed, so a row outside every window is
   * absent from every input. It has neither a disposition nor a magnitude, which
   * is exactly why it may not be summed as zero.
   */
  unsliced: readonly string[];
  /** Every unowned key, one entry each. The two ledgers below are derived from it. */
  unownedRows: readonly CoveredRow[];
  /** The four classes over `unownedRows`, each physical row entered ONCE. */
  unowned: RefusalLedger;
  /**
   * F9: unowned rows whose disposition is `credited`. They are in no `S_o`, in no
   * refusal class, and no void condition sees them.
   *
   * NOT ADDED TO ANY FIGURE. `design.metric` defines `S_o` over "`o`'s credited
   * rows" and limits `R_hi⁺`'s additions to the four refusal classes, so crediting
   * one here would amend the estimand rather than repair the instrument. It
   * refuses `R_hi⁺` instead, and it is published so the omission is visible.
   */
  unattributedCredited: ClassLedger;
  /** Why the ledger could not be formed. Empty means it was. */
  reasons: readonly string[];
  /**
   * Every physical row of the run entered the ledger exactly once, AND with a
   * magnitude the ledger could state. `reasons.length === 0`.
   *
   * The second half belongs in the name: a row counted once but unsized has not
   * been accounted for either, and summing it as zero is the collapse this whole
   * type file exists to forbid. Computed, never assumed.
   */
  exactlyOnce: boolean;
}

/** One refusal class: its count, its summed magnitude, and what it could not size. */
export interface ClassLedger {
  count: number;
  /** A FLOOR whenever `unsized > 0`. Never contains a zero standing in for an unknown. */
  units: number;
  unsized: number;
}

/** All four classes the design names. Fewer than four is not a ledger. */
export interface RefusalLedger {
  ambiguous: ClassLedger;
  unverifiable: ClassLedger;
  excludedForeign: ClassLedger;
  unmatched: ClassLedger;
}

/**
 * Covariate 1, the only covariate the frozen design says "GATES BOTH VERDICTS".
 *
 * An observation whose window contains no billed request of its own has NO
 * subagent share — not a share of zero. Zero is what a solo session measures,
 * and reporting it for a session that measured nothing would put an
 * unevaluable observation into the `solo` stratum and let it vote.
 */
export interface SubagentShare {
  /** Requests in this observation's window. */
  own: number;
  sidechain: number;
  /** `sidechain / own`, continuous, as the design requires it reported. */
  share: number;
  stratum: "solo" | "multi";
}

/**
 * One cell's bracket, WITH THE TWO POPULATIONS IT WAS BUILT FROM.
 *
 * **`admissionRule` 6 made a cell's evaluability and its ratio come from
 * different sets, and the artifact could not say so.** `holdsIf` 3 asks for cells
 * "evaluable (≥ 5 ADMITTED observations each) and all four on the same side of
 * 30%", so the floor counts admitted observations while the hold-side ratio is
 * pooled over the hold-eligible ones — a cell can be evaluable on ten and priced
 * on four, and a reader of `Evaluable<number>` alone would see a bracket with no
 * way to tell. `FINDINGS.md` F21.
 *
 * **REPORTED, DECIDING NOTHING.** Neither count is compared with anything. The
 * frozen floor stays on `counted`, and adding a second floor on `priced` was
 * adjudicated and REFUSED — it mints no new constant but it does mint a second
 * predicate over a population `admissionRule` 8 does not name. Publishing the
 * numbers is what the design's "reported, deciding nothing" category is for; the
 * gap itself stays open.
 *
 * An INTERSECTION with `Evaluable<number>` rather than a wrapper, so `.evaluable`
 * still narrows and no existing reader changes — and so the counts survive on an
 * UNEVALUABLE cell, which is the one case where a reader most wants them.
 */
export type StratumCell = Evaluable<number> & {
  /**
   * This cell's size in the FLOOR partition — admitted observations, the
   * population `holdsIf` 3's "≥ 5 admitted observations each" counts.
   *
   * NOT "the population that decided evaluability", which is what this said and
   * is false on one branch: a cell whose run carries an unrecognised
   * `verificationStratum` is unevaluable because `unknownStratum` is non-empty,
   * whatever its own size. `counted` is a size, and only sometimes the reason.
   */
  counted: number;
  /** The population the ratio was pooled over. Equal to `counted` on the published face. */
  priced: number;
};

/** The four cells `holdsIf` 3 requires to be evaluable and on one side of 30%. */
export interface StrataCells {
  testRed: StratumCell;
  typesOnly: StratumCell;
  solo: StratumCell;
  multi: StratumCell;
}

/** One delivery's share of the numerator, partitioned over the telemetry `tool` field. */
export interface DeliveryTerms {
  /** `S_o` at `T-1-t = 0` for this tool's rows only. */
  sLo: number;
  /** `S_o` at the observed segment for this tool's rows only. */
  sHi: number;
  rowCount: number;
  /**
   * Rows whose `passed` is `true` — what `MIN_REPAIR_CLOSURES` counts.
   *
   * REQUIRED, not optional. An optional field read as 0 when absent is the
   * unknown-summed-as-zero collapse the rest of this file exists to forbid, and
   * it would silently turn "we did not look" into "nothing closed".
   */
  closures: number;
  /**
   * Rows whose `passed` is `null` — the tool did not say. REPORTED, DECIDING
   * NOTHING: they are not counted as closures, which pushes a delivery toward
   * `unexercised`, and `unexercised` is neither a hold nor a fall. Carried so a
   * reader can tell "the delivery was exercised and did not close" from "the
   * rows could not answer", which the closure count alone cannot express.
   */
  closureUnknown: number;
}

/**
 * Everything one observation contributes, before anything is pooled.
 *
 * `sLo` and `sHi` are SIGNED. There is no clamp anywhere in this record, and a
 * negative value is a real measurement: `run 2026-08-04-mac-09` had `repair`
 * net negative on 12 of 12 calls against a TypeScript gate.
 */
export interface ObservationTerms {
  taskId: string;
  arm: Arm;
  disposition: Disposition;
  /** Billed input-equivalent units of this window's own originated requests. */
  aO: number;
  /** `S_o` with every row credited at the write component alone. */
  sLo: number;
  /** `S_o` at the observed segment. */
  sHi: number;
  /**
   * The same two sums with NO `clientTruncationCap` — accumulated from the
   * ledger's `unitsLoUncapped`/`unitsUncapped` in the same credited branch, so
   * the uncapped bracket is summed from rows priced whole rather than
   * reconstructed from byte totals. Feeds `B12Result.uncappedBracket` and
   * nothing else.
   */
  sLoUncapped: number;
  sHiUncapped: number;
  /** `unitsAddedByInstallation` restricted to the segments this window originated. */
  oO: number;
  /**
   * This window's OWN rows, credited and refused, for the artifact's face.
   *
   * Keyed since 2026-08-07: the run-level ledger has to tell one physical
   * telemetry row from another across observations, and an `invocationId` cannot
   * do it — a row can have none, and two observations can hold the same one.
   */
  rows: KeyedRow[];
  /** Refused rows this window OWNS — their `invocationId` is one of its own. */
  refusals: RefusalLedger;
  /**
   * Every OTHER row in this observation's telemetry slice, credited and refused
   * alike: `invocationId` null, or an id this window does not own.
   *
   * INDIVIDUALLY, NOT SUMMED, and that is the F12 fix. The same physical row sits
   * in two observations' slices whenever two sessions ran within a minute
   * (`admissionRule` 5 names `scopeTelemetry`'s ±60,000 ms window by hand), so a
   * per-observation TOTAL of these cannot be added up across observations without
   * counting that row twice — and `wouldHaveAdded` is signed, so a duplicated
   * negative magnitude pushes `R_hi⁺` DOWN, toward a fall the data does not
   * support. `runCoverage` deduplicates these by key and `rHiPlus` reads the
   * result; nothing sums this list directly.
   *
   * CREDITED ROWS ARE HERE TOO, which the four-class ledger below cannot express.
   * A credited row no window owns is `FINDINGS.md` F9: it is in no `S_o` and in
   * no refusal class, so it was summed zero times and no void condition saw it.
   */
  unattributed: KeyedRow[];
  /**
   * The four-class summary of the REFUSED part of `unattributed`, for this
   * window's own artifact page.
   *
   * **NOTHING MAY SUM IT; ONE PREDICATE MAY READ IT.** It is filled in the same
   * pass as `unattributed` — one loop, one rule, so the two cannot drift. It used
   * to be what `rHiPlus` summed, which is the defect F12 records: summing a
   * per-observation total of rows no observation owns double-counts every row two
   * slices share.
   *
   * This doc said "A DIAGNOSTIC THAT DECIDES NOTHING" until F19, and that became
   * false. `admissionRule` 6 excludes an observation with `ambiguous > 0` from the
   * hold arithmetic, and `admissionRule` 5 pins what `ambiguous` means to the
   * shipped counter — `savedFraction` withheld iff `provenanceUnavailable ||
   * ambiguous > 0` (`report.ts`) — which is counted over the whole telemetry slice
   * with NO ownership filter. So the clause-6 predicate is
   * `refusals.ambiguous.count + unattributedRefusals.ambiguous.count > 0`, and a
   * predicate reading only the owned ledger would miss an observation whose
   * ambiguous rows are all unowned.
   *
   * A BOOLEAN IS NOT THE SUM F12 FORBIDS. The duplication is arithmetic: one
   * physical row in two slices, added twice. Asking each observation "did your
   * report withhold" adds nothing — and a shared ambiguous row makes the answer
   * yes for BOTH observations, which is correct, because both reports withheld.
   */
  unattributedRefusals: RefusalLedger;
  /** Unevaluable when the window carried no billed request of its own. */
  subagentShare: Evaluable<SubagentShare>;
  /** Partitioned by the telemetry `tool` field, never by this project's prose. */
  perDelivery: Record<string, DeliveryTerms>;
  billedRequestCount: number;
  /** More than one across the admitted set VOIDs the run (`admissionRule` 9). */
  rateKeys: string[];
  verificationStratum: "test-red" | "types-only";
}

/**
 * One delivery's verdict. `unexercised` is a THIRD state, not a low score.
 *
 * The floor is the design's: fewer than 5 admitted observations carrying this
 * tool's rows and it is not scored. `repair` carries a second condition —
 * `holdsIf` requires "at least two of those carry `passed: true`" — because
 * `turns_collapsed` is `rounds.length` whether or not the failure closed, so an
 * unconditioned `R_repair` is maximised by `repair` flailing for its full budget
 * and returning red.
 *
 * THE FLOOR COUNTS OBSERVATIONS, NOT ROWS: at least two of the carrying
 * observations must hold a closure, which is `DeliveryTerms.closures > 0` on
 * this delivery's bucket. It is stated here because the second condition was
 * written into `UNIT-3.md` before anything carried `passed` at all, so it named
 * a quantity that did not exist and could not be implemented from the declared
 * types.
 */
export type DeliveryScore =
  | { scored: true; r: number; observations: number }
  | { scored: false; reason: "unexercised"; observations: number };

/**
 * One previously registered run, as the successor's artifact must list it.
 *
 * `voidConditions` 1 makes this a VOID condition twice over: B12 may not be
 * scored while any registered run has no committed result, and "every prior run's
 * run_id and bracket is listed in the successor's summary; **omission is itself a
 * VOID**". So the register is a required argument rather than an optional one —
 * a missing field would be indistinguishable from a run with no predecessors.
 */
export type PriorResult =
  | { scored: true; bracket: { rLo: number; rHi: number } }
  | { scored: false; voidClause: string; bracket: { rLo: number; rHi: number } };

/**
 * `voidConditions` 23: a VOID CONSUMES AN ATTEMPT, except for three enumerated
 * vendor-side causes the operator cannot induce.
 *
 * A bare `false` is unrepresentable on purpose. "Every other void is an attempt,
 * or the fall condition can be dodged indefinitely by voiding until a clean set
 * lands on the preferred side" — so not consuming one must NAME which of the
 * three it was. Enumerate the good values; refuse what the rule does not name.
 */
export type AttemptCost =
  | { consumed: true }
  | { consumed: false; exempt: "auto-update" | "echo-layout-change" | "vendor-outage" };

export interface PriorRun {
  runId: string;
  /**
   * What it committed. **NULL MEANS NO COMMITTED RESULT**, which is the clause-1
   * VOID itself: a run registered and never resolved. It is also what
   * `abandonedRuns` counts, so the count on the artifact and the condition that
   * voided the run are one quantity read twice rather than two that can disagree.
   *
   * The shape carries the rest of clause 1 as a TYPE rather than as a check: a
   * result states `scored` or names its void clause, and either way it carries
   * its partial bracket. None of the three can be omitted separately.
   */
  result: PriorResult | null;
  attempt: AttemptCost;
}

/** The five recomputations `voidConditions` 18 requires beside the parent figures. */
export interface Recomputations {
  /** Largest-`A_o` task dropped. */
  rLoMinusTask: number;
  rHiMinusTask: number;
  /** Largest single credited row dropped. */
  rLoMinusRow: number;
  rHiMinusRow: number;
  /** Every dropped observation reinstated at `saved_o = 0`, its `billed_o` kept. */
  rAll: number;
}

/**
 * The three `holdsIf` 2 names, and only those three.
 *
 * LOW HORIZON ONLY, because that is what the condition asks for: "`R_lo⁻ᵗ`,
 * `R_lo⁻ʳ` and `R_all` all ≥ 30%". The two high-horizon recomputations exist for
 * `voidConditions` 18, which compares them against the PUBLISHED `R_hi` — a
 * figure the hold domain does not have. Carrying them here anyway would put two
 * numbers on the artifact that nothing reads and no rule defines, which is the
 * shape this file spends its comments refusing.
 */
export interface HoldRecomputations {
  rLoMinusTask: number;
  rLoMinusRow: number;
  rAll: number;
}

/**
 * The hold arithmetic, over the domain `admissionRule` 6 leaves it.
 *
 * **"An observation with `ambiguous > 0` is admitted to the FALL arithmetic
 * only, at both bounds, and EXCLUDED FROM THE HOLD ARITHMETIC."** So a run has
 * two domains, not one, and `B12Result`'s own `rLo`/`rHi`/`strata`/`gate` are the
 * full-admitted ones — the published bracket, which `fallsIf` reads. These are
 * the other domain, and they are the ONLY figures a hold may be built from.
 *
 * DELIBERATELY NOT SHAPED LIKE THE PUBLISHED SIDE. A symmetric pair invites a
 * reader to assume the two are interchangeable, and they are not: this side has
 * no `rHi` (nothing reads one), three recomputations rather than five, and a
 * `gate` whose EXERCISE floor was counted on the full admitted set while its
 * ratio was not. The asymmetry is the documentation.
 *
 * `eligible` and `excludedForAmbiguity` are both published because their sum is
 * the admitted count: a reader who sees `excludedForAmbiguity: 0` knows every
 * figure here equals its published twin, and a reader who sees a non-zero knows
 * they do not — which is otherwise invisible, since the two domains coincide on
 * every clean run.
 */
export interface HoldFigures {
  /** A required discriminant, so a hold figure can never be read as a published one. */
  readonly basis: "hold-eligible";
  /** Admitted observations carrying no ambiguous refusal, owned or unowned. */
  eligible: number;
  /** Admitted observations `admissionRule` 6 keeps out of this arithmetic. */
  excludedForAmbiguity: number;
  /** `holdsIf` 1's figure. There is no `rHi` here because no hold condition reads one. */
  rLo: number;
  recomputations: HoldRecomputations;
  /**
   * `holdsIf` 3's four cells: the RATIO over the hold-eligible domain, the
   * EVALUABILITY floor over the full admitted set — "≥ 5 admitted observations
   * each", repeated by `admissionRule` 8 in the same words.
   */
  strata: StrataCells;
  /** `holdsIf` 4. `repair` and `other` are absent because no hold condition reads them. */
  gate: DeliveryScore;
}

/**
 * What the verdict command emits. Owed by every registered run, scored or void.
 */
export interface B12Result {
  runId: string;
  /**
   * The bracket. Published as an interval, never as a point.
   *
   * **OVER THE FULL ADMITTED SET, INCLUDING THE OBSERVATIONS NO HOLD MAY USE.**
   * `design.metric` opens its definition "Per admitted observation `o`", and
   * `conflictsResolved` 5 records the chosen resolution as "admitted to the FALL
   * arithmetic at both bounds and excluded from the HOLD arithmetic" — so these
   * two ARE the fall side's bounds, and `fallsIf` reads `rLo` by name ("`R_lo` <
   * 30% ≤ `R_hi⁺` ... is `open`"). The hold's lower bound is a different number
   * over a different domain and lives on `hold`, because one field cannot mean
   * both and this repository has already watched two derivations of one figure
   * drift apart.
   */
  rLo: number;
  rHi: number;
  /**
   * The doubt-credited fall-side figure, over the FULL observation set.
   * Not evaluable when any refused magnitude is unsized — the run returns
   * `open` rather than falling, because a fall on a deflated instrument stops
   * the project permanently and that is the worse of the two errors.
   */
  rHiPlus: Evaluable<number>;
  /**
   * The bracket priced with NO `clientTruncationCap` — the second half of
   * `voidConditions` 8, which is VOID "if the artifact does not carry both the
   * capped and uncapped brackets".
   *
   * REPORTED, DECIDING NOTHING: its PRESENCE is the requirement. The frozen
   * bracket is `[R_lo, R_hi]` and detector 2 asks for that one bracket
   * published capped AND uncapped — not for an uncapped variant of `rHiPlus`,
   * the strata, the recomputations, the hold or the deliveries, and none
   * exists. `cappedVsUncapped` below stays what it was: a byte-sum pair on the
   * artifact's face, deciding nothing.
   */
  uncappedBracket: { rLo: number; rHi: number };
  /**
   * What the run could and could not account for, on the artifact's face.
   *
   * Published whether or not `rHiPlus` was evaluable, and especially when it was
   * not: it carries the reason. A reader can check the exactly-once claim against
   * `unownedRows` rather than taking the totals on trust.
   */
  coverage: RunTelemetryCoverage;
  /**
   * The five `voidConditions` 18 compares against `rLo` and `rHi` — so over the
   * same full admitted set those two are, or the comparison would be between a
   * recomputation and a parent from another domain. `holdsIf` 2's three are on
   * `hold.recomputations`.
   */
  recomputations: Recomputations;
  /**
   * The four cells over the FULL admitted set — `admissionRule` 8's "each of the
   * four cells reports its own bracket", and the population `voidConditions` 17
   * and `fallsIf`'s unappealed condition both read.
   *
   * `holdsIf` 3's cells are on `hold.strata` and are a different arithmetic over
   * the same evaluability. On a run with no ambiguous refusal the two are equal,
   * which is exactly why the divergence needs a control rather than a comment.
   */
  strata: StrataCells;
  /** Full admitted. `holdsIf` 4's `R_gate` is on `hold.gate`. */
  gate: DeliveryScore;
  repair: DeliveryScore;
  other: DeliveryScore;
  /**
   * The hold arithmetic, over the domain `admissionRule` 6 leaves it.
   *
   * REQUIRED, so a run cannot publish a verdict without publishing the figures
   * the verdict was built from. Equal to its published twins on every run whose
   * admitted set carries no ambiguous refusal, which is every clean run — the
   * preflight asserts `ambiguous === 0` — and different exactly when it matters.
   */
  hold: HoldFigures;
  /**
   * `sum_d numerator_d === numerator` over ONE common denominator. Ratios do
   * not otherwise sum, and the design warns that an implementer bucketing
   * `scaffold`'s rows under the nearest named delivery would decide `gate`'s
   * survival on another tool's saving.
   */
  identityHolds: boolean;
  admitted: number;
  /** Every observation the run produced, with its disposition. */
  dispositions: Array<{ taskId: string; arm: Arm; disposition: Disposition }>;
  /** Reported, deciding nothing: both instrument-bias pairs. */
  cappedVsUncapped: { capped: number; uncapped: number };
  clampedVsSigned: { clamped: number; signed: number };
  rowsNetNegative: number;
  /** BANNED as the deciding form; carried because the design says to report it. */
  meanOfPerObservationRatios: number;
  /**
   * **`open — provisional` IS A REAL STATE OF THE FROZEN DESIGN and was missing.**
   *
   * `fallsIf` names it: a fall stands unappealed only under four conditions, and
   * "otherwise the fall is `open — provisional` and requires the A/B before it may
   * be recorded as a fall". Without the member the scorer collapsed a provisional
   * fall into a plain `open`, which reads as "we measured nothing decisive"
   * instead of "we measured a fall the design will not let stand yet".
   */
  verdict:
    | "holding"
    | "holding (unvalidated)"
    | "fallen"
    | "open"
    | "open — provisional"
    | "void";
  /**
   * The void clause BY NAME, or null when the run did not void.
   *
   * `admissionRule` 1 and `voidConditions` 1 both require it on the artifact's
   * face: a run owes a result "carrying `scored` or `void`, the void clause BY
   * NAME, the observation count, and the partial bracket". A boolean would say
   * that something fired without saying what, which is the shape that makes a
   * void unfalsifiable after the fact.
   */
  voidClause: string | null;
  /**
   * The selection guard's two pairs, reported whether or not they fired.
   *
   * `voidConditions` 16 voids a run whose excluded observations outweigh its
   * admitted ones on either — summed `wouldHaveAdded` against `Σ S_o`, or
   * `gate`/`repair` call counts. `holdsIf` 5 reads the first pair as well. Both
   * are on the face because "the pool was selected on the treatment's own
   * attributability" is a claim a reader must be able to check.
   */
  selection: {
    /**
     * **WHICH SENSE OF "EXCLUDED" THESE FIVE NUMBERS WERE BUILT UNDER, ON THE
     * ARTIFACT AND NOT ONLY IN A COMMENT.**
     *
     * `voidConditions` 16 and `holdsIf` 5 compare "the EXCLUDED observations"
     * against "the ADMITTED set". Since `admissionRule` 6 an observation can be
     * admission-admitted and hold-excluded at once, and the frozen text does not
     * say which extension those comparisons take (`FINDINGS.md` F20). This label
     * is `"disposition"` because that is the reading the scorer applies — **an
     * implementation convention, not the frozen rule**, and a reader who cannot
     * see which was used cannot check the void.
     *
     * A LABEL, NOT A GUARD. It is a literal and nothing compares it; it is here so
     * the artifact carries its own basis, in the same spirit as `HoldFigures.basis`.
     * The DUAL, non-deciding figures a reader would need to recompute the other
     * reading belong to `counterfactual.json` (`design.artifacts` 7), which is
     * per-observation and which nothing writes yet — `result.json` (artifact 8)
     * has the narrower inventory and is what this type maps to.
     */
    basis: "disposition";
    /**
     * A FLOOR whenever `excludedUnsized > 0`, never a total: a null magnitude is
     * counted there and deliberately not summed here. So `excludedWouldHaveAdded
     * > admittedSumS` is sound in one direction only — it proves the guard fired,
     * and its negation proves nothing while anything is unsized.
     */
    excludedWouldHaveAdded: number;
    excludedUnsized: number;
    admittedSumS: number;
    excludedToolCalls: number;
    admittedToolCalls: number;
  };
  /** Every previously registered run. Omission is itself a VOID (`voidConditions` 1). */
  priorRuns: readonly PriorRun[];
  /** DERIVED from `priorRuns`: a committed result naming a void clause. */
  voidedRuns: number;
  /** DERIVED: registered and never resolved — the same set that fires the clause-1 VOID. */
  abandonedRuns: number;
  /** Quoted from the frozen design so the artifact carries its own standard. */
  thresholds: { hold: 0.3; fall: 0.15 };
}

// ---------------------------------------------------------------------------
// UNIT 5 — the assembler's vocabulary. `archive.ts` produces `RunArchive`;
// `assemble.ts` consumes it plus a `GitAudit` and returns the two artifacts.
// ---------------------------------------------------------------------------

/**
 * One row of `evidence/<runId>.b12.runlog.jsonl`, as written by `observe()` —
 * `design.artifacts` 10's machine-written row. The scorer replays the committed
 * order (`voidConditions` 3) from these.
 */
export interface RunlogRow {
  ts: string;
  runId: string;
  taskId: string;
  arm: string;
  sessionId: string;
  outcome: string;
  valid: boolean;
  accepted: boolean | null;
  originated: number;
}

/**
 * One task of the sealed manifest, as the SCORER reads it. Fields are nullable
 * as-read: the harness refuses an incomplete manifest before spending anything
 * (`manifestDeclarationGaps`), but the scorer runs over a committed archive that
 * may be hostile, and a missing declaration at THIS layer is `FINDINGS.md` F25 —
 * reported, never defaulted, never a minted disposition.
 */
export interface ManifestTask {
  id: string;
  promptSha256: string | null;
  baseCommit: string | null;
  verificationStratum: string | null;
  expectedSubagentStratum: string | null;
  acceptance: string[] | null;
  acceptanceExpectedExit: number | null;
  verificationCommands: string[] | null;
  gateCategory: string | null;
  repairMaxRounds: number | null;
  fileScope: string[] | null;
}

/** The sealed manifest, narrowed to what scoring reads. `raw` is the whole parse. */
export interface RunManifest {
  runId: string;
  /** The ORDERED task list — the committed order `voidConditions` 3 protects. */
  tasks: ManifestTask[];
  /** Run-level pins (`design.artifacts` 1): version, binary sha, rates sha, caps… */
  pinned: Record<string, unknown>;
  abPairs: unknown;
  raw: unknown;
}

/** A pre/post-observation snapshot, as archived. `requestIds` is the full list. */
export interface SnapshotFacts {
  ts: string | null;
  /**
   * WHOSE snapshot this is — stamped by the harness since the R7 debt closed,
   * and CHECKED by the archive reader against the directory, the record and
   * the run: a stamp that disagrees is cross-wired evidence (`identityIntact`
   * false, terms refused); a stamp that is absent is a reported problem,
   * because stripping the stamp is a swapper's cheapest move.
   */
  identity: {
    runId: string | null;
    taskId: string | null;
    arm: string | null;
    sessionId: string | null;
    phase: string | null;
  } | null;
  slugsWalked: number | null;
  files: number | null;
  requestIds: string[];
}

/**
 * The scorer-read subset of `observation.json`, one field per frozen consumer.
 * Nullable as-read — see `ManifestTask`. `installedChars` keeps the harness's
 * own two shapes: a value WITH provenance on the treatment arm, a NAMED absence
 * on control (never 0 — one `O_o`, `PREMISES.md § B12`).
 */
export interface ObservationRecord {
  taskId: string;
  arm: string;
  sessionId: string;
  runId: string | null;
  /** The PRE-execution timestamp — what "the earliest session start" means.
   * The runlog row's `ts` is written at observation END and anchoring the
   * manifest-freeze window there left a gap the length of the session. */
  started: string | null;
  outcome: string | null;
  valid: boolean | null;
  invalidReasons: string[];
  censored: boolean | null;
  originatedRequestIds: string[];
  accepted: boolean | null;
  acceptanceExpectedExit: number | null;
  baseCommit: string | null;
  endCommit: string | null;
  treeHashAtStart: string | null;
  binaryVersion: string | null;
  binarySha256: string | null;
  mcpConfigPassedSha256: string | null;
  mcpConfigPinned: string | null;
  policyBlobSha256: string | null;
  installedChars:
    | { value: number; adapter?: string; probeRunId?: string }
    | { value: null; reason: string }
    | null;
  memorySnapshotSha256: string | null;
  /** The seven components, hashed pre and post — `design.covariates` 11. */
  instructionHashes: { pre: Record<string, string | null>; post: Record<string, string | null> } | null;
}

/**
 * One archived observation directory (`evidence/<runId>/obs-<taskId>-<arm>[-rN]/`),
 * read back as a value.
 *
 * `identified` is stamped by `archive.ts`, ONCE, with the repo-relative
 * `telemetry.jsonl` path as `source` — there is no run-level log, the archive
 * path IS the identity source (UNIT-5.md step 2, corrected), and nothing
 * downstream may re-identify a slice.
 *
 * `transcript` is the FULL lineage rebuilt from `archive.json`'s reduced
 * records through `transcriptFromRecords` — the parser's own pure half, fed
 * from the archive instead of from files. Null when the lineage cannot be
 * rebuilt, with the reason in `problems`.
 */
export interface ArchivedObservation {
  taskId: string;
  arm: string;
  /** 1 for `obs-<t>-<arm>`, N for `obs-<t>-<arm>-rN` (`admissionRule` 12). */
  attempt: number;
  /** Repo-relative directory. */
  dir: string;
  /**
   * FALSE the moment the identity source is suspect — a corrupt line, a
   * missing `telemetry.jsonl`, or drift between it and `archive.json`'s copy.
   * A row from a tampered source may not price ANY observation, so `assemble`
   * refuses terms for this observation and fires an integrity check instead of
   * scoring the surviving subset (the diff review's third finding).
   */
  telemetryIntact: boolean;
  /**
   * FALSE the moment the evidence's own identity does not bind to the
   * directory it was scored from — `observation.json` or `archive.json` naming
   * another task, arm, run or session, or carrying no identity to check. The
   * directory name decides WHICH manifest task the evidence is priced under,
   * so cross-wired or copied evidence would apply one task's acceptance and
   * telemetry to another; `assemble` refuses terms instead (the fifth diff
   * round's first finding).
   */
  identityIntact: boolean;
  /**
   * FALSE when `git status` shows any of this observation's files differing
   * from HEAD — positive evidence the replay is not reading the committed
   * archive, handled like tampering (no terms). NULL when committedness could
   * not be shown at all (no repository); the run-level check still fires, but
   * absence of proof is not proof of tampering, so terms are still computed
   * and published under the void.
   */
  evidenceCommitted: boolean | null;
  record: ObservationRecord | null;
  /** `archive.json`'s lineage records, flat, in file order — for predicates that
   * need raw content (instrument-write detection reads tool_use inputs). */
  lineageRecords: unknown[];
  lineageFiles: string[];
  transcript: import("../transcript.js").Transcript | null;
  identified: IdentifiedRow[];
  telemetrySource: string;
  invocationIds: string[];
  snapshotBefore: SnapshotFacts | null;
  snapshotAfter: SnapshotFacts | null;
  problems: string[];
}

/** The register `voidConditions` 1 reads, plus what the cross-check could not reconcile. */
export interface RunRegister {
  priorRuns: PriorRun[];
  /** Manifests with no MEASUREMENTS row, rows with no manifest — reported, per
   * clause 1's CONJUNCTIVE registration ("committed AND … by the same command"). */
  discrepancies: string[];
}

/**
 * Facts only git can answer, collected by the impure layer and consumed as
 * VALUES by `assemble` — the same boundary the spec draws for the clause 4–6
 * audit. Null with a problem when git was unavailable.
 */
export interface RunGitFacts {
  /** `HEAD:evidence/<runId>.b12.tasks.json`, for artifact 1's blob-hash-in-summary. */
  manifestBlobSha256: string | null;
  /**
   * Whether the manifest BYTES being scored are HEAD's — a blob existing at
   * the path proves nothing about the bytes that were parsed (the second
   * diff-round finding). Null when git could not answer.
   */
  manifestMatchesHead: boolean | null;
  /**
   * Commits touching the manifest dated after the earliest session start —
   * artifact 1 voids on any. NULL when the freeze window could not be
   * established (no trustworthy start, or git could not answer): fail CLOSED —
   * the artifact-1 check fires on null, because a freeze that cannot be shown
   * held is not a freeze.
   */
  manifestCommitsAfterStart: string[] | null;
  /** The rates blob at the frozen commit `3541625`, for `voidConditions` 4's byte-identity. */
  ratesSha256AtFrozenCommit: string | null;
  problems: string[];
}

/**
 * Whether the scoring input set on disk IS the committed evidence. The commit
 * barrier proves the original WRITE; nothing before this proved the REPLAY
 * reads the same bytes (the first diff-round finding). `dirty` lists every
 * path `git status` shows as differing from HEAD — modified, staged or
 * untracked alike; `unshowable` means git could not answer (scoring outside a
 * repository), which is never read as clean.
 */
export interface CommittedEvidenceState {
  state: "clean" | "dirty" | "unshowable";
  dirty: string[];
}

/**
 * Everything scoring reads, as one value. Produced by `archive.ts` (impure),
 * consumed by `assemble.ts` (pure). Hostile-disk findings land in `problems`
 * (run-level) and per-observation `problems` — reported, never thrown: the
 * result artifact is owed whatever the archive looks like (`admissionRule` 1).
 */
export interface RunArchive {
  runId: string;
  manifest: RunManifest;
  /** sha256 of the manifest bytes as read from disk. */
  manifestSha256: string;
  observations: ArchivedObservation[];
  runlog: { rows: RunlogRow[]; corruptLines: number };
  /** Loaded rates with the manifest's measured `clientTruncationCap` overlaid. */
  rates: import("../rates.js").Rates;
  /** sha256 of the rates bytes as read — compared against the manifest pin AND
   * the frozen-commit blob (`voidConditions` 4). */
  ratesSha256: string;
  git: RunGitFacts;
  register: RunRegister;
  /** The whole scoring input set — manifest, runlog, observation dirs — against HEAD. */
  evidenceCommitted: CommittedEvidenceState;
  problems: string[];
}

/**
 * The clause 4–6 audit, taken as an INPUT — the spec's own boundary: those
 * clauses are facts about git history, not about the archive. Its verdict AND
 * inputs are published on the result face so `design.artifacts` 11 can replay
 * the decision; `{ran: false}` is NEVER read as "passed" — the clauses it
 * covers appear in `uncheckedClauses` and the pre-declaration
 * (`PREMISES.md § B12`) bars a final verdict without a committed audit.
 */
export type GitAudit =
  | { ran: true; verdict: "clean" | "void"; reasons: string[]; inputs: Record<string, string> }
  | { ran: false };

/** One archive-level clause check, on the artifact's face whether or not it fired. */
export interface ArchiveCheck {
  clause: string;
  fired: boolean;
  detail: string;
}

/** A task/arm the frozen text gives NO disposition for — `FINDINGS.md` F25. */
export interface DeclarationFailure {
  taskId: string;
  arm: string;
  attempt: number;
  reasons: string[];
}

/**
 * One observation of `evidence/<runId>.b12.counterfactual.json` —
 * `design.artifacts` 7's inventory, per observation.
 *
 * `instructionComponents` are the SEVEN components pre/post, never an
 * aggregate: the VOID-21 composition is unadjudicated and minting a canonical
 * instruction-set hash was declined (`FINDINGS.md` F24) — `aggregateHash`
 * carries that absence as a named fact instead of a value.
 */
export interface CounterfactualObservation {
  taskId: string;
  arm: string;
  attempt: number;
  disposition: Disposition;
  /** Every disposition predicate that matched, not only the named one — the
   * precedence is a REGISTERED CONVENTION and this is what makes it checkable. */
  firedPredicates: string[];
  aO: number;
  sLo: number;
  sHi: number;
  /** Treatment: the calibrated value. Control: the named absence. */
  oO: number | { value: null; reason: string };
  /** `A_o + S_o > 0`, asserted per admitted observation and REPORTED, deciding
   * nothing (`PREMISES.md § B12`). Null on a non-admitted observation. */
  aPlusSPositive: boolean | null;
  rows: KeyedRow[];
  refusals: RefusalLedger;
  unattributedRefusals: RefusalLedger;
  subagentShare: Evaluable<SubagentShare>;
  requestsPerSegment: Array<{ thread: string; segment: number; requests: number }>;
  rateKeys: string[];
  perTaskDenominatorShare: number | null;
  binaryVersion: string | null;
  binarySha256: string | null;
  baseCommit: string | null;
  endCommit: string | null;
  treeHashAtStart: string | null;
  instructionComponents: ObservationRecord["instructionHashes"];
  aggregateHash: { absent: true; reason: string };
  memorySnapshotSha256: string | null;
  mcpConfigPinned: string | null;
  mcpConfigPassed: string | null;
  /** F20's dual reporting: what a reader needs to recompute `voidConditions` 16
   * under the other reading of "excluded". */
  holdExcluded: boolean;
  gateRepairCalls: number;
  wouldHaveAddedSum: number;
  wouldHaveAddedUnsized: number;
}

/** `evidence/<runId>.b12.counterfactual.json` — `design.artifacts` 7. */
export interface B12Counterfactual {
  schema: "b12-counterfactual/1";
  runId: string;
  observations: CounterfactualObservation[];
  declarationFailures: DeclarationFailure[];
}

/**
 * `evidence/<runId>.b12.result.json` — `design.artifacts` 8, which is
 * `B12Result` plus the archive-level face UNIT 5 adds: the clause checks, the
 * audit, the registered conventions' labels, and the id set `voidConditions` 19
 * compares. When an archive-level clause fires, `verdict`/`voidClause` here
 * OVERRIDE `aggregate()`'s — a void the arithmetic cannot see is still a void.
 */
export interface B12RunResult extends B12Result {
  schema: "b12-result/1";
  manifestSha256: string;
  manifestBlobSha256: string | null;
  archiveChecks: ArchiveCheck[];
  /** Clauses no input allowed anyone to check — 4–6 while `gitAudit.ran` is false.
   * NEVER empty silently: an unchecked clause published as no-void is the shape
   * `voidConditions` 8's handling refuses one clause over. */
  uncheckedClauses: string[];
  gitAudit: GitAudit;
  declarationFailures: DeclarationFailure[];
  /**
   * Observations whose ARCHIVE is untrustworthy — telemetry corrupt, drifted
   * or missing. No terms are computed from a suspect identity source; the
   * matching archive check fires, so the run voids rather than scoring a
   * surviving subset. Same shape as a declaration failure, different cause.
   */
  integrityFailures: DeclarationFailure[];
  /** The registered convention the disposition names were picked under. */
  dispositionPrecedence: string;
  /** `voidConditions` 19: the id set the ambiguity check saw, sorted. */
  ambiguityIdSet: string[];
  scoringCommand: { pinned: string | null; actual: string | null };
  /** `admissionRule` 12's re-runs: every attempt reported, the scored one named
   * (the LAST — a registered convention; the frozen text does not say which). */
  reruns: Array<{ taskId: string; arm: string; attempts: number; scoredAttempt: number }>;
  archiveProblems: string[];
}
