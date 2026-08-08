# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**A full doc-truth sweep landed** — every comment, docstring and markdown file
checked against the code it describes, in two rounds, each finding refuted
adversarially first. Gate at the baseline 4, tsc green. 81 of 101 round-1
candidates survived; 18 more in round 2.

- **The audit of my OWN corrections found 12 false claims, three of them high.**
  A confidently-worded wrong correction is worse than the vague text it
  replaced. Round 2 existed for that, and it earned its place.
- **Cite by symbol, not by line.** The repo's own rule (`FINDINGS.md`, "cited by
  its text from here on") settled ~15 findings at once — and settled them
  AGAINST re-pinning numbers that rot again a week later.
- **Three dead exports removed**: `serializeChecks`, `statusInputSchema`, and
  `repair.ts`'s `ToolError` re-export, whose comment named a phantom consumer.

## Next action

**`contract-stability`'s ladder is outside its own stated constraint.** It names
PATHS and the files grew under it: `report.ts` at 59,272 B now exceeds the
~51,607 B pre-flight ceiling, so L9 would measure a request the server refuses
to send. Re-pick the ladder before any future run; do not re-type its numbers.

**Two byte-identical duplications found, deliberately NOT fixed** — a refactor,
not a doc pass: `wordCap` (scaffold/shared) and `emptyLedger` (coverage/terms).

**`b12-scorer-selftest.sh` RAN and passed** — 50 checks, exit 0, on the Mac at
`29ef22b`, including `a pin that is not actually a stub refuses`, the one the
guard's rewritten refusal could have broken.

## Do not redo

- **A RETRACTION CAN ROT.** README's two still asserted in the present tense a
  defect repaired days earlier, gated on a premise that can never hold. Fix the
  tense and the pointer; never delete the retraction itself.
- **Amendments here are append-only.** ROADMAP's "G1 remains `open`" was already
  false nine hours after it was written. The remedy is a dated erratum.
- **Never back-fill an append-only record.** Three run ids are missing from
  `MEASUREMENTS.jsonl`; writing them by hand today would fabricate provenance.
