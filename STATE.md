# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**THE PLAN'S THREE PASSES SHIPPED AND SURVIVED R8** on
`claude/b12-f23-audit-register`: F23's uncapped bracket; the clause-6
controls, emission wrapper and audit computer; pilot, register (CAS,
create-only seal, cardinalities 30/5/6), admissionRule 7's grammar, the
observe registration guard, sessionId nonce+lock, snapshot identity stamps;
policy blobs as GIT PROVENANCE with the DUAL calibration key (the 2026-08-08
singular probe refused by name); the hardened Mac probes (+ NEW
`b12-truncationcap-probe-mac.sh`); `b12-author.mjs` with five named checks;
the R7#12 share formula registered. Details: FINDINGS.md, this file's log.

## Next action

R8–R17 (post-implementation adversarial rounds) are ADJUDICATED — nineteen
findings, all confirmed, fixed with controls: R8 CAS index +
capture-before-validate; R9 fail-open probes made fail-closed; R10 the
conditional sync; R11 the branch captured, artifact 6's runlog barrier,
case-folded scopes; R12 clause 6's two holes; R13 a stripped snapshot stamp
scoring; R14 the sync's index and leaked worktrees; R15 the sync became an
APPEND and `--attest-suite` moved to a detached worktree that BUILDS before
it tests; **R16 the worst one — the real index stayed on `expectedHead`
after the swap, so the operator's next ordinary commit UNDID the
registration (reproduced: manifest gone, row gone)**; R17 that fix's own
TOCTOU, closed with git's OWN mutex (`.git/index.lock` by O_EXCL, released
by renaming over `.git/index` — which also blocks a concurrent checkout).
The registration surface took five rounds; each answer moved further from
"check more carefully" toward "use the primitive that cannot race".
PR to main is open — merge is the user's act.

## Still blocking a run

The A/B pass (scorer + VOID 21 and VOID 12 adjudications — **NO A/B before
both are registered**); the 65-sibling corpus (b12-author compresses it);
the Mac trips: policy-bundle transport, dual-key re-probe, cap probe, formal
preflight, pilot; the platform amendment (pre-data, after the exploratory
cert, before the formal preflight); the Phase-3 1/3 amendment (gate-only is
CUT; only a NEW pre-data amendment seals); contract-stability re-run (F23
grew report.ts); then seal-harness → register (CAS) → the 20–26 supervised
sessions → the clause-6 sequence → verdict → A/B.

## Do not redo

- The O-bracket is DECLINED and so are its cousins: no control-arm
  `installedChars`, no minted VOID-21 hash, no minted verdict-precedence RULE.
- Never back-fill an append-only record; three phase-3 run ids stay row-less.
- `tests/fixtures/b12-run/` is TEST MATERIAL, never evidence.
