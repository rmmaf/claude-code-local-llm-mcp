# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**THE ORACLE EXISTS AND B19 REPLACES B17.** `scripts/session-token-walk.mjs`
counts a session's four token classes independently of `src/cost/`. B17 went
`moot` on two defects review found before it scored anything: its invariant
**could not fail** — per-source `uuid` sets filled after the dedup guard, so a
collision reported `holds: true` while dropping the subagent's request — and its
`cacheWrite` took `max(total, split)` where the repair takes `total`, **42,558
tokens** of its own making. Fixing both edited the file B17 had frozen, voiding
it. B19 inherits outcome, threshold and admission rule **verbatim**, at `9078a49`.

## Next action

**Commit 3, alone:** `src/cost/`, three fixes — `useSplit` consistency, the
`requestId` group taking the LAST record (**655,570 output tokens**, 19.27%, at
5.0x), and recursive discovery emitting one vector per `sessionId`. `rates.ts`
untouched. **Commit 4:** run over ≥ 5 sessions, ≥ 1 single-threaded, ≥ 1 with
`workflows/` nesting, both JSON artifacts into `evidence/`. **Yours:** G7's
threshold, and B14's 3.978 vs 3.5.

## Do not redo

- **B19's admission rule and oracle are frozen by SHA, not by date** — a date
  froze B17's defects along with it. One more replacement, total.
- **An invariant must be shown to fail before it is cited.**
  `tests/session-token-walk.test.ts` holds the corpus where it does.
- **B16's `> 10%` and 20-request denominator are INHERITED from B14.** Rederiving
  either destroys their only defence. The six D8 runs are in-sample.
- **Resolve the MODEL first, then its window**; never pin one across `repair`
  rounds; the retry needs its own pre-flight.
