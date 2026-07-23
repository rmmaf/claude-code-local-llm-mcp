# local-coder — hybrid orchestration MCP server

**Claude plans. Your local Qwen implements. Only specs and diffs cross the metered API.**

`local-coder` is an MCP server that lets Claude Code delegate token-heavy code generation to a local LLM served by [LM Studio](https://lmstudio.ai). Claude Code stays what it's best at — planning, decomposing, spec-writing, and reviewing — while a strong local coding model (Qwen3-Coder-30B by default) does the actual typing, for free, on your own hardware.

The core design rule: **file contents never round-trip through the orchestrator's context.** Claude sends a short spec plus file *paths*; this server reads the files from disk itself, prompts the local model, computes a unified diff, and returns only the diff plus a short summary. Claude reviews diffs, not files — so a 500-line implementation costs you a spec and a diff on the metered API instead of multiple full file round-trips.

```
Claude Code (orchestrator, metered API)
      │  stdio (MCP): spec + file paths ↓ · diff + summary ↑
local-coder MCP server  ←→  project files on disk (read + patch directly)
      │  HTTP: OpenAI-compatible chat completions
LM Studio · http://localhost:1234/v1  (MLX engine, JIT load + TTL unload)
      └─ model catalog (CSV: model + objective) → pick by objective + size-vs-free-RAM
         e.g. Qwen3-Coder-30B (~17 GB) · Qwen2.5-Coder-14B (~8.5 GB) · Qwen2.5-Coder-7B · …
```

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

**Make delegation automatic.** Add this to your project's `CLAUDE.md` so Claude routes work to the local model on its own:

```markdown
## Local delegation policy
- Delegate to mcp__local-coder__implement: multi-file implementations from a
  clear spec, boilerplate, test generation, mechanical refactors, docstrings.
- Delegate new-file creation from a spec to mcp__local-coder__scaffold.
- Keep in Claude: architecture decisions, API design, subtle debugging,
  security-sensitive code, and final review of every diff before apply.
- Never paste file contents into tool arguments — pass relative paths.
- Route test/lint failures on delegated code through mcp__local-coder__fix.
- Escalate to yourself after 2 failed local attempts on the same unit.
```

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

## Tools

The file-writing tools (`implement`, `fix`, `scaffold`) take **relative file paths only — never file contents**; the server reads files from disk itself, and pasting contents into arguments defeats the whole design. `status` and `models` are read-only diagnostics.

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
2. Live LM Studio behavior: JIT load latency, TTL unload, real Qwen3/Qwen2.5 output quality against the `<file>`-block contract (the corrective-retry path exists for occasional format misses).
3. `memory_pressure` / `vm_stat` output on your macOS version, and `lms ls --json` output on your `lms` version (parsers are tested against captured fixtures; any parse failure safely degrades — sizes become `null` and selection falls back to catalog order).
4. `scripts/smoke-test.ts` end-to-end — it exists precisely to verify all of the above: `npm run smoke-test`.

## License

MIT — see [LICENSE](LICENSE).
