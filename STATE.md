# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**The server is installed and ran inside a real session for the first time**
(`run 2026-08-03-win-01`). The `invocation_id` echo — the last unobserved
assumption under the cost meter — is verified: the id came back inside a
`toolUseResult` and the meter joined on it (`provenanceUnavailable: false`,
`unmatched: 0`). One `gate` call: 97,544 → 1,814 bytes, 98.1%, 4 failures located.
B2 stays fallen and G2 closed (dead); the hook is unregistered and the README
tells users not to install it. `npm test`: **4 failed / 202 passed**.

## Next action

**B1 is what this machine can still close, and only from inside a live session:**
run `npm run cost-meter -- --json`, read `/usage` **before the session ends** — it
is unrecoverable afterwards — and compare. Token totals compare directly; USD
needs `.local-coder/rates.json` carrying a real `inputPerMTok` for `claude-opus-5`
(absent → `usd: null`; do not invent a price). B3 needs 19 more real `gate` calls,
which costs nothing extra: just keep verifying with `gate` instead of Bash.

## Waiting on

- A real local model → B6 and B7; `repair` has never met one
- **B5 needs a different repository** — this one configures 2 checks, so 1
  collapsed turn is its structural ceiling and a ≥ 2 threshold is unreachable here
- B8 → whether RAG (G3) and the Mac's `D7` are needed at all

## Do not redo

- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
- A string in a transcript proves nothing about how it got there: the echo search
  also matched my own prose quoting the id. Check the record type and key set.
