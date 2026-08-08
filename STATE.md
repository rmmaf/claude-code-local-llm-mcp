# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**A full doc-truth sweep landed, and PR #13 is open against `main`** — 79
commits, 61 files. Gate at the baseline 4, tsc green, run four times unchanged.
`b12-scorer-selftest.sh` ran on the Mac: 50 checks, exit 0. The PR body carries
what lands, what stays open by finding number, and what it deliberately omits.

- **The audit of my OWN corrections found 12 false claims, three of them high.**
  A confidently-worded wrong correction is worse than the vague text it
  replaced. That pass earned its place; run it again next time.
- **Cite by symbol, not by line.** The repo's own rule (`FINDINGS.md`, "cited by
  its text from here on") settled ~15 findings at once — and settled them
  AGAINST re-pinning numbers that rot again a week later.

## Next action

**DECIDE ITEM (c), AND FIRST.** `DECISIONS.md` § *The term the design promised,
and the one nobody charged for*: whether supplying `installedChars` is a repair
to the instrument or a change to a design frozen by hash — in which case the
rule is retract and re-register, not edit. The OWNER'S call, agreed 2026-08-08
to be taken next session. It blocks everything: sealing the manifest first
produces observations one-sided by construction, and UNIT 5 cannot close without
the input. (a) is half-answered — `computeTerms` charges the term, nothing
measures it. Hand the choice over as a table.

**`contract-stability`'s ladder is outside its own stated constraint.** It names
PATHS and the files grew under it: `report.ts` at 59,272 B now exceeds the
~51,607 B pre-flight ceiling. Re-pick the ladder before any run; do not re-type
its numbers.

## Do not redo

- **A RETRACTION CAN ROT.** README's two still asserted in the present tense a
  defect repaired days earlier, gated on a premise that can never hold. Fix the
  tense and the pointer; never delete the retraction itself.
- **Amendments here are append-only.** ROADMAP's "G1 remains `open`" was already
  false nine hours after it was written. The remedy is a dated erratum.
- **Never back-fill an append-only record.** Three run ids are missing from
  `MEASUREMENTS.jsonl`; writing them by hand today would fabricate provenance.
