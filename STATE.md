# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**Corpus #1 ran: 20 of 20 closed** (`run 2026-08-04-mac-09`,
`qwen3-coder-30b-a3b-instruct-dwq-v2`), B7's median at **2.10 s** over 21 rounds,
zero truncations. **B6, B7 and B14 all stay `open`** — the corpus is synthetic
and single-fault, deviating from all three experiments in the direction that
flatters them, so it is recorded as strong evidence that decides nothing. The
8 assertion tasks are the half that cannot be gamed, and they are 8/8.

## Next action

**Corpus #2, from the capture hook, is what decides B6.** It needs real work to
accumulate in `.local-coder/corpus/` and then hand labelling of which failures
are mechanical, recorded with whoever labelled them. Two things corpus #1 could
not touch and #2 will: **B14** needs requests near the pre-flight bar, and
**G7**'s denominator is the captured corpus by amendment.

## Two findings that outlive the score

- **The model is not the bottleneck in a round.** `model_ms` is ~1.2 s in both
  halves; the gate is 0.74 s (`tsc`) against 3.63 s (tests). The lever for B7 is
  the gate, not a smaller model — which is where B7's own "if it falls" pointed.
- **`repair`'s byte value is entirely in the test half:** 1,919,136 → 6,859
  bytes on `npm-test`, against 2,308 → 10,048 on `tsc`, negative in 12 of 12.

## Do not redo

- **Read the per-request ceiling from the run, never from the environment** —
  the server's `env` is in `~/.claude.json`; a shell export cannot reach it.
- **`tests/` is not type-checked**, so a `Config` field missing from
  `testConfig` becomes NaN at runtime rather than a compile error.
- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
