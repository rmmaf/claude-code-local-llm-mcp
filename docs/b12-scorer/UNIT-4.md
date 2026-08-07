# UNIT 4 — `src/cost/b12/coverage.ts`

**Not part of the Phase-3 exposure.** Units 1–3 were the task the local model was
measured on; Phase 3 closed at 1 of 3 on 2026-08-07 and this unit was written
afterwards, by the orchestrator, to close `FINDINGS.md` F12 and F9. It is
specified here in the same form as the other three so the scorer has one
description per module and not three plus a conversation.

## What it exists to prevent

`R_hi⁺` is a sum over rows. Two independent defects meant the sum ran over the
wrong multiset:

- **Counted twice.** `scopeTelemetry` (`report.ts:828`) admits a row on an exact
  invocation-id match **or** on a ±60,000 ms window, so one physical row lands in
  two observations' slices whenever two arms ran within a minute. Summing each
  observation's unattributed ledger then counts it twice, and `wouldHaveAdded` is
  signed — a duplicated NEGATIVE magnitude pushes `R_hi⁺` down, toward a fall.
- **Counted zero times.** A credited row no window owns is dropped before `S_o`
  and before every refusal class (F9), so nothing sees it at all.

The fix is one run-level pass that resolves every physical row exactly once, and
refuses when it cannot.

## Row identity

`TelemetryRecord` has no field that identifies a row: `invocation_id` is optional
and absent on every row written before it existed, and two rows can otherwise be
byte-identical. Identity is therefore **(artifact, ordinal)** and is a property of
the READ, not of the row.

```
identify(source, records) -> records.map((record, ordinal) =>
  ({ key: JSON.stringify([source, ordinal]), record }))
```

`JSON.stringify([source, ordinal])` and **not** `${source}#${ordinal}`: a path may
contain `#`, and two different rows sharing a key is the one thing an identity may
not do.

`ordinal` is the index in the run's SINGLE read of that artifact. Read the log
once per run and derive every slice from that one array; a second read after an
append renumbers nothing that was already scored, but it is a different universe
and must not be mixed with the first.

## `runCoverage(universe, all): RunTelemetryCoverage`

`universe` is **every telemetry row the run produced**, identified — not the union
of the observations' slices. This is the argument the first design lacked and it
is load-bearing: `computeTerms` is handed a slice `scopeTelemetry` has already
narrowed, so a row outside every window is absent from every observation and a
coverage built from `ObservationTerms[]` alone cannot see that it exists.

The caller defines the universe. `scripts/b12-scorer-mac.sh:1138` already writes
exactly this set — the telemetry past a recorded byte baseline — to
`telemetry-slice.jsonl`.

In order:

1. Label each observation `${taskId}/${arm}`. Sort the labels; every tie below is
   broken in that order, so the output does not depend on the caller's array.
2. **Claims.** A key is CLAIMED by an observation when it appears in that
   observation's `rows` — the list `computeTerms` fills with the rows the window
   owns.
   - exactly one claimant → `ownedBy.set(key, label)`. It is that observation's
     row, at that observation's price, and **every other slice's price for it is
     discarded.** Without this, two arms a minute apart would put ordinary
     single-owner rows through the conflict rules below and refuse a run the
     design intends to score.
   - two or more claimants → `contested`. Assigned to none of them.
3. **Occurrences.** For every key, the list of `{label, row}` across all
   observations' `rows` and `unattributed` together.
4. `unsliced` = every key in `universe` with no occurrence.
5. **Unowned keys** — seen at least once, claimed by nobody. One `CoveredRow`
   each, resolved from its occurrences in this order, first match wins:
   - the occurrences carry more than one `disposition` → `conflict`, `units: null`;
   - any occurrence has `row.units === null` → `conflict`, `units: null`;
   - the non-null `row.units` values differ by more than `1e-9` → `conflict`,
     `units: null`;
   - otherwise `units` = that agreed value, `conflict: null`.

   `disposition` is the first occurrence's, in sorted label order. When `conflict`
   is non-null that choice is **arbitrary, deterministic and decides nothing** —
   the row is unsized, so `rHiPlus` refuses whichever class it was filed under.

   **A single number plus a null is a conflict, not an agreement.** Treating "one
   distinct non-null value" as agreement would discard the occurrence that could
   not be sized, which is the unknown-summed-as-zero collapse under another name.
6. **Derive** `unowned` (the four classes, over `unownedRows` whose disposition is
   not `credited`) and `unattributedCredited` (over those whose disposition is
   `credited`). `units` when it is a number, `unsized++` when it is null. Derived
   from the list, never accumulated beside it: a total that cannot name its rows
   cannot be checked against the exactly-once claim.
7. **`reasons`** — one string per run-level cause, in this order:
   `contested`; `unsliced`; `unattributedCredited.count > 0` (F9); `unsized > 0`
   in any class of `unowned`; `unattributedCredited.unsized > 0`.
8. `exactlyOnce = reasons.length === 0`.

## What is NOT here

- **No deduplication of an owned row.** Ownership already makes it unique.
- **No repair of any kind.** Every field is a report. The ledger's job is to say
  what it could not account for; `rHiPlus`'s job is to refuse rather than publish
  a figure over a set it cannot enumerate.
- **No new refusal class.** The four are frozen by `design.metric`. A conflicted
  row is unsized inside one of the four, and `unattributedCredited` is a separate
  count precisely because a credited row is in none of them.

## Done when

`npx vitest run tests/b12-coverage.test.ts` exits 0.
