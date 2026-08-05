# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B17 IS PRE-REGISTERED, AMENDED ONCE, AND HAS ALREADY FOUND THREE DEFECTS** —
writing an admission rule precise enough for a second implementation is what
found them. **(1)** `listTranscripts` does a non-recursive `readdir`: 11 files at
the top level, 37 recursively, so a multi-agent session shows the meter 54.8% of
its cache reads. **(2)** `readUsage` books 278 cacheWrite-1h tokens against a
top-level zero. **(3)** The dedup keeps the FIRST record of a `requestId` group
and drops **655,570 output tokens, 19.27% of all output**, at the 5.0x rate.

## Next action

**Commit 2, alone:** `scripts/session-token-walk.mjs`, importing NOTHING from
`src/cost/`; group by `requestId` and take the LAST record — `stop_reason` does
not identify it, 27 groups carry none and 1,300 carry several. **Commit 3,
alone:** the three fixes above, `rates.ts` untouched. **Commit 4:** run over ≥ 5
sessions, ≥ 1 single-threaded, ≥ 1 with `workflows/` nesting, both JSON artifacts
into `evidence/`. **Yours:** G7's threshold, and B14's 3.978 vs 3.5.

## Do not redo

- **B17's admission rule may not change again.** Its clock moved once, before any
  residual was seen; a second move is the tuning its VOID condition prevents.
- **B16's `> 10%` and 20-request denominator are INHERITED from B14.** Rederiving
  either destroys their only defence. The six D8 runs are in-sample.
- **Resolve the MODEL first, then its window**; never borrow another model's;
  never pin one across `repair` rounds; the retry needs its own pre-flight.
- **Never read absent `usage` as zero, sum it against a window, or fold
  `finish_reason` into `envelope`.** `repair` rows score the ENVELOPE half only.
- **A negative result is only as good as the command that produced it.**
