# local-coder — hybrid orchestration MCP server

**Keep build output out of Claude's context, and keep the fix loop off the metered API.**

`local-coder` is an MCP server that cuts what a Claude Code session costs. It does that by attacking the two things that actually dominate the bill — not by delegating the typing.

### Why the target is context, not generation

A token that enters Claude's context is paid for **once as a cache write** and then **re-read on every later request in the session**:

```
cost(token entering at turn t of a session running to T)
      = cache_write            (2.0x the input rate for a 1h cache)
      + cache_read x (T - 1 - t)   (0.1x, once per later request)
```

Measured on a real 69-request session with `npm run cost-meter`: a token entering at turn 0 cost **8.8x** the input rate, and the resident context grew from 33K to 449K tokens. The same session's bill split **48% cache write, 36% cache read, 16% output, 0.4% fresh input**.

So the ranking is forced:

| Lever | What it removes | Multiplier |
|---|---|---|
| Keep build/test output out of context (`gate`) | tokens x every later re-read | **up to 8.8x** |
| Collapse the fix loop into one call (`repair`) | whole turns, shrinking `T` for everything resident | **multiplicative** |
| Delegate the writing (`implement`) | generated tokens only — and the diff still enters context | **5x, once** |

Write-delegation is the *weakest* of the three and it is the one this project started with. It still ships, and still works, but it is no longer the headline.

```
Claude Code (orchestrator, metered API)
      │  stdio (MCP): gate / repair / locate ↓ · structured failures + one diff ↑
local-coder MCP server  ←→  project files + check commands on disk
      │  HTTP: OpenAI-compatible chat completions (repair loop only)
LM Studio · http://localhost:1234/v1  (MLX engine, JIT load + TTL unload)
```

Every suppression is **reversible**: full output is written to `.local-coder/spill/` and its path returned. This is not politeness — a published study measured an arm that removed 38% of tool-output tokens and cost **6.8% more**, dropping patch application from 27/40 to 15/40, because it destroyed the verbatim anchors edits depend on.

## Installation (macOS, step by step)

Target machine: any Apple Silicon Mac; the defaults are tuned for 36 GB unified memory (reference: MacBook Pro M4 Max). You need roughly **26 GB of free disk** for the two default models.

### 1. Prerequisites

- **Node.js ≥ 18** — check with `node --version`; install from [nodejs.org](https://nodejs.org) or `brew install node` if missing.
- **Claude Code** — the `claude` CLI you already use.
- **LM Studio** — download from [lmstudio.ai](https://lmstudio.ai), open it once (this installs the MLX engine on Apple Silicon).

### 2. Set up the LM Studio CLI (`lms`)

```bash
~/.lmstudio/bin/lms bootstrap   # adds `lms` to your PATH
lms --version
```

### 3. Start the server and enable JIT loading

```bash
lms server start                # serves http://localhost:1234/v1
```

In LM Studio's **Developer** tab, make sure **JIT model loading** is enabled and set a **TTL / auto-unload** so models load on demand and free your RAM when idle. With that on, you never load models manually — the first `implement` call loads the model, the TTL unloads it later.

### 4. Download one or more coding models

Download whatever coding models you want to choose between — for example:

```bash
lms get mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2   # ~17 GB
lms get qwen2.5-coder-14b-instruct                                # ~8.5 GB (or via the UI)
```

This is the only step that downloads from Hugging Face, and LM Studio handles it — installing the MCP server itself (next step) downloads no models. Afterwards run `lms ls` to see the exact identifiers you have; those go in the models CSV (see [Model selection](#model-selection)). With no CSV configured, the server falls back to a built-in default catalog of the two models above.

### 5. Install the MCP server into Claude Code

Pre-warm the build once in a terminal (the first `npx github:` run clones and compiles, which can exceed Claude Code's default 30 s MCP startup timeout):

```bash
npx -y github:rmmaf/claude-code-local-llm-mcp --version
```

Then register it:

```bash
claude mcp add local-coder -- npx -y github:rmmaf/claude-code-local-llm-mcp
```

Variants:

```bash
# available in every project, not just the current one
claude mcp add --scope user local-coder -- npx -y github:rmmaf/claude-code-local-llm-mcp

# with environment overrides
claude mcp add local-coder -e LM_STUDIO_URL=http://localhost:1234/v1 -- npx -y github:rmmaf/claude-code-local-llm-mcp

# pin a version
claude mcp add local-coder -- npx -y github:rmmaf/claude-code-local-llm-mcp#v0.1.0
```

If startup still times out, raise it: `MCP_TIMEOUT=120000 claude`.

### 6. Verify

Start `claude` in any project and ask:

> Run the local-coder status tool.

You should see `reachable: true`, your model catalog with each model's availability and size, your RAM numbers, and which model the memory-only fallback would auto-pick. If `reachable` is `false`, run `lms server start` and check again.

Prefer a guided, measured setup? [`CALIBRATION.md`](CALIBRATION.md) is a paste-into-Claude prompt that installs the server and calibrates every local model with a test battery before writing the catalog.

## How to use it

The division of labor: **you talk to Claude normally** — Claude decides (or you tell it) to delegate the mechanical typing to the local model.

**Delegate explicitly.** In Claude Code, say things like:

> Use local-coder to implement the CSV export function in src/csv.ts with tests in tests/csv.test.ts. Review the diff before applying.

Claude will write a tight spec, call `implement` with the two file paths (never the contents), get a unified diff back, review it, and either apply it or iterate. A typical unit goes:

1. Claude plans and writes a spec for one unit of work
2. `implement(spec, files, mode: "diff")` → the local model generates; the server returns a diff
3. Claude reviews the diff (cheap — it's just a diff) → applies it, or rejects with feedback
4. Claude runs your tests; failures go to `fix(spec, error_output, files)` — the repair loop stays local
5. After 2 failed local attempts on the same unit, Claude takes over that unit itself

**New files:** "Use local-coder to scaffold a `useDebounce` hook under src/hooks" → `scaffold` writes new files directly (it refuses to touch anything that exists).

**Delegation routing is installed for you.** On startup the server writes the policy below into your project's `CLAUDE.md`, because a routing rule that lives only in a README is a rule nobody applies — `run 2026-08-04-mac-10` is a real session that made 36 Bash verifications and zero `gate` calls against exactly this text, on a machine that had never installed it.

It is deliberately timid: it never overwrites, it appends rather than replacing if you already have a `CLAUDE.md`, it leaves the block alone once you have edited it, and it skips any directory without a `.git` or `package.json`. Set `LOCAL_CODER_AUTO_CLAUDE_MD=0` to turn it off, and check `status` for what it did. **Claude Code reads `CLAUDE.md` at session start, so the policy takes effect on your next session, not the one that installed it.**

The block, if you would rather paste it yourself:

```markdown
## Local delegation policy
- Verify with mcp__local-coder__gate, never by running lint/tsc/tests through
  Bash. One call runs them all and returns only structured failures.
- When the gate is red and the fix is mechanical (type errors, failing
  assertions, lint, missing imports), call mcp__local-coder__repair instead of
  fixing and re-testing yourself. It loops locally and returns one diff.
- Delegate new-file creation from a spec to mcp__local-coder__scaffold.
- Use mcp__local-coder__implement only for bulk mechanical authoring — it saves
  the smallest part of the bill.
- Keep in Claude: architecture decisions, API design, subtle debugging,
  security-sensitive code, and final review of every diff before apply.
- Never paste file contents into tool arguments — pass relative paths.
- Escalate to yourself after 2 failed local attempts on the same unit.
```

### The Bash output hook: measured, dead, do not install it

An earlier version of this project shipped a `PostToolUse` hook that condensed
Bash output before it entered the context. **It does not work, and you should not
install it.**

`hooks/filter-tool-output.mjs` still exists in this repo, unregistered and inert.
It condenses text correctly — 604 lines to 4 on a failing test run — and that was
never the question. The question was whether `hookSpecificOutput.updatedToolOutput`
changes what Claude Code actually *stores and bills*, and the answer, measured, is
no: on a real command the hook ran, filtered 30,136 bytes down to 8,462, wrote its
spill file — and the transcript recorded 30,000 characters of raw output anyway.
The replacement never arrived.

The most likely reason is a shape mismatch: the hook returns `updatedToolOutput`
as a bare string, while a Bash result is `{stdout, stderr, interrupted, isImage}`.
That is a cheap thing to retest, and the retest is written into `ROADMAP.md` as
`G2`'s reopening condition — one attempt, threshold fixed in advance. Until a run
clears it, nothing here should be installed and no saving may be attributed to it.

**This costs you very little.** Across five real sessions, Bash was between 1.7%
and 13.8% of all tool-result bytes, and most of that is `npm test` / `tsc` / `git`
output — exactly what `gate` already handles, structurally, by parsing rather than
truncating.

## Measuring what it saves

From a clone of this repo:

```bash
npm run cost-meter
```

Without one — it ships as a binary, so `npx` can run it against any project:

```bash
npx -y -p github:rmmaf/claude-code-local-llm-mcp local-coder-cost-meter
```

Reads Claude Code's own transcripts, so it reports **billed** quantities rather than estimates. Per session it prints the cost split, the context-growth curve, the multiplier a turn-0 token carries, which tools put the most bytes into context, and — once the local tools have run — an estimated saving per tool joined from `.local-coder/telemetry.jsonl`.

```bash
npm run cost-meter -- --last 5 --json
```

Fill in `models[...].inputPerMTok` in `.local-coder/rates.json` to see dollars; without it the report uses input-equivalent units, which are exact and are what the comparison actually needs.

> Dollar figures are withheld unless **every** billed request in the session has a configured model price. A session that mixes a priced main model with an unpriced subagent model reports `null` rather than a partial sum wearing the label of a total.

**What to expect:** the first call after idle time is slow (JIT loads ~17 GB into memory — tens of seconds), subsequent calls are much faster; a multi-file generation can take minutes on a 30B model. Everything heavy happens locally; your Anthropic bill sees only specs and diffs.

> **Note on `mode: "apply"`:** the server is stateless, so `apply` re-runs generation before writing rather than replaying the previously returned patch. At temperature 0.1 the output is normally the same, and the `apply` response includes the diff of what was *actually* written — have Claude confirm it matches the reviewed diff. For a byte-exact guarantee, have Claude apply the reviewed patch itself (`git apply`).

## Configuration

All environment variables are optional, with sane defaults:

| Variable | Default | Purpose |
|---|---|---|
| `LM_STUDIO_URL` | `http://localhost:1234/v1` | OpenAI-compatible base URL |
| `LOCAL_CODER_MODELS_CSV` | *(built-in default catalog)* | path to the model catalog CSV (see [Model selection](#model-selection)) |
| `LOCAL_CODER_MEM_FIT_FRACTION` | `0.85` | fraction of free RAM a model's on-disk size may occupy to count as "fits" |
| `LOCAL_CODER_TEMPERATURE` | `0.1` | sampling temperature |
| `LOCAL_CODER_MAX_OUTPUT_TOKENS` | `8192` | completion cap |
| `LOCAL_CODER_TIMEOUT_MS` | `300000` | per-request timeout (local models are slow on big generations) |
| `LOCAL_CODER_MAX_FILE_KB` | `256` | per-file size cap |
| `LOCAL_CODER_MAX_CONTEXT_KB` | `512` | total assembled-context cap |
| `LOCAL_CODER_CONTEXT_TOKENS` | *(probed from `lms ps`)* | the loaded model's context window, shared by prompt **and** answer. Cross-checked against `lms ps`, and the smaller wins — see below |
| `LOCAL_CODER_INPUT_BYTES_PER_TOKEN` | `3.9` | bytes of prompt per input token, for the context pre-flight |
| `LOCAL_CODER_AUTO_CLAUDE_MD` | `1` | write the delegation policy into the project's `CLAUDE.md` at startup (see below); `0` to leave the file alone |

### The context window is the real ceiling

`LOCAL_CODER_MAX_OUTPUT_TOKENS` bounds the answer. It does **not** bound the request, because the prompt and the answer share one context window — and the whole-file output contract sends every editable file in *and* gets every one back, so a request costs roughly **twice** the bytes it touches.

A pre-flight refuses requests that cannot fit, with `context_would_overflow`. It needs to know the window, and it asks both sources:

1. `LOCAL_CODER_CONTEXT_TOKENS`, if set.
2. `lms ps`, when exactly one model is loaded (or the one you named is).
3. **When both answer, the smaller wins**, and a disagreement is logged.
4. When neither does, **the check is skipped** — it refuses requests, so it will not act on a guess.

Rule 3 is there because a model explicitly loaded at 32,768 was later found loaded at 16,384 — the default — with nothing reconfigured. The setting is a belief; `lms ps` is an observation. Too small costs a refusal you can retry; too large costs content nobody notices is gone.

Run `status` to see which happened: `context_window.source` is `config`, `lms`, `disagreement`, or `unknown`, and `configured_tokens` / `probed_tokens` show both sides. `unknown` means nothing is enforcing the window; `disagreement` means one of your two numbers is stale.

Measured on a 30B coder at a 16,384-token window, the practical whole-file ceiling is **~25 KB of editable source per call**. Above it, the model does not necessarily fail loudly: `evidence/2026-08-04-mac-12-variance.contract-stability.json` records a 35.6 KB file coming back as a properly closed `<file>` block, with `finish_reason: "stop"`, **missing 90 lines** — a response every automated check accepts. Reload with a larger context (`lms load --context-length`) and set `LOCAL_CODER_CONTEXT_TOKENS` to match, or send fewer files per call.

**The reload is not a workaround, it is the fix, and it is measured.** The same 43.6 KB file that came back short at 16,384 returns **complete** at 32,768 (`evidence/2026-08-04-mac-20-32k.contract-stability.json`): it needs 10,321 output tokens and only ~5,835 were left after its prompt at the smaller window. At 32,768 the estimator's ceiling works out to roughly **~54 KB** of editable source per call, and the whole 13-case corpus returned 26 of 26 complete.

**And verifying once is not enough.** The drift above was observed *between* two checks, so the number you confirmed at the start of a long job can be wrong by the end. Give a benchmark the machine to itself: memory pressure from anything else running can take the model down and bring it back smaller.

**What the window costs you, on this repository.** A file plus its test is the natural unit for `repair` and `fix`, and the per-call ceiling decides how many of those fit:

| Loaded window | Ceiling per call | Source+test pairs refused | Single files refused |
|---|---|---|---|
| 16,384 | ~26.8 KB | **5 of 15 (33%)** | 2 of 30 (7%) |
| 32,768 | ~54.0 KB | 1 of 15 (7%) | 0 of 30 |

Raise it where it is real — LM Studio's per-model default load context — rather than in `LOCAL_CODER_CONTEXT_TOKENS`. The setting only takes effect when `lms ps` cannot answer, and that is exactly when the model is *not* loaded and JIT will bring it up at the default anyway.

**Why "the default" and not what you loaded:** LM Studio's `justInTimeModelLoading` (in `~/.lmstudio/.internal/http-server-config.json`, on by default) reloads a model the server is asked for but does not have — at the model's *default* context, not at whatever your last `lms load --context-length` requested. So an explicit 32,768 silently becomes 16,384 after any unload, with nothing reconfigured. Turning JIT off makes that loud: the server errors instead of serving a differently-configured model.

## Model selection

`local-coder` picks which local model to run from a **catalog** you define, weighing two things: **what each model is for** (its objective) and **whether it fits the free RAM** on the machine right now.

**The catalog** is a headerless CSV with two columns — the model name exactly as LM Studio references it, and a short English description of what it's good for:

```csv
mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2,Large capable general-purpose code generation and multi-file refactoring
qwen2.5-coder-14b-instruct,"Smaller, faster coding model for low-memory situations or concurrent agents"
```

Point `LOCAL_CODER_MODELS_CSV` at it — a relative path resolves against the project root. Three rules:

- Keep the model column **byte-identical** to what `lms ls` prints, so sizes line up.
- Double-quote any objective containing a comma; blank lines and `#` comments are ignored.
- With no CSV set, the server uses a built-in default catalog (the two models above).

A sample lives in [`models.example.csv`](models.example.csv).

**How a model gets picked.** Claude Code drives the choice:

1. Claude calls the **`models`** tool, which returns each catalog model with its objective, whether LM Studio has it, its size on disk (from `lms ls`), whether it fits current free RAM, and — for N concurrent agents — a recommended set that fits together.
2. Claude matches the objective to the task at hand and passes the chosen model name as the `model` argument to `implement` / `fix` / `scaffold`.
3. If a work tool is called **without** `model`, the server falls back to the largest catalog model that fits free RAM (objective matching is Claude's job, via the `models` tool).

**How "fits" is decided.** A model fits when `size ≤ free RAM × LOCAL_CODER_MEM_FIT_FRACTION` (default `0.85`). Treat it as advisory, not a guarantee:

- A model's runtime footprint (KV cache, context) runs larger than its on-disk weight, and on macOS the GPU wired limit can still block a load — so a positive fit is *necessary, not sufficient*.
- Sizes come from the `lms` CLI. If `lms` isn't on the server's PATH, sizes and fit read as `null`, and selection falls back to catalog order.
- Free RAM is read on macOS via `memory_pressure` (falling back to `vm_stat`); elsewhere via Node's `os.freemem()`, which excludes reclaimable cache on Linux — so `fits` is conservative there.

To set the CSV path at registration time (add `--scope user` to make it available in every project):

```bash
claude mcp remove local-coder

claude mcp add --scope user local-coder \
  -e LOCAL_CODER_MODELS_CSV="$HOME/.config/local-coder/models.csv" \
  -- npx -y github:rmmaf/claude-code-local-llm-mcp
```

If `claude mcp remove` reports it can't find the server, run `claude mcp list` to see which scope it's registered in and remove it from there (`claude mcp remove --scope local local-coder` forces the project scope).

### Generating the models CSV

Have Claude Code build the CSV for you from a plain list of model names (one per line, e.g. what `lms ls` shows), using the [Hugging Face MCP tools](https://huggingface.co/settings/mcp) to research each model's intended use. Put your model names in a `models.txt` (see [`models.example.txt`](models.example.txt)) and paste this prompt:

> I have a file `models.txt` with one LM Studio model name per line. Create `models.csv` — a headerless CSV with two columns, `model,objective` — with one row per input line.
>
> For each model name: use the Hugging Face MCP tools (`hub_repo_search`, then `hub_repo_details`) to find its repository and read its `pipeline_tag`, tags, and model-card summary. The name may carry a publisher prefix and quantization/format suffixes (e.g. `4bit`, `dwq`, `mlx`, `GGUF`, `Q4_K_M`, version suffixes) — strip those to search, and confirm the right repo by downloads/tags.
>
> Write `objective` as one concise English phrase (≤ ~15 words) describing what the model is best used for (e.g. "General multi-language code generation and refactoring", "Small fast coding model for low-memory or concurrent-agent use"). Keep the `model` column **byte-identical to the input line** so it matches LM Studio exactly. Double-quote any objective containing a comma. Never drop a line — if you can't find a model on Hugging Face, write a best-guess objective from its name. Output only the CSV rows, no header.

Then set `LOCAL_CODER_MODELS_CSV` to the file's path and run the `models` (or `status`) tool to confirm availability, sizes, and fit.

This gives you a bootstrap catalog from model cards. To write objectives from **measured behaviour** instead — a per-model test battery covering contract adherence, editing, bug repair, constraints, and context handling — run the calibration prompt in [`CALIBRATION.md`](CALIBRATION.md).

## Tools

The file-writing tools (`repair`, `implement`, `fix`, `scaffold`) take **relative file paths only — never file contents**; the server reads files from disk itself, and pasting contents into arguments defeats the whole design. `status` and `models` are read-only diagnostics.

### `gate`

Runs the project's lint / type-check / test commands and returns **only structured failures** — path, line, code, message — deduplicated, ranked so located failures survive the cap, with the full raw output spilled to disk. Needs no local model.

| Argument | Type | Notes |
|---|---|---|
| `checks` | `"all" \| "lint" \| "types" \| "test"` | Default `"all"`. |
| `max_failures` | number | Per check, default 25. The rest stay in the spill file and `truncated` says how many. |

Check commands come from `.local-coder/checks.json`; if absent they are inferred from `tsconfig.json`, `package.json` deps, an eslint config, or `pyproject.toml`. Only tools whose config actually exists on disk are proposed — a check that fails because it was never configured teaches you to ignore the gate.

Measured against this repo: **67,190 bytes of raw `tsc` + `vitest` output → 1,724 bytes returned (97% smaller)**, with all four real failures located.

### `repair`

The turn-collapse tool, and the largest single lever here. Snapshots the exact bytes of every file, then loops locally: run `gate` → feed the structured failures to the local model → apply → re-run `gate`, until green or the round/time budget runs out. Returns **one** cumulative diff.

| Argument | Type | Notes |
|---|---|---|
| `files` | string[] | Editable files, relative paths. Required. |
| `spec` | string | What must be true once the checks pass. Required. |
| `checks` | `"all" \| "lint" \| "types" \| "test"` | Which checks gate the loop. |
| `max_rounds` | number | Default 3, max 10. |
| `budget_seconds` | number | Wall-clock ceiling, default 300. |
| `context_files`, `model` | string[], string | As in `implement`. |

**Safety.** If the loop cannot reach green, every file is restored to its original bytes and the best attempt is returned as an *unapplied* diff alongside the remaining failures. A round that makes things worse cannot discard a round that made them better — the best state seen is what gets returned. The working tree is never left broken.

It writes to the real working tree rather than a scratch worktree, because most projects' checks need the full tree; the byte snapshot is what makes that safe.

### `implement`

Delegate a well-specified implementation. Returns a git-apply-compatible unified diff plus a summary.

| Argument | Type | Notes |
|---|---|---|
| `spec` | string, required | what to build, interfaces, constraints, acceptance criteria |
| `files` | string[], required | editable files, relative paths, must exist |
| `context_files` | string[] | read-only reference files included in the prompt |
| `model` | string | exact model name (as in LM Studio / the CSV); omit to auto-pick the largest model that fits free RAM |
| `mode` | `"diff" \| "apply"` | default `diff` (review gate); `apply` writes atomically |

Example:

```json
{
  "spec": "Add an `exportCsv(rows: Row[]): string` function to src/csv.ts that escapes quotes/commas/newlines per RFC 4180 and add unit tests covering those cases to tests/csv.test.ts.",
  "files": ["src/csv.ts", "tests/csv.test.ts"],
  "context_files": ["src/types.ts"],
  "mode": "diff"
}
```

Returns:

```json
{
  "summary": "≤120 words, what changed and why",
  "diff": "unified diff, git-apply compatible (a/ b/ headers)",
  "files_changed": ["src/csv.ts", "tests/csv.test.ts"],
  "applied": false,
  "model": "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2",
  "selection_reason": "largest catalog model fitting usable free RAM (17 GB)",
  "latency_ms": 41230,
  "usage": { "prompt_tokens": 3121, "completion_tokens": 1874 }
}
```

### `fix`

Same contract as `implement` plus `error_output` (required): the failing test/compiler/linter output, verbatim. The model is instructed to make the **minimal targeted change** that resolves the error — this is the local repair loop.

```json
{
  "spec": "Make the failing csv tests pass without changing the test file.",
  "error_output": "FAIL tests/csv.test.ts > escapes embedded quotes\nAssertionError: expected '\"a\"\"b\"' ...",
  "files": ["src/csv.ts"],
  "mode": "diff"
}
```

### `scaffold`

Generate **new files only** from a spec. Refuses if the target exists; writes directly (new files are low-risk) and returns the created paths.

```json
{
  "spec": "A React hook useDebounce<T>(value: T, delayMs: number): T with cleanup on unmount, plus a barrel export.",
  "target_path": "src/hooks"
}
```

`target_path` is a single file (`src/hooks/useDebounce.ts`) or a directory (trailing slash or no extension) for multi-file output.

### `status`

No arguments. Reports LM Studio reachability, available model IDs, whether the `lms` CLI is usable, the model catalog with each model's availability/size/fit, total/free RAM, which model the memory-only fallback would auto-pick, and the effective config. Never fails — an unreachable endpoint yields `reachable: false` with the hint: start LM Studio's server with `lms server start`.

### `models`

Optional `concurrent_models` (default 1). Returns the model catalog joined with live data — per model: objective, availability in LM Studio, size on disk, whether it fits current free RAM, whether it's already loaded, and a name-match quality flag (`exact`/`fuzzy`/`none`) — plus free-RAM numbers and a recommended set of models that fit together for that many concurrent agents. Read-only and never fails. This is the tool to call before delegating, to choose a model by objective + memory.

## Smoke test (manual, on your Mac)

CI is fully offline (all model calls mocked). The live end-to-end check runs only on your machine, against real LM Studio:

```bash
git clone https://github.com/rmmaf/claude-code-local-llm-mcp
cd claude-code-local-llm-mcp
npm install
lms server start          # if not already running
npm run smoke-test
```

It calls `status`, then runs a toy `implement` in a throwaway git repo, prints the returned diff, verifies it with `git apply`, and reports measured latency.

## Troubleshooting

- **`reachable: false` / connection refused** — LM Studio's server isn't running: `lms server start`. If it runs on another host/port, set `LM_STUDIO_URL`.
- **HTTP 404 / model errors** — the model name doesn't match LM Studio. Run `lms ls` and make your CSV `model` column (or the `model` argument) byte-identical to what it prints; the `models` tool shows a match-quality flag to spot mismatches.
- **First call fails but `status` says reachable** — JIT model loading may be disabled, so the model is never loaded on demand. Enable JIT loading (and TTL auto-unload) in LM Studio's server settings, or load the model manually with `lms load`.
- **Timeouts on long generations** — 30B-class models can take minutes on multi-file tasks. Raise `LOCAL_CODER_TIMEOUT_MS`, narrow the spec, or send fewer files.
- **Memory** — the default 4-bit DWQ 30B model (~17 GB) fits under the default macOS GPU wired limit on a 36 GB machine with no sysctl changes; only larger quants require raising `iogpu.wired_limit_mb`. When memory is tight, pick a smaller model via the `models` tool (or omit `model` to let size-fit selection do it), and tune `LOCAL_CODER_MEM_FIT_FRACTION`.
- **MCP server fails to start in Claude Code** — usually the first-launch build exceeding the 30 s startup timeout; see the pre-warm step under Installation.

## Development

```bash
npm install     # also builds (prepare)
npm test        # offline: builds, then runs the full vitest suite
```

Design notes and every judgment call live in [DECISIONS.md](DECISIONS.md). All logging goes to stderr; stdout carries only the MCP protocol (enforced by an integration test that speaks JSON-RPC to the built server).

## Verified locally required

Everything in CI is mocked and sandbox-verified. The following could **not** be verified where this was built (no LM Studio, no network to localhost) and needs a one-time check on your Mac:

1. The fresh-clone install path: `claude mcp add local-coder -- npx -y github:rmmaf/claude-code-local-llm-mcp` (sandbox-verified only via a local `npm pack` install and `npx .`).
2. ~~Live LM Studio behavior … real Qwen3/Qwen2.5 output quality against the `<file>`-block contract.~~ **The contract is verified — `run 2026-08-03-mac-01`:** `npm run smoke-test` on macOS got a diff back from a real local model and `git apply` accepted it. JIT load latency and TTL unload remain unmeasured.
3. ~~`memory_pressure` / `vm_stat` and `lms ls --json` parsers on your versions.~~ **Verified — `run 2026-08-03-mac-01`:** `lms_available: true`, both catalog models sized, memory reported (36 GB total, 19.6 GB usable free). One gap found, not a parse failure: LM Studio spells quantisation with `@` (`…-mlx@8bit`) and the matcher only strips hyphen-separated quant tokens, so such a model reads as missing when it is installed.
4. ~~`scripts/smoke-test.ts` end-to-end.~~ **Ran and passed — `run 2026-08-03-mac-01`.** Its own claim to "verify all of the above" is too broad: it does **not** exercise item 1, the `npx` fresh-clone path, which stays open.

**Caveat on items 2–4, stated rather than buried:** on that same machine and run, `npm test` was **red**. The four known failures are Windows-only (CRLF, path separators), so this is a real defect, and the failing test names have not been read yet. What that invalidates is therefore *unknown* — not nothing, not everything. The three items above rest on direct observations with objective criteria (`git apply` accepted the diff; `lms` reported sizes), which a unit failure does not undo; whether any failing test covers those paths is precisely what is still unknown.
5. ~~That the `invocation_id` our tools return survives into Claude Code's stored `toolUseResult`.~~ **Verified — `run 2026-08-03-win-01`.** The id came back inside a `toolUseResult` and the cost meter joined on it: `provenanceUnavailable: false`, `unmatched: 0`. This was the last unobserved assumption the meter rested on — the same class that killed the hook.
6. `repair` against a live local model. Its loop, budget, best-attempt tracking and byte-exact restore are all covered offline with a mocked model; what remains unmeasured is whether a real local model actually closes mechanical failures within 3 rounds, and how long a round costs.

## License

MIT — see [LICENSE](LICENSE).
