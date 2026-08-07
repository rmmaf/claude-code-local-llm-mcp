/**
 * UNIT 3 — the pooled bracket, the per-delivery split, and the guards.
 *
 * RATIO OF SUMS, ALWAYS. `saved_o / billed_o` per observation, and the mean of
 * per-observation ratios, are BANNED BY NAME as the deciding form. The mean is
 * computed and reported here anyway, because the design says to publish it — and
 * publishing a number that decides nothing is only safe while nothing reads it,
 * so it is carried in a field whose name says what it is.
 */

import type { CreditedRow } from "../report.js";
import { partitionByStrata } from "./strata.js";
import type {
  B12Result,
  DeliveryScore,
  Evaluable,
  HoldFigures,
  HoldRecomputations,
  ObservationTerms,
  PriorRun,
  Recomputations,
  RunTelemetryCoverage,
  StrataCells,
} from "./types.js";

/**
 * A delivery is scored only above this many admitted observations carrying its
 * rows. Below it the delivery is `unexercised`, which is neither a hold nor a
 * fall and is NOT zero. Inherited from B20's set floor rather than minted here.
 */
export const MIN_DELIVERY_OBSERVATIONS = 5;

/**
 * `repair` carries a second condition on top of the floor: at least this many of
 * its observations must have closed. `turns_collapsed` is `rounds.length`
 * whether or not the failure closed, so an unconditioned `R_repair` is maximised
 * by `repair` flailing for its full round budget and returning red — a repair
 * that did not close the failure did not collapse the turns that would have.
 *
 * OBSERVATIONS, NOT ROWS, and it is counted off `DeliveryTerms.closures`. This
 * constant named a quantity nothing carried until `CreditedRow.passed` existed;
 * a floor that cannot be computed is not a floor.
 */
export const MIN_REPAIR_CLOSURES = 2;

/**
 * EXACTLY this many admitted observations, not at least.
 *
 * `voidConditions` 3 voids a run with fewer, and `admissionRule` 2 fixes the
 * other side: the manifest orders 30 tasks and "the first 20 that admit, in that
 * committed order, are scored", so 30 is HEADROOM and not a licence to score 25.
 * This function cannot see the committed order, so a caller handing it more than
 * 20 has already made the selection the rule reserves to the manifest — and that
 * is refused rather than silently truncated here.
 *
 * **Nothing enforced either side until 2026-08-07**: the verdict checked no count
 * at all, so a three-observation run could have returned `fallen`.
 */
export const ADMITTED_OBSERVATIONS = 20;

/** The frozen thresholds, as bands, so "the same band" has one definition. */
const bandOf = (r: number): "below" | "middle" | "above" =>
  r < 0.15 ? "below" : r < 0.3 ? "middle" : "above";

/** The two deliveries whose call counts `voidConditions` 16 compares. */
const TOOL_CALL_NAMES = new Set(["gate", "repair"]);

/** The four class names, in one place, so no figure is built from three. */
const CLASSES = ["ambiguous", "unverifiable", "excludedForeign", "unmatched"] as const;

/**
 * `admissionRule` 6's `ambiguous`, counted the way the shipped instrument counts it.
 *
 * **BOTH LEDGERS, AND THE OWNED ONE ALONE IS NOT ENOUGH.** `admissionRule` 5 pins
 * the meaning to `report.ts` by file and line — "`savedFraction` is withheld iff
 * `provenanceUnavailable || ambiguous > 0`" — and that counter is incremented for
 * every telemetry row whose id is ambiguous, BEFORE any ownership is decided.
 * Ownership is imposed later, in `computeTerms`, which is where one count becomes
 * two ledgers. So an observation all of whose ambiguous rows are unowned still had
 * `ambiguous > 0` in its report, still withheld its `savedFraction`, and is still
 * the observation clause 6 keeps out of the hold. `FINDINGS.md` F19 proposed the
 * owned ledger alone and would have missed exactly that case.
 *
 * SUMMING TWO COUNTS ON ONE OBSERVATION IS NOT THE F12 DOUBLE-COUNT. That defect
 * was adding per-observation totals ACROSS observations, where a row two slices
 * share is added twice. Here the question is asked once per observation and the
 * answer is a boolean; a shared ambiguous row makes it true for both, which is
 * right, because both reports withheld.
 */
const ambiguousCount = (t: ObservationTerms): number =>
  t.refusals.ambiguous.count + t.unattributedRefusals.ambiguous.count;

const sumOf = <T>(xs: readonly T[], f: (x: T) => number): number =>
  xs.reduce((total, x) => total + f(x), 0);

const savedAt = (t: ObservationTerms, horizon: "lo" | "hi"): number =>
  horizon === "lo" ? t.sLo : t.sHi;

/** Every credited row on these observations, paired with the index that owns it. */
function creditedRows(
  terms: readonly ObservationTerms[]
): Array<{ owner: number; row: CreditedRow & { disposition: "credited" } }> {
  const out: Array<{ owner: number; row: CreditedRow & { disposition: "credited" } }> = [];
  terms.forEach((t, owner) => {
    // `t.rows` is keyed since the run-level ledger landed; the key is identity
    // for `runCoverage` and nothing here ranks or sums by it.
    for (const { row } of t.rows) {
      if (row.disposition !== "credited") continue;
      out.push({ owner, row });
    }
  });
  return out;
}

/**
 * The pooled ratio: `(sum S - sum O) / (sum A + sum S)`.
 *
 * One function for every ratio in the artifact — pooled, per stratum, per
 * delivery and every recomputation — because the alternative is the same
 * arithmetic written six times, and this repository has already watched two
 * numbers derived from one rule drift apart.
 *
 * `horizon: "lo"` sums `sLo` (every row at the write component alone);
 * `"hi"` sums `sHi` (the observed segment). Nothing is clamped and the result
 * may be negative — on the only live reading this project has, `gate` came back
 * at -467.1 units.
 */
export function poolRatio(terms: readonly ObservationTerms[], horizon: "lo" | "hi"): number {
  const S = sumOf(terms, (t) => savedAt(t, horizon));
  const A = sumOf(terms, (t) => t.aO);
  const O = sumOf(terms, (t) => t.oO);
  // An empty set has no ratio, and NaN propagates into every figure downstream.
  if (A + S === 0) return 0;
  return (S - O) / (A + S);
}

/**
 * The doubt-credited fall-side figure, over the FULL observation set — admitted
 * and excluded alike — granting every refused row its measured magnitude across
 * all four classes.
 *
 * NOT EVALUABLE the moment any class reports `unsized > 0`. An unknown may not
 * be summed as zero, and the run returns `open` rather than falling: a fall on a
 * deflated instrument stops the project permanently, which is strictly the worse
 * of the two errors.
 *
 * OWNED REFUSALS PER OBSERVATION, UNOWNED ONES FROM THE RUN LEDGER, so each
 * physical row enters exactly once. `unverifiable` rows can never belong to a
 * window and `excludedForeign` rows do not on any normal input, so they reach
 * here through `coverage.unowned` — and a figure summed from `refusals` alone is
 * missing most of two of the four classes it claims to cover.
 *
 * **`unattributedRefusals` IS NOT SUMMED HERE, AND THAT IS THE F12 FIX.** It is a
 * per-observation TOTAL of rows no observation owns, and `scopeTelemetry` admits
 * a row on a ±60,000 ms window as well as on an exact id match, so adding those
 * totals across observations counted every row two slices share twice.
 * `wouldHaveAdded` is signed, so a duplicated negative magnitude pushed this
 * figure DOWN, toward a fall the data does not support.
 *
 * **The old step 1b — refuse on a negative unattributed class sum — is GONE with
 * the sum it guarded.** It was declared incomplete the day it was written (a
 * class sum of zero hides a +100 and a -100), and a guard standing over a
 * quantity nothing computes any more reads as protection while providing none.
 */
export function rHiPlus(
  all: readonly ObservationTerms[],
  coverage: RunTelemetryCoverage
): Evaluable<number> {
  for (const t of all) {
    for (const name of CLASSES) {
      if (t.refusals[name].unsized > 0) {
        return {
          evaluable: false,
          reason: `${t.taskId}/${t.arm}: ${t.refusals[name].unsized} owned ${name} refusal(s) could not be sized, and an unknown may not be summed as zero`,
        };
      }
    }
  }
  // EVERY RUN-LEVEL CAUSE IN ONE PLACE. A row counted twice, a row counted zero
  // times, a row nobody could size, and a credited row no window owns are the
  // same failure at this level: the run cannot enumerate the set this figure is
  // defined over. `coverage.reasons` carries each one in its own sentence, and
  // the first is reported rather than a count, because a reason a reader cannot
  // act on is a number.
  const blocked = coverage.reasons[0];
  if (blocked !== undefined) return { evaluable: false, reason: blocked };

  const refused =
    sumOf(all, (t) => sumOf(CLASSES, (name) => t.refusals[name].units)) +
    sumOf(CLASSES, (name) => coverage.unowned[name].units);
  const S = sumOf(all, (t) => t.sHi);
  const A = sumOf(all, (t) => t.aO);
  const O = sumOf(all, (t) => t.oO);
  const denominator = A + S + refused;
  if (denominator === 0) return { evaluable: true, value: 0 };
  return { evaluable: true, value: (S + refused - O) / denominator };
}

/**
 * The five recomputations. **Only the 15% line voids.**
 *
 * `voidConditions` 18: a recomputation on the opposite side of 15% from its
 * parent is VOID; across 30% the run returns `open` with both figures recorded
 * and does NOT consume the attempt cap — "a run producing two defensible numbers
 * straddling the hold line has measured something". This comment said "both
 * thresholds", which would have voided runs the design deliberately keeps.
 *
 * Two are CONCENTRATION guards (drop the best task, drop the best row) and one
 * is a DILUTION guard (`rAll` reinstates every dropped observation at
 * `saved_o = 0` with its `billed_o` still in the denominator). The source
 * designs all carried the first kind and none carried the second, so discarding
 * a zero-saving observation tripped nothing.
 *
 * THE ROW GUARD RANKS PER HORIZON. `holdsIf` 2 asks a hold to survive deleting
 * "its best row" — the low figure's for `rLoMinusRow` (`unitsLo`), the high
 * figure's for `rHiMinusRow` (`units`). One shared ranking would make the
 * low-side guard a statement about the high side, and it would still produce a
 * number, which is how a wrong guard reads as a passed one.
 */
export function recompute(
  admitted: readonly ObservationTerms[],
  dropped: readonly ObservationTerms[]
): Recomputations {
  const minusTask = withoutLargestTask(admitted);
  return {
    rLoMinusTask: poolRatio(minusTask, "lo"),
    rHiMinusTask: poolRatio(minusTask, "hi"),
    rLoMinusRow: poolRatio(withoutLargestRow(admitted, "lo"), "lo"),
    rHiMinusRow: poolRatio(withoutLargestRow(admitted, "hi"), "hi"),
    rAll: poolRatio(reinstate(admitted, dropped), "lo"),
  };
}

/**
 * The same three guards `holdsIf` 2 asks for, over the hold domain.
 *
 * **`reinstated` IS NOT THE SAME SET `recompute` GETS, AND THAT IS THE POINT.**
 * `holdsIf` 2 wants a hold to survive "reinstating everything it dropped", and
 * `admissionRule` 3 shows the design using "dropped" to mean dropped FROM THE HOLD
 * ARITHMETIC rather than dropped from the run — a `void(task_failed)` observation
 * is "dropped from the hold arithmetic ... and reinstated at `saved_o = 0` in the
 * mandatory `R_all` recomputation". `admissionRule` 6 drops the ambiguous-bearing
 * observation from that same arithmetic, so the dilution guard has to see it too.
 *
 * The alternative — leaving it out of the hold entirely, `A_o` and all — takes a
 * billed denominator off the hold side and can only make a hold EASIER. That is
 * the direction a guard named for dilution must not move.
 *
 * Shares `withoutLargestTask` and `withoutLargestRow` with `recompute` rather than
 * restating them: two derivations of one rule is what this repository has already
 * watched drift.
 */
function holdRecompute(
  eligible: readonly ObservationTerms[],
  reinstated: readonly ObservationTerms[]
): HoldRecomputations {
  return {
    rLoMinusTask: poolRatio(withoutLargestTask(eligible), "lo"),
    rLoMinusRow: poolRatio(withoutLargestRow(eligible, "lo"), "lo"),
    rAll: poolRatio(reinstate(eligible, reinstated), "lo"),
  };
}

/** The concentration guard's first form: the largest `A_o` deleted. */
function withoutLargestTask(terms: readonly ObservationTerms[]): ObservationTerms[] {
  if (terms.length === 0) return [];
  let worst = 0;
  terms.forEach((t, i) => {
    if (t.aO > (terms[worst]?.aO ?? -Infinity)) worst = i;
  });
  return terms.filter((_, i) => i !== worst);
}

/** The set with one row's contribution removed from the observation that owns it. */
function withoutLargestRow(
  terms: readonly ObservationTerms[],
  horizon: "lo" | "hi"
): ObservationTerms[] {
  const rows = creditedRows(terms);
  const magnitude = (r: (typeof rows)[number]): number =>
    horizon === "lo" ? r.row.unitsLo : r.row.units;
  if (rows.length === 0) return [...terms];
  let best = 0;
  rows.forEach((r, i) => {
    const incumbent = rows[best];
    if (incumbent !== undefined && magnitude(r) > magnitude(incumbent)) best = i;
  });
  const chosen = rows[best];
  if (chosen === undefined) return [...terms];
  return terms.map((t, i) =>
    i !== chosen.owner
      ? t
      : horizon === "lo"
        ? { ...t, sLo: t.sLo - chosen.row.unitsLo }
        : { ...t, sHi: t.sHi - chosen.row.units }
  );
}

/** The dilution guard: every excluded observation back, at NO saving, billing intact. */
function reinstate(
  kept: readonly ObservationTerms[],
  excluded: readonly ObservationTerms[]
): ObservationTerms[] {
  return [...kept, ...excluded.map((t) => ({ ...t, sLo: 0, sHi: 0 }))];
}

/**
 * The two sets a delivery figure is built from, which `admissionRule` 6 split apart.
 *
 * BOTH REQUIRED AND NEITHER DEFAULTS TO THE OTHER. On the published face they are
 * the same set and passing it twice looks redundant; on the hold side they are
 * not, and a parameter that quietly fell back to its sibling would be the exact
 * silent-domain error this shape exists to make impossible.
 */
export interface DeliveryPopulations {
  /**
   * Decides `unexercised` and the closure floor. FULL ADMITTED, because
   * `design.metric` words it that way — "A delivery with fewer than 5 ADMITTED
   * observations carrying its rows is `unexercised`" — and clause 6 leaves such an
   * observation admitted. A window whose telemetry carries a `gate` row exercised
   * `gate`, whatever its refusals say about who owns the saving.
   */
  exercise: readonly ObservationTerms[];
  /**
   * The domain the ratio is computed over: full admitted for the published face,
   * hold-eligible for `holdsIf` 4's `R_gate`.
   */
  arithmetic: readonly ObservationTerms[];
}

/**
 * One delivery's figure over the COMMON denominator.
 *
 * ONE SHARED DENOMINATOR, with the numerator partitioned by the telemetry `tool`
 * field. Fixed in writing before any `R` exists, because the design warns that
 * an implementer's natural alternative — bucketing `scaffold`'s rows under the
 * nearest named delivery — would decide `gate`'s survival on another tool's
 * saving.
 *
 * **THE DESIGN'S `sum_d R_d + R_other = R` IS FALSE AND THIS COMMENT USED TO
 * REPEAT IT.** `sum_d R_d = S/(A+S)` while `R = (S-O)/(A+S)`, so they differ by
 * `O/(A+S)` on every run whose installation term is non-zero — which `holdsIf` 6
 * requires for every observation. Build the shared denominator anyway, and let
 * `B12Result.identityHolds` come out false: it says "compute it; do not assume
 * it". Allocating `O` across deliveries is a design decision nobody has made.
 * `FINDINGS.md` F11.
 *
 * **TWO POPULATIONS, AND COLLAPSING THEM SILENTLY MOVES A FROZEN FLOOR.** See
 * `DeliveryPopulations`: `unexercised` is defined over ADMITTED observations and
 * the ratio the hold reads is not. Passing the hold-eligible set for both — the
 * obvious implementation of `admissionRule` 6 — would quietly redefine
 * `unexercised` as "fewer than 5 hold-eligible", which the design does not say
 * and which turns an ambiguous refusal into evidence that a tool was never run.
 */
export function deliveryScore(
  pop: DeliveryPopulations,
  tools: readonly string[],
  horizon: "lo" | "hi",
  minClosures?: number
): DeliveryScore {
  const terms = pop.arithmetic;
  const bucketsOf = (t: ObservationTerms) =>
    tools.map((tool) => t.perDelivery[tool]).filter((b) => b !== undefined);
  const carrying = pop.exercise.filter((t) => bucketsOf(t).some((b) => b.rowCount > 0));

  // `unexercised` is a THIRD STATE and carries no `r` at all: a delivery nobody
  // exercised has not failed to pay for itself, it has not been asked, and a 0
  // would put it under 15% and fire the stopping criterion on an absence.
  if (carrying.length < MIN_DELIVERY_OBSERVATIONS) {
    return { scored: false, reason: "unexercised", observations: carrying.length };
  }
  if (minClosures !== undefined && minClosures > 0) {
    // OBSERVATIONS, not rows: `holdsIf` says "at least two of THOSE", so one
    // window that closed twice is one closure. `closureUnknown` counts toward
    // neither side, which can only push this floor toward `unexercised`.
    const closed = carrying.filter((t) => bucketsOf(t).some((b) => b.closures > 0));
    if (closed.length < minClosures) {
      return { scored: false, reason: "unexercised", observations: carrying.length };
    }
  }

  const numerator = sumOf(terms, (t) =>
    sumOf(bucketsOf(t), (b) => (horizon === "lo" ? b.sLo : b.sHi))
  );
  const A = sumOf(terms, (t) => t.aO);
  const S = sumOf(terms, (t) => savedAt(t, horizon));
  return {
    scored: true,
    r: A + S === 0 ? 0 : numerator / (A + S),
    observations: carrying.length,
  };
}

export interface AggregateInput {
  runId: string;
  /** Observations whose disposition is `scored`. */
  admitted: readonly ObservationTerms[];
  /** Everything else the run produced, needed for `rHiPlus` and `rAll`. */
  dropped: readonly ObservationTerms[];
  /**
   * `runCoverage(universe, [...admitted, ...dropped])` — the exactly-once ledger.
   *
   * A RUN-LEVEL ARGUMENT, because the defect is run-level. No function taking one
   * observation at a time can see that a row sits in two slices, or that a
   * credited row sits in none; `computeTerms` is handed one observation and
   * `rHiPlus` is handed totals. Built by the caller because only the caller reads
   * the telemetry artifact, which is the same reason `ambiguousIds` is passed in
   * rather than derived.
   */
  coverage: RunTelemetryCoverage;
  /**
   * Every previously registered run, in registration order.
   *
   * REQUIRED, not optional, and an empty array is a claim rather than a default:
   * `voidConditions` 1 makes omitting the register **itself a VOID**, so a field
   * the caller could leave off would be indistinguishable from a first run. The
   * scorer can check that a register was supplied and that every entry carries a
   * committed result; it cannot check that the register is complete, and that
   * limit is stated rather than papered over.
   */
  priorRuns: readonly PriorRun[];
}

/**
 * The selection guard's two pairs — `voidConditions` 16 and `holdsIf` 5.
 *
 * `excludedWouldHaveAdded` sums the four classes of the DROPPED observations'
 * OWNED ledgers. The unowned ledger is run-level and belongs to neither side, so
 * folding it in here would attribute rows nobody could attribute.
 *
 * Tool calls are counted over `t.rows` by the row's own `tool`, credited and
 * refused alike. `perDelivery[tool].rowCount` counts CREDITED rows only, and the
 * question this guard asks — "did the excluded observations carry more `gate` and
 * `repair` calls than the admitted ones" — is about calls made, not calls scored.
 */
function selectionOf(
  admitted: readonly ObservationTerms[],
  dropped: readonly ObservationTerms[]
): B12Result["selection"] {
  const toolCalls = (of: readonly ObservationTerms[]): number =>
    sumOf(of, (t) => t.rows.filter(({ row }) => TOOL_CALL_NAMES.has(row.tool)).length);
  return {
    excludedWouldHaveAdded: sumOf(dropped, (t) =>
      sumOf(CLASSES, (name) => t.refusals[name].units)
    ),
    // THE SUM ABOVE IS A FLOOR WHILE THIS IS NON-ZERO, and the pair is published
    // together for that reason: `addRefusal` counts a null magnitude here and
    // deliberately does not sum it there.
    excludedUnsized: sumOf(dropped, (t) => sumOf(CLASSES, (name) => t.refusals[name].unsized)),
    admittedSumS: sumOf(admitted, (t) => t.sHi),
    excludedToolCalls: toolCalls(dropped),
    admittedToolCalls: toolCalls(admitted),
  };
}

/**
 * The two sets a stratum cell is built from — the same split `DeliveryPopulations`
 * makes, and for the same reason.
 *
 * **THE FLOOR IS AN ADMITTED-SET PROPERTY AND THE RATIO IS NOT.** `holdsIf` 3 asks
 * for "All four declared strata evaluable (≥ 5 ADMITTED observations each) and all
 * four on the same side of 30%", and `admissionRule` 8 repeats the floor in the
 * same words. `admissionRule` 6 moves only the arithmetic.
 *
 * **A CELL CAN THEREFORE BE EVALUABLE ON FIVE AND PRICED ON THREE, and that is
 * the literal frozen rule rather than an oversight.** Requiring five on the ratio
 * side as well would be a stricter number in the frozen one's clothes — the exact
 * objection `design.metric` raises against reusing 30% on a jackknifed quantity —
 * so the gap is recorded as `FINDINGS.md` F21 instead of being closed by
 * preference.
 */
export interface StrataPopulations {
  /** Full admitted: decides evaluability, and whether a declaration was corrupted. */
  floor: readonly ObservationTerms[];
  /** The domain the cell's bracket is pooled over. */
  ratio: readonly ObservationTerms[];
}

/**
 * Fill the four cells, leaving any below the 5-observation floor unevaluable.
 *
 * A non-empty `unknownStratum` makes `testRed` AND `typesOnly` unevaluable
 * regardless of their sizes: each of those observations belongs to one of the
 * two and nobody can say which, so both are deflated by an unknown amount.
 * `unevaluableShare` does not do this to `solo`/`multi` — a window that
 * originated no billed request belongs to neither cell, and neither is deflated
 * by its absence. Measured absence, corrupted declaration: not the same fact.
 */
export function strataCells(pop: StrataPopulations): StrataCells {
  const floor = partitionByStrata(pop.floor);
  const ratio = partitionByStrata(pop.ratio);
  const cell = (
    counted: readonly ObservationTerms[],
    priced: readonly ObservationTerms[],
    name: string
  ): Evaluable<number> =>
    counted.length < MIN_DELIVERY_OBSERVATIONS
      ? {
          evaluable: false,
          reason: `${name} holds ${counted.length} admitted observation(s), below the floor of ${MIN_DELIVERY_OBSERVATIONS}`,
        }
      : { evaluable: true, value: poolRatio(priced, "lo") };

  // COUNTED ON THE FLOOR POPULATION, because an unrecognised declaration is a
  // fact about the admitted set. A run reaches the hold only after every cell is
  // already evaluable, so reading it off the ratio population would ask the
  // question again of a set that cannot answer it differently.
  const corrupted =
    floor.unknownStratum.length > 0
      ? {
          evaluable: false as const,
          reason: `${floor.unknownStratum.length} observation(s) carry an unrecognised verificationStratum, so both declared cells are deflated by an unknown amount`,
        }
      : null;

  return {
    testRed: corrupted ?? cell(floor.testRed, ratio.testRed, "test-red"),
    typesOnly: corrupted ?? cell(floor.typesOnly, ratio.typesOnly, "types-only"),
    solo: cell(floor.solo, ratio.solo, "solo"),
    multi: cell(floor.multi, ratio.multi, "multi"),
  };
}

/** The artifact. Owed by every registered run, whether it scores or voids. */
export function aggregate(input: AggregateInput): B12Result {
  const { admitted, dropped, coverage, priorRuns } = input;
  // `admissionRule` 6, AND IT IS DERIVED HERE RATHER THAN ASKED OF THE CALLER.
  // This is the only function that sees the whole admitted set, and the run-level
  // assembler that will call it does not exist yet — a required input would be a
  // rule the assembler's author could satisfy wrongly, and an optional one a rule
  // they could forget. See `ambiguousCount` for why both ledgers are read.
  const holdEligible = admitted.filter((t) => ambiguousCount(t) === 0);
  const holdExcluded = admitted.filter((t) => ambiguousCount(t) > 0);
  const rLo = poolRatio(admitted, "lo");
  const rHi = poolRatio(admitted, "hi");
  // Computed ONCE and read twice below. It used to be called twice, which is the
  // shape that lets a figure and the verdict built on it disagree.
  const fallSide = rHiPlus([...admitted, ...dropped], coverage);
  const strata = strataCells({ floor: admitted, ratio: admitted });
  const selection = selectionOf(admitted, dropped);
  const recomputations = recompute(admitted, dropped);

  // THE HOLD DOMAIN, BUILT BESIDE THE PUBLISHED ONE SO THE PAIR IS LEGIBLE. Every
  // member is the same quantity over a smaller set, and on a run with no ambiguous
  // refusal `holdExcluded` is empty and every member equals its published twin —
  // which is why the divergence is pinned by a control rather than by a comment.
  const hold: HoldFigures = {
    basis: "hold-eligible",
    eligible: holdEligible.length,
    excludedForAmbiguity: holdExcluded.length,
    rLo: poolRatio(holdEligible, "lo"),
    // Reading D: the clause-6 observations join the dropped ones in `R_all`, at no
    // saving and with their billing intact. See `holdRecompute`.
    recomputations: holdRecompute(holdEligible, [...dropped, ...holdExcluded]),
    strata: strataCells({ floor: admitted, ratio: holdEligible }),
    gate: deliveryScore({ exercise: admitted, arithmetic: holdEligible }, ["gate"], "lo"),
  };
  // DERIVED, both of them, from the one register. `abandonedRuns` is also what
  // fires the clause-1 VOID, so the count on the artifact and the condition that
  // voided the run are one quantity read twice rather than two that can disagree.
  const abandonedRuns = priorRuns.filter((r) => r.result === null).length;
  const voidedRuns = priorRuns.filter((r) => r.result !== null && !r.result.scored).length;

  // THE PUBLISHED THREE, over the full admitted set on both populations. The
  // design's per-delivery figures are descriptive here; the only one a verdict
  // reads is `hold.gate`, and `R_repair` "is reported separately and NEVER gates
  // B12's own status".
  const publishedPop = { exercise: admitted, arithmetic: admitted };
  const gate = deliveryScore(publishedPop, ["gate"], "lo");
  const repair = deliveryScore(publishedPop, ["repair"], "lo", MIN_REPAIR_CLOSURES);
  // `R_other` reads `unexercised` on every run this venue can produce: none of
  // these five tools writes a telemetry row. Declared in advance in
  // `PREMISES.md § B12` so the field is not mistaken for a measurement.
  // `FINDINGS.md` F13.
  const other = deliveryScore(
    publishedPop,
    ["fix", "implement", "models", "scaffold", "status"],
    "lo"
  );

  // COMPUTED, NOT ASSUMED, and it comes out false whenever `O` is non-zero —
  // which `holdsIf` 6 requires for every observation. See `deliveryScore`.
  const A = sumOf(admitted, (t) => t.aO);
  const S = sumOf(admitted, (t) => t.sLo);
  const O = sumOf(admitted, (t) => t.oO);
  const numeratorOf = (tools: readonly string[]): number =>
    sumOf(admitted, (t) =>
      sumOf(
        tools.map((tool) => t.perDelivery[tool]).filter((b) => b !== undefined),
        (b) => b.sLo
      )
    );
  const deliverySum =
    numeratorOf(["gate"]) +
    numeratorOf(["repair"]) +
    numeratorOf(["fix", "implement", "models", "scaffold", "status"]);
  const identityHolds = Math.abs(deliverySum - (S - O)) < 1e-9;

  const rows = creditedRows(admitted).map((r) => r.row);
  const ratios = admitted
    .map((t) => ({ numerator: t.sLo - t.oO, denominator: t.aO + t.sLo }))
    .filter((x) => x.denominator !== 0)
    .map((x) => x.numerator / x.denominator);

  return {
    runId: input.runId,
    rLo,
    rHi,
    rHiPlus: fallSide,
    coverage,
    recomputations,
    strata,
    gate,
    repair,
    other,
    hold,
    identityHolds,
    admitted: admitted.length,
    dispositions: [...admitted, ...dropped].map((t) => ({
      taskId: t.taskId,
      arm: t.arm,
      disposition: t.disposition,
    })),
    // Both instrument-bias pairs, over the CREDITED rows — the ones that carry a
    // scored contribution. Reported, deciding nothing.
    cappedVsUncapped: {
      capped: sumOf(rows, (r) => r.capped),
      uncapped: sumOf(rows, (r) => r.signed),
    },
    clampedVsSigned: {
      clamped: sumOf(rows, (r) => Math.max(0, r.signed)),
      signed: sumOf(rows, (r) => r.signed),
    },
    rowsNetNegative: rows.filter((r) => r.signed < 0).length,
    // THE BANNED FORM, published because the design says to publish it. Nothing
    // here reads it, and the field's name is the guard.
    meanOfPerObservationRatios:
      ratios.length === 0 ? 0 : sumOf(ratios, (x) => x) / ratios.length,
    ...decide({
      admitted,
      coverage,
      rLo,
      rHi,
      fallSide,
      strata,
      hold,
      selection,
      recomputations,
      priorRuns,
    }),
    selection,
    priorRuns,
    voidedRuns,
    abandonedRuns,
    thresholds: { hold: 0.3, fall: 0.15 },
  };
}

interface Decision {
  admitted: readonly ObservationTerms[];
  coverage: RunTelemetryCoverage;
  /** PUBLISHED, over the full admitted set. The hold's lower bound is `hold.rLo`. */
  rLo: number;
  rHi: number;
  fallSide: Evaluable<number>;
  /** PUBLISHED. `holdsIf` 3's cells are `hold.strata`. */
  strata: StrataCells;
  selection: B12Result["selection"];
  /** PUBLISHED, the five `voidConditions` 18 compares against `rLo` and `rHi`. */
  recomputations: Recomputations;
  priorRuns: readonly PriorRun[];
  hold: HoldFigures;
}

/**
 * Everything `holdsIf` may read, and NOTHING ELSE IS IN SCOPE.
 *
 * That is the whole point of the separate function. `admissionRule` 6 gives the
 * run two domains whose members carry identical names and identical types, so a
 * hold conjunct reaching for the published `rLo` instead of the hold one is a
 * one-word mistake that no type can catch — both are `number`. Putting the
 * published figures out of scope catches it at compile time instead.
 *
 * `admitted` is here because `holdsIf` 6 asks whether `unitsAddedByInstallation`
 * was computed for EVERY observation, which is a data-quality question about the
 * admitted set rather than an arithmetic over a domain.
 */
interface HoldEvidence {
  hold: HoldFigures;
  selection: B12Result["selection"];
  admitted: readonly ObservationTerms[];
}

/**
 * The verdict, and the void clause BY NAME when it voids.
 *
 * **VOIDS FIRST, THEN THE FALL, THEN THE HOLD.** The order is not cosmetic: a
 * void discards the run and consumes an attempt (`voidConditions` 23), so a run
 * that voids never reaches the fall arithmetic and cannot be recorded as a fall
 * on a set the design has already disqualified.
 *
 * **TWO DOMAINS, AND ONLY THE HOLD USES THE SECOND.** `admissionRule` 6 admits an
 * `ambiguous > 0` observation "to the FALL arithmetic only, at both bounds", and
 * excludes it from the hold arithmetic. So every figure above the hold branch is
 * the published, full-admitted one — including the strata `voidConditions` 17 and
 * `fallsIf` read — and the hold branch sees only `HoldEvidence`.
 *
 * **TWO CLAUSES OF THE FROZEN TEXT CONTRADICT THEMSELVES, and the resolutions are
 * quoted rather than chosen.**
 *
 * `voidConditions` 15 opens "VOID if any refused magnitude is null and R_hi+ was
 * therefore not evaluable" and then says, in the same sentence, "the run returns
 * `open`, never a fall" — while `fallsIf` says `open — provisional`. Three
 * formulations of one fact. `design.metric` settles it in words: "If any refused
 * magnitude is `null`, `R_hi⁺` is NOT EVALUABLE and **the run returns `open`**."
 * So an unevaluable fall side is `open`. It is also the only reading that does not
 * spend an irreplaceable attempt on an ambiguity, which `voidConditions` 18 shows
 * the design is reluctant to do.
 *
 * `voidConditions` 3 does the same with an undersized stratum — "VOID if ... any
 * declared stratum has fewer than 5 admitted observations (that stratum is
 * `unevaluable` and the run returns `open`)" — and `admissionRule` 8 settles it
 * outright: an unevaluable stratum "returns `open`, never a hold, a fall, or **a
 * void**." Its FIRST clause, fewer than 20 admitted, carries no such
 * contradiction and voids.
 *
 * **THIS DOC CLAIMED "THERE IS NO HOLD BRANCH" UNTIL 2026-08-07, TWO PASSES AFTER
 * ONE WAS WRITTEN.** The F14 pass moved the body and `UNIT-3.md` and left this
 * comment describing the world before it, so the file's most load-bearing docstring
 * contradicted the function under it. Its closing demand was stale twice over: it
 * asked for a `coverage.unattributedCredited.count > 0` conjunct that the hold
 * branch below deliberately omits, because `rHiPlus` refuses on that exact fact and
 * the run has already returned `open` before the hold is reached. Recorded rather
 * than quietly deleted — a doc that outlived its code is the same failure as a
 * guard that outlived the sum it guarded, and this file has now produced both.
 */
function decide(d: Decision): { verdict: B12Result["verdict"]; voidClause: string | null } {
  const voided = (voidClause: string) => ({ verdict: "void" as const, voidClause });

  // CLAUSE 3 AND admissionRule 2, both sides. Fewer than 20 voids; MORE than 20
  // is the manifest's selection made by the caller, and this function cannot see
  // the committed order that would justify it.
  if (d.admitted.length !== ADMITTED_OBSERVATIONS) {
    return voided(
      `voidConditions 3 / admissionRule 2: ${d.admitted.length} admitted observation(s) against the frozen ${ADMITTED_OBSERVATIONS}`
    );
  }

  // CLAUSE 10 / admissionRule 9: "the admitted set spans EXACTLY one rate key".
  // Zero is as wrong as two — it means nothing carried a rate key at all. G1's
  // ratio argument survives an unknown pricing basis only if the basis is
  // CONSTANT, and dropping the odd observation instead would select on session
  // shape, which is exactly what the subagent-heavy observations look like.
  const keys = [...new Set(d.admitted.flatMap((t) => t.rateKeys))].sort();
  if (keys.length !== 1) {
    return voided(
      `voidConditions 10: the admitted set spans ${keys.length} rate keys (${keys.join(", ") || "none"}), and exactly one is required`
    );
  }

  // CLAUSE 16, both halves. "The pool was then selected on the treatment's own
  // attributability" — a statement about the instrument, not a result.
  //
  // THE FIRST HALF IS SOUND IN ONE DIRECTION ONLY. `excludedWouldHaveAdded` is a
  // FLOOR while `excludedUnsized > 0`, so exceeding proves the guard fired and
  // NOT exceeding proves nothing. That is not a hole: an unsized refusal on a
  // dropped observation also makes `rHiPlus` refuse — it iterates admitted and
  // dropped alike — so such a run reaches the `open` below and never a fall.
  const s = d.selection;
  if (s.excludedWouldHaveAdded > s.admittedSumS) {
    return voided(
      `voidConditions 16: the excluded observations' summed wouldHaveAdded (${s.excludedWouldHaveAdded}) exceeds the admitted set's Σ S_o (${s.admittedSumS})`
    );
  }
  if (s.excludedToolCalls > s.admittedToolCalls) {
    return voided(
      `voidConditions 16: the excluded observations carry ${s.excludedToolCalls} gate/repair calls against the admitted set's ${s.admittedToolCalls}`
    );
  }

  // CLAUSE 17. A coverage-bug signature, not a cost result — and it fires ONLY
  // while the counters read clean, because a run with refusals has an ordinary
  // explanation for the two strata disagreeing.
  const countersClean =
    d.admitted.every((t) => CLASSES.every((name) => t.refusals[name].count === 0)) &&
    CLASSES.every((name) => d.coverage.unowned[name].count === 0);
  if (
    countersClean &&
    d.strata.solo.evaluable &&
    d.strata.multi.evaluable &&
    bandOf(d.strata.solo.value) !== bandOf(d.strata.multi.value)
  ) {
    return voided(
      `voidConditions 17: the subagent strata sit in different bands (solo ${d.strata.solo.value}, multi ${d.strata.multi.value}) while every refusal counter reads clean`
    );
  }

  // CLAUSE 18's FIVE, EACH BESIDE THE PARENT IT IS A RECOMPUTATION OF — built
  // ONCE and read at both thresholds below. The clause names one list ("R_lo-t,
  // R_lo-r, R_hi-t, R_hi-r, R_all") and gives it two readings, 15% and 30%, so two
  // lists here would be two chances to disagree. The first draft had exactly that:
  // the 15% check ran over five and the 30% check over three, which silently
  // narrowed a frozen clause to its low-side half.
  const mandatory: Array<[string, number, number]> = [
    ["rLoMinusTask", d.recomputations.rLoMinusTask, d.rLo],
    ["rHiMinusTask", d.recomputations.rHiMinusTask, d.rHi],
    ["rLoMinusRow", d.recomputations.rLoMinusRow, d.rLo],
    ["rHiMinusRow", d.recomputations.rHiMinusRow, d.rHi],
    ["rAll", d.recomputations.rAll, d.rLo],
  ];

  // ONLY the 15% line voids. Across 30% the run returns `open` with both figures
  // recorded and does NOT consume the attempt cap — read further down, because a
  // void must not be spent on it.
  for (const [name, value, parent] of mandatory) {
    if (value < 0.15 !== parent < 0.15) {
      return voided(
        `voidConditions 18: ${name} (${value}) is on the opposite side of 15% from its parent (${parent})`
      );
    }
  }

  // CLAUSE 1. B12 may not be scored while any registered run has no committed
  // result. The scorer can see that the register was supplied and that every entry
  // resolved; it CANNOT see that the register is COMPLETE, and nothing here
  // pretends otherwise — a caller that omits a prior run entirely is invisible.
  // The rest of clause 1 is carried by `PriorResult`'s shape rather than checked:
  // a result states `scored` or names its void clause, and either way it carries
  // its partial bracket.
  const unresolved = d.priorRuns.filter((r) => r.result === null).map((r) => r.runId);
  if (unresolved.length > 0) {
    return voided(
      `voidConditions 1: ${unresolved.length} previously registered run(s) carry no committed result (${unresolved.join(", ")})`
    );
  }

  // Past the voids. An unscorable fall side is `open` per `design.metric`.
  if (!d.fallSide.evaluable) return { verdict: "open", voidClause: null };

  // admissionRule 8: an unevaluable stratum returns `open`, NEVER a void.
  const cellsEvaluable =
    d.strata.testRed.evaluable &&
    d.strata.typesOnly.evaluable &&
    d.strata.solo.evaluable &&
    d.strata.multi.evaluable;
  if (!cellsEvaluable) return { verdict: "open", voidClause: null };

  if (d.fallSide.value < 0.15) {
    // `fallsIf`: a fall stands unappealed only if both subagent strata are
    // evaluable AND BOTH BELOW 15%. Evaluable is settled above; the bands are not.
    // The two can disagree because the cells are pooled at the LO horizon while
    // this figure is a doubt-credited HI one — 20 observations at
    // `A_o = 100, O_o = 5, S_lo = 30, S_hi = 15` put every cell at 19.23% while
    // `R_hi⁺` is 8.70%, which is exactly the case this member exists for.
    const bothBelow =
      d.strata.solo.evaluable &&
      d.strata.multi.evaluable &&
      d.strata.solo.value < 0.15 &&
      d.strata.multi.value < 0.15;
    if (bothBelow) return { verdict: "fallen", voidClause: null };
    return { verdict: "open — provisional", voidClause: null };
  }

  // `voidConditions` 18's OTHER HALF, AND IT IS NOT A VOID: a recomputation across
  // 30% "returns `open` with both figures recorded and does NOT consume the attempt
  // cap — a run producing two defensible numbers straddling the hold line has
  // measured something". THE SAME FIVE, against the same parents.
  //
  // **THIS USED TO BE THE LAST CONJUNCT OF THE HOLD, WHERE IT COULD NOT FAIL.**
  // The conjuncts above it already required `rLo >= 0.3` and all three low
  // recomputations `>= 0.3`, so by the time it was evaluated every operand was on
  // the same side of the line and the test was always true — a guard that cannot
  // fire, sitting directly beneath a comment explaining that the F9 guard was
  // removed for exactly that reason. Moved here, over figures the hold branch does
  // not constrain, it can. `FINDINGS.md` F22.
  //
  // **AND IT COVERS THE HIGH SIDE, WHICH THE FIRST FIX DID NOT.** No hold condition
  // reads `R_hi`, so a high-side straddle is invisible to every conjunct of
  // `decideHold` — it is only ever this check that can catch one.
  if (mandatory.some(([, value, parent]) => value >= 0.3 !== parent >= 0.3)) {
    return { verdict: "open", voidClause: null };
  }

  if (decideHold({ hold: d.hold, selection: s, admitted: d.admitted })) {
    return { verdict: "holding (unvalidated)", voidClause: null };
  }
  return { verdict: "open", voidClause: null };
}

/**
 * `holdsIf` 1–6 over the domain `admissionRule` 6 leaves the hold.
 *
 * ALWAYS `(unvalidated)` WHEN IT PASSES. `holdsIf` 7 is "the A/B ran and did not
 * kill it", the A/B does not exist, and the design names the state for exactly
 * that: "A never-run A/B leaves `holding (unvalidated)`, which is a real recorded
 * state and MAY NOT BE CITED AS AN INPUT TO OPENING OR CLOSING ANY GATE."
 *
 * **EVERY RATIO HERE IS A HOLD-DOMAIN RATIO AND THE PUBLISHED ONES ARE NOT IN
 * SCOPE.** That is why this is a function and not a block: `d.rLo` and
 * `d.hold.rLo` are both `number`, both plausible, and differ only on runs that
 * carry an ambiguous refusal — the runs where getting it wrong matters and no
 * test on a clean fixture would notice.
 *
 * **THE F9 HOLD-SIDE GUARD IS SUBSUMED, NOT MISSING.** A credited row no window
 * owns is omitted from `R_lo`, and magnitudes are SIGNED, so omitting a NEGATIVE
 * one RAISES the figure toward a hold; a guard was registered as owed here. Written
 * as a conjunct it can never decide anything, because `rHiPlus` refuses on that
 * exact fact and the run returns `open` before reaching this function. Planting the
 * defect proved it: deleting the conjunct changed no test.
 */
function decideHold(e: HoldEvidence): boolean {
  const cells = [e.hold.strata.testRed, e.hold.strata.typesOnly, e.hold.strata.solo, e.hold.strata.multi];
  return (
    // 1. The whole bracket clears the line. The COUNT is settled by the caller's
    //    clause-3 void, which counts admitted observations — `hold.eligible` may
    //    legitimately be smaller, because clause 6 leaves such an observation
    //    admitted and removes it only from this arithmetic.
    e.hold.rLo >= 0.3 &&
    // 2. Survives deleting its best task, its best row, and reinstating everything
    //    it dropped — where "dropped" includes the clause-6 exclusions, per
    //    `admissionRule` 3's use of the phrase. All three are LOW-side figures.
    e.hold.recomputations.rLoMinusTask >= 0.3 &&
    e.hold.recomputations.rLoMinusRow >= 0.3 &&
    e.hold.recomputations.rAll >= 0.3 &&
    // 3. All four cells on the same side of 30%. Their EVALUABILITY was decided on
    //    the admitted set and settled by the caller; a cell can therefore be
    //    evaluable on five admitted observations and priced on fewer (`FINDINGS.md`
    //    F21). Re-checked here rather than assumed, because this function may not
    //    depend on which branch called it.
    cells.every((c) => c.evaluable && c.value >= 0.3) &&
    // 4. Per-delivery: G-stop requires each delivery to individually pay for
    //    itself. `unexercised` was counted on the admitted set, the ratio was not.
    e.hold.gate.scored &&
    e.hold.gate.r >= 0.3 &&
    // 5. **`holdsIf` 5 IS NOT WRITTEN HERE, BECAUSE BOTH HALVES OF IT ARE ALREADY
    //    TRUE OF EVERY RUN THAT REACHES THIS FUNCTION.** It asks that no refused
    //    magnitude be null and that the excluded set not outweigh the admitted one.
    //    `voidConditions` 16 voids on the exact complement of the second —
    //    `excludedWouldHaveAdded > admittedSumS` — so reaching here proves `<=`;
    //    and `rHiPlus` iterates admitted AND dropped and refuses on any unsized
    //    owned refusal, so `excludedUnsized > 0` returns `open` before the hold is
    //    considered. Both were written as conjuncts and neither could fail.
    //
    //    That is the third time this file has grown a guard that cannot fire
    //    (`FINDINGS.md` F22, and the F9 conjunct before it), so it is recorded
    //    rather than replaced by a comment saying the guard is there. **The
    //    subsumption is exact for finite figures only**: a NaN would slip both the
    //    void and the conjunct, and nothing here defends against one beyond `oO`.
    //
    //    Where `selection` splits admitted from excluded — on DISPOSITION, not on
    //    clause 6 — is an implementation convention rather than a reading of the
    //    frozen text, which does not say which sense of "excluded" these
    //    comparisons take. `FINDINGS.md` F20.
    //
    // 6. `unitsAddedByInstallation` computed for EVERY observation, not estimated
    //    and not omitted. A non-finite `oO` is the omission wearing a number. Over
    //    the ADMITTED set: it is a question about what the instrument computed, not
    //    about which arithmetic the observation feeds.
    e.admitted.every((t) => Number.isFinite(t.oO))
  );
}
