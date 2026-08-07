# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**F19 is closed and the run now has TWO domains.** Gate at 4 failures, all
pre-existing Windows CRLF/path; tsc green; SELFTEST OK.

- **`admissionRule` 6 was not implemented at all.** An `ambiguous > 0` observation
  is "admitted to the FALL arithmetic only" and was in the hold too. `rLo` and
  `hold.rLo` are two numbers now; whoever quotes one must say which.
- **The finding's own safety claim was FALSE** — removal raises a ratio of sums
  iff the removed local ratio is below the pool, which a refusal does not say.
- **THREE guards here could not fire** — clause 18's 30% half (F22) and both
  halves of `holdsIf` 5, each proved by the ordering above it.

## Next action

**F17, F20, F21, F23, F25 OPEN** — five routes to closing them adjudicated, all
refused. F23: clause 8 wants two BRACKETS, the artifact carries two byte sums.

**F24 BLOCKS EVERYTHING ELSE.** `design.artifacts` 6 wants the lineage records,
the telemetry window verbatim, the id set and per-file sha256 per observation;
`b12-run.mjs` writes four files and none of it. **A run executed today cannot be
re-scored** — the failure the archive exists to prevent. Harness, not scorer.

`UNIT-5.md` is gated and revised: REFUTE, now split archive/assemble/emitter, and
nothing in it throws — `admissionRule` 1 owes a result artifact even on a VOID.

## Do not redo

- **A control never seen failing is not a control.** Ten new assertions all green
  on first run; eleven planted defects, one at a time.
- **Ask of every new conjunct what run reaches it with the conjunct false.**
  Fixing a guard that could not fire, I narrowed the clause to its low half.
- **A test title is a claim**, and one of mine covered the wrong branch.
- **Codex refuted seven of my readings across five rounds, correctly each time.**
  Verify its citations, then concede — arguing one cost a whole round.
- **Line-number citations rot**: two in `FINDINGS.md` were wrong within two days,
  one of them the note whose job was correcting a line number.
- **Under load the `vcsRunner` fix's 49× margin vanishes**: 146 ms → 5196 ms with
  four background jobs. Check load before believing a `STACK_TRACE_ERROR`.
