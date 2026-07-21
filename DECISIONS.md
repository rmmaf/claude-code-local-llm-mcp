# DECISIONS.md

Judgment calls made while building `local-coder`, in rough chronological order.
Each entry states the decision and the reasoning. Items the spec left open are
marked **(open point)**.

## Module structure (planned before implementation)

```
src/
  server.ts        entry point: shebang, --version flag, McpServer + stdio transport, tool registration
  config.ts        env parsing with defaults; the Config object is passed explicitly everywhere (no globals)
  logger.ts        stderr-only logger; the only sanctioned way to print anything
  profile.ts       RAM detection + profile auto-selection; pure parsers exported for fixture tests
  fs-safety.ts     path resolution/containment, size caps, binary sniff, atomic writes
  llm-client.ts    plain-fetch OpenAI-compatible client (chat completions + model listing), timeout via AbortController
  parse.ts         <think> stripping, <file path="..."> block parsing, declared-file validation
  diff.ts          unified diff generation (jsdiff) with a/ b/ prefixes, git-apply compatible
  tools/
    shared.ts      the generate→parse→retry→diff→apply pipeline shared by implement and fix
    implement.ts   tool: implement
    fix.ts         tool: fix
    scaffold.ts    tool: scaffold
    status.ts      tool: status
tests/             vitest, fully offline, fetch mocked
fixtures/          memory_pressure / vm_stat sample outputs, canned model responses
scripts/
  smoke-test.ts    live end-to-end check for the user's Mac; never run in CI
```

Tools are implemented as plain async functions (`runImplement(args, config, deps)`)
that `server.ts` wires into MCP registration. Tests call the functions directly and
inject a mocked `fetch` — no MCP plumbing needed in unit tests. One integration
test spawns the real built server over stdio to prove protocol correctness and
stdout purity.

## Dependency choices

- `@modelcontextprotocol/sdk` ^1.29.0 — current stable at build time.
- `zod` pinned to **^3.25** (not v4) — the SDK peer range allows both, but the
  v3 classic API + the SDK's `zod-to-json-schema` path is the battle-tested
  combination; schema-to-JSON conversion for `tools/list` is load-bearing here.
- `diff` (jsdiff) ^9 — ships its own TypeScript types, so no `@types/diff`.
- `typescript` pinned to **^5.9** rather than the new 7.x line: `npx github:`
  runs the build on the user's machine via `prepare`, so the compiler must be
  the maximally boring choice.
- `vitest` ^4, `tsx` (dev-only, to run the smoke test script directly).
- ESM (`"type": "module"`, `module: nodenext`) — cleanest fit for the SDK and
  Node ≥ 18.

## Model output contract

- The model returns **complete file contents** in `<file path="...">` blocks;
  the server computes unified diffs with jsdiff `createTwoFilesPatch` using
  `a/` and `b/` prefixes. LLM-authored diffs are rejected by design (broken
  hunks); full-file output + server-side diffing is deterministic.
- **Parsing strategy (revised after the pre-ship review):** blocks are parsed
  with a line-anchored segment parser, not a lazy regex. Opening tags must
  start a line; the closing tag must sit alone on its own line (exactly the
  format the model is taught); within a segment, content runs to the **last**
  line-anchored `</file>` before the next opening tag. Consequences: file
  content may mention `</file>` or `<think>` inline (regexes, docs, test
  strings) without being truncated or excised; text outside blocks —
  reasoning, `<think>` spans, prose — is simply ignored, so no global
  think-strip runs over file content. Known limitation: a file whose content
  contains a *line-anchored* `<file path=...>` opening tag (essentially only
  files documenting this very protocol) degrades to a detectable
  missing-file retry/error rather than silent corruption.
- **Trailing newlines:** the block format forces a newline before the closing
  tag, so a file that does not end in `\n` cannot round-trip byte-exactly
  through the prompt. The embed appends one newline to such files, and the
  diff step treats "identical except for that appended trailing newline" as
  unchanged — a verbatim echo of a no-trailing-newline (or empty) file
  produces no diff and no write. A file receiving real edits does gain a
  trailing newline, which the diff reports honestly.
- jsdiff emits a `===` separator line before the `---`/`+++` headers. I strip
  everything above the `---` header and emit a `diff --git a/x b/x` line
  instead, so output looks like a normal git diff. Compatibility is proven by
  actually running `git apply --check` (and a real `git apply`) in tests.
- **(open point) Who writes the `summary`?** The implementer prompt forbids
  prose (nothing but `<file>` blocks), so the model cannot supply the summary.
  The server composes it mechanically: per-file added/removed line counts plus
  the first sentence of the spec. Deterministic, always ≤ 120 words, and no
  extra parse surface.
- Retry policy: on malformed output (missing declared file, unparseable blocks,
  or truncation via `finish_reason: "length"`), retry **exactly once**. The
  retry continues the same conversation: the malformed assistant reply is
  included, followed by a corrective user message quoting the required format
  and naming the missing files. On second failure, return a structured error
  naming the missing files. `usage` and `latency_ms` are summed across both
  attempts.
- Undeclared `<file>` paths in the output are silently dropped (logged to
  stderr), per spec. Files whose returned content is byte-identical to disk are
  excluded from the diff and `files_changed`.
- `<think>…</think>` blocks are stripped before parsing (Qwen3 hybrid-thinking
  output). Unclosed `<think>` (truncation artifact) strips to end of string.
  Markdown code fences wrapping the whole output are also tolerated and
  stripped, since small models do this even when told not to.

## File safety

- Every path is resolved against the **project root = `process.cwd()`** at
  server start (Claude Code launches MCP servers in the project dir). The root
  is captured once into `Config` so tests can point it at temp dirs.
- Rejected: absolute paths, `..` escapes (checked on the resolved path), and
  symlinks that resolve outside the root (`fs.realpath` on the file and its
  containing directory). Containment check uses `path.relative` — prefix string
  compares break on sibling dirs like `/root` vs `/root-other`.
- Binary detection: null byte in the first 8 KiB → rejected with a clear error.
- Size caps: `LOCAL_CODER_MAX_FILE_KB` per file, `LOCAL_CODER_MAX_CONTEXT_KB`
  for the sum of all file contents (editable + context files). **(open
  point)** The spec text ("assembled context") could include the spec string
  itself; I count only file bytes — the spec/error_output are authored by the
  orchestrator, which can see their size itself. Errors name every offending
  file with its size.
- Atomic apply: write to a `.<name>.<random>.tmp` sibling in the same
  directory, `fsync`, then `rename`. Same-directory keeps the rename atomic on
  the same filesystem.

## Tool semantics

- `implement` / `fix` share one pipeline; `fix` adds `error_output` and a
  system-prompt emphasis on the minimal targeted change.
- `scaffold` **(open point — target existence)**: the spec says "refuse if the
  target exists". Implemented literally: if `target_path` exists at all (file
  or directory) → structured error. If it does not exist, it is treated as a
  directory when it ends with `/` or has no file extension, else as a single
  file; the prompt instructs the model accordingly. Every created file must
  also not exist and must resolve inside the root. Parent directories are
  created as needed.
- `scaffold` writes directly (no diff gate) and returns `created` paths +
  summary, per spec. It validates **every** returned path before writing any
  file (a late validation failure must not leave a half-written scaffold),
  and the parser's normalized map keys collapse duplicate spellings
  (`x.ts` vs `./x.ts`) to one file instead of erroring after a partial write.
- **`mode: "apply"` is a regeneration, not a replay.** The server is
  stateless: apply re-runs generation and writes what the fresh generation
  returns. This is inherent to the four-tool surface (there is no "apply this
  patch" input). Mitigation: temperature 0.1 keeps variance low, the apply
  response returns the diff of what was *actually* written for re-checking,
  and the README/tool descriptions tell the orchestrator to apply the
  reviewed patch itself (`git apply`) when byte-exactness matters.
- `diffStats` counts only lines inside hunks (state machine keyed on
  `diff --git` / `@@`), because a bare `startsWith("---")` prefix test
  misclassifies removed SQL/Lua `--` comments and added `++i;`-style lines
  as file headers.
- `status` never throws: every probe (HTTP, RAM, profile) is wrapped; an
  unreachable endpoint yields `reachable: false` plus the exact hint string
  "start LM Studio's server with `lms server start`".
- Tool errors are returned as MCP `isError: true` results whose text is a JSON
  object (`{ "error": { "code", "message", ... } }`) — structured enough for
  the orchestrator to branch on, human-readable enough to debug.

## Profile auto-selection

- macOS: total RAM from `sysctl -n hw.memsize`; free percentage parsed from
  `memory_pressure` ("System-wide memory free percentage: NN%"); free bytes =
  total × pct. Fallback: `vm_stat` — (free + inactive + speculative) pages ×
  page size. Free GB ≥ `LOCAL_CODER_SOLO_MIN_FREE_GB` → `solo`, else `ide`.
- Non-macOS or any parse/exec failure → `solo` (per spec), with the reason
  logged to stderr. Decision + numbers always logged to stderr.
- Parsers are pure string functions in `profile.ts`, unit-tested against
  fixture outputs; command execution is injected so tests never shell out.
- `status` reports RAM on non-macOS too, via Node's `os.totalmem/freemem`
  (display only — auto-selection still returns `solo` off-macOS).

## Packaging

- `bin` → `dist/server.js` (shebang preserved by tsc from `src/server.ts`),
  `files: ["dist"]`, `prepare: npm run build` so `npx github:` builds on
  install, `engines.node >= 18`.
- `--version` prints the version to stdout and exits — the one sanctioned
  stdout write outside the MCP transport, used for the pre-warm instruction in
  the README. Version is read from `package.json` at runtime (works from
  `dist/` and from a packed install).
- `pretest` runs the build so `npm test` alone is always green and the
  stdio integration test always has a fresh `dist/`.

## Testing

- `fetch` is injected into the pipeline (`deps.fetch`) and stubbed per test —
  no network, ever. The stdio integration test spawns `node dist/server.js`
  and speaks real JSON-RPC over stdin/stdout; it asserts (a) initialize works,
  (b) `tools/list` returns exactly the four tools, and (c) **every byte** on
  stdout parses as JSON-RPC — the stdout-purity proof.
- git-apply compatibility is proven by running real `git init`/`git apply`
  against generated diffs in a temp repo.

## Pre-ship adversarial review

Before pushing, the codebase went through a multi-agent adversarial review
(five independent lenses — spec compliance, pipeline correctness, security,
packaging, tests/docs — with every finding attacked by three independent
refuters). The security and packaging lenses found nothing. Confirmed
findings, all fixed and covered by `tests/regression.test.ts`:

1. Lazy-regex block parsing truncated file content containing a literal
   `</file>`, and the global `<think>` strip could corrupt content containing
   those literals → replaced with the line-anchored segment parser above.
2. Files without a trailing newline (and empty files) could never round-trip
   unchanged — a verbatim echo produced a phantom diff and a pointless write
   → lossless embed + trailing-newline-aware unchanged check.
3. `diffStats` skipped removed `--`-comment lines and added `++`-prefixed
   lines as if they were headers → hunk-aware counting.
4. `scaffold` could write a file and then throw `target_exists` when the
   model emitted the same path in two spellings → normalized parse keys +
   validate-all-before-writing.
5. Tests that exercised profile auto-selection without injecting a platform
   would shell out to real `sysctl`/`memory_pressure` on macOS and fail
   depending on live free RAM → every such test now injects
   `platform: "linux"`.
6. README/tool descriptions implied `mode: "apply"` applies the previously
   reviewed diff; it actually regenerates → documented honestly (see above).

## Things that cannot be verified in this sandbox (listed in README too)

- The end-to-end `claude mcp add local-coder -- npx -y github:rmmaf/claude-code-local-llm-mcp`
  install path from a fresh clone (verified here only via local `npm pack` +
  `npx .`).
- Live LM Studio behavior: JIT load latency, TTL unload, real Qwen output
  quality, actual `memory_pressure`/`vm_stat` output on the user's macOS
  version (parsers are tested against captured fixtures).
- `scripts/smoke-test.ts` end-to-end (it requires live LM Studio by design).
