# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**`D8` ran on the Mac and stopped being a diagnostic.** Six artifacts
(`evidence/2026-08-04-mac-11` … `-mac-17`) say the whole-file contract is 94.7%
complete and **size-determined, not random** — 13/13 cases unanimous over three
repeats. Its one failure exposed what nothing checked: prompt and answer share
one window, so a request cleared the output cap and came back properly closed,
`finish_reason: "stop"`, **90 lines missing**. A context pre-flight now refuses
those. Re-verified on Windows: **4 failures / 320 passing**, +38 tests, 0 new.

## Next action

**Two decisions are yours, and both are blocked on nothing but a choice.**
(1) **B14's threshold measures a quantity that did not occur** — 0 of 5 real
failures carried `finish_reason: "length"`. Amend it, supersede it, or ship the
pre-flight unmeasured. (2) **G7 names `output_would_truncate`, which refused 0
of 13**, while `context_would_overflow` refused 2 — and that code did not exist
when the threshold was written. Then score **B15**: the `D8` session is the first
non-void candidate, and only the denominator is missing.

## Do not redo

- **`outputBytesPerToken` stays 3.5** though 3.978 is now measured. Re-fitting it
  on the corpus that measured it is corpus #1's mistake again.
- **The input divisor is 3.9 and separate on purpose** — one divisor over a
  shared window applies its pessimism twice and refused a request that fits.
- **An unknown context window must fail OPEN.** `!== null` made the budget NaN
  and turned one refusal into every refusal; 50 tests caught it.
- **B15 needs `scripts/classify-verification.mjs`**, standalone and read-only.
  `src/cost/` stays frozen while G1 is reopened.
