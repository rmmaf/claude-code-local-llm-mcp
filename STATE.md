# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B14 is `moot`; B16 replaces it.** `finish_reason: "length"` means *`max_tokens`
was reached*, and LM Studio reports context exhaustion as a separate reason the
OpenAI layer flattens to `stop` — so B14 counted a string that cannot fire here:
0 across 5 real failures, reading as a pass while a request lost 90 lines. B16
states the outcome as the **harm**, the detector only as **method**:
`prompt + completion >= contextTokens` splits 70 successes (max 11,918) from 10
failures (min 16,426). Two reviews found **six** instrument defects. G7 held.

## Next action

**Open LM Studio and read `contextOverflowPolicy`.** `truncateMiddle` and
`rollingWindow` keep generating while pruning the *prompt*, which explains a
block that came back **properly closed** and 90 lines short better than "the
model stopped" — and it cannot be set through the API. Then reload at 32,768,
set `LOCAL_CODER_CONTEXT_TOKENS`, and run `contract-stability` to score B16;
the six existing runs are in-sample.

## Do not redo

- **B16's `> 10%` and 20-request denominator are INHERITED from B14** and
  predate the data. Re-deriving either destroys their only defence.
- **The corrective retry gets its OWN pre-flight** — skipped, not sent, when the
  accumulated messages will not fit. A correctness bug, not just a metric one.
- **Never compare `GenerationResult.usage` to a window** (it sums both
  requests), never fold `finish_reason` into `envelope`, never read absent
  `usage` as zero. Record via `attempts[]`, `usageKnown` and `onAttempt`.
- **`repair` rows score the ENVELOPE half only** — the elision tier reads
  deleted lines as lost content, which is what `repair` legitimately does.

