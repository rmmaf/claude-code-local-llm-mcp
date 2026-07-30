# local-coder — full setup & calibration prompt

This file is a task prompt. Paste everything below the rule into a Claude Code session
running **on the machine that hosts LM Studio**, using the strongest model available to you
(Opus-class recommended): authoring discriminative tasks and reading diffs against specs is
the quality bottleneck of the whole calibration. The local models are the test subjects,
never the executor — most of the wall-clock is local inference, which costs you nothing.

---

# Task: set up and calibrate a local-coder MCP delegation stack

You are configuring this machine so Claude Code can delegate coding work to local LLMs
running in LM Studio, via the `local-coder` MCP server — and calibrating every local model
with a multi-dimensional test battery, so the final catalog reflects how these models
actually behave on this machine, not their marketing copy. Work through the phases in
order. Do not skip the calibration phases.

Deliverables:
1. `~/models.csv` — the model catalog; each `objective` is model-selection guidance.
2. A user-scope `mcpServers` entry for `local-coder` pinned to that CSV, with
   `LOCAL_CODER_TEMPERATURE=0`.
3. A `## Available local LLMs` section in `~/.claude/CLAUDE.md` with a selection rule and a
   delegation policy.
4. A calibration lab (suggested: `~/local-coder-lab/`), git-committed, containing the frozen
   battery, the harness, `results.csv`, and `summary.md` — so calibration can be re-run.
5. A final report: chosen default, `AVOID` list with evidence, surprises vs the model cards.

Report findings as you go. Ask me only if something is genuinely ambiguous.

## Ground rules (they apply to every phase)

1. **Determinism envelope.** Every MCP call runs with `LOCAL_CODER_TEMPERATURE=0` — it is
   the only numeric env var the server accepts `0` for. Every direct API call sends ALL
   sampling parameters explicitly (`temperature: 0`, `top_p: 1`, `top_k: 1`, an explicit
   `max_tokens`): LM Studio's per-model defaults differ, and its `preset` request field
   silently ignores sampling parameters. Even then, quantized runtimes are not
   bit-reproducible — stability is measured (Phase 4), never assumed.
2. **Sequential, isolated, verified.** One model at a time. `~/.lmstudio/bin/lms unload
   --all` between models, then confirm with `lms ps` — do not trust JIT TTL or Auto-Evict.
3. **The `lms` CLI is not on PATH in non-interactive shells.** Use the absolute path
   `~/.lmstudio/bin/lms` in every script you write.
4. **Anti-contamination.** Local models have memorized the famous problems: fibonacci,
   two-sum, FizzBuzz, palindromes, anagrams, roman numerals, rate limiters, LRU caches, and
   everything shaped like Exercism or LeetCode. Never use one. Reuse the *invariant shapes*
   the recipes prescribe, transplanted into a novel surface domain, with changed boundary
   conventions, return shapes, and error contracts. The spec must differ, not just the
   names — so that memorized recall produces a plausible but failing answer.
5. **Budget cap.** Every call has a timeout (server default 300 s — `llm_timeout`). No model
   gets more than 2× its per-item time budget; a runaway loop is a finding, not a reason to
   wait.

## Phase 0 — Discover the environment

- Confirm LM Studio's server is reachable. `curl -s http://localhost:1234/v1/models` lists
  the exact API ids.
- Query the richer namespace too: `GET /api/v0/models` adds per-model `arch`,
  `quantization`, `max_context_length`, and `state` (loaded / not-loaded). And
  `POST /api/v0/chat/completions` returns a `stats` object (`tokens_per_second`,
  `time_to_first_token`, `stop_reason`) — free metrics. Prefer `/api/v0` for every direct
  probe in this calibration.
- `~/.lmstudio/bin/lms ls` gives on-disk sizes; `lms ps` shows what is loaded.
- Get total RAM and a realistic free figure — this decides how many models can co-reside.
- Exclude embedding models (`text-embedding-*`) from everything that follows.

Deliverable: an environment table — API id, arch, quant, size on disk, declared max
context, and total/free RAM.

## Phase 1 — Register the server and build the harness

The server is `github:rmmaf/claude-code-local-llm-mcp` (stdio transport). Register it at
user scope so it is available in every project (`claude mcp add` defaults to the current
directory only):

    claude mcp add local-coder -s user \
      -e LOCAL_CODER_MODELS_CSV=$HOME/models.csv \
      -e LOCAL_CODER_TEMPERATURE=0 \
      -- npx -y github:rmmaf/claude-code-local-llm-mcp

Verify with `claude mcp list` and `claude mcp get local-coder`.

Two facts that will otherwise waste your time:
- **The server parses the CSV once at startup.** Editing `models.csv` does nothing until
  Claude Code restarts (`claude -c` keeps the conversation). It is a stdio child process of
  Claude Code: killing the PID disconnects the tool without reloading anything, and there
  is no `claude mcp restart`.
- **The server's root is its process cwd.** All file arguments are paths relative to that
  root; absolute paths, `..` escapes, and symlinks out of the root are rejected.

Because of both facts, the calibration does NOT run through the registered instance. Build
a small harness in the lab directory instead — spawning the server per call gives a fresh
CSV read, a root you choose, and per-call env (required for the Phase 4 token-budget
sweep):

- `harness/mcp_call.py` — spawns `npx -y github:rmmaf/claude-code-local-llm-mcp` with
  **cwd = the lab directory** and env overrides passed per call; speaks newline-delimited
  JSON-RPC on stdio: `initialize`, then `notifications/initialized`, then `tools/call` with
  `{"name": ..., "arguments": {...}}`; ignores stderr (server logs); prints the result.
  Tool results arrive as `result.content[0].text` containing a JSON payload — parse that.
  When `isError` is true the text is `{"error": {"code", "message", ...details}}`.
- `harness/direct_probe.py` — `POST /api/v0/chat/completions` with explicit sampling
  (ground rule 1); records `stats`, `finish_reason`/`stop_reason`, and token usage.

**Parser trap — applies to every direct probe.** Reasoning models return chain-of-thought
in `choices[0].message.reasoning_content` (some models: `.reasoning`), and that field can
contain raw, unescaped control characters. Python's `json.loads` is strict by default and
dies with `Invalid control character`. Parse with `json.loads(raw, strict=False)`, read
bodies with `errors="replace"`, and read `reasoning_content` separately — `content` holds
the answer. Note the MCP server itself reads **only** `content`: a model that answers only
in `reasoning_content` fails delegation even though it looks fine in chat.

The server exposes five tools: `implement(spec, files[], context_files[]?, model?, mode?)`,
`fix(…same + error_output)`, `scaffold(spec, target_path, model?)`, `models`, and `status`.
`status.config` echoes the effective configuration — the cheap self-check that your env
overrides actually landed.

Deliverable: registration verified, plus both harness scripts proven with one `status` call.

## Phase 2 — Build the first draft of the CSV

Format: two columns, no header, `model,objective`, objectives double-quoted; a leading `#`
makes a row a comment.

    # local-coder model catalog — model,objective
    <api-id>,"<objective>"

- Use the **exact** API ids from `/v1/models`. In the `models` tool, `available_match:
  "fuzzy"` or `"none"` means a typo — fix it now.
- Catalog order is the server's fallback pick, so keep it best-first. You do not know the
  best order yet — Phase 6 fixes it.
- Draft objectives from what you know of each model. They are placeholders; Phase 6
  rewrites them from measurements.

## Phase 3 — Author the test battery (before touching any model)

You author every task yourself, now, from the recipes below. Recipes give the invariant
shape and the mandatory checks; you invent the surface domain (ground rule 4). The battery
is frozen before the first run so every model faces identical tasks.

Lab layout (a git repo):

    ~/local-coder-lab/
      harness/             mcp_call.py, direct_probe.py, scorers/
      items/<ID>/          pristine sources, spec.md, tests/ (stdlib unittest only), score.py
      runs/<ts>/<model>/   raw responses, server diffs, score JSON   (gitignored)

`git init`, add a `.gitignore` for `runs/`, and commit — restoring between runs is
`git checkout -- items && git clean -fd items`. Tests use only the standard library
(`unittest`); do not assume pytest exists.

Authoring discipline — this is where calibrations are won or lost:
- **Thick, adversarial tests.** Rigorous edge-case suites drop measured pass rates by
  19–29% and *reorder* model rankings (EvalPlus, arXiv:2305.01210); thin suites make a 7B
  and a 30B look identical. Every functional item gets 15–25 named asserts, including
  empty input, zero-sized config, boundary-exact values, and state-after-rejection.
- **Novel domains only.** Contamination is measured and severe: models drop from ~60% to
  ~0% on problems released after their training cutoff (LiveCodeBench, arXiv:2403.07974).
- **Deliberately absent axes**: no diff-syntax probes (the server's contract is whole
  files — the model never writes diffs) and no tool-calling probes (the local model never
  calls tools; it only returns file blocks).

Each recipe: Intent / Build / Score / Calls. G* = gate items, S* = survivor battery,
F* = finalist probes, O* = optional.

### G1 — aliveness and operational profile (direct API)

- Intent: does it respond; where does reasoning go; what does loading cost.
- Build: one trivial one-word-answer prompt, `max_tokens: 300`.
- Score: non-empty `content`; **reasoning signature** — which of `content`-with-`<think>`,
  `reasoning_content`, `reasoning` is populated; unusual prompt-token overhead (a shipped
  preset system prompt shows up here); cold-load seconds (verified-unloaded → first
  response) vs a second warm call; TTFT and gen tok/s from `stats`.
- Calls: 2 direct (1 cold, 1 warm; discard the warm-up from all averages).

### G2 — execution prediction (CRUXEval-shaped; doubles as first contract probe)

- Intent: separates models that *trace* code from models that pattern-match — cheap and
  discriminative (arXiv:2401.03065). Known-hard spots: `rsplit`, `rfind`, `maketrans`,
  negative-step slices — include 2–3.
- Build: `items/G2/answers.py`, a stub of `ANSWER_1: object = None` … `ANSWER_N` (N =
  8–12). The spec embeds N novel micro-functions (4–10 lines: a loop mutating state under a
  condition — accumulator resetting on a sentinel, index that skips; no imports, no floats,
  args of length ≤ 3) each with one concrete input, and asks the model to replace each
  `None` with the literal value that call returns.
- Score: import the returned file; compare every `ANSWER_i` against actually executing the
  reference — k/N exact matches. Also your first `<file>`-contract datapoint: malformed
  output or a verbatim echo here (success with `files_changed: []`) is an early red flag.
- Calls: 1 `implement`.

### G3 — contract micro-edit (run 3×)

- Intent: can the model follow the whole-file output contract at all, and is it stable.
- Build: one novel ~40-line file with two functions; the spec demands a small behavioural
  change in one and says the other must remain untouched.
- Score, per run: outcome; on `model_output_malformed`, classify `details.problem` **by
  substring** — it is a prose sentence, not an enum: contains "truncated" (ran out of
  output budget), `no valid <file> blocks` (contract not followed), or "did not include
  every declared editable file" (partial output). Verbatim echo = a *success* result with
  an empty diff — treat it as a failure signal. Retry detection: the server makes exactly
  one silent corrective retry and sums `usage` across attempts, so `prompt_tokens` ≈ 2× the
  other runs means attempt 1 failed. Report each signal as k/3.
- Calls: 3 `implement`, identical arguments.

### S1 — stateful generation with interacting invariants

- Intent: holistic class generation over shared mutable state — the axis where model size
  and quality actually show (ClassEval, arXiv:2308.01861).
- Build: one class, 3–5 interdependent methods, novel domain, delivered as a stub file
  (real signatures and docstrings, every body `raise NotImplementedError`). The spec must
  contain BOTH: (a) a value that clamps at a bound AND a piece of state that must NOT
  advance when the clamp fires; (b) an idempotence or rejected-path invariant (a repeated
  identical call must not double-apply; a rejected call leaves all state untouched). State
  the exact `<` vs `<=` boundary behaviour in prose.
- Score: named asserts passed / total (15–25, with adversarial cases: empty, zero
  capacity, time moving backwards, exactly-at-boundary). Partial credit is diagnostic
  only — the item passes only if all pass.
- Calls: 1 `implement`.

### S2 — localized edit with preservation

- Intent: the #1 practical failure of small models in whole-file mode — elision ("lazy"
  placeholder comments silently destroying code) and collateral damage (Aider measured
  format/prompt effects moving a refactor benchmark from 20% to 61%).
- Build: one novel 120–200-line file: 1 target function + 3–4 non-trivial neighbours (one
  with a docstring, one with a nested helper, one with a tricky literal — a regex or
  triple-quoted string). Spec: a localized behavioural change to the target, phrased
  descriptively ("change X so that it does Y").
- Score — four independent binaries: (1) fail-to-pass: the new-behaviour tests pass;
  (2) pass-to-pass: the neighbours' pre-existing tests still pass; (3) preservation: the
  AST check below — every untouched function byte-identical in `ast.dump`, no lazy
  placeholder comments; (4) scope: the server-computed diff touches only the target
  function's line range.
- Calls: 1 `implement`. Finalists re-run it later with *lazy* phrasing ("make Y possible")
  — the descriptive-vs-lazy delta is a real capability axis (CanItEdit, arXiv:2312.12450).

### S3 — constraint adherence overlay

- Intent: instruction compliance measured separately from correctness — compliance is
  consistently the lower number (IFEvalCode, arXiv:2507.22462), and *negated* constraints
  are the ones small models systematically ignore (arXiv:2310.15941).
- Build: an S2-shaped edit task whose spec adds 3–4 machine-checkable constraints, phrased
  negatively: "do not add imports", "do not modify `<function>`", "preserve every existing
  docstring verbatim", "keep the public API unchanged".
- Score: a `check_instruction` scorer, pure AST, independent of the tests: import set
  unchanged; `ast.dump` of the protected function identical; `ast.get_docstring` of every
  module/class/function identical; top-level names and signatures unchanged. If — and only
  if — a constraint fails, re-run once with positive phrasing ("use only already-imported
  modules"): a pass on the flip attributes the failure to negation-parsing, which belongs
  in the objective text.
- Calls: 1 `implement` (+1 conditional).

### S4 — single-bug repair via `fix`

- Intent: the repair loop is local-coder's core loop; measure it, don't assume it.
  Repairing is measurably harder than writing (HumanEvalFix, arXiv:2308.07124).
- Build: a correct novel module (~60–100 lines) with a passing suite; inject ONE subtle
  bug — off-by-one slice bound, `<` → `<=` in a clamp, argument mutated instead of copied,
  a deleted early-return guard, or an accumulator initialized outside a loop that must
  reset inside. Run the tests; capture the REAL `unittest` stderr verbatim.
- Score: fail-to-pass (the bug's test now passes) AND pass-to-pass (everything else still
  passes — this is what blocks "fixing" by deleting the logic); diff confined to the buggy
  function.
- Calls: 1 `fix`, `error_output` = the captured stderr.

### S5 — repair delta (conditional)

- Intent: pass_rate_1 vs pass_rate_2, aider's two-attempt protocol — some models are
  decent one-shot and useless in the loop. This number underwrites the "escalate after 2
  failed attempts" policy.
- Build: nothing new. If S1 or S2 failed its tests, take that model's own failing artifact,
  capture the real test output, and call `fix` once on it.
- Score: pass after repair; `repair_delta` = passes-after-fix − passes-before, per model.
- Calls: ≤ 2 `fix`.

### S6 — cross-file dependency

- Intent: does the model actually use `context_files`? Construction must *guarantee* the
  cross-file fact is required (CrossCodeEval, arXiv:2310.11248), or the item measures
  nothing.
- Build: 3–4 novel files, < 250 lines total: `constants.py` with a non-obvious sentinel,
  `utils.py` with a helper whose signature is surprising (e.g. a keyword-only flag),
  `base.py` with an abstract method; the editable file implements against them, and the
  correct implementation is underivable from the editable file alone.
- Score: the tests `unittest.mock.patch` the existing helper and assert it WAS called
  (reuse, not reimplementation); an AST check asserts no new function shadowing a
  context-file name; the sentinel is used by identity; pass-to-pass elsewhere.
- Calls: 1 `implement` with `context_files`. Finalists re-run WITHOUT `context_files`:
  the same score both ways means it never read the context; a collapse means it uses it.

### F1 — long-output integrity (finalists)

- Intent: sustained generation at the default 8192-token output cap without truncation,
  repetition, or elision.
- Build: one spec forcing ~4–6k output tokens across 2 editable files (e.g. a module plus
  its exhaustive table-driven test file).
- Score: outcome and `finish_reason`; retry detection; n-gram repetition ratio (helper
  below; flag > 0.3); the elision regex on both files; both files parse.
- Calls: 1 `implement`.

### F2 — effective context and prefill cost (finalists; DIRECT API ONLY)

- Intent: `safe_context_tokens` is a measured number, not the model card's: with no
  lexical overlap between question and needle, 11 of 13 tested models drop below 50% of
  their short-context baseline by 32k (NoLiMa, arXiv:2502.05167). Never run this through
  the MCP server — the whole-file contract would force the model to echo a huge file back;
  you would be measuring output budget, not retrieval.
- Build: realistic filler from real source files; one load-bearing fact at ~40% depth; a
  question that *paraphrases* (zero keyword overlap with the needle) and needs a ~10-line
  code answer. Prompt sizes ~8k / 16k / 32k tokens, capped by the model's *configured*
  context in LM Studio — silent truncation happens at that boundary.
- Score per size: answer correct; TTFT; prefill tok/s (≈ prompt_tokens / TTFT); gen tok/s.
  `safe_context_tokens` = the largest tested size still answered correctly.
- Calls: 3 direct.

### F3 — reasoning budget (reasoning-signature models only; finalists)

- Intent: reasoning models burn the output budget on thinking. Through this server the
  signature is `model_output_malformed` with a "truncated" problem — or `llm_bad_response`
  when `content` comes back null. The catalog needs `min_viable_max_tokens`.
- Build: re-run the G3 item via the harness, varying `LOCAL_CODER_MAX_OUTPUT_TOKENS` per
  spawn; binary-search 1k → 16k for the smallest cap that passes.
- Score: `min_viable_max_tokens`; thinking overhead ≈ its completion_tokens on a pass ÷
  the non-reasoning models' median on the same item. Optionally test once whether
  `/no_think` inside the spec suppresses thinking (a Qwen-style soft switch — verify,
  don't trust). Note in the catalog that template-level toggles (`chat_template_kwargs`)
  are NOT reachable through this server.
- Calls: ~4 harness calls.

### O1 — test generation (optional; the first thing to cut)

- Intent: the delegation policy routes test generation to local models — measure it.
- Build: give a correct novel module (S4's pristine version, as a context file); ask for a
  `unittest` suite in a new file. Hand-write 8–12 one-line mutants (flip a comparison,
  drop the clamp, off-by-one a bound, return input instead of copy, delete a guard).
- Score: **soundness** — the suite passes against the correct module (any failure asserted
  something the spec doesn't guarantee); **mutation score** — mutants killed / total, one
  subprocess run per mutant. Coverage is NOT the metric: 100%-coverage suites have been
  measured at 4% mutation kill rate (arXiv:2410.00752).
- Calls: 1 `implement`.

### Scoring helpers (write once, in `harness/scorers/`)

Preservation / elision — AST, no execution:

    import ast, re
    def fn_map(src):
        return {n.name: ast.dump(n) for n in ast.walk(ast.parse(src))
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
    # pass: every protected name still present AND its ast.dump unchanged
    LAZY = re.compile(r"\.\.\.|rest (of|remains|unchanged)|omitted|add .*logic here", re.I)

n-gram repetition ratio:

    def repeat_ratio(text, n=8):
        toks = text.split()
        grams = [" ".join(toks[i:i+n]) for i in range(len(toks) - n)]
        return 0.0 if not grams else 1 - len(set(grams)) / len(grams)

Retry detector: within one item, `prompt_tokens` > 1.7× the minimum observed for identical
arguments ⇒ the server's corrective retry fired (usage is summed across attempts).

### Meta-validation (mandatory before freezing)

1. Your own reference solution passes every suite of every item.
2. Every scorer is run once against a deliberately bad artifact (an elided function, a
   violated constraint, a wrong `ANSWER_i`) and must FAIL it — a scorer that cannot fail
   measures nothing.
3. `git add -A && git commit -m "freeze battery"`.

## Phase 4 — Run the battery

Per model, in this order:

1. `~/.lmstudio/bin/lms unload --all`; confirm empty via `lms ps`.
2. **Tier 0** — G1 cold + warm (~2 min). Record the operational profile.
3. **Tier 1** — G2 once, G3 three times (~4–7 min).
4. **Gate check** (thresholds in Phase 5). Failed → verdict `AVOID` with the evidence,
   unload, next model. One exception: a reasoning-signature model that failed only by
   truncation gets a single G3 retry at `LOCAL_CODER_MAX_OUTPUT_TOKENS=16384` before the
   verdict — its true budget is measured in F3 if it survives.
5. **Tier 2** (survivors) — S1 → S2 → S3 → S4 → S5 → S6 (~15–25 min). Between items:
   `git checkout -- items && git clean -fd items`. Save every raw result, server diff, and
   score JSON under `runs/<ts>/<model>/<item>/`.
6. Unload; next model.
7. After all models: pick 2–3 provisional finalists → **Tier 3** per finalist: F1, F2
   (direct), F3 (reasoning models), plus the deferred arms (S2 lazy phrasing, S6 without
   context), and O1 if time allows (~10–15 min each).

Rules of the run:
- k=3 is for G3 only. Expensive items run once; one re-run is allowed only for a
  surprising failure you suspect is a harness bug — never to shop for a pass.
- Latency numbers come from Tier 0 and `/api/v0` `stats` only; Tiers 1–2 measure
  pass/fail (JIT reloads pollute their timings).
- **Budget checkpoint**: when the first survivor finishes Tier 2, project total wall-clock
  from measured tok/s. If the projection exceeds ~3 h, cut in this order — O1, the
  deferred arms, F2's 32k point — and say so in the final report.
- **Read every diff against the spec, not just the test results.** A passing suite does
  not mean the spec was followed. If you find a latent bug the tests missed, add a
  regression test and re-run the already-scored models — the comparison must stay fair.
- If the catalog has the same model at two quants, run both through Tiers 0–2 and report
  the delta: this machine's A/B beats any published quantization table.
- Rough budget at 20–60 warm tok/s: a gated-out model ≈ 10 min; a survivor ≈ 30 min; a
  finalist +15 min. Six models ≈ 2.5–3 h, dominated by local inference.

## Phase 5 — Score, gate, rank

**Hard gates** — any one ⇒ `AVOID for delegation`, with an evidence line. Scope violations
gate rather than average, because a model that edits what it was told not to touch is
dangerous, not "pretty good":
- `model_output_malformed` in ≥ 2 of 3 G3 runs (the server already spent its corrective
  retry — this is post-retry failure);
- verbatim echo in ≥ 2 of 3 G3 runs;
- constraint or scope violations on more than 1/3 of checked items (S2 scope, S3
  constraints, S4 confinement);
- repetition loop (ratio > 0.3) or truncation at the default cap, still recurring after
  the reasoning-model exception;
- 2 or more `llm_timeout`s anywhere.

**Weighted score** for survivors — a declared starting point; tune it only with a reason,
and say so:
- 0.40 instruction & format adherence — G3 clean-run rate, S2 preservation+scope, S3
  compliance, inverted retry rate;
- 0.35 correctness — G2 fraction, S1/S2/S4/S6 binary passes;
- 0.15 reliability — G3 k/3 variance, timeout/truncation incidence, repetition flags;
- 0.10 speed — warm gen tok/s and per-item wall-clock (cold load is reported, unscored).

Ranking = the weighted score. Near-ties (< ~5 points) are settled by paired comparison on
the items where the two models disagree, in this order: format adherence > preservation >
compliance > completion tokens > latency. With ~15 items, absolute scores carry wide error
bars — the paired read on identical items is the defensible signal (arXiv:2411.00640).

Item hygiene: an item every model passed or every model failed carries zero ranking
information — keep it in `results.csv` marked `nondiscriminating`, exclude it from the
score, and redesign it next calibration.

`results.csv` — one row per model × item × run:

    ts, model, item_id, axis, tier, run_idx, condition, tool, outcome,
    asserts_passed, asserts_total, f2p, p2p, elision_ok, scope_ok, constraint_ok,
    preserve_ok, malformed_problem, retry_detected, echo, finish_reason,
    latency_ms, prompt_tokens, completion_tokens, ttft_s, gen_tps, notes

`summary.md` — per model: gate verdicts with evidence; the four subscores, total, rank; an
ops block (`cold_load_s`, warm tok/s, `ttft_s`, `safe_context_tokens`,
`min_viable_max_tokens`, reasoning signature, prompt-token overhead); and ≤ 3 bullets of
characteristic failures, each pointing at a `runs/` artifact.

## Phase 6 — Rewrite the CSV from measurements

The `objective` field is what Claude reads when choosing a delegate. Write decision
guidance — 1–2 present-tense sentences, ≤ ~40 words:
- a role tag: exactly one model gets `DEFAULT for implement and fix`;
- "right for: …" — named conditions (task type and size);
- "prefer X when: …" — the handoff condition to another model;
- "watch for: …" — the characteristic failure to look for in its diffs;
- numeric caveats only when binding: "needs max_tokens ≥ N", "unreliable past ~Nk context".

Banned: adjectives without conditions ("solid coder"), calibration narration ("in testing
it…"), and model-card claims you did not observe. Every score here is a property of
(model, quant, this harness) — write conditions, not compliments.

**Models that failed a gate are commented out with `#`, reason inline.** This matters:
when `model` is omitted, the server auto-picks the *largest* catalog model that fits free
RAM — an uncommented broken 30B would be selected first. Commenting removes it from
selection while keeping the finding visible.

Reorder best-first (catalog order is the fallback and the tie-break among equal fits).
Validate: the file parses as N rows × 2 columns, and a harness `models` call shows every
active row `available_match: "exact"`. (The README's "≤ ~15 words" guidance is for
bootstrap CSVs; calibrated objectives are worth the extra words.)

## Phase 7 — Write the CLAUDE.md section

Add `## Available local LLMs` to `~/.claude/CLAUDE.md`:

- A best-first table: API id, quant, size, cold-load s, warm tok/s,
  `safe_context_tokens`, `min_viable_max_tokens` (reasoning models), reasoning signature,
  one-line role.
- Total/usable RAM and which pairs co-fit for two concurrent delegates.
- **A "Choosing a model" rule keyed to measurements**: name the default; deviate when —
  subtle stateful invariant → the model that passed S1; large multi-file context → the
  best F2 model, within its measured `safe_context_tokens`; two concurrent agents → the
  two smallest co-fitting survivors; constraint-heavy edits → the best S3 model.
- The parser trap from Phase 1, and each model's reasoning signature.
- Operational notes: JIT loading and cold-load times, `lms unload --all` between
  sequential jobs, the absolute `lms` path, CSV read once at startup (edits need a
  restart), and that registration pins `LOCAL_CODER_TEMPERATURE=0`.
- **Ignore the `models` tool's `recommended` / `auto_selection` fields** — they pick the
  largest model that fits RAM, which is unrelated to task fit. Always pass `model`
  explicitly.
- The delegation policy: delegate multi-file implementations from a clear spec,
  boilerplate, test generation, mechanical refactors, docstrings; keep architecture, API
  design, subtle debugging, and security-sensitive code in Claude; never paste file
  contents into tool arguments — pass relative paths; route failing tests through `fix`
  with the verbatim test output; escalate to Claude after 2 failed local attempts, citing
  the measured `repair_delta` (repair never succeeded for a model → escalate after 1).
- A "landing a delegated diff" checklist: prefer `mode: "diff"` and apply the reviewed
  patch yourself with `git apply` — **`mode: "apply"` re-generates rather than replaying
  the diff you reviewed** (the server is stateless by design; temperature 0 narrows but
  does not close the gap). Review specifically (a) the preservation constraints, (b) the
  guard/clamp lines the spec called out, (c) lines outside the requested change.
- A re-calibration runbook: the lab path; the frozen battery commit; re-running Phase 4
  for one model against that commit; a newly downloaded model = add a CSV row, run its
  Tiers 0–2, re-rank, rewrite its objective.
- Keep claims proportionate to evidence. One observation is "observed once" — not
  "always fails".

## Phase 8 — Verify end-to-end

1. Restart Claude Code (`claude -c`) and call the `models` tool through the **registered**
   instance: objectives and order match the CSV; every active row is `available_match:
   "exact"`; sizes and `fits` are populated. If the old objectives come back, the server
   started without `LOCAL_CODER_MODELS_CSV` — check the `mcpServers` env and confirm with
   `status.config`.
2. Run one real `implement` through the registered instance on a scratch file in the
   current project. The battery ran on the spawned harness; this proves the registered
   path too — including that its root is the directory Claude Code runs in.
3. Report back: the chosen default and why; every `AVOID` with its evidence; per-model
   surprises vs the model cards; total calibration wall-clock; where the lab lives and how
   to re-run it.
