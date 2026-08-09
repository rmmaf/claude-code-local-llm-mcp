# UNIT 3 — `src/cost/b12/aggregate.ts`

Implement the exported functions. Do not change their signatures, do not add
exports, do not edit any other file. `MIN_DELIVERY_OBSERVATIONS` (5) and
`MIN_REPAIR_CLOSURES` (2) are already declared — use them, do not redefine them.
`src/cost/b12/strata.ts` is already implemented; `strataCells` calls
`partitionByStrata` from it.

`poolRatio` returns `0` when `A + S` is zero — an empty set has no ratio, and
`NaN` propagates into every figure downstream of it.

## `poolRatio(terms, form): number`

**RATIO OF SUMS. Never an average of per-observation ratios.**

```
S = sum over terms at the form: sLo | sHi | sLoUncapped | sHiUncapped
A = sum over terms of t.aO
O = sum over terms of t.oO
return (S - O) / (A + S)
```

`O` is subtracted from the NUMERATOR and never added to the denominator. Nothing
is clamped; the result may be negative and that is a real measurement. Return `0`
when `A + S === 0`.

`form` is the four-member `PricedForm` since F23's repair (2026-08-09). ONLY the
published `uncappedBracket` reads the two uncapped forms: the jackknife, strata,
hold and delivery figures keep the narrow `"lo" | "hi"` union, so an uncapped
recomputation is a compile error rather than a choice. `reinstate` zeroes all
four sums together and `withoutLargestRow` subtracts the chosen row from all
four while ranking on the capped pair.

## `rHiPlus(all, coverage): Evaluable<number>`

Over EVERY observation handed in, admitted and dropped alike, plus the run-level
ledger `UNIT-4.md` builds.

**OWNED REFUSALS PER OBSERVATION, UNOWNED ONES FROM THE RUN LEDGER**, so each
physical row enters exactly once. `unverifiable` can never be owned and
`excludedForeign` is unowned on any normal input, so those reach the figure
through `coverage.unowned`; a figure built from `refusals` alone is missing most
of two of the four classes the frozen metric names.

1. If any class of any observation's OWNED `refusals` has `unsized > 0`, return
   `{ evaluable: false, reason: "..." }` naming it. An unknown may not be summed
   as zero, and the run returns `open` rather than falling.
2. If `coverage.reasons` is non-empty, return `{ evaluable: false }` with the
   first of them. Those cover every run-level cause: a row two observations
   claim, a row no slice saw, a row nobody could size, and a credited row no
   window owns.
3. Otherwise `refused` = sum over observations of `refusals`' four classes, PLUS
   `coverage.unowned`'s four classes. **All four on both sides.** Three classes
   gives a different number.
4. `S = sum of sHi`, `A = sum of aO`, `O = sum of oO`.
5. Return `{ evaluable: true, value: (S + refused - O) / (A + S + refused) }`.

**`unattributedRefusals` IS NOT SUMMED, AND STEP 1b IS GONE.** They went together
and the reason is one reason. That ledger is a per-observation TOTAL of rows no
observation owns, and one physical row sits in two slices whenever two sessions
ran within a minute of each other — `admissionRule` 5 names `scopeTelemetry`'s
±60,000 ms window by hand. Adding those totals counted such a row twice, and
`wouldHaveAdded` is signed:

- **Positive** — the ordinary case — moved `R_hi+` up. Safe on its own: it can
  turn a true fall into `open` and can never manufacture a hold.
- **Negative** moved it DOWN and could manufacture a fall the data does not
  support. That is the error the whole design is arranged to prevent.

Step 1b refused on a negative class sum and was declared incomplete in this file
the day it was written: a class sum of zero hides a +100 and a −100. It is
removed rather than kept alongside the new ledger, because a guard standing over
a quantity nothing computes any more reads as protection while providing none.
`runCoverage` deduplicates by row identity instead, and refuses what it cannot
resolve.

## `deliveryScore(pop, tools, horizon, minClosures?): DeliveryScore`

`tools` is the list of telemetry `tool` names this delivery owns. `pop` is a
REQUIRED PAIR — `{ exercise, arithmetic }` — and neither member defaults to the
other: `admissionRule` 6 split them apart, `unexercised` is defined over
**admitted** observations and the ratio the hold reads is not. On the published
face both members are the full admitted set; on `hold.gate` the exercise floor is
still the admitted set and only the arithmetic narrows.

1. `carrying` = the observations **of `pop.exercise`** with at least one entry in
   `t.perDelivery` whose key is in `tools` and whose `rowCount > 0`.
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
4. Otherwise the numerator is the sum, over ALL of `pop.arithmetic` (not just
   `carrying`), of this delivery's `sLo`/`sHi` per the horizon; the denominator is
   the SAME `A + S` that `poolRatio(pop.arithmetic, horizon)` uses.
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

## `holdRecompute(eligible, reinstated): HoldRecomputations`

The three `holdsIf` 2 names and no more — `rLoMinusTask`, `rLoMinusRow`, `rAll`,
all at the LOW horizon, because that is what the condition asks for. The two
high-horizon forms exist for `voidConditions` 18, which compares them against the
published `R_hi`, a figure the hold domain does not have; carrying them here would
put two numbers on the artifact that nothing reads and no rule defines.

`reinstated` is `dropped` PLUS the clause-6 exclusions. Share the task-drop and
row-drop helpers with `recompute` rather than restating them: two derivations of
one rule is what this repository has already watched drift.

## `strataCells(pop): StrataCells`

`pop` is the same kind of required pair `deliveryScore` takes, named for what each
member decides: `{ floor, ratio }`. Call `partitionByStrata` on BOTH. For each of
the four cells: if the **`floor`** partition holds fewer than
`MIN_DELIVERY_OBSERVATIONS` observations, the cell is `{ evaluable: false, reason }`;
otherwise `{ evaluable: true, value: poolRatio(ratioCell, "lo") }`.

**EVERY CELL ALSO CARRIES BOTH POPULATION SIZES — `counted` and `priced` — whether
or not it is evaluable.** `counted` is the `floor` cell's length and `priced` is
the `ratio` cell's; they coincide on the published face and diverge on the hold
domain. A cell was an `Evaluable<number>` and nothing else until F21, so a bracket
pooled from four observations was indistinguishable from one pooled from ten.
**Reported, deciding nothing** — the floor still reads `counted`, and a second
floor on `priced` was adjudicated twice and refused: it would mint no constant but
it would mint a second predicate over a population `admissionRule` 8 does not name.

Carry them by INTERSECTING with `Evaluable<number>` rather than wrapping it, so
`.evaluable` still narrows and the counts survive on the unevaluable arm — which
is the case a reader most wants them for. The corrupted-declaration branch below
must build a cell PER CELL rather than share one object, or both declared cells
report the same two numbers.

**The floor is an admitted-set property and the ratio is not.** `holdsIf` 3 asks
for "All four declared strata evaluable (≥ 5 **admitted** observations each) and
all four on the same side of 30%", and `admissionRule` 8 repeats the floor in the
same words. So a hold cell can be evaluable on five and priced on three; that is
the literal frozen rule and the gap it leaves is `FINDINGS.md` F21, not a licence
to add a second floor of one's own.

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

**THE RUN HAS TWO DOMAINS AND EVERY FIELD BELOW NAMES ITS OWN.**
`admissionRule` 6: "An observation with `ambiguous > 0` is admitted to the FALL
arithmetic only, at both bounds, and **excluded from the HOLD arithmetic**", and
`conflictsResolved` 5 records that as the chosen resolution of "excluded outright
versus admitted". So:

- **full admitted** — the published bracket and everything `voidConditions` and
  `fallsIf` read. Such an observation is still admitted, so it counts toward the
  20 and toward every floor the design words as "admitted observations".
- **hold-eligible** = admitted minus every observation with
  `refusals.ambiguous.count + unattributedRefusals.ambiguous.count > 0`. The
  predicate reads BOTH ledgers because `admissionRule` 5 pins `ambiguous` to the
  shipped counter, which `report.ts` increments over the whole telemetry slice
  before ownership is decided.
- **every produced observation** — `rHiPlus`, unchanged.

Derive the partition inside `aggregate()`. It is the only function that sees the
whole admitted set, and the run-level assembler that will call it does not exist
yet — a required input would be a rule its author could satisfy wrongly, and an
optional one a rule they could forget.

- `rLo` / `rHi` = `poolRatio(input.admitted, "lo" | "hi")` — FULL admitted.
  `fallsIf` reads `rLo` by name; the hold's lower bound is `hold.rLo`.
- `uncappedBracket` = `{ rLo, rHi }` at the two uncapped forms over the SAME
  full admitted set (F23, repaired 2026-08-09). Reported, deciding nothing —
  its PRESENCE as four finite bounds is what the assembler's live clause-8
  check reads, and no other figure has an uncapped variant.
- `gate` = `deliveryScore({ exercise: admitted, arithmetic: admitted }, ["gate"], "lo")`;
  `repair` = the same pair with `["repair"]` and `MIN_REPAIR_CLOSURES`;
  `other` = the same pair over the five unexercised tools.
- `hold`: `basis` is the literal `"hold-eligible"`; `eligible` and
  `excludedForAmbiguity` sum to `admitted.length`; `rLo` is
  `poolRatio(holdEligible, "lo")`; `recomputations` are the three `holdsIf` 2
  names and no more; `strata` is `strataCells({ floor: admitted, ratio: holdEligible })`;
  `gate` is `deliveryScore({ exercise: admitted, arithmetic: holdEligible }, ["gate"], "lo")`.

  **THE TWO POPULATIONS ARE NOT INTERCHANGEABLE AND NEITHER DEFAULTS TO THE
  OTHER.** `unexercised` is defined as "fewer than 5 **admitted** observations
  carrying its rows" and a stratum is evaluable on "≥ 5 **admitted** observations
  each"; clause 6 moves only the arithmetic. Passing the hold-eligible set for
  both — the obvious implementation — silently redefines a frozen floor and turns
  an ambiguous refusal into evidence that a tool was never run.

  **`hold.recomputations.rAll` REINSTATES THE CLAUSE-6 EXCLUSIONS TOO**, at
  `saved_o = 0` with their billing intact, alongside the dropped observations.
  `admissionRule` 3 uses "dropped" to mean dropped from the hold arithmetic, and
  `holdsIf` 2 asks a hold to survive "reinstating everything it dropped". Leaving
  them out entirely takes a billed denominator off the hold side, which is the one
  direction a dilution guard must not move.
- `selection.basis` is the literal `"disposition"`. `voidConditions` 16 and
  `holdsIf` 5 compare "the EXCLUDED observations" against "the ADMITTED set", and
  since `admissionRule` 6 an observation can be both admission-admitted and
  hold-excluded; the frozen text picks neither extension. **The label is on the
  artifact so a void built on these numbers can be checked rather than trusted**,
  and it says the reading is the scorer's convention rather than the design's.
  `FINDINGS.md` F20. A LABEL, NOT A GUARD — nothing compares it.
- `identityHolds`: true when the three numerators sum to the pooled numerator
  within `1e-9`. Compute it; do not assume it.
- `meanOfPerObservationRatios`: the mean of `(t.sLo - t.oO) / (t.aO + t.sLo)` over
  `admitted`, guarding a zero denominator. **REPORTED AND DECIDING NOTHING** — it
  is the banned form, carried because the design says to publish it.
- `cappedVsUncapped`, `clampedVsSigned`, `rowsNetNegative`: derive from the rows
  on the admitted observations.
- `thresholds` is the literal `{ hold: 0.3, fall: 0.15 }`.
- `coverage`: the `RunTelemetryCoverage` the caller passed in, verbatim, on the
  artifact's face. Published whether or not `rHiPlus` was evaluable, and
  especially when it was not, because it carries the reason — and a reader can
  check the exactly-once claim against `unownedRows` instead of taking the
  totals on trust.
- `verdict` and `voidClause`: **VOIDS FIRST, THEN THE FALL, THEN THE HOLD.** The
  order is not cosmetic — a void discards the run and consumes an attempt
  (`voidConditions` 23), so a run that voids must never reach the fall arithmetic.
  In order, and each void naming its clause on the artifact:

  1. `admitted.length !== 20` — `voidConditions` 3 and `admissionRule` 2. Fewer
     voids by the clause; MORE is the manifest's selection made by the caller,
     since "the first 20 that admit, in that committed order, are scored" and this
     unit cannot see the committed order.
  2. the admitted set spans other than **exactly** one rate key — `voidConditions`
     10. Zero is as wrong as two.
  3. `selection.excludedWouldHaveAdded > admittedSumS`, or
     `excludedToolCalls > admittedToolCalls` — `voidConditions` 16. The first is
     sound in ONE direction only: the sum is a floor while `excludedUnsized > 0`,
     so exceeding proves the guard fired and not exceeding proves nothing. That
     leaves no hole — an unsized refusal on a dropped observation also makes
     `rHiPlus` refuse, so such a run reaches `open` below.
  4. both subagent strata evaluable, in DIFFERENT bands, and every refusal counter
     clean — `voidConditions` 17. "Clean" is every class count zero in every
     observation's OWNED ledger and in `coverage.unowned`. The cleanliness is half
     the condition: a run with refusals has an ordinary explanation for the strata
     parting.
  5. any recomputation on the opposite side of **15%** from its parent —
     `voidConditions` 18. Only that line voids.
  6. any prior run carrying no committed result — `voidConditions` 1.

  Then, and these are `open` rather than `void`:

  7. `rHiPlus` not evaluable. **The frozen text contradicts itself here and
     `design.metric` settles it**: "If any refused magnitude is `null`, `R_hi⁺` is
     NOT EVALUABLE and **the run returns `open`**." `voidConditions` 15 opens
     "VOID if" and then says "the run returns `open`, never a fall" in the same
     sentence; `fallsIf` says `open — provisional`. Two of the three name `open`,
     and it is the only reading that does not spend an irreplaceable attempt on an
     ambiguity.
  8. any of the four cells unevaluable. `admissionRule` 8 is explicit: an
     unevaluable stratum "returns `open`, never a hold, a fall, **or a void**."

  Then the fall:

  9. `rHiPlus < 15%` **and both subagent strata below 15%** → `"fallen"`.
  10. `rHiPlus < 15%` otherwise → **`"open — provisional"`**. The cells are pooled
      at the LO horizon while `R_hi⁺` is a doubt-credited HI figure, so they can
      sit on opposite sides of the line: 20 observations at
      `A_o = 100, O_o = 5, S_lo = 30, S_hi = 15` put every cell at 19.23% while
      `R_hi⁺` is 8.70%.

  Then `voidConditions` 18's **other half**, which is NOT a void:

  10a. any of the SAME FIVE on the opposite side of **30%** from **its own
       parent** — `rLo` for the three low forms, `rHi` for the two high ones —
       → `"open"`, "with both figures recorded", and it "does NOT consume the
       attempt cap". **Over the published figures, not the hold ones.**

       Build the `[name, value, parent]` list ONCE and read it at both thresholds.
       Clause 18 names one list and gives it two readings; two lists in the code
       is two chances to disagree, and the first attempt did exactly that — five
       recomputations at 15% and three at 30%, which narrowed a frozen clause to
       its low-side half without saying so.

       Written as a conjunct of the hold it can never fire: the conjuncts below
       already force `rLo` and all three low recomputations onto the same side of
       the line, and **no hold condition reads `R_hi` at all**, so a high-side
       straddle is invisible to every one of them. `FINDINGS.md` F22.

  Then the hold, and it is **always `"holding (unvalidated)"`**:

  11. `holdsIf` 1–6 all satisfied → `"holding (unvalidated)"`. `holdsIf` 7 is "the
      A/B ran and did not kill it", the A/B does not exist, and the design names
      the state for exactly that: "A never-run A/B leaves `holding (unvalidated)`,
      which is a real recorded state and **may not be cited as an input to opening
      or closing any gate**." Returning `open` there collapses a state the design
      provides into one it distinguishes from it.

      **EVERY RATIO IN THIS STEP IS A HOLD-DOMAIN RATIO.** `rLo` and `hold.rLo`
      are both `number`, both plausible, and differ only on runs carrying an
      ambiguous refusal — so the step takes a separate function whose input is the
      hold evidence alone, and the published figures are not in scope. A one-word
      slip is a compile error rather than a review question.

      ONE conjunct reads the ADMITTED set rather than the hold domain, and it
      says why: `holdsIf` 6 asks whether `unitsAddedByInstallation` was computed
      for every observation, which is a question about the instrument rather than
      an arithmetic over a domain — a non-finite `oO` is the omission wearing a
      number.

      **`holdsIf` 5 is NOT a conjunct here, and that is subsumption rather than
      omission** (`FINDINGS.md` F22, FIXED). Both halves are already true of any
      run that reaches the hold: `voidConditions` 16 voids on the exact
      complement of `excludedWouldHaveAdded <= admittedSumS`, so arriving here
      proves the `<=`; and `rHiPlus` iterates the admitted AND dropped sets and
      refuses on any unsized owned refusal, so `excludedUnsized > 0` returns
      `open` first. **The subsumption is exact for FINITE figures only** — a
      `NaN` would slip both the void and the conjunct, and nothing defends
      against one beyond `oO`. The disposition-split note stays where it applies,
      on `selection.basis` and `voidConditions` 16 above (`FINDINGS.md` F20,
      still open).
  12. otherwise `"open"`.

  **The bare `"holding"` is unreachable from this unit and that is correct**, not
  an omission: it requires an A/B that has not been built.

  **The F9 hold-side guard is subsumed, not missing.** A credited row no window
  owns raises `R_lo` when its magnitude is negative, so a guard was registered as
  owed to the hold branch. Written as a conjunct it can never decide anything —
  `rHiPlus` refuses on that exact fact, so step 7 has already returned. Proved by
  planting the defect: deleting the conjunct changed no test.

  Historical, kept because the reasoning still applies: `"fallen"` requires all
  four `strata` cells evaluable. `fallsIf` names it twice:
  a fall stands unappealed only if "both subagent strata are evaluable", and
  "a run with fewer than 20 admitted observations, or any stratum below 5, is
  VOID or `open` — never a fall on a short set". An unevaluable cell is exactly
  that case, whether it came from the 5-observation floor or from
  `unknownStratum`.

  **The hold branch now exists** — see the ordered rule above — and the guard this
  paragraph asked for turned out to be subsumed by step 7 rather than owed. The
  claim it corrected still stands: "omission deflates the hold, which is the safe
  direction" is FALSE, because magnitudes are signed and an omitted NEGATIVE
  credited row RAISES `R_lo`.

## Done when

`npx vitest run tests/b12-aggregate.test.ts` exits 0. Do not read that file.
