# B12 scorer — open findings

Defects in the scorer's **specs and bodies**, not in the harness that measures
whether `repair` can author them. Kept here because the fix for each one moves a
spec, an oracle and a body together, and because a finding that lives only in a
conversation is a finding that gets rediscovered.

F1–F5 came from a Codex adversarial review on 2026-08-06, each verified by three
independent agents (factual / impact / adversarial-refuter, the refuter told to
default to REFUTED absent positive evidence); all 15 confirmed. F6–F8 were found
afterwards. **F9–F14 came from a second Codex adjudication on 2026-08-07**, run
as gate 1 of the scorer-correctness pass; every mechanism below was re-checked
against the files before being written down, and two of Codex's claims were
sharpened in the process rather than copied.

**None of these is a reachability blocker.** The three units' oracles pass green
on all of them, which is exactly why they need writing down: an oracle that
cannot fail on a defect is not evidence the defect is absent.

---

## OPEN

### F19 — the hold arithmetic includes observations the admission rule excludes from it

Found by the F14 adjudication on 2026-08-07 and **deliberately not fixed in that
pass**, because it changes `R_lo` and `R_hi` themselves and every figure derived
from them.

`admissionRule` 6: "An observation with `ambiguous > 0` is admitted to the FALL
arithmetic only, at both bounds, and **excluded from the HOLD arithmetic**.
Crediting an unowned saving toward a hold is the double-count the refusal exists
to prevent." `aggregate` passes the whole admitted set to `poolRatio`,
`strataCells`, `deliveryScore` and `recompute` alike, so an observation with a
non-zero `ambiguous` count is in the hold figures the rule keeps it out of.

**The direction is conservative, which is why shipping the hold branch ahead of
this fix is safe.** Such an observation carries its full `A_o` while its ambiguous
rows are refused rather than credited, so its `S_o` is deflated relative to what
it would otherwise be — it drags `R_lo` DOWN, making a hold harder rather than
easier. That is the safe error on the hold side, and `holding (unvalidated)` "may
not be cited as an input to opening or closing any gate" in any case. It is not
guaranteed for every conceivable observation, only for one whose refused ambiguous
rows carry positive magnitude — the ordinary case, and the same qualification F1
had to be corrected to make.

The fix is a partition: `poolRatio` and everything hold-side over
`admitted.filter(t => t.refusals.ambiguous.count === 0)`, while `rHiPlus` keeps
the full set. It needs its own controls, because every hold-side figure moves.

### F17 — the frozen preflight screens for none of `R_hi⁺`'s new refusals

Raised by the second adjudication on 2026-08-07, against a claim I had made and
could not support: that a clean run trips none of the five conditions F9 and F12
added to `rHiPlus`.

`design.artifacts` fixes what the preflight asserts — `provenanceUnavailable ===
false`, `ambiguous === 0`, `unmatched === 0`, `excludedForeign === 0`,
`savedFraction !== null`, non-zero snapshot counts. It asserts **nothing** about
`unverifiable`, about unique window ownership, about credited rows no window
owns, about slices disagreeing, or about full slice coverage. And
`savedFraction !== null` excludes only `provenanceUnavailable` and `ambiguous`;
`report.ts:1240` deliberately does not withhold it for `unverifiable`.

So a run can pass its ten-minute preflight and still return `open` at scoring
time on a condition the preflight never looked at. **That is the safe direction**
— `open`, never a wrong fall — but it is a cost, and it is registered here rather
than discovered on the day it happens. The preflight is a frozen artifact and is
not amended; see F11 for the rule.

### F11 — `Σ_d R_d + R_other = R` is false, and the oracle hides it

The frozen design asserts the identity and `B12Result.identityHolds` says
"compute it; do not assume it". Computing it gives `false` on every real run:

```
Σ_d R_d = S / (A + S)        R = (S − O) / (A + S)        difference = O / (A + S)
```

`O` is non-zero by design — `holdsIf` 6 requires `unitsAddedByInstallation`
computed for every observation. `tests/b12-aggregate.test.ts`'s identity fixture
passes only because every `terms()` in it leaves `oO` at 0.

Fixing it is a **design decision, not an implementation one**: the installation
term has to be allocated across deliveries, or published as its own
`R_installation`, and the frozen design says neither. `UNIT-3.md` now instructs
the implementer to build the common denominator and let `identityHolds` come out
false rather than to force the identity.

**DECIDED 2026-08-07: implement to the instruction; do not amend.** B20's rule
lets the INSTRUMENT's implementation be repaired until the first scored
observation — it does not license changing the ESTIMAND, which is what
reallocating `O` would be, however early. `B12Result` carries `identityHolds` as
a boolean because the design's author allowed it to be false; forcing it true
deletes the evidence. The reading is pre-declared in `PREMISES.md § B12` so it is
not later mistaken for a measurement. A coherent per-delivery decomposition needs
a newly pre-registered premise.

### F13 — `R_other` has no source data at all

`UNIT-3.md:88` scores `R_other` over `fix`, `implement`, `models`, `scaffold`,
`status`. **None of those five tools writes a telemetry row.** The only
`telemetry.record` calls in the repository are `gate.ts:381` and
`repair.ts:451`/`:915`. Separately, `isLocalToolResult` (`report.ts:545-547`)
matches only `/(^|__)(gate|repair)$/`, so even a row from one of the five would
join nothing and land in `excludedForeign`.

So `R_other` is `unexercised` by construction on every run that can be produced
today, and the `Σ_d R_d + R_other = R` identity of **F11** cannot even be formed.

**DECIDED 2026-08-07: publish `unexercised` and declare it in advance.** Neither
of the two alternatives survives. Amending the design changes the estimand (see
F11). Instrumenting the five tools is a design change wearing an implementation's
clothes — it would CREATE data the experiment assumed already existed — and it
would not close F11 anyway, since the missing `O/(A+S)` is untouched by it.
`unexercised` is the design's own state for a delivery nobody exercised, and it
is neither a hold nor a fall.

### A stale citation in the frozen design, recorded because it cannot be fixed

`admissionRule` 5 cites `savedFraction` at `report.ts:684`. It is at
`report.ts:1098` today. The pre-registration is frozen and stays as written; this
note exists so the next reader does not follow the line number.

---

## CLOSED

### F14 — `B12Result` could say two of the six verdicts the design defines — FIXED

`fallsIf` names `open — provisional` as a real state and `B12Result.verdict` had
no such member, so a provisional fall was published as a plain `open`. That was
the finding as recorded. **The adjudication found it was the smaller half.** The
verdict function returned `"fallen"` or `"open"` and nothing else: it checked no
observation count, no rate basis, no selection guard, no recomputation, no
register — six frozen VOID clauses it had the data for — and it collapsed
`holding (unvalidated)` into `open` as well.

**Fixed** with the ordered rule in `UNIT-3.md`: six voids, each naming its clause
on the artifact, then the two `open` states the frozen text settles, then the
fall, then the hold. `B12Result` gains `voidClause`, `selection`, `priorRuns`,
`voidedRuns` and `abandonedRuns`; `AggregateInput` gains a REQUIRED `priorRuns`,
because `voidConditions` 1 makes omitting the register itself a VOID and an
optional field would be indistinguishable from a first run.

**Two clauses of the frozen text contradict themselves, and both are settled by
quotation rather than by preference.**

- `voidConditions` 15 opens "VOID if any refused magnitude is null and R_hi+ was
  therefore not evaluable" and ends "the run returns `open`, never a fall", while
  `fallsIf` says `open — provisional`. `design.metric` settles it in words: "If
  any refused magnitude is `null`, `R_hi⁺` is NOT EVALUABLE and **the run returns
  `open`**." Two of the three name `open`, and it is the only reading that does
  not spend an irreplaceable attempt (`voidConditions` 23) on an ambiguity.
- `voidConditions` 3 does the same to an undersized stratum, and `admissionRule`
  8 settles it outright: it "returns `open`, never a hold, a fall, **or a void**."

**Two shapes carry a rule instead of checking it.** `PriorResult` makes a prior
run state `scored` or name its void clause, and carry its bracket either way, so
clause 1's three requirements cannot be satisfied separately. `AttemptCost` makes
"did not consume an attempt" unrepresentable without naming which of clause 23's
three enumerated vendor-side causes it was — "every other void is an attempt, or
the fall condition can be dodged indefinitely by voiding until a clean set lands
on the preferred side".

**And the F9 hold-side guard turned out to be subsumed rather than owed.** It was
registered during the F9 fix as owed to whoever wrote a hold branch. Written as a
conjunct of the hold it can never decide anything, because `rHiPlus` refuses on
that exact fact and the run has already returned `open`. Established by planting
the defect: deleting the conjunct changed no test. Removed and explained, on the
same rule that retired step 1b — a guard that cannot fail is not a guard.

### F10 — the window join was wider than the crediting join — FIXED

`windowInvocationIds` collected ids from **every** `transcript.toolResults` entry.
`byInvocation` (`report.ts:894-898`) is built from
`toolResults.filter(isLocalToolResult)` — gate and repair only.

Transcript ids are scanned out of arbitrary serialised output, so a result that
merely QUOTES an id put it into `mine` while `byInvocation` had never held it.
Two consequences, both small and both real: an `excludedForeign` row was
*practically* unownable rather than *provably* so (F1's corrected residue), and a
window could claim an id that is not this server's at all — the over-wide window
`terms.ts`'s own header warns about.

**Fixed** by exporting `isLocalToolResult` and applying it as the FIRST hop of the
join, which is now five and was documented as four. One predicate in one place:
the alternative is a second copy of the rule in the module that has to agree with
it. `mine ⊆ byInvocation.keys()` on every input afterwards, which is exactly what
makes `excludedForeign` provably unownable.

Seen failing: an owned request calls `Read`, whose result quotes an invocation id.
Without the filter the window claims two ids where it owns one.

**One overstatement corrected in the process.** This entry said a `Read` of
`.local-coder/telemetry.jsonl` would mark "every id in the project's whole
history" as this session's, and `report.ts` said the same. `readInvocationId`
runs a single non-global `exec` and returns the FIRST match
(`transcript.ts:248-252`), so a quotation injects ONE id per result. That is still
enough to misattribute a saving; it is not the whole history.

### F12 — `unattributedRefusals` double-counted, and the fix had to be run-level — FIXED

`scopeTelemetry` admits a row on an exact invocation-id match **or** on a
±60,000 ms window (`report.ts:828-846`), and `admissionRule` 5 names that window
by hand, so one physical row sits in two observations' slices whenever two arms
ran within a minute. `rHiPlus` summed each observation's `unattributedRefusals`,
so that row was counted twice.

**The direction follows the sign.** `d/dF [(S+F−O)/(A+S+F)] = (A+O)/(A+S+F)² ≥ 0`,
and `F` can be negative because `wouldHaveAdded` is signed — a row whose returned
bytes exceed its capped raw bytes has a negative magnitude, and this project has
measured whole tools net negative. Positive duplication moved `R_hi⁺` up, which
is safe; **negative duplication moved it down and manufactured a fall.**

**Fixed** by `src/cost/b12/coverage.ts` (UNIT 4): row identity is
`JSON.stringify([artifact, ordinal])`, stamped by `identify` at read time,
because `TelemetryRecord` carries nothing that survives a null `invocation_id`.
`ObservationTerms.rows` and the new `ObservationTerms.unattributed` are keyed;
`runCoverage(universe, all)` resolves every physical row once; `rHiPlus` reads
owned refusals per observation and unowned ones from the run ledger.

**Step 1b is retired with the sum it guarded.** It refused on a negative
unattributed class sum and this file declared it incomplete the day it landed —
a class sum of zero hides a +100 and a −100. A guard standing over a quantity
nothing computes any more reads as protection while providing none.
`unattributedRefusals` survives as a per-window diagnostic that no figure sums.

**Two corrections from the adjudication, both adopted:**

- **`runCoverage` cannot take `ObservationTerms[]` alone.** `computeTerms`
  receives a slice `scopeTelemetry` has already narrowed, so a row outside every
  window is absent from every observation and invisible to a coverage built from
  them. The run's full identified row set is an argument, and `unsliced` is the
  state for a row the run produced that no window saw.
- **"Exactly one distinct non-null value" was too weak.** One number beside one
  `null` counted as agreement and discarded the unknown. Every occurrence must be
  sized AND equal, or the row is `unsized`.

Two slices can also disagree about what a row IS — `credited` in one transcript
and `excludedForeign` in another (`report.ts:1081-1107`). `unverifiable` and
`ambiguous` cannot vary that way; the other three can. No frozen class means "the
transcripts disagree", so such a row is unsized and carries a `conflict` string.
It needs no refusal rule of its own: every reachable disagreement either contains
`credited`, which trips F9's condition, or contains `unmatched`, which is unsized
by construction.

### F9 — a credited row no window owns vanished from every `S_o` — FIXED

REACHABLE, with a concrete path, not a hypothetical:

1. A transcript holds a local `gate`/`repair` result whose payload carries no
   invocation id. Then `localResults.length > 0` and `byInvocation.size === 0`,
   so `provenanceUnavailable` is true (`report.ts:908`).
2. An id-bearing telemetry row is admitted through the timestamp fallback
   (`report.ts:1100-1107`).
3. With a later request present it becomes a **credited** row.
4. No local result carries that id, so it is in no observation's `mine`, and
   `computeTerms` dropped it before `S_o` and before every refusal class.

`computeTerms` structurally cannot detect this — it is handed one observation at
a time, which is why the fix is UNIT 4's and not UNIT 2's.

**Fixed by REPORTING AND REFUSING, not by crediting.** `design.metric` defines
`S_o` over "`o`'s credited rows" and limits `R_hi⁺`'s additions to the four
refusal classes, so adding such a row to the numerator would amend the ESTIMAND —
which B20's repair rule does not license, on the same reading that decided F11 and
F13. `coverage.unattributedCredited` publishes the count and the size, and
`rHiPlus` returns `open`.

**The refusal is unconditional, not sign-aware, and the first draft had that
wrong.** Omitting a credited magnitude `U` moves the figure by
`U(A+O) / (D(D+U))` with `D = A + S + refused`, so "a negative `U` is the safe
direction" needs `D > 0` and `D + U > 0` — and `rHiPlus` checks only
`denominator === 0`.

**And the hold side is NOT protected by omission, which is the other thing I had
backwards.** "Omission deflates the hold, which is the safe direction" is false
as written: magnitudes are signed, so an omitted NEGATIVE credited row RAISES
`R_lo` and `R_hi`, toward a hold. `verdictOf` has no hold branch today, so there
is nothing to guard yet; the requirement is written into `UNIT-3.md`'s verdict
rule and into `aggregate.ts` beside the function, for whoever writes it.

### F1 — two of the four refusal classes could never be populated — FIXED

`UNIT-2.md` step 6 kept only rows whose `invocationId` was non-null and in
`mine`; step 10 built the four-class ledger from those.

- **`unverifiable` is structurally unownable.** The class exists precisely
  because `entry.invocation_id === undefined` (`report.ts:927`), so `refusedRow`
  gives it `invocationId: null` (`report.ts:885`) and step 6 dropped every one.
- **`excludedForeign` is empty on every normal input, but not provably so.** The
  class exists because the id is absent from `byInvocation` — and `mine` is built
  from a *wider* set of tool results than `byInvocation` is, so the two are not
  exact complements. **Corrected from "structurally empty"** after the gate-1
  adjudication; the residue is **F10**.
- **The direction was overstated too.** `wouldHaveAdded` is signed
  (`report.ts:868`), so omitting a refusal deflates `R_hi+` when its magnitude is
  positive — the ordinary case — and inflates it when negative. "Deflated by
  construction" was too strong; "deflated on any run whose refused magnitudes are
  positive" is what the code supports.

`rHiPlus` is defined over all four classes (`design.metric`), so the fall-side
figure was short by two of them.

**Fixed** by a second ledger, `ObservationTerms.unattributedRefusals`, holding
every refused row in the slice whose `invocationId` is null or not in `mine`.
`rHiPlus` summed both and refused on `unsized > 0` in either.

**Superseded 2026-08-07 by F12's fix, and this paragraph used to end here.** That
shape double-counted every row two slices share, so the second ledger is now a
per-window diagnostic nothing sums: the unowned rows are carried INDIVIDUALLY in
`ObservationTerms.unattributed`, deduplicated by row identity in `runCoverage`,
and `rHiPlus` reads the run-level result. The fix to F1 stands — the fall-side
figure was short by two classes and no longer is — but the route it took to get
there did not.

### F2a — `MIN_REPAIR_CLOSURES` was not implementable from the declared types — FIXED

`UNIT-3.md:87` passed the constant and nothing carried `passed`.

**Fixed** with `CreditedRow.passed: boolean | null` read from `entry.detail.passed`
only when it is a boolean, plus required `DeliveryTerms.closures` and
`closureUnknown`. **Absent is `null`, never `false`** — `repair`'s abort path
(`repair.ts:458`) writes a detail with no verdict, rows predating the field exist
on disk, and a string is not a verdict. The floor counts **observations** with
`closures > 0`, which is how `holdsIf` words it ("≥ 5 admitted observations carry
a `repair` row AND at least two of THOSE carry `passed: true`"), so several
closures inside one observation still contribute one.

An unknown deflates the count and pushes toward `unexercised`, which is neither a
hold nor a fall — the safe direction, now stated in the type rather than implied.

### F2b — `rLoMinusRow` dropped the row that dominates the OTHER figure — FIXED

`units` is `(capped / charsPerToken) * multiplier` (`report.ts:1046`) — exactly
`sHi`'s contribution — and `UNIT-3.md` ranked both jackknives by it. `holdsIf` 2
asks a hold to survive deleting "**its** best row", per figure.

`aggregate.ts` could not compute the low side at all: `AggregateInput` carries no
`rates`, and a row exposed `capped`, `ttl`, `rateKey` and the realised **high**
multiplier but not the write component.

**Fixed** with `CreditedRow.unitsLo`, computed in `report.ts` beside `units` on
both the credited and the refused path, `null` exactly when `units` is `null`.
`wouldHaveAdded` returns both horizons for that reason: `unitsLo: null` on a row
whose `units` is a number would have given `null` a second meaning on a field
whose whole contract is that it means one thing.

**Accepted side effect, registered:** `UNIT-2.md` step 7 collapses to
`sLo += row.unitsLo` / `sHi += row.units`, which removes `multipliersFor` from
the unit — the import F6 was fixed for. One rule in one place is the discipline
`report.ts` states about itself. F6's lesson survives at half strength: `rateKey`
still comes from `../rates.js` at step 13.

### F3 — an unrecognised `verificationStratum` vanished with no trace — FIXED

`strata.ts:77-81` was `if` / `else if` with no `else`. **And the field is not
merely unvalidated — nothing writes it.** `scripts/b12-run.mjs` emits no
`verificationStratum` into `observation.json`, so it reaches the scorer through a
manifest join that has not been built, and three places in the repository claimed
it was "read off the observation".

**Fixed** with a sixth `unknownStratum` bucket, the comparison widened to
`const declared: string` so `tsc` allows the branch, and `strataCells` refusing
**both** declared cells while it is non-empty. Not a throw: `aggregate()` owes an
artifact "whether it scores or voids".

**Plus the amendment gate 1 raised, confirmed against `fallsIf`:** `"fallen"` now
additionally requires all four strata cells evaluable. The frozen text says it
twice — a fall stands unappealed only if "both subagent strata are evaluable",
and "any stratum below 5 is VOID or `open` — never a fall on a short set".
Without it the F3 fix would have produced unevaluable cells that nothing read.

`unknownStratum` is deliberately **not** treated like `unevaluableShare`: a
window that originated no billed request belongs to neither `solo` nor `multi`
and deflates neither, while an observation with a corrupt stratum belongs to one
of the two declared cells and nobody can say which.

### F16 — no file under `tests/` was type-checked by anything — FIXED

`tsconfig.json` is `"include": ["src/**/*.ts"]`, and vitest transpiles without
checking. So every oracle, every fixture and every helper in this repository is
**unchecked TypeScript**: a fixture that stops matching its type, an assertion
against a field that no longer exists, a factory missing a newly required
property — none of it is caught until an assertion happens to read the value, and
often not then.

The repository already knew and wrote it down twice — `src/contract-probe.ts`'s
header and `src/cost/b12/types.ts`'s — as the reason those files live in `src/`.
It was not carried into the test tree's own claims: several comments added by the
scorer-correctness pass said an oracle's "API shape is pinned by `tsc`", which is
false. Corrected.

**Measured before proposing anything:** compiling `src/**` and `tests/**` under
the existing `strict` settings produces **14 errors across 3 files** —
`repair.test.ts` (12, all union access without narrowing: `ToolError |
RepairResult` and `RepairDeps | undefined`), `helpers.ts` (1, a missing DOM lib
name), `cost-meter.test.ts` (1, no declarations for `scripts/b12-run.mjs`). None
is a real type mismatch, and **none is in the b12 oracles or fixtures**.

**Fixed by swapping which config is which, rather than by adding a third.**
`tsconfig.json` is now the CHECKING config — `src/**` plus `tests/**`,
`noEmit` — and emitting moved to `tsconfig.build.json`, whose `include` stays
narrow so `dist/` and the published package never carry the tests. That was the
only shape that needed no change to `gate`: its autodetection hardcodes
`tsc -p tsconfig.json --noEmit` (`src/checks/config.ts:165`), and so does
`scripts/b12-preflight-mac.sh`, and so does every editor. A `tsconfig.tests.json`
that nothing invoked would have been the same hole with a config file in front
of it.

The 14: `NonNullable<Parameters<typeof runRepair>[2]>` for five `fetchImpl`
casts; a `rejectionOf` helper narrowing `RepairResult | ToolError` at three sites
that were reading `.message` off the union and would have read `undefined` the
day the call stopped rejecting; `Parameters<FetchLike>[0]` for a `RequestInfo`
that is a DOM name under `lib: ["ES2022"]`; and `scripts/b12-run.d.mts` for the
one harness function a test calls.

Seen failing: `billedRequestCount: "one"` in `tests/b12-fixtures.ts` now gives
`TS2322` from the gate. **`scripts/**` is still unchecked** — deliberately, and
`contract-probe.ts` and `contract-stability.ts` say so in their headers, which
were corrected here along with six other comments that named the old scope.

### F15 — `CreditedRow`'s null invariant was not encoded, so `?? 0` passed everything — FIXED

`units` and `unitsLo` were `number | null` on a flat interface, so
`disposition === "credited"` narrowed neither and `row.unitsLo ?? 0` compiled,
passed every oracle in the repository, and committed the exact
unknown-summed-as-zero collapse this scorer forbids everywhere else. The
invariant lived in a doc comment, and a doc comment cannot stop an implementer.

**Fixed** by making `CreditedRow` a union discriminated on `disposition`:
`CreditedLedgerRow` has `units`, `unitsLo` and every positional field as
non-null; `RefusedLedgerRow` keeps them nullable and `units`/`unitsLo` null
together. `UNIT-2.md` step 7 now says to narrow on the disposition instead of
prescribing a throw — the compiler does the work the throw was standing in for.
The positional fields came along for free: "null on a refusal" is now a type
rather than a paragraph.

**The control is two `Assert` type aliases beside the union, in `src/`** — where
it had to be when the union landed, because `tests/` was read by no compiler
then (**F16**, fixed since). It stays beside the type it constrains rather than
in a file that imports it. Seen failing: widening `CreditedLedgerRow["units"]` gives
`TS2344: Type 'false' does not satisfy the constraint 'true'`. A runtime half
sits in `cost-meter.test.ts`, summing a real `buildCounterfactual`'s credited
rows at both horizons with no coalescing anywhere.

### F8 — the unit headers were swapped — FIXED

`strata.ts` said "UNIT 2" and is UNIT 1; `terms.ts` said "UNIT 1" and is UNIT 2.
Recorded here as one file; it was two. `aggregate.ts` was correct.

### F6 — `UNIT-2.md`'s only worked example taught the wrong module — FIXED

`UNIT-2.md` named six functions living outside the unit and gave the module for
exactly one — `positionalMultiplier` "from `../report.js`" — which is right for
three of them and wrong for `multipliersFor` and `rateKey`, both in `../rates.js`
and imported-not-re-exported by `report.ts`. The spec was not silent; it taught
an answer correct in the only case it demonstrated.

Not hypothetical: exposure B's `terms` call 2 imported `multipliersFor` from
`../report.js`, took `TS2459`, and round 3 timed out. Call 1 dodged it by using
`rates.multipliers` directly and reimplementing `rateKey` inline — two
workarounds for one spec defect, in one exposure.

**Fixed** with an explicit import block plus the module at each call site. F2b
later removed `multipliersFor` from the unit entirely; `rateKey` remains.

### F7 — `budget_seconds` was an unregistered parameter truncating a registered one — FIXED

`repair`'s default budget is 300 s. `aggregate`'s rounds cost 106–132 s because
it writes ~3,400 completion tokens against `terms`' ~1,700, so the registered
`max_rounds: 3` was delivered as **two** productive rounds for that unit, at any
window. Three units of one exposure were measured against different effective
conditions.

Raising the budget alone would have traded a truncation for a starvation: the
per-request timeout is `min(config.timeoutMs, remaining)` (`shared.ts:547`), so
at 600/600 one slow round can be issued with the whole budget. The longest
LEGITIMATE round observed is **132 s** — corrected from 149 s, which carries
`attempts: 0` and "LM Studio request timed out after 148755 ms"; the 256 s round
was the backend returning HTTP 400.

**Fixed** as `TIMEOUT_MS=180000` / `BUDGET_SECONDS=600` / `MAX_ROUNDS=3`, and —
because both travel through a prompt as optional arguments with defaults —
recorded in `detail.budget_seconds` / `detail.max_rounds` as **resolved** values
and checked per repair row. A session that drops one is a `limits-mismatch` VOID;
a row predating the fields is `limits-unverifiable`, never a pass.

Do not re-run a unit that already has an observation to give it the rounds it
should have had — that is a second draw at the same bar.

### F4 — a unit's state came from the vitest exit code alone — FIXED `f6926b4`

`repair`'s own `passed` was never read, so "the model ran and failed" and "the
model never ran" were the same `red`. Worse, the scorer commits the bodies it
produces while the fresh-exposure guard only refused on **uncommitted** ones, so
a later run on a clean tree could inherit all three through `already-green` and
print `R_repair reachable (>= 2 of 3)` with zero `repair` calls.

Now a per-unit telemetry window and a closed list of six states, of which only
`closed` counts; the guard compares each attempted unit against its stub at a
pinned commit. Exercised by `scripts/b12-scorer-selftest.sh`, which extracts both
decision points verbatim and replays exposure B's real slice.

### F5 — the exposure's central VOID was a check that could not fail — FIXED `ee7defb`

Exposure B pre-registered "VOID if `report.ts` was not actually in the context —
checked against the telemetry's own `detail.files`/`context_files`".
`detail.context_files` did not exist, and `detail.files` is the diff's changed
list — editable files only, structurally incapable of holding a read-only context
file.

Now reported on a `ToolDeps` callback off the **loaded** files, never off the
argument, and verified per repair row by the scorer. First observed rather than
declared in `run 2026-08-07-mac-b12-phase3-c40e9f4`.

---

## Review status of the authored bodies

| unit | authored by | reviewed | verdict |
|---|---|---|---|
| `strata.ts` | local model, `c40e9f4` | 2026-08-07 | **accepted**; correct against `UNIT-1.md` step for step. F3 fixed here by hand. |
| `terms.ts` | orchestrator, 2026-08-07 | — | implemented after Phase 3 closed |
| `aggregate.ts` | orchestrator, 2026-08-07 | — | implemented after Phase 3 closed |
| `coverage.ts` | orchestrator, 2026-08-07 | — | UNIT 4, written for F12/F9, never part of the exposure |

`terms.ts` and `aggregate.ts` stopped being measured work when Phase 3 closed at
1 of 3. `repair` never closed either of them and gets no further draw.

`strata.ts`'s two bodies are 34 lines; every comment, both interfaces and the
imports were already in the stub. `UNIT-1.md`'s steps 1–7 are close to executable
pseudocode, which is worth remembering when reading the one unit that closed.

**Any hand-edit to an authored body goes in a commit of its own**, separate from
the run's. `git log -p` is the only thing that keeps "what the local model wrote"
legible once a human has touched the file.

## Nine assertions, now proved as controls

The scorer-correctness pass added seven assertions to
`tests/b12-aggregate.test.ts` and two to `tests/b12-terms.test.ts`. They were
written against stubs, so every one of them failed on `not implemented` whether
it was right or wrong, and each carried an `UNPROVED CONTROL` marking saying so.

**Re-checked 2026-08-07, the day the bodies landed**, in three groups of three
defects planted in three different functions so attribution stayed clean. All
nine fired, each for its own reason and no other:

| assertion | defect planted | what fired |
|---|---|---|
| both ledgers in `R_hi+` | sum only `refusals` | 110/1110 against 160/1160 |
| unsized in EITHER ledger | check only `refusals` | evaluable, should refuse |
| negative unattributed magnitude | drop the guard | evaluable, should refuse |
| per-horizon row jackknife | rank the low side by `units` | 70/270 against 60/260 |
| both cells on a corrupt stratum | drop the rule | cells stayed evaluable |
| closures per OBSERVATION | count closure rows | scored, should be `unexercised` |
| `identityHolds` false on `O ≠ 0` | compare against `S` | true, should be false |
| the second ledger in `computeTerms` | file everything as owned | unattributed count 0 |
| `closureUnknown` on `null` only | treat `!== true` as unknown | counted a red repair |

**Three of them were defective when written, which is the argument for the
re-check rather than against it.** `strataCells`'s `typesOnly` arm was satisfied
by the 5-observation floor with an empty cell, so it passed on the defect it was
aimed at. The closure floor gave every fixture `closures` of 0 or 1, where
summing rows and counting observations agree. The closure test supplied only
`true` and `null`, so `passed !== true` satisfied both arms while merging a
repair that ran and failed with one that could not say. All three were fixed
before the bodies existed; **three defects in seven assertions is the rate to
expect from assertions nobody has watched fail.**

**A fourth defect surfaced on first execution, in the FIXTURE rather than in an
assertion.** `withToolUse` overrode `message` wholesale and dropped the
`cache_creation` split, so the transcript parser priced that request's write at
the 5-minute TTL — its documented conservative guess — while `req`'s own comment
promises 1h at 2.0x. Every constant hand-derived from that promise was 75 units
out on a 100-token write, and `A_o` came back 5725 against 5800. A fixture that
contradicts its own stated intent is invisible until something executes it.

## Twenty-two more, for F12 and F9

The F12/F9 pass added twenty-two assertions across `b12-coverage.test.ts` (new),
`b12-aggregate.test.ts`, `b12-terms.test.ts` and `cost-meter.test.ts`. **All
twenty-two passed on first execution, which is the state that says nothing.**
Each was then checked against a planted defect, in six groups of at most one
defect per function so attribution stayed clean:

| defect planted | in | what fired |
|---|---|---|
| drop the `unmatched` row push | `buildCounterfactual` | rows 4 for 5 telemetry entries |
| key as `${source}#${ordinal}` | `identify` | the encoding test, and the key on a priced row |
| never push to `unattributed` | `computeTerms` | the unowned rows came back empty |
| pair every row with `telemetry[0]` | `computeTerms` | two rows keyed ordinal 0 |
| sum only the owned refusals | `rHiPlus` | 110/1110 against 160/1160, and 200/2200 |
| one `CoveredRow` per occurrence | `runCoverage` | −600/1400 against −200/1800 |
| report a generic reason | `rHiPlus` | the artifact stopped carrying the cause |
| assign a contested key to its first claimant | `runCoverage` | contested came back empty |
| filter the nulls before the sizing check | `resolve` | 400 where the answer is unknown |
| drop the price-spread check | `resolve` | 400 chosen out of 400 and 900 |
| drop the disposition-disagreement check | `resolve` | 400 on a row nobody can class |
| drop the F9 reason | `runCoverage` | a credited orphan scored |
| drop the `unsliced` reason | `runCoverage` | a row nobody saw scored |
| drop the unsized-unowned reasons | `runCoverage` | an unknown summed as zero |
| take ownership out of the claims map | `runCoverage` | an owned row entered the run ledger |
| remove the sort in `resolve` | `resolve` | two callers, two different ledgers |

**Two fired on numbers written into the comments before any body existed** —
`110/1110` for the owned-only sum and `−600/1400` for the twice-counted row —
which is the only form of prediction this file counts.

**One assertion of the twenty-two could not be proved by its own defect and is
marked as such:** `rows[0].key` on a priced row fired under the ENCODING defect
but not under "always pair with index 0", because index 0's key is correct for
row 0 either way. The index rule is proved by the `unattributed` assertion beside
it, which fired on exactly that defect.
