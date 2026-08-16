# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**The corpus is COMPLETE: 65 of 65** and the run is DECLARED — `manifest-config.json` now
carries both manifests, the run ids and 6+6 abPairs, and the full dry run refuses only on
MAC-LOCAL pins. `tests/b12-plan.test.ts` binds artifact→generator, 60 specs→plan, config→plan,
and DERIVES the pair rule. **Both constants DECIDED** pre-data (`b086a59`).

## Next action

**DECLARED IS NOT SEALABLE — see `_beforeYouBuild`,** four decisions and one hazard. The
hard one first: `evidence/b12-harness-seal.json` does not exist, is a barrier before ANY
registration, must run AFTER `build`, and is create-only forever. `pinned.scoringCommand` is
now a TEMPLATE resolved per manifest by the assembler, so A and B each carry one literal
string — and since 2026-08-14 there is exactly ONE scoring invocation to name (R50), so the
old problem of one string having to serve two invocations is gone. Rename the three
`*-pending` run ids before `build`.

## Measured, and worth not re-deriving

- **`--deep` still is not evidence a base carries its defect**, though its `os.tmpdir()`
  toolchain bug is fixed (`32561af`). It asserts the predicate FAILS, so every way of being
  wrong that makes one fail reads as a defect. **Green at the parent is the trustworthy half,
  the author checks it, and `--deep` belongs on the Mac.**
- **7 of 30 types-only sites admit a false FIXED** — a tsc-only predicate cannot tell a
  restored annotation from a behaviour-changing silencer. Built and run. Pairing does NOT
  make it noise: only treatment has `repair`, which loops on the predicate alone, so
  arm-dependent route choice is a possible treatment EFFECT. Two of the seven are paired.
- **A rule with a tunable clause is still a discretionary choice.** The pairs are the first
  six of each committed order because every clause I added to buy a property was the clause
  doing the selecting. Costs taken unpatched, in `_abPairs`.
- **The authoring machine is not the run machine.** A whole round went into routing around a
  suite that is red on Windows only, and green on the Mac, where the predicates execute.

## Still blocking a run

**p is unmeasured:** N=30 completes 29% at 0.60, 59% at 0.667, 93% at 0.77. Unchanged: VOID
21 and VOID 12 (**no A/B before both**); the Mac trips (policy blobs, installedChars RE-PROBE
with the model in the key, cap probe, pilot). **At the seal, re-pin `pinned.captureSha256`.**

## Do not redo

- A published base is RETIRED, never re-authored: `git commit` embeds committer time.
