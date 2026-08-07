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
  ObservationTerms,
  RefusalLedger,
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

/** The four class names, in one place, so no figure is built from three. */
const CLASSES = ["ambiguous", "unverifiable", "excludedForeign", "unmatched"] as const;

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
    for (const row of t.rows) {
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
  for (const t of all) {
    const ledgers: Array<[string, RefusalLedger]> = [
      ["refusals", t.refusals],
      ["unattributedRefusals", t.unattributedRefusals],
    ];
    for (const [which, ledger] of ledgers) {
      for (const name of CLASSES) {
        if (ledger[name].unsized > 0) {
          return {
            evaluable: false,
            reason: `${t.taskId}/${t.arm}: ${ledger[name].unsized} ${name} refusal(s) in ${which} could not be sized, and an unknown may not be summed as zero`,
          };
        }
      }
    }
    // The one duplication case the declared types can see. NOT a complete
    // guard — a class sum of zero can hide a +100 and a -100 — and
    // `FINDINGS.md` F12 is the run-level ledger that would close it.
    for (const name of CLASSES) {
      if (t.unattributedRefusals[name].units < 0) {
        return {
          evaluable: false,
          reason: `${t.taskId}/${t.arm}: unattributed ${name} magnitude is negative (${t.unattributedRefusals[name].units}), and such a row may be counted twice, which would push this figure toward a fall the data does not support`,
        };
      }
    }
  }

  const refused = sumOf(all, (t) =>
    sumOf(CLASSES, (name) => t.refusals[name].units + t.unattributedRefusals[name].units)
  );
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
  const withoutLargestTask = (): ObservationTerms[] => {
    if (admitted.length === 0) return [];
    let worst = 0;
    admitted.forEach((t, i) => {
      if (t.aO > (admitted[worst]?.aO ?? -Infinity)) worst = i;
    });
    return admitted.filter((_, i) => i !== worst);
  };

  const rows = creditedRows(admitted);
  /** `admitted` with one row's contribution removed from the observation that owns it. */
  const withoutLargestRow = (horizon: "lo" | "hi"): ObservationTerms[] => {
    const magnitude = (r: (typeof rows)[number]): number =>
      horizon === "lo" ? r.row.unitsLo : r.row.units;
    if (rows.length === 0) return [...admitted];
    let best = 0;
    rows.forEach((r, i) => {
      const incumbent = rows[best];
      if (incumbent !== undefined && magnitude(r) > magnitude(incumbent)) best = i;
    });
    const chosen = rows[best];
    if (chosen === undefined) return [...admitted];
    return admitted.map((t, i) =>
      i !== chosen.owner
        ? t
        : horizon === "lo"
          ? { ...t, sLo: t.sLo - chosen.row.unitsLo }
          : { ...t, sHi: t.sHi - chosen.row.units }
    );
  };

  const minusTask = withoutLargestTask();
  // Reinstated with NO saving and its billing intact: the dilution guard.
  const reinstated = [...admitted, ...dropped.map((t) => ({ ...t, sLo: 0, sHi: 0 }))];

  return {
    rLoMinusTask: poolRatio(minusTask, "lo"),
    rHiMinusTask: poolRatio(minusTask, "hi"),
    rLoMinusRow: poolRatio(withoutLargestRow("lo"), "lo"),
    rHiMinusRow: poolRatio(withoutLargestRow("hi"), "hi"),
    rAll: poolRatio(reinstated, "lo"),
  };
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
  const bucketsOf = (t: ObservationTerms) =>
    tools.map((tool) => t.perDelivery[tool]).filter((b) => b !== undefined);
  const carrying = terms.filter((t) => bucketsOf(t).some((b) => b.rowCount > 0));

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
  const p = partitionByStrata(admitted);
  const cell = (of: readonly ObservationTerms[], name: string): Evaluable<number> =>
    of.length < MIN_DELIVERY_OBSERVATIONS
      ? {
          evaluable: false,
          reason: `${name} holds ${of.length} admitted observation(s), below the floor of ${MIN_DELIVERY_OBSERVATIONS}`,
        }
      : { evaluable: true, value: poolRatio(of, "lo") };

  const corrupted =
    p.unknownStratum.length > 0
      ? {
          evaluable: false as const,
          reason: `${p.unknownStratum.length} observation(s) carry an unrecognised verificationStratum, so both declared cells are deflated by an unknown amount`,
        }
      : null;

  return {
    testRed: corrupted ?? cell(p.testRed, "test-red"),
    typesOnly: corrupted ?? cell(p.typesOnly, "types-only"),
    solo: cell(p.solo, "solo"),
    multi: cell(p.multi, "multi"),
  };
}

/** The artifact. Owed by every registered run, whether it scores or voids. */
export function aggregate(input: AggregateInput): B12Result {
  const { admitted, dropped } = input;
  const rLo = poolRatio(admitted, "lo");
  const rHi = poolRatio(admitted, "hi");

  const gate = deliveryScore(admitted, ["gate"], "lo");
  const repair = deliveryScore(admitted, ["repair"], "lo", MIN_REPAIR_CLOSURES);
  // `R_other` reads `unexercised` on every run this venue can produce: none of
  // these five tools writes a telemetry row. Declared in advance in
  // `PREMISES.md § B12` so the field is not mistaken for a measurement.
  // `FINDINGS.md` F13.
  const other = deliveryScore(
    admitted,
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
    rHiPlus: rHiPlus([...admitted, ...dropped]),
    recomputations: recompute(admitted, dropped),
    strata: strataCells(admitted),
    gate,
    repair,
    other,
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
    verdict: verdictOf(rHiPlus([...admitted, ...dropped]), strataCells(admitted)),
    thresholds: { hold: 0.3, fall: 0.15 },
  };
}

/**
 * `"open"` unless something clearly decides otherwise, and NEVER an invented
 * hold. A fall additionally requires all four strata cells evaluable, which
 * `fallsIf` says twice: a fall stands unappealed only if "both subagent strata
 * are evaluable", and "a run with fewer than 20 admitted observations, or any
 * stratum below 5, is VOID or `open` — never a fall on a short set".
 */
function verdictOf(fallSide: Evaluable<number>, strata: StrataCells): B12Result["verdict"] {
  const cellsEvaluable =
    strata.testRed.evaluable &&
    strata.typesOnly.evaluable &&
    strata.solo.evaluable &&
    strata.multi.evaluable;
  if (fallSide.evaluable && fallSide.value < 0.15 && cellsEvaluable) return "fallen";
  return "open";
}
