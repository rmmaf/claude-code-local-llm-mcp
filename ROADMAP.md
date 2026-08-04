# ROADMAP.md

What may be built next, and the number that decides it.

**Rules.**

- Gate states: `unevaluated` · `open` · `closed` · `moot`.
- **A step without a NUMERIC gate cannot be written.** "It seems useful" is not a
  gate; a threshold on a premise in `PREMISES.md` is.
- A `closed` gate reopens **only** on a measurement carrying a new `run_id`, and
  the reopening condition is written into the block itself — not decided later.
- **At most 6 active gates.** If a seventh is needed, one must close or become
  moot first.

---

## G1 — cost meter · `open` (reopened)

- **Delivered:** `src/cost/{cli,rates,transcript,report}.ts`, `src/telemetry.ts`,
  `.local-coder/rates.json`.
- **Was closed by:** it runs against real transcripts and reports billed
  quantities, deduplicating 155 `assistant` records into 69 billed requests
  (`run 2026-08-02-win-01`).
- **REOPENED by B1 falling** (`run 2026-08-03-win-04`): meter $119.11 vs `/usage`
  $35.96, +231% against a 5% threshold. This is the reopening condition exactly
  as it was written, so it applies exactly as it was written: **nothing
  meter-derived may be measured until it agrees.** That covers B12 and anything
  reading `savedFraction`. It does not cover B6 or B7, which come from `repair`'s
  own returned payload and never touch the meter.
- **Closes again when:** the meter agrees with a comparator to within 5%. Which
  comparator is now an open question, not a detail: `/usage` reports 20.0% of
  published list price for its own token counts, so it is not measuring
  list-price API cost. **Pick and pre-register the comparator as its own premise
  before running anything against it** — choosing it after seeing a disagreement
  is how a threshold gets quietly fitted to the data.

## G2 — deterministic layer (PostToolUse hook) · `closed` (dead)

- **Closed by B2 falling** (`run 2026-08-02-win-03`): the hook ran on a real
  command, filtered it, wrote its spill — and its replacement never reached the
  transcript. 30,000 characters of raw output landed instead. The suppression was
  not happening at all, billed or otherwise.
- **In force now:** the hook is unregistered from `.claude/settings.json`, so it
  is off the critical path of every Bash call. `hooks/filter-tool-output.mjs`
  stays on disk — inert, and cheap to retest. Suppression lives in `gate`, which
  controls its own returned payload and needs no hook (67,190 → 1,724 bytes on a
  real run). Nothing else in this file depends on G2.
- **Reopens ONLY if:** a run with a new `run_id` shows
  `cache_creation_input_tokens` on the following request drop measurably with the
  hook returning `{stdout, stderr, interrupted, isImage}` — the shape a Bash
  result actually has, and the specific reason the string form failed.
  **One attempt.** If that run does not show a drop, G2 becomes `moot`.
- **Why the condition is written here rather than debated later:** the argument
  "the implementation was wrong, not the idea" is always available, whether or not
  the idea is any good. Committing the threshold in advance is what stops a fallen
  premise from being quietly reinterpreted into a live one.
- **Either way:** no saving from the hook may be reported as measured.

## G3 — RAG / Chroma · `unevaluated`

- **Opens only if B8 < 70%** — that is, only if deterministic search (ripgrep +
  import graph + git recency) cannot find the right files on its own.
- **If it opens:** the Mac's `D7` diagnostic must be built (recall vs grep, index
  footprint, cold-load time, incremental reindex time, 3 embedding dimensions).
- **Deliberately not built yet.** The cheapest arm is the baseline; building the
  expensive one first would leave us unable to tell whether it paid.
- **Scope, so it is not misread:** the corpus is *this repository*. It is not
  library documentation and it does not answer library version drift — see
  `DECISIONS.md § v3` and **G6**.

## G4 — `locate` tool, arms A and B · `unevaluated`

- **Waiting on:** B8 (arm A recall), B9 (does local triage add anything),
  **B11** (does Claude stop reading the whole file).
- **Build order is fixed:** arm A first — it is deterministic, needs no local
  model, and is the baseline every other arm is measured against.
- **B11 is a revert condition, not a tuning condition.** If Claude reads the file
  anyway, pointers cost *on top of* the read and the tool is strictly negative.
- **Motivation, measured:** `Agent` results were 472 KiB of 816 KiB (58%) of all
  tool output in a real session — the largest single contributor to context.

## G5 — Mac diagnostics, reduced · `unevaluated`

- **Still needed:** `D2` (real KV cache per context), `D3` (RAM ceiling and
  Auto-Evict), `D5` (Docker Desktop VM cost), `D10` (RAM floor with work apps
  open), `D8` (output contract, stability, elision — now the engine of `repair`),
  `D4` (tok/s — `repair` has a time budget, and a slow model makes B7 fall).
- **Dropped unless B8 < 70%:** `D7` (RAG recall and index footprint).
- **Changed shape:** the RAM planner now sizes **two small models** (a repairer
  and a triager) instead of squeezing in one 27B. The question moved from
  "does it fit?" to "what is the smallest that works?".
- **Waiting on:** B6 and B7, which decide what the local model actually has to be
  good at.

## G6 — installed-types injection · `unevaluated` · **experiment only**

- **Not a planned component, and nothing else here depends on it.** The
  architecture's answer to library version drift is G2/`gate` plus escalation to
  the orchestrator — see `DECISIONS.md § v3`. G6 asks only whether injecting the
  installed declarations buys anything *on top* of that. If it is never built,
  no other gate on this board changes.
- **Opens only if B13 ≥ 15 pp.** B13 is a *delta* on B6's close rate, so it
  cannot be measured before B6 — which needs a real local model, and therefore
  G5's `D4`/`D8`. G6 is the furthest-downstream gate on the board.
- **Nothing new is needed to run the experiment.** `repair`, `implement` and
  `fix` already take `context_files`; the arm is a different *call*, not
  different code. What does not exist is the **selection logic** that picks which
  declarations to pass — and it stays unbuilt until B13 says it pays.
- **Blocked on a size question, not a recall question.** A library's declarations
  can exceed `LOCAL_CODER_MAX_FILE_KB` (256) on their own, and
  `enforceContextCaps` **rejects** rather than truncates. So the experiment must
  count how often the cap refused the injection; that count decides whether
  per-symbol slicing is worth building. **(open in `DECISIONS.md § v3`:** what a
  slice would even be.)
- **Closes as dead if:** B13 < 5 pp, **or** the injection pushes the median
  `repair` round past B7's 150 s fall threshold — the lever fills the context the
  project exists to empty, so a time regression kills it outright.
## G7 — search/replace output contract · `unevaluated`

- **What it would be:** the model returns anchored `search → replace` blocks
  instead of whole files, so output is proportional to the **edit** rather than
  to the file. Coverage stops depending on file size.
- **Why this is not the thing `DECISIONS.md` already rejected.** What was
  rejected is **LLM-authored unified diffs**, and the stated reason is broken
  hunks — line numbers and hunk arithmetic the model has to get right. Anchored
  search/replace has neither: an exact string either matches once or it does
  not, and not matching is **detectable and refusable**, not silent corruption.
  The recorded reason is good and it does not transfer. That is the whole of why
  this gate may be opened at all.
- **Opens only if ≥ 40% of the CAPTURED corpus's tasks are refused by the
  pre-flight** (`output_would_truncate`). The threshold is above the base rate on
  purpose: **15% of this repo's source+test pairs are over the cap today**, so
  refusals arriving at roughly that rate would say the refusal is uncorrelated
  with where real work happens.
- **Dies if < 20%.** At or near the base rate, the whole-file contract is not
  what blocks real work, and rewriting it would be paying for coverage nobody
  was reaching for. **Both numbers are fixed here, before any corpus runs**, for
  the reason G2 spells out: after the fact, "the implementation was wrong, not
  the idea" is always available.
- **AMENDED before any data existed: the denominator is the *captured* corpus,
  not corpus #1.** As first written this said "the corpus", and corpus #1 turned
  out to be synthetic — which means whoever writes the fixtures chooses their
  sizes and therefore chooses the refusal rate. Fixtures small enough to measure
  B6 rather than B0 give 0% by construction and would have killed this gate
  without evidence about anything. A pre-registered threshold decided by its own
  generator is worse than no threshold. **The amendment is legitimate only
  because it happened here, before the run:** the same edit after seeing a
  result would be the exact move this file exists to prevent, and the difference
  is the timing and nothing else.
- **What it would cost if it opens:** a new parser, a new apply path, and it
  touches the compare-and-swap, the rollback and `effectivelyUnchanged`, all of
  which assume whole content today. It also needs **its own premise**: the rate
  at which a small local model emits a usable search/replace block is exactly
  the kind of number this project does not accept by assumption.
- **Blocked on B14 too, in one direction only:** if the pre-flight turns out to
  be too strict, its refusal count is inflated and would open this gate on an
  artefact. Read B14's result before reading this one.
- **Active-gate count:** **six active** (G3, G4, G5, G6, G7, G-stop) since G2
  closed. **G7 takes the last slot under the ceiling of 6** — a seventh needs
  one of these to close or become moot first.

## G-stop — STOPPING CRITERION · `open`

**If, once the surviving deliveries are in use, the cost meter shows < 15%
reduction, the project stops.**

Those are now **three**, not four: the cost meter (G1), `gate` and `repair`. The
`PostToolUse` hook was delivery 2 and is dead (G2), so it is not part of what has
to pay for itself — and it cannot be counted toward the 15% either.

Only the pieces that individually paid for themselves in the cost-meter's
counterfactual accounting survive. This is deliberately a hard number and not a
judgment call: the failure mode this whole registry exists to prevent is
continuing to build on a premise that quietly stopped being true.

- **Measured by:** B12, over 20 real tasks with the server and hook on versus off.
- **Reopens if:** a later measurement with a new `run_id` clears 15%.

---

## Not on the roadmap, and why

- **`dispatcher/` in Python, LangChain** — no gate, so it cannot be written.
  Everything above fits the TypeScript server that already exists.
- **Per-agent local model routing** — blocked upstream by
  [claude-code#38698](https://github.com/anthropics/claude-code/issues/38698);
  `ANTHROPIC_BASE_URL` is session-wide. MCP is the only path today.
- **`CALIBRATION.md`** — out of scope by decision, recorded in `DECISIONS.md § v3`.
