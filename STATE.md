# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**The `repair` payloads exist** (`run 2026-08-03-mac-06`, archived under
`evidence/`). The previous run called them missing; telemetry writes
`rounds_used` under the name `turns_collapsed`. B3: 12 of 20, median 98.67%, and
3 of 11 calls made context *worse*. B6: 10 calls with a red gate, 2 closed, both
in one round, and 3 `max_rounds` calls that improved nothing over 10 rounds.
Two instrument fixes: a generation reads as `budget` only when it was cut off
*and* this call's deadline is what cut it — either signal alone mislabels — and
the per-round trace reaches telemetry, without which B7 was never measurable.

## Next action

**Decide B0's output contract before another B6 run.** While `shared.ts:78`
demands every editable file whole against an 8192-token cap, a truncated
response throws and is logged `model_failed`, indistinguishable from a loop that
genuinely failed. Every B6 number carries that until the contract changes or the
tools are scoped to small files in writing.

## Waiting on

- **The Mac's uncommitted `selectModelsBestFit`** — no push credentials there;
  route is `git show --format="" HEAD` pasted here, applied by hand.
- **B5 needs a different repository** — this one configures 2 checks.

## Do not redo

- **A field absent from the log is not absent from the code.** B6 ran on a
  narrative for a whole session because a grep for `rounds_used` missed the
  column holding exactly that under another name. Read the writer.
- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
