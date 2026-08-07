# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**F1, F2a, F2b, F3 and F8 are closed**, each moving a spec, an oracle and a body
together. Mechanisms in `FINDINGS.md`; registered in `PREMISES` before any run.

- **`CreditedRow` gained `unitsLo` and `passed`** — the low horizon, since
  `aggregate.ts` has no `rates` to rank rows for `R_lo⁻ʳ`; and the verdict, since
  `MIN_REPAIR_CLOSURES` counted what no type carried. **Absent is `null`.**
- **`ObservationTerms` gained `unattributedRefusals`** — two refusal classes
  could not be owned by a window, so `rHiPlus` was short by them.
- **`strata.ts` gained `unknownStratum`**, and `"fallen"` now needs all four
  cells evaluable — Codex's amendment, confirmed in `fallsIf`.
- **Gate: 27 = 18 baseline (14 stubs + 4 Windows CRLF) + 9 new.** tsc green,
  SELFTEST OK — 50 checks. `STUBS_FROZEN_AT` moved to `3d27f08`.

## Next action

**Two structural findings, neither an implementer's to fix.** `R_other` has no
source data — only `gate` and `repair` write telemetry, so five of its seven
tools emit nothing (F13). And `Σ_d R_d + R_other = R`, asserted by the frozen
design and computed by the artifact, is false by `O/(A+S)` when `O` ≠ 0 (F11).

**Standing decision, still the owner's:** exposure C, or stop Phase 3 on what it
has. It would measure a changed task — UNIT-3 grew, and it never closed.

## Do not redo

- **A control never seen failing is not a control** — and nine new assertions
  are NOT controls: they test stubs, so they fail on `not implemented` whether
  right or wrong. **Three of the first seven were defective**, each passing on
  the defect it was aimed at. Re-check by breaking a real body the day one lands.
- **"Duplication is the safe direction" was wrong** and I wrote it twice.
  `wouldHaveAdded` is signed, so a duplicated NEGATIVE refusal pushes `R_hi+`
  DOWN and manufactures a fall. `UNIT-3` step 1b refuses on a negative class sum
  — the only case the types see; a zero sum hiding ±100 still passes.
- **A control that fires on the clock says nothing.** `repair.test.ts` compared
  `JSON.stringify(result).length` across runs whose `model_ms` differ — 656 vs
  657, passing on luck until today. `now` is injected now.
- **`git add -A` after a tool run committed a stray one-byte `test` file.**
