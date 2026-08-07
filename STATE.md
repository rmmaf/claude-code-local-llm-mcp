# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**F1, F2a, F2b, F3, F8 and F15 are closed**, each moving a spec, an oracle and a
body together. Mechanisms in `FINDINGS.md`; registered in `PREMISES` first.

- **`CreditedRow` gained `unitsLo` and `passed`** and became a union on
  `disposition`, so a credited row's magnitudes are `number` and `?? 0` is
  unwritable. Control: two `Assert` aliases, in `src/` on purpose.
- **`ObservationTerms` gained `unattributedRefusals`** — two refusal classes
  no window could own, so `rHiPlus` was short by them.
- **`strata.ts` gained `unknownStratum`**, and `"fallen"` now needs all four
  cells evaluable — Codex's amendment, confirmed in `fallsIf`.
- **Gate: 27 = 18 baseline + 9.** tsc green, selftest 50. Pin → `3d27f08`.

## Next action

**Cheapest real win: type-check `tests/`** (F16). Measured at 14 errors in 3
files, none in the b12 oracles. Left undone because it changes `gate`.

**Two structural findings, neither an implementer's to fix.** `R_other` has no
source data — only `gate` and `repair` write telemetry (F13). And
`Σ_d R_d + R_other = R` is false by `O/(A+S)` when `O` ≠ 0 (F11).

**Standing decision, still the owner's:** exposure C, or stop Phase 3.

## Do not redo

- **NOTHING UNDER `tests/` IS TYPE-CHECKED.** `tsconfig.json` is `src/**` only
  and vitest transpiles, so "the API shape is pinned by tsc" was false wherever
  I wrote it. A compile-time control must live in `src/`.
- **A control never seen failing is not a control** — nine new assertions test
  stubs and fail on `not implemented` either way. **Three of the first seven were
  defective**, each passing on the defect it was aimed at.
- **"Duplication is the safe direction" was wrong** and I wrote it twice.
  `wouldHaveAdded` is signed, so a duplicated NEGATIVE refusal pushes `R_hi+`
  DOWN and manufactures a fall. Step 1b sees only the negative-class-sum case.
- **A control that fires on the clock says nothing:** `repair.test.ts` compared
  `JSON.stringify(result).length` across runs whose `model_ms` differ. And
  `git add -A` after a tool run committed a stray one-byte `test` file.
