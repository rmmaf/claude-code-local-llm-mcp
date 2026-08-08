# UNIT 5 — the assembler: a committed run archive in, two artifacts out

`src/cost/b12/archive.ts` (impure) + `src/cost/b12/assemble.ts` (pure) + a thin
emitter. UNITs 1–4 are pure functions over values; this is where the filesystem
lives, and it is split in three so that the impure surface stays as small as the
four units below it were designed to make it.

> **THE ARCHIVE THIS SPEC READS NOW EXISTS. WHAT BLOCKS THE UNIT IS SMALLER, AND
> IT IS STILL NOT IN THIS FILE.** `design.artifacts` 6 defines the
> per-observation archive — reduced lineage records, the telemetry window
> VERBATIM, the pre/post `requestId` diff, the observation's `invocation_id` set,
> the acceptance exit code, and sha256 of every source file. When this spec was
> written `scripts/b12-run.mjs` wrote only `observation.json`,
> `snapshot-before.json`, `snapshot-after.json` and `cli-stdout.json`, so an
> assembler promising to read a committed archive had none to read. **It emits
> six files now** — those four plus `archive.json` and `telemetry.jsonl` — built
> by `src/cost/b12/capture.ts`, committed at each task's end and verified blob by
> blob against `HEAD`. **What F24 still owes, this unit still needs.**
> `installedChars` is a required field of `TermsInput` at step 5 below, and the
> covariate and memory hashes are what clauses 12-13 and artifact 7 read — and
> only the harness can take any of them, since at scoring time the worktree is
> gone and the server is not running. So F24 still blocks this unit, on those
> three inputs rather than on the archive, alongside the fact that **no manifest
> has been sealed**, so `observe()` has never run end to end. (F24 also still
> carries the `dist/**` hole, registered rather than closed.)
>
> **THE CLAUSE'S OWN FIELD LIST IS STILL SHORT OF ITS OWN CRITERION**, and that
> is recorded rather than fixed. It says "the admitted records reduced to **the
> fields the meter reads**" and then enumerates eight that cannot rebuild a
> `Transcript` — no `parentUuid`, no `isSidechain`, no `isCompactSummary`, no
> `message.content`, no `toolUseResult`. The criterion governs and the
> enumeration is incomplete; see F24. The capture resolves it by reducing onto
> `RawRecord`, the parser's own declared field set, held to it by a type-level
> assert — so step 5 below has a lineage to hand `computeTerms`.

**NOT PART OF THE PHASE-3 EXPOSURE.** Phase 3 is closed at 1 of 3 and `repair`
gets no further draw (`PREMISES.md § B12`). UNITs 1–3 were the measured task;
this is orchestrator work, authored directly, and is not evidence about a local
model.

**REVISED 2026-08-07 after a Codex gate returned REFUTE on the first draft.** The
first version overstated one danger, minted three refusals the design does not
authorise, claimed the counterfactual artifact was already covered by
`ObservationTerms`, and put every VOID clause behind one vague word. Each is
corrected below and named where it was wrong, because a spec that quietly
improves is a spec nobody can audit.

---

## The three parts, and why the boundary is there

| module | purity | responsibility |
|---|---|---|
| `archive.ts` | **impure** | paths → a validated `RunArchive` value. Canonical telemetry identification happens here, exactly once. |
| `assemble.ts` | **pure** | `RunArchive` + registration audit → `{ counterfactual, result }`. Joins strata, decides dispositions, enforces the committed order, runs the archive-level VOID checks, then calls the four units. |
| the emitter | thin | reads through `archive.ts`, calls `assemble`, and **writes both artifacts even when the result is a VOID**. |

**The first draft made this one `assemble.ts` and that was the wrong boundary.**
Every rule worth testing — order, disposition, the VOID predicates, artifact
completeness — is a function of values, and putting it behind a filesystem read
means every test of it builds a directory tree. The split lets the frozen rules be
tested as values and the hostile on-disk cases be tested separately.

It also corrects a claim: the first draft said the committed order "is knowable
only in this unit". It is knowable wherever the ordered manifest is a value —
which, after the split, is `assemble.ts`, and it does not need the filesystem to
know it.

---

## What it reads

| source | what it fixes | notes |
|---|---|---|
| `evidence/<run_id>.b12.tasks.json` | the ORDERED 30 task ids, and **the only declaration of `verificationStratum`** | `design.artifacts` 1 |
| `evidence/<run_id>/obs-<taskId>-<arm>/` | the per-observation archive | **incomplete today — F24** |
| each `obs-…/telemetry.jsonl` | every `TelemetryRecord`, identified **by archive path** | there is no run-level log — step 2 |
| every session transcript of the run | `ambiguousIds`, and the lineage `computeTerms` needs | `invocationOwners` |
| `.local-coder/rates.json` + the manifest | prices, and the MEASURED `clientTruncationCap` | `voidConditions` 8 |
| `MEASUREMENTS.jsonl` + each prior `<run_id>.b12.result.json` | `priorRuns` | `voidConditions` 1 |

---

## The steps

### 1. The manifest first, and `verificationStratum` comes from it

**`observation.json` CARRIES EVERY `B12Observation` FIELD EXCEPT ONE.**
`scripts/b12-run.mjs` writes `valid`, `invalidReasons`, `runId`, `taskId`, `arm`,
`sessionId`, `censored`, `baseCommit`, `treeHashAtStart`, `endCommit`,
`originatedRequestIds` and `accepted` — every required field and several extra
provenance ones. It does **not** write `verificationStratum`, and
`admissionRule` 8 says the stratum is "declared per task before the run", so it
is joined here from the manifest by `taskId`.

**NEVER DEFAULT.** A missing stratum may not become `"types-only"` because that
is the commoner value, and it may not be inferred from the observation's own
result — that reads the stratum off the data it exists to stratify.
`partitionByStrata`'s `unknownStratum` bucket (`FINDINGS.md` F3) is defence in
depth against a corrupted declaration reaching UNIT 1; it is not a licence to
guess here.

**AND DO NOT THROW EITHER — the frozen text has no disposition for this and that
is `FINDINGS.md` F25.** `admissionRule` 1 makes every registered run owe a result
artifact naming `scored` or a VOID clause BY NAME, and a throw produces no
artifact at all. But the closed disposition list has no member that lawfully
describes a malformed manifest: `void(withheld)` is fixed by `admissionRule` 5 to
`provenanceUnavailable || ambiguous > 0`, `void(execution_error)` is narrowly
enumerated in clause 12, and `void(task_failed)` is the acceptance predicate. The
first draft of this spec resolved that gap by inventing a throw. It is recorded
open instead.

### 2. Identify the telemetry log ONCE, over the WHOLE log, before any scoping

```ts
// NOT `readTelemetry(root)` — that joins `.local-coder/telemetry.jsonl` onto a
// root (`../../telemetry.js`, two levels up from `src/cost/b12/`), and every
// arm's worktree is destroyed before scoring. Read each observation's ARCHIVED
// copy, which `scripts/b12-run.mjs` writes at `<obs dir>/telemetry.jsonl`.
const rows = await readArchivedRows(obsDir);           // <obs dir>/telemetry.jsonl
const identified = identify(obsArchivePath, rows);     // ./coverage.js
// …one per observation; their union is the universe.
const universe = observations.flatMap((o) => o.identified);
```

**Why it is keyed on the archive path and not on one log — see the correction at
the end of this step.** The short form: there is no run-level log to key on.

`identify` keys a row `JSON.stringify([source, ordinal])` where `ordinal` is its
position **in the array it was handed**. `scopeTelemetry(transcript, telemetry)`
returns a bare `TelemetryRecord[]` carrying no identity, so the obvious sequence —
scope, then identify — restarts ordinals at 0 inside every slice and mints one key
for two different physical rows.

**WHAT THAT COSTS, STATED PRECISELY, BECAUSE THE FIRST DRAFT OVERSTATED IT.** It
claimed `runCoverage` "would report `exactlyOnce: true` over colliding keys". That
is false in the case it most obviously applies to, and traced through
`coverage.ts` the three cases differ:

- **Two OWNED rows collide** — `claims[key]` collects two distinct labels, the key
  goes to `contested`, `reasons` gains a sentence and `exactlyOnce` is **false**.
  Caught, loudly.
- **One owned, one unowned collide** — the owned claim puts the key in `claims`,
  and the unowned-rows loop begins `if (claims.has(key)) continue`. The unowned
  occurrence is **silently discarded**. Not caught.
- **Two unowned rows collide with equal disposition and magnitude** — `resolve`
  reads them as one row seen twice and merges them. **Not caught**, and the second
  row's magnitude vanishes from `R_hi⁺`.

So the rule stands and the reason is sharper: the danger is not that the ledger
lies about `exactlyOnce`, it is that **rows are dropped or merged where the ledger
cannot see them at all.**

**Scope by filtering the IDENTIFIED array** — apply `scopeTelemetry`'s predicate to
`universe`, keeping each row's key — and hand `universe` itself to `runCoverage`.
If the universe is ALSO built from separately identified slices, even the
`unsliced` reason stops firing, and the last protection is gone.

**CORRECTED 2026-08-07: THERE IS NO RUN-LEVEL LOG, AND THIS STEP NAMED ONE.**
The paragraph that stood here said "ONE LOG IS IDENTITY; THE PER-OBSERVATION
COPIES ARE ARCHIVE … read the run-level log; the copies are evidence for a human
and for re-emission, never input to identity." **That rule had no referent.**
Each observation runs in its own worktree, the MCP server's root is its own
`process.cwd()` (`server.ts` → `config.ts`), and `git worktree remove --force`
destroys `<worktree>/.local-coder/telemetry.jsonl` before the next task starts.
The frozen clause says as much in its own words — without the archive "the run
cannot be corrected, only discarded". **The copies are not evidence beside the
log. They are the only survivors, and they ARE the identity source.**

What the old rule was protecting survives intact, because the danger was never
"two files" — it was restarting ordinals inside a SCOPED SLICE of one source.
So: **key on the ARCHIVE PATH.** `identify(<obs archive path>, rows)` per
observation file, ordinals restarting per file, paths distinct, therefore
`JSON.stringify([source, ordinal])` globally unique — and concatenation order is
NOT load-bearing, which it would have been had the copies been merged into one
array first. Scope by filtering the IDENTIFIED rows; hand the union of every
observation's identified rows to `runCoverage` as the universe.

**The ±60 s window still applies at scoring time and is not the harness's to
remove.** `admissionRule` 5 fixes it by hand. A row physically present in only
one observation's file can still be admitted to a neighbouring observation's
slice on timestamp, which is F12 exactly — and `runCoverage`'s identity is what
resolves it, unchanged.

### 3. `ambiguousIds` once, run-level

`invocationOwners(transcripts)` over every session transcript of the run — what
`src/cost/cli.ts` already does before its own loop, and the reason it is handed to
`computeTerms` rather than derived there. Per-observation computation gives each
window a different set, and `admissionRule` 5 pins `ambiguous` to a counter over
the whole slice.

`FINDINGS.md` F19 turns on this set — it decides which observations leave the hold
arithmetic — so a narrower one silently widens the hold domain.

### 4. Rates, with the measured cap overlaid

Load `.local-coder/rates.json`, then overlay the manifest's `clientTruncationCap`
for the pinned version. `rates.json` is frozen byte-identical to commit `3541625`
and cannot hold it, while `Rates` requires the field.

**THAT SATISFIES ONLY HALF OF `voidConditions` 8**, which reads: "VOID if no
`clientTruncationCap` was measured for the version that ran, **or if the artifact
does not carry both the capped and uncapped brackets**." A *bracket* in this
design is `[R_lo, R_hi]` — "THE SCORED QUANTITY IS A BRACKET, NOT A POINT".
`B12Result.cappedVsUncapped` is two summed row-BYTE magnitudes. **The current
result type cannot satisfy clause 8** and the fix is a second pass of the whole
arithmetic, not a field on this unit. `FINDINGS.md` F23.

### 5. One `computeTerms` per observation

`TermsInput` needs `observation`, the FULL lineage `transcript`, the identified
slice from step 2, `rates`, `installedChars`, `ambiguousIds`, and `disposition`.

`disposition` is DECIDED IN `assemble.ts`, from the closed list in
`admissionRule` 1. `computeTerms` takes it and decides nothing — UNIT 2 says so,
and that is what keeps the admission rule in one place.

`admissionRule` 13: **`R`'s admission requires the TREATED arm's acceptance
only.** The control arm never enters the primary verdict.

### 6. Select the first 20 that admit, IN THE COMMITTED ORDER

`admissionRule` 2: "the first 20 that admit, in that committed order, are scored."
`aggregate` receives only the selected arrays and says in its own comment that it
cannot see the manifest order, so its `length !== 20` refusal is a **backstop**.
Directory listing order, `mtime` and task-id sort are all wrong and all look right
on a clean run.

**A MANIFEST TASK WITH NO OBSERVATION DIRECTORY IS LAWFUL, and the first draft
made it an error.** `not_started` is a member of the closed disposition list; the
manifest orders 30 tasks as HEADROOM and only the first 20 that admit are scored.
Requiring a bijection contradicts both.

Every task not scored is reported with its disposition. Those with a disposition
other than `not_started` go to `aggregate` as `dropped` — `rHiPlus` and `R_all`
are both defined over them.

### 7. The archive-level VOID clauses, each with its own predicate

`aggregate`'s `decide()` implements clauses **1, 3, 10, 16, 17 and 18** — the ones
that are facts about the arithmetic. The rest are facts about the ARCHIVE and
belong here. The first draft hid them all behind the word `disposition`, which
cannot encode a run-level VOID at all.

| clause | what it is a fact about |
|---|---|
| 2 | partial set, every disposition reported, committed order followed |
| 7 | version, binary sha256, `DISABLE_AUTOUPDATER` |
| 8 | measured cap **and both brackets** (F23) |
| 9 | instrument contamination; the scorer's own session absent from the manifest |
| 11 | base commit, clean tree at start, pair tree hashes |
| 12 | instruction / settings / MCP / policy hashes |
| 13 | memory restoration and its pre/post hashes |
| 14 | snapshot scope, and cumulative origination disjointness |
| 19 | the scoring command's identity, and `ambiguousIds` set equality |
| 20 | pacing |

Clauses **4, 5, 6** (frozen-item drift, instrument-source drift, the conformance
suite at the run commit) are an audit over git history rather than over the
archive, and `assemble` should take their result as an input rather than compute
it. **THAT IS IN TENSION WITH `design.artifacts` 11** — "EVERY admission
condition **from the committed archive alone**" — and an audit result taken as an
input is not in the archive. So the audit's VERDICT *and its inputs* must be
committed with the run, or clauses 4–6 are exactly the conditions a later reader
cannot replay. Recorded here; it belongs to whoever writes the audit.
Clauses **21, 22** are the A/B's. Clause **23** is the run registry's.

### 8. Emit two artifacts, not one

- **`evidence/<run_id>.b12.counterfactual.json`** (`design.artifacts` 7) — per
  observation. **NOT everything here is on `ObservationTerms`, which the first
  draft claimed.** The frozen inventory also demands requests-per-segment, the
  Claude Code version, base and end SHAs, the tree hash, and the instruction-set
  and memory hashes. Some come from `observation.json`, some from the archive of
  artifact 6, and the hashes come from nowhere at all today (F24).
- **`evidence/<run_id>.b12.result.json`** (`design.artifacts` 8) — `B12Result`,
  "owed by every registered run whether it scores or voids". A run that voids at
  step 6 still writes one, which is why nothing above may throw.

**`FINDINGS.md` F20's dual reporting is owed to the FIRST of these**: the
per-observation inputs a reader needs to recompute `voidConditions` 16 under the
other reading of "excluded" belong to artifact 7's wide inventory.
`result.json` carries only `selection.basis`, the label naming the reading used.

---

## What it refuses, and under which authority

The first draft listed five refusals as though the design demanded all five. It
demands two of them, in a form that is not a throw.

| condition | authority | handling |
|---|---|---|
| stratum does not join | none — **F25** | detect and report; the design supplies no disposition |
| manifest blob hash / a commit touching it after the earliest session start | `design.artifacts` 1 | **VOID**, named on the result artifact |
| two identified rows share a key | none | an **engineering invariant** of step 2, asserted in the tests; not a scoring rule |
| telemetry log absent while a transcript carries a local tool result | none | an audit failure reported as a VOID result, not an exception |
| a manifest task with no observation directory | contradicted | lawful — `not_started` |

**Nothing in this unit throws to avoid producing an artifact.** `admissionRule` 1
makes the result artifact owed from registration onward; an exception is the one
outcome the design does not allow. A parse error with no possible result is the
only exception, and it is a bug rather than a run outcome.

---

## What it inherits, open

**F17** the preflight screens for none of `R_hi⁺`'s refusals · **F20** the
selection guard's domain, and where its dual reporting goes · **F21** a hold cell
evaluable on ten and priced on four · **F23** clause 8's two brackets ·
**F24** the archive the harness does not write · **F25** no disposition for a
malformed declaration.

## What it creates

**THE ANALYSIS SESSION IS NOT AN OBSERVATION, BUT IT IS ARCHIVED AND IT IS
FORBIDDEN FROM THE MANIFEST.** `admissionRule` 7 voids the run if an
OBSERVATION's session reads `.local-coder/telemetry.jsonl`; this unit reads it by
construction. `admissionRule` 2 wants the analysis session's transcript committed
so that computing `R` on a partial set stays machine-checkable, and
`voidConditions` 9 forbids that session from appearing in the manifest. Both
obligations belong in `PREMISES.md § B12` before the first run.

---

## Done when

`npx vitest run tests/b12-archive.test.ts` and `tests/b12-assemble.test.ts` exit 0.

**Two oracles, because there are two modules.**

- **`archive.ts` — hostile on-disk fixtures.** Missing files, extra directories,
  reordered directory listings, hash drift, duplicate ids, incomplete snapshots,
  malformed lineage.
- **`assemble.ts` — constructed `RunArchive` values.** Every disposition path, the
  order selection, each archive-level VOID clause of step 7, and artifact-schema
  completeness against the frozen inventories.

**The round trip is a PARTIAL oracle and the first draft called it the central
one.** Building the same `B12Result` by calling the four units by hand catches a
filesystem adapter that differs from constructed values — wrong decoding, a failed
join, wrong slice selection, lost keys, wrong order, a duplicated or omitted unit
call. It provably MISSES any defect shared by both paths, any frozen obligation
absent from both, missing counterfactual fields (the equality names only
`B12Result`), every covariate and VOID check not represented in `B12Result`, and a
non-compliant archive producer.

**The assertion that does not go through the units at all**, replacing the first
draft's narrower overlapping-window one:

> Every physical telemetry line, identified independently by run-log source and
> ordinal, appears under that same key in every slice that sees it; and
> `runCoverage` accounts for every universe key exactly once or names it in
> `contested` or `unsliced`.

That subsumes the overlap case and catches the mixed-ownership and equal-magnitude
aliases that `runCoverage` cannot see.

**And one metamorphic pair on the order**: changing directory enumeration must not
change the selection; changing only the manifest order must change which first
twenty are selected.

**`design.artifacts` 11 owes a replay test this does not satisfy** — "recomputes
the bracket, both jackknives, `R_all`, `R_hi⁺`, every stratum and EVERY admission
condition **from the committed archive alone**". A synthetic round trip over
same-process values is not that, and it cannot be until F24 lands.
