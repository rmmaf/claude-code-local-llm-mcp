# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**The last next-action rested on a false premise.** It said to rewrite `gate`'s
description — but that description **already** said "Prefer this over running
the commands through Bash", and it lost 36–0 in `run 2026-08-04-mac-10`. Worse:
`README.md` has always told users to install a `CLAUDE.md` carrying that same
rule, and **no `CLAUDE.md` existed anywhere**. mac-10 measured an unconfigured
install. The server now writes that file itself at startup
(`src/claude-md.ts`) — the cheap arm the roadmap's own rule demands first.

## Next action

**Run a real session on the Mac and score B15** — capture ≥ 50% holds, < 25%
falls, and a session with < 5 eligible verification events is VOID, not zero.
Two things must happen first: restart Claude Code twice (run 1 writes
`CLAUDE.md`, run 2 is the first that reads it), and build the standalone
transcript classifier — the cost meter discards each `Bash` call's `input`, so
it cannot compute the denominator and **must not be edited while G1 is open**.

## Do not redo

- **`gate`'s persuasion sentence is held byte-for-byte** as Arm 1's baseline.
  The description grew +114 tokens on truth fixes only; that number is B15's
  cost condition, so re-measure if it moves.
- **`repair` must not probe git** — its loop runs `gate` per round, and
  bookkeeping inside a budget is capped by what remains or skipped.
- **4 test failures are pre-existing and Windows-only** (CRLF, path separators);
  282 pass. Verify with `npm test`, never `npx vitest run`.
- **The roadmap is at seven gates, not six** — the count omitted reopened G1.
