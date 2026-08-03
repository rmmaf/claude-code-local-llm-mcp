# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**The server is installed and the meter returns dollars.** The `invocation_id`
echo is verified — it reached a `toolUseResult` and the meter joined on it,
`provenanceUnavailable: false` (`run 2026-08-03-win-01`). One `gate` call:
97,544 → 1,814 bytes, 98.1%. Prices came from Anthropic's sheet; the five
multipliers in `rates.ts` already matched it exactly. Six review rounds found
six pricing defects, every one in a branch this machine cannot reach.
`npm test`: **4 failed / 228 passed**, the four pre-existing Windows failures.

## Next action

**Read `/usage` and compare against USD 117.98** — 412 requests, meter run at
the same moment. That is B1, and `/usage` is gone once this session closes.
Error ≤ 5% → B1 holds; > 5% → fixing the meter becomes the only work. Then the
Mac: `npm run smoke-test` first (the `<file>`-block contract), then a session
using `implement`/`repair`. B6 and B7 come from `repair`'s own returned payload
(`passed`, `rounds_used`, `rounds[].model_latency_ms`), not from the meter.

## Waiting on

- A real local model → B6 and B7; `repair` has never met one
- **B5 needs a different repository** — this one configures 2 checks, so 1
  collapsed turn is its structural ceiling and a ≥ 2 threshold is unreachable
- B3 needs 19 more real `gate` calls; just keep verifying with `gate`

## Do not redo

- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
- Read timestamps from the clock in the command that writes them. Twice this
  session I typed one from memory and it landed in the future.
