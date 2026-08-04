# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**The stop-cause fix is verified against a real model**, `run 2026-08-04-mac-07`
on `qwen3-coder-30b-a3b-instruct-dwq-v2`: applied 14061 ms reported `budget` and
applied 20000 ms reported `model_failed` twice — the label flipping with the
ceiling and nothing else, no counterexample. **B7 has its first real figure,
median 2.15 s over 3 rounds**, from one task on a 6-line fixture. Scoring it
exposed one more field the caller saw and the log did not, the model of a failed
round: now announced before the first request and written to telemetry.

## Next action

**A corpus, not another fix.** B6 and B7 both ask for 20 real mechanical
failures and every run so far has supplied about one. The corpus must record the
cold/warm round split, not just the median — a cold round costs ~6x a warm one.
**B0 stays the block underneath it:** while `shared.ts:78` demands every editable
file whole against an 8192-token cap, a truncated response lands as
`model_failed` and no B6 number reads clean.

## Waiting on

- **The Mac's `selectModelsBestFit`** — now committed as `2fabd32` on branch
  `wip/select-models-best-fit`, still unpushed; that machine has no credentials.
- **B5 needs a different repository** — this one configures 2 checks.

## Do not redo

- **Read the per-request ceiling from the run, never from the environment.** The
  setup shell exported 60000 while the server used 20000, from the MCP server's
  `env` in `~/.claude.json` — a shell export cannot reach it.
- **Never derive a cause from a signal that went through a lossy transform.**
- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
