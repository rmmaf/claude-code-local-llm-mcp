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
failures (min 16,426). Three reviews found **eight** instrument defects, two of
them live data-loss bugs. G7 held; its second refusal code is exploratory.

## Next action

**Open LM Studio and read `contextOverflowPolicy`.** `truncateMiddle` and
`rollingWindow` keep generating while pruning the *prompt*, which explains a
block that came back **properly closed** and 90 lines short better than "the
model stopped" — and it cannot be set through the API. Then reload at 32,768,
set `LOCAL_CODER_CONTEXT_TOKENS`, and run `contract-stability` to score B16.

## Do not redo

- **B16's `> 10%` and 20-request denominator are INHERITED from B14.**
  Re-deriving either destroys their only defence. The six runs are in-sample.
- **Resolve the MODEL first, then its window**; never borrow the window of a
  model nobody asked for; never pin one window across `repair` rounds.
- **The corrective retry needs its OWN pre-flight** — skipped, not sent.
- **Never sum `usage` against a window, fold `finish_reason` into `envelope`, or
  read absent `usage` as zero.** `repair` rows score the ENVELOPE half only.
