# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**F9, F12, F10 and F14 are closed.** Gate at 4 failures, all four the pre-existing
Windows CRLF/path ones; tsc green; `SELFTEST OK — 50 checks passed`.

- **UNIT 4 exists** (`coverage.ts`): the exactly-once run ledger. Row identity is
  `[artifact, ordinal]`, because nothing on a telemetry row survives a null id.
- **The window join is five hops, not four.** It read every tool result while the
  crediting join reads gate/repair only, so a quoted id could be claimed.
- **The verdict had TWO of six states.** It checked no observation count, no rate
  basis, no selection guard, no recomputation, no register — six VOID clauses it
  had the data for — and collapsed `holding (unvalidated)` into `open`.
- **Two clauses of the frozen text contradict themselves.** `voidConditions` 15
  says "VOID" and "returns `open`" in one sentence; clause 3 does it to a short
  stratum. `design.metric` and `admissionRule` 8 settle them, by quotation.
- **33 new assertions across the day, every one seen failing** on planted defects.

## Next action

**F17 and F19 remain, and F19 is the one with teeth**: `admissionRule` 6 excludes
an `ambiguous > 0` observation from the HOLD arithmetic and the scorer includes
it. Conservative direction, so the hold branch shipped ahead of it.

The scorer is still wired to NOTHING: no parser for `observation.json`, nothing
writes `verificationStratum`, and the run-level assembler that would call
`runCoverage` and `aggregate` does not exist. That assembler is the next real
piece of work, and it is where `identify` gets its `source`.

## Do not redo

- **A control never seen failing is not a control**, and today it caught three
  bad fixtures of my own: a clause-18 case that fired clause 17 instead, a
  coverage-face case that passed with an empty set, and two defects in one group
  that cancelled each other.
- **A guard that cannot fail is not a guard.** Step 1b went with the sum it
  guarded; the F9 hold-side conjunct turned out subsumed by `rHiPlus`'s refusal —
  proved by deleting it and watching nothing break.
- **Things I asserted and had backwards**: omission does not reliably deflate the
  hold; a clean preflight does not imply the new refusals stay quiet (F17); "no
  hold branch because the A/B does not exist" ignored `holding (unvalidated)`.
