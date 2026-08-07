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

### F9 — a credited row no window owns vanishes from every `S_o`

REACHABLE, with a concrete path, not a hypothetical:

1. A transcript holds a local `gate`/`repair` result whose payload carries no
   invocation id. Then `localResults.length > 0` and `byInvocation.size === 0`,
   so `provenanceUnavailable` is true (`report.ts:783-797`).
2. An id-bearing telemetry row is admitted through the timestamp fallback
   (`report.ts:964-970`).
3. With a later request present it becomes a **credited** row (`report.ts:1030`).
4. No local result carries that id, so it is in no observation's `mine`, and
   `UNIT-2.md` step 6 drops it before `S_o` and before either ledger.

`computeTerms` structurally cannot detect this — it is handed one observation at
a time. For a positive row this deflates R; for a signed-negative one it inflates
it. `admissionRule` 5 withholds `savedFraction` on `provenanceUnavailable`, which
protects the hold side and **not** the fall side: `R_hi+` is defined over the
full observation set, and this row is in neither `S` nor any refusal class. No
void condition detects it.

The fix is the run-level coverage invariant in **F12**, not anything `terms.ts`
can do.

### F12 — `unattributedRefusals` can double-count, and the real fix is run-level

The F1 fix below puts every unownable refused row into a second per-observation
ledger. `scopeTelemetry` admits any row within ±60,000 ms of the transcript
(`report.ts:717-734`), and `admissionRule` 5 says so by hand, so one physical row
can sit in two observations' slices and be summed twice by `rHiPlus`.

**Bounded, not solved.** `d/dF [(S+F−O)/(A+S+F)] = (A+O)/(A+S+F)² ≥ 0`, so extra
refused units move `R_hi+` **up**: duplication can turn a true fall into `open`
and can never manufacture a hold, since a hold is decided by `R_lo`, its
recomputations, the strata and `R_gate`. The residue that is not free: duplicated
units also enter `holdsIf` 5's cleanliness ceiling, so duplication can **block a
legitimate hold**.

Codex's design, recorded whole because it also closes F9: a run-level
`RunTelemetryCoverage`, deduplicated by source artifact plus line ordinal (an
`invocationId` cannot identify legacy null-id rows), holding the union of every
observation's `mine`, with an **exactly-once invariant** — every telemetry row is
either owned by exactly one observation or entered exactly once in the run-level
ledger. `rHiPlus` would consume that, and `ObservationTerms.refusals` would go
back to being a window-local diagnostic.

Out of scope for the pass that produced it: `rHiPlus`'s signature takes
`ObservationTerms[]`, `AggregateInput` has no run-level field, and the assembler
does not exist and has no spec.

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

### F13 — `R_other` has no source data at all

`UNIT-3.md:88` scores `R_other` over `fix`, `implement`, `models`, `scaffold`,
`status`. **None of those five tools writes a telemetry row.** The only
`telemetry.record` calls in the repository are `gate.ts:381` and
`repair.ts:451`/`:915`. Separately, `isLocalToolResult` (`report.ts:545-547`)
matches only `/(^|__)(gate|repair)$/`, so even a row from one of the five would
join nothing and land in `excludedForeign`.

So `R_other` is `unexercised` by construction on every run that can be produced
today, and the `Σ_d R_d + R_other = R` identity of **F11** cannot even be formed.
Two readings, and the project has to pick one: instrument the five tools, or
amend the design to say `R_other` is empty in this venue and why.

### F10 — the window join is wider than the crediting join

`windowInvocationIds` (`UNIT-2.md` step 3) collects ids from **every**
`transcript.toolResults` entry. `byInvocation` (`report.ts:783-786`) is built
from `toolResults.filter(isLocalToolResult)` — gate and repair only.

So `mine` can contain an id that `byInvocation` does not, whenever some other
tool's serialised output quotes one (transcript ids are scanned out of arbitrary
serialised results, `transcript.ts:240-252`). Two consequences, both small and
both real: an `excludedForeign` row is *practically* unownable rather than
*provably* so (see F1), and a window can claim an id that is not this server's at
all — the over-wide window `terms.ts`'s own doc warns about.

Not fixed here because it changes the four-hop join, which is the subtlest step
in the unit. The candidate fix is one filter: apply `isLocalToolResult` in step 3.

### F14 — `B12Result` cannot say what `fallsIf` requires it to say

`fallsIf` names `open — provisional` as a real state: a fall whose refusal
ledger, excluded-observation call counts or subagent strata do not clear the
conditions "is `open — provisional` and requires the A/B before it may be
recorded as a fall". `B12Result.verdict` offers `"open"` and no such member, so
the scorer collapses a provisional fall into a plain `open`.

`UNIT-3.md`'s verdict rule now refuses to fall when any stratum is unevaluable,
which is the half of this that could be fixed without a type change. The other
half — telling `open` from `open — provisional` — needs the excluded
observations' `gate`/`repair` call counts, which `AggregateInput` does carry via
`dropped[].rows`, and a new verdict member. Also unlisted: the run-level void
clause and the register of prior runs that `design.artifacts` requires on the
artifact's face.

### A stale citation in the frozen design, recorded because it cannot be fixed

`admissionRule` 5 cites `savedFraction` at `report.ts:684`. It is at
`report.ts:1098` today. The pre-registration is frozen and stays as written; this
note exists so the next reader does not follow the line number.

---

## CLOSED

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
`rHiPlus` sums both and refuses on `unsized > 0` in either. The duplication this
admits is bounded and declared in **F12**.

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
| `terms.ts` | — | — | still a stub |
| `aggregate.ts` | — | — | still a stub |

`strata.ts`'s two bodies are 34 lines; every comment, both interfaces and the
imports were already in the stub. `UNIT-1.md`'s steps 1–7 are close to executable
pseudocode, which is worth remembering when reading the one unit that closed.

**Any hand-edit to an authored body goes in a commit of its own**, separate from
the run's. `git log -p` is the only thing that keeps "what the local model wrote"
legible once a human has touched the file.

## Seven assertions that are not yet controls

The scorer-correctness pass added five assertions to `tests/b12-aggregate.test.ts`
and two to `tests/b12-terms.test.ts`. Both files test stubs, so **every one of
them fails on `not implemented` whether it is right or wrong** — they have never
been executed against any implementation. Their constants were derived by hand
and their API shape is pinned by `tsc`; nothing else about them has been checked,
and each is marked `UNPROVED CONTROL` in the file.

They must be re-checked the day a body lands, by breaking that body deliberately
and watching each one fail for its own reason. Until then they are specifications
in test syntax, not evidence.
