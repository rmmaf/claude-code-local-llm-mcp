# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**First real workload, and it went badly in an informative way**
(`run 2026-08-04-mac-10`, an 8-hour Tetris build). Six `scaffold` calls all
returned `created`; the composed program did not run, and **51.2% of the 2,055
generated lines were dead code** because three of six files ignored a constraint
carried verbatim in every spec. `created` claims only that parseable output
reached the requested path. Before this: corpus #1 closed 20 of 20
(`mac-09`), which decided nothing — it was synthetic and single-fault.

## Next action

**Rewrite `gate`'s tool description, and treat that as the experiment.** That
session made **36 `Bash` calls and 0 `gate` calls**, with 0 `repair` — B5's own
"if it falls" line predicted exactly this, so the mechanism is not what needs
work. A tool nobody calls cannot be measured. **D4 is now known (78.9 tok/s)**
and it unblocked a hidden dependency: B14 cannot observe truncation below
~208 s of `timeoutMs`, so any B14 run must record its ceiling.

## Do not redo

- **`/cost`'s "68% from local-coder" is not a saving.** It is last-24h
  session attribution under "what is contributing to your limits usage", and the
  panel says its lines are "not a breakdown". Measured share of tool output in
  that session: **13.5%**.
- **The gate only sees the configured checks.** Delegated work outside them —
  `tetris/*.js` — leaves `gate` green and `repair` no-opping on a broken tree.
- **Read the per-request ceiling from the run, never from the environment**; the
  server's `env` lives in `~/.claude.json` (`scripts/set-server-env.mjs`).
- **`tests/` is not type-checked**, so a missing `Config` field becomes NaN.
- **Verify with `npm test`, not `npx vitest run`** — the latter skips the build.
