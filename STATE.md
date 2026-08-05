# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B20 STATES THE ADMISSION RULE IN FULL — FOUR STEPS, IN ONE PLACE.** Nine
oracle defects across four reviews, all before anything was scored. The last
two: the `sessionId` guard fired only when the field was present, so it admitted
any record omitting it and did not implement the rule printed above it; and the
refutation of *broadening is safe* had landed in `PREMISES.md` while
`DECISIONS.md` still asserted it — both retracted in place now. Missing
`sessionId` is excluded **and** marks the session `suspect`: 0 of 5,595 records
lack it, so non-zero means the layout moved.

## Next action

**Commit 3, alone:** `src/cost/`, three fixes — `useSplit` consistency, the
`requestId` group taking the LAST record (**655,570 output tokens**, 19.27%, at
5.0x), and recursive discovery emitting one vector per `sessionId`. `rates.ts`
untouched. **Commit 4:** run over ≥ 5 non-void sessions, ≥ 1 single-threaded,
≥ 1 with nested agents; both JSON artifacts into `evidence/`. **Yours:** G7's
threshold, and B14's 3.978 vs 3.5.

## Do not redo

- **Build the fixture; assert nothing about the instrument.** And a refutation
  must reach every file carrying the claim, not just the one it was written in.
- **If the oracle needs another correction, G1 cannot close in this venue** —
  say so and decide on a stated non-metered basis. That is a permitted ending.
- **B16's `> 10%` and 20-request denominator are INHERITED from B14.** Rederiving
  either destroys their only defence. The six D8 runs are in-sample.
- **Resolve the MODEL first, then its window**; never pin one across `repair`
  rounds; the retry needs its own pre-flight.
