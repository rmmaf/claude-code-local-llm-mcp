# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B2 fell and G2 is closed (dead).** The hook ran on a real command and its
replacement never reached the transcript — 30,000 chars of raw output landed
instead (`run 2026-08-02-win-03`). It is unregistered, the README tells users not
to install it, and the retest is written into G2 as a reopening condition with its
threshold and its one attempt fixed in advance. 27 defects from three adversarial
and eleven stop-time reviews are fixed (35 new tests). Pushed: `59cf135` on
`claude/multi-agent-plan-models-eval-75e2c4`. `npm test`: **4 failed / 202 passed**.

## Next action

**The server has never been installed, so none of this has run inside a real
session.** Install it, work one ordinary session verifying with `gate` instead of
Bash — no local model needed — and **record that session's `/usage` figures before
closing it**: B1 is the meter's total against them within ±5%, and `/usage` is
unrecoverable afterwards. Then `npm run cost-meter -- --json`; `provenanceUnavailable`
must come back `false` — the `invocation_id` echo is the last unobserved assumption
the meter rests on, the class that cost B2. Settles B1, B3, B5; the Mac, B6 and B7.

## Waiting on

- A real local model → B6 and B7; `repair` has never met one
- B8 → whether RAG (G3) and the Mac's `D7` are needed at all

## Do not redo

- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
- A string in a transcript proves nothing about how it got there: two of my B2
  readings were a `Read` of the hook's own source and the hook's direct output.
  Check the record's tool and its key set before concluding anything.
