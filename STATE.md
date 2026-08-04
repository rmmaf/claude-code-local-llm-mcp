# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B0's disposition shipped, verified on a real server** (`run 2026-08-04-mac-08`):
the tools are scoped, they say so, and the output contract is unchanged.
`enforceOutputCap` estimates the whole-file answer for the editable files and
refuses before anything is read — from `runGeneration` and, separately, from
`runRepair` before the loop. **That unblocks B6:** a truncation now costs zero
rounds and writes no telemetry row, so it cannot pass as a loop failure.

## Next action

**The corpus of 20 real mechanical failures, which nothing blocks now.** It
settles four things at once: B6's close rate, B7's median (recording the
cold/warm split — a cold round costs ~6x a warm one), **B14** (a request that
passes the pre-flight and truncates anyway; falls above 10%), and **G7**
(search/replace contract; opens at ≥ 40% refused, dies below 20%, base rate 15%).
Read B14 before G7 — a pre-flight that is too strict inflates the refusal count.

## Waiting on

- **The Mac's `selectModelsBestFit`** — committed as `2fabd32` on branch
  `wip/select-models-best-fit`, unpushed and now needing a rebase; no credentials.
- **B5 needs a different repository** — this one configures 2 checks.

## Do not redo

- **Read the per-request ceiling from the run, never from the environment.** The
  setup shell exported 60000 while the server used 20000, from the MCP server's
  `env` in `~/.claude.json` — a shell export cannot reach it.
- **`tests/` is not type-checked** (`tsconfig` includes `src/**` only), so a new
  `Config` field missing from `testConfig` becomes NaN at runtime, not an error.
- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
