# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**Exposure B is complete and reads 1 of 3 — INCONCLUSIVE.** The pre-registered
branch for exactly one: the manifest may not be sealed on it.

- **`aggregate` is RED, and it is the first real observation it has ever had.**
  `run 2026-08-07-mac-b12-phase3-c40e9f4`, US$ 0.42. Two `repair` calls, 4
  attempts, every envelope complete, no backend failure, **`voids: []`** — model
  and all three context files verified from telemetry. Exposure B's central
  condition was observed rather than declared, for the first time.
- **It never beat the stub:** 10 → 20 and 10 → 18, round 2 changed nothing. The
  empty diff IS the measurement — `best` starts at the original bytes.
- **`report.ts` helped it too, and not enough.** Damage roughly halved against
  exposure A on the same unit (10 → 28, 10 → 25).
- **Re-emission is now four for four.** Round 2's completion is the same length
  as round 1's (3306/3306, 3419/3419) against a prompt 2,300 tokens larger.
- **The instrument found a limitation in the registered condition.** Both calls
  stopped on `budget`, round 3 timing out: `aggregate` got TWO productive rounds
  where the prompt says three. Cause measured, not guessed — its rounds cost
  106–132 s because it writes ~3,400 completion tokens, twice `terms`' ~1,700,
  against `repair`'s default 300 s. **Not the window:** its prompt is within 4%
  of `terms`', and its rounds cost 128–132 s at 32,768 too.

## Next action

**Pin `budget_seconds` before the next exposure and register it.** It is an
unregistered free parameter that silently truncates the registered `max_rounds`
on any unit whose output is large. At ~130 s/round, three rounds of `aggregate`
needs ≥ 450 s.

Then the open work, in order: **F1 and F2** (scorer correctness — deflated
`rHiPlus`, and `UNIT-3`'s two unimplementable guards), and **review `strata.ts`**
— the local model's body, on this branch and not yet read by me, which must not
reach `main` unreviewed.

## Do not redo

- **A control never seen failing is not a control.** Every harness change this
  session was reverted and re-run to watch the right checks fail.
- **The session's narration is not the measurement.** It reported the diff as
  "discarded along with the rollback"; it was empty because nothing beat the stub.
