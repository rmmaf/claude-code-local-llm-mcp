# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**Corpus #1 is built and unrun; the capture hook for corpus #2 is live.** A red
`gate` now archives the `Failure[]` it parses to `.local-coder/corpus/` with the
tree state to replay it — the third field on this branch the caller saw and the
log did not, after `rounds[]` and `model`. `scripts/corpus-run.sh` drives 20
synthetic tasks **one on disk at a time**: twenty broken fixtures at once would
put each other's failures in every gate run and `repair` would never reach green.
All 20 were verified — one tsc error each, or one failing assertion each.

## Next action

**Run corpus #1 on the Mac:** `setup`, paste the one prompt it prints, `check`.
It hard-stops if `tsc` or `npm test` is already red, which is the precondition
most likely to be wrong there. It yields B6's close rate, B7's median with the
cold/warm split, and B14's truncation count — **not G7**, whose denominator was
amended to the *captured* corpus before any data existed, because a synthetic
corpus lets its own author choose the refusal rate that decides the gate.

## Waiting on

- **The Mac's `selectModelsBestFit`** — `2fabd32` on `wip/select-models-best-fit`,
  unpushed, needs a rebase; no credentials there.
- **B5 needs another repo** — 2 checks, no linter, so B6's lint category is out too.

## Do not redo

- **Read the per-request ceiling from the run, never from the environment.** The
  MCP server's `env` lives in `~/.claude.json`; a shell export cannot reach it.
- **`tests/` is not type-checked** (`tsconfig` includes `src/**` only), so a new
  `Config` field missing from `testConfig` becomes NaN at runtime, not an error.
- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
