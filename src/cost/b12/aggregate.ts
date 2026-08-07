/**
 * UNIT 3 — the pooled bracket, the per-delivery split, and the guards.
 *
 * RATIO OF SUMS, ALWAYS. `saved_o / billed_o` per observation, and the mean of
 * per-observation ratios, are BANNED BY NAME as the deciding form. The mean is
 * computed and reported here anyway, because the design says to publish it — and
 * publishing a number that decides nothing is only safe while nothing reads it,
 * so it is carried in a field whose name says what it is.
 */

import type {
  B12Result,
  DeliveryScore,
  Evaluable,
  ObservationTerms,
  Recomputations,
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
  void terms;
  void horizon;
  throw new Error("not implemented");
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
 * OVER BOTH LEDGERS ON EVERY OBSERVATION. `unverifiable` rows can never belong
 * to a window and `excludedForeign` rows do not on any normal input, so they
 * reach here through `unattributedRefusals`, and a figure summed from `refusals`
 * alone is missing most of two of the four classes it claims to cover.
 *
 * ALSO NOT EVALUABLE on a negative `unattributedRefusals` class sum: those rows
 * may be counted twice and `wouldHaveAdded` is signed, so a duplicated negative
 * magnitude pushes this figure DOWN, toward a fall the data does not support.
 */
export function rHiPlus(all: readonly ObservationTerms[]): Evaluable<number> {
  void all;
  throw new Error("not implemented");
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
  void admitted;
  void dropped;
  throw new Error("not implemented");
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
 */
export function deliveryScore(
  terms: readonly ObservationTerms[],
  tools: readonly string[],
  horizon: "lo" | "hi",
  minClosures?: number
): DeliveryScore {
  void terms;
  void tools;
  void horizon;
  void minClosures;
  throw new Error("not implemented");
}

export interface AggregateInput {
  runId: string;
  /** Observations whose disposition is `scored`. */
  admitted: readonly ObservationTerms[];
  /** Everything else the run produced, needed for `rHiPlus` and `rAll`. */
  dropped: readonly ObservationTerms[];
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
export function strataCells(admitted: readonly ObservationTerms[]): StrataCells {
  void admitted;
  throw new Error("not implemented");
}

/** The artifact. Owed by every registered run, whether it scores or voids. */
export function aggregate(input: AggregateInput): B12Result {
  void input;
  throw new Error("not implemented");
}
