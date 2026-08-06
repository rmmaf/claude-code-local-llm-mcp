# UNIT 3 — `src/cost/b12/aggregate.ts`

Implement the exported functions. Do not change their signatures, do not add
exports, do not edit any other file. `MIN_DELIVERY_OBSERVATIONS` (5) and
`MIN_REPAIR_CLOSURES` (2) are already declared — use them, do not redefine them.
`src/cost/b12/strata.ts` is already implemented; `strataCells` calls
`partitionByStrata` from it.

`poolRatio` returns `0` when `A + S` is zero — an empty set has no ratio, and
`NaN` propagates into every figure downstream of it.

## `poolRatio(terms, horizon): number`

**RATIO OF SUMS. Never an average of per-observation ratios.**

```
S = sum over terms of (horizon === "lo" ? t.sLo : t.sHi)
A = sum over terms of t.aO
O = sum over terms of t.oO
return (S - O) / (A + S)
```

`O` is subtracted from the NUMERATOR and never added to the denominator. Nothing
is clamped; the result may be negative and that is a real measurement. Return `0`
when `A + S === 0`.

## `rHiPlus(all): Evaluable<number>`

Over EVERY observation handed in, admitted and dropped alike.

1. If any observation has any of its four `refusals` classes with `unsized > 0`,
   return `{ evaluable: false, reason: "..." }` naming the unsized refusal. An
   unknown may not be summed as zero, and the run returns `open` rather than
   falling.
2. Otherwise `refused` = sum over all observations of
   `ambiguous.units + unverifiable.units + excludedForeign.units + unmatched.units`
   — **all four classes**. Three classes gives a different number.
3. `S = sum of sHi`, `A = sum of aO`, `O = sum of oO`.
4. Return `{ evaluable: true, value: (S + refused - O) / (A + S + refused) }`.

## `deliveryScore(terms, tools, horizon, minClosures?): DeliveryScore`

`tools` is the list of telemetry `tool` names this delivery owns.

1. `carrying` = the observations with at least one entry in `t.perDelivery` whose
   key is in `tools` and whose `rowCount > 0`.
2. If `carrying.length < MIN_DELIVERY_OBSERVATIONS`, return
   `{ scored: false, reason: "unexercised", observations: carrying.length }`.
   **There must be no `r` on that object at all.** `unexercised` is a third
   state, not a low score: a delivery nobody exercised has not failed to pay for
   itself, it has not been asked, and a 0 would put it under 15% and fire the
   stopping criterion on an absence.
3. When `minClosures` is a number greater than 0, apply it as a second floor in
   the same way and return `unexercised` if unmet.
4. Otherwise the numerator is the sum, over ALL `terms` (not just `carrying`), of
   this delivery's `sLo`/`sHi` per the horizon; the denominator is the SAME
   `A + S` that `poolRatio(terms, horizon)` uses over all `terms`.
   **One common denominator** — that is the only reading under which the design's
   `sum_d R_d + R_other = R` identity holds, and it is why a tool's rows are
   never bucketed under another delivery's name.
5. Return `{ scored: true, r, observations: carrying.length }`.

## `recompute(admitted, dropped): Recomputations`

- `rLoMinusTask` / `rHiMinusTask`: `poolRatio` over `admitted` with the single
  observation of largest `aO` removed.
- `rLoMinusRow` / `rHiMinusRow`: `poolRatio` over `admitted` with the single
  largest credited row removed — find the row with the greatest `units` across
  all observations, and subtract its contribution from that observation's `sLo`
  and `sHi` before pooling.
- `rAll`: `poolRatio` over `admitted` PLUS every `dropped` observation reinstated
  with `sLo = 0` and `sHi = 0` but its `aO` and `oO` intact. This is the dilution
  guard; the other two are concentration guards.

## `strataCells(admitted): StrataCells`

Call `partitionByStrata` from `./strata.js`. For each of the four cells: if it
holds fewer than `MIN_DELIVERY_OBSERVATIONS` observations, the cell is
`{ evaluable: false, reason }`; otherwise `{ evaluable: true, value: poolRatio(cell, "lo") }`.

## `aggregate(input): B12Result`

Fill every field of `B12Result` from the functions above.

- `rLo` / `rHi` = `poolRatio(input.admitted, "lo" | "hi")`.
- `gate` = `deliveryScore(admitted, ["gate"], "lo")`;
  `repair` = `deliveryScore(admitted, ["repair"], "lo", MIN_REPAIR_CLOSURES)`;
  `other` = `deliveryScore(admitted, ["fix","implement","models","scaffold","status"], "lo")`.
- `identityHolds`: true when the three numerators sum to the pooled numerator
  within `1e-9`. Compute it; do not assume it.
- `meanOfPerObservationRatios`: the mean of `(t.sLo - t.oO) / (t.aO + t.sLo)` over
  `admitted`, guarding a zero denominator. **REPORTED AND DECIDING NOTHING** — it
  is the banned form, carried because the design says to publish it.
- `cappedVsUncapped`, `clampedVsSigned`, `rowsNetNegative`: derive from the rows
  on the admitted observations.
- `thresholds` is the literal `{ hold: 0.3, fall: 0.15 }`.
- `verdict`: `"open"` unless something clearly decides otherwise; never invent a
  hold. `"fallen"` requires `rHiPlus.evaluable === true` and its value `< 0.15`.

## Done when

`npx vitest run tests/b12-aggregate.test.ts` exits 0. Do not read that file.
