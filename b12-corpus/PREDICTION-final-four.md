# Prediction — the last four bases

Written and committed BEFORE any of it was run, because that is the only way a wrong
premise stays visible instead of being rewritten as a hit afterwards. Whatever the
measurement says lands in `MEASUREMENTS.jsonl`; the diff against this file is the score.

The four are `cfgclamp`, `cfgenv` (blocked by the PARENT) and `chkbudget`, `tymemrec`
(sites rejected by audit). Three of them sit inside a manifest's first-20 admission
window — `tymemrec@7`, `cfgenv@14`, `chkbudget@16` in A, `cfgclamp@12` in B — so they are
not decoration that can be dropped without re-running the plan's constraint check.

## P1 — what is actually red at the parent

`npx vitest run tests/config.test.ts` at `608e930` on Windows fails with **exactly one**
failing test: *"resolves a relative models CSV path against the project root"*. The other
four pass.

The reasoning, so a wrong call is diagnosable: that test asserted the literal
`"/project/config/models.csv"` and `path.resolve("/project", "config/models.csv")` is
drive-qualified on Windows. The neighbouring assertion in *"honors env overrides"* uses
`/etc/local-coder/models.csv`, which `src/config.ts:177` passes through untouched because
`path.isAbsolute` is true for a leading slash on Windows too — so that one survives.

**Confidence: high on the failing test, medium on the claim that only it fails.** I have
read the file, not run it. If a second test fails, the `-t` route below dies for whichever
task depends on it.

## P2 — the `-t` route

`npx vitest run tests/config.test.ts -t "clamps a mem fit fraction above 1 down to 1"` at
`608e930` **exits 0**, and the same command at a `cfgclamp` base exits non-zero. Likewise
`-t "honors env overrides"` for `cfgenv`.

**The risk that would kill it** is not the parent: it is that a `-t` filter matching
nothing still exits 0. If vitest reports "no tests matched" as success, then a filtered
predicate can go green at a base for a reason that has nothing to do with the defect, and
the whole point of a red predicate is lost. Measure the empty-filter exit code before
trusting this route, not after.

**Named cost if it is adopted:** 2 of 60 tasks would carry a narrower verification command
than the other 58. That is a real covariate asymmetry in the corpus, small and one-sided.

## P3 — `tymemrec`

Narrowing `parseVmStat`'s return annotation from `number | null` to `number` produces tsc
errors **only inside `src/memory.ts`** — I predict **4**: three `return null` statements
(lines 23, 25, 31) and the `freeBytes === null` comparison at line 71, which becomes a
no-overlap comparison.

It is runtime-neutral in the strict sense that matters here: a return-type annotation emits
byte-identical JavaScript, so there is no behaviour for a session to leave broken while a
tsc-only predicate scores it FIXED. That was the exact defect in the rejected proposal.

**Why not narrow `MemoryInfo.source` instead** — the other obvious candidate: it leaks.
`tests/memory.test.ts:88` asserts `expect(info?.source).toBe("os")`, and vitest types
`toBe` from the receiver, so the error would be reported outside `fileScope`. Predicted, and
worth checking rather than believing.

## P4 — `chkbudget`

A defect confined to `parseSpecs` in `src/checks/config.ts` turns `tests/gate.test.ts` red
**without any risk of blinding the gate the treatment arm verifies through**, because this
repository has **no `.local-coder/checks.json`** — `git ls-files .local-coder` lists only
`rates.json`. `loadChecks` therefore takes the autodetect branch and `parseSpecs` never
executes in a real gate run here.

That is the difference from the rejected site, which reached check EXECUTION.

**The claim I am least sure of** is the second half: that the running gate never executes
the base's own `src/checks/config.ts`. The MCP server runs from its installed build, not
from the worktree under test — but I have not proven that, and if it is false, every
`src/checks/**` task in this corpus is suspect, not just this one.

## P5 — the adjudication

I predict the audit kills **at most one** of the two proposed sites, and that the `-t`
route is accepted with the asymmetry recorded rather than rejected. I also predict the
thing I have not thought of arrives in the `chkbudget` lens, since that is where the last
audit found what I missed.
