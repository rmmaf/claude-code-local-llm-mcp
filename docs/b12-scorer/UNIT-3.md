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

**BOTH LEDGERS, EVERY TIME.** Each observation carries `refusals` (the rows it
owns) and `unattributedRefusals` (the rows in its slice that no window can own).
Every rule below reads the two together — `unverifiable` and `excludedForeign`
live only in the second, so a figure built from `refusals` alone is missing two
of the four classes the frozen metric names.

1. If any class of EITHER ledger, on any observation, has `unsized > 0`, return
   `{ evaluable: false, reason: "..." }` naming the unsized refusal. An unknown
   may not be summed as zero, and the run returns `open` rather than falling.
2. Otherwise `refused` = sum over all observations, over both ledgers, of
   `ambiguous.units + unverifiable.units + excludedForeign.units + unmatched.units`
   — **all four classes**. Three classes gives a different number.
3. `S = sum of sHi`, `A = sum of aO`, `O = sum of oO`.
4. Return `{ evaluable: true, value: (S + refused - O) / (A + S + refused) }`.

Do not deduplicate `unattributedRefusals` across observations. One row can sit
in two slices when two sessions ran within a minute of each other, and counting
it twice moves this figure UP — `R_hi+` gates only the fall, so it can prevent a
fall and can never manufacture a hold. Dropping the row is the error that stops
the project; counting it twice is not.

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
   the same way and return `unexercised` if unmet. **It counts OBSERVATIONS, not
   rows:** how many of `carrying` have `closures > 0` in one of the buckets whose
   key is in `tools`. `holdsIf` words it as "≥ 5 admitted observations carry a
   `repair` row AND at least two of THOSE carry `passed: true`".
   `closureUnknown` is not a closure and is not a failure to close — it is
   reported and counted toward neither, which can only push this floor toward
   `unexercised`, and `unexercised` is neither a hold nor a fall.
4. Otherwise the numerator is the sum, over ALL `terms` (not just `carrying`), of
   this delivery's `sLo`/`sHi` per the horizon; the denominator is the SAME
   `A + S` that `poolRatio(terms, horizon)` uses over all `terms`.
   **One common denominator**, and a tool's rows are never bucketed under another
   delivery's name — the design warns that an implementer doing so would decide
   `gate`'s survival on another tool's saving.

   **The design also asserts `sum_d R_d + R_other = R`, and that is FALSE as
   written. Implement the instruction above; do not implement the identity.**
   `sum_d R_d = S / (A + S)` while `R = (S - O) / (A + S)`, so the two differ by
   `O / (A + S)` on every run where the installation term is non-zero — and `O`
   is non-zero by design, since `holdsIf` 6 requires it computed for every
   observation. `B12Result.identityHolds` says "compute it; do not assume it", so
   report what you measure and let it come out false. See `FINDINGS.md` F11:
   fixing it needs the frozen design to say where `O` is allocated, which is not
   this unit's decision.
5. Return `{ scored: true, r, observations: carrying.length }`.

## `recompute(admitted, dropped): Recomputations`

- `rLoMinusTask` / `rHiMinusTask`: `poolRatio` over `admitted` with the single
  observation of largest `aO` removed.
- `rLoMinusRow` / `rHiMinusRow`: `poolRatio` over `admitted` with the single
  largest credited row removed. **EACH HORIZON DROPS ITS OWN LARGEST ROW, and
  they may be different rows.** `holdsIf` 2 says a hold must survive deleting
  "its best task, its best row" — *its*, per figure.
  - `rHiMinusRow`: find the credited row with the greatest `units` across all
    observations, subtract `units` from its observation's `sHi`, pool at `"hi"`.
  - `rLoMinusRow`: find the credited row with the greatest **`unitsLo`**,
    subtract `unitsLo` from its observation's `sLo`, pool at `"lo"`.

  `units` is `capped/charsPerToken × multiplier` and `unitsLo` is the same row at
  the write component alone, so the two rankings differ whenever rows sit at
  different segment positions. Ranking both by `units` makes the low-side
  concentration guard a statement about the high side — and a guard computed
  about the wrong figure still produces a number, which reads as a passed guard.
- `rAll`: `poolRatio` over `admitted` PLUS every `dropped` observation reinstated
  with `sLo = 0` and `sHi = 0` but its `aO` and `oO` intact. This is the dilution
  guard; the other two are concentration guards.

## `strataCells(admitted): StrataCells`

Call `partitionByStrata` from `./strata.js`. For each of the four cells: if it
holds fewer than `MIN_DELIVERY_OBSERVATIONS` observations, the cell is
`{ evaluable: false, reason }`; otherwise `{ evaluable: true, value: poolRatio(cell, "lo") }`.

**One extra rule, before the floor.** If `unknownStratum` is non-empty, `testRed`
AND `typesOnly` are both `{ evaluable: false, reason }` naming the count,
whatever their sizes. Each of those observations belongs to one of the two cells
and nobody can say which, so both are deflated by an unknown amount — and a cell
that reports a number while missing observations it should hold is worse than one
that refuses.

`unevaluableShare` does **not** do this to `solo` / `multi`. It is a different
fact: the window originated no billed request, so it genuinely belongs to neither
cell and neither is deflated. A measured absence and a corrupted declaration are
not the same thing; do not merge the two buckets or the two rules.

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
  hold. `"fallen"` requires `rHiPlus.evaluable === true`, its value `< 0.15`,
  **and all four `strata` cells evaluable.** `fallsIf` names the last one twice:
  a fall stands unappealed only if "both subagent strata are evaluable", and
  "a run with fewer than 20 admitted observations, or any stratum below 5, is
  VOID or `open` — never a fall on a short set". An unevaluable cell is exactly
  that case, whether it came from the 5-observation floor or from
  `unknownStratum`.

## Done when

`npx vitest run tests/b12-aggregate.test.ts` exits 0. Do not read that file.
