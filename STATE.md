# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**The Mac is green end to end** (`run 2026-08-03-mac-02`): install, `lms`,
server, status, a coder-only catalog with 4 of 4 models matched and sized, the
smoke test, and the full suite. The `<file>`-block contract is verified against
a real local model. The one red test was a Windows path literal, fixed in
`3c6242a`; the real slugs there confirm the leading dash, not the dot rule.
**B1 fell and G1 reopened**: meter $119.11 vs `/usage` $35.96, +231% against a
5% threshold, and the two never measured the same quantity.

## Next action

**Register the MCP on the Mac, restart, and run `repair` on a real failure.**
Nothing has yet run inside a Claude Code session there — `~/.claude/projects`
has no entry for the repo, which is why telemetry is still empty. B6 (`passed`,
`rounds_used`) and B7 (`rounds[].model_latency_ms`, `gate_ms`) come from
`repair`'s own payload, so a reopened G1 does not block them. Record which
model ran: free RAM moved 28.2 → 15.6 → 18.1 GB across runs and at 15.6 the
pick silently changed from the 30B to the 14B.

## Waiting on

- **B5 needs a different repository** — this one configures 2 checks, so 1
  collapsed turn is its structural ceiling and a ≥ 2 threshold is unreachable
- B3 needs 19 more real `gate` calls; just keep verifying with `gate`

## Do not redo

- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
- **Never report an inferred cause as an observed one.** Ten reviews of
  `mac-check.sh` were all this, and the last one hit the *justification*, not
  the code. Quote whatever actually knows, or say you did not look.
