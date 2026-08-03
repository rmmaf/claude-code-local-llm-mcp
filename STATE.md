# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**Both instrument defects found in `run 2026-08-03-mac-06` are fixed and
tested.** `stopped_because` no longer blames the model for the budget: it reads
the `remaining` that went into `min(config.timeoutMs, remaining)`, captured at
issue, since no downstream signal recovers it. Four tests pin both sides of that
boundary. The per-round trace now reaches telemetry — without it B7 was never
measurable from the log, on any past run. `scripts/verify-stop-cause.sh`
prepares, scores and cleans up the Mac run that confirms this against a real
model; `check` returns 0 verified, 1 contradicted, 2 incomplete.

## Next action

**Run the verifier on the Mac.** `setup`, paste the three prompts it prints,
then `check`. It is the only source of a real `model_ms`, and B7 has none.
**B0 is a separate, standing block:** while `shared.ts:78` demands every editable
file whole against an 8192-token cap, a truncated response is logged
`model_failed` and no B6 number reads clean.

## Waiting on

- **The Mac's uncommitted `selectModelsBestFit`** — no push credentials there.
- **B5 needs a different repository** — this one configures 2 checks.

## Do not redo

- **Never derive a cause from a signal that went through a lossy transform.**
  Three passes at one branch: the error code alone, then a clock read after the
  abort, then the output of the `min()` that discarded the distinction.
- **A field absent from the log is not absent from the code** — B6 ran on a
  narrative because a grep missed `rounds_used` under another name.
- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
