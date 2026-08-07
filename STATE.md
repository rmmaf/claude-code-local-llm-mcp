# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**F1, F2a, F2b, F3 and F8 are closed**, each moving a spec, an oracle and a body
together. Mechanisms in `docs/b12-scorer/FINDINGS.md`; the condition change is
registered in `PREMISES` before any run can happen under it.

- **`CreditedRow` gained `unitsLo` and `passed`** — the low horizon, since
  `aggregate.ts` has no `rates` to rank rows for `R_lo⁻ʳ`; and the verdict, since
  `MIN_REPAIR_CLOSURES` counted what no type carried. **Absent is `null`.**
- **`ObservationTerms` gained `unattributedRefusals`.** Two of the four refusal
  classes could never be owned by a window, so `rHiPlus` was short by two.
- **`strata.ts` gained `unknownStratum`**, and `"fallen"` now needs all four
  cells evaluable — Codex's amendment, confirmed in `fallsIf`.
- **Gate: 25 = 18 baseline (14 stubs + 4 Windows CRLF) + 7 new.** tsc green,
  SELFTEST OK — 50 checks. `STUBS_FROZEN_AT` moved to `3d27f08`.

## Next action

**The two structural findings are the interesting ones and neither is an
implementer's to fix.** `R_other` has no source data — only `gate` and `repair`
write telemetry, so five of its seven tools emit nothing (F13). And
`Σ_d R_d + R_other = R`, asserted by the frozen design and computed by the
artifact, is false by `O/(A+S)` whenever `O` is non-zero (F11).

**Standing decision, still the owner's:** exposure C, or stop Phase 3 on what it
has. It would measure a changed task — UNIT-3 grew, and it never closed.

## Do not redo

- **A control never seen failing is not a control** — and seven new assertions
  are NOT controls yet: they test stubs, so they fail on `not implemented`
  whether right or wrong. Marked `UNPROVED CONTROL`; re-check by breaking a real
  body the day one lands.
- **A control that fires on the clock says nothing.** `repair.test.ts` compared
  `JSON.stringify(result).length` across runs whose `model_ms` differ — 656 vs
  657, passing on luck until today. `now` is injected now.
- **Codex sharpened two claims and I weakened them:** `excludedForeign` is
  practically, not provably, unownable (F10), and omission deflates only when the
  magnitude is positive — `wouldHaveAdded` is signed.
