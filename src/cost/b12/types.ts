/**
 * The vocabulary of B12's scorer. TYPES ONLY — no arithmetic lives here.
 *
 * This file exists so the three units under `src/cost/b12/` agree about what
 * they are passing each other before any of them is implemented, and so `tsc`
 * enforces that agreement while the bodies are still `throw`. It sits under
 * `src/` on purpose: `tsconfig.json` covers `src/**` alone, so a scoring type
 * defined in `scripts/` or `tests/` would be checked by nothing, and this
 * repository already put `contract-probe.ts` here for exactly that reason.
 *
 * Two shapes below encode a rule rather than a value, and both are deliberate:
 * `Evaluable<T>` makes "not evaluable" unrepresentable as a number, and
 * `DeliveryScore` makes `unexercised` unrepresentable as zero. The frozen design
 * forbids both collapses by name, and a type is the only place a prohibition
 * cannot be forgotten.
 */

import type { CreditedRow } from "../report.js";

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
  /** This window's rows, credited and refused, for the artifact's face. */
  rows: CreditedRow[];
  /** Refused rows this window OWNS — their `invocationId` is one of its own. */
  refusals: RefusalLedger;
  /**
   * Refused rows in this observation's telemetry slice that belong to NO window:
   * `invocationId` null, or an id this window does not own.
   *
   * WITHOUT THIS, TWO OF THE FOUR CLASSES ARE STRUCTURALLY EMPTY AND `R_hi+` IS
   * DEFLATED TOWARD THE FALL LINE. An `unverifiable` row is refused precisely
   * because it has no `invocation_id`, so it can never be in any window's owned
   * set; an `excludedForeign` row is refused precisely because its id is absent
   * from this transcript, which is where owned ids come from. A ledger built
   * only from owned rows can hold `ambiguous` and `unmatched` and nothing else,
   * while the frozen metric defines `R_hi+` over ALL FOUR — so the fall-side
   * figure was short by construction, and the whole point of `R_hi+` is that a
   * fall must survive the most generous arithmetic the data admits.
   *
   * IT MAY DOUBLE-COUNT, AND THAT IS THE SAFE DIRECTION. `admissionRule` 5 says
   * `scopeTelemetry`'s ±60,000 ms window pulls a neighbouring arm's rows in
   * whenever two sessions run within a minute, so one such row can appear in two
   * observations' slices. Over-crediting `refused` moves
   * `(S + refused - O) / (A + S + refused)` UP, and `R_hi+` gates only the fall
   * — it can prevent one and can never manufacture a hold. Omission is the error
   * that stops the project; duplication is not.
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
