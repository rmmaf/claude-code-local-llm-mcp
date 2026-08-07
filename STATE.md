# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**The B12 scorer is implemented and green.** Gate is at 4 failures, and all four
are the pre-existing Windows CRLF/path ones. Every b12 test passes; tsc green.
Baseline was 27 this morning.

- **Phase 3 closed at 1 of 3, deliberately**, with a second opinion asked to
  attack the decision. The cost is recorded: the registered rule says exactly
  1 of 3 needs more exposure, so that question is left UNRESOLVED, not answered.
- **F11 and F13 ship as findings, not amendments.** `R_other` reads
  `unexercised` and `identityHolds` reads `false`, both declared in PREMISES
  before the run. B20's rule repairs the INSTRUMENT, not the estimand.
- **All nine `UNPROVED CONTROL` assertions were re-checked** by planting nine
  defects in three groups. Every one fired for its own reason.
- **F1, F2a, F2b, F3, F8, F15, F16 closed** earlier in the day.

## Next action

**F9, F10, F12, F14 remain** — ordinary implementation, no decision inside them.
F12's run-level exactly-once ledger is the biggest and closes F9 with it.

Nothing in `src/cost/b12/` is wired to a CLI or a reader yet: `observation.json`
has no parser, and `verificationStratum` is not written by the harness at all.

## Do not redo

- **A control never seen failing is not a control.** THREE of the first seven new
  assertions were defective when written, each passing on the defect it was aimed
  at. A fourth defect was in the fixture: `withToolUse` dropped the
  `cache_creation` split, so a write priced at 1.25x while the file promised 2.0x.
- **`tests/` was unchecked for the project's whole life**, and CI still did not
  run the checking config after I fixed the local gate. Both closed.
- **"Duplication is the safe direction" was wrong** — `wouldHaveAdded` is signed,
  so a duplicated NEGATIVE refusal manufactures a fall.
- **Three casts in three files** stood between a type and the thing it should
  constrain. Look for `as unknown as` before trusting any narrowing.
