# UNIT 2 — `src/cost/b12/terms.ts`

Implement the two exported functions. Do not change their signatures, do not add
exports, do not edit any other file. `src/cost/b12/strata.ts` is already
implemented — call it, do not reimplement it.

## Constants, frozen — use these exact values

- `rates.charsPerToken` (3.7) and `rates.clientTruncationCap` (30000): read them
  off the `rates` argument, never hardcode them.
- `positionalMultiplier(t, T, m, ttl)` from `../report.js` returns
  `write + cacheRead * max(0, T - 1 - t)`, where `write` is `m.cacheWrite1h` for
  ttl `"1h"` and `m.cacheWrite5m` for `"5m"`.

**EVERY IMPORT THIS UNIT NEEDS, AND THEY ARE NOT ALL FROM THE SAME MODULE.**
This list is here because the one worked example above used to be the document's
only module hint, and generalising from it is wrong for `rateKey`:

```ts
import {
  breakdownOfRequests, buildCounterfactual, buildSessionReport,
  unitsAddedByInstallation,
} from "../report.js";
import { rateKey } from "../rates.js";
import { subagentShare } from "./strata.js";
```

`positionalMultiplier` is described above so the numbers on the rows make sense;
this unit does not call it, so it is not in the list.

`rateKey` lives in `../rates.js`. `../report.js` imports it and does **not**
re-export it, so importing it from `../report.js` is a `TS2459` — which is
exactly what `run 2026-08-06-mac-b12-phase3-f2932ff` did with `multipliersFor`
before spending its remaining budget on the error.

## `windowInvocationIds(observation, transcript): Set<string>`

Four hops, all required:

1. `owned = new Set(observation.originatedRequestIds)`.
2. Collect every `toolUse.id` from each `request of transcript.requests` whose
   `request.requestId` is in `owned`. Call it `ownedToolUseIds`.
3. For each `result of transcript.toolResults`: if `result.invocationId` is not
   null AND `result.toolUseId` is not null AND
   `ownedToolUseIds.has(result.toolUseId)`, add `result.invocationId`.
4. Return that set.

A window that did not make the call owns nothing, even when the id is plainly
present elsewhere in the same transcript.

## `computeTerms(input): ObservationTerms`

In order:

1. `const owned = new Set(input.observation.originatedRequestIds)`.
2. `aO` = `breakdownOfRequests(input.transcript.requests, input.rates, owned).units.total`.
3. `oO` = `unitsAddedByInstallation(input.transcript, input.rates, input.installedChars, owned)`.
4. `const mine = windowInvocationIds(input.observation, input.transcript)`.
5. Call `buildCounterfactual(input.transcript, input.telemetry, input.rates,
   buildSessionReport(input.transcript, input.rates), input.ambiguousIds)`.
   **Pass the WHOLE transcript.** Never a filtered one: `positionalMultiplier`
   reads `t` and `T` off the full segment, and shortening it changes the answer.
6. Keep only the returned `rows` whose `invocationId` is non-null and in `mine`.
   Those are this window's rows; put them in `rows`.
7. For each kept row with `disposition === "credited"`:
   - `sHi += row.units` and `sLo += row.unitsLo`. **Both are already on the row**
     — `units` is the observed segment, `unitsLo` the write component alone
     (`T - 1 - t = 0`). Do not recompute either from `capped` and a multiplier:
     the row is where that arithmetic lives, and a second derivation of one
     number is how two figures from one rule drift apart.
   - They are typed `number | null` because a REFUSED row may be unsizeable. On a
     credited row both are always numbers, but **`disposition === "credited"`
     does not narrow them** — the type does not encode the invariant. So do not
     write `?? 0`: that sums an unknown as zero, which is the one thing this
     scorer forbids everywhere else, and every oracle would still pass. **Throw,
     naming the row**, if a credited row arrives with either field null. A
     defect upstream is worth a crash here; it is not worth a silent zero.
   - Add the same two numbers into `perDelivery[row.tool]`, creating the entry on
     first sight. Key by `row.tool` verbatim — never map a tool name onto another
     delivery's bucket. The entry is
     `{sLo, sHi, rowCount, closures, closureUnknown}`: increment `closures` when
     `row.passed === true` and `closureUnknown` when `row.passed === null`.
     `false` increments neither — it is a delivery that ran and did not close,
     which is a third thing. Credited rows only, exactly like the two sums: a row
     outside the numerator is outside the closure count as well.
8. **`turnsCollapsed` contributes NOTHING** to `sLo`, `sHi` or `perDelivery`.
9. **Never clamp.** A negative `row.capped` stays negative through every sum.
10. **TWO ledgers, split on OWNERSHIP and on nothing else.** Build each the same
    way: for each of the four classes, count the rows with that `disposition`;
    sum `row.units` into `units` when it is a number; increment `unsized` for
    each whose `units` is `null`.
    - `refusals` — over the KEPT rows, as step 6 defines them. This window's own.
    - `unattributedRefusals` — every OTHER refused row the counterfactual
      returned: `invocationId` null, or an id not in `mine`.

    Do not special-case any class. **`unverifiable` is the one that can never be
    owned** — it is refused precisely because it has no `invocation_id`, so it is
    never in `mine`. `excludedForeign` is unownable on any normal input but not
    provably: it is refused for being absent from the gate/repair-filtered map,
    while `mine` is built from EVERY tool result, so the two sets are not exact
    complements (`FINDINGS.md` F10). Writing the rule as "ownership" rather than
    as a list of classes is what keeps it correct either way.

    Either way a single ledger over kept rows is missing most of two classes,
    while `R_hi+` is defined over ALL FOUR — so the fall-side figure came out
    short.

    Do not try to attribute the second group to a window. Nothing in the data
    can, and `aggregate.ts` credits it whole.
11. `subagentShare` = `subagentShare(input.observation, input.transcript)` from
    `./strata.js`.
12. `billedRequestCount` = the number of `transcript.requests` in `owned`.
13. `rateKeys` = sorted unique `rateKey(request.model, request.speed)` over those
    same requests. `rateKey` is **from `../rates.js`**, not `../report.js`.
14. `taskId`, `arm`, `verificationStratum` from `input.observation`;
    `disposition` from `input.disposition`.

## Done when

`npx vitest run tests/b12-terms.test.ts` exits 0. Do not read that file.
