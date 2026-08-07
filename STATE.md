# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**F9, F12, F10 and F14 are closed.** Gate at 4 failures, all pre-existing Windows
CRLF/path; tsc green; `SELFTEST OK — 50 checks passed`.

- **UNIT 4 exists** (`coverage.ts`): the exactly-once run ledger, keyed
  `[artifact, ordinal]` — nothing on a telemetry row survives a null id.
- **The window join is five hops, not four** — it read every tool result while
  the crediting join reads gate/repair only, so a quoted id could be claimed.
- **The verdict had TWO of six states.** No observation count, rate basis,
  selection guard, recomputation or register — six VOID clauses it had the data
  for — and `holding (unvalidated)` collapsed into `open`.
- **Two frozen clauses contradict themselves** — 15 says "VOID" and "returns
  `open`" in one sentence, 3 does it to a short stratum. `design.metric` and
  `admissionRule` 8 settle them by quotation.

## Next action

**F17 and F19 remain, F19 with teeth**: `admissionRule` 6 excludes an
`ambiguous > 0` observation from the HOLD arithmetic and the scorer includes it —
conservative direction, so the hold branch shipped ahead of it.

The scorer is wired to NOTHING: no parser for `observation.json`, nothing writes
`verificationStratum`, no run-level assembler — the next real piece of work, and
where `identify` gets its `source`.

## Do not redo

- **A control never seen failing is not a control** — it caught three bad
  fixtures of my own, one firing the wrong VOID clause.
- **A guard that cannot fail is not a guard.** Step 1b went with the sum it
  guarded; the F9 hold-side conjunct was subsumed by `rHiPlus`, proved by
  deleting it and watching nothing break.
- **Things I asserted and had backwards**: omission does not reliably deflate the
  hold; a clean preflight does not imply the new refusals stay quiet (F17); "no
  hold branch because the A/B exists nowhere" ignored `holding (unvalidated)`.
- **A stubbed `processRunner` does NOT stub `vcsRunner`.** 42 repair tests shelled
  out to real `git` — 179 ms of a 214 ms call, reading whatever repo `%TEMP%` sits
  under. Look for a second runner before believing a test is isolated.
