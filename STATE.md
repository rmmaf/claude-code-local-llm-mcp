# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B16 HOLDS.** `mac-20` and `mac-23`, both non-void, both with the window
verified at 32,768 — `mac-23` after the run as well as before, the check
`mac-21` lacked and was discarded for. **0 of 52 admitted requests lost
content**, against a >10% fall line and a hold condition of 0 over ≥ 20 across
≥ 2 runs, all pre-registered. **Read the caveats with it:** the two runs share a
corpus at temperature 0.1 where 12 of 13 cases reproduce byte-identically, so 52
is nearer n=1 replicated than n=2; and neither run refused anything, so nothing
here speaks to the refusal side. Not tightened after the fact, on purpose.

## Next action

**Nothing is blocked on B16 any more; pick from what it left open.** G7's
inflation risk is untouched — its two runs refused nothing, and the observed
over-refusal (`mac-16`) still carries no threshold, deliberately. Or settle the
oldest open point: **why the loss had that SHAPE.** Running out of room cuts a
response off at the end; that one came back properly closed with 81 lines gone
from the middle, which only prompt pruning produces — `truncateMiddle` or
`rollingWindow`, not `stopAtLimit`. GUI only.

## Do not redo

- **B16's `> 10%` and 20-request denominator are INHERITED from B14.**
  Re-deriving either destroys their only defence. The six runs are in-sample.
- **Resolve the MODEL first, then its window**; never borrow the window of a
  model nobody asked for; never pin one window across `repair` rounds.
- **The corrective retry needs its OWN pre-flight** — skipped, not sent.
- **Never sum `usage` against a window, fold `finish_reason` into `envelope`, or
  read absent `usage` as zero.** `repair` rows score the ENVELOPE half only.
