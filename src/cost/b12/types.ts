/**
 * The vocabulary of B12's scorer. TYPES ONLY — no arithmetic lives here.
 *
 * This file exists so the three units under `src/cost/b12/` agree about what
 * they are passing each other before any of them is implemented, and so `tsc`
 * enforces that agreement while the bodies are still `throw`. It sits under
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

/** The four cells `holdsIf` 3 requires to be evaluable and on one side of 30%. */
export interface StrataCells {
  testRed: Evaluable<number>;
  typesOnly: Evaluable<number>;
  solo: Evaluable<number>;
  multi: Evaluable<number>;
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
   * A DIAGNOSTIC THAT DECIDES NOTHING. It is filled in the same pass as
   * `unattributed` — one loop, one rule, so the two cannot drift — and no figure
   * reads it. It used to be what `rHiPlus` summed, which is the defect F12
   * records: summing a per-observation total of rows no observation owns
   * double-counts every row two slices share.
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
 * What the verdict command emits. Owed by every registered run, scored or void.
 */
export interface B12Result {
  runId: string;
  /** The bracket. Published as an interval, never as a point. */
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
   * What the run could and could not account for, on the artifact's face.
   *
   * Published whether or not `rHiPlus` was evaluable, and especially when it was
   * not: it carries the reason. A reader can check the exactly-once claim against
   * `unownedRows` rather than taking the totals on trust.
   */
  coverage: RunTelemetryCoverage;
  recomputations: Recomputations;
  strata: StrataCells;
  gate: DeliveryScore;
  repair: DeliveryScore;
  other: DeliveryScore;
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
  verdict: "holding" | "holding (unvalidated)" | "fallen" | "open" | "void";
  /** Quoted from the frozen design so the artifact carries its own standard. */
  thresholds: { hold: 0.3; fall: 0.15 };
}
