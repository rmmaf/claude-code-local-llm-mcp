# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B14 is `moot`; B16 replaces it, and the pre-flight now has a negative
control.** `run 2026-08-04-mac-19-32k` declared a 32,768 window while the model
ran at **16,384**. Same corpus, same model, same real window as `mac-16`/`-17`;
only the declaration differed. **Told the truth: 2 refused, 0 elided. Told
double: 0 refused, 1 elided.** First causal evidence the check works. The run is
VOID for B16 — a misinformed pre-flight is a misconfiguration under test — and
that VOID condition was added after seeing it, and says so. Of the two honest
refusals, G3 would have succeeded and L10 would have lost content: 1-1.

## Next action

**Run `contract-stability` at a VERIFIED 32,768** for the first valid B16 score
— the Mac is already loaded there. The interesting case is L10 (43,594 B),
which at 32k is admitted honestly instead of by mistake.
`contextOverflowPolicy` is app state — not in `lms ps`, not in any file under
`~/.lmstudio`, rejected by the OpenAI endpoint — but the token accounting now
points at **pruning**: the retry reported an identical prompt count after ~6,000
tokens were appended, and still generated ~5,900. Read the GUI to settle it.

## Do not redo

- **B16's `> 10%` and 20-request denominator are INHERITED from B14.**
  Re-deriving either destroys their only defence. The six runs are in-sample.
- **Resolve the MODEL first, then its window**; never borrow the window of a
  model nobody asked for; never pin one window across `repair` rounds.
- **The corrective retry needs its OWN pre-flight** — skipped, not sent.
- **Never sum `usage` against a window, fold `finish_reason` into `envelope`, or
  read absent `usage` as zero.** `repair` rows score the ENVELOPE half only.
