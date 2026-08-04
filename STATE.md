# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B14 is `moot`; B16 replaces it.** Research settled it: `finish_reason:
"length"` means *`max_tokens` was reached*, and LM Studio reports context
exhaustion as a separate native reason the OpenAI-compatible layer flattens to
`stop`. B14 counted a string that cannot fire here — 0 across 5 real failures,
reading as a clean pass while a request lost 90 lines. B16 states the outcome as
the **harm** and names the detector only as **method**: `prompt + completion >=
contextTokens` separates 70 successes (max 11,918) from 10 failures (min 16,426)
with a 4,508-token gap. `repair` now writes those three numbers per round.

## Next action

**Open LM Studio and read `contextOverflowPolicy`.** `truncateMiddle` and
`rollingWindow` keep generating while pruning the *prompt*, which explains a
block that came back **properly closed** and 90 lines short better than "the
model stopped" does — and the project cannot set it through the API. One look
decides whether `DECISIONS.md`'s causal story survives. Then reload at 32,768
with `LOCAL_CODER_CONTEXT_TOKENS` to match and run a fresh `contract-stability`
to score B16 — the six existing runs are in-sample and cannot.

## Do not redo

- **B16's `> 10%` and its 20-request denominator are INHERITED from B14**, so
  they predate the data. Re-deriving either destroys the only defence they have.
- **No margin constant on `contextExhausted`** — a 4,508-token gap has no noise.
- **G7 still opens only on `output_would_truncate`.** The second code is
  exploratory, and refusals below a maximal window count for nothing.
- **`outputBytesPerToken` stays 3.5** though 3.978 is measured.
