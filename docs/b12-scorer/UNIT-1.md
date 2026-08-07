# UNIT 1 — `src/cost/b12/strata.ts`

Implement the two exported functions. Do not change their signatures, do not add
exports, do not edit any other file. **No ratio is computed in this file** — it
answers which observations belong in which cell, never what the cell's number is.

First in the chain because it depends on nothing: `terms.ts` imports
`subagentShare` from here and `aggregate.ts` imports `partitionByStrata`.

## `subagentShare(observation, transcript): Evaluable<SubagentShare>`

1. `const owned = new Set(observation.originatedRequestIds)`.
2. `const own = transcript.requests.filter(r => owned.has(r.requestId))`.
   **Filter — never use `transcript.requests` whole.** The transcript holds every
   request in the lineage; the window holds its own.
3. **If `own.length === 0`, return `{ evaluable: false, reason: "..." }`** with a
   reason naming that the window originated no billed request. Do NOT return a
   share of 0. Zero is what a genuinely single-threaded session measures;
   returning it here files an empty observation into the `solo` stratum and lets
   it vote on a cell it never contributed to.
4. `const sidechain = own.filter(r => r.isSidechain).length`.
5. `share = sidechain / own.length`.
6. `stratum` is `"solo"` when `sidechain === 0`, otherwise `"multi"`. **The
   threshold is ZERO, not a fraction** — any sidechain request at all makes it
   `multi`. Do not introduce a percentage cutoff.
7. Return `{ evaluable: true, value: { own: own.length, sidechain, share, stratum } }`.

## `partitionByStrata(terms): StrataPartition`

Return six arrays, preserving input order within each.

- `testRed` / `typesOnly`: split on `t.verificationStratum`, which is DECLARED in
  the manifest and read off the observation. Never infer it from what the gate
  did — inferring it after the fact lets a result choose its own cell.
- `unknownStratum`: any other value goes here, and into **NEITHER** `testRed` nor
  `typesOnly`. The field is typed as a two-value union, but it is read from
  unvalidated JSON and nothing in the repository checks it, so **write the
  comparison against a widened `const declared: string = t.verificationStratum`
  and give it a real `else`.** Without the widening `tsc` narrows the third
  branch to `never` and there is no way to say what happens to a value the rule
  does not name. Enumerate the good values; refuse the rest.
- `solo` / `multi`: read `t.subagentShare`. When `evaluable === true`, use
  `t.subagentShare.value.stratum`.
- `unevaluableShare`: when `evaluable === false`, the observation goes here and
  into **NEITHER** `solo` nor `multi`. A bucket that absorbed them would make the
  two cells look complete while one carried the unknowns.

The two "neither" buckets are not the same kind of thing, and `aggregate.ts`
treats them differently: an unevaluable share is a MEASURED ABSENCE, an
unrecognised stratum is a CORRUPTED DECLARATION. Do not merge them.

## Done when

`npx vitest run tests/b12-strata.test.ts` exits 0. Do not read that file.
