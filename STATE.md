# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B14 is `moot`; B16 replaces it.** `finish_reason: "length"` means *`max_tokens`
was reached*; LM Studio reports context exhaustion as a separate native reason
the OpenAI layer flattens to `stop`. B14 counted a string that cannot fire here —
0 across 5 real failures, reading as a pass while a request lost 90 lines. B16
states the outcome as the **harm** and the detector only as **method**:
`prompt + completion >= contextTokens`, which separates 70 successes (max 11,918)
from 10 failures (min 16,426). `repair` records it **per attempt**, throws
included. G7 did not move; its second refusal code is exploratory.

## Next action

**Open LM Studio and read `contextOverflowPolicy`.** `truncateMiddle` and
`rollingWindow` keep generating while pruning the *prompt*, which explains a
block that came back **properly closed** and 90 lines short better than "the
model stopped" does — and the project cannot set it through the API. Then reload
at 32,768, set `LOCAL_CODER_CONTEXT_TOKENS` to match, and run a fresh
`contract-stability` to score B16 — the six existing runs are in-sample.

## Do not redo

- **B16's `> 10%` and its 20-request denominator are INHERITED from B14**, so
  they predate the data. Re-deriving either destroys their only defence.
- **Never compare `GenerationResult.usage` to a window** — it sums both
  requests, and the malformed path throws after two of them. Use `attempts[]`.
- **`repair` rows score the ENVELOPE half only.** The elision tier reads deleted
  lines as dropped content, and deleting lines is what `repair` does.
- **No margin on `contextExhausted`**; `outputBytesPerToken` stays 3.5.
