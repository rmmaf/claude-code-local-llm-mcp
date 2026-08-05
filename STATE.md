# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B17 IS PRE-REGISTERED AND `/usage` IS OUT OF THE GATE.** B1's *Scope* failure
had a cause nobody looked for: since Claude Code 2.1.219 a session is N files and
`listTranscripts` does a non-recursive `readdir` — **11 at the top level, 37
recursively**, so a multi-agent session shows the meter 54.8% of its cache reads.
**G1's dollar condition is deleted, not satisfied** — a Max plan issues no
per-token invoice, so it was never meetable. B17 gates on **exact integer
equality** against Claude Code's own shipped enumerator: nothing to fit.

## Next action

**Commit 2, alone:** `scripts/session-token-walk.mjs`, the oracle, importing
NOTHING from `src/cost/`. **Commit 3, alone:** the `useSplit` fix first — 278
tokens booked against a top-level zero — then discovery, one vector per
`sessionId` not per file. **Commit 4:** ≥ 5 sessions, ≥ 1 single-threaded, ≥ 1
with `workflows/` nesting, both JSON artifacts into `evidence/`. **Yours:** G7's
threshold on `context_would_overflow`, and B14's 3.978 vs 3.5.

## Do not redo

- **B17's admission rule and oracle are FROZEN; the meter is not.** Editing
  either after the pre-registration commit voids the run.
- **B16's `> 10%` and 20-request denominator are INHERITED from B14.** Rederiving
  either destroys their only defence. The six D8 runs are in-sample.
- **Resolve the MODEL first, then its window**; never borrow another model's;
  never pin one across `repair` rounds; the retry needs its own pre-flight.
- **Never sum `usage` against a window, fold `finish_reason` into `envelope`, or
  read absent `usage` as zero.** `repair` rows score the ENVELOPE half only.
- **A negative result is only as good as the command that produced it.**
