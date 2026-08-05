# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B16 HOLDS.** `mac-20` and `mac-23`, both non-void, window verified at 32,768 —
`mac-23` after the run as well as before, the check `mac-21` was discarded for.
**0 of 52 admitted requests lost content**, against a >10% fall line and a hold
condition of 0 over ≥ 20 across ≥ 2 runs, all pre-registered. **Read the caveats
with it:** both runs share a corpus at temperature 0.1 where 12 of 13 cases
reproduce byte-identically, so 52 is nearer n=1 replicated than n=2; and neither
refused anything, so nothing here speaks to the refusal side.

## Next action

**The oldest open point is CLOSED: the policy is `truncateMiddle`**, read via
the `@lmstudio/sdk` after six dead ends. It drops the MIDDLE of the context, so a
model copying a file out of the prompt loses its own source and closes the block
normally — the properly closed tag, the 81 middle lines, `stop`, and the
identical retry prompt count, all one mechanism. The pre-flight already prevents
it; what this establishes is that **a wrong window fails silently by design**.
**Left open, and both are yours:** G7's threshold on `context_would_overflow`
(base rate now known, 33% at 16k / 7% at 32k), and B14's 3.978 vs 3.5.

## Do not redo

- **B16's `> 10%` and 20-request denominator are INHERITED from B14.**
  Re-deriving either destroys their only defence. The six runs are in-sample.
- **Resolve the MODEL first, then its window**; never borrow the window of a
  model nobody asked for; never pin one window across `repair` rounds.
- **The corrective retry needs its OWN pre-flight** — skipped, not sent.
- **Never sum `usage` against a window, fold `finish_reason` into `envelope`, or
  read absent `usage` as zero.** `repair` rows score the ENVELOPE half only.
