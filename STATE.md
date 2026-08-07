# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**F12 and F9 are closed.** Gate at 4 failures, all four the pre-existing Windows
CRLF/path ones; tsc green; `SELFTEST OK — 50 checks passed`.

- **A fourth unit exists**, `src/cost/b12/coverage.ts` + `UNIT-4.md`. Row
  identity is `[artifact, ordinal]` because nothing on a telemetry row survives a
  null `invocation_id`. `rHiPlus(all, coverage)` now has FIVE refusals.
- **Step 1b is retired with the sum it guarded** — it was declared incomplete
  the day it landed, and a guard over a quantity nothing computes reads as
  protection while providing none.
- **Codex changed the design twice, and both were blockers.** `runCoverage`
  cannot take `ObservationTerms[]` alone (a row in no slice is invisible), and
  "one distinct non-null value" silently discarded the unknown beside it.
- **22 new assertions, all seen failing** on planted defects in six groups. Two
  landed on numbers written down first: `110/1110` and `−600/1400`.

## Next action

**F10, F14 and F17 remain**, none of them blocking. The bigger gap is that the
scorer is wired to NOTHING: `observation.json` has no parser,
`verificationStratum` is written by no harness, and the run-level assembler that
would call `runCoverage` and `aggregate` does not exist. That assembler is the
next real piece of work, and it is where `identify` gets its `source`.

## Do not redo

- **A control never seen failing is not a control.** Every one of the 22 passed
  on first execution. Three of an earlier seven were defective when written.
- **Two things I asserted and had backwards**, both caught by adjudication:
  omission does NOT reliably deflate the hold (magnitudes are signed, so an
  omitted negative row raises it), and a clean preflight does NOT imply the new
  refusals stay quiet — the frozen preflight screens for none of them (F17).
- **`tests/` was unchecked for the project's whole life**, and CI did not run the
  checking config after the local gate was fixed. Both closed.
- **Look for `as unknown as` before trusting any narrowing** — three casts in
  three files once stood between a type and the thing it should constrain.
