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
  exec.ts          the shared subprocess primitive (CommandRunner) used by the memory + lms probes
  memory.ts        RAM detection (macOS memory_pressure/vm_stat, os fallback); pure parsers for fixture tests
  lms.ts           `lms ls`/`lms ps --json` model-size probe; pure parser for fixture tests
  models-csv.ts    the model catalog: CSV parser + loader + built-in default catalog
  selection.ts     name matching, size-vs-RAM fit, single/multi model selection, resolveModel
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
    models.ts      tool: models (catalog + size/fit discovery and recommendation)
tests/             vitest, fully offline, fetch mocked
fixtures/          memory_pressure / vm_stat / lms_ls.json / models.csv sample outputs, canned model responses
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
- **The contract is kept, and the tools are scoped to fit it (B0's disposition).**
  Whole-file output means the answer is the **sum** of the editable files,
  regenerated on every attempt and every `repair` round, against
  `maxOutputTokens`. Over the cap the response truncates mid-file — and
  `repair` files that under `stopped_because: "model_failed"`, the same label a
  genuine loop failure gets. That shared label, not the lost coverage, is the
  expensive part: it is what made B6 unmeasurable.
  `enforceOutputCap` (`src/fs-safety.ts`) estimates the answer from the editable
  files' bytes and **refuses before anything is read or generated**, exactly as
  `enforceContextCaps` already does for the input. Called from `runGeneration`
  and, separately, from `runRepair` **before the loop** — so a request that
  cannot fit costs zero rounds and writes no telemetry row.
  - **Editable files only.** `context_files` go into the prompt and are never
    echoed back, so they cost input budget and no output budget at all.
  - **The estimate is an estimate**, and both constants are env-tunable
    (`LOCAL_CODER_OUTPUT_BYTES_PER_TOKEN`, `LOCAL_CODER_OUTPUT_USABLE_FRACTION`).
    3.5 is not taste: it is the divisor at which the estimate reproduces the one
    truncation ever observed (`run 2026-08-03-mac-05`). **B16** is what replaces
    the calibration with a measurement (B14 until it went `moot`); a test pins
    the constant to that observation so it cannot drift away from it quietly.
  - **`scaffold` is not covered**, and this is the record of that rather than an
    oversight. It has its own generation loop, does not go through
    `runGeneration`, and creates files that do not exist yet — so there is no
    input size from which to estimate an output.
- **Why not switch to search/replace blocks instead.** That is the other
  disposition B0 allows, and it is **not rejected — it is gated** (`ROADMAP.md`
  G7, opens at ≥ 40% of the corpus refused, dies below 20%). Worth being precise
  about what the rejection above does and does not cover: what was rejected is
  **LLM-authored unified diffs**, for broken hunks — line numbers and hunk
  arithmetic. Anchored search/replace has neither, and a failed anchor is
  detectable and refusable rather than silently wrong. So the recorded reason is
  correct and simply does not reach that design. The cheap arm ships first and
  the corpus decides whether the expensive one is needed, which is the same
  order G3 uses for RAG.

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
- `status` never throws: every probe (HTTP, RAM, lms) is wrapped; an
  unreachable endpoint yields `reachable: false` plus the exact hint string
  "start LM Studio's server with `lms server start`".
- Tool errors are returned as MCP `isError: true` results whose text is a JSON
  object (`{ "error": { "code", "message", ... } }`) — structured enough for
  the orchestrator to branch on, human-readable enough to debug.

## Model selection

Model choice is driven by a catalog + size-vs-memory fit. The catalog is a
headerless CSV (`model,objective`) pointed at by `LOCAL_CODER_MODELS_CSV`; with
none set, a built-in default catalog keeps the zero-config path working.

- **Decision locus is Claude Code, not the server.** The server exposes the
  data — a `models` tool returning, per catalog model, its objective, `/models`
  availability, `lms ls` size, and whether it fits free RAM — and Claude matches
  the free-text objective to the task itself (no NLP in the server).
  `implement`/`fix`/`scaffold` take an explicit `model` string; omitting it
  falls back to the largest catalog model that fits free RAM (memory-only, since
  objective matching is Claude's job).
- **Sizes come from the `lms` CLI** (`lms ls --json`, optionally `lms ps --json`
  for loaded state), shelled out through the same injected `CommandRunner` the
  memory probes use, with a pure parser + a captured `fixtures/lms_ls.json`. The
  OpenAI `/models` endpoint only lists ids, not sizes, so `lms` is the size
  source; if it's absent, sizes/fit are null and selection degrades to catalog
  order. No `@lmstudio/sdk` dependency was added.
- **Fit** is `size ≤ free RAM × LOCAL_CODER_MEM_FIT_FRACTION` (default 0.85). It
  is advisory: runtime footprint exceeds on-disk weight (KV cache/context), and
  macOS unified memory has a separate GPU wired limit, so a positive fit is
  necessary, not sufficient. The fraction is a tunable heuristic.
- **RAM detection** lives in `memory.ts` (macOS `sysctl` +
  `memory_pressure`→`vm_stat`, `os.freemem/totalmem` elsewhere). Command
  execution is injected so tests never shell out.
- **Three-surface name matching** (CSV ↔ `/models` ↔ `lms ls`) is the central
  correctness risk, since the three identifier spaces aren't guaranteed equal
  (publisher prefixes, quant/format suffixes). `matchModel` tries exact
  normalized first, then a conservative fuzzy pass (basename and
  quant-suffix-stripped equality — never substring containment, so different
  parameter sizes don't collide), and always surfaces the match quality
  (`exact`/`fuzzy`/`none`) so mismatches are visible. Docs tell users to keep the
  CSV byte-identical to `lms ls`.
- **Multi-model packing** for concurrent agents (the `models` tool's
  `concurrent_models`) is greedy largest-first and advisory — LM Studio
  loads/unloads independently and free RAM shifts between probe and load, so the
  tool reports what should fit and also every model's size for Claude to pack by
  objective.
- `loadConfig` stays synchronous; the CSV is read afterward (`config.models =
  await loadModelCatalog(config.modelsCsvPath)`) in `server.ts`/`smoke-test.ts`,
  keeping config unit tests file-free.

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
  (b) `tools/list` returns exactly the five tools, and (c) **every byte** on
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
5. Tests that exercised memory-based selection without injecting a platform
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
  quality, actual `memory_pressure`/`vm_stat` output and `lms ls --json` /
  `lms ps --json` shape on the user's macOS + `lms` version (parsers are tested
  against captured fixtures — the `lms` JSON schema in particular varies by
  version and should be re-checked against your `lms`).
- `scripts/smoke-test.ts` end-to-end (it requires live LM Studio by design).

## v3 — cost model redirect

### Why the architecture turned

I built this server on the premise that the expensive thing was the local model
doing the typing: *Claude plans, the local model writes, only diffs cross the
API*. Measurement says that premise is close to backwards.

Generated tokens are roughly **10%** of a session's bill — on a real 69-request
session of mine, 15.9% — and the delegated diff **enters the context anyway**
once it comes back. So delegating the writing saves the 5x output multiplier
once, and then pays full price for the diff like any other token.

What actually dominates is a token that enters the context and is re-read on
every later request in the segment:

```
cost(token entering at request t of a segment running to T)
      = cache_write + cache_read x (T - 1 - t)
```

On that same session a token entering at turn 0 cost **8.8x** the input rate, and
the resident context grew from 33,510 to 449,504 tokens re-read per request. The
split was write 48.0% / read 35.7% / output 15.9% / fresh input 0.4%.

That forces an ordering I did not choose so much as read off the arithmetic:

1. **Keep tool output out of the context** — the `PostToolUse` hook, and `gate`.
   Removes tokens *and* every later re-read of them.
2. **Collapse turns** — `repair`. Shrinks `T`, which discounts everything already
   resident, so it is the only lever that is multiplicative.
3. **Delegate the writing** — `implement`. Smallest lever, no multiplier.

### `implement` / `fix` / `scaffold` are kept, and demoted only in description

I did not delete them. They are tested, they work, and if `repair` and `locate`
turn out not to pay, they are the fallback. What changed is the first line of
`implementToolDescription` and `fixToolDescription`, which now route the reader
to `gate` and `repair` first and say plainly that write-delegation saves the
smallest part of the bill.

This is not cosmetic. In MCP the description **is** the routing mechanism — it is
the only thing that decides which tool the orchestrator reaches for. Treating it
as documentation rather than behaviour is how a good tool goes unused.

### `repair` writes to the real working tree, not a scratch worktree

A scratch `git worktree` was the obvious safe choice and I rejected it. Most
projects' checks need the full tree — installed dependencies, generated files,
local config, a populated `node_modules` — and a detached worktree has none of
that. A gate that cannot run is worse than no gate.

So the loop writes in place, and safety comes from a **byte-exact snapshot** of
every file it may touch, taken before round 1. If the loop cannot reach green,
every file is restored to its original bytes and the best attempt is returned as
an *unapplied* diff alongside the remaining failures. A round that makes things
worse cannot discard a round that made them better — the best state seen is what
is returned. Claude is blocked on the call anyway, so the tree being transiently
mid-repair costs nothing.

### `.local-coder/rates.json` ships with `inputPerMTok: null`

Deliberate. A hardcoded price goes stale silently and then every dollar figure in
every report is quietly wrong — the exact failure this whole registry exists to
prevent. With the price unset the meter falls back to **input-equivalent units**,
which are exact, need no maintenance, and are what an architecture comparison
actually needs. Dollars are one number the user fills in when they want them.

The multipliers next to it (`cacheWrite1h: 2.0`, `cacheWrite5m: 1.25`,
`cacheRead: 0.1`, `output: 5.0`) are structural — they follow from how prompt
caching is billed, not from any one model's sheet — so the argument survives a
price change.

### Deduplicating by `requestId` is the meter's correctness core

Worth recording because it is not obvious and it is easy to get wrong in the
direction that flatters us. Claude Code writes one billed request as **several**
`assistant` records, one per content block, each carrying an *identical* copy of
`message.usage`. On the session above, 155 records were 69 billed requests;
summing the records inflates `cache_read` by **2.3x**. Usage deduplicates by
`requestId`; content blocks are collected across all records of that request.

### Suppression is reversible, and that is a requirement rather than a courtesy

arXiv 2607.12161 measured an arm that removed 38% of tool-output tokens and cost
**6.8% more** (CI +2.8% to +11.3%), dropping patch application from 27/40 to
15/40 — because it destroyed the verbatim anchors edits match against. Every
suppression here writes the full text to `.local-coder/spill/` and returns the
path, and the hook bails out entirely on diffs and git porcelain.

### **(open point)** B2 is unverified, and it gates the whole first lever

That `hookSpecificOutput.updatedToolOutput` changes what is **billed** rather
than only what is displayed is documented but unobserved. It cannot be tested in
the session that installs it — `.claude/settings.json` is read at session start.
A probe that did run cost ~8.5K tokens and proved only that the hook was
inactive. Until it is measured, no saving may be attributed to the hook as
"measured" anywhere, including the README.

### **(open point)** `repair` has never met a real local model

Its loop, budget, best-attempt tracking and byte-exact restore are covered
offline with a mocked model. Whether a real local model closes mechanical
failures within 3 rounds (B6) and what a round costs in wall-clock (B7) are both
unmeasured. B6 is the least-evidenced premise in the project.

### `tests/stdio.test.ts` asserted exactly five tools — fixed

`gate` and `repair` make seven. The assertion was masked during development
because `npx vitest run` skips the build that `npm test` performs, so it ran
against a stale `dist/`. Now updated to seven, with schema assertions for both new
tools. **Verify with `npm test`.** The same trap is discussed below — `gate` was
falling into it too.

### **(open point)** `CALIBRATION.md` remains out of scope

Model choice still rests on model cards rather than measured behaviour. The v3
architecture needs *smaller* local models than the original 27B workhorse — a
repairer and a triager — which weakens but does not remove the case for
calibrating. Recorded so that finding `CALIBRATION.md` unused in the repo reads
as a decision rather than an oversight.

### Library version drift: the answer is verification, not retrieval

The local model's training cutoff may predate the version of a library the
project actually has installed. It will then confidently write the API it
remembers. Writing this down because the architecture *does* have an answer and
it is not the obvious one.

**RAG is not that answer, and it is easy to assume it is.** G3's corpus is *this
repository*. Fully built and working, an index of our own source still has
nothing to say about a third-party library's current API. Making it say something
would mean indexing a second corpus — library documentation — which is stale in
precisely the direction that hurts: docs describe the latest release, while
`node_modules/` holds the version you actually resolved. Retrieval would be
guessing at an API whose exact definition is already sitting on disk.

**The type-checker is the answer.** `tsc` runs against the declarations in
`node_modules`, which *are* the API of the installed version by construction.
`gate` parses the result into `(path, line, code, message)` and `repair` feeds it
back. That is not a heuristic about the API, it is an observation of it —
version-correct for free, no embedding, no index, nothing to keep fresh. The
general shape: **against drift, verify; do not retrieve.**

**The residue, stated honestly.** Two gaps survive, and they are not the same kind
of gap:

1. `tsc` says "property X does not exist on type Y". It does not say "use Z". A
   model that does not know the replacement can burn `max_rounds` guessing.
2. If the old API is deprecated but still present, it compiles, the gate goes
   green, and the regression is silent. **This is the only failure mode in the
   whole design that fails quietly.** Everything else fails loudly.

**What the architecture does about gap 1: escalate, do not enrich.** The
orchestrator is the up-to-date party here — Claude has the later cutoff and can
fetch a changelog; the local model has neither. So drift is handled by the
division of labour that already exists, in this order, and **none of it is new
code**:

1. **Let the checker find it.** The local model does not need to know the
   version; `tsc` does. A call into an API that no longer exists fails with path,
   line and code before it can reach a commit.
2. **Bound the guessing.** `repair` feeds those structured failures back for
   `max_rounds`, then stops and restores every touched file byte-exactly. Drift
   costs a bounded number of *local* rounds — never a silent bug, never an
   unbounded loop, and never a billed Claude turn per attempt.
3. **Escalate on exhaustion.** `stopped_because: "max_rounds"` returns the
   remaining failures plus the best unapplied diff. That is Claude's cue to
   supply the correct call itself — from its own knowledge or a `WebFetch` of the
   changelog — as a few hundred bytes of `spec`/`error_output`. This is the
   crux: the *correction* is tiny and the orchestrator already has it, whereas
   the injection idea ships hundreds of kilobytes and merely *hopes* the small
   model locates the answer inside. Escalation is strictly cheaper and strictly
   more reliable.
4. **Keep the local model out of where drift bites.** In v3 its job is `repair`
   on mechanical failures inside code that already exists — and existing code is
   itself a version-correct example of the API in use. Authoring a fresh
   integration against a library the model has never seen is exactly where drift
   dominates, and that case belongs to Claude, not to `implement`.

Recorded because step 3 is the answer and it is easy to miss: it is already what
`stopped_because` and the returned failures are *for*.

**(open point) B13 is an experiment, not a component.** Everything below is about
whether injecting installed declarations buys anything *on top of* the four steps
above. Nothing depends on it; the default is not to build it. Kept because the
mechanism is genuinely sound — `node_modules/**` cannot be stale — and because
the question would otherwise be re-derived from scratch later.

**(open point) If it is ever run: what would actually be injected — the caps make
"just pass the `.d.ts`" fail on the first library I would want it for.** `enforceContextCaps`
holds `LOCAL_CODER_MAX_FILE_KB` (256) and `LOCAL_CODER_MAX_CONTEXT_KB` (512), and
it **rejects** rather than truncates — deliberate, since a silently truncated type
file is worse than a refusal. In this repo today
`node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts` is **373 KB**: our
own main dependency does not fit. `typescript.d.ts` is 574 KB and `lib.dom.d.ts`
is 1.8 MB. (Sizes from `ls`, not from a run — no `run_id`, so they stay here in
prose and out of `PREMISES.md` and `MEASUREMENTS.jsonl`.) Candidate slicings,
none chosen: (a) only the declaration of the symbol the failure names, extracted
via the TypeScript compiler API — precise, but adds a compiler dependency at
runtime and a new failure surface; (b) the submodule entry point rather than the
barrel; (c) a separate byte cap for injected context, so a type dump cannot crowd
out the files being edited. **I am deliberately not choosing.** B13's experiment
runs the naive whole-file version *under the existing caps* and records how often
the cap refused it. That refusal count is what decides whether slicing is worth
building, and it costs nothing extra because it falls out of a run we owe anyway.

**(open point) The cost objection is real but it is not the cost model's.** The
local model's context is not billed by Anthropic, so filling it does not touch the
`cache_write + cache_read x (T - 1 - t)` arithmetic this redirect is built on.
What it does touch is **B7** (wall-clock per `repair` round) and small-model
attention — a 7B looking at 400 KB of declarations is not obviously better at
anything. So B13's fall condition includes B7's 150 s threshold, and this lever is
allowed to die of latency even if it helps accuracy.

**(open point) `node_modules` is not readable this way on every layout.**
`resolveSafePath` realpaths each path and rejects anything landing outside the
root as `symlink_escape`. pnpm survives that — its store link stays under
`node_modules/.pnpm/` — but Yarn PnP has no `node_modules` tree at all, and a
workspace link can resolve outside a package-level root. The injection is
therefore available on the common layout and simply absent on others; a B13 run
must record which layout it ran on or the number does not transfer.

**(open point) Deprecated-but-compiles: a premise, or prose? Not my call.**
Both sides, because the file's own rule cuts against my instinct here.
*For a premise:* it is the highest-consequence failure in the design and the only
silent one, and there is a cheap candidate mitigation that would make it gateable
— a lint rule flagging `@deprecated` usage (typescript-eslint ships
`no-deprecated`; confirm availability for the stack before relying on it) turns
the silent pass into a loud gate failure, and `gate` already runs eslint whenever
the project configures it. That is config, not code, which fits the architecture
exactly. *Against:* the hard rule is that a premise needs an experiment, and the
experiment here is not viable on this project's terms — it needs curated
library-version pairs with known deprecations, a corpus nothing else on the
roadmap reuses, unlike B6's and B8's. Worse, no threshold currently changes a
decision: if the local model emits deprecated-but-compiling code 10% of the time,
nothing in `ROADMAP.md` moves. A premise whose fall triggers no action is
decoration. It is also not local-model-specific — any model with a cutoff does
this, and the standard mitigation is review. *My recommendation:* leave it here as
prose. (This said "as B14" when written, reserving the next free number. B14 went
to the output pre-flight instead and has since gone `moot`, so the reservation is
dropped rather than renumbered — a premise that does not exist should not be
holding a label.) It becomes writable the moment the lint mitigation is adopted, and
the premise then has an obvious shape — "enabling the deprecation rule catches
drift the type-checker misses, at an acceptable false-positive rate" — with a
threshold that actually decides whether the rule stays on.

### What a Codex adversarial review changed (`run 2026-08-02-win-02`)

Six defects, all fixed, nine tests added. Recording them because four of the six
are the *same* class of mistake — a tool that is supposed to be strict quietly
being lenient — and that class is worth recognising on sight.

**`gate` was bypassing the project's own test script.** Detection ran
`npx vitest run` whenever vitest was a dependency, so the `else if (scripts.test)`
branch was unreachable. That skips npm lifecycle hooks, and a `pretest` that
builds is exactly how a suite ends up green against a stale artifact — this repo's
own stdio test runs `dist/server.js`. So the verification tool reproduced the very
trap `STATE.md` already warned about. It now runs `npm test`, forwarding
`--reporter=json` (and `run`, when the script would otherwise start a watcher) so
failures stay structured while the lifecycle still fires. `npx vitest` remains only
as the fallback for projects with no test script.

**`.local-coder/checks.json` failed open.** Malformed entries were skipped and the
survivors accepted without a word: one typo in `category` deleted that check while
the gate went on reporting `passed: true`. It now fails closed with indexed
per-entry errors, and an existing-but-invalid file is an error rather than a silent
fall back to autodetection — falling back would run a *different* set of checks
than the one the project pinned, which is the same failure as skipping one.

**`repair` could leave a half-repaired tree.** `restore` sat only on the normal
return path, so anything thrown after the model had written — a locked file, a
check config the repair itself invalidated — returned an error and kept the
model's bytes on disk, directly contradicting the tool's own "never left broken".
The loop is now wrapped, and rollback runs on the error path too.

**`repair`'s rollback could destroy someone else's edit.** It overwrote any file
differing from the snapshot without asking who wrote it. It now tracks the bytes
*it* wrote and only rolls back a file still holding exactly those; anything else is
left as found and named in `restore_conflicts`.

The first attempt at this got it wrong in an instructive way, and a stop-time
review caught it. It recorded "what we wrote" by **reading the file back** after
each round. But a read cannot tell our write from anyone else's — and the read
happened after generation, which is the longest part of a round (up to the model
timeout). An editor or formatter touching the file during those minutes was
adopted as our own work and then rolled away by the very mechanism meant to
protect it. The compare-and-swap was comparing against bytes that already belonged
to the other writer.

The fix is to stop inferring. `runGeneration` now reports each write through a
`onFileWritten(rel, content)` callback **as it lands**, so `repair` holds the exact
bytes it produced and never consults the disk to find out. That also fixes the
partial-write case: a generation that throws half-way has still reported the files
it got to, so those roll back and the untouched ones are left alone. `best`
likewise comes from what we wrote rather than from a disk read, which would have
let a concurrent edit be promoted to "best attempt" and then reverted.

A second stop-time review then found that the compare-and-swap protected the
*rollback* but not the write just above it. When the loop ended red it briefly
wrote the best attempt to the working tree so it could read it back and diff it —
an **unconditional** write, with no check of what was on disk. A concurrent edit
was therefore destroyed in order to produce a report that was immediately thrown
away. That write is gone: the diff is now rendered from bytes already in memory
(`renderDiff`), and on the failure path the tool does not touch the tree at all.
Reading the tree to describe work we already hold was never necessary.

What remains, stated rather than hidden: the model's own `mode: "apply"` write can
still overwrite a file someone edited mid-round. That one is the call doing its
declared job — the caller listed those files as editable — and it is the same
exposure `implement` and `fix` have always had. The distinction that matters is
that **writes which are the point of the call stay; writes that existed only to
produce a report are gone.**

A third review then caught me overcorrecting. Having learned "do not read the
tree", I had made *both* paths render from memory — and on the success path that
is wrong. `applied: true` is a claim **about the working tree**, so the diff has
to describe the tree. Rendering it from `lastWritten` would silently miss a check
that rewrites files (`eslint --fix`, a formatter, a codegen step) as well as
anything that landed after our last write, and would report a diff that does not
match what is on disk while asserting that it does.

So the two paths take opposite sources, and that asymmetry is the actual rule:

- `applied: true` → **read the tree.** The claim is about the tree, so it must be
  observed, not assumed.
- `applied: false` → **use memory.** The diff is an explicitly unapplied proposal
  and the tree is about to be restored; reading disk here is what made the loop
  write the proposal out just to read it back.

A fourth review found the failure handling around those reads. Both of them
swallowed errors into a benign-looking value: the success path fell back to the
*original* bytes, so a file that could not be read rendered as "unchanged"; and
`restore` skipped an unreadable file entirely, reporting a rollback that never
happened. Neither said anything. On Windows a locked or removed file is not
exotic, and the result the caller trusts would have read `files_changed: []` for
work the loop actually did. An unreadable file is now a reported outcome, not a
default: the success path falls back to the last write and lists the file in a new
`unverified`, and `restore` reports it as a conflict. **The failure branch of an
IO call is not the place to pick a value that happens to look fine.**

The general lesson, which is why all of this is written down: **provenance cannot
be recovered by observation, and state cannot be established without it.** If you
need to know who wrote something, record it at write time — checking afterwards
only tells you the current state, which is exactly what is in dispute. But if you
are claiming what the current state *is*, you have to go and look. The first two
bugs came from reading the tree to learn something the code already knew; the
third came from applying that lesson where the tree was the only source of truth.

**`budget_seconds` was not a ceiling.** The first gate ran before the check, and
per-check and model timeouts (300 s each) were independent of it, so
`budget_seconds: 1` could still burn many minutes. It is now an absolute deadline:
the first gate counts against it, and `gate` and the model request are each capped
by what remains. A check that cannot start is reported as not-run — never as green.

**Compaction boundaries were pooled across threads.** A compaction resets *one*
conversation's context, but every boundary was applied to every request, so a
subagent's compaction would reset the main thread's `t`. Boundaries are now
per-thread. **(open point)** Codex asked for affected measurements to be re-run; I
checked instead, and 0 of the 10 compaction records in this project's transcripts
are on a sidechain, so `run 2026-08-02-win-01`'s main-thread figures — the 8.8x
multiplier included — are unaffected. Per-subagent figures in sessions that both
compacted and used subagents would have been wrong, and none were published.

**Packaging shipped neither the hook nor the meter.** `files` listed only `dist`
and the model examples while the README told people to install with
`npx -y github:…` and then run `node hooks/filter-tool-output.mjs`. The cost meter
moved to `src/cost/cli.ts` so it compiles into `dist/` and ships as a
`local-coder-cost-meter` binary; `hooks/` is now published. The hook itself stays a
*file path* — the README documents the `node_modules` path and a one-file copy,
because resolving it through `npx` on every single Bash call would cost more than
it saves.

### A second adversarial review, after the first round of fixes

Four more, and the first one is the case I had explicitly declared out of scope.

**The model's own write was still destroying concurrent edits — and the rollback
was finishing the job.** I had written that this one was "the call doing its
declared job", since the caller lists those files as editable. That framing was
too generous, and the trace shows why: an editor changes the file mid-round, the
model writes over it, `onFileWritten` records the model's bytes as ours, and the
rollback then finds `current === lastWritten`, passes its compare-and-swap, and
restores the ORIGINAL. The user's edit is gone and `restore_conflicts` is empty.
The write may be the tool's job; **silently reverting a file to a state nobody
asked for is not.** `mode: "apply"` now compare-and-swaps across all files before
writing any of them, and `repair` abandons the round without writing
(`stopped_because: "concurrent_edit"`). Declaring a hazard out of scope had not
made it stop happening.

**The corrective retry got a fresh copy of the deadline.** `runGeneration` makes
up to two model requests and both used the timeout computed once, so a hard
`budget_seconds` could be exceeded by nearly another full request. The remaining
budget is now re-read before every attempt, and a retry with nothing left is
skipped rather than started.

**`snapshot()` read every editable file before the size caps applied.**
`enforceContextCaps` only ran later, inside `runGeneration` — so the cap that
exists to stop a huge file from being loaded ran *after* it had been loaded.
Caps are now enforced before anything is read, and the snapshot goes through
`readTextFileSafe`, which also restores the binary sniff it had been skipping.

**Telemetry was joined to the transcript by a ±60 s timestamp window.** Two
sessions on the same project that overlap select each other's rows, and the same
saving is counted in both reports; `requestAtOrAfter` also skipped sidechains, so
a subagent's tool call was priced against a main-thread request with the wrong
positional multiplier. This feeds `savedFraction`, which is B12, which is
`G-stop` — the number that decides whether the project continues.

The fix is provenance again, the same lesson as before: `gate` and `repair` now
mint an `invocation_id`, return it in their payload, and write it into the
telemetry row. The meter joins on that id, so a row either belongs to this
transcript or is dropped and counted in `excludedForeign`. Rows predating the id
still join by timestamp and are reported as `legacyTimeJoined`, because a number
whose provenance is a guess should say so. The MCP server cannot see Claude Code's
session id — there is no such field in an MCP call — so echo-and-match is the only
exact join available.

### **(open point)** the exact join rests on an assumption I have not observed

That our echoed `invocation_id` reaches the transcript inside `toolUseResult` is
**assumed from how Claude Code stores MCP results, and never verified** — this
server is not installed here, so no transcript in this repo contains a single one.
It is the same shape of unverified dependency as B2, and I first wrote it up as if
it worked.

What made that dangerous is the failure mode. If the echo does not survive, every
telemetry row looks foreign, all of them are dropped, and `savedFraction` reports a
confident **0%** — with no error, into the metric that decides `G-stop`. A silently
wrong number is the one outcome this meter exists to prevent, so the code now tells
the two cases apart: a transcript with **no** calls to `gate`/`repair` means those
rows really are another session's and they stay excluded; a transcript **with**
such calls but no ids means the echo is broken, so it falls back to timestamps and
sets `provenanceUnavailable`, which the CLI prints in bold.

**Experiment, whenever the server is next installed:** call `gate` once, run
`npm run cost-meter`, and check that `excludedForeign` and `legacyTimeJoined` are
both 0 and `provenanceUnavailable` is false. One call settles it.

That guard then created a worse bug than the one it fixed, which is worth
recording. The CLI was letting **every** id-bearing row past the time window, on
the reasoning that the join would drop the foreign ones — so when the join became
unavailable, the entire telemetry history of the project fell through to the
timestamp branch and was attributed to whichever session was being reported. The
fallback I added to prevent under-reporting 0% could therefore over-report by
orders of magnitude, and over-reporting is the direction that lets `G-stop` pass on
nothing. Scoping now lives in `scopeTelemetry`, where a row skips the window only
when **this transcript actually recorded its id**; everything else stays bounded by
the session's own span. A safety net that is only checked on the path it was
written for is not a safety net.

And then the scoping trusted an id found in **any** tool's result. The id is
recovered by scanning the serialized payload, so a payload that merely *quotes*
one counts — and `.local-coder/telemetry.jsonl` carries an `invocation_id` on
every line. A single `Read` of that file, the most natural thing to do while
debugging the meter, marked the project's entire id history as belonging to the
current session and re-opened the same inflation. It also defeated the
`provenanceUnavailable` detector, which asks whether *any* id was seen. Ids are
now trusted only from a `gate`/`repair` result: **an echo has to be
distinguishable from a quotation.**

Fixing that broke three of my own tests, correctly. Their fixtures had a
`tool_result` with no matching `tool_use`, so the tool had no name — a shape a
real transcript never has. Test fixtures that skip the parts the code under test
depends on will pass right up until the code starts depending on them.

### The concurrency guarantee is narrowed, not absolute

I wrote that the loop "never overwrites someone else's edit". It cannot promise
that, and the tool description now says what is true instead. Two limits:
`atomicWriteFile` is `write-tmp` + `rename`, which is atomic but not *conditional*,
so between the compare and the rename there is a window that only file locking
could close — it is now a syscall pair rather than the minutes generation takes,
because each file is re-checked immediately before its own write in addition to the
all-files sweep. And a file the model returns unchanged is never write-checked at
all; that case is caught later by the rollback's compare-and-swap instead.

Precision matters here because the previous four defects in this area all came from
believing a guarantee that the code did not actually make.

### B2 was answered by looking, not by an experiment — and it failed

A third adversarial review claimed the hook's `updatedToolOutput` is rejected
because it returns a **string** while Bash results are objects. Checking it did
not need the fresh-session experiment B2 had been waiting for; the answer was
already sitting in transcripts on this machine:

- Bash's native `toolUseResult` is `{stdout, stderr, interrupted, isImage}`, in
  every one of 28 records inspected.
- The hook fired exactly once on a real command — telemetry proves it: raw
  30,136 bytes, returned 8,462, spill file written.
- That command's transcript entry holds **30,000 characters of raw output**
  (Claude Code's own truncation cap) with no trace of the hook's marker.

So the hook ran, filtered, recorded a saving — and the full output entered the
context anyway. **B2 is `fallen`.**

Two things worth keeping. First, the defensive labelling paid for itself: the
`hook_lines_*` measurements were recorded with the note *"hook was invoked
directly, NOT via Claude Code — the billing effect is unverified"*, so no false
saving was ever published. Second, I twice asserted the opposite while working
this out — the first match was a `Read` result (I had read the hook's own source),
the second was the probe that invoked the hook directly, whose output *is* the
filtered text. A string appearing in a transcript says nothing about how it got
there.

**(open point)** What falls is this implementation, not necessarily the
mechanism: the shape mismatch is a specific, cheap explanation, and the correct
shape is visible in the transcript. But `ROADMAP.md` pre-registered "G2 closes as
dead if B2 falls", precisely so that this decision would not be relitigated after
the fact. Retesting once with the object shape is defensible; quietly rewriting
the gate is not. The decision is recorded as pending rather than taken.

### Three fixes the same review was right about

**Check side effects escaped the snapshot.** The loop snapshots `args.files` and
then runs arbitrary project checks repeatedly — a formatter, `eslint --fix`, a
codegen or lifecycle script rewrites other files, and those changes appear in
neither the diff nor the rollback. It now fingerprints the tree before and after
via `git status --porcelain` plus `git diff --numstat`, and reports what changed
outside its own files as `check_side_effects`. Deliberately **report, never
restore**: rolling back a build artifact or a formatter's work would be a second
bug, not a fix. `--numstat` matters because a file that was already dirty when the
loop began is the normal case, and only the added/removed counts reveal that a
check touched it again. Git's ignore rules do the filtering for free, which is the
right filter — build output is not the user's work. `null` means "could not tell",
which is not the same as an empty list.

That fix broke eleven tests on its first attempt, for a reason worth recording: I
borrowed `deps.processRunner` for the `git` calls, and in tests that runner is a
scripted *queue* of check results. Two git calls silently ate the next check's
scripted output. The VCS inventory now has its own `vcsRunner`. **An injection
point belongs to one collaborator; sharing it makes every caller's behaviour a
function of every other caller's call count.**

And on its second attempt the inventory was only read on the normal return, so a
loop that threw reported nothing about what the checks had changed — the identical
omission I had just fixed for the rollback lists, made again in the same edit. The
"before" fingerprint is now taken in `runRepair`, outside the try, so both exits
can diff against it, and the error path throws a single `repair_aborted` carrying
the rollback lists *and* the side effects. The rule I keep having to relearn:
**on the error path the error is the entire report**, so every fact the caller
needs has to be inside it. Adding a new fact to the success path is not done until
the same fact reaches the failure path.

Then a third pass on the same spot: the error path carried the side-effect *value*
but not its **unknown** state. `null` means "could not inventory the tree", and the
success path is careful to say so — but the error path treated `null` as nothing to
report and exited quietly. By the time anything in that block throws, at least one
gate has run, so the checks may well have changed files; staying silent is the
exact conflation the field exists to prevent. An unknown inventory now produces its
own note. **Carrying a value across a boundary is not the same as carrying its
meaning**, and a sentinel that means "I don't know" is the one most likely to be
read as "no" by the next branch that touches it.

And the fix to *that* overshot, on the strength of a comment I wrote asserting
"by the time anything here throws, at least one gate has run". It is false:
`runGate` throws while still reading its own config — invalid `checks.json`, a
category with no checks — and on that path nothing executed, so nothing can have
touched the tree. The UNKNOWN warning fired anyway, and wrapping buried a precise
`checks_config_invalid` under a vague `repair_aborted` for what is simply a
misconfigured project. The warning is now conditioned on a check having actually
run. **A justification written as a comment is not a check**; this one was wrong
the moment it was written, and only a reviewer reading the call graph caught it.

And that guard went on the wrong thing. I conditioned the "unknown" warning on a
check having run and left the "found something" warning free to fire — so with
nothing executed, an edit made elsewhere in that window would still be reported
as *"your checks also changed files"*, which is a claim about causation that
cannot be true when nothing ran. The condition now sits on the **inventory
itself**: no check, no inventory, no claim either way. Guarding one branch of a
decision and not its sibling is the recurring shape of this whole session — the
guard belongs at the point where the fact is established, not at each place it is
later phrased.

The guard itself then turned out to establish a proxy rather than the fact. It was
set when `runGate` **returned**, and a gate can return having executed nothing:
every command missing, or the time budget spent before the first one starts — both
come back as reports carrying `error`. So the flag could say "checks ran" when none
had, and put the warning back on the table it had just been taken off. It now looks
at whether any report came back *without* an `error`, which is what "a process
actually ran" means. **A flag named after a fact should be computed from that fact**;
"the function returned" and "the function did something" are different claims, and
only one of them was the one being relied on.

The replacement signal was still a proxy. `runOne`'s `try` wraps the parsing as
well as the process, so `error` covers both "could not start" and "ran fine, then
blew up while its output was read" — and only the first means the tree is
untouched. `CheckReport` now carries `executed`, flipped the instant the process
comes back and before anything is parsed, and that is what the guard reads.
Three rounds on one question, each answer a slightly better proxy than the last;
the one that held was the one recorded **where the event happens** rather than
inferred downstream from its traces.

**A failed rollback abandoned every remaining file.** `atomicWriteFile` sat
unguarded inside `restore`'s loop, so one locked file rejected the whole promise:
later files were never attempted, and the `catch` upstream flattened it into a log
line. The caller could not even find out which files still held model output. Each
file is now attempted independently, failures collect into `restore_failed`, and
the error path throws a composite `rollback_failed` carrying the original failure
plus both lists — because on that path an error is *all* the caller gets.

**Mixed-model sessions reported a partial sum as a total.** Session USD went
non-null as soon as *any* model had a price, while unpriced requests contributed
zero in silence; the counterfactual then applied the first price it found to every
saving. A session mixing a priced main model with an unpriced subagent model would
under-report and say nothing. USD is now `null` unless **every** billed request is
priced, and each saving is priced at the model of the request it was actually
matched to. Latent today because `inputPerMTok` ships `null` — which is exactly
when a bug like this gets written and never noticed.

### G2 closed, and the shape of the decision was itself the mistake

I framed the G2 disposition as a choice — close it dead, or retest once with the
object shape — and held it open for a decision. That framing was wrong, and
`ROADMAP.md` already said so in its own rules:

> A `closed` gate reopens **only** on a measurement carrying a new `run_id`, and
> the reopening condition is written into the block itself — not decided later.

I had left G2 as `open` with prose saying "decision pending". That is a fifth
state the file does not have, and it defers the reopening condition to later,
which is the one thing the rule forbids. The file's existing machinery handles
this case exactly: **close the gate, and write the reopening condition into it.**

So G2 is now `closed` (dead), the hook is unregistered from
`.claude/settings.json`, and the retest survives as a written condition — one
attempt, threshold fixed, `run_id` required. The difference is not cosmetic. The
default is in force immediately: the hook is off the critical path of every Bash
call, and **B4 goes `moot`** with it, since the premise about heuristic
suppression damaging edit anchors has no live subject. `gate` parses output into
typed failures rather than truncating text, so it cannot destroy an anchor the way
head/tail capping can. **B3's experiment moves to `gate`** for the same reason —
the premise about suppressible bytes still matters, just not about the hook.

`hooks/filter-tool-output.mjs` stays on disk. Unregistering removes the risk and
the dependency; deleting it would only make the pre-written retest expensive
without buying anything.

What is left for a human is *when* to spend a session on the reopening condition.
That is scheduling. It is no longer doctrine, and it should never have been posed
as one.

### Closing a gate means retracting its claims, not just flipping a state

I closed G2 and then left the evidence for it standing everywhere else. A review
caught the residue, and the list is worth keeping because "mark it closed" is the
easy half:

- `README.md` still walked the reader through installing the hook, in two ways,
  with the 604→4 figure as proof — documentation recommending what measurement had
  just killed. `package.json` still shipped `hooks/` to make that install work.
- B3's `Measured:` line still counted the hook's 99% while its experiment had been
  moved to `gate`, and the "Measured facts" table still listed 604→4 as a fact of
  the architecture.
- B12's experiment still called for a "hook enabled versus disabled" arm that no
  longer exists, and `G-stop` still said "once deliveries 1–4 are in use" when one
  of the four was dead.

**The 604→4 number was never wrong; it was answering the wrong question.** The
hook did condense 604 lines into 4. Claude Code then ignored the result. Keeping
that figure in a facts table would have let a true measurement carry a false
implication indefinitely — which is exactly the failure the registry exists to
catch, arriving through the side door.

I withdrew the attribution rather than editing the rows: the `hook_lines_*`
measurements keep their values and their `run_id`, and a new row records that B3
no longer claims them. History is not rewritten; the claim built on it is.

**And the test count was the most flattering lie available.** I had written that
closing G2 "cost no coverage" because `npm test` reported 202 passing before and
after. That is true and it means the opposite of what it sounds like: ten of those
tests cover an unregistered component, they spawn the script directly and assert
on what it returns — and **every one of them passed for the entire time B2 was
false.** They test the boundary that did not matter. The file is kept for G2's
pre-registered retest and now says so in its header; the count is recorded
separately so 202 is not read as 202 tests of live behaviour.

### The contradiction that mattered was in the code, not the prose

Two rounds of cleaning up documents after closing G2, and the review kept saying
the retraction was still contradictory. It was right, and I had been looking in
the wrong place: `npm run cost-meter` was **reporting a saving for the dead hook**.

    session 723e03c0: hook:Bash  1 call  21,674 bytes suppressed → savedFraction 0.39%
    session 1705b026: hook:Bash  1 call  21,674 bytes suppressed → savedFraction 0.42%

That saving never happened. The row is real telemetry — the hook did condense
30,136 bytes to 8,462 — but the replacement was discarded, so nothing was
suppressed from anyone's context. And `savedFraction` is B12, which is `G-stop`.
The meter built to stop us continuing on a dead premise was quietly crediting one.

`PREMISES.md` and `ROADMAP.md` both say, in writing, *"no saving from the hook may
be reported as measured — anywhere, including the cost-meter output."* The rule
was there. Nothing enforced it, because I had written the rule for a human reader
and the violation was in a function.

**The fix is a general rule, not a blocklist.** A telemetry row with no
`invocation_id` cannot point at the transcript entry it produced, so there is no
way to show its output ever reached the context. Those rows are now excluded from
`unitsTotal` and `savedFraction`, counted as `unverifiable`, and their magnitude
reported as `unverifiableUnits` so the exclusion is visible rather than silent.
The hook is dropped by that rule automatically — not because it is named, but
because it is a tool that mutates someone else's result and therefore has no
result of its own to point at. Any future component with the same shape is caught
the same way.

Deliberately *not* covered by the rule: a row that HAS an id when the transcript
carries none. That is a broken echo, not an unverifiable row, and excluding it
would collapse `savedFraction` to a confident zero. `provenanceUnavailable`
already degrades loudly there.

Both sessions now read `savedFraction 0%` with 21,674 and 31,047 units withheld.
Zero is the honest number: nothing in those sessions has yet been shown to save
anything.

### The withheld row was invisible in the only case it existed

Having made the meter stop *counting* the phantom hook saving, I reported that
the exclusion was now "visible rather than silent". It was not. The whole savings
section was gated on `byTool.length > 0`, so when every row in range was withheld
— which is today's state, in both affected sessions — the report printed nothing
at all. A section whose purpose is to surface exclusions omitted the only one it
had.

`buildCounterfactual` had been returning `unverifiable` and `unverifiableUnits`
correctly the entire time. **The data was right and nobody printed it.** The
section now renders whenever there is anything counted *or* anything withheld,
and says "nothing counted — every telemetry row in range was withheld" instead of
falling silent.

Worth naming the pattern, because this is its third appearance in one branch:
B2 died at the boundary between the hook's return value and what Claude Code did
with it; the `invocation_id` echo is unverified at the boundary between an MCP
result and the transcript; this one lived between a correct function and its
report. Every unit test passed through all three. So the fix here is not only the
render — `tests/cost-meter.test.ts` now spawns the **compiled CLI** against a
fixture and asserts the withheld line appears, the same shape as the stdio test.
**A test that stops at the last function call cannot see the last mistake.**

### Fixing the silent case broke the empty case

The predicate I added to un-hide withheld rows was
`counted || excludedForeign > 0 || unverifiable > 0 || provenanceUnavailable`.
The last term does not belong there. `provenanceUnavailable` is a property of the
**transcript** — "this session called gate/repair and no result carried an id" —
and it is true with an entirely empty telemetry log. So a session with **zero
rows** would print "nothing counted — every telemetry row in range was withheld"
and a 0% savings block, while swallowing the correct *"no telemetry yet — savings
appear once the local tools run"*.

Reachable without trying: `--root` defaults to `process.cwd()`, so running the
meter from anywhere but the project reads an empty log against a transcript full
of tool calls.

Only rows that exist now decide whether a savings section is printed. The
broken-echo warning moved **outside** that block, so it survives an empty log
instead of masquerading as one. And a third branch was added for rows that exist
but fall outside this session's range — silence there would have read as "no
telemetry", which is a different and wrong story.

The lesson is narrower than "test the boundary", which I already wrote. It is that
**a predicate mixing "is there data" with "is something wrong with the data" will
lie in whichever case has one but not the other.**

**And then I recorded coverage that did not exist.** The first version of this
entry claimed both new branches were covered by CLI tests. Two tests existed —
withheld-rows and empty-log — and the out-of-range branch had none. A registry
whose entire purpose is to stop unverified things being written down as verified,
asserting a test that was never written, in the same paragraph as a lesson about
untested boundaries. All three branches now have a CLI test against the compiled
binary; the claim was corrected rather than quietly dropped, because the
interesting part is that it happened here.

### Where the numbers live

`PREMISES.md` holds B1–B13 with thresholds and revert conditions; `ROADMAP.md`
holds the gates including the `G-stop` stopping criterion; `MEASUREMENTS.jsonl`
holds every measured value with its `run_id`. The rule that keeps them honest:
a `Measured:` line exists only with a run id, and a premise without an experiment
does not go in `PREMISES.md` at all — it becomes prose here.

### Speed is part of the price, and a snapshot is not a comparison

Two defects, both introduced by the commit that filled in `inputPerMTok` and so
both invisible while every dollar figure was `null`.

**Claude Code's fast mode bills Opus at twice the standard rate and reports the
same model string.** Pricing on the model alone halved any fast-mode session —
and a halved total does not read as a pricing bug, it reads as *the meter is
wrong*, which is exactly the conclusion B1 exists to draw. The field was there
the whole time: `usage.speed` is present on all 628 records of the transcript I
was measuring, saying `standard`. Requests are now priced under `model@speed`,
and a speed with no entry is **unpriced rather than standard-priced** — the same
fail-closed choice as leaving `inputPerMTok` null, for the same reason.

**And I pre-registered a moving number.** Pinning the meter's total before
reading `/usage` is the right instinct — it stops the comparison being adjusted
after the fact — but the session was still running, so the figure grew from
$88.34 to $94.62 while the record said $88.34. Comparing a later `/usage` against
an earlier snapshot manufactures an error out of nothing. **Both sides of B1 must
be read at the same moment, at the end of the session.** Pre-registration binds
the method, not a number the method has not finished producing.

**I also wrote a timestamp that had not happened yet** — `03:40:00Z` recorded at
`03:27Z`, rounded from memory instead of read from the clock. Corrected in place
rather than superseded: a superseding row is for a value that was true and
stopped being true, and this one was never true. `git log -p` keeps the original.

### Speed-aware pricing, finished properly

The speed key was applied in `report.ts` and not in `cli.ts`, so the CLI's
headline multiplier was computed from the bare model while the USD printed four
lines above it came from the speed key. Two numbers on one screen from two
different multiplier sets. Both now go through `rateKey`.

Two things the same review turned up, both worse than the inconsistency:

**The "USD not shown" hint named the model, not the missing key.** With a fast
request and a priced base model, it told the reader to fill in a line that was
already filled in. `unpricedKeys` now carries the exact keys that had no price,
and the hint prints those.

**And the headline had never printed in a real session.** It anchored on the
first request in the file; a resumed session opens with a leftover one-request
segment, so `segmentSize > 1` was false and the line carrying the entire cost
argument — 27.2x, measured — was silently absent every time. It now anchors on
the longest main segment and prints that segment's size, so the figure cannot be
read as covering more of the session than it does. A number that never renders
is indistinguishable from a number that is wrong, and neither is visible from a
passing test suite: nothing asserted the line appears.

**Twice in one session I wrote a timestamp from memory and it landed in the
future.** Both caught by review, not by me. Timestamps are read from the clock
now — `new Date().toISOString()` in the same command that writes the row, never
typed.

### The headline is summed, not multiplied

Reviving the headline was not enough: it still applied turn 0's rate across the
whole segment via `positionalMultiplier`. That is the right way to *state* the
model and the wrong way to *measure* a session — `/model` and `/fast` are both
togglable mid-segment, so after either switch every re-read was being priced at
the pre-switch rate, with the TTL read from turn 0 alone.

`entryCostOfSegment` now sums each later request's own cache-read multiplier and
takes the write from turn 0's own key and TTL. On a uniform segment it agrees
with `positionalMultiplier` exactly — a test pins that, so the closed form stays
the documented model and the sum stays the measurement. When a segment does span
more than one rate key, the line names them rather than averaging them away.

`positionalMultiplier` is unchanged and still used where a single rate is the
right assumption: the counterfactual prices one tool call against the one
request it was matched to.

### A multiplier is a ratio to *a* price, and mixed segments do not have one

The summed headline was still wrong, and wrong in the way this file keeps
warning about. Every multiplier is a ratio to **its own key's** input price.
Summing `2.0` (a multiple of model m's $1) with `0.5` (a multiple of m@fast's
$2) adds quantities with different bases and labels the result "x the input
rate" — a rate no request in the segment actually paid. My own test asserted
`3.0` for a segment whose true entry cost is $4.

Two figures now, with different domains of validity:

- **The ratio** is emitted only when the segment has one base: a single rate
  key, or several keys with identical known prices. Otherwise it is `null` and
  the CLI says why rather than picking one of the bases.
- **USD per million** multiplies each term by its own key's price *before*
  summing, so it stays valid however the segment mixes. It is `null` when any
  key is unpriced.

A single unpriced key still yields a ratio — one base, unknown magnitude, which
is exactly what a multiplier is for. Two *different* unpriced keys do not: their
prices cannot be shown to be equal.

The general lesson is the one the file already had and I did not apply: a number
that is dimensionally wrong looks exactly like a number that is right. The
uniform case — which is every session so far — agreed with the correct answer
throughout, which is why four rounds of review were needed to find it.

### "Unknown" is not "different"

The branch that fires when a mixed segment has an unpriced key said the keys
"are priced differently". It cannot know that. Two keys with no `inputPerMTok`
may share a price exactly; the rates file simply does not say. The message
asserted a pricing fact the data does not contain — the same failure as letting
"we did not look" read as "nothing changed", which this file already records
for `treeFingerprint`, committed again three sections later.

`EntryCost.unpricedKeys` now carries the keys actually missing a price, and the
CLI names them and says the comparison cannot be made. The neighbouring branch
keeps "priced differently" because there it is true: every price is known and
they are not equal.

Worth noting how narrow the survival path was. The wrong claim only printed for
a segment that both mixes rate keys and lacks a price, on a line that until two
commits ago never rendered at all. Three of the last four review findings lived
in cases the live session cannot reach — which is the argument for reviewing
the branch you cannot run, not the one you can.

### Three states, not two

Correcting "different" to "unknown" overcorrected. With prices $1, $2 and one
missing, the known prices already settle it: a missing third price cannot make
two unequal prices equal. Saying "no way to tell" there understates what the
rates file does say — the mirror of the overstatement it replaced, and just as
wrong.

`sharesOneInputRate` is therefore `true | false | null`, and the third is not
the second. `false` is a conclusion drawn from prices we have; `null` is the
absence of one. The CLI prints a different sentence for each, and the ratio
itself is emitted only on `true`.

Two rounds of review on one sentence, in opposite directions. The pattern worth
keeping: "we cannot tell" is a claim about the evidence and needs checking as
carefully as the claim it replaces.

### The output cap was never the ceiling — input and output share one window

`enforceOutputCap` compared an estimated *output* size against
`maxOutputTokens` and nothing else. That is half of the constraint. The model
holds prompt and answer in one context window, and the whole-file contract sends
every editable file **in** and gets every one **back**, so a request costs
roughly twice the bytes it touches. `run 2026-08-04-mac-12-variance` is what the
missing half looks like: `src/tools/repair.ts` cleared the output cap at ~10,187
estimated tokens against ~14,745 usable, and then needed 8,756 prompt + 7,670
completion = 16,426 in a 16,384-token window.

The response was not an error. It was a `<file>` block, properly closed,
`finish_reason: "stop"`, **90 lines short**. Every signal the pipeline reads says
that is fine — which is why this belonged in the pre-flight rather than in
better error handling downstream. There is no downstream.

Three choices inside the fix are worth stating, because each had a cheaper wrong
version.

**Two divisors, not one.** Reusing `outputBytesPerToken` on the input side is the
obvious move and it cost real coverage immediately: `run 2026-08-04-mac-16-preflight`
refused a 26,345 B pair that measured 11,237 actual tokens and had returned
complete 3 of 3. The two quantities are not the same kind of thing. The output
divisor predicts how many tokens a model will *emit* — a guess about behaviour,
kept pessimistic because under-guessing means a truncation. The input divisor
counts tokens in text that already exists, which is arithmetic. Fitted against
the 13 measured prompts, 3.9 is the largest value that under-predicts none of
them.

**An unknown window fails open.** `pickLoadedContextTokens` returns null — skip
the check — when `lms` is unavailable, when nothing is loaded, and when several
models are loaded and none was named. A pre-flight that *refuses* work must not
act on a guess; the asymmetry is that skipping risks one bad response, while
guessing wrong refuses everything. The guard tests for a finite positive number
rather than `!== null` for a reason that was observed, not imagined: `Config`
literals in `tests/helpers.ts` are not type-checked (`tsconfig` covers `src/**`),
so a missing field arrives as `undefined`, makes the budget `NaN`, every `<=`
false, and a check meant to refuse one request refuses every one. Fifty tests
went red on the `!== null` version.

**The corrective retry is its own request and gets its own pre-flight.** This was
missed on the first pass and it is the sharper half of the design: the check ran
once, above the attempt loop, while attempt 2 appends the entire malformed
response plus a corrective message and is therefore strictly larger. An
unchecked, oversized retry is precisely the condition that produces a closed,
well-formed, shorter file — the failure this whole section is about — and
`repair` would have written it over the source. It is now measured from the
accumulated messages rather than re-derived from the files, since the appended
response is the whole reason the size moved, and a retry that will not fit is
**not sent** rather than sent and hoped for.

**The window belongs to the model, and the model is resolved first.** This was
backwards for three commits: `resolveContextTokens` ran on `args.model`, which is
undefined whenever nothing is named, and `resolveModel` picked the actual model
afterwards. The probe then answered with whatever single model happened to be
loaded — a number about a model the request would never touch.
`pickLoadedContextTokens` made it worse by returning that sole loaded model's
window even when a *different* model had been named explicitly. Both spellings
are the same mistake: 32k loaded and 16k used admits a request that overflows,
16k loaded and 32k used refuses work that fits. A named model that is not loaded
now returns null, and `repair` no longer pins one window for the whole loop —
that pin was justified by "a value that cannot change mid-loop", which is untrue
the moment no model is named and each round re-selects.

**`status` reports the window, including when it does not know it.**
`context_window.source` is `config`, `lms` or `unknown`, and `unknown` is the
case worth surfacing loudest: it means the check is switched off, silently. A
refusal users cannot explain is a refusal they will work around.

What this does **not** claim: that ~25 KB is a property of the contract. It is a
property of a 30B coder loaded at 16,384 tokens. The model supports 262,144, and
the honest remedy for both refused cases is `lms load --context-length` plus
`LOCAL_CODER_CONTEXT_TOKENS` to match — not a looser estimate.

### **(open point)** which context-overflow policy was in force

The section above says the model "stopped when the window filled". That is the
obvious reading and it may be wrong, and one detail in it never fit: the response
came back with a **properly closed** `</file>` tag. A model that runs out of room
does not get to close its block.

LM Studio has a `contextOverflowPolicy` with three settings, and only the first
matches the story told above:

| Setting | What happens when the window fills |
|---|---|
| `stopAtLimit` | generation **stops**, native reason `contextLengthReached` |
| `truncateMiddle` | **keeps generating**, removes the middle of the context |
| `rollingWindow` | **keeps generating**, prunes the oldest context |

Under either of the last two the mechanism is different in a way that matters:
LM Studio prunes the **prompt** while the model is still writing, the model loses
sight of the middle of the file it is copying, carries on, and closes the block
normally. That produces `finish_reason: "stop"`, a well-formed block, and 90
missing lines — every observed symptom, including the closing tag the first story
cannot explain.

Two things follow. **The project cannot set this**: an open LM Studio issue
reports the policy is rejected through the `/api/v0` endpoint, with no maintainer
response, so whatever the GUI holds is what ran — and no artifact records it.
**And if it is `rollingWindow`, the pre-flight is only half the fix**; the other
half is switching to `stopAtLimit` so the failure becomes loud instead of silent.

It is one look at a settings panel. Until someone takes it, the causal claim
above is a hypothesis and is labelled as one. B16 is unaffected either way — it
counts the harm, not the mechanism, which is exactly why it was written that way.

**Searched, and it is not reachable from the CLI or from disk.** `lms ps --json`
reports `contextLength` and `maxContextLength` and nothing about the policy, and
a recursive text search of `~/.lmstudio` turns up only the app's own bundled
JavaScript and the `@lmstudio/sdk` type declarations — no user configuration file
carries it. Combined with the open issue that the OpenAI-compatible endpoint
rejects it, that means **the policy is app state that this project can neither
read nor set**. The GUI is the only place it exists, so this point cannot be
closed by anything automatable, and any run whose conclusion depends on the
mechanism has to record the setting by hand.

**The token accounting discriminates between the policies, and it points at
pruning.** `run 2026-08-04-mac-19-32k`, case L10, both attempts of one case:

| | prompt | completion | sum | window |
|---|---|---|---|---|
| attempt 1 | 10,549 | 5,960 | 16,509 | 16,384 |
| attempt 2 | **10,549** | 5,947 | 16,496 | 16,384 |

The diagnostic appends the whole 5,960-token bad response *plus* a corrective
message before attempt 2, so its message list is roughly 6,000 tokens larger —
and the server reported **the same prompt count**, then generated another ~5,900
tokens on top. Under `stopAtLimit` a prompt that alone exceeds the window cannot
produce a six-thousand-token answer. Under `truncateMiddle` or `rollingWindow`
LM Studio prunes the prompt and keeps going, which fits both numbers.

This is not proof — the server could be reporting a cached-prefix figure rather
than what it actually processed — and it is recorded as an observation, not a
conclusion. But it is the first evidence that discriminates between the policies
at all, and it points the same way as the symptom that opened this question: a
block that came back properly closed and 90 lines short.

**`run 2026-08-04-mac-20-32k` narrowed what has to be explained, without
explaining it.** The same request at a real 32,768-token window returns
**complete**, emitting the 10,321 output tokens the file actually needs against
the ~5,835 that were left at 16,384. So the *loss* was arithmetic: there was no
room. What that does not explain is the SHAPE of the loss. A response that
simply runs out of room is cut off at the end; this one came back with a
properly closed `</file>` and a run of 81 lines gone from the **middle**. Only
something that removed content from the prompt while generation continued
produces that shape, which is `truncateMiddle` or `rollingWindow` and not
`stopAtLimit`.

Nothing overflowed at 32,768, so that run cannot discriminate between the
policies — it removes the "maybe the model is just bad at long files" reading and
leaves the mechanism question exactly where it was.

**What the search DID settle is the neighbouring question.** `run
2026-08-04-mac-19-32k` declared a 32,768-token window while `lms ps` reported the
model loaded at **16,384**, and the pre-flight then admitted everything and let
one response come back short. So whatever the overflow policy is, the practical
rule is already decided: **the declared window must be verified against `lms ps`
before it is trusted**, and a run that skips that verification is measuring its
own configuration rather than the model. B16 carries that as a VOID condition.
