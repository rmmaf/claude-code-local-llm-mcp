# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**The corpus is COMPLETE: 65 of 65** — 60 sealed bases plus 5 pilot, published as annotated
tags, shallow and `--deep` clean. Generator now in `scripts/b12-plan.mjs` with a `check` mode;
`tests/b12-plan.test.ts` binds artifact→generator AND all 60 specs→plan, so a hand-edit is a
red suite. **Both constants DECIDED** pre-data (`b086a59`). Every remaining pin is MAC-LOCAL.

## Next action

**COMPLETE IS NOT SEALABLE.** `manifest-config.json` declares no manifestA/manifestB, no
runIds and no abPairs, so `b12-manifest.mjs` is still in its pilotOnly branch and refuses a
sealed manifest without well-formed pair declarations. Writing those is the next step, and
the abPairs decide the open question in `_typesOnlyEscapeRoute`.

## Measured, and worth not re-deriving

- **`--deep` still is not evidence a base carries its defect**, though its `os.tmpdir()`
  toolchain bug is fixed (`32561af`). It asserts the predicate FAILS, so every way of being
  wrong that makes one fail reads as a defect. **Green at the parent is the trustworthy half**
  and the author checks it. It also belongs on the Mac; the Windows run took 9.1 min.
- **7 of 30 types-only sites admit a false FIXED** — a tsc-only predicate cannot tell a
  restored annotation from a behaviour-changing silencer. Built and run. Plan records it.
- **The authoring machine is not the run machine.** `tests/config.test.ts` is red at the
  parent on Windows only; a whole round went into routing around a Mac-green suite.
- **Zero of 162 local sessions carry a sidechain** — wrong population: B12's subagents come
  from the arm calling `repair`, and only the pilot can measure the `multi` cell.

## Still blocking a run

**p is unmeasured:** N=30 completes 29% at 0.60, 59% at 0.667, 93% at 0.77; a void costs an
attempt. Unchanged: VOID 21 and VOID 12 (**no A/B before both**); the Mac trips (policy
blobs, installedChars RE-PROBE with the model in the key, cap probe, pilot); platform and
Phase-3 amendments; contract-stability re-run; seal → register (CAS) → sessions → clause 6
→ verdict → A/B. **At the seal, re-pin `pinned.captureSha256`.**

## Do not redo

- The O-bracket is DECLINED, with its cousins. Never back-fill an append-only record.
- Decision 2 is WITHDRAWN — the seal resolved MANIFEST SOURCE to **authored**.
- A published base is RETIRED, never re-authored: `git commit` embeds committer time.
