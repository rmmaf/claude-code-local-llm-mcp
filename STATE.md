# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**Exposure B is complete and reads 1 of 3 — INCONCLUSIVE.** The pre-registered
branch for exactly one: the manifest may not be sealed on it.

- **`aggregate` is RED, and it is the first real observation it has ever had.**
  `run 2026-08-07-mac-b12-phase3-c40e9f4`, US$ 0.42. Two `repair` calls, 4
  attempts, every envelope complete, no backend failure, **`voids: []`** — model
  and context files verified from telemetry, the condition observed at last.
- **It never beat the stub:** 10 → 20 and 10 → 18, round 2 changed nothing. The
  empty diff IS the measurement — `best` starts at the original bytes. `report.ts`
  helped here too and not enough: exposure A was 10 → 28 and 10 → 25.
- **Re-emission is now four for four.** Round 2's completion is the same length
  as round 1's (3306/3306, 3419/3419) against a prompt 2,300 tokens larger.
- **The instrument found a limitation in the registered condition (F7):** both
  calls stopped on `budget`, so `aggregate` got two productive rounds of three.

## Next action

**`docs/b12-scorer/FINDINGS.md` holds every open defect, each mechanism
re-checked against the files.** Six open, two closed. Next is the scorer-
correctness pass — **F1** (two of four refusal classes structurally unpopulated,
deflating `rHiPlus`), **F2a/F2b**, **F3**, **F6** — each moving a spec, an oracle
and a body together.

**F7 first, because it gates the next exposure:** pin `budget_seconds`. At
~130 s/round, three rounds of `aggregate` needs ≥ 450 s; 600 s matches the MCP
config. Do not re-run a unit that already has an observation to give it the
rounds it should have had — that is a second draw.

`strata.ts` is **reviewed and accepted**: correct against `UNIT-1.md` step for
step, F3 its one deferred finding.

## Do not redo

- **A control never seen failing is not a control.** Every harness change this
  session was reverted and re-run to watch the right checks fail.
- **The session's narration is not the measurement.** It reported the diff as
  "discarded along with the rollback"; it was empty because nothing beat the stub.
