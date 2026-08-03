# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B1 fell and G1 reopened.** Meter $119.11 vs `/usage` $35.96 — +231% against
a 5% threshold, both read within a minute (`run 2026-08-03-win-04`). Two
independent failures: the meter counts 65% of `/usage`'s tokens for the same
session, and `/usage` reports exactly 20.0% of published list price for its
own tokens — the two sides never measured the same thing. The transcript is
internally consistent: dedup clean, no missing `requestId`, `iterations`
summing to the top level. `npm test`: **4 failed / 228 passed**.

## Next action

**Decide what the meter is compared against and pre-register it as its own
premise before measuring anything with it** — `/usage` is not a list-price
oracle. Then close the scope gap: the 35% of tokens it counts and the
transcript does not. Until the meter agrees nothing meter-derived counts
(B12, `savedFraction`). B6/B7 come from `repair`'s own payload and never touch
the meter, so the Mac is not blocked — `smoke-test` first, then `repair`.

## Waiting on

- A real local model → B6 and B7; `repair` has never met one
- **B5 needs a different repository** — this one configures 2 checks, so 1
  collapsed turn is its structural ceiling and a ≥ 2 threshold is unreachable
- B3 needs 19 more real `gate` calls; just keep verifying with `gate`

## Do not redo

- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
- Read timestamps from the clock in the command that writes them. Twice this
  session I typed one from memory and it landed in the future.
