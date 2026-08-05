# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B16 has its first valid run and DOES NOT YET HOLD.**
`run 2026-08-04-mac-20-32k`, window verified at 32,768 before starting: **26
admitted, 26 complete, 0 lost content**, largest request 20,870 tokens clearing
the 20,644 non-void bar. That is 0% against a 10% fall line — but the hold
condition wants ≥ 2 non-void runs and this is one. `mac-19` is void.
**The elision turned out to be arithmetic:** the same file needs 10,321 output
tokens and had ~5,835 left at 16,384; at 32,768 it returns complete. That also
proves `mac-16`'s refusal of it was right, by measurement.

## Next action

**One more verified run and B16 holds.** Same command, new `--run-id`; the
window must be confirmed with `lms ps` before it starts, not declared.
Still open: **why the loss had that SHAPE.** Running out of room cuts a response
off at the end; this one came back properly closed with 81 lines gone from the
middle, which only prompt pruning produces — `truncateMiddle` or `rollingWindow`,
not `stopAtLimit`. Not readable from `lms ps` or any file under `~/.lmstudio`.
Read it in the GUI.

## Do not redo

- **B16's `> 10%` and 20-request denominator are INHERITED from B14.**
  Re-deriving either destroys their only defence. The six runs are in-sample.
- **Resolve the MODEL first, then its window**; never borrow the window of a
  model nobody asked for; never pin one window across `repair` rounds.
- **The corrective retry needs its OWN pre-flight** — skipped, not sent.
- **Never sum `usage` against a window, fold `finish_reason` into `envelope`, or
  read absent `usage` as zero.** `repair` rows score the ENVELOPE half only.
