# The mutation harness — plan, not code

Status: **PLAN ONLY**, revision 2. Nothing here is implemented.

Written against `main` at `ac87053`, after PR #18 merged — so the six controls
this measures were frozen before the measurer was designed, and any edit to a
control now shows up as a diff against a merged base rather than as a quiet
adjustment inside one PR.

Closes the half of R23 still open: clause 6 requires six negative controls
**shown FIRING**, and all six have been shown firing *by hand* — mutate the
subject, run the named control, read the failure, restore, re-run. Thirty such
demonstrations exist in `FINDINGS.md`. None of them is a mechanism.

**Revision 2 exists because revision 1 was reviewed NO-SHIP.** Five findings,
four confirmed whole and one confirmed in part. Where the review is followed the
section says so; where it is declined the section says why. The declines matter
as much as the fixes — one of the review's recommendations would have minted the
very condition §1 exists to prevent.

## 1. Where the evidence goes — reversed from revision 1

Revision 1 kept the harness artifact out of `voidConditions`, arguing that
reading it would mint a voiding condition and owe a pre-data amendment. **That
was wrong, and it was a rationalisation.**

The frozen clause says *shown **FIRING***. The audit computer today checks that
the six controls are **PASSING** ([audit.ts:632-675](../../src/cost/b12/audit.ts:632)).
Passing is strictly weaker than firing: a gutted control — one that keeps its
title and asserts nothing — passes. The gap is not between the code and a
condition someone wants to add; it is between the code and **the frozen sentence
the code already claims to implement**.

By this project's own standing distinction, implementing what a frozen sentence
says is a **correction**; widening beyond it is what owes an amendment. So:

> Firing evidence is read by clause 6's **existing** evaluator and reported as a
> failure of clause 6's existing "shown FIRING" requirement. No seventh numbered
> condition. No new clause. `voidConditions` gains no entry.

This is the ninth instance of the pattern this repository keeps hitting: the
defect living exactly where the rule had already been written down.

**One ambiguity is settled explicitly rather than argued away.** Requiring the
evidence to be *machine-produced* does narrow how "shown" may be satisfied — a
hand demonstration recorded in `FINDINGS.md` is also a showing. That narrowing is
decided **pre-data**, recorded in `PREMISES.md` with the ordering visible in
`git log -p`, exactly as the two owner decisions of 2026-08-11 were. Pre-data and
declared, the question does not arise; post-data it would be unanswerable. The
audit computer's own comment already says it: *before the first scored
observation these are free* ([audit.ts:626](../../src/cost/b12/audit.ts:626)).

What clause 6's evaluator rejects, all as "shown FIRING" failures:

- no firing evidence bound to the attestation's `subjectCommit`
- any registered pair recorded as NOT FIRED
- evidence whose base commit is not the `subjectCommit`, or whose recorded
  subject blob shas differ from that commit's
- evidence whose `CONTROL_TESTS` coverage is not exactly the clause's six

## 2. What "FIRING" has to mean — tightened

A control that goes red under a mutation has proved nothing on its own. Deleting
the subject file reddens all six. Revision 1 offered three conditions; the review
built a mutant satisfying all three that still proves nothing — a production
branch keyed to the diagonal test's own fixture id, wrong for that tuple alone.
It is right. Six conditions now, and the last two are the new ones:

1. **Sensitivity (the diagonal).** Under mutation `M_i`, control `C_i` FAILS.
2. **The failure is a judgement, not a crash.** An assertion failure. A
   module-load error, a TS error, or a timeout REFUSES the pair.
3. **Specificity (the off-diagonal).** Under `M_i` the other five PASS, except
   collateral declared in advance with its reason. Undeclared collateral fails
   the pair.
4. **The kill is the control's own.** The failing assertion must be located in
   the named test's body — **not in a `beforeEach`/`beforeAll` hook**. Vitest
   attributes a hook failure to the test, so a mutation that only breaks shared
   setup reads as a firing while the control's own assertions never ran.

**Conditions 2 and 4 were written against a guess, and the guess was measured
and killed.** A throwaway probe ran an assertion failure, a `beforeEach` failure
and two same-titled passes through this project's own vitest and json reporter.
Three facts, none of them what revision 2 assumed:

- **`assertionResults[].location` is `null`** — `includeTaskLocation` is off in
  this config. The reporter cannot tell the harness where a test is declared, so
  "is the failure inside the test's body" is not answerable from the report
  alone. The test's line range has to be parsed out of the control file itself.
- **A hook failure is shape-identical to an assertion failure**: same
  `status: "failed"`, same `failureMessages`, same stack pointing into the test
  file. The only robust discriminator observed is the message prefix —
  `AssertionError:` for a judgement, `Error:` for a hook that threw.
- **The duplicate `fullName` case is real, not theoretical.** Two distinct
  passing tests came back under one identical `fullName`, exactly the ambiguity
  `audit.ts:672` refuses to resolve.

So the implemented rule is: **`AssertionError:` prefix** (which covers condition
2 and most of condition 4 — a throwing hook is a crash, not a judgement),
**plus** the first stack frame in the control's file falling inside that test's
body range, parsed from the file. A hook that fails an `expect` is the residual
hole: it emits `AssertionError:` and is attributed to the test. The line-range
check is what closes it, and it is the reason the range is parsed rather than
skipped as too fiddly.
5. **Production-reachable.** The mutant may not mention any test-only
   identifier — no fixture id, path, uuid or literal that appears in
   `CONFORMANCE_FILES`. Checked mechanically against the mutation text.
6. **Not fixture-singular.** The mutant must be killed by at least two
   independently constructed inputs, or the pair is reported as
   fixture-singular. This is *reported*, not fatal — see §3.

Plus the bookends of §4.

## 3. The mutation sets — two of them, with different powers

The review's fourth finding says replaying the historical bug is circular: it
shows the control is a regression test for the defect it was born from, and says
nothing about the defect space around it. **True as a limitation.** But it argues
for a goal the clause does not set: clause 6 asks that the controls be shown
firing, not that they be shown adequate. So the review's recommendation —
*require* each control to kill several non-equivalent mutants — **is declined**,
because a new pass/fail requirement is exactly the condition §1 refuses to mint.

Two sets, with different standing:

### 3a. The clause-6 set — DECIDES

Six pairs, one per control. Each mutation is **the historical bug the control was
written against**: real, shipped, production-reachable, and by construction not
derived from the fixture. Controls come from `CONTROL_TESTS`
([audit.ts:127](../../src/cost/b12/audit.ts:127)) by import, never restated; the
registry refuses if the two do not cover each other exactly.

| # | Control (`tests/cost-meter.test.ts`) | Subject | Mutation |
|---|---|---|---|
| 1 | credits a failed repair row at zero units — [:1757](../../tests/cost-meter.test.ts:1757) | `buildCounterfactual`, `src/cost/report.ts:888` | refuse the `raw==0 && returned==0` row instead of crediting it at zero |
| 2 | keeps a call that ADDED bytes as the negative it is — [:1708](../../tests/cost-meter.test.ts:1708) | signed/clamped bracket, `src/cost/report.ts` | restore the shipped clamp: `max(0, raw - returned)` as the scored figure |
| 3 | counts a refusal it cannot size — [:1455](../../tests/cost-meter.test.ts:1455) | `ambiguousUnits`, `src/cost/report.ts` | fold the unsized refusal into `units` as 0 instead of `unsized` |
| 4 | rejects a resumed session from a sibling worktree — [:3076](../../tests/cost-meter.test.ts:3076) | `void(sibling_inheritance)`, `src/cost/b12/assemble.ts` | drop the `inherited > 0` rejection |
| 5 | refuses a call two sessions both carry, on both sides — [:1007](../../tests/cost-meter.test.ts:1007) | `invocationOwners`, `src/cost/report.ts:749` | credit a doubly-owned id to the first session that claims it |
| 6 | rejects a run whose snapshot covered fewer slugs — [:3158](../../tests/cost-meter.test.ts:3158) | `classifyRun`, `scripts/b12-run.mjs` | compare slug COUNTS instead of populations — the control's own comment says counts read nothing here |

### 3b. The invariant catalogue — REPORTED, DECIDING NOTHING

Operators derived from each subject's stated invariant and its boundary
partitions, **written before re-reading the control's assertions**, so they are
not shaped to be caught. Surviving mutants are named in the artifact. They void
nothing, gate nothing, and change no verdict — they are the honest measure of how
much of the defect space around each control is unguarded, which is a fact a
reader deserves and not a condition anyone agreed to.

- **failed-repair:** one-zero vs both-zero; failure-status predicate flipped
- **signed bytes:** sign reversal; absolute value; clamp before vs after aggregation
- **ambiguous units:** drop; coerce to zero; double-count; NaN
- **sibling inheritance:** wrong-side check; boundary comparison; mixed local/inherited ids
- **duplicate ownership:** first-wins; last-wins; count-both; cross-arm-only detection
- **slug coverage:** equal-count different populations; strict subset; strict superset; duplicates; normalisation collision

This is the "reported, deciding nothing" pattern the project already uses for the
capped/uncapped pair, the conformance hashes, `endPorcelain`, and
`invocationsWithoutRow`.

## 4. Mechanics — rebuilt after the review

Revision 1 promised per-pair bookends and then budgeted seven runs total. The two
cannot both be true, and the review caught the arithmetic. It also caught the
worse half: restoring the subject's **bytes** does not restore the **tree**.
`tsc` does not delete obsolete output, so a restored source with a stale `dist/`
still runs the mutant — and a later pair failing on an earlier pair's residue
would be recorded as a firing.

Base: the audit computer's own path
([audit.ts:1556-1602](../../src/cost/b12/audit.ts:1556)) — `git worktree add
--detach <sha>`, `npm ci`, `npm run build`, `npx vitest run --root <tree>
tests/cost-meter.test.ts --reporter=json`, `rmSync` + `worktree prune` in a
`finally`.

**Pristine is proved, not assumed.** Between pairs the tree is returned by
`git checkout -- .` + `git clean -xfd -e node_modules`, then **`git status
--porcelain` must be empty** — and `dist/` is deleted and rebuilt, never
incrementally patched. `node_modules` survives because the lockfile never
changes; nothing else does.

**Bookends are pairwise and real.** Per pair: clean run (all six green) → mutate
→ rebuild → mutant run → reset to proved-pristine. The budget is therefore
**1 + 2N runs**, which for the clause-6 set is **13**, not 7. Stated plainly
because a silently truncated matrix reads as coverage it does not have.

`--reporter=json` still yields the whole row of the matrix in one run: under
`M_i` all six controls' statuses arrive together. That economy is real; the
seven-run claim built on it was not.

Mutations are exact literal replacements with a **required occurrence count** —
never a regex. A regex that silently matched zero times produced a mutant that
never applied, once, already (R35); a harness that cannot distinguish "mutation
applied and the control held" from "mutation never applied" is worse than none.

## 5. Self-test — the vacuous control is dropped

Revision 1 registered a vacuous seventh control outside `CONFORMANCE_FILES` and
treated being outside as a virtue. The review is right that it is the defect:
outside the suite, it travels a **different lookup path**, so it cannot catch an
inverted acceptance rule that reads registered controls one way and the watchman
another. It would have certified six controls while accepting all of them wrong.

Replaced by a **synthetic-reporter self-test**: hand-built `--reporter=json`
payloads pushed through the *same* parsing, identity and acceptance functions the
six controls use, asserting the evaluator's verdict on each. Cases:

all-pass · all-fail · swapped names · **duplicate fullName** (the audit already
treats a duplicated title as unanswerable, [audit.ts:672](../../src/cost/b12/audit.ts:672))
· missing test · hook-attributed failure · inverted diagonal · crash instead of
assertion · zero tests reported

The hook-attributed and assertion cases are **not hand-written**: they are the
probe's real payloads, kept as fixtures, so the evaluator is tested against what
this vitest actually emits rather than against what a plan assumed it emits.

Unlike the harness itself, this is an ordinary vitest test and runs under the
gate — it mutates nothing and touches no worktree.

## 6. Where it lives

- `scripts/b12-mutate.mjs` — the runner, plus its registry beside it. `scripts/`
  is pinned **by filename** (`scripts/b12-run.mjs`, [audit.ts:61](../../src/cost/b12/audit.ts:61)),
  not by directory, so a new script adds nothing to the pinned set. Confirmed
  independently by the review.
- Never inside `CONFORMANCE_FILES` — pinned once the 2026-08-10 amendment's
  introducing commit is an ancestor of the run anchor
  ([audit.ts:1141-1158](../../src/cost/b12/audit.ts:1141)), and carrying a
  committed attestation.
- **The runner is not a vitest test.** A test would mutate trees on every
  ordinary gate. It is a script, invoked deliberately. Its *evaluator* is unit
  tested (§5); its *execution* is not.
- Output is deterministic: no wall-clock, no random. The timestamp is passed in,
  as `PREMISES.md` entries already are.

## 7. Gutting, R23's other half

Same machine, one more registered mutation: empty the scorer's returns and assert
the pipeline yields **no verdict**, not a favourable one. Its declared collateral
is *all six controls* — declared, because here the collateral is the claim.

## 8. When

Hard deadline: **before the seal / the first scored observation.** After that a
dead control is no longer a bug to fix — it is re-emission or VOID across 20–26
paid sessions. Before it, it is an ordinary Tuesday.

Because §1 now binds the evidence to the attestation's `subjectCommit`, a subject
that changes after the harness ran makes clause 6 fail on its face rather than
relying on anyone remembering to re-run.

## 9. Known soft spots — attack these next

- §3b's operators are still authored by the same hand as the controls. Writing
  them from the invariant before re-reading the assertions reduces the shaping;
  it does not eliminate it.
- Condition 6 (not fixture-singular) is *reported*, so a fixture-singular mutant
  can still satisfy the clause-6 set. Making it fatal is a condition, and §1
  forbids it. The report is the whole defence.
- Declared collateral remains the softest joint: a lazy declaration turns the
  off-diagonal into a rubber stamp. Every declaration carries a reason and is
  read in review, which is a human check, not a mechanical one.
- The pristine proof rests on `git status --porcelain` being empty, which says
  nothing about state outside the worktree (global caches, `%TEMP%`).
