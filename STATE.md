# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**The instrument is fixed and tested; the completion is pre-registered and not
yet run.** Nothing was measured — this was all harness.

- **Exposure B was INCOMPLETE/VOID, not the "1 of 3" its artifact printed.**
  `aggregate` never generated a token — both `repair` calls died in the backend.
  `strata` closed in round 1; `terms` reached one failing test of four with `tsc`
  green. Adding `report.ts` to `context_files` moved every mechanism.
- **Five Codex findings, 3 agents each, all 15 confirmed.** F4/F5 fixed here;
  F1/F2 are scorer-correctness and untouched on purpose — fixing them would edit
  the spec of the unit about to be attempted.
- **F5 (`ee7defb`):** `detail.context_files` did not exist — exposure B's central
  VOID could not fail. Read off the LOADED files, never off the argument.
- **F4 (`f6926b4`):** state came from the vitest exit code alone, so "ran and
  failed" and "never ran" were the same `red`. Now a per-unit telemetry window
  and six states; only `closed` counts. The fresh-exposure guard compares against
  the stub at `d0253e1`, not `git status` — which cannot see a body this script
  itself committed. `ea35254`: 39 self-test checks, extracted verbatim.

## Next action

**On the Mac** — load at 65,536, `git pull`, then:
```
git checkout d0253e1 -- src/cost/b12/aggregate.ts
B12_ONLY=aggregate B12_CARRIED_FROM=2026-08-06-mac-b12-phase3-f2932ff \
  bash scripts/b12-scorer-mac.sh
```
Expect: one unit attempted, artifact reads `partial` with no verdict, and
`contextFilesObserved` carrying `src/cost/report.ts` — exposure B's central
condition observed rather than declared, for the first time.

## Do not redo

- **A control never seen failing is not a control.** Every change here was
  reverted and re-run to watch the right checks fail — including the self-test's
  first draft, which reported four passes it had not earned because `refuse`
  writes to stderr and the capture dropped it.
- **`bash -n` parses; it does not expand.** Exercise every path, do not read it.
