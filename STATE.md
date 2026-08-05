# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B20 FREEZES THE THRESHOLDS; THE ENUMERATION IS REPAIRABLE AND MUST BE EXACT.**
Seven oracle defects across three reviews, all before anything was scored, all
false negatives or false artifacts. The last refuted a claim B20 made in its own
text — *broadening can only make the oracle count more*. **False**: step 3 is
last-write-wins, not a sum, so a stray `.jsonl` with an early partial copy read
**695 → 5**, the direction that HOLDS the premise on a broken meter. Guarded by
matching `sessionId`, and a `requestId` group spanning files marks the session
`suspect` and refuses to score. B17/B19 `moot`; thresholds verified untouched.

## Next action

**Commit 3, alone:** `src/cost/`, three fixes — `useSplit` consistency, the
`requestId` group taking the LAST record (**655,570 output tokens**, 19.27%, at
5.0x), and recursive discovery emitting one vector per `sessionId`. `rates.ts`
untouched. **Commit 4:** run over ≥ 5 non-void sessions, ≥ 1 single-threaded,
≥ 1 with nested agents; both JSON artifacts into `evidence/`. **Yours:** G7's
threshold, and B14's 3.978 vs 3.5.

## Do not redo

- **Assert nothing about the instrument — build the fixture.** Five of the seven
  defects were properties I claimed instead of measured.
- **If the oracle needs another correction, G1 cannot close in this venue** —
  say so and decide on a stated non-metered basis. That is a permitted ending.
- **B16's `> 10%` and 20-request denominator are INHERITED from B14.** Rederiving
  either destroys their only defence. The six D8 runs are in-sample.
- **Resolve the MODEL first, then its window**; never pin one across `repair`
  rounds; the retry needs its own pre-flight.
