# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**Everything the Mac needs is committed, and the Mac has not run.** G-stop
amended a second time (two axes, the 15% governs one); instrument repaired
(`4a7eaac`); contract and oracle in (`cb436ed` — 13 tests, 13 red, every one on
`not implemented`); specs and runner in (`dab8db9`). Phase 3's threshold was
pre-registered (`efbe17a`) **before a single unit was attempted**.

## Next action

**Run `bash scripts/b12-scorer-mac.sh` on the Mac**, clean tree, nothing else on
the box. It refuses on a dirty tree, on `rates.json` that is not byte-identical
to `3541625`, on a context window under 32768, and on a missing spec; it reads
the window before AND after. Send back the one `.tgz` it names.

Then apply the bundle, review every body the local model wrote **before** it
reaches main, and write the `MEASUREMENTS.jsonl` row against the pre-registered
reading: ≥2 of 3 reachable · 0 of 3 amends B12's text before Phase 4 · exactly
1 of 3 is inconclusive and the manifest may not be sealed on it.

## Do not redo

A control never seen failing is not a control. Two of mine could not fail: one
reverted the wrong of two functions sharing a line; one asserted `> 0`, not a value.
