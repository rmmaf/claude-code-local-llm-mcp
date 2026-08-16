# The last four, round two — round one scored, and what I expect next

`PREDICTION-final-four.md` is not edited. It stands as written and this file is its score,
followed by fresh predictions for the step that has not run yet: authoring the four bases.

## Round one, scored

**P1 — HIT.** `npx vitest run tests/config.test.ts` at the parent fails on exactly one test,
*"resolves a relative models CSV path against the project root"*, with the other four passing.
The reasoning held too: `path.isAbsolute("/etc/…")` is true on Windows, so the neighbouring
assertion in *"honors env overrides"* survives.

**P2 — the mechanism HIT, the conclusion MISSED.** I named the risk that killed the route:
an unmatched `-t` exits 0, measured, and `--passWithNoTests=false` does not change it. But I
predicted the route would be *adopted with the asymmetry recorded*, and it was rejected on
**five** independent fatal grounds. I had found one.

The four I missed, in the order they should have occurred to me:

1. `b12-author.mjs:102`'s `SHELL_UNSAFE` includes `\s`, so a spaced argv forces `shell:false`,
   and `npx` with `shell:false` on Windows is ENOENT.
2. `b12-manifest.mjs:161-165` refuses a whitespace-carrying `predicate.argv` **by name**.
3. `b12-manifest.mjs:476` joins argv on spaces and `b12-run.mjs:2975` splits it back — and
   `b12-run.mjs` is frozen and sha-pinned, so the round trip cannot be repaired.
4. **The premise is a Windows artifact and the run machine is the Mac.** On POSIX the suite is
   green at the parent. I would have permanently narrowed 2 of 60 predicates to route around a
   defect that does not exist where they execute.

Number 4 is the one worth keeping. It was not a fact I lacked — it is in MEMORY.md and in
`manifest-config.json`'s `_transport`. I framed the whole problem as "find a predicate green on
Windows" and never asked whether Windows was the machine the predicate answers about. The
authoring machine and the run machine are different, and only one of them was in the question.

**P3 — MISSED in its specifics, and missed one thing that matters more than the count.**
I predicted narrowing `parseVmStat`'s return type would produce **4** errors including the
`freeBytes === null` comparison. Measured: **3**, and the comparison does not fire. The shipped
site is a different one — `getMemoryInfo`'s `Promise<MemoryInfo | null>` — which I had not
proposed.

The real miss is a sentence I wrote with confidence: *"a return-type annotation emits
byte-identical JavaScript, so there is no behaviour for a session to leave broken while a
tsc-only predicate scores it FIXED."* The emit half is right and was proven by hash. The
conclusion is wrong, because a session does not have to leave behaviour broken — it can **add**
behaviour. Replacing the three `return null`s with `os.totalmem()`/`os.freemem()` fallbacks is
three lines, inside `fileScope`, makes tsc exit 0, and changes what the function does on every
failure path. Acceptance is predicate-exit-0 and nothing else, so it scores FIXED. That was
built and run, not argued.

It is not a defect in this base. Seven of the thirty types-only sites drop a `| null` from a
signature and every one of them has the same escape. It is a property of the stratum and it is
recorded as one, below.

What P3 got right: the leak analysis. Narrowing `MemoryInfo.source` would have surfaced an
error in `tests/memory.test.ts:88`, outside `fileScope`, exactly as predicted.

**P4 — HIT, including the half I flagged as least sure.** A `parseSpecs`-confined defect cannot
blind the gate, and the reason is stronger than the one I gave: the MCP server runs from a
pinned `dist/` in a *different* worktree, imports `loadChecks` statically, has no dynamic
loading anywhere in `src/`, and exposes no root parameter. Three measured layers rather than my
one argument about `checks.json` being absent.

**P5 — MISSED, all three clauses.** I predicted the audit would kill at most one of the two
sites (it killed **zero**), that the `-t` route would be accepted (**rejected**), and that the
surprise would arrive in the `chkbudget` lens (it arrived in the route lens).

Two clean hits, one half, two misses. The pattern in both misses is the same: I was confident
about a mechanism I had reasoned through and had not run.

## What has not run yet, and what I expect

**N1 — all four author on the first attempt.** `b12-author.mjs author` runs the predicate at the
parent (expect exit 0) and at the patched tree (expect non-zero) in a worktree under `.b12/`,
then commits detached and publishes the tag.

High confidence for `chkbudget` and `tymemrec`: both were measured in exactly that worktree
shape. **Lower for `cfgclamp` and `cfgenv`**, for one specific reason — the author does not
apply the patch by editing a working tree. It builds the tree through a temporary git index
(`treeViaIndex`, `b12-author.mjs:205`), so the patch has to apply as a *diff*, and every
measurement so far applied the site as a *string substitution*. If one of them fails, I expect
it to be there and not at the predicate.

**N2 — the plan diff is exactly `4 4`.** After changing the two `TEST_RED` tuples and running
`b12-plan.mjs write`, `git diff --numstat b12-corpus/corpus-plan.json` reads **4 insertions, 4
deletions**: two `predicateArgv` element lines and two `verificationCommands` strings.
`manifestA` and `manifestB` byte-identical, `cfgenv` still A[14], `cfgclamp` still B[12].

Stated as `4 4` rather than "eight lines changed" because the loose phrasing accepts a result
twice the size of the right one.

**N3 — `verify-corpus --deep` will be slow and will report nothing.** With the `os.tmpdir()`
fix it now runs 65 predicates in worktrees where the toolchain resolves, which as far as I can
tell is the first time it has ever done so. I predict zero reasons and over twenty minutes.

**And I predict that clean result will still be weak evidence**, for a reason the run cannot
show: `--deep` asserts each base's predicate FAILS, so every way of being wrong that makes a
predicate fail — a suite that cannot load, a toolchain that is not there, a Windows-only path
literal — reads as a base carrying its defect. A clean `--deep` is consistent with a corpus
that is fine and with one that is broken in any of those ways. Green at the parent is what
carries the weight; this is the second time that has needed saying.

**N4 — where the next surprise comes from.** Not the authoring. The `symptom` prose: it is
pasted verbatim into a paid session's `prompt.md`, no script compares it to anything, and both
`cfgclamp` and `cfgenv` now describe a suite and a behaviour they did not describe an hour ago.
The failure mode is silent — a stale symptom authors clean.
