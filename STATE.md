# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**The corpus toolchain is COMPLETE and the corpus is EMPTY.** `b12-author.mjs` mints
and publishes a base (`530c2c2`, annotated `refs/tags/b12/corpus/<taskId>`, create-only,
retire moves before a compare-and-delete); `b12-manifest.mjs` assembles the manifests
(`0086b79`). The assembler DERIVES rather than declares — `baseCommit` from the tag,
`acceptance` from the spec's argv — and refuses a spec that declares either.
**Two measurements decided design, both refuting an argument:** a plain `git fetch` into
an existing clone brings NO base (auto-following only takes tags pointing into fetched
history); and a quoted acceptance entry is an ALWAYS-ACCEPT — `'single'` exits 0 on both
platforms, `"double"` exits 0 on macOS and 3 on Windows, against the author's 3.

## Next action

**Author the 65 defect patches**, which is the only thing left before the Mac trips: pick
the shared green parent, then one spec directory per task (`spec.json` with its `manifest`
block, `defect.patch`, `prompt.md`) under `b12-corpus/`. The four open owner decisions —
per-task predicate, `fileScope`, the committed order, and the admission rate p — are
inputs to this, not to the tools. Predicates must be SPACE-FREE argv: no quotes.

## Still blocking a run

**The exposure is p, never measured:** N = 30 completes 29% at p = 0.60, 59% at 0.667 — a
coin flip — and 93% at the 0.77 the frozen design implies. A void consumes one of two
attempts.

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
- A pilot manifest needs 3 abPairs: `observe` runs the gap sweep BEFORE any pilot
  exemption. Suppressing that gap in a build tool ships an unrunnable artifact.
