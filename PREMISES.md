# PREMISES.md

What this project bets on, how each bet falls, and what changes when it does.

**Two hard rules.**

1. **A premise without an experiment does not go in this file.** If it cannot be
   falsified by a described procedure, it is a judgment call and belongs in
   `DECISIONS.md` as prose.
2. **A `Measured:` line exists only with a `run <run_id>` in it.** A value
   without a run is an assumption, not a measurement, and must say `— (assumed)`.
   Run ids are recorded in `MEASUREMENTS.jsonl`.

**Status values.** `open` (not yet decided by measurement) · `holding` (measured
at or above threshold) · `fallen` (measured below threshold) · `moot` (no longer
decision-relevant).

---

## The cost model these premises serve

The repo began on the premise *"Claude plans, the local model writes, only diffs
cross the API"*. That bet is weak: generated tokens are ~10% of a session's bill,
and the delegated diff **enters the context afterwards anyway** — so delegating
the writing saves 5x once, with no multiplier.

What dominates is a token that enters the context and is re-read on every later
request:

```
cost(token entering at request t of a segment running to T)
      = cache_write + cache_read x (T - 1 - t)
```

That forces the priority order every premise below is organised around:

1. Keep tool output out of the context (`gate` — the `PostToolUse` hook was
   measured and closed dead, see B2 and `ROADMAP.md` G2)
2. Collapse turns (`repair`) — shrinks `T` for everything already resident
3. Delegate the writing (`implement`) — kept, demoted in its tool description

---

## B1 — the cost meter reproduces the session cost `/usage` reports, within ±5%

- **Assumed:** within ±5% — (assumed)
- **Source of the assumption:** the meter sums the same billed fields Claude Code
  writes to its own transcript, deduplicated by `requestId`; nothing is estimated.
- **Experiment:** run `npm run cost-meter` against a session, compare its total
  against that session's `/usage` figures.
- **Measured:** meter **$119.11**, `/usage` **$35.96**, read within a minute of
  each other, `run 2026-08-03-win-04`. Error **+231%** against a 5% threshold.
- **Falls if:** error > 5%.
- **If it falls:** every other premise here loses its instrument. Fixing the meter
  becomes the only work until it agrees.
- **Status:** **fallen**

**Two independent failures, and only one of them is the meter.**

1. **Scope.** The meter counts 65% of `/usage`'s cache-read tokens for the same
   session (input 64%, output 77%, write 66%). The transcript is internally
   consistent — 251 duplicate groups all carrying identical usage and none
   differing, no record missing a `requestId`, `usage.iterations` summing to the
   top level — so this is not arithmetic. `/usage`'s "This session" covers a
   different set of requests than one transcript file. Its scope could not be
   determined from the data available.
2. **Basis.** Fed `/usage`'s *own* token counts, published list rates give
   $179.93 against the $35.96 it reports — exactly 20.0%. This is a Max-plan
   subscription; the panel shows 5-hour and weekly limits. So the two sides do
   not measure the same quantity even before the scope gap.

**The threshold is not being revised after the fact.** B1 as written is falsified
and stays that way. Failure 2 says the *experiment* was mis-specified — a
finding, not an excuse — and a corrected instrument check has to be proposed and
pre-registered as its own premise before anything is measured against it.

**That check is now written, as B17 below, and it does not use `/usage`.** Both
of B1's failures turned out to belong to the comparator: the scope gap has a
located mechanical cause in the meter, and the basis gap is a property of the
subscription that no threshold can remove. B17 replaces the instrument rather
than the number. **B1 stays `fallen`.**

## B17 — the cost meter counts every billed token a session incurred

> ### ⚠ `moot` — superseded by B19, and killed by its own VOID condition.
>
> Stop-time review found two defects in `scripts/session-token-walk.mjs` before
> it had scored anything: a disjointness invariant that **could not fail**, and a
> `cacheWrite` rule that contradicted the `useSplit` repair by 42,558 tokens. See
> `DECISIONS.md § a check that cannot fail is worse than no check`. Fixing them
> edited the oracle after the commit **VOID condition 2** froze it at, and that
> condition also says the clock may not move again — so every run scorable under
> B17 is void, permanently. **B19 replaces it, inheriting the outcome, the
> threshold, the holds/falls conditions and the admission rule VERBATIM**, so
> nothing is re-derived and nothing is loosened. Same disposition as B14 → B16,
> and for the same reason: the premise was never wrong, its method was.
>
> Everything below stands as written, and B19 points at it rather than repeating
> it.

**This is a repair verification, not a blind instrument test.** The mechanism was
diagnosed before this premise was written, the fix is known, and the expected
residual is zero. What is pre-registered here is therefore **not** an unknown
outcome — it is the **admission rule and the oracle**, fixed in text before the
repair is written, so the repair cannot be tuned by redefining what counts.
Pre-registration is working here as a commitment device against reinterpretation,
not as evidence about an unknown, and saying so is the difference between a
limitation declared and a limitation found later.

- **Assumed:** the meter's per-class token totals for one `sessionId` equal the
  totals over every billed record that session wrote — (assumed)
- **Source of the assumption:** the coverage defect is mechanical and located —
  `listTranscripts` does a non-recursive `readdir` and cannot see
  `<sessionId>/subagents/**`, which since Claude Code 2.1.219 is where every
  sidechain record lives. See `DECISIONS.md § the session is N files`.
- **States the outcome as the HARM, not the DETECTOR — B16's correction applied
  to B1's error.** B1 named `/usage` in its own title, so when `/usage` turned
  out to measure a different scope on a different basis, the *premise* recorded
  "the meter is wrong" and G1 stayed shut. Here the outcome is **a billed record
  went uncounted**; the comparator is named separately under **Method**, and a
  comparator found blind falsifies the method and leaves this premise standing to
  be re-measured with a better one.
- **Method, not threshold:** an independent enumeration in
  `scripts/session-token-walk.mjs`, importing nothing from `src/cost/`, written
  to Claude Code 2.1.219's **own shipped enumerator** and quoting it here so that
  both implementations answer to this text rather than to each other — the main
  directory's `*.jsonl` files, **plus `<sessionId>/subagents/**` recursively,
  deduplicated by record `uuid`**. Writing the oracle to a vendor specification
  is what makes this a conformance test rather than a second guess checked
  against a first.
- **`/usage` is disqualified, and that is a finding rather than a preference.**
  Its existence as a token source cannot be settled by reading the binary — two
  independent readings of the same bundle disagree over whether the panel renders
  a token block at all or only cost and utilisation percentages. It is compact-
  formatted to one decimal, which quantises by up to **±4.8%** just above a unit
  boundary; its "This session" is ambiguous between the running process and the
  `sessionId`'s whole history, **measured at 13.3% apart on output**; it is
  ephemeral; and reading it costs a live session and a hand transcription. A
  comparator whose existence is not decidable by inspection cannot gate anything.
- **Admission rule, AMENDED 2026-08-05 — see the amendment note directly below,
  which is the only thing that makes the edit legitimate.** A billed request is a
  **`requestId` group**, formed in three steps that are separate on purpose:
  1. **Admit** every record with `type: "assistant"` carrying `message.usage`,
     **excluding** records with `isApiErrorMessage: true` — which carry a real
     `requestId`, `model: "<synthetic>"` and all-zero usage, so they must be
     excluded by those fields and **never** by usage reading zero, since a
     legitimate record can also read zero at the top level. **Excluding files
     that are not request logs:** `subagents/workflows/wf_*/journal.jsonl` ends
     in `.jsonl`, holds records keyed `{type, key, agentId}`, and carries agent
     return values in which the string `usage` appears — a naive `**/*.jsonl`
     glob double counts.
  2. **De-duplicate by `uuid`.** That is *record* identity across the file union
     — the vendor's rule, and a guard against reading one record twice — and it
     is **not** request identity.
  3. **Group by `requestId`, and take the group's usage from its LAST record in
     file order.** Records with no `requestId` form their own group of one; there
     are none in this corpus, and that is measured rather than assumed.
  Both implementations are written to this paragraph and to nothing else.
- **THE AMENDMENT, AND WHY IT IS LEGITIMATE.** As first written this rule said "a
  billed request is a record … deduplicated by `uuid`", and that is not
  implementable as worded: Claude Code writes one billed request as several
  `assistant` records, one per content block, each carrying a copy of
  `message.usage`. Over this corpus **5,364 `uuid`-distinct records collapse to
  2,478 `requestId` groups**, so summing usage per record inflates by **2.165x**.
  The rule as written scored an arithmetic artefact, not the meter.
  **What licenses the edit is timing and direction.** It is made **before
  `scripts/session-token-walk.mjs` exists, before the meter is touched, and
  before any residual has been seen** — the same claim G7's amendment rests on,
  and the difference is the timing and nothing else. It is also the direction the
  premise's own **Method, not threshold** clause anticipates: a method found
  blind is corrected and the premise stands. And it makes the rule **more
  specified, never more permissive** — step 3 did not exist at all before.
  **VOID condition 2's clock therefore runs from this amendment**, not from the
  pre-registration commit. That is not a loophole and the reason is checkable:
  nothing has been measured against either version, so there is no residual the
  new wording could have been chosen to accommodate.
- **Step 3 is not a detail, it is the third defect this premise found before
  running.** `src/cost/transcript.ts:239-243` keeps the **first** record of a
  `requestId` group and discards every later record's usage. Measured over this
  corpus: **only `output_tokens` ever differs within a group — 327 of 1,647
  multi-record groups — and in 327 of 327 the first record is the SMALLER one.**
  Intermediate records carry a partial count; the terminal one carries the whole
  answer. Taking the last record agrees with taking the maximum on **2,482 of
  2,482** groups, while `stop_reason` does not identify the terminal record — 27
  groups have none and 1,300 have more than one — so **last-in-file-order is the
  rule, not `stop_reason`**. First-wins drops **655,570 output tokens, 19.27% of
  all output in this project**, in the class carrying the 5.0x multiplier.
  `MEASUREMENTS.jsonl:9` and `:54` stand as recorded; what is falsified is the
  generalisation they licensed — usage repeats verbatim except for
  `output_tokens`, and that exception is the expensive one.
- **Metric, exact:** per class `c ∈ {input, cacheRead, cacheWrite, output}`,
  `meter_c − oracle_c`, **in integers**. `cacheWrite` is compared as
  `cacheWrite1h + cacheWrite5m` summed, stated rather than discovered. Plus one
  invariant, measured and archived:
  `|uuids(main) ∪ uuids(subagents)| == |main| + |subagents|`. Without it the
  union can pass by two errors cancelling. **`isSidechain` is not a key and does
  not establish this** — it is `false` on every record of the main file and
  `true` on every record of a subagent file, so it identifies the source, not the
  record.
- **Experiment:** for **every** session present in `~/.claude/projects/<slug>/`
  at the pre-registration commit, run the repaired meter selecting that
  `sessionId` explicitly, run `scripts/session-token-walk.mjs` over the same id,
  and difference the four classes. The set is fixed by that enumeration rule
  rather than chosen, so no session can be dropped after its residual is seen.
- **Holds if:** every class differs by **exactly 0 tokens** on **every** session
  in a set fixed by enumeration rule, containing **≥ 5 sessions**, of which
  **≥ 1 is single-threaded** (zero subagent records) and **≥ 1 contains
  `subagents/workflows/wf_*/` nesting**.
- **The single-threaded session is a required arm, not an exclusion.** An earlier
  draft made it VOID on the grounds that it cannot distinguish a fixed meter from
  a broken one. That is a power argument wearing a definedness argument's
  clothes: both denominators are ~10⁷ and the metric is perfectly defined there.
  Dropping it would have discarded the negative control — the arm that shows the
  repair does not *introduce* error where there was none — which is the role
  `run 2026-08-04-mac-19-32k` plays for B16.
- **Falls if:** any class differs by ≥ 1 token on any session in the set.
- **Why the number is 0, and why B1's 5% does not transfer.** Both sides are
  integer sums of the same integers read from the same files. There is no
  sampling, no estimation, no display formatting and no clock, so a one-token
  difference is a defect with a locatable cause and never noise. B1's 5% was a
  **dollar** threshold against a rounded live panel; inheriting it would be a
  threshold with no argument behind it, which is what G7's rule 4 forbids.
  Removing the panel removes every mechanism that would justify a non-zero
  tolerance, so the correct tolerance is zero.
- **Disclosure of what was known when the threshold was fixed.** The readdir
  mechanism, session `5fe28335`'s per-class coverage (cacheRead 54.8%,
  cacheWrite 41.0%, output 99.1%, input 88.7%) and the ~96% pooled coverage over
  eleven sessions were all computed **before** this premise was written, under
  `run 2026-08-05-win-02-layout`. **The threshold of 0 uses none of those
  figures.** Recorded rather than suppressed, per the rule G7 states: do not
  forbid the second number, report when the deviation happened.
- **Void conditions, fixed here rather than argued afterwards.** Each is
  demanding on the *experiment* rather than permissive on the *result*, which is
  the only direction a construction rule may be chosen in after the fact:
  1. **VOID unless `evidence/<run_id>.meter.json` and
     `evidence/<run_id>.walk.json` are both committed**, carrying the four-class
     vector per session per side, the `uuid` disjointness count, the subagent
     request share per session, the Claude Code version, and the SHAs of the
     pre-registration, oracle and repair commits. **Machine-produced JSON only.**
     Hand-typed numbers do not archive a run: B1's comparator side survives
     nowhere but inside free-text `method` strings, which is why its fall cannot
     be re-adjudicated today.
  2. **VOID if `scripts/session-token-walk.mjs` or the admission rule above
     changed after the amendment commit of 2026-08-05** — the clock moved once,
     for the reason given in the amendment note, and it may not move again. What
     is frozen is the standard, not the instrument: the meter may be iterated
     freely against it, and must be, since repairing it is the point.
  3. **VOID if the Claude Code version that wrote any session in the set differs
     from the version recorded at pre-registration.** 2.1.219 is running and
     2.1.220 is already on disk; an auto-update silently changes the layout being
     conformed to.
- **Attempt cap, and what it binds.** The readings are deterministic and
  re-runnable, so capping *them* would mean nothing. What is capped is
  restatement: **G1's closing condition may be restated on a different comparator
  ONCE MORE, in total.** After that the recorded conclusion is that G-stop is not
  evaluable in this venue, and the continue/stop decision is made on a stated
  non-metered basis. The cap exists because "the comparator was wrong, not the
  meter" is infinitely available — the same hazard G2 names for implementations
  and B15 for strings.
- **If it falls:** the residual is neither file discovery nor per-request
  selection, since both are now located and specified above. The remaining
  surface is per-record extraction — `readUsage`'s TTL split, and whether
  `usage.iterations` still sums to the top level on every record rather than on
  the ones that were spot-checked. **Do not compensate by widening the
  tolerance**; a tolerance is what this premise removed.
- **What a hold does NOT establish**, stated so it cannot be cited for more
  later: that Anthropic billed these records; that the transcript writer wrote
  every record it should have; that tokens map to the right rate key — 1h/5m TTL
  attribution, model attribution, and the `speed` fast-mode suffix `rateKey()`
  builds are tested by nothing here; and that any absolute dollar figure is
  measurable on this plan.
- **Measured:** — (no run)
- **Status:** **moot** — superseded by B19, see the box at the top of this block.
  It was never measured, so it is `moot` rather than `fallen`. B14's disposition
  exactly, and for the same reason: the premise was sound, its method was not.

## B18 — Claude Code's own accounting of a session equals the on-disk union

- **Assumed:** they agree — (assumed)
- **EXPLORATORY. It cannot open or close G1, and no gate reads it.** B17 asks
  whether the meter reads every billed record **on disk**; that is a claim about
  the meter. B18 asks whether the records on disk are the ones Claude Code
  **credited**; that is a claim about Claude Code's internal consistency, and it
  cannot decide a premise about the meter. The hierarchy is fixed here before
  either runs, with its reason, which is what distinguishes it from choosing the
  gating outcome after seeing both — the move G7's rule 2 exists to prevent.
- **Method:** `claude -p --output-format json` → `result.modelUsage` summed
  across model rows, against the oracle walk over `result.session_id`, on a run
  that spawns nested workflow subagents. Recorded alongside: the CLI version, the
  process `startedAt`, and **both** vectors — the union by `sessionId` and that
  union restricted to `timestamp >= startedAt` — so the process-versus-history
  ambiguity is visible rather than silently absorbed into a residual. If
  `~/.claude.json → projects[<cwd>].lastModelUsage` populates, it is recorded
  unrounded; it is empty for all four entries of this project today, and a
  60-second pilot settles whether that is permanent.
- **Experiment:** one headless run with nested subagents, both vectors archived.
- **Measured:** — (no run)
- **Falls if:** nothing. A disagreement here is a finding about the venue and
  produces a new premise; it does not touch B20's status. Recorded without a
  threshold, deliberately, for the reason above.
- **Status:** open

## B19 — the cost meter counts every billed token a session incurred

> ### ⚠ `moot` — superseded by B20, and killed by the same freeze that killed B17.
>
> A second stop-time review found two more false-negative paths in the oracle,
> both of them **this project's own bug wearing a different costume**:
> `sessionFiles` hardcoded the path segment `subagents`, and `jsonlUnder` caught
> every error and returned `[]`. A corpus whose agent logs sat one directory over
> came back as a clean single-threaded session — 2 requests, 0 subagent, a
> passing invariant, 1,500 output tokens uncounted. See
> `DECISIONS.md § the oracle hardcoded where to look, which is the bug it was built to find`.
>
> **The churn is not the oracle. It is that this premise and B17 both froze the
> IMPLEMENTATION before it was trustworthy, instead of freezing the STANDARD.**
> Three premises have now died to that, none of them for tuning, and a freeze
> that pins a defect in place is not protecting anything. **B20 changes what the
> freeze attaches to**, which is why it is a replacement rather than a fourth
> repetition — and it is the last one this line gets.

**Replaces B17, which is `moot`.** B17 was never measured and nothing about it
was wrong except its instrument: its oracle carried a disjointness invariant that
could not fail and a `cacheWrite` rule that contradicted the repair by 42,558
tokens. Fixing them edited the file B17's VOID condition had frozen, and that
condition also forbade the clock moving twice — so B17 is unscorable by its own
text and this premise takes a fresh number. **IDs are never recycled**; B14 → B16
is the precedent, including that the outcome did not change.

- **INHERITED VERBATIM FROM B17, and that is the point:** the outcome, the
  threshold of **exactly 0**, the **Holds if** and **Falls if** conditions, the
  **admission rule** with its three steps, the **Experiment**, the
  **Method, not threshold** clause, the **disclosure** of what was known when the
  threshold was fixed, and the statement of **what a hold does NOT establish**.
  Read them there. Nothing is re-derived and nothing is loosened — **the
  admission rule did not change in the repair**; only the implementation, and an
  extraction rule the admission rule never specified.
- **What is new, 1 — the extraction rule, which B17 left unstated and should not
  have.** `cacheWrite` is the **top-level `cache_creation_input_tokens`** on both
  sides; the TTL split never overrides it. This is not a choice made here: it is
  what `readUsage`'s own comment already fixes — *"the split is authoritative when
  present **and consistent**; otherwise attribute the whole cache write to the
  5-minute TTL"* — text that predates all of this, which is why adopting it
  cannot be fitting. Fifteen records carry a top-level 0 against an
  `ephemeral_1h` of 2,452 to 4,911; under the two rules the sides differ by
  **42,558 tokens**, so B17 would have fallen on its own oracle's preference.
  Those records and their tokens are **counted and totalled** in the oracle's
  output — visible and unscored rather than invisible and absorbed. Which reading
  Anthropic bills is not decidable from these files, and this premise does not
  score TTL attribution.
- **What is new, 2 — the invariant must be demonstrated capable of failing before
  it may score anything.** B17's disjointness check reported `sharedUuids: 0` on a
  corpus built to violate it, because the per-source sets were filled after the
  de-duplication guard. It was cited as a passing check and was a loop artefact.
  `tests/session-token-walk.test.ts` now holds the corpus where it comes back
  **false**, and this premise's `Holds if` may not be read as satisfied unless
  that test is present and passing. **An invariant never shown to fail is not
  evidence** — the same lesson as B16's negative control arriving by accident,
  learned here on purpose.
- **VOID conditions: B17's three, with condition 2 re-pointed.** VOID unless both
  `evidence/<run_id>.meter.json` and `evidence/<run_id>.walk.json` are committed
  with the full four-class vector per session per side, machine-produced. VOID if
  the Claude Code version that wrote any session differs from the version
  recorded here. And **VOID if `scripts/session-token-walk.mjs` differs from
  commit `9078a49`, or the admission rule changes** — the freeze now attaches to
  a **SHA rather than a date**, because a date froze a file whose defects had not
  yet been found and that is exactly how B17 died. A SHA can be checked; a date
  can only be believed.
- **This clock does not move.** If the oracle needs a third correction, the
  honest reading is that the method is not converging, and the remedy is to say
  so rather than to renumber again. **One more replacement, total** — the same
  cap B17 put on restating G1's comparator, applied to the instrument.
- **Measured:** — (no run)
- **Status:** **moot** — superseded by B20, see the box above. Never measured, so
  `moot` and not `fallen`. **The clause directly above was right about the
  symptom and wrong about the cause:** a third correction did arrive, and it did
  not mean the method was failing to converge. It meant the freeze was pointed at
  the wrong object. B20 spends the replacement this clause allowed, on that.

## B20 — the cost meter counts every billed token a session incurred

**Replaces B19, which replaced B17. Both are `moot`, neither was ever measured,
and neither died of tuning** — they died because their VOID conditions froze
`scripts/session-token-walk.mjs` at a commit before anyone had shown the file was
trustworthy, and it was not: four false-negative paths were found across two
reviews, every one of which would have made the premise HOLD on a broken meter.

**What changes here is the object of the freeze, and that is the whole point of
the renumber.** The thing that must not be tuned is the **standard**, not the
code that implements it. Freezing the code was over-tight in the direction that
matters least and useless in the direction that matters most: it never stopped a
defect, and it pinned four of them in place.

- **"THE STANDARD" IS TWO DIFFERENT KINDS OF THING, AND THE FIRST DRAFT OF THIS
  PREMISE LUMPED THEM.** That was wrong within a day: it claimed everything was
  byte-identical to the pre-registration commit while the oracle had already been
  broadened past the enumeration clause. The two need different treatment and the
  difference is not a matter of taste.
  - **A THRESHOLD CAN BE FITTED.** Move it and the same data changes verdict, in
    whichever direction the author prefers. **Frozen absolutely, from the
    pre-registration commit, no exceptions.**
  - **AN ENUMERATION RULE IS A FACTUAL CLAIM ABOUT WHERE A VENDOR WRITES FILES,
    AND IT MUST BE EXACT.** Under-inclusion hides the defect; over-inclusion
    invents one. Neither is safe, and correcting it is repair rather than tuning
    only because the **thresholds** it feeds are frozen and verified — never
    because of anything about the correction's direction.
- **FROZEN ABSOLUTELY, and byte-identical to the pre-registration commit — this
  part of the claim survives and has been checked:** the outcome, the threshold
  of **exactly 0**, the **Holds if** and **Falls if** conditions, the
  **Experiment**, the **disclosure** of what was known when the threshold was
  fixed, and the statement of **what a hold does NOT establish**. `git diff` over
  `PREMISES.md` from the pre-registration commit touches none of those lines.
  Read them in B17.
  - **Checked field by field at `win-14`, not asserted:** ten bullets extracted
    from B17 at `db4874e` and at `HEAD` and compared byte-for-byte — the heading,
    the HARM/DETECTOR statement, `Metric, exact`, `Experiment`, `Holds if`, the
    single-threaded-arm clause, `Falls if`, why the number is 0, the disclosure,
    and what a hold does not establish. **All ten identical.** The fields that
    differ are the ones amended with a note (`Admission rule`), the consequence
    field `If it falls` — which is not the falsification condition `Falls if` —
    and `Status`. **The check failed vacuously twice before it worked**: once
    comparing `None` to `None` when a regex matched nothing, once on a field
    marker that never existed. It now asserts the markers were found.
- **AMENDED 2026-08-05, and this is the amendment the clause above exists to
  license:** the enumeration is **every `*.jsonl` under `<sessionId>/`,
  recursively** — not `<sessionId>/subagents/**` as B17 wrote it. The original
  clause encoded a literal path segment, which is the identical assumption
  `listTranscripts` makes with its non-recursive `readdir` and **the exact defect
  this premise exists to falsify**. A corpus with agents one directory over came
  back as a clean single-threaded session with a passing invariant.
  - **Timing:** before any comparison has been run, and there is therefore no
    residual the new wording could have been chosen to accommodate.
  - **"BROADENING IS ALWAYS SAFE" WAS WRITTEN HERE AND IS FALSE. Measured, not
    reasoned about.** The claim was that a superset of files can only make the
    oracle count more, therefore only make the meter look worse, therefore never
    be fitted in its favour. **A superset of FILES is not a superset of COUNTED
    TOKENS**, because step 3 is last-write-wins per `requestId`, not a sum. A
    stray `.jsonl` under the session directory holding an early partial copy of a
    group **replaces** the winning record: measured **695 → 5 output tokens** on
    a fixture. That is the file set growing and the count *shrinking* — the
    direction that drives a residual toward zero and can hold this premise on a
    meter that is wrong. A second fixture, a foreign session's record in the same
    place, went the other way: **695 → 4,937.**
  - **So direction is not a safety proxy and the latitude is not bounded by it.**
    What bounds it is: the thresholds are frozen absolutely and verifiably; the
    conformance suite must be green; and **any enumeration change after the first
    scored run requires every existing `evidence/` artifact to be re-emitted**, so
    a change in counted tokens appears as a diff rather than being absorbed.
    Today that costs nothing because no artifact exists — which is exactly why
    the correction is being made now rather than argued about later.
- **THE ADMISSION RULE, STATED HERE IN FULL AND IN ONE PLACE.** B17 wrote it as
  three steps. The oracle now performs four, and for a while the extra one lived
  only in a separate bullet of this premise while B17's three-step text and the
  oracle's own header both still said three. **Two descriptions of one rule,
  disagreeing, is worse than either being wrong** — a reader following "the
  admission rule" got a rule nothing implemented. This supersedes B17's wording
  for B20; B17's stands as history.
  1. **Admit** records with `type: "assistant"` carrying `message.usage`,
     excluding `isApiErrorMessage: true` and `model: "<synthetic>"` — they carry
     a real `requestId` and all-zero usage, so they are excluded **by those
     fields and never by usage reading zero**, since a legitimate record can read
     zero at the top level.
  2. **Require `record.sessionId` to equal this session, unconditionally.** A
     file under a session's directory is not thereby a request *of* that session:
     unguarded, a stray record read **695 → 4,937** output tokens on a fixture.
     **A record with no `sessionId` at all is excluded AND marks the session
     `suspect`** — counted separately, never quietly dropped, because dropping
     them silently is how a session with real traffic comes back empty. That is
     not hypothetical here: this oracle has produced a false empty twice.
     Measured: **0 of 5,595 records in this corpus lack the field**, so requiring
     it costs nothing today and a non-zero count means the layout moved.
  3. **De-duplicate by `uuid`** — RECORD identity across the file union, not
     request identity.
  4. **Group by `requestId`, take the group's usage from its LAST record in file
     order.** A group spanning more than one file marks the session **`suspect`**
     and it is not scored: last-write-wins is undefined there, the oracle cannot
     know which record is authoritative, and guessing is what produced the
     **695 → 5** reading that started this.
  **An earlier draft's guard was conditional on the field being present**, so it
  admitted any record that omitted `sessionId` and did not implement the rule it
  declared one paragraph above. Both guards are zero across the real corpus and
  both are now shown *firing* in `tests/session-token-walk.test.ts`.
- **The emitted artifact must describe the rule that produced it.** For one
  commit the oracle's `rule` string still named `subagents/**` after the walk had
  been broadened, so an `evidence/` file would have carried a false account of
  its own method. Pinned by `tests/session-token-walk.test.ts`. **In this
  repository the artifact is the record**, and a record that misdescribes itself
  is worse than a missing one.
- **Also frozen, inherited from B19:** the **extraction rule** — `cacheWrite` is
  the top-level `cache_creation_input_tokens` on both sides, per `readUsage`'s own
  documented fallback, with the 15 disagreeing records counted and totalled
  rather than resolved.
- **NOT FROZEN: the oracle's implementation, until the first scored run.** It may
  be repaired freely up to that point, and after it any change to
  `scripts/session-token-walk.mjs` **voids that run** and requires a new one.
  **The argument is that this is precisely the anti-tuning rule, stated
  correctly:** tuning means choosing the standard by its answer, and *there is no
  answer to tune toward until a residual exists*. Before the first comparison
  there is nothing to fit; after it there is, and the freeze bites exactly then.
  B17's and B19's version bit a year too early and let go a moment too late.
- **This IS a loosening of B19's letter, and the compensating tightening is named
  rather than implied.** The oracle must pass `tests/session-token-walk.test.ts`,
  and that file must contain, as *negative* controls: the disjointness invariant
  returning **false** on a collision corpus; the walk finding agent logs that sit
  **outside** `subagents/`; the walk **throwing** rather than reporting an empty
  session when a directory cannot be read; and a session with no admitted request
  coming back **void**. A repair that breaks one of those is caught by a check,
  not by whoever is reading the diff that day. **Trust moved from a hash to a
  suite, which is the direction it should have run in from the start.**
- **VOID conditions.** B17's three, with the second re-pointed as above:
  1. **VOID** unless `evidence/<run_id>.meter.json` and
     `evidence/<run_id>.walk.json` are both committed, machine-produced, with the
     four-class vector per session per side.
  2. **VOID** if the oracle changed after the run it scores without every
     existing `evidence/` artifact being re-emitted; if any **absolutely frozen**
     rule above changed at all; or if the conformance suite was not passing at
     the commit the run was produced from.
  3. **VOID** if the Claude Code version that wrote any session in the set
     differs from the version recorded at that run.
  4. **VOID sessions do not count toward the set.** A session with no admitted
     request satisfies "every class differs by exactly 0" on both sides
     trivially; the oracle marks those `void` and they are excluded from the
     ≥ 5. Zero requests is a fact about the corpus, never a verdict about the
     meter.
  5. **SUSPECT sessions do not count toward the set either, and do not fall it.**
     A `requestId` group spanning files makes the walk's own aggregation
     undefined, so the session says nothing about the meter in either direction.
     Excluded and reported, never scored.
- **NO MORE REPLACEMENTS. This line ends here.** B19 permitted one and this is
  it. If the oracle needs a fifth correction, the recorded conclusion is that
  **G1 cannot be closed in this venue**, G-stop is not evaluable, and the
  continue/stop decision is made on a stated non-metered basis. That is a real
  outcome this project is allowed to reach, and reaching it honestly beats a
  sixth renumber.
- **Measured: `run 2026-08-05-win-14-b20`. Residual EXACTLY 0 on every class of
  every session — 4 classes x 11 sessions — and the request counts equal on all
  eleven.** Artifacts: `evidence/2026-08-05-win-14-b20.{walk,meter,comparison}.json`,
  machine-produced, carrying the four-class vector per session per side, the
  `uuid` disjointness counts, the subagent share per session, the Claude Code
  version and the three commit SHAs.
  - **The set was fixed by the enumeration rule, not chosen:** every session
    present at the pre-registration commit `db4874e`. Eleven scored, **none void,
    none suspect, none dropped**, so there is no selection to argue about.
  - **Both required arms are present.** Seven single-threaded sessions as the
    negative control — the arm that shows the repair does not introduce error
    where there was none — and `c9e2fe70` carrying `subagents/workflows/`
    nesting. One Claude Code version throughout, `2.1.219`.
  - **Read from a FROZEN SNAPSHOT of those files.** The live directory grows
    while the session measuring it runs, so a comparison whose input changes
    between its two halves cannot be repeated — which is the whole reason this
    premise demands artifacts. Both sides read one fixed copy.
  - **Conformance suite green at the run's commit:** `tests/session-token-walk.test.ts`,
    14 tests, including the four negative controls this premise requires.
  - **RE-EMITTED, and the first attempt is superseded rather than deleted.**
    `run 2026-08-05-win-11-b20` produced identical vectors from a meter that
    identified a session by its first billable record, while the oracle required
    `record.sessionId` to equal the id it was handed. **Two different rules
    agreeing because filename and records match on all 11 files here — 0 of 11
    disagree — is agreement by corpus, not by rule**, and that is the coincidence
    this premise exists to exclude. The meter now honours the id. Both artifact
    sets are committed; the earlier one is evidence of the instrument, not of the
    result. **A third emission followed**, because each side had also promoted
    the key IT needed — `requestId` for the meter, `uuid` for the oracle — into
    an admission condition step 1 does not state, in opposite directions and
    both silently. **All three runs return identical vectors**, because every one
    of this corpus's 5,669 assistant records carries both keys. Three times now
    the residual was 0 for a reason that was a property of the corpus rather than
    of the rules, and each time a fixture varying one field found what reading
    the two implementations side by side did not.
    **A fourth emission followed, and it is the scored one.** The meter reported
    one fixture record as `admittedWithoutUuid: 1` *and* `excluded.apiError: 1` —
    the same record counted as admitted and as rejected in one payload — because
    the counter sat in the record-level pass, which knows only assistant-plus-usage
    and not the api-error or session checks that decide admission. The symptom was
    that a **rejected** record was counted as admitted, so the number could read
    non-zero on a session that admitted nothing. The oracle counts at the point of
    admission and reported 0. **All eleven sessions report 0 on both sides**, which
    is why this corpus could never have shown it: the fourth time a number agreed
    for a reason belonging to the corpus and not to the rules. Vectors again
    identical; only the instrument commit differs, and that is the whole reason to
    re-emit.
    - **RETRACTED from the sentence above as first written: "it could therefore
      exceed the number of requests admitted."** That was offered as a symptom of
      the defect and it is not one. The counter is over **records** while a
      request is a `requestId` **group**, and **neither number bounds the other**:
      measured 3 against 1 request where one group holds three uuid-less records,
      and 2 against 4 where two of them share a group and three others carry
      uuids. Counting per record is deliberate — each could reappear in a second
      file undetected, so a per-group count can understate the risk, equalling it
      when a group holds one such record and falling below when it holds several.
      **Three statements about this field were wrong in three consecutive
      commits, each an existential dressed as a universal.** "It can never
      exceed the request count", pinned as a test assertion that passed only
      because the fixture's counter was 0. "It exceeds by design", which reads as
      always. "It does exceed whenever one group has several such records", a
      sufficient condition that is not one — case B above satisfies it and does
      not exceed. Each was refuted by a fixture, and the test now pins **both
      directions**, which is the only form that cannot rot back into an ordering.
      Nothing scored changes: `win-14`'s artifacts carry 0 for all eleven
      sessions, and the oracle marks any session with a non-zero count `suspect`,
      which drops it from the set before it can be compared.
- **What the repair recovered: 390 of 2,703 billed requests were invisible.**
  The meter printed `(N main, 0 subagent)` on every session for four days. The
  gap is not spread evenly — `514a829f` is 78% subagent by request count while
  seven sessions have none at all — which is why it was never a constant and why
  no scale factor could have corrected an old number.
- **Status:** **holding**

## B2 — `hookSpecificOutput.updatedToolOutput` changes what is BILLED, not only what is displayed

- **Assumed:** it does — (assumed, from documentation only)
- **Source of the assumption:** the Claude Code hooks reference states
  `updatedToolOutput` "replaces the tool's result". No billing observation.
- **Experiment:** start a **fresh** session; run a command with large filterable
  output; compare `cache_creation_input_tokens` on the following request with the
  hook enabled versus disabled.
- **Measured:** the replacement never reached the transcript at all,
  `run 2026-08-02-win-03`. The hook fired on a real command (telemetry: 30,136
  bytes raw → 8,462 returned, spill written) and that command's transcript entry
  holds **30,000 characters of raw output** — Claude Code's own truncation cap —
  with no trace of the hook's marker. No fresh-session experiment was needed;
  the answer was already in transcripts on disk.
- **Falls if:** no measurable difference in `cache_creation_input_tokens`. It
  failed harder than that: no difference in what was *stored*, let alone billed.
- **If it falls:** the hook is worthless and its work migrates inside the MCP
  tools, where we control the returned payload directly. Gate G2 closes.
- **Status:** fallen

> ### ⚠ Falsified — and the disposition of G2 is a pending decision.
>
> What is falsified is **this implementation**: the hook returns
> `updatedToolOutput` as a bare string, while a Bash result is
> `{stdout, stderr, interrupted, isImage}`. That shape mismatch is a specific and
> cheap explanation, and the correct shape is visible in the same transcripts.
>
> **G2 is now `closed` (dead)** and the hook is unregistered from
> `.claude/settings.json`. The retest is not forbidden — it is written into G2 as
> a reopening condition with its threshold and its one attempt fixed in advance,
> so running it later is executing a commitment rather than relitigating a result.
>
> The old caution still stands: **no saving may be attributed to the hook as
> "measured"** anywhere. It is now **enforced rather than stated** — the cost
> meter was quietly crediting `hook:Bash` with 21,674 suppressed bytes in two
> sessions until `run 2026-08-02-win-03`. A telemetry row carrying no
> `invocation_id` cannot point at the transcript entry it produced, so it is
> excluded from `savedFraction` and reported as `unverifiable`. The rule is
> general: it catches the hook because the hook mutates someone else's result and
> has none of its own, not because it is named.

## B3 — test/build output has ≥ 60% suppressible bytes

- **Assumed:** ≥ 60% — (assumed for the general case)
- **Source of the assumption:** two synthetic probes plus the published range for
  comparable deterministic filters (60–90%).
- **Experiment:** take the median of `1 - bytes_returned / bytes_raw` over 20 real
  `gate` calls from ordinary work, read from `.local-coder/telemetry.jsonl`. The
  experiment used to run the hook; G2 closed, so the premise now stands or falls
  on the tool that actually does the suppressing.
- **Measured:** median **98.67%** over **12** real in-session `gate` calls — 11
  from `run 2026-08-03-mac-06`, plus the 98.1% (97,544 → 1,814 bytes) of
  `run 2026-08-03-win-01`. **12 of the 20 the experiment asks for**, so the
  premise is not decided, but the median sits far above both the 60% assumption
  and the 40% fall line. The 97% of `run 2026-08-02-win-01` is excluded: it was a
  direct invocation, and the experiment says *from ordinary work*. The 99% figure
  from a 604-line failing test run is **not counted here** either — it came from
  the hook, which G2 closed, so it measures a component nothing uses.
- **The distribution is bimodal, and that is the finding the median hides.**
  **3 of the 11** calls made the context **worse**: two at 213 → 823 bytes
  (−286%) and one at 1,395 → 1,938 (−39%). The mechanism is mechanical, not
  anomalous — when a check emits a couple of failing lines, `gate`'s structured
  envelope costs more than the raw text it replaces, and nothing in the tool
  compares the two. A tool that cannot lose to its own input would return the raw
  output whenever raw is smaller. This does not bear on B3, which is a median
  premise and passing it comfortably; it is recorded as a design defect so the
  headline number does not bury it.
- **The same defect is in `repair`, and `run 2026-08-04-mac-09` splits the two
  modes cleanly by check kind.** Over 20 `repair` calls:
  - **`npm-test`-gated, 8 calls: median −99.6%** — that is, 99.6% *smaller*.
    Totals **1,919,136 → 6,859 bytes**, 280x. This is the mode that justifies
    the whole first lever.
  - **`tsc`-gated, 12 calls: median +378.6% bigger**, totals **2,308 → 10,048**,
    and negative in **12 of 12** with no exceptions. When the raw output is a
    couple of hundred bytes the structured envelope costs more than the text it
    replaces, every time.
  Those are `repair` calls, so still **not B3 data** — B3 counts `gate` calls —
  but the mechanism is the same one and the split is now unambiguous with n=20.
  It also corrects the reading of `run 2026-08-04-mac-07`, where 4 of 4 rows were
  negative and only the bad mode was visible. **The tool's byte value lives
  entirely in the test half**, and a tsc-only call is byte-negative every time.
- **Falls if:** median < 40% over 20 real `gate` calls.
- **If it falls:** structured extraction is worth less than assumed and the whole
  first lever shrinks — `gate` would still collapse turns (B5), but its byte
  argument would be gone. Do not compensate by widening what it strips.
- **Status:** open

## B4 — reversible suppression does not reduce the task success rate

- **Assumed:** no measurable reduction — (assumed)
- **Source of the assumption:** the failure mode is documented and specific.
  arXiv 2607.12161 measured an **irreversible** arm that removed 38% of
  tool-output tokens and cost **6.8% MORE** (CI +2.8% to +11.3%), dropping patch
  application from 27/40 to 15/40 by destroying verbatim edit anchors. The
  mitigation is reversibility: full text spilled to `.local-coder/spill/` with
  the path returned, plus a hard bail-out on diffs and git porcelain.
- **Experiment:** 20 tasks run with the hook on and off; compare completion
  without human correction. **No longer runnable:** G2 is `closed` and the hook is
  unregistered, so there is no "on" arm to compare against.
- **Measured:** — (no run)
- **Falls if:** success drops > 5 pp.
- **If it falls:** narrow the suppression rules to progress/install lines only,
  or drop the hook. Do **not** compensate by tuning thresholds.
- **Status:** moot — the risk it guarded left with the hook. `gate` does not
  truncate text; it parses output into typed failures, so it cannot destroy an
  edit anchor the way heuristic head/tail capping can. If G2's reopening
  condition is ever met, B4 goes live again unchanged.

## B5 — `gate` reduces verification from ≥ 3 turns to 1

- **Assumed:** ≥ 2 turns saved per verification — (assumed)
- **Source of the assumption:** lint, type-check and tests are three separate
  Bash round-trips today; `gate` runs all configured checks in one call.
- **Experiment:** count `gate` calls versus the Bash verification round-trips they
  replace, in the transcript, over 20 real tasks.
- **Measured:** 1 turn collapsed, `run 2026-08-03-win-01` (confirming
  `run 2026-08-02-win-01`). **This repository cannot decide B5.** It configures two
  checks — `tsc` and `npm-test`, no lint — so one collapsed turn is the structural
  ceiling here, and a premise whose threshold is ≥ 2 can never be met in this
  venue. Measuring it needs a project with three or more configured checks. Do not
  read the 1 as evidence against the mechanism; it is evidence about the repo.
  `run 2026-08-03-mac-06` shows the same ceiling from the other end: one call
  narrowed to `checks: ["tsc"]` alone collapsed **0** turns and cost bytes on top
  (1,395 → 1,938), so in that configuration `gate` is strictly negative on both
  levers at once. Narrowing the checks is what makes it so — a caller's choice,
  not a property of the tool.
- **`run 2026-08-04-mac-10` observed the predicted failure mode directly.** A
  real 8-hour session building a Tetris: **36 `Bash` calls, 0 `gate` calls, 0
  `repair` calls.** The tool built to collapse verification into one call was
  not reached for once, and the nine delegated fixes went to `fix` — the
  one-shot — rather than to the loop that is the project's turn-collapse lever.
  The "if it falls" line below wrote this outcome down before it happened, which
  is the good news and also the whole problem: **a tool nobody calls cannot be
  measured, and its description is what decides that, not its mechanism.**
- **A limit the premise never stated: the gate only sees the configured checks.**
  In that session the delegated work lived in `tetris/*.js`, which is on the path
  of neither configured check, so `gate` returned **green on a broken artifact**
  and `repair` had nothing to loop on. The failures became reachable only after a
  human hand-wrote a test to produce error output. Delegating into a directory
  the project does not already check leaves both tools blind.
- **That limit is now visible in the tool's own return**
  (`run 2026-08-04-mac-18-coverage`). The first real call carrying `coverage`
  came back `passed: true` with `commands` = `tsc` + `npm test` and
  `changed_files` = `["tetris.html", "tetris/"]` — neither command on the path of
  either changed path. The reading given back, unprompted, was that the result is
  **silent** about those paths rather than a verification of them. The silence
  itself did not change; what changed is that it is now sayable from the payload
  alone, without a reader who already knows the check configuration. **This does
  not move B5's threshold** — B5 is a median over turns saved, and one
  operator-requested call yields none. Its 127,347 → 726 bytes is likewise
  **excluded from B3**, which counts calls from ordinary work.
- **Falls if:** < 2 turns saved on median.
- **If it falls:** the problem is almost certainly the **tool description** losing
  to the instinct to reach for Bash, not the tool. Rewrite the description before
  concluding anything about the mechanism.
- **Disposition of `run 2026-08-04-mac-10`: VOID for B5, not evidence against
  it.** The threshold above is a median over turns saved, and a session with
  zero `gate` calls produces no median — so that run could not have moved this
  premise in either direction, whatever it showed. The threshold is left exactly
  as written: editing a number after seeing a result is the move this registry
  exists to prevent, and a session being unable to test a premise is a fact
  about the session. **B15 is where that run's finding is actually scored**, and
  it is a different quantity: whether the tool gets reached for at all.
- **A second thing that run exposed, and it is not the description's fault:**
  `README.md` has always told users to install a `CLAUDE.md` routing policy
  whose first line is "Verify with mcp__local-coder__gate, never by running
  lint/tsc/tests through Bash" — and no `CLAUDE.md` existed on that machine, in
  this repository, or anywhere else. mac-10 measured an **unconfigured
  install**. The server now writes that file itself (`src/claude-md.ts`), which
  is Arm 0 of B15 and the cheaper arm by the rule `ROADMAP.md` already states.
- **Status:** open

## B0 — the delegation tools can operate on this project's own files

- **Assumed:** implicitly, and never stated until it failed — (assumed)
- **Source of the assumption:** none. It was never written down, which is why it
  was never checked.
- **Experiment:** call `implement` on a file of ordinary size for this
  repository and see whether the result arrives complete.
- **Measured:** **it does not.** `run 2026-08-03-mac-05`: `implement` truncated
  repeatedly on `src/selection.ts` (380 lines) with `qwen3-coder-30b` and the
  default 8192-token cap. `IMPLEMENT_SYSTEM_PROMPT` in `src/tools/shared.ts`
  requires the model to return *the complete final content of every editable
  file*, so output is the **sum** of the files in the request, regenerated on
  every attempt and every `repair` round. `repair.ts` was 699 lines at that run;
  `report.ts` 554. (Both have since grown past 1,000, which sharpens the point
  rather than dulling it; the figures stand as measured.)
- **Falls if:** it already has — the ceiling is structural, not a tuning knob.
- **If it falls:** B6 and B7 are measuring a tool that cannot reach the files
  they claim to be about. Either the output contract stops being whole-file, or
  the tools are scoped to small files and said to be. **Raising
  `LOCAL_CODER_MAX_OUTPUT_TOKENS` buys headroom, not a fix:** the cost still
  scales with total file size × rounds.
- **Disposition, decided:** the **second** option — the tools are scoped, and
  they say so. `enforceOutputCap` estimates the whole-file answer for the
  editable files and **refuses** before anything is read or generated, mirroring
  what `enforceContextCaps` already does for the input. The output contract is
  unchanged, so `DECISIONS.md § Model output contract` stands as written.
  - **How much this repo keeps**, measured **on the tree of 2026-08-04** and not
    re-counted since (estimate `bytes/3.5`, cap 8192) — the repo has grown, so
    read these as the census of that day, not of today:
    **43 of 46** `.ts` files fit alone (93%; the three that do not are
    `repair.ts`, `repair.test.ts`, `cost-meter.test.ts`), and **11 of 13**
    source+test pairs fit (85%). At the shipped 0.9 headroom the bar is 7372
    tokens, which also refuses `gate.ts` + its test (8075) — **10 of 13** (77%).
    The repo is not behind a wall; it is sitting on the edge of one.
    **Counted on a CRLF checkout**, so these are the pessimistic side: the same
    files are ~1% smaller with LF endings (`run 2026-08-04-mac-08`), and a pair
    within 1% of the bar can therefore land on either side of it by machine.
  - **Verified against a real server**, `run 2026-08-04-mac-08`: the request that
    truncated in `mac-05` is now refused with `output_would_truncate` and writes
    **no telemetry row at all** — the property that un-shares the label — while a
    request that fits passes the pre-flight and reaches the gate normally.
  - **Why refusing is worth more than the coverage it costs.** A truncated
    response throws and lands under `stopped_because: "model_failed"`, the same
    label a genuine loop failure gets. That shared label is what made B6
    unmeasurable. A refusal happens before any round, so it cannot be confused
    with one — **B6 becomes measurable without touching the output contract.**
  - **`scaffold` is deliberately not covered.** It does not go through
    `runGeneration`, and its files do not exist yet, so there is no input size to
    estimate an output from. Recorded rather than left as a silent hole.
  - **`run 2026-08-04-mac-10` put a price on that hole.** Six `scaffold` calls
    all returned `created` with no error, and the composed program did not run:
    rotation inert, gravity inverted, malformed piece data. **`created` claims
    only that syntactically parseable output was written at the requested path**
    — not that the file does what the spec said, not that it composes.
    `scaffold` is the one tool missing three nets at once: no gate, no output
    pre-flight, and **no telemetry row at all**, so six calls of real work left
    nothing in the log. Of the 2,055 lines it generated, **51.2% were dead code**
    in the composition, because three of six files ignored a constraint carried
    verbatim in every spec and one of them replaced the shared global instead of
    extending it. That is what a 30B local model does with a cross-file contract
    whose other side it cannot see.
  - **What did NOT happen:** the whole-file contract was not replaced with
    anchored search/replace blocks. That is **G7** in `ROADMAP.md`, with its
    opening threshold fixed in advance and decided by the corpus running under
    this refusal.
- **Status:** **fallen**, disposition decided. B6's blocker is cleared; B0 itself
  stays fallen, because what the premise claims — that the tools reach this
  project's own files — is still false for 15–23% of them.

## B6 — `repair` closes ≥ 50% of mechanical failures within 3 rounds

- **Assumed:** ≥ 50% — (assumed)
- **Source of the assumption:** none worth the name. **This is the premise with
  the least evidence in the project.** `repair` has never been run against a real
  local model; every test uses a mocked one.
- **Experiment:** 20 real mechanical failures (type errors, failing assertions,
  lint, missing imports); record `passed` and `rounds_used`.
- **Corpus #1 is SYNTHETIC, and its distribution is chosen rather than
  observed.** `scripts/corpus-run.sh` drives 20 tasks — 8 type errors, 4 missing
  imports, 8 failing assertions — and that split is somebody's decision, so any
  rate it produces carries the caveat **on the same line as the number**. Two
  reasons it could not be observed instead, both checked rather than assumed:
  - **The repo's history does not contain mechanical failures.** All 17 `fix:`
    commits touching `src/` and `tests/` insert 17–368 lines, and every subject
    describes a reasoning error. Reverting one yields a design task wearing a
    red gate, which is the wrong category.
  - **No archive of real failures existed.** `gate` parsed a typed `Failure[]`
    on every red run and wrote `{checks, passed}` to telemetry, so the failures
    were computed and dropped. Fixed now — the capture hook writes them to
    `.local-coder/corpus/`, and **corpus #2 is the one that measures** instead
    of choosing.
- **Lint is structurally unreachable in this venue.** This repo configures no
  linter, so one of B6's four categories cannot appear in any corpus taken here.
  Same shape as B5's ceiling and for the same reason: the repo, not the tool.
  A rate measured over three categories is not a rate over four.
- **Measured:** **1 task, 11 `repair` calls, and still not a rate.**
  `run 2026-08-03-mac-06` recovered the payloads `run 2026-08-03-mac-05` reported
  it could not find. They were never missing: telemetry writes `rounds_used`
  under the name `turns_collapsed` — the `rounds_used` and `turns_collapsed`
  writes in `repair.ts` are the same expression, `rounds.length` — so a search
  for `rounds_used` in the log was always going to
  come back empty. Archived as `evidence/2026-08-03-mac-06.telemetry.jsonl`.
  - **10 calls entered with a red gate; 2 closed.** The 11th ran on an
    already-green tree (0 rounds, no files, the `gate.passed` branch that
    `repair.ts` logs as *checks were already green; nothing to do*) and is
    excluded — a call with no
    failure to close cannot count as a closure.
  - **2 of 10 is not B6's rate and must not be read as one.** B6 counts
    mechanical *failures*; those 10 calls are successive passes over roughly the
    same failure, so the denominator is still about one task.
  - **Both closures took exactly one round.** No second or third round closed
    anything in this corpus.
  - **3 of the 4 `max_rounds` calls returned `files: []`** — and that is stronger
    than a low close rate. `files` derives from `best.contents`
    (`repair.ts`), which is replaced only when a round *lowers* the failure
    count, so an empty list after exhausting the rounds means no round ever
    improved on the original bytes. Those three burned 4, 3 and 3 rounds: **10
    rounds of local generation that reduced the failure count zero times.**
  - **This corrects the previous run's wording.** "It did not close" was wrong as
    written — two calls did close, both in one round. What no single call did was
    close the *original* failure within 3 rounds.
  - **`run 2026-08-04-mac-07` adds one more failure that did not close.** A
    6-line fixture went `2 → 1 → 1 → 1` over three rounds and stopped at
    `max_rounds` with `passed: false` and a one-line diff: round 1 removed one of
    the two type errors, rounds 2 and 3 changed nothing. Same shape as the corpus
    above, where no round after the first improved anything either. **Still not a
    rate**, and now for a second reason — the fixture is synthetic.
  **B0 fell underneath this and the payload cannot separate them:** a truncated
  response (`finish_reason=length`, the `result.finishReason === "length"` branch
  in `shared.ts`) throws after the corrective
  retry and lands under `stopped_because: "model_failed"` — the same label a
  request killed by the deadline used to get. The deadline half is fixed, and by
  **observing** which ceiling fired rather than inferring it: the request ceiling
  is `min(config.timeoutMs, remaining)`, so the loop records the `remaining` that
  went *into* that `min` and reports `budget` when it was `<=` the per-request
  limit. Neither downstream signal can stand in for it — a clock read after the
  abort has already moved, and the applied value maps a tie and a comfortable
  budget onto the same number. **That half is now verified against a real model**
  (`run 2026-08-04-mac-07`): with the ceiling at 20000 ms, an applied 14061 ms
  reported `budget` and an applied 20000 ms reported `model_failed`, twice — the
  label flipping with the ceiling and nothing else, across three rows with no
  counterexample. The `budget` row carries one round holding a timeout error, so
  it went through the new branch (`repair.ts:625`) and not the pre-existing
  between-rounds one (`repair.ts:519`), which would have produced zero rounds.
  The truncation half is **not** fixed, so a
  `model_failed` row still means *either* B0 *or* the loop, and B6 cannot be
  measured cleanly until the output contract is decided.
- **`run 2026-08-04-mac-09`: 20 of 20, on the synthetic corpus.** Type 8/8,
  import 4/4, assert 8/8, with `qwen3-coder-30b-a3b-instruct-dwq-v2`. Nineteen
  closed in one round; `import-03` took two — the model wrote the wrong module
  specifier, the gate returned, and it corrected. That is the only task in the
  corpus where the loop did what the loop exists to do.
  - **This does not decide B6, and the reason is the word *real* in the
    experiment above.** The fixtures are single-fault, single-file and a few
    hundred bytes, which deviates from the written experiment in exactly the
    direction that inflates a close rate. The threshold is cleared twice over
    and the premise stays `open` until corpus #2, which the capture hook is
    collecting from real work.
  - **The two halves do not carry the same weight, and 100% must not read as one
    uniform thing.** The 8 assertion tasks are pinned by tests: a failing
    assertion closes only by making the code do the thing. The 12 tsc tasks go
    green either by fixing the fault or by silencing the type, and the telemetry
    cannot separate those — `stats` is `{added:1, removed:1}` for both. Under
    B6's own definition closure *is* the gate going green, so all 20 count; the
    **8 of 8 behaviourally verified** is the number that cannot be gamed.
- **Falls if:** < 30%.
- **If it falls:** `repair` degrades to a one-shot `fix` with a gate around it,
  and the turn-collapse lever is worth roughly a third of the estimate.
- **Status:** open — measured far above the threshold, on a corpus the premise
  did not ask for.

## B7 — a `repair` round costs ≤ 90 s

- **Assumed:** ≤ 90 s — (assumed)
- **Source of the assumption:** a local model generating one file plus one gate
  run, on the target hardware. Untested.
- **Experiment:** the same 20 failures as B6; take the median of
  `model_latency_ms + gate_ms` per round.
- **Measured:** **median 2.15 s per round**, `run 2026-08-04-mac-07`, model
  `qwen3-coder-30b-a3b-instruct-dwq-v2`. The instrument gap is closed — the
  per-round trace now reaches telemetry — so this is the first time B7's own
  statistic has existed in the log. Three completed rounds, `model_ms + gate_ms`:
  **12.60 s, 2.15 s, 1.84 s**. **It does not decide B7:** n=3 from ONE task, on a
  6-line synthetic fixture chosen small on purpose to escape B0, against an
  experiment that asks for 20 real mechanical failures. Comfortably below both
  the 90 s assumption and the 150 s fall line, and that comparison is not yet
  worth much at this n.
  - **The cold round costs ~6x the warm ones** (12.60 s against 2.15 and 1.84).
    Round 1 carries model load and prompt processing. So whatever median B7
    finally reports depends on how many rounds in the corpus are cold: a corpus
    of one-round tasks measures something near 12.6 s, a corpus of long loops
    something near 2 s. **The corpus must record the split, not only the median.**
  - **Three further rounds are censored and excluded.** They timed out before the
    gate ran (`model_ms` 20137, 20145, 14199; `gate_ms` 0), so they measure the
    per-request ceiling rather than the round. Putting them in the median would
    measure the instrument.
  - **`run 2026-08-03-mac-06`'s upper bound stands unchanged as history:** median
    **93.6 s** of `latency_ms / rounds` over the 10 calls that had a failure to
    fix (per call, seconds: 9.8, 13.9, 52.1, 77.7, 85.2, 102.0, 222.0, 300.1,
    305.5, 325.9). It over-attributes on purpose — the first gate, the rollback
    and the tree fingerprint are all charged to the rounds — and the real
    per-round figure landing far below it is what that construction predicted.
  - **Which model produced these timings is recoverable only for the call that
    succeeded.** `repair` assigns `model` after `runGeneration` *returns*
    (`repair.ts:576`), so a round that throws discards the name `resolveModel`
    already produced inside it, and `model` never reaches telemetry at all — it
    lives only in the returned payload (`repair.ts:717`). Failed rows therefore
    cannot be attributed to a model, and failed rows are exactly what B6 counts.
    **Fixed in this commit:** `runGeneration` announces the model through
    `onModelResolved` the moment it resolves and *before* the first request, so a
    round that throws still names it, and the telemetry detail now carries it. A
    `null` there means no generation ever started — which is a fact, not a loss.
- **`run 2026-08-04-mac-09`: median 2.10 s over 21 rounds** (2.07 s excluding the
  one cold round; range 1.81–10.12 s). First figure with n > 3, and it does not
  decide B7 either — the fixtures are a few hundred bytes, and B0 established
  that generation cost scales with file size, so a real failure on a real file is
  slower by an unknown factor.
  - **THE MODEL IS NOT THE BOTTLENECK IN A ROUND**, and this is the finding that
    changes what to do about B7. `model_ms` is ~1.2 s in *both* halves of the
    corpus. What differs is the gate: **0.74 s** for `tsc` against **3.63 s** for
    the test suite, so a test-gated round costs **4.82 s** against **1.99 s** —
    2.4x, on the same model and the same size of fixture. The lever for lowering
    B7 is therefore the **gate**, narrowing what a round re-runs, and not the
    smaller or faster local model the "If it falls" line below reaches for.
  - **B7's median is a statement about the check mix.** A corpus that is mostly
    type errors reports a different B7 than one that is mostly tests, on
    identical hardware. Whatever corpus finally decides this has to record its
    mix, or the number cannot be compared to the next one.
  - **The cold round confirms `mac-07`:** 10.12 s against 20 warm rounds between
    1.81 and 5.04 s. One cold round per session, so its weight falls as a corpus
    grows — another reason the split is reported and not just the median.
- **Falls if:** median > 150 s.
- **If it falls:** three rounds cost more wall-clock than the user will accept.
  Lower `max_rounds` to 2, or narrow what the gate re-runs per round — **not**
  "pick a smaller model", which `run 2026-08-04-mac-09` shows is aimed at the
  wrong term. Re-measure B6 after.
- **Status:** open

## B8 — `locate` arm A (ripgrep + import graph + git recency, NO model) finds the right files ≥ 70% of the time

- **Assumed:** ≥ 70% — (assumed)
- **Source of the assumption:** code has an index and documents do not; exact
  search should carry most of the recall.
- **Experiment:** a gold set of ~20 tasks with known target files, zero lexical
  overlap between the task text and file/function names.
- **Measured:** — (no run)
- **Falls if:** < 50%.
- **If it falls:** RAG stops being optional. Gate G3 opens and the Mac's `D7`
  diagnostic has to be built after all.
- **Status:** open

## B9 — local triage (arm B) adds ≥ 10 pp over arm A

- **Assumed:** ≥ 10 pp — (assumed)
- **Source of the assumption:** SWE Context Bench (arXiv 2602.08316) finds smaller
  models can perform context-gathering phases on coding tasks without hurting
  patch quality.
- **Experiment:** the B8 gold set, run with and without the triage step.
- **Measured:** — (no run)
- **Falls if:** < 5 pp.
- **If it falls:** cut arm B. `locate` stays deterministic, needs no local model,
  and gets faster.
- **Status:** open

## B10 — discarded candidate patches (arm D) add ≥ 10 pp over A+B

- **Assumed:** ≥ 10 pp — (assumed)
- **Source of the assumption:** AI21 "first scale, then enrich" — generating
  candidates first and using where they tried to fix things as the localization
  signal cut blind spots 9.3% → 2.7%. **Caveat that must not be dropped:** they
  used a frontier model at all three steps, so they demonstrated the *pipeline
  order*, not the cheap/frontier split this premise assumes.
- **Experiment:** the B8 gold set, with and without the candidate-generation step.
- **Measured:** — (no run)
- **Falls if:** < 5 pp.
- **If it falls:** cut arm D. It is the most speculative arm and the most
  expensive in local compute.
- **Status:** open

## B11 — `locate` avoids reading the whole file in ≥ 70% of cases

- **Assumed:** ≥ 70% — (assumed)
- **Source of the assumption:** pointers are only cheaper than content if the
  pointer is trusted. This is the assumption, not a finding.
- **Experiment:** count `Read` calls on a file that a preceding `locate` already
  pointed into, in the transcript.
- **Measured:** — (no run)
- **Falls if:** < 50%.
- **If it falls:** **REVERT `locate`. Do not tune it.** If Claude reads the file
  anyway, the pointers cost *on top of* the read and the tool is strictly
  negative. This is the one premise whose failure means deletion, not adjustment.
- **Status:** open

## B12 — a task done with the server installed costs ≥ 30% less billed Anthropic context than the same task done without it

- **Assumed:** ≥ 30% — (assumed; the per-lever estimate behind it is a derivation
  over the measured cost split, not a measurement)
- **Source of the assumption:** the cost decomposition plus the positional
  multiplier.
- **PRE-REGISTERED 2026-08-05, BEFORE ANY OBSERVATION EXISTS.** The full design
  is frozen verbatim in `evidence/2026-08-05-b12-preregistration.json`,
  **sha256 `5d42b19a899d4cc4538fcdb4d7573d17cf8ca9d4cb557f148c1746e6181ea55e`**,
  committed as an ancestor of every observation. It carries the clauses this
  entry states plus the ones only an implementer needs: 23 VOID conditions, 11
  artifacts with their field lists, 16 covariates, and the run script's
  obligations. **What is written here decides; what is written there implements.**
  Freezing by hash rather than by prose is deliberate — B20 spent four emissions
  discovering that a frozen claim nobody can check is not frozen.
  - **How it was produced, because the method bounds what it is worth:** three
    independent designs from different angles, each attacked on four adversarial
    lenses by reviewers told to refute rather than to be fair, then synthesised.
    **12 attack passes, 120 findings — 38 rated fatal, 72 major. No design
    survived intact.** Four load-bearing claims were verified against the code
    before being accepted; one was a defect in code shipped that same morning
    (`wouldHaveAdded` hardcoding the main thread, fixed at `47b65f7`).
- **States the outcome as the HARM, not the DETECTOR.** The harm is *the task
  cost the same or more*. `savedFraction` is named separately under **Method**,
  so a detector found blind falsifies the METHOD and leaves B12 standing. B14
  returned a pass because its detector could not look; this is written so that
  cannot repeat.
  - **"a task", not "an attempt":** scored only if the task's committed
    acceptance command exits 0. Otherwise the numerator is earned at a
    verification step and the denominator is croppable by quitting, so every
    fraction rises by giving up.
  - **"installed", not "invoked":** a task that never calls a tool still pays the
    tool schemas in every system prompt of every thread. `unitsAddedByInstallation`
    is a term in the metric, not a caveat.
  - **"less billed Anthropic context", never "less cost":** `repair`, `scaffold`,
    `implement` and `fix` move work to a local model whose tokens and seconds are
    outside the denominator **by construction**. A reduction here is consistent
    with a pure relocation.
- **Method, not threshold:** the counterfactual accounting in `src/cost/report.ts`,
  joined by `invocation_id`, priced from `.local-coder/rates.json`. It is
  PRIMARY and runs FIRST; the paired A/B runs second and **can only kill a hold,
  never grant one**.
  - **"The estimator is a floor" is DELETED — it is false, and no verdict
    asymmetry may rest on it.** Four biases, each measured here, and they run in
    BOTH directions: the positional multiplier takes `T` from the treated
    session's own segment, which the tool lengthened by being called; the
    numerator is uncapped above Claude Code's own 30,000-character truncation
    ceiling (B2); `Math.max(0, …)` records a byte-negative call as zero, and
    negative is the majority mode on a TypeScript repo (`run 2026-08-04-mac-09`:
    `repair` negative **12 of 12**); and the refusal machinery deflates silently —
    four sessions once printed a confident `0.0000` while refusing **534,443
    units**.
  - **Therefore the scored quantity is a BRACKET, not a point.** `R_lo` credits
    every row at the cache write alone and zero re-reads; `R_hi` uses the
    observed segment. Publishing a bound as a point value is the error the
    `savedFraction` withholding rule already exists to prevent, one level up.
- **Unit of observation: ONE TASK WINDOW**, delimited by a `requestId` snapshot
  taken immediately before and diffed immediately after — any id absent from the
  pre-snapshot was **originated** by the task. **Not a session:** `ROADMAP.md` G1
  is narrowed to say why. The snapshot covers **every project slug this machine
  writes to**, because a one-slug snapshot returns `inherited = 0` for arms that
  wrote elsewhere, which is a check that cannot fail — and each arm runs in a
  fresh worktree, so its slug does not exist when the "before" is taken.
  **Corrected 2026-08-05: at that scope the snapshot is 56 slugs, 7,158 files and
  70,453 ids, and takes ~25-31 s, not the 0.69 s first recorded** — that figure
  was one slug, and one slug is exactly the scoping the clause forbids. Two per
  observation over 45 observations is ~40 minutes, which is the price of making
  inheritance impossible by construction rather than by inference.
- **Scored as a VECTOR, not a scalar:** pooled `R`, plus `R_gate`, `R_repair` and
  an explicit `R_other`, because G-stop requires each delivery to pay for itself
  and pooling lets one delivery's exposure hold another's verdict hostage.
- **Holds if** all seven conditions in the frozen design, of which the first is
  **`R_lo` ≥ 30% over ≥ 20 admitted observations** — the WHOLE bracket clears the
  line, the only reading of a frozen threshold against an interval that does not
  require picking a point after seeing the data. A hold must also survive
  deleting its best task, its best row, and reinstating everything it dropped.
  - **Said now rather than in a post-mortem: this may be unreachable.** On a
    25-request task suppressing 200 KB at the write component alone, `R_lo` is
    roughly 26%. **It is genuinely possible that no honest run of this design
    ever holds.** That is a fact about the design's power, disclosed before the
    data, not an excuse to be discovered after it.
- **Falls if `R_hi⁺` < 15%** — computed at the observed segment, over the FULL
  observation set, granting every refused and excluded unit its measured
  magnitude. A fall stops the project, so it must survive the most generous
  arithmetic the data admits.
  - **And the fall is CONDITIONAL.** It stands unappealed only if no refused
    magnitude is `null`, `R_hi⁺` was evaluable, the excluded observations do not
    carry more tool calls than the admitted ones, and both subagent strata are
    evaluable and both below 15%. Otherwise it is `open — provisional` until the
    A/B lands. **A fall on a deflated instrument stops the project permanently,
    which is strictly the worse of the two errors**, and every source design
    guarded only the other one.
  - **A bracket straddling a line is `open`, with both ends published.** `open`
    is not a defeat; it is what an interval spanning a threshold honestly says.
  - **Two subagent strata in different bands with a clean refusal ledger is
    VOID, not a fall** — that is the signature of a coverage bug, the shape that
    hid 390 of 2,703 requests for four days.
- **Why these numbers, and they are not being re-derived:** `git log` shows B12
  edited exactly once, at `59cf135` on 2026-08-02, and never since. **30% and 15%
  pre-date every measurement in this file's B12 line and have never moved.** Two
  numbers in the design have no ancestor — the pacing ceiling and the per-task
  denominator share cap — and both are labelled CHOSEN rather than derived, in
  the pre-registration commit, before any observation.
- **Attempt cap: TWO registered scored runs**, on B20's "no more replacements"
  basis, with the second manifest sealed and hashed at the SAME commit as the
  first so attempt 2 is a pre-registered replication rather than a re-draw
  informed by twenty per-task outcomes. A VOID consumes an attempt except for
  enumerated vendor-side causes. After two, **the recorded conclusion is that
  G-stop is not evaluable in this venue** and the continue/stop decision is made
  on a stated non-metered basis.
- **What a hold does NOT establish** — eleven items in the frozen design; the
  four that bite hardest:
  1. **NOT that G-stop is satisfied.** G-stop names three surviving deliveries
     and requires each to pay for itself. **The cost meter suppresses nothing and
     writes no telemetry row, so it has no `R_d` and structurally cannot have
     one.** B12 holding therefore cannot close G-stop, and that consequence is
     fixed here, in advance, rather than argued when it arrives.
  2. **NOT that the task set is representative.** The manifest is **authored**.
     B20's set was every session at a commit — a rule with no discretion — and
     that defence does not transfer. B3 measured the two verification modes
     **400x apart**, so the author's choice of tasks is the largest single lever
     on `R`.
  3. **NOT that total cost fell rather than moved.** Local compute is outside the
     denominator by construction.
  4. **NOT anything about correctness.** B4 is open and unmeasured. Acceptance
     rates per arm are published beside every ratio precisely so a cost reduction
     bought by doing less is visible as one.
- **The operator cannot be blinded, and no clause makes that residual zero.** The
  treatment IS the presence of the tools in the operator's own tool list. Seven
  channels are enumerated and bounded in the frozen design; what remains is
  declared, not repaired.
- **If it falls:** the project stops. Only the pieces that individually paid for
  themselves survive — and per item 1 above, the cost meter cannot be shown to
  have done so by this instrument.
- **PHASE 3 READING RULE — PRE-REGISTERED 2026-08-06, BEFORE THE MAC RUN AND
  BEFORE ANY UNIT WAS ATTEMPTED.** The frozen run plan routes this project's own
  mechanical work through `repair` for exposure, and attaches a consequence with
  no number to it: *"if `R_repair` proves unreachable in phase 3, B12 is
  measuring `gate` alone and the premise text should say so before phase 4 rather
  than after phase 6."* This supplies the number. **The timing is the whole of
  its legitimacy**, the same claim the two G-stop amendments of this date rest
  on: no unit has been attempted, and the scorer those units implement does not
  exist, so the answer is strictly unknowable as this is written.
  - **The exposure:** the three arithmetic-core units of the B12 scorer
    (`terms`, `strata`, `aggregate`) — real failing-assertion gates on this
    repository's own remaining work, not fixtures authored for the experiment.
    Each is handed to `repair` at its frozen `max_rounds`.
  - **A unit COUNTS AS CLOSED only if `repair` returns `passed: true` AND the
    harness's own `vitest` run of that unit's tests exits 0.** The tool's word is
    not the measurement; this project has already recorded one call reporting
    success on an already-green tree.
  - **≥ 2 of 3 closed:** `R_repair` is reachable. B12 keeps both deliveries and
    its text does not move.
  - **0 of 3 closed:** `R_repair` is unreachable in this venue. **B12's text is
    amended BEFORE Phase 4 to say it measures `gate` alone**, and `repair` is
    recorded `unexercised` rather than fallen — `holdsIf` already forbids
    `R_repair` from gating B12's status, so this changes what is CLAIMED, not
    what is required.
  - **Exactly 1 of 3: INCONCLUSIVE**, named now so it cannot be read either way
    later. The manifest may not be sealed on it; more exposure comes first.
  - **What it does NOT decide:** nothing about `R_gate`, nothing about the
    bracket, nothing about whether B12 holds or falls. Three units, one
    repository, one local model is **exposure, not a rate** — the caveat B6
    carries, for the same reason.
- **ATTEMPT 1 IS VOID, and the cause is named: the criterion was unsatisfiable
  by construction.** `run 2026-08-06-mac-b12-phase3-efe5806` returned 0 of 3, and
  that number measures the harness rather than `repair`. Nothing above this line
  is edited; the rule stands and is re-registered below with the same thresholds.
  - **The defect.** All three units shared ONE oracle, `tests/b12-scorer.test.ts`,
    and `repair` closes when the PROJECT's gate goes green — the whole suite. So
    a unit could only return `passed: true` once every OTHER unit was implemented
    too, and `repair` rolls back when it does not close, so each unit began from
    all-stubs. No unit could be first. **The rule's own words say "the harness's
    own `vitest` run of THAT UNIT'S tests"; the harness handed it everyone's.**
    The rule was right and the implementation did not match it.
  - **It is void rather than a fall because the argument is structural and
    predates the result.** A shared oracle plus rollback makes `passed: true`
    unreachable for units 1 and 2 whatever the model produced. That was derivable
    before the run, by me, and was not derived.
  - **WHAT IT DID MEASURE, and it is not nothing.** `repair` was called six times
    and every call produced well-formed output.
    - **`strata.ts` was implemented CORRECTLY in round 1** — 13 failures to 11,
      exactly the two `subagentShare` tests — then held byte-identical across
      rounds 2 and 3 (959 completion tokens each). Not a model failing to
      improve: a model finished with its file, being told the gate is still red
      for reasons outside it.
    - **No round after the first ever improved anything**, across four calls.
      This reproduces B6's earlier finding on different work.
    - **The model stops emitting `<file>` blocks on the corrective retry** —
      `envelope: "no_blocks"` in 3 of 6 calls at a 32,768 window, with
      `finish_reason: "stop"`. Not truncation. Unexplained, and it is the
      likeliest single cause of a unit not closing.
    - Cost **US$ 0.88** against a US$ 40 ceiling; net suppression **+599,359
      bytes** over six calls, 3 positive and 3 negative.
  - **A second defect, recorded because it cost information:** `repair` returns
    its best attempt as an unapplied diff and the harness did not keep it, so
    whether the two `13 -> 1` calls were near misses or nonsense is unknown. The
    re-run captures it.
- **PHASE 3 READING RULE, ATTEMPT 2 — RE-REGISTERED 2026-08-06, after attempt 1
  was voided and BEFORE the corrected harness ran.** Thresholds unchanged and
  deliberately so: what failed was satisfiability, not the numbers, and moving a
  number after a run is the move this file exists to forbid.
  - **One oracle per unit** — `tests/b12-{strata,terms,aggregate}.test.ts` — and
    the harness holds the other two outside `tests/` for the duration of a unit's
    `repair` call, so the gate that unit must close contains only its own tests.
  - **Units run in dependency order: `strata`, then `terms`, then `aggregate`.**
    `terms` calls `subagentShare` and `aggregate` calls `partitionByStrata`, so a
    unit is attempted against real dependencies rather than stubs. **A unit whose
    dependency did not close is `blocked`, not `failed`**, and counts toward
    neither side.
  - **≥ 2 of 3 closed** — reachable. **0 of 3** — B12's text says it measures
    `gate` alone, amended before Phase 4. **Exactly 1 of 3** — inconclusive, and
    the manifest may not be sealed on it. A unit is CLOSED only when `repair`
    returns `passed: true` AND the harness's own `vitest` run **of that unit's
    file** exits 0.
  - **This is attempt 2 of the Phase-3 exposure, not of B12.** B12's own
    two-attempt cap is untouched; it has not run.
- **ATTEMPT 2 RESULT: 1 of 3 — INCONCLUSIVE**, which is the branch the rule named
  in advance and the one it forbids reading either way.
  `run 2026-08-06-mac-b12-phase3-d746d07`, US$ 0.74 of a US$ 40 ceiling. The one
  closed unit is `strata`, **inherited** from the attempt the machine killed and
  skipped rather than re-attempted; **this run closed nothing**
  (`unitsClosedThisRun: 0`). Per the rule, the manifest may not be sealed on it.
  - **`repair` never once produced a state better than the untouched stub**, and
    that is the finding rather than a missing artifact. Failure counts across the
    four calls: `terms` 4→9→9 and 4→7→7→7; `aggregate` 10→28→28 and 10→25→23→23.
    `best` initialises to the ORIGINAL bytes at the starting failure count and
    only advances on `after < best.failures`, so nothing ever displaced it, the
    unapplied proposal WAS the stub, and `renderDiff` correctly returned `""`.
  - **This corrects what attempt 1 recorded as a second defect.** That entry says
    `repair` returns its best attempt as a diff and the harness did not keep it,
    and that "the re-run captures it". The re-run did keep it. There was nothing
    to keep. Attempt 1's own `13 → 1` calls did improve, so the loss was real
    THERE; here the empty field is the measurement.
  - **Round 1 made things worse in 4 of 4 calls**, and across the seven rounds
    after a round 1 exactly one improved anything (25 → 23). Third independent
    reproduction of B6's finding, now on this project's own remaining work.
  - **It also replicates `run 2026-08-04-mac-09`** — `repair` net negative on
    12 of 12 calls against a TypeScript gate — at 4 of 4, on a different corpus.
    Two independent samples now say the same thing about the same condition.
  - **The mechanism is visible in the token counts.** Completions held at
    1895/1898/1898 and 3331/3385/3385 across rounds whose prompts grew by the
    prepended failures. The model is not correcting; it is re-emitting. And
    `envelope: "no_blocks"` in **6 of 13 attempts**, every one with
    `finish_reason: "stop"` — attempt 1 saw 3 of 6, and it remains what it was
    called before any data existed: the likeliest single cause, unexplained.
  - **The context window was never the constraint, and this is worth recording
    because a day was spent on it.** Largest prompt of the run 14,231 tokens
    against 32,768, every attempt `stop`, window read 32,768 before AND after.
  - **CHECKED AND REJECTED: the harness did not hand it an impossible task this
    time.** The model compared against `"void(ambiguous)"` and friends while
    `RowDisposition` (`src/cost/report.ts`) is `"credited" | "ambiguous" |
    "unverifiable" | "excludedForeign" | "unmatched"`. Those four names are
    exactly `RefusalLedger`'s fields in `types.ts`, which it HAD, and `UNIT-2.md`
    gives `disposition === "credited"` correctly and names every row field used.
    It took the `void(...)` shape from `Disposition` — the other disposition type
    in the same file — and merged the two. Model error, not construction. The
    `../b12.js` it tried to import appears in no spec. **Attempt 2 is a result,
    not a void.**
- **PHASE-3 EXPOSURE B — PRE-REGISTERED 2026-08-06, AFTER exposure A returned
  1 of 3 and BEFORE any unit was attempted under the new condition.** A separate
  exposure, **not attempt 3 of the same one**, and the distinction is the whole
  of its legitimacy: attempt 2 was re-registered with conditions unchanged
  because what had failed was satisfiability; this changes what the tool is given
  and therefore cannot be presented as a re-draw of the same question.
  - **THE TIMING, STATED AGAINST MYSELF.** `src/cost/report.ts` was never in
    `context_files` although both units call five functions from it and consume
    `CreditedRow`, and the specs compensated by naming its fields in prose —
    work the type system should have done. The argument stands on its own. **I
    did not make it before the run and noticed it only by reading the failure**,
    which is why it may not be applied as a correction to exposure A. Exposure
    A's numbers stay exactly as recorded above.
  - **What changes — two things, both forced, and named together because one
    causes the other.** `context_files` gains `src/cost/report.ts`; and the
    window moves 32,768 → **65,536**, because that file is 51,747 B ≈ 14,800
    tokens and adding it puts `aggregate`'s corrective retry at ~29,000 against
    a ~29,491 usable budget — inside the margin where `context_would_overflow`
    is reported as `model_failed` and the count cannot tell them apart. That is
    the hazard the 32,768 floor already exists for, met from the other side.
  - **What does not change:** local model, quantisation, temperature, the three
    specs, the three oracles, `max_rounds: 3`, one unit per claude session, one
    oracle per unit, dependency order, and the two-call retry protocol.
  - **ALL THREE UNITS RESET TO STUBS.** Not inherited. `strata` closed under the
    old condition, and carrying it forward would let ONE closure out of two
    attempts reach the "≥ 2 of 3" bar — silently loosening a threshold the
    thresholds section refuses to move. Three units, one condition, denominator
    three. It also buys a free replication of the only unit that has ever
    closed, and a `strata` that STOPS closing with more context in front of it
    would be the most informative single result this exposure can produce.
  - **Thresholds verbatim from exposure A. ≥ 2 of 3** closed — `R_repair` is
    reachable. **0 of 3** — B12's text says it measures `gate` alone, amended
    before Phase 4. **Exactly 1 of 3** — inconclusive, manifest not sealed.
    CLOSED still means `repair` returns `passed: true` AND the harness's own
    `vitest` run of that unit's file exits 0.
  - **VOID if `report.ts` was not actually in the context** — checked against
    the telemetry's own `detail.files`/`context_files`, not against this text.
    A condition that only the registration believes in is the misdeclared window
    of `mac-19` wearing a different hat.
  - **VOID if fewer than three units are attempted under the new condition**
    (crash, budget ceiling, a dependency left `blocked`). Incomplete is not a
    reading, and this machine has already ended two runs by kernel panic.
  - **What a hold does NOT establish, and it is a real weakness: two conditions
    moved, so a better result cannot attribute.** "The right types helped" and
    "more context helped" are not separable here, and separating them is B13's
    job — downstream of B6, not a planned component, and explicitly requiring a
    same-byte-budget control this exposure does not run. The Phase-3 question is
    **reachability**, not mechanism: B12 will run under whatever configuration
    works, so a result that cannot say WHY still answers what was asked. Stated
    now so nobody reads it as more.
  - **Free in B12's own currency, which is why it is allowed at all.**
    `context_files` takes PATHS; the 51,747 B are read by the local model and
    never enter Claude's context. Adding them costs the metric nothing.
  - **PREDICTION, registered so it can be wrong: 1 of 3 again.** `strata` closes
    (it closed in round 1 before); `terms` and `aggregate` more likely than not
    do not. The literal-guessing was a concrete and identified cause of some of
    exposure A's new failures, but nothing about adding a file addresses round 1
    making things worse in 4 of 4 calls, no round after the first improving
    anything, `no_blocks` at 6 of 13, or mac-09's 12 of 12. **If this is right
    the exposure resolves nothing and costs about a dollar** — it is run anyway
    because exposure A carries a known defect in its setup and a clean
    INCONCLUSIVE is worth more than a flawed one. If it comes back 2 or 3 of 3,
    that beat a stated expectation.
- **EXPOSURE B RESULT: INCOMPLETE, and VOID on its own pre-registered condition.
  NOT the "1 of 3 — INCONCLUSIVE" its own artifact printed.**
  `run 2026-08-06-mac-b12-phase3-f2932ff`, US$ 0.82 of 40, window 65,536 read
  before and after, `report.ts` in `context_files`, all three units reset first.
  - **`aggregate` never generated a token.** Both `repair` calls died in the LM
    Studio backend — HTTP 400, MLX scheduler exception — before any output.
    Telemetry, which does not depend on anyone's narration: `files` empty,
    **zero attempts recorded**, `10 → 10`, `model_ms` 256,479 then **391**. The
    second call's 391 ms says the backend was already dead and did not recover.
  - **B15's own rule decides it:** "a round that never got a response carries no
    attempts at all, which is different from zero." `aggregate` has NO
    observation, so fewer than three units were attempted, which exposure B
    pre-registered as VOID with "crash" named among the causes. **The counter-
    argument, stated so it can be taken:** `repair` WAS invoked twice, so one may
    read "attempted" as "invoked". This project has already decided that reading
    for rounds; applying it to units is the consistent move, not a new one.
  - **THE HARNESS PRINTED A READING IT HAD NO RIGHT TO**, and this is the
    defect rather than the crash. `UNIT_STATE` comes from `VITEST_RC` alone, so
    a unit whose model never ran is recorded `red` — indistinguishable from a
    unit that ran and failed. Three records then existed, so the merge logic
    emitted INCONCLUSIVE off a denominator of three. **A run that measured two
    units reported on three.**
  - **WHAT IT DID MEASURE, and it is the most informative run this premise has
    had.** Against exposure A on the identical units:

    | | A (no `report.ts`, 32,768) | B (with, 65,536) |
    |---|---|---|
    | `strata` | inherited | **closed in round 1**, 5 → 0 |
    | `terms` call 1 | 4 → **9** | 4 → **1** |
    | `terms` call 2 | 4 → 7 → 7 → 7 | 4 → 3 → **2** |
    | `tsc` on the best attempt | failing | **passing** |
    | `envelope: no_blocks` | 6 of 13 attempts | **0** |

    On its best attempt `repair` wrote **121 lines**, left `tsc` green, and
    failed **one test of four**. Round 1 stopped making things worse — the
    behaviour reproduced three times before this and now reversed under one
    changed condition.
  - **THE REGISTERED PREDICTION WAS RIGHT ON THE COUNT AND WRONG ON THE
    MECHANISM.** It said 1 of 3 and said nothing about adding a file would
    address round 1 worsening, later rounds not improving, or `no_blocks`. The
    count matched; every mechanism named moved. Recorded because a prediction
    that is only scored on its headline is not a prediction.
  - **THE SPEC IS IMPLICATED, TWICE, AND THIS TIME IT IS NOT DERIVABLE-BUT-
    MISSED.** `UNIT-2.md` names `multipliersFor` (step 7) and `rateKey`
    (step 13) **without their module**, in a document whose preamble says
    "`positionalMultiplier(t, T, m, ttl)` **from `../report.js`**". Both live in
    `src/cost/rates.ts`; `report.ts` imports them (`report.ts:1`) and does not
    re-export. Call 2 imported `multipliersFor` from `../report.js`, took
    `TS2459`, and round 3 timed out. Call 1 dodged it — `rates.multipliers`
    directly, and `rateKey` **reimplemented inline** rather than imported.
  - **WHICH TEST FAILED IS UNKNOWABLE, and that is a third harness gap.**
    `repair` returns `remaining_failures`; the prompt asks the session for the
    `diff` and not for that. The one-failure state lived only inside the loop,
    and both `terms` vitest captures are byte-identical at 4,354 B because the
    tree was rolled back. Same information-loss class as attempt 1's diff, at
    the single most informative moment this premise has produced. The obvious
    candidate — the inlined `rateKey` — stays a hypothesis: the fixture uses
    only default multipliers, so the rate-key blindness alone would not fail it.
- **PHASE-3 EXPOSURE B — COMPLETION, pre-registered before the run.**
  Registered at commit `ea35254`, after the harness changes below and before a
  single token of it was generated.
  - **What runs:** `B12_ONLY=aggregate`, `B12_CARRIED_FROM=` the exposure B run,
    against `aggregate.ts` reset to its stub at `d0253e1`. Same window (65,536),
    same `context_files`, same local model, same specs and oracles.
  - **WHY THIS IS A CONTINUATION AND NOT A NEW DRAW.** `aggregate` has no
    observation at all — B15 already rules that a round with no response is not
    one, and exposure B's own VOID clause names "crash" among its causes. The
    conditions are unchanged, so nothing about the exposure moves.
  - **`terms` IS NOT RE-ATTEMPTED, AND THIS IS THE POINT OF THE FLAG.** It got a
    fair draw and came within one failing test; so did `strata`, which closed.
    Re-running all three to "finish" the exposure would hand those two a SECOND
    draw at the same bar, and three draws for two units is a higher chance of
    reaching `>= 2 of 3` with nothing about `repair` having changed. The harness
    now refuses to let a run inherit them silently and refuses to combine two
    runs arithmetically: the completion's artifact reads `partial` and renders no
    verdict. **The reading is written here, by hand, with both artifacts as
    evidence** — as every reading in this file has been.
  - **REGISTERED PREDICTION.** `aggregate` closes: **no.** It is the largest unit
    (four exported functions against `terms`' three and `strata`' two), it was
    the unit exposure A drove furthest backwards (10 → 28, 10 → 25 → 23), and
    nothing in the two harness fixes changes what the model is handed. The one
    thing that has changed in its favour is second-hand: `strata` and `terms`
    both improved sharply once `report.ts` joined `context_files`, and
    `aggregate` has never once been attempted under that condition — both of its
    calls died before generating. **So the honest prediction is that this is the
    first real observation of `aggregate`, not that it is a bad one.** If it
    closes, the exposure reads 2 of 3 and `R_repair` is reachable.
  - **THE CAVEAT THAT HAS TO EXIST BEFORE THE RESULT DOES.** Whatever `repair`
    writes into `aggregate.ts` closes an oracle that does **not** exercise the
    two guards finding F2 names: the fixture passes `minClosures: 0`, never
    imports `recompute`, and never asserts on `recomputations`. **A closure
    answers reachability and says nothing about the scorer being correct.** That
    body does not reach `main` as the B12 scorer until F1 and F2 are fixed and
    tests exist over the seams that currently pass green and empty. Written down
    now because it is much easier to say before a green run than after one.
  - **VOID conditions, evaluated by the harness rather than declared.** The
    completion is VOID if `detail.model` on any repair row is not the declared
    local model; if `detail.context_files` does not contain all three declared
    paths, **or is absent**, which is unverifiable and therefore not a pass; or
    if `aggregate` again produces no observation, which is `no_response` and
    counts toward neither side. Exposure B registered the middle one and had no
    way to check it: `detail.context_files` did not exist. It does now
    (`ee7defb`), and the check is `f6926b4`.
- **EXPOSURE B COMPLETION RESULT: `aggregate` is RED. Exposure B therefore reads
  1 of 3 — INCONCLUSIVE**, which is the pre-registered branch for exactly one:
  the manifest may not be sealed on it. `run 2026-08-07-mac-b12-phase3-c40e9f4`,
  US$ 0.42 of 40, one unit attempted, artifact reads `partial` and renders no
  verdict. This reading is written by hand from both artifacts, as registered.
  - **It is a REAL observation, and the first `aggregate` has ever had.** Two
    `repair` calls, **4 generation attempts**, every envelope `complete`, no
    backend failure. `voids: []` — `detail.model` matched on every row, and
    `contextFilesObserved` carried all three declared paths. **Exposure B's
    central condition was observed rather than declared, for the first time.**
  - **It never beat the stub.** Round 1 went 10 → **20** and 10 → **18**; round 2
    changed nothing in either call. `files: []` and the diff is empty **because
    `best` starts at the ORIGINAL bytes and nothing displaced it** — the same
    correction attempt 1 needed. The session's own narration got this wrong
    ("discarded along with the rollback"); the empty diff IS the measurement.
  - **THE RE-EMISSION SIGNATURE, now four for four.** Round 2's completion is
    the SAME LENGTH as round 1's in both calls — 3306/3306 and 3419/3419 — with
    the same failure count, against a prompt **2,300 tokens larger** carrying the
    failures. Exposure A showed 1899→1907→1907, 1895→1898→1898, 3385→3385. After
    round 1 this model re-emits; it does not correct.
  - **`report.ts` HELPED `aggregate` TOO, and it was not enough.** Damage roughly
    halved against exposure A on the identical unit: 10 → 28 and 10 → 25 became
    10 → 20 and 10 → 18. Same direction as `strata` (closed) and `terms` (4 → 1).
  - **A LIMITATION IN THE REGISTERED CONDITION, found by the new per-round
    telemetry.** The prompt says `max_rounds: 3`; **both calls stopped on
    `budget` with round 3 timing out**, so `aggregate` got TWO productive rounds.
    Cause, measured rather than guessed: its rounds cost **106–132 s** because it
    writes ~3,400 completion tokens, **twice `terms`' ~1,700** — and `repair`'s
    default `budget_seconds` is 300. **NOT the window.** `aggregate`'s prompt
    (20–23 k) is within 4% of `terms`' (19–20 k), and its rounds cost 128–132 s
    at 32,768 as well. The file's size is the cause, at any window.
  - **WHETHER THE THIRD ROUND WOULD HAVE MATTERED IS A HYPOTHESIS, LABELLED.**
    Two independent pieces of evidence say no — round 2 re-emitted round 1 here,
    and exposure A's call 2 DID reach round 3 and produced 23 → 23 — but neither
    is the measurement, and the condition as registered was not delivered.
    **`budget_seconds` is an unregistered free parameter** that silently truncates
    the registered `max_rounds` on any unit whose output is large enough. It must
    be fixed and recorded before the next exposure, not defaulted.
  - **PREDICTION SCORED.** Registered: "`aggregate` closes: **no**", with the
    hedge that this would be its first real observation and not necessarily a bad
    one. Both halves resolved: real, and bad.
- **FOUR CONDITION CHANGES REGISTERED AFTER EXPOSURE B AND BEFORE ANY LATER
  RUN.** All are instrument repairs — they fix specs that were wrong and a limit
  that was never registered — but all change what the model is handed, so **no
  run under them is comparable with exposure A or B** and any later exposure is a
  new one with its own registration.
  - **The two limits are now set as a pair and VERIFIED.** `budget_seconds: 600`
    and `LOCAL_CODER_TIMEOUT_MS: 180000`, where before the budget was never
    passed and defaulted to 300 s. Raising the budget alone would have traded a
    truncation for a starvation: the per-request timeout is
    `min(config.timeoutMs, remaining)`, and at 600/600 one slow round can be
    issued with the whole budget. 180 s clears the longest LEGITIMATE round ever
    observed (132 s, exposure A) by 36% while no single request can take more
    than 30% of the budget. The 149 s and 256 s rounds on record were **not**
    generations — one was a request handed the remaining budget as its timeout,
    the other the backend returning HTTP 400.
    **They travel through a prompt and both have defaults, so they are now
    recorded in `detail.budget_seconds` / `detail.max_rounds` and checked per
    repair row; absent is `unknown` and a VOID, never a pass.** Without that, a
    session dropping one argument would be measured at 300 s with nothing saying
    so — the same defect as exposure B's unverifiable context condition.
  - **`UNIT-2.md` now names every import.** It named six cross-module functions
    and gave the module for exactly one, and that one said `../report.js` — right
    for three of the six and wrong for `multipliersFor` and `rateKey`, which live
    in `../rates.js` and are imported-not-re-exported by `report.ts`. Exposure B
    produced both failure modes from this in one run: a `TS2459` in one call and
    an inline reimplementation in the other. **This is a spec that was wrong, not
    a spec that was hard**, which is why it is repaired rather than left frozen.
  - **THE SCORER-CORRECTNESS PASS (F1, F2a, F2b, F3, F8), and it changes the
    TASK, not only the conditions.** Four defects that every oracle passed green
    on, all fixed together with their specs and their oracles; the mechanisms are
    in `docs/b12-scorer/FINDINGS.md`. Two are worth naming here because they
    decide how a later exposure may be read.
    - **UNIT-3 is materially harder now** — a second refusal ledger to sum, a
      per-horizon row jackknife, an observation-level closure floor, a fifth
      partition bucket, and a verdict that refuses to fall on an unevaluable
      stratum. **UNIT-2 changed shape rather than difficulty**: two arithmetic
      steps became field reads and one cross-module import went away, while a
      second ledger and two closure counters arrived. **UNIT-1 gained one
      bucket.** So an exposure C would measure a DIFFERENT TASK from A and B, on
      top of already being incomparable on conditions — and `aggregate`, the unit
      that has never closed, is the one that grew.
    - **A closure under these specs answers reachability and still says nothing
      about the scorer being correct.** F9–F14 are open, and two of them are
      structural: `R_other` has no source data at all (five of the seven tools
      write no telemetry), and `Σ_d R_d + R_other = R` — asserted by the frozen
      design and computed by the artifact — is **false** by `O/(A+S)` on every
      run with a non-zero installation term. Neither is fixable by an
      implementer; both need the design to say something it does not say.
    - **`tests/**` joined `tsconfig.json` in the same pass.** No test file in
      this repository had ever been type-checked — vitest transpiles without
      checking — so every fixture, oracle and helper was unchecked TypeScript,
      and four comments in `src/` recorded the hole as a reason to put things
      elsewhere rather than as something to close. Cost, measured before the
      change: 14 errors in 3 files, none a real mismatch and none in the b12
      oracles. **This is a change to `gate`,** the instrument every reading in
      this section is taken with: from here on a green gate means more than it
      did, and no earlier run's gate reading may be compared with a later one on
      the strength of the number alone. `scripts/**` is still unchecked.
    - **Nine of the new assertions were not controls when this was written, and
      all nine have since been proved** (2026-08-07, the day the bodies landed;
      the defect table is in `FINDINGS.md`). They tested stubs, so they failed on
      `not implemented` whether they were right or wrong. Registered because
      "the oracle agreed" is
      exactly the claim a green run would invite, and these oracles have not been
      watched fail — **three of the first seven were defective when written**,
      each passing on the very defect it was aimed at, and were caught only by
      re-deriving the fixtures against the specs and by an adversarial review of
      the diff.
    - **`STUBS_FROZEN_AT` moved to `3d27f08`**, which is where the repaired stubs
      live. A consequence rather than a choice: `strata` has a body at that
      commit, so the harness now refuses any run that attempts it — enforcing the
      rule this section already carries, that a unit with an observation may not
      be drawn again.
  - **THE HOLD ARITHMETIC NOW RUNS OVER A DIFFERENT SET FROM THE PUBLISHED
    BRACKET (F19), and this is the change most likely to be misread later.**
    `admissionRule` 6 admits an `ambiguous > 0` observation "to the FALL
    arithmetic only, at both bounds" and excludes it from the hold; the scorer put
    it in both. `B12Result` now carries a second family of figures under `hold`,
    and **a run's `rLo` and its hold's `rLo` are two numbers, not one.** Anyone
    quoting "R_lo" off a future artifact has to say which.
    - **THE SAFETY CLAIM THAT LICENSED SHIPPING THE HOLD BRANCH FIRST WAS FALSE.**
      `FINDINGS.md` recorded that including such an observation "drags `R_lo` DOWN,
      making a hold harder", so fixing it later was safe. Removing an observation
      from a ratio of sums raises the pool **iff** its own `(s−o)/(a+s)` is below
      the pool, which a refused magnitude says nothing about. The hold branch
      therefore shipped on 2026-08-07 under a direction that had never been
      established. It is registered here rather than quietly corrected in the
      findings file, because the same reasoning error — *deflated relative to
      itself* read as *below the pool* — is what F1 and F9 were each corrected for.
    - **What does bound the direction is the dilution guard.** `hold.rAll`
      reinstates every clause-6 exclusion at `saved_o = 0` with its billing, so for
      a **strictly positive** excluded saving it is strictly below the published
      `R_lo`, and a hold now requires the full admitted set to clear 30% under
      dilution as well. At exactly zero the two are equal; this said "non-negative"
      and was wrong at that one point, which is the same overstatement-by-one-word
      the safety claim above died of.
    - **Two of my three readings were refuted by adjudication** — that a short
      hold set makes a hold impossible, and that "admitted" in `voidConditions` 16
      covers a clause-6 observation (I had quoted the clause with "to the FALL
      arithmetic only" dropped). And **one conservative guard I proposed was
      refused as post-freeze threshold-minting**: requiring 5 hold-eligible
      observations per stratum cell. It would only ever turn a hold into `open`,
      and it is still a number the frozen design does not contain. Recorded as
      F21 instead.
    - **UNIT-3 is harder again**: a second family of figures, two functions taking
      a population PAIR where neither member may default to the other, and a
      verdict step that must not see the published domain. Any exposure C was
      already measuring a different task; it is now measuring a different task
      again.
- **PHASE 3 IS CLOSED AT 1 OF 3, DELIBERATELY, WITHOUT A THIRD EXPOSURE.**
  Decided 2026-08-07 with an adversarial second opinion that was asked to attack
  the decision and agreed with it.
  - **Why not exposure C.** It would not be the third comparable draw: the specs
    changed under the scorer-correctness pass and UNIT-3 — `aggregate`, the unit
    that never closed — grew materially. Publishing "1 of 3" three times would
    look like accumulating evidence while being three different experiments. And
    the likely outcome is another 1 of 3: `strata` showed small-unit closure,
    `terms` came within one failing test, `aggregate` regressed even before it
    grew. Even ≥ 2 of 3 would license only "reachable", and `R_repair` never
    gates B12's own status.
  - **THE COST, STATED RATHER THAN GLOSSED.** The registered reading rule says
    exactly 1 of 3 requires more exposure. Stopping leaves that formal question
    **unresolved**, and it is recorded as unresolved — not as answered.
  - **What Phase 3 did produce, which is the thing worth keeping:** `repair`
    closes small, prescriptively-specified units in one round; comes close on
    medium ones; and drives large ones BACKWARDS, re-emitting its previous answer
    at the same length against a larger prompt. Four re-emissions out of four.
  - **Consequence:** `terms.ts` and `aggregate.ts` stop being measured work and
    are implemented by the orchestrator. `repair` gets no further draw at them.
- **F11 AND F13 ARE IMPLEMENTED TO THE INSTRUCTION, NOT AMENDED AWAY, AND THE
  READINGS ARE DECLARED HERE BEFORE THE RUN.**
  - `R_other` will read **`unexercised`** on every run this venue can produce.
    Not a measurement: the five tools it is defined over — `fix`, `implement`,
    `models`, `scaffold`, `status` — write no telemetry row at all, so the bucket
    has no source data. `unexercised` is the design's own state for this and is
    neither a hold nor a fall.
  - `identityHolds` will read **`false`** on any run whose installation term is
    non-zero, which `holdsIf` 6 requires for every observation. `Σ_d R_d` is
    `S/(A+S)` and `R` is `(S−O)/(A+S)`; they differ by `O/(A+S)`.
  - **The design is NOT amended, and the distinction is the whole point.** B20's
    rule lets the INSTRUMENT's implementation be repaired until the first scored
    observation. Reallocating `O` or minting an `R_installation` would change the
    ESTIMAND, which is not repair however early it happens. `B12Result` carries
    `identityHolds` as a boolean precisely because the design's author allowed it
    to be false; forcing it true would delete the evidence. **If a coherent
    per-delivery decomposition is wanted, it needs a newly pre-registered
    premise, not a repair to this one.**
  - Declared in advance so neither field is later mistaken for a measurement.
    This is disclosure, not a threshold change: nothing about what would count as
    a hold or a fall moves.
- **F12 AND F9 ARE FIXED, AND `R_hi⁺` NOW HAS FIVE WAYS TO REFUSE THAT THE FROZEN
  PREFLIGHT DOES NOT SCREEN FOR.** Registered 2026-08-07, after two rounds of
  adversarial adjudication, before any later run.
  - **What was wrong.** `scopeTelemetry` admits a telemetry row on a ±60,000 ms
    window as well as on an exact id match, so one physical row sat in two
    observations' slices and `R_hi⁺` summed it twice — and `wouldHaveAdded` is
    signed, so a duplicated NEGATIVE magnitude pushed the fall-side figure DOWN,
    toward a fall the data does not support (F12). Separately, a CREDITED row no
    window owns was in no `S_o` and in none of the four refusal classes, so it was
    summed zero times and no void condition saw it (F9).
  - **What changed.** A fourth unit, `src/cost/b12/coverage.ts`, keyed on
    (artifact, ordinal) because nothing on a telemetry row survives a null
    `invocation_id`. It takes the run's WHOLE row set — not the union of the
    slices, since a row outside every window is invisible to the observations —
    and resolves each row once. `rHiPlus` reads it. **The old step 1b is retired
    with the sum it guarded**, having been declared incomplete on the day it
    landed.
  - **THE COST, and it is the one I tried to argue away and could not.** The
    frozen `preflight` artifact asserts `provenanceUnavailable === false`,
    `ambiguous === 0`, `unmatched === 0`, `excludedForeign === 0` and
    `savedFraction !== null`. It asserts NOTHING about `unverifiable`, about
    unique window ownership, about credited rows no window owns, about slices
    disagreeing, or about full slice coverage. **So a run can pass its preflight
    and still return `open` at scoring time on a condition the preflight never
    looked at.** That is the safe direction — `open`, never a wrong fall — but it
    is a cost, and the preflight is frozen and is not amended. `FINDINGS.md` F17.
  - **A second thing I had backwards, corrected here rather than quietly.**
    "Omission deflates the hold, which is the safe direction" is FALSE:
    magnitudes are signed, so an omitted NEGATIVE credited row raises `R_lo` and
    `R_hi`, toward a hold. When this was written the verdict function had no hold
    branch, so the requirement was recorded in `UNIT-3.md` and in `aggregate.ts`
    for whoever wrote one. **The hold branch exists now** — `decide` returns
    `holding (unvalidated)` on `decideHold`'s conjunction — and the guard this
    asked for turned out to be SUBSUMED rather than owed: `rHiPlus` refuses on an
    unowned credited row, so the run returns `open` before `decideHold` is ever
    reached and a conjunct there could never decide anything. Planting the defect
    proved it — deleting the conjunct changed no test. The corrected direction
    claim above stands unchanged.
  - **This is instrument repair, not an amendment**, on the same reading that
    decided F11 and F13: the ratio, the horizons, the four classes and the
    thresholds are untouched. What moved is which multiset the sum runs over, and
    it moved toward the one `design.metric` already describes.
  - **UNIT-3 grew again** — a run-level argument and five refusal conditions —
    and there is now a UNIT 4 that never existed during any exposure. An exposure
    C would measure a task further still from A's and B's.
- **THE VERDICT NOW HAS SIX STATES AND IT HAD TWO (F14), AND TWO CLAUSES OF THE
  FROZEN TEXT CONTRADICT THEMSELVES.** Registered 2026-08-07 after two rounds of
  adjudication, before any later run.
  - **The scorer could return `fallen` or `open` and nothing else.** It checked no
    observation count, no rate basis, no selection guard, no recomputation and no
    prior-run register — six VOID clauses it had the data for. A three-observation
    run could have returned `fallen`. It also collapsed `holding (unvalidated)`
    into `open`, and `holdsIf` 7 names that state for exactly the never-run A/B
    this project has.
  - **`voidConditions` 15 says both "VOID" and "the run returns `open`" in one
    sentence**, while `fallsIf` says `open — provisional`. Three formulations of
    one fact. `design.metric` settles it in words — "the run returns `open`" — and
    that reading is registered here. **`voidConditions` 3 does the same to an
    undersized stratum**, and `admissionRule` 8 settles it outright: "never a
    hold, a fall, or a void." Both readings are pre-declared so neither is later
    mistaken for a judgement made after seeing a number.
  - **`holding (unvalidated)` is now reachable and the bare `holding` is not.**
    The design says the unvalidated state "may not be cited as an input to opening
    or closing any gate", so nothing downstream may move on it. Publishing it is
    disclosure, not a threshold change.
  - **F19 is open and NOT fixed**, found in the same adjudication:
    `admissionRule` 6 excludes an observation with `ambiguous > 0` from the HOLD
    arithmetic and the scorer includes it. The direction is conservative — such an
    observation carries its full `A_o` against a deflated `S_o`, so it drags
    `R_lo` DOWN — which is why the hold branch ships ahead of the fix rather than
    waiting for it. Recorded before any run so a later hold is read knowing it.
    - **SUPERSEDED 2026-08-07 — F19 is fixed.** The bullet above stands as the
      record of what shipped and why, including the safety claim that licensed
      shipping it; `docs/b12-scorer/FINDINGS.md` files F19 under CLOSED. The
      scorer now partitions the admitted set on `ambiguousCount(t) === 0` and
      pools the hold's `rLo` over the eligible subset, publishing the excluded
      count beside it. **The eligible subset is the ARITHMETIC population, not
      the whole story:** `strata` and the hold's per-delivery figure take a
      population PAIR — the frozen floors (stratum evaluability, `unexercised`)
      still count the FULL admitted set and only the ratio is pooled over the
      eligible subset, so a cell can be evaluable on five and priced on fewer
      (`FINDINGS.md` F21) — and `recomputations` reinstates the hold-excluded
      observations rather than dropping them.
- **THE INSTALLATION TERM'S INPUT: ONE `O_o`, OPERATIONALIZED HERE, BEFORE THE
  PROBE THAT MEASURES IT.** Registered 2026-08-08. `DECISIONS.md` item (c) is
  decided by the owner: supplying `installedChars` is INSTRUMENT REPAIR under
  `voidConditions` 5 and `runPlan` PHASE 0 (repairs 9 and 10 are among the ten
  owed, and no scored observation exists — no `*.b12.tasks.json`, no
  `*.b12.result.json`). The boundary that binds the repair, held through two
  independent adjudications: **ONE `O_o`, the same value in the hold
  arithmetic, the fall arithmetic and every recomputation.** Two values of
  `O`, or any assignment of `O` by verdict, is new decision arithmetic under
  `voidConditions` 4 and takes the retract-and-re-register route instead. This
  entry exists so the operationalization is fixed while the probe's result is
  strictly unknowable.
  - **What `installedChars` is:** the per-arm RESIDENT system-prompt delta on
    the pinned binary, estimated by a paired first-request usage delta — two
    fresh scratch sessions, identical but for the arm (`--mcp-config` with
    this server vs `--strict-mcp-config`), identical prompt, worktree and
    settings, each arm carrying its own sealed policy blob once blobs exist;
    the statistic is the first billed request's input-class token count,
    treatment minus control. An ESTIMATOR, declared as one: the system prompt
    is not observable from outside the session (`FINDINGS.md` F24), and
    whatever the client makes resident BECAUSE the server is installed —
    schemas or deferral stubs — is exactly what the term charges.
  - **Units, by adapter:** the delta is native in TOKENS; the shipped
    interface divides chars by the frozen 3.7. `installedChars :=
    measured_tokens × 3.7`, declared as an adapter so the frozen divisor
    cancels exactly. Not a re-derivation of `charsPerToken`.
  - **Calibration key:** binary sha256 × arm × MCP-config hash × policy-blob
    hash × the probe protocol below. Any component moves, the value is
    re-taken; `voidConditions` 7's version blocks re-key it automatically. The
    committed covariate carries the key and the probe run id — a value with no
    provenance is refused, so a defaulted zero can never impersonate a
    measured one.
  - **Probe protocol:** fresh sessions only (no `--continue`/`--resume`),
    `DISABLE_AUTOUPDATER=1`, arms back-to-back on the same machine; the
    compared request is each session's FIRST billed request (segment start:
    input and cacheWrite classes; a non-zero cacheRead on it voids the
    replicate). **k = 3 replicates per arm and a tolerance of ZERO — both
    CHOSEN, with no ancestor, and labelled so** (the same honest label the
    pacing ceiling carries).
  - **Sustained iff** all three treatment−control deltas are identical,
    non-negative and finite. **Not sustained** — any spread, any negative, any
    key component that moved mid-probe — **⇒ the pre-declared route is
    retract-and-re-register, with the probe artifacts as the recorded cause.**
    Nothing here re-opens after the probe; the branch is chosen now.
  - **Where deferral costs land, fixed before the probe says which world this
    is:** if the pinned binary defers schemas, the ToolSearch round trips that
    fetch them are billed requests inside the observation's window and enter
    `A_o` by the frozen definition. `O_o` charges the resident delta only. No
    frozen quantity changes in either world; the probe decides the VALUE,
    never the arithmetic.
  - **Domain validation owed to the harness pass (F24):** refuse to write an
    observation whose `installedChars` is absent, non-finite or negative —
    `holdsIf` 6's finiteness guard cannot catch a fabricated finite sentinel,
    so provenance checked at write time is the defence. `A_o + S_o > 0` is
    asserted per admitted observation and REPORTED, deciding nothing: the
    directional claim "smaller `O` moves `R` toward the hold" holds only on a
    positive denominator, and a reader of the artifact should see that
    precondition's state rather than assume it.
  - **Postscript, 2026-08-08, before any replicate ran — both arms are
    STRICT.** The probe's first execution refused at its own preconditions and
    the refusal surfaced a measured fact: the work Mac carries ~30 claude.ai
    ACCOUNT connectors (`claude mcp list`), which `claude mcp remove` cannot
    remove. With the treatment arm un-strict — the parenthetical shape this
    entry inherited from `observe()` — they merge into one arm only, and the
    arms differ by the account's roster as well as by this server: two
    treatments. So the protocol's argv is clarified, not changed in what it
    measures: treatment `--strict-mcp-config --mcp-config <cfg>`, control
    `--strict-mcp-config`, and `observe()` was corrected identically in the
    same commit. Either strict excludes the account state (clean) or it lands
    in BOTH arms and cancels in the paired subtraction — in both worlds the
    delta isolates the server, which is the criterion ("identical but for the
    arm") this entry already fixed. The connector roster is recorded in the
    probe artifact. No replicate had run when this was written; the refusal
    transcript above it is the evidence.
  - **Second postscript, same day, still before any delta — the statistic is
    the TOTAL prompt size, because the API refuted the zero-cacheRead form.**
    The protocol above said "input and cacheWrite classes; a non-zero
    cacheRead on it voids the replicate", on the assumption that a fresh
    session's first request reads no cache. Measured false on the second
    execution: **cacheRead = 22,099 on a brand-new session id**, run right
    after the proof session — prompt cache is prefix-keyed ACROSS sessions,
    so back-to-back same-shape sessions inside the TTL ALWAYS read cache, and
    the zero-cacheRead requirement is unsatisfiable by the protocol's own
    back-to-back design. The amended statistic is the first billed request's
    **input + cacheWrite + cacheRead** — every prompt token lands in exactly
    one of the three classes, so the sum is the total resident prompt,
    invariant to cache state, and it is the same quantity this entry named
    from the start (the per-arm resident delta). k, the tolerance, the
    sustained rule and the give-up branch are untouched. No delta existed
    when this was written: the probe refused at replicate 1, treatment,
    before any pair completed, and that refusal transcript is the evidence.
- **Pre-declared, 2026-08-11, before any run exists — clause 6's "SHOWN
  FIRING" is satisfied by MACHINE-PRODUCED evidence, and only by that.**
  The frozen text requires the six negative controls be *shown FIRING*. The
  audit computer checked that they were *PASSING*, which is strictly weaker: a
  control gutted to assert nothing keeps its title and passes. Closing that is a
  **correction** — the code reaching the sentence it already claimed to
  implement — and corrections owe no amendment. But one residue is real and is
  settled here rather than argued away: a demonstration recorded BY HAND in
  `FINDINGS.md` is also a showing, and thirty such demonstrations exist. Reading
  a committed artifact instead NARROWS how "shown" may be satisfied.
  That narrowing is declared now, before the first scored observation, with the
  same standing as the two decisions below and provable by the same `git log -p`.
  Concretely: clause 6 fails unless `evidence/<runId>.b12.firing.json` is
  committed, names the attestation's own `subjectCommit`, covers exactly
  `CONTROL_TESTS`, records every pair FIRED over a green unmutated baseline, and
  binds to subject bytes the audit recomputes at that commit. Post-data this
  question would be unanswerable; the audit's own comment says the quiet part —
  *before the first scored observation these are free*.
- **Pre-declared, 2026-08-11, before any run exists — TWO OWNER DECISIONS on
  what this measurement is allowed to be.** Both were put and answered AFTER the
  reachability estimate below was on the table and BEFORE the first paid
  session, which is the only ordering under which they are declarations rather
  than rationalisations. `git log -p` proves the ordering independently.
  1. **`open` IS AN ACCEPTED OUTCOME, and no power analysis gates the run.**
     The thresholds cannot move — `thresholdArgument` defends 30% and 15% by
     PROVENANCE, not magnitude, and says "neither moves" — so the only thing an
     analysis could report is the probability of landing between them. The
     owner was shown `holdsIf`'s own estimate (a 25-request task suppressing
     200 KB gives `R_lo` ≈ 26%, BELOW the hold line, so "a hold requires either
     heavier suppression or shorter denominators than this project's median")
     and answered: run anyway, `open` is a real result. That is `runPlan`'s own
     stance — the recorded conclusion may be that G-stop "is not evaluable in
     this venue… That is a real result" — reaffirmed with the number in view.
     **An analysis whose result changes no decision is not evidence.**
  2. **THE ACCEPTANCE PREDICATE IS THE WHOLE QUALITY FLOOR, and that is
     sufficient.** The scored quantity rewards an arm for returning FEWER
     bytes, so the floor is what stops a degenerate tool from scoring well.
     That floor is `runPlan` phase 4's: each task enters the manifest with its
     acceptance predicate **verified to FAIL at the base commit**, so a no-op
     task cannot be scored. What it does not cover was put to the owner in
     those words — a task that passes its own command while the work is worse
     in a dimension the command does not read (legibility, breakage outside
     the check, a solution that satisfies the test without solving the
     problem) — and the answer was that the predicate is sufficient. **No
     further quality dimension may be introduced after the first scored
     observation**; doing so would be a condition minted mid-game, which is
     what this entry exists to prevent.

- **Pre-declared, 2026-08-08, before any run exists — the ANALYSIS SESSION and
  the clause 4–6 AUDIT.** Three obligations the UNIT 5 pass surfaced
  (`UNIT-5.md` "What it creates"; the plan gate's R7/R9, `FINDINGS.md`), added
  now because after a run is registered they would be rules minted mid-game:
  1. **The analysis session's transcript is COMMITTED with the run.**
     `admissionRule` 2 makes "R computed on a partial set" a machine-checkable
     VOID only if the session that computed it can be read; the scorer reads
     `.local-coder/telemetry.jsonl` by construction, so this session exists on
     every scored run.
  2. **The analysis session is FORBIDDEN from the manifest** — `voidConditions`
     9 in its own words: "VOID if the session computing the verdict is in the
     manifest."
  3. **The scoring invocation requires a COMMITTED clause 4–6 audit artifact
     at `evidence/<run_id>.b12.audit.json`** — repo-relative at exactly that
     path, present in HEAD, byte-identical to HEAD's blob, carrying verdict
     AND non-empty inputs (published on `result.json`'s face for artifact
     11's replay). Anything short of that is NO audit: `assemble` publishes
     clauses 4–6 as UNCHECKED — never as "clean" — and **a verdict emitted
     without one is not final**. The committedness requirement is the probe
     trust boundary's fix applied on the day the input existed (the UNIT-5
     diff review's first finding); the audit computer itself is not yet
     written and is a named blocker of a lawful run (`STATE.md`), beside F23.
- **Measured:** Phase-3 exposure A — **1 of 3, INCONCLUSIVE**
  (`run 2026-08-06-mac-b12-phase3-d746d07`). Exposure B — **1 of 3,
  INCONCLUSIVE**, assembled from `f2932ff` (`strata` closed, `terms` red) and
  `c40e9f4` (`aggregate` red). Attempt 1 void. No exposure has reached the bar.
  - **Where these three run ids live, since it is not where rule 2 says.**
    `d746d07`, `f2932ff` and `c40e9f4` have **no row in `MEASUREMENTS.jsonl`**,
    though `2026-08-06-mac-b12-phase3-efe5806` — the void attempt — does. Their
    artifacts are committed and carry the run id verbatim:
    `evidence/2026-08-06-mac-b12-d746d07.scorer.json`,
    `evidence/2026-08-06-mac-b12-f2932ff.scorer.json`,
    `evidence/2026-08-07-mac-b12-c40e9f4.scorer.json` (note the file names drop
    the `phase3` segment the run ids carry). **The rows are not being
    back-filled.** A row written by hand today, stamped with a time from days
    ago, is the fabrication an append-only record exists to prevent — and rule 2
    exists so a reader can tell a measurement from an assumption, which these
    artifacts already let them do. The gap is recorded here instead. Note that
    this does **not** make them registered B12 runs under `voidConditions` 1,
    which requires a committed `evidence/<run_id>.b12.tasks.json` **and** the
    `MEASUREMENTS.jsonl` row, written by one command before the first billed
    request; none of the three has a tasks file, so none is in that register and
    none owes a result artifact.
- **Status:** open · **both exposures INCONCLUSIVE at 1 of 3** · `R_repair`
  neither reachable nor ruled out. The limits are pinned and verified (F7) and
  the scorer's spec defects are fixed (F1/F2a/F2b/F3, then F9/F12), so nothing
  blocks an exposure C — but it would measure a changed task, and whether to
  spend one is open. **F17 remains** (F19 was fixed 2026-08-07), and the scorer is
  still wired to nothing: `observation.json` has no parser, `verificationStratum`
  is written by no harness, and the run-level assembler that would call
  `runCoverage` and `aggregate` does not exist.

## B13 — injecting the installed `.d.ts` of a library named in a gate failure raises `repair`'s close rate on version-drift failures by ≥ 15 pp

- **Assumed:** ≥ 15 pp — (assumed)
- **Experiment only — not a planned component.** The architecture's answer to
  version drift is the gate plus escalation to the orchestrator
  (`DECISIONS.md § v3`); nothing depends on B13 and the default is **not** to
  build it. B13 exists to find out whether the injection buys anything *on top*
  of an answer that already works without it.
- **Source of the assumption:** the mechanism, not evidence. Declarations under
  `node_modules/` are the API of the version *actually installed*, so unlike
  anything retrieved they cannot be stale relative to the code being checked.
  How much that is worth is a guess. **B13 is downstream of B6:** a delta needs a
  baseline close rate, and B6 is `open`, so this cannot be measured first. The
  bar is set above B9's and B10's 10 pp on purpose — this arm *adds* bytes to the
  context the project exists to shrink, so it has to clear more to be worth it.
- **Experiment:** reuse the B6 corpus; hand-label the failures that are version
  drift (`gate` names the module and symbol but does not classify the failure, so
  the labelling is manual and must be recorded with the run). Run each labelled
  case twice — `repair` alone, then `repair` with the cited library's installed
  declarations passed as `context_files`, which needs no new code — and compare
  `passed` and `rounds_used`. Three things the run must record or it decides
  nothing: (a) how often `enforceContextCaps` **refused** the injection, since a
  library's declarations can exceed the 256 KB per-file cap on their own (this
  repo's own MCP SDK does) — that refusal count, not an opinion, is what decides
  whether per-symbol slicing is worth building; (b) a same-byte-budget control
  of ordinary project files, because otherwise a positive result may mean "more
  context helps" rather than "types help"; (c) that 15 pp of 20 cases is 3 cases
  — this measures signal, not significance, and must not be reported as more.
- **Measured:** — (no run)
- **Falls if:** < 5 pp, **or** the median `repair` round crosses B7's 150 s fall
  threshold. A close-rate gain bought by breaking the time budget is not a gain.
- **If it falls:** drop the injection and change nothing else — it was never
  load-bearing. The gate plus orchestrator escalation stays the whole answer, and
  the residue is recorded in `DECISIONS.md` as an accepted limitation rather than
  reopened as a tuning problem.
- **Status:** open

## B14 — no request that passes the output pre-flight truncates

- **Assumed:** none do — (assumed)
- **Source of the assumption:** the estimator, and it is an estimator. Output
  tokens are guessed from bytes at a fixed divisor, because the server does not
  have the model's tokenizer. The divisor was **calibrated against the one
  truncation this project has observed** — `src/selection.ts` +
  `tests/selection.test.ts`, 31,086 bytes, which `bytes/3.5` puts at 8,882
  tokens against a 8,192 cap, so the pre-flight refuses exactly the request that
  `run 2026-08-03-mac-05` truncated on. One point is a calibration, not a curve.
- **THE EXPERIMENT IS NOT EXECUTABLE BELOW A TIMEOUT THRESHOLD, and the
  threshold is now a number.** `run 2026-08-04-mac-10` measured **78.9 tok/s**
  on this machine, so a response reaches `finish_reason: "length"` only after
  **~208 s** of generation at a 16384-token cap. Any `config.timeoutMs` below
  that makes the deadline fire first and truncation **unobservable** — at the
  20000 ms this machine ran until then, B14 could not have produced a single
  truncation no matter how bad the estimator was. **B14 therefore depends on
  `D4`** (`ROADMAP.md` G5), which is a dependency nobody had written down, and
  any run scoring B14 must record its `timeoutMs` against this threshold or the
  zero it reports means nothing.
- **The known unmodelled term:** reasoning tokens share the same budget.
  `DECISIONS.md` records that Qwen3 hybrid-thinking output has been seen and is
  stripped at parse time — but it was generated, and it was charged to
  `maxOutputTokens` before anything was stripped. No fixed divisor covers a
  variable amount of thinking, so if this premise falls, thinking is the first
  suspect and the fix may be the model rather than the constant.
- **A second term, now measured rather than suspected:** the estimate is
  line-ending dependent, because bytes are. The same two files come to 8882
  tokens on a CRLF checkout and 8787 on an LF one — **1.1%**, and the 95-token
  gap is exactly the 333 carriage returns in `tests/selection.test.ts`
  (`run 2026-08-04-mac-08`). The estimator is byte-exact on both; the input
  differs. **A request within ~1% of the bar can be refused on one machine and
  allowed on another.** The 0.9 headroom is ten times that, so nothing is changed
  for it — it is recorded because B14 is about the estimate's accuracy and this
  is a term in it, not because it is currently costing anything.
- **Experiment:** over the B6/B7 corpus, count (a) requests the pre-flight
  refused and (b) `finish_reason: "length"` among the requests it let through.
  Both are already visible: (a) is an `output_would_truncate` `ToolError`, (b) is
  the `error` text in the per-round telemetry trace.
- **Measured:** **0 of 20**, `run 2026-08-04-mac-09` — no round carried a
  truncation, and no task was refused either. **This does not decide B14**: the
  corpus never stressed the estimator. Every fixture is a few hundred bytes
  against a 7372-token bar, so 0 truncations is what the construction guarantees
  rather than what the estimator earned. B14 needs requests *near* the bar, which
  corpus #1 by design does not contain and corpus #2 will.
- **THE TIMEOUT DEPENDENCY IS NOW SATISFIED, and the experiment finally ran on
  requests that do stress the estimator.** `D8` (`ROADMAP.md` G5) built
  `scripts/contract-stability.ts`, a 10-file size ladder of this repo from 665 B
  to 35,656 B, and ran it at `timeoutMs` **600,000** — far above the ~208 s the
  bullet above fixes as the threshold. Six runs, `2026-08-04-mac-11` through
  `-mac-17`, artifacts in `evidence/`.
- **Measured, and it does not fit either side of the threshold.** Over the 38
  scored responses of `run 2026-08-04-mac-12-variance`: **36 complete, 2 elided,
  0 truncated**, and the contract turns out to be a function of size rather than
  a random variable — 13 of 13 cases unanimous across three repeats, 12 of them
  byte-identical. Everything at or below **23,063 B** returned complete three
  times over. One case fails, and it fails every time it runs.
- **THE INSTRUMENT IS BLIND TO THE FAILURE THAT ACTUALLY HAPPENS.** This premise
  says to count `finish_reason: "length"`. Across **five** observations of the
  one failing request (`src/tools/repair.ts`, 35,656 B) in `mac-12-variance`,
  `mac-13-repair-diff` and `mac-14-repair-diff` — 2 elided, 3 truncated — that
  count is **0 of 5**. Every one carried `finish_reason: "stop"`. The binding
  constraint was the **context window**, not the output cap: prompt 8,756 +
  completion 7,670 = 16,426 against a model loaded at 16,384, and a model that
  runs out of window says `stop`. The three truncations were caught as an
  *unclosed* `<file>` block; the two elisions were caught as 81 consecutive
  deleted lines with **no marker at all**. This is the same class of error as
  B2 measuring the wrong hook channel, and it is a fact about the detector.
- **The elision is the dangerous half, and it is worse than a truncation.** The
  block was properly closed, `finish_reason: "stop"`, nothing missing, **90 lines
  gone**. `parseFileBlocks` finds it, no corrective retry fires, and
  `runGeneration` returns a diff that DELETES those 90 lines. Every automated
  signal the pipeline reads says the response is fine; only a human reading the
  diff stands between it and disk.
- **The symmetrical clause below has its first observation, and it is real.**
  `run 2026-08-04-mac-16-preflight` refused `src/fs-safety.ts` +
  `src/cost/transcript.ts` (26,345 B) with `context_would_overflow` — a request
  that measured **11,237 actual tokens** and had returned complete 3 of 3. The
  cause was reusing the 3.5 *output* divisor on the input side, so its pessimism
  applied twice over a shared window. Fixed by splitting them
  (`LOCAL_CODER_INPUT_BYTES_PER_TOKEN` **3.9**, the largest divisor that
  under-predicts none of the 13 measured prompts). It is **still refused by ~55
  tokens** in `mac-17`, and that residual is the output divisor.
- **The re-derivation this premise exists for, measured and deliberately NOT
  applied.** Across the 36 complete responses: **350,118 bytes / 88,018
  completion tokens = 3.978 B per output token**, against the **3.5** configured.
  The estimator is ~14% pessimistic — which `outputBytesPerToken`'s own comment
  already claims as bought coverage. It is left alone: 3.5 was calibrated against
  the single truncation this project has observed (`run 2026-08-03-mac-05`),
  `tests/fs-safety.test.ts` pins that calibration, and re-fitting a constant
  against a corpus whose sizes its own author chose is the move corpus #1 was
  already caught by. **Changing it is a decision, not a cleanup.**
  - **DECIDED 2026-08-06: 3.5 STAYS. The divisor does not move.** Not deferred —
    decided, with the condition that would reopen it stated below.

    Three reasons, and the first is the one this file keeps being caught by.
    **(a)** 3.978 is pooled over a corpus whose sizes its own author chose, which
    is the corpus #1 mistake in different clothes; the bullet above says so
    itself. **(b) It is not even stable across corpora** — the same file records
    4.22 B/token in one place against the 3.978 pooled over `mac-12-variance`, a
    6% spread, so "the measured value" is a value, not the value. **(c) The two
    errors are not symmetric, and that is decisive.** At 3.5 the estimator is
    ~14% pessimistic: it refuses requests that would have fit, which costs
    coverage **visibly** — `output_would_truncate` is a `ToolError` with a name,
    and B16 already carries one observed over-refusal. At 3.978 it would refuse
    less and truncate more, and truncation is **silent**: this premise's own
    closing bullet is about a request that "quietly lost 90 lines" while the
    detector reported a pass. Trading a logged refusal for an unlogged
    amputation is the wrong direction for an estimator whose whole problem is
    that it cannot see its own failures.

    **Reopens if:** corpus #2 supplies requests *near* the bar — which corpus #1
    by construction does not — and a run scoring them records its `timeoutMs`
    against the ~208 s threshold above, so a zero means something. Re-derive
    against **that** data, not against a re-pooling of this one.
- **Falls if:** > 10% of the requests that pass still truncate.
- **If it falls:** recalibrate `LOCAL_CODER_OUTPUT_BYTES_PER_TOKEN` and
  `LOCAL_CODER_OUTPUT_USABLE_FRACTION` **against that run's data**, which is the
  only thing that turns them from a defensible guess into a measurement. Do not
  compensate by widening what counts as editable.
- **Symmetrical failure, deliberately not given a threshold yet:** the estimator
  can also be too strict, refusing requests that would have fit. That costs
  coverage silently, and the same corpus can bound it — but only by running the
  refused requests with the cap raised, which is a second experiment and is not
  pre-registered here. Recorded so the one-sided threshold above is not mistaken
  for the whole question. **`run 2026-08-04-mac-16-preflight` is that failure,
  observed** — see the bullet above. It still has no threshold, and giving it one
  now, after seeing it, is exactly what this file forbids.
- **Status:** **moot — superseded by B16**, and superseded rather than amended
  on purpose. The threshold measures a quantity that cannot occur here, so
  measuring it cannot inform any decision, which is exactly what `moot` means in
  the legend above. **Nothing before this line has been edited.** Amending the
  fall condition after seeing the data was the available alternative and it was
  refused: a threshold rewritten to fit the failure it missed is indistinguishable
  from one chosen by its answer, and B16 instead inherits this number *verbatim*
  and changes only what is being counted.
- **Why it is not `holding`, though it reads as a pass.** 0 of 5 real failures
  carried `finish_reason: "length"`, and by the letter that clears the > 10% bar
  while a request quietly lost 90 lines. A premise that returns a pass because
  its detector is blind has not been confirmed; it has been unable to look.
- **Root cause, and it is not this project's arithmetic.** In the OpenAI
  specification `length` means *`max_tokens` was reached*; running out of context
  is a different event, and LM Studio carries a separate native stop reason for
  it (`contextLengthReached`) that the OpenAI-compatible layer does not map to
  `length`. On top of that, `length` could only ever fire here if
  `enforceOutputCap` had already failed to refuse an over-cap request — a knob
  the project itself sets. The detector was written against another API's
  semantics, and against a quantity the code controls.
- **Revives unchanged if:** this project is ever pointed at a server whose
  `finish_reason` follows the OpenAI semantics literally — then `length` means
  what B14 assumed and every word above applies again. Same shape as B4's
  dormancy under G2.

## B15 — with the routing policy installed, `gate` wins ≥ 50% of the verification calls it is eligible for

- **Assumed:** ≥ 50% capture — (assumed). Not fitted to data; there is no data
  to fit to. It is the point at which `gate`'s own description — "Prefer this
  over running the commands through Bash" — becomes a true statement about
  observed behaviour rather than an aspiration.
- **Why B5 cannot express this.** B5 falls on "< 2 turns saved on median". A
  session with zero `gate` calls yields no median at all, so `run
  2026-08-04-mac-10` could not falsify B5 and no future 0-call session can
  either. The quantity that decides whether the tool is reached for needs its
  own premise, and this is it.
- **Eligible verification event:** a `Bash` call running a command `loadChecks()`
  would have run (`tsc`, `vitest`, `npm test`, `eslint`, `pytest`, `ruff` —
  heads listed in `src/checks/config.ts`), **or** any `gate` call.
- **Metric:** `capture = gate_calls / (gate_calls + bash_verification_calls)`
  over eligible events only.
- **Excluded:** any `gate` call the operator asked for by name. Same rule, and
  for the same reason, as B3's exclusion of its direct invocation above.
- **Void, not zero:** a session with **< 5 eligible events** is recorded and
  excluded. This is what stops mac-10's problem from recurring as an argument:
  a session whose work sits outside every configured check offers the tool no
  jurisdiction, and scoring that as 0% would be measuring the workload, not the
  routing.
- **The baseline is unknown, not zero.** `MEASUREMENTS.jsonl` records mac-10's
  `Bash 36` with no command breakdown, so the prior is `0/unknown`. Recovering
  it needs a standalone read-only pass over the raw transcript —
  `src/cost/transcript.ts` keeps `{id, name}` and discards each call's `input`,
  so the meter cannot answer this and **must not be edited to** while G1 is
  reopened.
- **Experiment:** ≥ 15 eligible events across ≥ 3 non-void sessions.
- **Holds if:** capture ≥ 50%.
- **Falls if:** capture < 25%. The dead band is deliberate and copies G7's
  shape: a marginal result must not be readable either way.
- **Second fall condition, on cost:** falls if
  `sum(bytes_raw - bytes_returned)/3.7` over the induced `gate` calls is below
  `114 x (segments x threads)`. **114 tokens is measured**, not assumed: the
  description went from 688 to 1110 characters at 3.7 chars/token. Note the unit
  — a tool description is paid per *thread and compaction segment*, not per
  session, because context resets at each boundary and each subagent thread
  carries its own copy. **Tokens only, never dollars:** G1 is reopened, so
  nothing meter-derived may be reported as measured.
- **Arm 0 is a bundle, and this is written before it runs:** the auto-installed
  `CLAUDE.md`, the truth-fixed `gate` description, and the `coverage` field ship
  together. **Attribution within the bundle is not available** and may not be
  claimed later. What was deliberately held constant is the persuasion sentence
  itself, byte-for-byte, so that Arm 1 — rewriting it — remains a clean
  single-variable change against this baseline.
- **Attempt cap: TWO description rewrites, total.** Copying G2's "one attempt"
  discipline. A string is infinitely re-tunable, so without a cap "the wording
  was wrong, not the idea" stays available forever. If the second misses, the
  recorded conclusion is that description text is not the lever, and B5's
  "if it falls" remedy is **exhausted**.
- **Void conditions, fixed here rather than argued afterwards:** the operator
  names gate/verify/check in the prompt; the session is the same one in which
  `CLAUDE.md` was first written (Claude Code reads it at start, so run 1
  installs and run 2 is the first eligible run); `gate`'s description or any
  check-running path changed during the run; `dist/` was stale against `src/`
  at session start.
- **Recorded without a threshold:** a successful Arm 0 makes verification
  *slower*. One `checks: "all"` run on this repo took ~20 s against a ~2 s
  `npx tsc --noEmit` through Bash. B7 covers `repair` rounds only, so nothing
  bounds this today. Noted so the headline number cannot hide it.
- **First candidate session run, and it CANNOT BE SCORED YET.** The Mac session
  of 2026-08-04 that produced `D8` (`evidence/2026-08-04-mac-11` … `-mac-17`) is
  the first real workload with `CLAUDE.md` already on disk. **None of the four
  void conditions fired:** the prompt named no check, `CLAUDE.md` predated the
  session, `gate`'s description and every path under `src/checks/` are untouched
  in that session's diff, and `dist/` was rebuilt after the last `src/` edit.
  What is missing is the **denominator**. The rendered conversation shows `gate`
  reached for at least twice, unprompted ("gate is green", "gate green
  throughout"), against mac-10's zero — but it renders Bash calls as "ran 1 shell
  command" with the command elided, so `bash_verification_calls` is not
  recoverable from it. **Two unprompted calls is a sign, not a capture rate**,
  and it may not be reported as one.
- **What unblocks it:** `scripts/classify-verification.mjs`, read-only over the
  raw session JSONL, counting eligible events by the definition above. The
  transcript is on the Mac. This is still **not** an edit to `src/cost/`, which
  stays frozen while G1 is reopened.
- **Status:** open

## B16 — no request the context pre-flight admits comes back with content missing

- **Assumed:** none do — (assumed)
- **Replaces B14, and states the outcome as the HARM rather than the SIGNAL.**
  That is the whole correction. B14 named `finish_reason: "length"` in its fall
  condition, so when the string turned out to be blind, the *premise* returned a
  pass. Here the outcome is "a file came back short"; the detector is named
  separately, under **Method**, so a detector found blind falsifies the method
  and leaves this premise standing to be re-measured with a better one.
- **Method, not threshold:** `contextExhausted` in `src/contract-probe.ts` —
  `prompt_tokens + completion_tokens >= contextTokens`, and **null when the
  window is unknown**, the same fail-open rule `pickLoadedContextTokens` follows.
  **Per REQUEST, never summed**: a generation makes up to two requests and
  `GenerationResult.usage` is their total, while a context window is a
  per-request ceiling. The retry's prompt carries the whole bad response plus the
  correction, so a summed comparison reports exhaustion for rounds where neither
  request came near the window.
- **The outcome has two halves and only one is measurable outside the
  diagnostic.** *Envelope* — did every declared block arrive and close — is
  unambiguous anywhere, and it is what `repair` rows contribute. *Elision* —
  content dropped from a block that IS present — is **not derivable from a
  `repair` round at all**, because `contract-probe` reads a run of deleted lines
  as dropped content and deleting lines is exactly what `repair` was asked to do.
  Only the diagnostic's probe spec, whose task is a pure append, separates them.
  **`repair` telemetry therefore contributes to the envelope count only**, and a
  score that pooled the two would be counting legitimate fixes as failures.
- **The outcome is recorded independently of the detector, and that is
  structural.** `envelope` comes from `parseFileBlocks`, not from
  `contextExhausted`. If the two were derived from the same signal this premise
  would be scoring its own detector, and could never distinguish "the pre-flight
  works" from "the detector is blind".
- **The detector is not marginal.** Over `evidence/2026-08-04-mac-11` …
  `-mac-17` it separates **70 complete responses (max 11,918 tokens)** from **10
  failures (min 16,426)** against a 16,384-token window — a **4,508-token gap**.
  There is deliberately **no margin constant**: there is no noise in that gap to
  tune against, and a fudge factor would be a knob nobody could later justify.
  `tests/contract-probe.test.ts` replays all six artifacts through the shipped
  rule so this claim cannot rot.
- **THOSE RUNS ARE IN-SAMPLE AND DO NOT SCORE THIS PREMISE.** They are the
  motivating observation, exactly as `run 2026-08-04-mac-09` was for B14. The
  data that produced a detector cannot also confirm it.
- **The pre-flight has a negative control, and it arrived by accident.**
  `run 2026-08-04-mac-19-32k` re-ran the same corpus on the same model at the
  same **real** 16,384-token window, differing only in the window it *declared*:
  **32,768**. Told the truth (`mac-16`/`mac-17`) the check refused 2 requests and
  **0** responses lost content. Told double, it refused **0** and **1** came back
  elided. That is the first causal evidence that this check does the job it was
  built for — and it is why the run is VOID rather than a 4% pass.
- **Both refusals are now measured rather than argued, and they split 1-1.** Of
  the two the honest pre-flight refused: `G3` (26,889 B) returned **complete 2 of
  2** — B14's symmetrical clause confirmed by a successful run instead of by
  arithmetic — while `L10` (43,594 B) **elided**. The two outcomes are not
  symmetric in cost: a wrong refusal spends a round trip, a missed one returns a
  diff that deletes 90 lines and that every automated check accepts.
- **Experiment:** a fresh `scripts/contract-stability.ts` run at the loaded
  window — the only source that scores **both** halves — plus `repair` telemetry
  from ordinary work for the envelope half. `detail.rounds[].attempts[]` carries
  `prompt_tokens`, `completion_tokens`, `context_tokens`, `finish_reason` and
  `envelope` **per attempt**, at two levels of separation. Per round, because
  `repair` prepends each round's gate failures so the prompt grows and the round
  likeliest to fill the window is the last one, whose output is the one that gets
  applied. Per attempt inside it, for the summing reason above.
  **Including the rounds that threw:** `model_output_malformed` is raised after
  up to two responses were received and measured, so it is this premise's
  likeliest positive — recording only the success path would drop the positives
  and keep every negative, biasing the rate in one direction. A round that never
  got a response carries no attempts at all, which is different from zero.
  Denominator: requests the pre-flight **admitted** — now true of the corrective
  retry as well, which is checked against the accumulated messages and **skipped
  rather than sent** when it will not fit. A refusal is a fact about the request,
  not a verdict on it.
- **Unknown token usage is excluded, never counted as zero.** `chatCompletion`
  zero-fills a response body that carries no `usage`; `ChatResult.usageKnown`
  keeps the distinction and the attempt row stores `null`, so `contextExhausted`
  answers "cannot tell" instead of "fits". Otherwise a single dependency skew
  would make every request look like it cost nothing and this premise could hold
  on no data.
- **VOID unless the corpus reaches the bar.** A run in which **no** admitted
  request exceeds **70% of `contextBudget`** is VOID, not a pass. This is
  corpus #1's lesson made a rule: a ladder that cannot reach the bar returns 0
  by construction, and B14's own `0 of 20` was exactly that. The condition is
  demanding on the *experiment* rather than permissive on the *result*, which is
  the only direction a construction rule may be chosen in after the fact.
- **VOID unless the declared window IS the loaded window.** Added after
  `run 2026-08-04-mac-19-32k` and said to be, which is the only thing that makes
  it legitimate. That run declared `LOCAL_CODER_CONTEXT_TOKENS=32768` while the
  model was JIT-loaded at **16,384** — a factor of two — so the pre-flight
  admitted every request and `contextExhausted` scored the one response that DID
  lose content as fitting. **The detector is only as honest as the number it is
  handed**, which turns a configuration mismatch into a silent scoring error.
  Any run scoring this premise must record `lms ps`'s `contextLength` for the
  model that served it and show it equal to the declared value. Like the rule
  above, this makes the premise harder to satisfy — the alternative was reading
  1 of 25 as a 4% pass on a run where the pre-flight was actively misinformed.
  **The numbers are now measured, not inferred:** that response was
  10,549 prompt + 5,960 completion = **16,509 against a real 16,384** — over by
  **125 tokens**. `contextExhausted` catches it against the real window and calls
  it a fit against the declared one. The margin is the point: the failure needs
  no dramatic overshoot, so a declared window is worth nothing unverified.
- **Falls if:** > 10% of the admitted requests come back with content missing.
  **This number is inherited verbatim from B14** and that is the point — it
  predates the data, so it cannot have been chosen by its answer. Only the
  outcome definition changed.
- **Holds if:** 0 over ≥ 20 admitted requests across ≥ 2 non-void runs. Twenty
  is B14's denominator, inherited for the same reason.
- **If it falls:** the pre-flight's arithmetic is wrong in the unsafe direction —
  re-derive `LOCAL_CODER_INPUT_BYTES_PER_TOKEN` and `PROMPT_OVERHEAD_TOKENS`
  against that run's measured prompts, which is what makes them measurements
  rather than fits. Do **not** widen what counts as `complete`.
- **Carried forward from B14, still live:** reasoning tokens share the same
  budget and no fixed divisor covers a variable amount of thinking; the estimate
  is line-ending dependent by ~1.1%; and the `D4` timeout dependency, now
  **satisfied** — `timeoutMs` 600,000 against the ~208 s threshold.
- **Carried forward WITHOUT a threshold, deliberately:** the estimator can also
  be too strict, refusing requests that would have fit.
  `run 2026-08-04-mac-16-preflight` is that failure observed — a 26,345 B pair
  measuring 11,237 actual tokens, refused. Giving it a threshold now, after
  seeing it, is the identical error this premise exists to correct.
- **The re-derivation stands unapplied:** 3.978 measured B per output token
  against 3.5 configured. See B14 for why it is not changed here.
- **THE MECHANISM IS NOT ESTABLISHED.** LM Studio's `contextOverflowPolicy` has
  three settings and two of them (`truncateMiddle`, `rollingWindow`) keep
  generating while pruning the *prompt* — which would explain a block that came
  back **properly closed** and 90 lines short better than "the model stopped".
  It cannot be set through the OpenAI-compatible endpoint, so whatever the GUI
  holds is what ran, and no artifact records it. This premise counts the harm
  either way; the causal story in `DECISIONS.md` is what depends on the answer.
- **Known gaps in the denominator, both recorded rather than closed.**
  `implement`, `fix` and `scaffold` write **no telemetry at all**, so only
  `repair` and the diagnostic contribute — not arbitrary, since B14's denominator
  was the B6/B7 corpus and B6/B7 are `repair` premises, but a gap. And `repair`
  contributes the envelope half only, per the split above. **A run scored on
  `repair` rows alone bounds this premise from one side and must say so**; only a
  diagnostic run scores it whole.
- **The instrument was wrong eight ways before it measured anything, and three
  rounds of adversarial review found all eight.** Recorded rather than quietly
  fixed, because the numbers this premise will eventually carry are worth exactly
  as much as the row that produced them — and because most of the eight biased
  the rate rather than breaking it, which is the kind of defect that ships. **Two
  were live data-loss bugs**, not measurement errors: the pre-flight is what
  stands between an overflowing request and a silently shortened file, and both
  let one through.
  - **Summed usage against a per-request window.** `GenerationResult.usage`
    totals both requests; the retry carries the whole bad response plus the
    correction, so any round that retried read as exhausted. False positives.
  - **The `model_output_malformed` path recorded nothing**, and it is raised
    after up to two measured responses — this premise's likeliest positives.
  - **Apply-stage throws discarded measured responses.** Recording happened on
    the return, so a `concurrent_modification` or a failed write silently
    removed a response that had already arrived. Now handed over through
    `onAttempt` the moment it is parsed.
  - **The corrective retry never faced the pre-flight.** The check ran once
    above the attempt loop; attempt 2 was strictly larger and unchecked. So the
    denominator's own words — "requests the pre-flight admitted" — were false,
    and worse, this was the live path on which an oversized request comes back
    closed and short. The retry is now checked against the accumulated messages
    and skipped rather than sent.
  - **`finish_reason` was folded back into the outcome.** A response that closed
    every block after hitting `max_tokens` was labelled by its stop reason
    instead of its envelope — B14's exact error, committed inside the fix for
    B14's exact error.
  - **Absent `usage` became zero rather than unknown**, so a server that reports
    no tokens would have made every request read as fitting, and this premise
    could have "held" on no data at all.
  - **The window was resolved before the model, and could belong to a different
    one.** With nothing named, the probe answered with whatever single model
    happened to be loaded while auto-selection sent the work elsewhere — and
    `pickLoadedContextTokens` compounded it by returning the sole loaded model's
    window even when a DIFFERENT model was named. A 32k model loaded and a 16k
    model used admits a request that overflows; the inverse refuses work that
    fits. The second live bug. The model is now resolved first and the window
    asked only about it, a named-and-not-loaded model returns null, and `repair`
    no longer pins one window across rounds — the reasoning that justified the
    pin ("a value that cannot change mid-loop") was false, because with no model
    named each round re-selects.
  - **Attempts were lost when the whole repair aborted.** They lived in the
    loop, and the outer catch rolls back and rethrows without writing telemetry
    — so a response that arrived and was measured vanished whenever a
    post-generation failure fired. `runRepair` now owns the buffer and writes an
    `aborted` row from the catch, guarded so the two paths cannot both write.
- **Measured, on the first run that verified its own window:**
  `run 2026-08-04-mac-20-32k`, `LOCAL_CODER_CONTEXT_TOKENS=32768` with `lms ps`
  confirming 32,768 before the run started. **26 admitted, 26 complete, 0 with
  content missing.** Largest admitted request 20,870 actual tokens against a
  29,491 usable budget — clearing the 70% non-void bar of 20,644, so the run
  counts.
- **The second non-void run: `run 2026-08-04-mac-23-32k`.** Same shape, and this
  time the window was checked **after** the run as well as before — 32,768 both
  times, so it cannot have drifted mid-run the way `mac-21` did. 26 admitted, 26
  complete, 0 with content missing, largest request 20,870 again.
- **HOLDS: 0 of 52 admitted requests across 2 non-void runs**, against a fall
  line of > 10% and a hold condition of 0 over ≥ 20 across ≥ 2. Every condition
  was pre-registered before either run.
- **What that does NOT establish, stated because the threshold turned out weaker
  than it looked.** (a) **The two runs are barely independent**: same corpus,
  same model, temperature 0.1, and `D8` already measured 12 of 13 cases returning
  byte-identical output across repeats — `mac-23`'s L10 reproduces `mac-20`'s to
  the token. This is closer to n=1 replicated than n=2. The condition is **not**
  retroactively tightened, because raising a bar after seeing the result is the
  mirror image of lowering it; it is recorded so nobody reads 52 as 52
  independent observations. (b) **Neither run refused anything.** At 32,768 the
  pre-flight admitted all 26 both times, so these runs confirm *admitted requests
  succeed* and say nothing about whether it refuses what it should. (c) One
  model, one window, one repository.
- **The same request, at two real windows, and the elision turns out to be
  arithmetic rather than model quality.** `src/tools/repair.ts` (43,594 B),
  prompt 10,549 tokens both times:

  | Real window | Completion | Sum | Verdict |
  |---|---|---|---|
  | 16,384 (`mac-19`) | 5,960 | 16,509 | `elided`, probe 0/1 |
  | 32,768 (`mac-20`) | **10,321** | 20,870 | `complete`, probe 1/1 |

  The file needs 10,321 output tokens and only ~5,835 were left after the prompt.
  Same model, same temperature, same bytes — it returns complete once there is
  room. **This also proves `mac-16`'s refusal of this request was correct**, by
  measurement rather than by symptom: 20,870 needed in a 16,384-token window.
- **The mechanism is now settled, and it was not settled by that run.** LM
  Studio's `contextOverflowPolicy` on the measuring machine reads
  **`truncateMiddle`** (`getBasePredictionConfig()` via the SDK,
  `run 2026-08-05-mac-25-policy`). It keeps the system prompt and the first user
  message and removes the **middle** of the context — so the model, copying a
  file out of the prompt, lost the middle of its own source and closed the block
  normally. That accounts for the properly closed tag, the 81 lines gone from the
  middle rather than the end, the `finish_reason: "stop"`, and the retry
  reporting an identical prompt count after ~6,000 tokens were appended.
  **It does not change this premise**, which counts the harm and was written not
  to depend on the mechanism — but it does mean that **when the pre-flight is
  wrong, the failure is silent by design**, which is what the `Math.min`
  cross-check exists for.
- **Estimator error on that case: +14.2%, in the safe direction.** Estimated
  23,833 total against 20,870 actual (input +7.9%, output +20.7%; measured output
  density 4.22 B/token here against the 3.978 pooled over `mac-12-variance`).
  Recorded beside the unapplied re-derivation above: this is the run that shows
  the pessimism is not obviously waste.
- **The VOID condition above now has a mechanical guard, because verifying once
  is not enough.** `run 2026-08-04-mac-22-window-drift`: a model explicitly
  loaded at 32,768 and confirmed by `lms ps` was found at **16,384** minutes
  later, server still up, nobody having reconfigured anything. So
  `resolveContextTokens` no longer lets `LOCAL_CODER_CONTEXT_TOKENS`
  short-circuit the probe — it takes the **smaller** of configured and loaded and
  warns on disagreement, and `status.context_window` reports both sides plus a
  `disagreement` source. The setting is a belief; `lms ps` is an observation.
- **`run 2026-08-04-mac-21-32k` was discarded before scoring**, not counted. It
  was the intended second non-void run: the guard confirmed 32,768 at launch, but
  the window fell mid-run while an oversized probe request shared the machine.
  A start-of-run probe cannot see that, so its artifact would have claimed 32,768
  for requests possibly served at half. **B16 therefore still has one non-void
  run and still needs a second** — and a run scoring it must not share the
  machine with anything else, because memory pressure changes what is measured.
  **`mac-23` is that clean run** — window verified before and after, nothing else
  on the box.
- **Status:** **holding** — 0 of 52 admitted requests lost content across
  `run 2026-08-04-mac-20-32k` and `run 2026-08-04-mac-23-32k`, both non-void.
  **Reopens if** a run with a new `run_id` puts the rate over 10%, and the
  limitations above are the places to look first: a different model, a different
  window, a corpus this one did not reach, or the refusal side, which neither run
  exercised at all.

These are observations, not bets — nothing here has a threshold or can "fall".
All from `run 2026-08-02-win-01`, machine `win-01`, recorded retroactively and
reproducible with `npm run cost-meter`.

| Fact | Value | How |
|---|---|---|
| Cost split, real 69-request session | write **48.0%** · read **35.7%** · output **15.9%** · fresh input **0.4%** | cost-meter over the session transcript |
| Cost of a token entering at turn 0 | **8.8x** the input rate | `2.0 + 0.1 x 68` from that session's own length |
| Context growth across the session | **33,510 → 449,504** tokens re-read per request | per-request `cache_read_input_tokens` |
| Transcript records vs billed requests | **155 `assistant` records = 69 billed requests** | usage repeats verbatim per content block |
| Naive summing error | inflates `cache_read` **2.3x** | summing records instead of deduping by `requestId` |
| `Agent` tool results | **472 KiB of 816 KiB** of all tool output (**58%**) | per-tool byte tally |
| `gate` on this repo | **67,190 → 1,724 bytes (97% smaller)**, 4/4 real failures located | live run over `tsc` + `vitest` |
| ~~Hook on a 604-line failing test run~~ | ~~604 → 4 lines~~ — **withdrawn**: measured by invoking the hook directly, and the hook never reached the transcript (B2 fell, G2 closed). It condensed text that Claude Code then ignored. | — |

**Why the `Agent` figure matters:** at 58% of everything tools put into context,
subagent reports are the single largest contributor, and they are precisely the
context-gathering category `locate` targets. That makes B8–B11 the
highest-value premises after B2 — and it is a measured motivation, not an
inferred one.

---

## Known-broken, recorded so it is not rediscovered

`npm test` reports **4 failures / 337 passing** (341 total,
`run 2026-08-04-win-02`). The same four, and the same causes, as when this was
first recorded at 4/202 in `run 2026-08-02-win-03` — re-confirmed by a fresh
`git stash -u` baseline while adding `coverage` and `src/claude-md.ts`, again
after importing the Mac's `D8` work (**+38 tests, no new failure**), and again
adding B16 and the fixes its three adversarial reviews forced, plus the window cross-check (**+17**). The four,
by name, so the count is checkable rather than trusted:
`tests/config.test.ts:46`, `tests/implement.test.ts:65` and `:98`, and
`tests/regression.test.ts:117`.

**RETRACTED — the discrepancy below is explained, and the explanation is that it
was a miscount.** At 339 tests the two machines agree exactly: the Mac passes
339 of 339 (`run 2026-08-04-mac-19-32k`), Windows runs the same 339 with the
four failures named above. The earlier delta came from prose in a rendered
conversation, not from either machine. Kept visible because "unexplained" is
itself a claim, and it was wrong.

*Superseded, kept for the record:* "One unexplained discrepancy, recorded rather
than smoothed over: that Mac session reported **323** tests where Windows counts
**324**. Nothing in this repository is platform-gated on purpose, so the delta is
not attributed to one — it is simply not yet explained, and anyone quoting a
total should quote its machine with it."

- **All 4 are pre-existing**, confirmed by a `git stash -u` baseline:
  `core.autocrlf=true` on Windows rewrites line endings, so three tests comparing
  `git apply` output against `\n` literals fail, plus one path-separator
  assertion in `tests/config.test.ts`.
- The fifth failure — `tests/stdio.test.ts` asserting *exactly* five tools when
  `gate` and `repair` make seven — **is fixed**. It had been masked because
  `npx vitest run` skips the build that `npm test` performs, so the assertion ran
  against a stale `dist/`. **Always verify with `npm test`, never bare
  `npx vitest run`** — and note that `gate` made the same mistake until the
  adversarial review caught it (`DECISIONS.md § v3`).
