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
   - `sHi += (row.capped / rates.charsPerToken) * row.multiplier`
   - `sLo += (row.capped / rates.charsPerToken) * writeComponent`, where
     `writeComponent` is `m.cacheWrite1h` when `row.ttl === "1h"` and
     `m.cacheWrite5m` when `"5m"`, with `m = multipliersFor(rates, row.rateKey)`.
     That is `positionalMultiplier` at `T - 1 - t = 0`.
   - Add the same two numbers into `perDelivery[row.tool]`
     (`{sLo, sHi, rowCount}`), creating the entry on first sight. Key by
     `row.tool` verbatim — never map a tool name onto another delivery's bucket.
8. **`turnsCollapsed` contributes NOTHING** to `sLo`, `sHi` or `perDelivery`.
9. **Never clamp.** A negative `row.capped` stays negative through every sum.
10. `refusals`: for each of the four classes, count the kept rows with that
    `disposition`; sum `row.units` into `units` when it is a number; increment
    `unsized` for each whose `units` is `null`.
11. `subagentShare` = `subagentShare(input.observation, input.transcript)` from
    `./strata.js`.
12. `billedRequestCount` = the number of `transcript.requests` in `owned`.
13. `rateKeys` = sorted unique `rateKey(request.model, request.speed)` over those
    same requests.
14. `taskId`, `arm`, `verificationStratum` from `input.observation`;
    `disposition` from `input.disposition`.

## Done when

`npx vitest run tests/b12-terms.test.ts` exits 0. Do not read that file.
