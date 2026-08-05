# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B16 HOLDS** — 0 of 52 admitted requests lost content across `mac-20` and
`mac-23`, both non-void, window verified at 32,768 before *and* after. Caveats
travel with the verdict: both share a corpus at temperature 0.1 where 12 of 13
cases reproduce byte-identically, so 52 is nearer n=1 replicated than n=2, and
neither refused anything. **The oldest open point closed too** — the overflow
policy is `truncateMiddle`, read via `@lmstudio/sdk` after six dead ends. It
drops the MIDDLE of the context: a wrong window fails silently by design.

## Next action

**Unblocked:** B15 still needs `scripts/classify-verification.mjs` — standalone,
read-only over a raw session JSONL, counting eligible verification events. It
must NOT live in `src/cost/`, which is frozen while G1 is reopened.
**Yours to decide:** G7's threshold on `context_would_overflow` (base rate known
— 33% at 16k, 7% at 32k, so it is a function of the window), and B14's 3.978 vs
3.5. **Mac as left:** loaded at 32,768 with JIT on, so any unload silently
returns it to 16,384.

## Do not redo

- **B16's `> 10%` and 20-request denominator are INHERITED from B14.** Rederiving
  either destroys their only defence. The six D8 runs are in-sample.
- **Resolve the MODEL first, then its window**; never borrow another model's;
  never pin one across `repair` rounds; the retry needs its own pre-flight.
- **Never sum `usage` against a window, fold `finish_reason` into `envelope`, or
  read absent `usage` as zero.** `repair` rows score the ENVELOPE half only.
- **A negative result is only as good as the command that produced it** —
  `grep -I` skips binaries, zsh aborts a whole line on an unmatched glob.
