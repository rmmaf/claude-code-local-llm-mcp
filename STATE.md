# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**The corpus commits have REFS** (`530c2c2`): annotated `refs/tags/b12/corpus/<taskId>`,
create-only by git's own refusal and read back after writing; retire creates the retired
tag before a COMPARE-AND-DELETE of the live one — safe against failure, NOT a transaction.
`verify-corpus` is what refuses on the Mac when a base is missing, and its text carries
the fetch line. **The transport was measured and it REFUTED me:** a plain `git fetch` into
an existing clone brings no base at all — auto-following only takes tags pointing into
fetched history, and these are detached. Also: `*.patch` is `eol=lf`, because a CR patch
applies in the worktree and is REFUSED by the index (`bbbf9f4`); and the register oracle's
29 git tests, which had no budget at all, carry a measured 30 s (`938b84a`).

## Next action

**Build `scripts/b12-manifest.mjs`.** Nothing writes `evidence/<runId>.b12.tasks.json`, so
the corpus cannot become a manifest. It DERIVES rather than declares — `baseCommit` from
the tag, `acceptance` as an ARRAY of space-free STRINGS (both halves are load-bearing),
`promptSha256` computed. First the SEVENTH owner decision in `PREMISES.md` (A and B
disjoint), which is the licence for its one contestable refusal.

## Still blocking a run

**The 65-sibling corpus is UNAUTHORED — the tools now exist, the patches do not.** The
exposure is p, never measured: N = 30 completes 29% at p = 0.60, 59% at 0.667 — a coin
flip — and 93% at the 0.77 the frozen design implies. A void consumes one of two attempts.

Unchanged: VOID 21 and VOID 12 (**no A/B before both**); the Mac trips (policy blobs,
installedChars RE-PROBE with the model in the key, cap probe, pilot); platform and
Phase-3 amendments; contract-stability re-run; seal → register (CAS) → sessions → clause
6 → verdict → A/B. **At the seal, re-pin `pinned.captureSha256`.**

## Do not redo

- The O-bracket is DECLINED and so are its cousins: no control-arm `installedChars`,
  no minted VOID-21 hash, no minted verdict-precedence RULE.
- Never back-fill an append-only record; three phase-3 run ids stay row-less.
- `tests/fixtures/b12-run/` is TEST MATERIAL; `// b12:emission-begin` IS clause 5's 4th.
- **`void(withheld)` is MEASURED not firing** — 2026-08-09 pre-flight, 2.1.221.
- The zero-owned-key gap is the harness's, named in `PREMISES.md`, and NOT closed.
