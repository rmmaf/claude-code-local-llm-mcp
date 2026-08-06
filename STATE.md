# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**The pre-flight passed on the Mac** (`2eab63d`, 11/11, artifact in `evidence/`)
and **three decisions that had outlived every technical blocker are closed**, all
while their answers were still unknowable — the only condition that makes closing
them mean anything. G-stop no longer names the meter as a delivery that must pay:
**two now, `gate` and `repair`**. G7 gets no threshold on
`context_would_overflow`, ever. B14 stays at **3.5**. Live warning from the
pre-flight: `gate` scored **−467.1 units** — it cost more than it suppressed.

## Next action, in this order

1. **Write the scorer.** `R_ab` exists in the frozen design and in NO `.ts`,
   `.mjs` or `.md` file. `observe()` writes observations; nothing reads them.
   45 sessions would finish with no number. It must compute **subagent share per
   arm** (G-stop requires it; `observe()` records no such field, but it is
   derivable from `originatedRequestIds` + `isSidechain`, `report.ts:198`).
2. **Then one paired observation**, smallest real task, both arms, ~2 sessions.
   Score it with the scorer written in 1. Only then seal and run the rest.
3. **Author the scorer through `repair`** — its mechanical parts are exactly what
   it is for, and G-stop's second delivery has one call of exposure in its life.

Not blocking B12: the meter's `savedFraction` credits suppression and never
charges installation, and `unitsAddedByInstallation` is written, tested, called
from nothing. Magnitude in doubt too — the scratch session called `ToolSearch`.

## Do not redo

- **Test the good values, not one bad one.** `[ "$X" = "none" ]` passed when the
  probe failed and `X` was `""`, and printed `ok` for an empty answer.
- **A passing test makes an unwired function look finished.** Twice now.
