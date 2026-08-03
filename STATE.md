# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**The Mac is green end to end** (`run 2026-08-03-mac-02`): install, `lms`,
server, status, a coder-only catalog with 4 of 4 models matched and sized, the
smoke test, and the full suite. The `<file>`-block contract is verified against
a real local model. The one red test was a Windows path literal, fixed in
`3c6242a`; the real slugs there confirm the one platform-dependent half.
**B1 fell and G1 reopened**: meter $119.11 vs `/usage` $35.96, +231% against a
5% threshold, and the two never measured the same quantity.

## Next action

**Run a task on the Mac that delegates the writing to the local model.** The
first session there produced two real `gate` calls (99.46% each, B3 now has 3
of the 20 it asks for) but **no `repair` data at all**: both gates passed, so
no failure ever existed to close, and no local-model tool ran. B6 and B7 need
a task whose correctness is not reachable in one pass. Record which model ran —
free RAM moved 28.2 → 15.6 → 27.8 GB across runs and at 15.6 the pick silently
changed from the 30B to the 14B.

## Waiting on

- **B5 needs a different repository** — this one configures 2 checks, so 1
  collapsed turn is its structural ceiling and a ≥ 2 threshold is unreachable
- B3 needs 19 more real `gate` calls; just keep verifying with `gate`

## Do not redo

- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
- **Never report an inferred cause as an observed one.** Ten reviews of
  `mac-check.sh` were all this, and the last one hit the *justification*, not
  the code. Quote whatever actually knows, or say you did not look.
