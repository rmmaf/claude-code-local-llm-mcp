# UNIT 5 — the assembler: a committed run archive in, two artifacts out

`src/cost/b12/assemble.ts`. **The only unit that touches the filesystem.** UNITs
1–4 are pure functions over values; this one reads a run's committed evidence,
builds those values, calls the four in order, and writes what the design says a
run owes.

**NOT PART OF THE PHASE-3 EXPOSURE.** Phase 3 is closed at 1 of 3 and `repair`
gets no further draw (`PREMISES.md § B12`). UNITs 1–3 were the measured task;
this is orchestrator work and is authored directly. Nothing here is evidence
about a local model.

**WHY IT DOES NOT EXIST YET, STATED SO THE ABSENCE IS NOT MISTAKEN FOR AN
OVERSIGHT.** Every unit below it was specified against a frozen design that says
what to compute. This one is specified against a frozen design that says what to
*emit* and a run script that emits something slightly different, and the gap
between the two is the whole of the work.

---

## What it reads

| source | what it fixes | notes |
|---|---|---|
| `evidence/<run_id>.b12.tasks.json` | the ORDERED 30 task ids, and **the only declaration of `verificationStratum`** | `design.artifacts` 1 |
| `evidence/<run_id>/obs-<taskId>-<arm>/observation.json` | every other `B12Observation` field | written by `scripts/b12-run.mjs` |
| the run's telemetry log | every `TelemetryRecord`, **read once** | identity source, see step 2 |
| every session transcript of the run | `ambiguousIds`, and the lineage each `computeTerms` needs | `invocationOwners` |
| `.local-coder/rates.json` + the manifest | prices, and the MEASURED `clientTruncationCap` | VOID 8 |
| `MEASUREMENTS.jsonl` + each prior `<run_id>.b12.result.json` | `priorRuns` | `voidConditions` 1 |

---

## The steps

### 1. The manifest first, and `verificationStratum` comes from it

**`observation.json` CARRIES EVERY `B12Observation` FIELD EXCEPT ONE.**
`scripts/b12-run.mjs` writes `valid`, `invalidReasons`, `runId`, `taskId`, `arm`,
`sessionId`, `censored`, `baseCommit`, `treeHashAtStart`, `endCommit`,
`originatedRequestIds` and `accepted`. It does **not** write
`verificationStratum`, and `admissionRule` 8 says the stratum is "declared per
task before the run" — so it is joined here, from the manifest, by `taskId`.

**REFUSE WHEN THE JOIN FAILS; NEVER DEFAULT.** A missing stratum may not become
`"types-only"` because that is the more common value, and it may not be inferred
from the observation's own result — that would be reading the stratum off the
data it is meant to stratify. `partitionByStrata`'s `unknownStratum` bucket
(`FINDINGS.md` F3) is defence in depth against a corrupted declaration reaching
UNIT 1; it is not a licence for this unit to guess and let UNIT 1 catch it.

The manifest also fixes the ORDER, which nothing downstream can see — step 6.

### 2. Identify the telemetry log ONCE, over the WHOLE log, before any scoping

```ts
const records = await readTelemetry(root);          // ../telemetry.js
const universe = identify(TELEMETRY_REL_PATH, records);
```

**THIS IS THE LOAD-BEARING RULE OF THE UNIT AND IT IS EASY TO GET BACKWARDS.**
`identify` keys a row `JSON.stringify([source, ordinal])` where `ordinal` is its
position in the array it was handed. `scopeTelemetry(transcript, telemetry)`
returns a `TelemetryRecord[]` with **no identity at all** — so the obvious
sequence, scope-then-identify, restarts ordinals at 0 inside every slice and
makes two observations mint `["telemetry.jsonl", 0]` for two different physical
rows.

That is `FINDINGS.md` F12 reintroduced at the read layer, and it is worse there:
`runCoverage` would report `exactlyOnce: true` over a set of colliding keys while
attributing magnitudes to the wrong observations. **Scope by filtering the
IDENTIFIED array** — apply `scopeTelemetry`'s predicate to `universe`, keeping
each row's key — and hand `universe` itself to `runCoverage` as its first
argument.

**ONE LOG IS IDENTITY; THE PER-OBSERVATION COPIES ARE ARCHIVE.**
`design.artifacts` 6 has each `obs-<NN>/` carry "the telemetry rows in the task's
window", so the same physical row exists in the run log and in one or more
observation directories. Identity is a property of the READ (`coverage.ts`), so
identifying the copies would produce a second, disagreeing key space. Read the
run-level log; treat the copies as evidence for a human, never as input.

### 3. `ambiguousIds` once, run-level

`invocationOwners(transcripts)` over every session transcript of the run — which
is what `src/cost/cli.ts` already does before its own loop, and the reason it is
handed to `computeTerms` rather than derived there. Computing it per
observation would give each window a different set, and `admissionRule` 5 pins
`ambiguous` to a counter over the whole slice: "`savedFraction` is withheld iff
`provenanceUnavailable || ambiguous > 0`".

`FINDINGS.md` F19 turns on this set — it is what decides which observations leave
the hold arithmetic — so a narrower one silently widens the hold domain.

### 4. Rates, with the measured cap overlaid

Load `.local-coder/rates.json`, then overlay the manifest's `clientTruncationCap`
for the pinned Claude Code version. **`rates.json` is frozen byte-identical to
commit `3541625` and cannot hold it**, and `voidConditions` 8 requires it measured
per version — "a run that does not record a measured cap for its own version is
VOID". The overlay happens here because this is the only unit that sees both
files; `computeTerms` documents that its caller does it.

### 5. One `computeTerms` per observation

`TermsInput` needs `observation`, the FULL lineage `transcript` (continuation and
fork children included — never one file), the identified slice from step 2,
`rates`, `installedChars`, `ambiguousIds`, and `disposition`.

`disposition` is DECIDED HERE, from the closed list in `admissionRule` 1
(`scored`, `void(execution_error)`, `void(version_drift)`, `void(instrument_write)`,
`void(rate_key_mixed)`, `void(withheld)`, `void(sibling_inheritance)`,
`void(task_failed)`, `void(pacing)`, `not_started`). `computeTerms` takes it as an
argument and decides nothing — UNIT 2 says so, and that is what keeps the
admission rule in one place instead of scattered through the arithmetic.

`admissionRule` 13: **`R`'s admission requires the TREATED arm's acceptance
only.** The control arm never enters the primary verdict, "otherwise `R`'s
admitted set is unknowable at the moment it must be published".

### 6. Select the first 20 that admit, IN THE COMMITTED ORDER

`admissionRule` 2: "The manifest fixes an ORDERED list of 30 tasks by id; **the
first 20 that admit, in that committed order, are scored.** The order is fixed
before the first arm runs, so this is headroom and not selection."

**THIS UNIT IS THE ONLY PLACE THE ORDER IS KNOWABLE.** `aggregate` refuses on any
count other than 20 and says in its own comment that it cannot see the committed
order — so a caller handing it a set of 20 has already made the selection, and
the check there is a backstop, not the rule. Directory listing order, filesystem
`mtime` and task-id sort are all WRONG and all look right on a clean run.

Every task not scored is reported with its disposition (`admissionRule` 2), and
the ones with a disposition other than `not_started` go to `aggregate` as
`dropped` — `rHiPlus` and `R_all` are both defined over them.

### 7. The prior-run register

`priorRuns` from `MEASUREMENTS.jsonl` and each prior `<run_id>.b12.result.json`.
`voidConditions` 1: B12 may not be scored while any registered run has no
committed result, **and "omission is itself a VOID"**.

**NEITHER THIS UNIT NOR `aggregate` CAN CHECK THAT THE REGISTER IS COMPLETE**, and
that limit is stated rather than papered over. `aggregate` can see that a register
was supplied and that every entry resolved; this unit can see that every
`run_id` in `MEASUREMENTS.jsonl` has an artifact. A run registered in neither is
invisible to both. Say so on the artifact.

### 8. Emit two artifacts, not one

- **`evidence/<run_id>.b12.counterfactual.json`** (`design.artifacts` 7) — PER
  OBSERVATION: `A_o`, `S_o` at both horizons, `O_o`, the per-row `(t, T, ttl,
  multiplier, bytes_raw, bytes_returned, capped/uncapped/signed)` vector, the
  four-class refusal ledger with magnitudes, subagent share, rate key, and the
  disposition. Everything here is already on `ObservationTerms`.
- **`evidence/<run_id>.b12.result.json`** (`design.artifacts` 8) — `B12Result`
  verbatim. Owed "by every registered run whether it scores or voids", which
  means a run that voids at step 6 still writes one.

**`FINDINGS.md` F20's DUAL REPORTING IS OWED TO THE FIRST OF THESE, NOT THE
SECOND.** `voidConditions` 16 compares "the EXCLUDED observations" against "the
ADMITTED set" and `admissionRule` 6 put one observation on both sides; the frozen
text picks neither reading. Publishing both is permitted as "reported, deciding
nothing" but the per-observation inputs belong to artifact 7, whose inventory is
the wide one — `result.json` carries only `selection.basis`, the label saying
which reading the verdict used.

---

## What it must refuse, loudly

A silent assumption here is worse than anywhere else in the scorer, because every
unit below it is pure and will happily compute a confident number over a wrong
set. In each case throw with the run identity and the offending id in the message
— `computeTerms`'s pairing assertion is the model.

1. **A `taskId` in the manifest with no observation directory**, or the reverse.
2. **An observation whose `taskId` does not join to a manifest stratum** — step 1.
3. **Two identified rows sharing a key.** This cannot happen if step 2 is done
   right and is the assertion that proves it was: it is a control that CAN fire,
   which is why it is written rather than assumed.
4. **A telemetry log that is absent or empty** while any observation's transcript
   carries a local tool result — that is `provenanceUnavailable`'s file-level
   cousin and it would score every row as `unverifiable`.
5. **A manifest whose recorded git blob hash does not match the file**
   (`design.artifacts` 1: "any commit touching it dated after the earliest session
   start is a VOID").

**It does NOT refuse on a stratum it does not recognise.** That is UNIT 1's
`unknownStratum` and `FINDINGS.md` F3 — the value joined and was simply not one of
the two, which is a corrupted declaration rather than a missing one, and the
design owes an artifact "whether it scores or voids" so a throw produces none.

---

## What this unit inherits, open

- **F17** — the frozen preflight screens for none of `R_hi⁺`'s refusal
  conditions, so a run can pass preflight and still return `open` here.
- **F20** — the selection guard's domain is undetermined; step 8 says where the
  dual reporting goes.
- **F21** — a hold cell can be evaluable on ten and priced on four; both counts
  are published, the gap is not closed.

## What this unit creates, and it is new

**THE ANALYSIS SESSION IS NOT AN OBSERVATION, BUT IT IS ARCHIVED.**
`admissionRule` 7 voids the whole run if an OBSERVATION's session reads
`.local-coder/telemetry.jsonl`. This unit reads it by construction. It is not an
observation and no rule touches it — but `admissionRule` 2 requires the analysis
session's transcript to be committed, precisely so that `R`, `N` and `A` computed
on a partial set is machine-checkable after the fact. **Whoever runs the
assembler must run it in a committed, archived session**, and that obligation
belongs in `PREMISES.md § B12` before the first run rather than in this file.

---

## Done when

`npx vitest run tests/b12-assemble.test.ts` exits 0, over a synthetic run archive
built on disk in a temp root — a manifest, twenty-plus observation directories, a
telemetry log and two session transcripts.

**The oracle's central assertion is a ROUND TRIP, not a golden file.** Build the
archive, assemble it, and separately build the same `B12Result` by calling
`identify` / `computeTerms` / `runCoverage` / `aggregate` by hand over values the
test constructs; the two must be deep-equal. A golden `result.json` would pass on
any assembler that is wrong in the same way twice.

**And one assertion that is not a round trip**: two observations whose windows
overlap must produce slices whose keys are DISJOINT-BY-ROW and IDENTICAL-BY-KEY
for the row they share — the scope-then-identify defect passes every other test
in the file.
