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
- **Falls if:** < 2 turns saved on median.
- **If it falls:** the problem is almost certainly the **tool description** losing
  to the instinct to reach for Bash, not the tool. Rewrite the description before
  concluding anything about the mechanism.
- **Status:** open

## B0 — the delegation tools can operate on this project's own files

- **Assumed:** implicitly, and never stated until it failed — (assumed)
- **Source of the assumption:** none. It was never written down, which is why it
  was never checked.
- **Experiment:** call `implement` on a file of ordinary size for this
  repository and see whether the result arrives complete.
- **Measured:** **it does not.** `run 2026-08-03-mac-05`: `implement` truncated
  repeatedly on `src/selection.ts` (380 lines) with `qwen3-coder-30b` and the
  default 8192-token cap. `src/tools/shared.ts:78` requires the model to return
  *the complete final content of every editable file*, so output is the **sum**
  of the files in the request, regenerated on every attempt and every `repair`
  round. `repair.ts` is 699 lines; `report.ts` 554.
- **Falls if:** it already has — the ceiling is structural, not a tuning knob.
- **If it falls:** B6 and B7 are measuring a tool that cannot reach the files
  they claim to be about. Either the output contract stops being whole-file, or
  the tools are scoped to small files and said to be. **Raising
  `LOCAL_CODER_MAX_OUTPUT_TOKENS` buys headroom, not a fix:** the cost still
  scales with total file size × rounds.
- **Status:** **fallen**, and it precedes B6 — decide the contract before
  spending more runs on close rates.

## B6 — `repair` closes ≥ 50% of mechanical failures within 3 rounds

- **Assumed:** ≥ 50% — (assumed)
- **Source of the assumption:** none worth the name. **This is the premise with
  the least evidence in the project.** `repair` has never been run against a real
  local model; every test uses a mocked one.
- **Experiment:** 20 real mechanical failures (type errors, failing assertions,
  lint, missing imports); record `passed` and `rounds_used`.
- **Measured:** **1 task, 11 `repair` calls, and still not a rate.**
  `run 2026-08-03-mac-06` recovered the payloads `run 2026-08-03-mac-05` reported
  it could not find. They were never missing: telemetry writes `rounds_used`
  under the name `turns_collapsed` — `repair.ts:654` and `repair.ts:680` are the
  same expression — so a search for `rounds_used` in the log was always going to
  come back empty. Archived as `evidence/2026-08-03-mac-06.telemetry.jsonl`.
  - **10 calls entered with a red gate; 2 closed.** The 11th ran on an
    already-green tree (0 rounds, no files, the `gate.passed` branch that
    `repair.ts:691` logs as *nothing to do*) and is excluded — a call with no
    failure to close cannot count as a closure.
  - **2 of 10 is not B6's rate and must not be read as one.** B6 counts
    mechanical *failures*; those 10 calls are successive passes over roughly the
    same failure, so the denominator is still about one task.
  - **Both closures took exactly one round.** No second or third round closed
    anything in this corpus.
  - **3 of the 4 `max_rounds` calls returned `files: []`** — and that is stronger
    than a low close rate. `files` derives from `best.contents`
    (`repair.ts:598`), which is replaced only when a round *lowers* the failure
    count, so an empty list after exhausting the rounds means no round ever
    improved on the original bytes. Those three burned 4, 3 and 3 rounds: **10
    rounds of local generation that reduced the failure count zero times.**
  - **This corrects the previous run's wording.** "It did not close" was wrong as
    written — two calls did close, both in one round. What no single call did was
    close the *original* failure within 3 rounds.
  **B0 fell underneath this and the payload cannot separate them:** a truncated
  response (`finish_reason=length`, `shared.ts:283`) throws after the corrective
  retry and lands under `stopped_because: "model_failed"` — the same label a
  request killed by the deadline used to get. The deadline half is fixed, and by
  **observing** which ceiling fired rather than inferring it: the request ceiling
  is `min(config.timeoutMs, remaining)`, and `llm_timeout` carries the value it
  applied, so a value below `config.timeoutMs` *is* the budget having bound. A
  clock read after the abort cannot recover that — by then the deadline has
  usually passed whichever limit fired. The truncation half is **not** fixed, so
  a `model_failed` row still means *either* B0 *or* the loop, and B6 cannot be
  measured cleanly until the output contract is decided.
- **Falls if:** < 30%.
- **If it falls:** `repair` degrades to a one-shot `fix` with a gate around it,
  and the turn-collapse lever is worth roughly a third of the estimate.
- **Status:** open

## B7 — a `repair` round costs ≤ 90 s

- **Assumed:** ≤ 90 s — (assumed)
- **Source of the assumption:** a local model generating one file plus one gate
  run, on the target hardware. Untested.
- **Experiment:** the same 20 failures as B6; take the median of
  `model_latency_ms + gate_ms` per round.
- **Measured:** **the experiment could not have been run — on this run or any
  earlier one — and that was an instrument gap, not a missing run.** Every round
  already measures `model_latency_ms` and `gate_ms` (`repair.ts:65`) and hands
  them to the *caller* in `rounds[]`; `telemetry.record` kept only the call total
  and the round count (`repair.ts:673`). So B7's statistic was never in the log,
  and the gap would have swallowed the next run too. **Fixed in this commit**:
  the per-round trace is now written into the telemetry detail.
  What `run 2026-08-03-mac-06` supports meanwhile is an **upper bound**:
  `latency_ms / rounds` over the 10 calls that had a failure to fix has a median
  of **93.6 s** (per call, seconds: 9.8, 13.9, 52.1, 77.7, 85.2, 102.0, 222.0,
  300.1, 305.5, 325.9). It over-attributes on purpose — it charges the first
  gate, the rollback and the tree fingerprint to the rounds — so the true figure
  is below it. Above the 90 s assumption, below the 150 s fall line, from about
  one task. **It does not decide B7**; it is a different statistic, recorded so
  the assumption stops being unexamined.
- **Falls if:** median > 150 s.
- **If it falls:** three rounds cost more wall-clock than the user will accept.
  Lower `max_rounds` to 2, or pick a smaller model, and re-measure B6 after.
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

## B12 — the combined saving is ≥ 30% of cost per task

- **Assumed:** ≥ 30% — (assumed; the per-lever estimate behind it is a derivation
  over the measured cost split, not a measurement)
- **Source of the assumption:** the cost decomposition below plus the positional
  multiplier.
- **Experiment:** 20 real tasks run with the MCP server enabled and disabled;
  compare with `npm run cost-meter`. There is no hook arm — G2 is closed, so the
  server is the whole of what is being measured.
- **Measured:** — (no run)
- **Falls if:** < 15% — see `G-stop` in `ROADMAP.md`.
- **If it falls:** the project stops. Only the pieces that individually paid for
  themselves in the counterfactual accounting survive.
- **Status:** open

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

---

## Measured facts (not premises)

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

`npm test` reports **4 failures / 202 passing** (206 total), `run 2026-08-02-win-03`.

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
