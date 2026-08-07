# B12 scorer — open findings

Defects in the scorer's **specs and bodies**, not in the harness that measures
whether `repair` can author them. Kept here because the fix for each one moves a
spec, an oracle and a body together, and because a finding that lives only in a
conversation is a finding that gets rediscovered.

F1–F5 came from a Codex adversarial review on 2026-08-06, each verified by three
independent agents (factual / impact / adversarial-refuter, the refuter told to
default to REFUTED absent positive evidence); all 15 confirmed. F6–F8 were found
afterwards and are attributed where they were found. Every mechanism below was
re-checked against the files before being written down.

**None of these is a reachability blocker.** The three units' oracles pass green
on all of them, which is exactly why they need writing down: an oracle that
cannot fail on a defect is not evidence the defect is absent.

---

## OPEN

### F1 — two of the four refusal classes can never be populated

`UNIT-2.md` step 6 keeps only rows "whose `invocationId` is non-null and in
`mine`". Step 10 then builds `refusals` **from the kept rows**.

- `unverifiable` rows exist precisely because `entry.invocation_id === undefined`
  (`report.ts:927-929`). Their `invocationId` is null, so step 6 drops every one.
- `excludedForeign` rows carry an invocation id that belongs to another window —
  that is what makes them foreign — so `in mine` drops every one of those too.

`RefusalLedger`'s own type says "Fewer than four is not a ledger"
(`types.ts:84-90`), and `rHiPlus` is defined as granting every refused row its
would-have magnitude **across all four classes**, refusing to evaluate when any
is unsized (`types.ts:192-198`). With two classes structurally empty, `rHiPlus`
can never refuse on them and never receives their magnitude. **The fall-side
figure is deflated toward the 15% fall line by construction**, and the one
mechanism that exists to stop a fall on a deflated instrument cannot fire.

`report.ts:951-957` already records that shipping `excludedForeign` without its
magnitude was a defect, and it was fixed there. The spec then re-introduced it at
a different layer.

### F2a — `MIN_REPAIR_CLOSURES` is not implementable from the declared types

`UNIT-3.md:87` calls `deliveryScore(admitted, ["repair"], "lo",
MIN_REPAIR_CLOSURES)`, where the fourth argument is a minimum number of rows with
`passed: true`. **Neither `CreditedRow` (`report.ts:411-433`) nor
`ObservationTerms` (`types.ts:133-156`) carries `passed` in any form.**

The guard is load-bearing, not decorative: `types.ts:161-166` states that
`turns_collapsed` is `rounds.length` whether or not the failure closed, so an
unconditioned `R_repair` "is maximised by `repair` flailing for its full budget
and returning red" — which is very close to what exposure B and its completion
actually observed. The guard that would catch it cannot be written.

### F2b — `rLoMinusRow` drops the row that dominates the OTHER figure

`UNIT-3.md:67-69` says to find "the row with the greatest `units` across all
observations" and subtract its contribution from `sLo` and `sHi`.

For a credited row, `units` is `(capped / charsPerToken) * multiplier`
(`report.ts:1046`) — which is **exactly** `sHi`'s contribution as `UNIT-2.md`
step 7 defines it. `sLo` uses `writeComponent` instead of `multiplier`. So the
selection is correct for `rHiMinusRow` and wrong for `rLoMinusRow`: the low-side
concentration guard drops whichever row dominates the **high** side.

This one is implementable — every field needed is on `CreditedRow` — it just
computes a guard about a different figure than the one it reports. Narrower than
F2a, and unlike F2a it produces a number, which is worse: a wrong guard reads as
a passed guard.

### F3 — an unrecognised `verificationStratum` vanishes with no trace

`strata.ts:77-81` is `if` / `else if` with no `else`. `verificationStratum` is
documented as read from `evidence/<runId>/obs-<taskId>-<arm>/observation.json`
(`types.ts:50-53`), it is typed as a two-value union, and **no validator for it
exists anywhere in the repository** — the reader that will parse that JSON has
not been written yet.

A manifest typo (`"test_red"`) therefore puts that observation in NEITHER
`testRed` nor `typesOnly`, silently, while it still counts in `solo`/`multi`.
`holdsIf` 3 requires all four cells evaluable; an observation that evaporates
from one family deflates a cell's count with nothing recording that it did.

**Found reviewing `strata.ts` on 2026-08-07. It is a defect in `UNIT-1.md`, not
in what the local model wrote** — the spec says "split on
`t.verificationStratum`" and says nothing about validation, and the body follows
the spec exactly. Fix the spec, the oracle and the body together.

### F6 — `UNIT-2.md` names two functions without their module

Step 7 names `multipliersFor(rates, row.rateKey)` and step 13 names
`rateKey(request.model, request.speed)` with no module, in a document whose
preamble does say "`positionalMultiplier(t, T, m, ttl)` **from `../report.js`**".
Both live in `src/cost/rates.ts`; `report.ts:1` imports them and does not
re-export.

This is not hypothetical. Exposure B's `terms` call 2 imported `multipliersFor`
from `../report.js`, took `TS2459`, and round 3 timed out. Call 1 dodged it by
using `rates.multipliers` directly and reimplementing `rateKey` inline.

### F7 — `budget_seconds` is an unregistered parameter that truncates a registered one

`repair`'s default budget is 300 s. `aggregate`'s rounds cost 106–132 s because
it writes ~3,400 completion tokens, twice `terms`' ~1,700 — so the `max_rounds:
3` the Phase-3 prompt registers is delivered as **two** productive rounds for
that unit, at any window. Both calls of `run 2026-08-07-mac-b12-phase3-c40e9f4`
stopped on `budget` with round 3 timing out.

Three units of one exposure were therefore measured against different effective
conditions. Pin it explicitly (≥ 450 s at the measured rate; 600 s matches the
MCP config's `LOCAL_CODER_TIMEOUT_MS`) and register it **before** the next
exposure. Do not re-run a unit that already has an observation in order to give
it the rounds it should have had — that is a second draw at the same bar.

### F8 — `strata.ts`'s file header says "UNIT 2" and it is UNIT 1

Doc only. Present in the stub at `d0253e1`, so it is the author's, not the local
model's. `docs/b12-scorer/UNIT-1.md` is its spec.

---

## CLOSED

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
| `strata.ts` | local model, `c40e9f4` | 2026-08-07 | **accepted**; correct against `UNIT-1.md` step for step. F3 deferred here. |
| `terms.ts` | — | — | still a stub |
| `aggregate.ts` | — | — | still a stub |

`strata.ts`'s two bodies are 34 lines; every comment, both interfaces and the
imports were already in the stub. `UNIT-1.md`'s steps 1–7 are close to executable
pseudocode, which is worth remembering when reading the one unit that closed.

**Any hand-edit to an authored body goes in a commit of its own**, separate from
the run's. `git log -p` is the only thing that keeps "what the local model wrote"
legible once a human has touched the file.
