# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B2 fell and G2 is closed (dead).** The hook ran on a real command and its
replacement never reached the transcript — 30,000 chars of raw output landed
instead (`run 2026-08-02-win-03`). It is unregistered from `.claude/settings.json`;
the retest is written into G2 as a reopening condition with its threshold and its
one attempt fixed in advance. Three adversarial reviews plus eleven stop-time
reviews found 27 defects, nearly all in `repair`; all fixed, 35 new tests.
`npm test`: **4 failed / 202 passed**, the four pre-existing Windows failures.

## Next action

**Commit first** — 26 uncommitted entries, ~1,000 changed lines, no restore point.
Then install the server and work one real session through `gate` instead of Bash:
`claude mcp add local-coder -- node "<worktree>\dist\server.js"`, restart Claude
Code, finish with `npm run cost-meter`. That single session settles B3, B5, and
whether the `invocation_id` echo reaches the transcript — the last unobserved
assumption the cost meter still rests on, and the same class of assumption that
just cost B2.

## Waiting on

- A real local model → B6 and B7; `repair` has never met one
- B8 → whether RAG (G3) and the Mac's `D7` are needed at all

## Do not redo

- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
- A string in a transcript proves nothing about how it got there: two of my B2
  readings were a `Read` of the hook's own source and the hook's direct output.
  Check the record's tool and its key set before concluding anything.
