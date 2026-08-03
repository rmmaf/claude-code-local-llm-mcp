# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B1 fell and G1 reopened.** Meter $119.11 vs `/usage` $35.96 — +231% against a
5% threshold (`run 2026-08-03-win-04`). Two independent failures: the meter sees
65% of `/usage`'s tokens for the same session, and `/usage` reports 20.0% of
list price for its own tokens — the two never measured the same quantity. The
transcript itself is consistent. `scripts/mac-check.sh` sets up and audits the
Mac; its first run cleared install/lms/server/status and flagged the catalog.

## Next action

**On the Mac: trim the generated catalog to coder models, then run `repair` on a
real failure.** B6 (`passed`, `rounds_used`) and B7 (`rounds[].model_latency_ms`,
`gate_ms`) come from `repair`'s own payload and never touch the meter, so G1
being reopened does not block them. Nothing meter-derived counts until the meter
agrees with a comparator pre-registered as its own premise — `/usage` is not a
list-price oracle.

## Waiting on

- **B5 needs a different repository** — this one configures 2 checks, so 1
  collapsed turn is its structural ceiling and a ≥ 2 threshold is unreachable
- B3 needs 19 more real `gate` calls; just keep verifying with `gate`

## Do not redo

- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
- Read timestamps from the clock in the command that writes them.
- **Never report an inferred cause as an observed one.** B2, `treeFingerprint`
  and four reviews of `mac-check.sh` were all this. Quote whatever actually
  knows, or say you did not look — a guessed reason reads as a finding.
