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
      ├─ solo: Qwen3-Coder-30B-A3B-Instruct 4-bit DWQ v2 (~17 GB)
      └─ ide:  Qwen2.5-Coder-14B 4-bit (~8.5 GB)
```

## Requirements

- macOS on Apple Silicon (reference machine: MacBook Pro M4 Max, 36 GB unified memory)
- [LM Studio](https://lmstudio.ai) with the **MLX** engine
- LM Studio's server running headless: `lms server start`
- **JIT model loading** and **TTL auto-unload** enabled in LM Studio's server settings (so models load on demand and free memory when idle)
- Models downloaded:

  ```bash
  lms get mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2
  lms get qwen2.5-coder-14b-instruct   # or via the LM Studio UI
  ```

  Run `lms ls` afterwards — if your local identifiers differ from the defaults above, set `LOCAL_CODER_MODEL_SOLO` / `LOCAL_CODER_MODEL_IDE` accordingly.
- Node.js ≥ 18 (Claude Code already requires this)

## Install

One line, straight from GitHub — no npm publish involved:

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

**First-launch note:** the first `npx github:` run clones the repo and builds it, which can exceed Claude Code's default 30 s MCP startup timeout. Pre-warm once in a terminal:

```bash
npx -y github:rmmaf/claude-code-local-llm-mcp --version
```

…or raise the timeout with `MCP_TIMEOUT` (e.g. `MCP_TIMEOUT=120000 claude`).

## Configuration

All environment variables are optional, with sane defaults:

| Variable | Default | Purpose |
|---|---|---|
| `LM_STUDIO_URL` | `http://localhost:1234/v1` | OpenAI-compatible base URL |
| `LOCAL_CODER_MODEL_SOLO` | `mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2` | solo profile model ID |
| `LOCAL_CODER_MODEL_IDE` | `qwen2.5-coder-14b-instruct` | ide profile model ID |
| `LOCAL_CODER_SOLO_MIN_FREE_GB` | `20` | free-RAM threshold for auto-selecting solo |
| `LOCAL_CODER_TEMPERATURE` | `0.1` | sampling temperature |
| `LOCAL_CODER_MAX_OUTPUT_TOKENS` | `8192` | completion cap |
| `LOCAL_CODER_TIMEOUT_MS` | `300000` | per-request timeout (local models are slow on big generations) |
| `LOCAL_CODER_MAX_FILE_KB` | `256` | per-file size cap |
| `LOCAL_CODER_MAX_CONTEXT_KB` | `512` | total assembled-context cap |

**Profiles.** `solo` targets the 30B model (~17 GB) for when the machine is mostly yours; `ide` targets the 14B model (~8.5 GB) for when an IDE, browser, or meeting stack is eating memory. When a tool call omits `profile`, the server auto-selects: free RAM ≥ `LOCAL_CODER_SOLO_MIN_FREE_GB` → `solo`, else `ide` (measured via `memory_pressure`, falling back to `vm_stat`; non-macOS or measurement failure defaults to `solo`). The decision and numbers are logged to stderr.

## Tools

All four tools take **relative file paths only — never file contents**. The server reads files from disk itself; pasting contents into arguments defeats the whole design.

### `implement`

Delegate a well-specified implementation. Returns a git-apply-compatible unified diff plus a summary.

| Argument | Type | Notes |
|---|---|---|
| `spec` | string, required | what to build, interfaces, constraints, acceptance criteria |
| `files` | string[], required | editable files, relative paths, must exist |
| `context_files` | string[] | read-only reference files included in the prompt |
| `profile` | `"solo" \| "ide"` | omit for memory-based auto-selection |
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
  "profile": "solo",
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

No arguments. Reports LM Studio reachability, available model IDs, whether the two configured profile models are present, total/free RAM, which profile auto-selection would pick right now, and the effective config. Never fails — an unreachable endpoint yields `reachable: false` with the hint: start LM Studio's server with `lms server start`.

## The workflow this enables

1. Claude Code plans and decomposes; writes a tight spec per unit
2. `implement(spec, files, mode: "diff")` → local model generates; server returns diff
3. Claude reviews the diff (cheap) → approves via `mode: "apply"` (or applies the patch itself), or rejects with feedback
4. Claude runs tests; failures go to `fix(spec, error_output, files)` — the repair loop stays local
5. After 2 failed local attempts on the same unit, Claude takes over that unit itself

> **Note on `mode: "apply"`:** the server is stateless, so `apply` re-runs generation before writing rather than replaying the previously returned patch. At temperature 0.1 the output is normally the same, and the `apply` response includes the diff of what was *actually* written — have Claude confirm it matches the reviewed diff. For a byte-exact guarantee, have Claude apply the reviewed patch itself (`git apply`).

Add this to your project's `CLAUDE.md` so Claude Code delegates on its own:

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
- **HTTP 404 / model errors** — model ID mismatch. Run `lms ls` and set `LOCAL_CODER_MODEL_SOLO` / `LOCAL_CODER_MODEL_IDE` to the identifiers it prints.
- **First call fails but `status` says reachable** — JIT model loading may be disabled, so the model is never loaded on demand. Enable JIT loading (and TTL auto-unload) in LM Studio's server settings, or load the model manually with `lms load`.
- **Timeouts on long generations** — 30B-class models can take minutes on multi-file tasks. Raise `LOCAL_CODER_TIMEOUT_MS`, narrow the spec, or send fewer files.
- **Memory** — the default 4-bit DWQ solo model (~17 GB) fits under the default macOS GPU wired limit on a 36 GB machine with no sysctl changes; only larger quants require raising `iogpu.wired_limit_mb`. When memory is tight, pass `profile: "ide"` or let auto-selection do it.
- **MCP server fails to start in Claude Code** — usually the first-launch build exceeding the 30 s startup timeout; see the pre-warm note under Install.

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
3. `memory_pressure` / `vm_stat` output on your macOS version (parsers are tested against captured fixtures; any parse failure safely defaults to `solo`).
4. `scripts/smoke-test.ts` end-to-end — it exists precisely to verify all of the above: `npm run smoke-test`.

## License

MIT — see [LICENSE](LICENSE).
