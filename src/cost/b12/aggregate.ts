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
 */
export function rHiPlus(all: readonly ObservationTerms[]): Evaluable<number> {
  void all;
  throw new Error("not implemented");
}

/**
 * The five recomputations, each of which must land on the same side of both
 * thresholds as its parent or the run is VOID.
 *
 * Two are CONCENTRATION guards (drop the best task, drop the best row) and one
 * is a DILUTION guard (`rAll` reinstates every dropped observation at
 * `saved_o = 0` with its `billed_o` still in the denominator). The source
 * designs all carried the first kind and none carried the second, so discarding
 * a zero-saving observation tripped nothing.
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
 * THE IDENTITY IS WHY THE DENOMINATOR IS SHARED. The design asserts
 * `sum_d R_d + R_other = R`, and ratios do not otherwise sum; the only reading
 * under which that holds is one denominator with the numerator partitioned by
 * the telemetry `tool` field. Fixed here, in writing, before any `R` exists —
 * the design warns that an implementer's natural alternative, bucketing
 * `scaffold`'s rows under the nearest named delivery, would decide `gate`'s
 * survival on another tool's saving.
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

/** Fill the four cells, leaving any below the 5-observation floor unevaluable. */
export function strataCells(admitted: readonly ObservationTerms[]): StrataCells {
  void admitted;
  throw new Error("not implemented");
}

/** The artifact. Owed by every registered run, whether it scores or voids. */
export function aggregate(input: AggregateInput): B12Result {
  void input;
  throw new Error("not implemented");
}
