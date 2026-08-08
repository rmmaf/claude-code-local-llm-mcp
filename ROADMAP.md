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

## G1 — cost meter · `closed` (again)

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
- **CLOSED AGAIN by B20 holding** (`run 2026-08-05-win-14-b20`): the meter's
  per-class token totals equal an independent enumeration's, **residual exactly 0
  on 4 classes x 11 sessions**, artifacts under `evidence/`. The comparator was
  pre-registered before any repair and it is not `/usage`.
- **The measurement ban lifts with it.** B12 and anything reading `savedFraction`
  may be measured again. **G-stop becomes evaluable**, which it has not been
  since B1 fell.
- **Three defects were repaired to get here, and each was found by writing the
  check rather than by running it.** `listTranscripts` read one file where a
  session is many (390 of 2,703 requests invisible); the dedup kept the FIRST
  record of a `requestId` group where the last one carries the answer (655,570
  output tokens, 19.27%, at the 5.0x rate); and `readUsage` used a TTL split that
  contradicted its own total (42,558 tokens in the 2.0x class). Two of the three
  undercounted, and B1's headline still ran 231% high — so none of them explains
  that fall, and the fall's own diagnosis of it was right: `/usage` was measuring
  a different quantity. (B20 replaces B19, which replaced B17. Both are `moot` and
  neither was ever measured: their VOID conditions froze the oracle's *code*
  before it was trustworthy, and four false-negative paths were found across two
  reviews. B20 freezes the *standard* instead. The outcome, the threshold and the
  admission rule are byte-identical to the pre-registration commit throughout.)
- **THE ORIGINAL CONDITION — "within 5%" of a dollar comparator — IS DELETED, NOT
  SATISFIED.** It cannot be met on this account and no amount of repair will make
  it meetable: `/usage` reports **20.0% of published list price for its own token
  counts** because this is a Max subscription, and a Max subscription produces no
  per-token invoice to check against. **Even a perfect meter leaves the dollar
  disagreement at roughly 5x, permanently.** Recording that as a property of the
  venue is the honest move; leaving the 5% standing beside B20's condition would
  be worse than either, because a marginal reading would then sit inside both and
  whoever adjudicated later would get to choose which one it answered to.
- **Timing, stated because it is the only thing that makes this legitimate.**
  This replacement is written **before** the oracle exists, before the meter is
  repaired, and before any comparison has been run — the same claim G7's
  amendment below rests on, and the difference is the timing and nothing else.
  What licenses it is `PREMISES.md`'s own disposition of B1: failure 2 says the
  *experiment* was mis-specified, so a corrected instrument check is proposed and
  pre-registered as its own premise. That was B17, and is now B20 — the
  replacements changed the instrument, never the outcome or the threshold.
- **What closing this does NOT license.** No absolute dollar figure may be
  reported as measured on this plan. **B12 and G-stop consume ratios only** —
  reduction against a control arm — and a ratio survives an unknown pricing basis
  only if that basis is constant across both arms.
- **NARROWED 2026-08-05, while pre-registering B12: a session's total is not that
  session's cost.** Measured — **zero of 5,769** billable-shaped records carry a
  foreign `sessionId`, because Claude Code **rewrites the id** on the inherited
  records it copies into a resumed or forked conversation's file. So B20's
  session rule cannot separate a session's own work from what it inherited,
  nothing in the format marks a record as inherited, and **535 of 1,904 distinct
  billed requests (28.1%) are claimed by two or more sessions** — 87 by four. Per
  session the inherited share runs **1% to 100%** and no session is clean. G1 is
  untouched: B20 compares the two sides over the same files, both read a shared
  record identically, and the residual of 0 stands. What is narrowed is what may
  be read OFF a session total afterwards. **A session is therefore not an
  observation, and B12 may not use one as its unit** — a mostly-inherited session
  divides by another conversation's cost. Narrowing only, in the one direction a
  closed gate's text may move.
- **Recorded without a threshold: the uniform-discount assumption.** The ratio
  argument above needs the plan's discount to be **uniform across token classes**.
  If the subscription discounts cache reads differently from output, a saving
  ratio computed at list rates is biased by an unknown amount in an unknown
  direction. Nothing here measures that, nothing can measure it from the data
  available, and it is currently doing silent work for the entire stopping
  criterion. Named here so it stops being silent.
- **The repair proceeded, and `src/cost/` being "frozen" did not forbid it.**
  See `DECISIONS.md § the freeze forbids measuring, not repairing`. The short
  form: read as a blanket edit ban, the freeze makes this gate's own written
  closing condition unreachable by construction.
- **The active-gate count returns to six**, without anyone having to resolve the
  interpretive question the note at the foot of this file records. The board was
  at seven because a *reopening* breached the ceiling; the reopening is over. The
  ambiguity — whether `open (reopened)` counts as active — is untouched and stays
  a decision for whoever needs it, which is nobody while the count is six.

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
  **That denominator is now known to be main-thread only** and the number is
  therefore understated by an unknown, session-dependent amount: the meter that
  produced it could not see `<sessionId>/subagents/**`. Flagged rather than
  recomputed — recomputing needs the oracle B20 pre-registers, and a number
  corrected by hand would be the same class of error twice.

## G5 — Mac diagnostics, reduced · `unevaluated`

- **`D4` is MEASURED: 78.9 tok/s** (`run 2026-08-04-mac-10`, six `scaffold`
  calls on `qwen3-coder-30b-a3b-instruct-dwq-v2`, 16,484 tokens over 208.3 s).
  It turned out to matter for something nobody had connected to it: at a
  16384-token cap a response cannot truncate before **~208 s**, so **B14 (now
  B16) is not
  executable at all below that `timeoutMs`** and reports zero truncations by
  arithmetic rather than by merit.
- **`D8` is MEASURED, and it did not stay a diagnostic**
  (`run 2026-08-04-mac-11` … `-mac-17`, six artifacts under `evidence/`).
  `scripts/contract-stability.ts` runs a 10-file size ladder of this repo, 665 B
  to 35,656 B, plus three multi-file groups, scoring every response
  `complete` / `elided` / `truncated` through `src/contract-probe.ts` — which
  lives under `src/` on purpose, because `tsconfig.json` does not cover
  `scripts/**` (it covered `src/**` alone when this was written; `tests/**`
  joined on 2026-08-07) and a scoring bug there would corrupt every number
  silently. Headline: **94.7%
  complete** over 38 scored responses, and **the outcome is a function of size,
  not a random variable** — 13 of 13 cases unanimous across three repeats, 12
  byte-identical. Practical ceiling on this configuration: **~23 KB of editable
  source** at a 16,384-token window.
- **What `D8` found is why it stopped being a diagnostic.** Input and output
  share one context window, and nothing in this codebase consulted it: the one
  failing case came back as a properly closed `<file>` block with
  `finish_reason: "stop"`, **missing 90 lines**. That shipped a context
  pre-flight (`context_would_overflow`, `LOCAL_CODER_CONTEXT_TOKENS`,
  `pickLoadedContextTokens`, `status.context_window`) which was on no roadmap.
  The numbers are in **B16**, which replaced B14 once it turned out that B14's
  detector — `finish_reason: "length"` — cannot see this failure at all.
- **A `D3`/`D10` by-product, unlooked-for:** four LM Studio runtime crashes under
  memory pressure, all on the single largest case — a 16 GB model plus the KV
  cache for a ~7,700-token answer on a 36 GB machine. Refusing that request up
  front removed them entirely. `lms ps` also now yields the loaded
  `contextLength` (16,384) and `maxContextLength` (262,144), which is **not**
  `D2`: a context length is not a measured KV-cache footprint.
- **Still needed:** `D2` (real KV cache per context), `D3` (RAM ceiling and
  Auto-Evict), `D5` (Docker Desktop VM cost), `D10` (RAM floor with work apps
  open).
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
- **Blocked on B16 too** (B14 until it went `moot`)**, in one direction only:**
  if the pre-flight turns out to be too strict, its refusal count is inflated and
  would open this gate on an artefact. Read B16's result before reading this one.
- **B16 now holds, and it does NOT clear that block.** Its two non-void runs
  (`mac-20`, `mac-23`) refused **nothing** — at 32,768 every request was
  admitted — so they establish that admitted requests succeed and say nothing at
  all about the refusal side. The over-refusal that *was* observed
  (`run 2026-08-04-mac-16-preflight`, a 26,889 B pair that measured 11,237 actual
  tokens and later returned complete 2 of 2) is still carried by B16 **without a
  threshold**, deliberately. So this gate's inflation risk is exactly as open as
  it was.
- **A number now exists, and this gate does NOT move on it.**
  `run 2026-08-04-mac-17-preflight` ran the full `D8` corpus with both pre-flights
  enforcing: **`output_would_truncate` refused 0 of 13**;
  `context_would_overflow` refused 2. Two independent reasons that is not this
  gate's number. **(a) Wrong denominator.** The amendment above fixed it to the
  *captured* corpus for one stated reason — whoever writes the fixtures chooses
  their sizes and therefore chooses the refusal rate — and a deliberately
  size-graded ladder is that same problem in different clothes. 0% here would
  kill this gate on an artefact of its own construction, which is the outcome the
  amendment was written to prevent. **(b) A code that did not exist when the
  threshold was written.** `context_would_overflow` shipped in this same run.
  Both codes refuse a whole-file answer that will not fit; only one is named
  above. **Which code the threshold means is an open question and is left open**
  — deciding it now, with the counts already on the table, is choosing a
  threshold by its answer. Whoever resolves it should write the resolution here
  *before* the captured corpus runs, and say which of the two readings was
  intended.
- **B16 is now a second thing to read first, alongside the pre-existing note.**
  If the estimator is too strict, refusals are inflated and this gate opens on an
  artefact — that was already written down. `run 2026-08-04-mac-16-preflight`
  observed exactly that over-refusal on a real request. Both directions are now
  live, not just one.
- **PROTOCOL, PRE-REGISTERED HERE AND NOW — after seeing the `D8` numbers above,
  and BEFORE the captured corpus runs.** The timing is stated because it is the
  only thing that makes this legitimate, the same claim the amendment above
  rests on. Five rules, and none of them moves this gate today:
  1. **`output_would_truncate` remains the sole opening and killing outcome**, at
     ≥ 40% / < 20%, unchanged. Nothing about it is reinterpreted.
  2. **`context_would_overflow` is EXPLORATORY.** It cannot open this gate and it
     cannot kill it. Look at the shape of what is on the table: the
     pre-specified outcome measured 0% and kills G7, the un-specified one
     measured 15.4% and keeps it alive. Reading the threshold as "either code"
     would be choosing, after seeing both, the number that saves the gate. That
     has a name — outcome switching — and the accepted remedy is not to forbid
     the second number but to **label it exploratory and report when the
     deviation happened**, which is what this bullet is.
  3. **Refusals measured at a sub-maximal context window count for NOTHING.**
     The reason is mechanical rather than fitted: the cheap arm is
     `lms load --context-length`, this file already rules that the cheapest arm
     is the baseline (see G3), and the model in question supports 262,144 against
     the 16,384 it ran at. Only a refusal that survives a reload says anything
     about the *output contract*. This retires the contaminated 15.4% without
     anyone having to pick a number against it.
  4. **Promotion to a gate condition requires two things written here first:**
     the threshold, *and* a recomputed base rate — the fraction of realistic
     request bundles that exceed a shared window at the loaded context. The
     existing 40/20 was justified against a 15% base rate for the *output cap*;
     that justification does not transfer to a constraint that counts the prompt
     too, and inheriting the numbers without recomputing it would be a threshold
     with no argument behind it.
     - **HALF OF THAT IS NOW DONE. The base rate exists, and it is not one
       number — it is a function of the window**, which is itself the finding.
       Over this repository's 15 source+test pairs, estimated by the shipped
       formula rather than by running anything: **33% (5 of 15) exceed a
       16,384-token window, 7% (1 of 15) exceed 32,768.** Files alone: 7% and 0%.
       So a threshold on `context_would_overflow` says nothing until the window
       it was measured at is fixed — which is rule 3 arriving from the other
       direction. **No threshold is set here**; setting one now, with the rate in
       hand, is the move rule 4 exists to prevent. What rule 4 still needs is the
       threshold and its argument, from whoever decides them.
     - **RESOLVED 2026-08-06, and the resolution is that NO THRESHOLD WILL BE
       SET.** `context_would_overflow` stays exploratory permanently; rule 4's
       promotion path is closed rather than left waiting for a number.

       The argument is the one rules 3 and 5 already make, followed to its end.
       Rule 3 retires any refusal measured at a sub-maximal window because
       `lms load --context-length` is the cheap arm and this file rules the
       cheapest arm is the baseline. Rule 5 says the two codes must not merge
       because `context_would_overflow` is also answered by a free reload. The
       base rate then turned out not to be a number but a **function of the
       window** — 33% of this repository's 15 source+test pairs exceed 16,384
       tokens and 7% exceed 32,768, on a model that supports 262,144.

       A threshold on a quantity that a configuration flag moves by a factor of
       five is not a gate condition. It is a report about how the model was
       loaded, and promoting it would let a `--context-length` argument open a
       gate that buys a parser and a new apply path. **The honest closure is that
       this code cannot become one, not that its number is still pending.**

       `output_would_truncate` is unaffected and remains the sole opening and
       killing outcome at ≥ 40% / < 20%, over the captured corpus, exactly as
       rule 1 states. G7's status does not move: still `unevaluated`, still
       waiting on the captured corpus and on nothing else.
  5. **The codes must not be merged, and the reason is not pedantry — they imply
     different fixes.** `output_would_truncate` says the answer is too big, which
     is what search/replace blocks are for. `context_would_overflow` says prompt
     and answer do not fit together, which search/replace also helps — but so
     does a free reload. Merging them would let this gate open, and buy a parser
     and a new apply path, on evidence that a configuration change had already
     removed.
- **Active-gate count:** **six active** (G3, G4, G5, G6, G7, G-stop) since G2
  closed. **G7 takes the last slot under the ceiling of 6** — a seventh needs
  one of these to close or become moot first.
- **Correction: that count omits G1, which is `open (reopened)`.** By the state
  list at the top of this file `open` is live, so the board is at **seven** and
  has been since B1 fell — the ceiling was breached by a reopening, which is the
  one way it can happen without anyone deciding to. Recorded rather than
  silently renumbered, and **the practical rule is unchanged**: nothing new may
  be opened. Which of "active" or "reopened counts differently" the ceiling
  actually means is a real ambiguity in this file, and resolving it is a
  decision, not a typo fix.

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

- **Measured by:** B12, **pre-registered 2026-08-05** — design frozen by sha256 in
  `evidence/2026-08-05-b12-preregistration.json`, run not started.
- **ONE OF THE THREE DELIVERIES CANNOT BE SCORED BY THIS CRITERION, and that is
  structural rather than a gap to be filled.** G-stop requires each surviving
  delivery to individually pay for itself in the counterfactual accounting. The
  counterfactual credits a tool for bytes it suppressed and turns it collapsed.
  **The cost meter suppresses nothing and writes no telemetry row**, so it has no
  per-delivery ratio and cannot acquire one without becoming a different thing.
  So B12 holding closes G-stop for `gate`, leaves `repair` on its own exposure,
  and **cannot close G-stop overall**. The choice this forces — amend G-stop to
  name the meter as infrastructure rather than as a delivery that must pay, or
  accept that G-stop is not evaluable as written — is recorded here now, unmade,
  because making it after seeing `R` would be choosing the criterion to fit the
  result. **It is the project owner's call and it is not urgent until B12 runs.**
- **Reopens if:** a later measurement with a new `run_id` clears 15%.
- **15% is a RATIO, and that is what makes it reachable on this account.** A
  constant pricing basis cancels between the two arms, so G-stop never needed the
  meter's absolute dollars to be right — it needs the meter to count the same
  tokens on both sides and price them consistently. That is what G1 now closes
  on. **Two conditions ride on it and both are stated in G1**: the discount must
  be uniform across token classes, which is unmeasured; and the two arms must not
  differ in **subagent share**, because the coverage error is a function of
  session shape (near zero single-threaded, ~45% multi-agent). Record the
  subagent share as a covariate on every arm, or the comparison flatters
  whichever side spawned fewer agents.
  - **NOT RECORDED. Measured 2026-08-06:** `scripts/b12-run.mjs` `observe()`
    writes no subagent, thread or sidechain field on the observation. It is
    recoverable rather than lost — `src/cost/report.ts:198` derives
    `sidechainRequests` from `isSidechain`, and the observation carries
    `originatedRequestIds` — so the scorer can compute the share for exactly
    those ids. **It must, or this bullet is a paragraph.**
- **AMENDED 2026-08-06 — the cost meter is INFRASTRUCTURE, not a delivery that
  must pay for itself. The deliveries under this criterion are TWO: `gate` and
  `repair`.** Nothing above this line has been edited; "Those are now three" is
  the pre-amendment text and is left standing.

  **The owner made this call, and the timing is the whole of its legitimacy.**
  The bullet above says the choice must not be made after seeing `R`, because
  choosing a criterion to fit a result is the failure this file exists to
  prevent. B12 has not run. There is no `R`, no observation, and no scorer that
  could produce one — so the criterion is being fixed while its answer is
  strictly unknowable, which is the only condition under which fixing it means
  anything.

  **The argument, in the owner's words:** the meter suppresses nothing and emits
  no telemetry row, so it is an instrument, not a delegation tool. Keeping it
  named as a delivery means G-stop can never close — not because the project
  failed, but on a technicality about a thing that was never in the category.

  **What this does NOT do.** It does not lower the bar for the two that remain.
  Each of `gate` and `repair` must still individually pay for itself in the
  counterfactual accounting, and the first live reading is not encouraging:
  `evidence/2026-08-06-mac-b12-2eab63d.preflight.json` has `gate` at **−467.1
  units** on the scratch session — it cost more context than it suppressed, and
  the pre-repair clamped view would have printed `0`. One synthetic session with
  a one-line error proves nothing about a real task, but the sign is on the
  table before the run rather than after it.

  **The meter is not thereby exempt from evidence.** It is now judged as G1
  judges it — whether it counts the same tokens on both sides and prices them
  consistently — and G1 remains `open (reopened)`. What changes is that its
  verdict no longer gates this criterion.

- **AMENDED 2026-08-06, second amendment of that date — this criterion's 15%
  governs ONE OF THE PROJECT'S TWO VALUE AXES, and this names the other one so
  that a fall stops what it should and stops nothing else.** Nothing above this
  line has been edited, the first amendment of today's date included; it stands
  exactly as written, and so does the pre-amendment text it left standing.

  **The owner made this call, and the timing is the whole of its legitimacy.**
  The condition the first amendment rests on holds here and is the only thing
  that makes this legitimate: B12 has not run, there is no `R`, and the scorer
  that could produce one does not exist. The frozen design pre-authorised this
  exact branch — `whatAHoldDoesNotEstablish` item 2 says G-stop is *either*
  amended to name the deliveries it can be evaluated on *or* B12's hold is
  recorded as a partial answer, and that "deciding that after seeing `R` would be
  the outcome switching this premise exists to forbid." There is no
  retract-and-re-register clause in that design and this needs none: `ROADMAP.md`
  is a governance document, not a VOID-4 frozen item. What VOID 4 freezes is
  numbers and definitions, and none is touched below.

  **The argument, in the owner's words:** two different things were built here
  and only one of them is a cost lever. `gate` and `repair` move billed context,
  and B12 is the right instrument for them. The output and context pre-flights
  are not cost levers at all — they were on no roadmap, they fell out of `D8`,
  and what they bought is **output integrity**: `run 2026-08-04-mac-12-variance`
  returned a properly closed `<file>` block carrying `finish_reason: "stop"` and
  missing 90 lines, with every signal in the pipeline reporting a healthy
  response. Judging that by a context-economy ratio would be measuring a seatbelt
  by its fuel consumption.

  **THE SECOND AXIS IS JUDGED ON ONE OF ITS TWO HALVES, AND THE OTHER HALF HAS
  NO JUDGE. This is the sentence that keeps the amendment from being an escape
  hatch, so it is stated before anything favourable.** B16 covers the ADMISSION
  half — "no request the pre-flight admits comes back with content missing" — and
  is **holding, 0 of 52 admitted requests**, across two non-void runs. It says
  nothing whatever about the REFUSAL half: whether the pre-flights refuse work
  that would have fit. B16's own text carries that mode **"WITHOUT a threshold,
  deliberately"** (`PREMISES.md`), because `run 2026-08-04-mac-16-preflight`
  observed it — a 26,345 B pair measuring 11,237 actual tokens, refused — and
  giving it a threshold after seeing it would be the identical error B16 exists
  to correct. § G7 above says the same from the other side: its two non-void runs
  refused nothing, so they "say nothing at all about the refusal side."
  **Consequence, written here rather than discovered later: after this amendment
  nothing in this registry can return the verdict "these pre-flights refuse too
  much."** Acquiring a judge for it means a new premise with its number written
  before its next data — never an inference from this page, and never from B16's
  holding half. **And this axis is NOT B4's question.** B4 asks whether
  suppression reduces task success and is `moot`; this asks whether a whole-file
  answer arrives intact. Two different things that the English word "correctness"
  would have merged.

  **What this does NOT do, and this paragraph is the whole of the amendment's
  honesty.** It does not lower the bar for `gate` or `repair`: each must still
  individually pay for itself, at the same 15%, on the same instrument, and the
  only live reading there is has `gate` at **−467.1 units**. It does not move
  15%, 30%, `Holds if`, `Falls if`, the outcome, the unit definition, the
  admission rule or the metric arithmetic — every one of those is a VOID-4
  absolutely-frozen item and this amendment touches none of them. And above all
  **it is not a licence to keep building.** The output-integrity axis is a
  DELIVERED result, already paid for and measured on the half that has a judge.
  It survives a fall as a **finding**, not as a mandate. If B12 falls, what stops
  is the context-economy programme — G3, G4, and any further investment in `gate`
  or `repair` as cost levers — and **that axis stops too, in the only sense that
  is actionable: no new work may be started on it either.** Anyone wanting to build
  further on it needs a new gate with its own pre-registered number, under the
  ceiling of six active gates, which is full today (G3, G4, G5, G6, G7, G-stop).
  **"The other axis is fine" is not a reason to continue and may not be cited as
  one.**

  **A seam is named here rather than left for the verdict session to improvise.**
  The frozen design's `instrumentPrecedence` table still carries "NOT closable
  overall (the meter has no `R_d`)" in the cell where every other condition
  passes — a THREE-delivery world, written before this morning's first amendment
  reduced the deliveries to two. So the ROADMAP and the sealed JSON now disagree
  about how many deliveries this criterion names. The JSON is frozen by sha256
  and is not being edited. The disagreement is recorded here, in the governance
  document, because that is where a reader will look. **Which of the two governs
  is NOT decided by this amendment** — it is a real question, and whoever needs
  the answer should write it here *before* the verdict rather than inside it.

- **ERRATUM 2026-08-07 — the first amendment says `G1 remains open (reopened)`,
  and that was false when it was written.** Not stale: wrong on the day. G1 was
  closed again by B20 holding in `f6bf400` at 12:03; the amendment landed in
  `4dbcffe` at 21:37 the same day, nine hours later. Neither amendment is edited
  — both stand exactly as written, which is this section's whole discipline — so
  the correction is recorded here instead. **What it changes for a reader:** the
  reopening condition's ban, "nothing meter-derived may be measured until it
  agrees", is **lifted**, and has been since `f6bf400`. B12 and anything reading
  `savedFraction` are no longer blocked by it. **What it does not change:** the
  amendment's actual conclusion — that the meter is judged as G1 judges it and
  its verdict does not gate this criterion — is untouched, because that
  conclusion never depended on which side of open/closed G1 was sitting on.

---

## Not on the roadmap, and why

- **`dispatcher/` in Python, LangChain** — no gate, so it cannot be written.
  Everything above fits the TypeScript server that already exists.
- **Per-agent local model routing** — blocked upstream by
  [claude-code#38698](https://github.com/anthropics/claude-code/issues/38698);
  `ANTHROPIC_BASE_URL` is session-wide. MCP is the only path today.
- **`CALIBRATION.md`** — out of scope by decision, recorded in `DECISIONS.md § v3`.
