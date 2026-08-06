#!/usr/bin/env bash
#
# b12-scorer-mac.sh — author the B12 scorer's three arithmetic-core units by
# routing each one through `repair`, and measure whether `repair` can do it.
#
# THIS IS NOT A BUILD SCRIPT. It is `run <date>-mac-b12-phase3`, and it carries a
# question pre-registered in PREMISES.md before a single unit was attempted:
#   >= 2 of 3 units closed  -> `R_repair` is reachable, B12 keeps both deliveries
#   0 of 3 closed           -> B12's text says it measures `gate` alone, BEFORE
#                              Phase 4
#   exactly 1 of 3          -> INCONCLUSIVE; the manifest may not be sealed on it
# A unit counts as CLOSED only if `repair` returns passed:true AND this script's
# own vitest run exits 0. The tool's word is not the measurement.
#
# WHAT IT CHANGES IN YOUR CLONE, stated plainly rather than implied:
#   - writes implementation bodies into src/cost/b12/{terms,strata,aggregate}.ts
#     (the local model does this through `repair`, not this script)
#   - runs `npm ci` and `npm run build`, so node_modules/ and dist/ are rebuilt
#   - appends to .local-coder/telemetry.jsonl and .local-coder/corpus/ (both
#     gitignored) as a side effect of calling the tools
#   - writes ONE new file under evidence/ and ONE .tgz under ~/lc-results/
#   - makes ONE local git commit if anything went green. It never pushes.
# It creates and removes a temp dir under $TMPDIR and nothing else.
#
# bash 3.2 compatible: no associative arrays, no mapfile, no ${x,,}.
#
# Usage:  bash scripts/b12-scorer-mac.sh [/path/to/repo]

set -u
set -o pipefail
# NOT `set -e`, and deliberately: errexit would abort inside the `cmd && ...`
# lines below and before the result is printed. A run that fails must still say
# what it measured.

# ---------------------------------------------------------------------------
# NOTHING THE CLEANUP TOUCHES IS INHERITED FROM THE ENVIRONMENT.
# `TMP_DIR` is an ordinary variable name and the trap is installed long before
# this script assigns it, so any early refusal would otherwise run `rm -rf` on
# whatever the caller happened to have exported. `set -u` does not help: the
# variable IS set, which is the whole problem.
# ---------------------------------------------------------------------------
TMP_DIR=""
TMP_MINE=0
ART=""
ART_FINALISED=0
CLEANED=0
REPO=""
OUT=""
STAGED=""

# Hold every unit's oracle except the current one outside `tests/` for the
# duration of that unit's `repair` call, and put them back before anything is
# measured or committed.
#
# WHY THIS EXISTS. `repair` closes when the PROJECT's gate goes green, and the
# project's gate runs the whole suite. With all three oracles present a unit can
# only return `passed: true` once every OTHER unit is implemented too -- and
# `repair` rolls back on failure, so each unit started from all-stubs and none
# could ever be first. `run 2026-08-06-mac-b12-phase3-efe5806` measured exactly
# that: `strata.ts` was implemented correctly in round 1, the suite stayed red
# for reasons outside that file, and the harness recorded a failure to close.
# The criterion was unsatisfiable by construction; the run is void on that cause.
unstage() {
  for u in $STAGED; do
    if [ -f "$TMP_DIR/b12-$u.test.ts" ] && [ -n "${REPO:-}" ]; then
      mv "$TMP_DIR/b12-$u.test.ts" "$REPO/tests/b12-$u.test.ts" 2>/dev/null
    fi
  done
  STAGED=""
  return 0
}
stage_only() {
  unstage
  for u in strata terms aggregate; do
    [ "$u" = "$1" ] && continue
    if [ -f "$REPO/tests/b12-$u.test.ts" ]; then
      mv "$REPO/tests/b12-$u.test.ts" "$TMP_DIR/b12-$u.test.ts" ||
        refuse "could not hold tests/b12-$u.test.ts aside; the gate would have judged this unit on another unit's tests"
      STAGED="$STAGED $u"
    fi
  done
  return 0
}

cleanup() {
  [ "${CLEANED:-0}" = "1" ] && return 0
  CLEANED=1
  # BEFORE the temp dir goes: a staged oracle lives in there, and losing it
  # leaves the checkout missing a committed file.
  unstage
  # An artifact with no provenance is evidence that hides its own origin.
  if [ "${ART_FINALISED:-0}" != "1" ] && [ -n "${ART:-}" ] && [ -f "$ART" ]; then
    rm -f "$ART"
  fi
  [ "${TMP_MINE:-0}" = "1" ] && [ -n "${TMP_DIR:-}" ] && rm -rf "$TMP_DIR"
  return 0
}
on_signal() {
  printf '\n\033[1mINTERRUPTED\033[0m — stopping here. Nothing further was run.\n' >&2
  cleanup
  trap - INT TERM EXIT
  # RE-RAISE. A handler that ends in `return` resumes the script after the
  # interrupted command, which is how an interrupted run finishes "successfully".
  kill -"$1" "$$"
}
trap cleanup EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    ok    %s\n' "$1"; }
info() { printf '    ..    %s\n' "$1"; }
warn() { printf '    !!    %s\n' "$1"; }
refuse() {
  printf '\n\033[1mREFUSED\033[0m — %s\n\n' "$1" >&2
  printf 'Nothing was scored. Fix the above and re-run; this script is idempotent.\n' >&2
  exit 1
}
step=0
next() { step=$((step + 1)); say "$step. $1"; }

# The frozen inputs. A run that cannot prove it started from these proves nothing.
RATES_FROZEN_AT="3541625"
MIN_CONTEXT=32768
BUDGET_USD="${B12_BUDGET_USD:-40}"
MODEL_CLAUDE="${B12_CLAUDE_MODEL:-claude-sonnet-5}"
MODEL_LOCAL="${B12_LOCAL_MODEL:-qwen3-coder-30b-a3b-instruct-dwq-v2}"
PERMISSION_MODE="${B12_PERMISSION_MODE:-default}"

# ---------------------------------------------------------------------------
next "Locate and identify the repository"
# ---------------------------------------------------------------------------
if [ "${1:-}" != "" ]; then REPO="$1"; else
  REPO=$(git rev-parse --show-toplevel 2>/dev/null)
  [ -n "$REPO" ] || REPO="$HOME/Documents/GitHub/claude-code-local-llm-mcp"
fi
# ASK GIT, NOT THE FILESYSTEM. In a linked worktree `.git` is a FILE containing
# `gitdir: ...`, so `[ -d "$REPO/.git" ]` refuses a perfectly valid checkout.
git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  refuse "no git work tree at $REPO (pass the path as the first argument)"
cd "$REPO" || refuse "cannot enter $REPO"
REPO=$(pwd -P)
[ -n "$REPO" ] || refuse "pwd -P returned nothing; every path below would be built from an empty string"
REPO_NAME=$(node -p "require('$REPO/package.json').name" 2>/dev/null)
[ "$REPO_NAME" = "local-coder-mcp" ] ||
  refuse "$REPO is not this project (package.json name is \"$REPO_NAME\", expected local-coder-mcp)"
ok "$REPO"

RAW=$(git status --porcelain 2>/dev/null)
GIT_RC=$?
[ $GIT_RC -eq 0 ] || refuse "git status exited $GIT_RC; a tree whose state could not be read is not a clean tree"
# TRACKED CHANGES REFUSE; UNTRACKED FILES DO NOT — the same split
# `b12-preflight-mac.sh:103-112` makes, and it matters on a real machine. A Mac
# checkout carries untracked artifacts that belong to other premises entirely:
# on `~/local-coder` the three `contract-stability.json` files B16's holding
# status rests on were sitting untracked, and a blanket dirty-tree refusal is one
# short step from a blanket `git clean` that destroys them.
TRACKED=$(printf '%s\n' "$RAW" | grep -v '^?? ' | grep -E '^..' || true)
UNTRACKED_N=$(printf '%s\n' "$RAW" | grep -c '^?? ')
if [ -n "$TRACKED" ]; then
  refuse "the working tree has TRACKED changes. This script commits what the local model writes, so every tracked change must have come from this run.
$TRACKED"
fi
if [ "${UNTRACKED_N:-0}" -gt 0 ]; then
  warn "$UNTRACKED_N untracked path(s) present. They are LEFT ALONE and never committed: this run commits src/cost/b12/ and its own artifact, nothing else."
fi
ok "no tracked changes"

LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null)
case "$LOCAL_SHA" in
  ????????????????????????????????????????) : ;;
  *) refuse "could not read HEAD (got \"$LOCAL_SHA\")" ;;
esac
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
SHORT=$(printf '%s' "$LOCAL_SHA" | cut -c1-7)
ok "HEAD $SHORT on $BRANCH"

# ---------------------------------------------------------------------------
next "Tools, versions and the pinned binary"
# ---------------------------------------------------------------------------
for bin in git node npm claude tar; do
  command -v "$bin" >/dev/null 2>&1 || refuse "\`$bin\` is not on PATH"
done
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) refuse "could not read node's major version. An unreadable version must not be compared as a number." ;;
esac
[ "$NODE_MAJOR" -ge 18 ] || refuse "node $NODE_MAJOR is too old; package.json requires >= 18"

# Exit code FIRST, then shape. stderr is not folded in: a version read off a
# warning message is not a version.
CLAUDE_VER=$(claude --version 2>/dev/null)
CV_RC=$?
[ $CV_RC -eq 0 ] || refuse "claude --version exited $CV_RC. The version is part of the evidence and may not be guessed at."
CLAUDE_VER=$(printf '%s' "$CLAUDE_VER" | head -1)
case "$CLAUDE_VER" in
  *[0-9].[0-9]*) : ;;
  *) refuse "claude --version returned \"$CLAUDE_VER\", which does not look like a version." ;;
esac
CLAUDE_BIN=$(command -v claude)
CLAUDE_SHA=$(shasum -a 256 "$CLAUDE_BIN" 2>/dev/null | awk '{print $1}')
[ -n "$CLAUDE_SHA" ] || refuse "could not hash $CLAUDE_BIN; VOID 7 pins the binary by sha256"
ok "claude $CLAUDE_VER  ${CLAUDE_SHA}"

LMS_BIN=""
if command -v lms >/dev/null 2>&1; then LMS_BIN="$(command -v lms)"
elif [ -x "$HOME/.lmstudio/bin/lms" ]; then LMS_BIN="$HOME/.lmstudio/bin/lms"; fi
[ -n "$LMS_BIN" ] || refuse "the \`lms\` CLI is missing; install LM Studio's CLI or put it on PATH"
"$LMS_BIN" server start >/dev/null 2>&1 || true
ok "lms $LMS_BIN"

# ---------------------------------------------------------------------------
next "The frozen inputs — rates.json, and the contract this run implements"
# ---------------------------------------------------------------------------
# VOID 4 freezes .local-coder/rates.json byte-identical to the G1-closure commit.
# This is not academic: on the Windows machine the worktree matched and the main
# checkout did not.
RATES_NOW=$(shasum -a 256 "$REPO/.local-coder/rates.json" 2>/dev/null | awk '{print $1}')
RATES_FROZEN=$(git show "$RATES_FROZEN_AT:.local-coder/rates.json" 2>/dev/null | shasum -a 256 | awk '{print $1}')
[ -n "$RATES_NOW" ] || refuse "could not hash .local-coder/rates.json"
[ -n "$RATES_FROZEN" ] || refuse "could not read .local-coder/rates.json at $RATES_FROZEN_AT"
[ "$RATES_NOW" = "$RATES_FROZEN" ] ||
  refuse "rates.json is NOT byte-identical to $RATES_FROZEN_AT.
  here:   $RATES_NOW
  frozen: $RATES_FROZEN
VOID 4 forbids scoring against a different rate table."
ok "rates.json byte-identical to $RATES_FROZEN_AT"

# The contract arrives from the Windows side. This script does not invent it.
for f in \
  "src/cost/b12/types.ts" \
  "src/cost/b12/terms.ts" \
  "src/cost/b12/strata.ts" \
  "src/cost/b12/aggregate.ts" \
  "tests/b12-fixtures.ts" \
  "tests/b12-strata.test.ts" \
  "tests/b12-terms.test.ts" \
  "tests/b12-aggregate.test.ts" \
  "docs/b12-scorer/UNIT-1.md" \
  "docs/b12-scorer/UNIT-2.md" \
  "docs/b12-scorer/UNIT-3.md" ; do
  [ -s "$REPO/$f" ] || refuse "$f is missing or empty. The specs and the oracles are authored on the other machine and arrive by \`git pull\`; this script will not invent them."
done
ok "contract present: 3 stubs, 3 specs, 3 per-unit oracles, 1 type module"

# ---------------------------------------------------------------------------
next "Install, build, and verify the build BY SYMBOL"
# ---------------------------------------------------------------------------
npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1 ||
  refuse "npm ci and npm install both failed"
npm run build >/dev/null 2>&1
BUILD_RC=$?
[ $BUILD_RC -eq 0 ] || refuse "npm run build exited $BUILD_RC"
# The MCP server loads dist/ at startup. Trusting the build is how a stale dist
# has already fooled this project; check for the symbol the run depends on.
grep -q "excludedForeignUnits" "$REPO/dist/cost/report.js" ||
  refuse "dist/cost/report.js has no excludedForeignUnits — the build did not land the instrument repair this run scores against"
ok "dist/ carries excludedForeignUnits"

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/b12scorer.XXXXXX") || refuse "could not create a temp dir"
TMP_MINE=1

# ---------------------------------------------------------------------------
next "The local model, and the context window it is actually loaded with"
# ---------------------------------------------------------------------------
WIN_JS="$TMP_DIR/window.mjs"
cat > "$WIN_JS" <<'JS'
import { pathToFileURL } from "node:url";
const dist = process.argv[2];
const wanted = process.argv[3];
const { getLoadedLmsModels, pickLoadedContextTokens } = await import(
  pathToFileURL(dist + "/lms.js").href
);
try {
  const loaded = await getLoadedLmsModels();
  const ctx = pickLoadedContextTokens(loaded, wanted);
  process.stdout.write(String(ctx === null ? "unknown" : ctx) + "\n");
} catch (e) {
  process.stdout.write("unknown\n");
}
JS
[ -s "$WIN_JS" ] || refuse "could not write the window probe"

read_window() {
  WINDOW=$(node "$WIN_JS" "$REPO/dist" "$MODEL_LOCAL" 2>/dev/null | head -1)
  return 0
}

read_window
# TEST THE GOOD VALUES. A value the rule does not name must not be read as one
# that it does — `[ "$X" = "unknown" ]` alone passes for an empty probe result.
case "$WINDOW" in
  ''|*[!0-9]*)
    refuse "the context probe reported \"$WINDOW\", which is not a number. An unreadable window must not be compared against a floor.

THE USUAL CAUSE IS THAT THE MODEL IS NOT LOADED. LM Studio unloads an idle model
on its TTL, and \`pickLoadedContextTokens\` returns null rather than borrowing an
unrelated model's window — a 32k model loaded while the request goes to a 16k one
admits a request that overflows, and the answer comes back closed, well-formed
and short.

  lms ps    # what is loaded, and under which id
  lms unload --all; lms load \"$MODEL\" --context-length $MIN_CONTEXT

If \`lms ps\` shows the model loaded under a DIFFERENT id than \"$MODEL\", that is
the other cause: pass the served id in B12_LOCAL_MODEL rather than renaming
anything." ;;
esac
[ "$WINDOW" -ge "$MIN_CONTEXT" ] || refuse "the loaded context window is $WINDOW, under the $MIN_CONTEXT floor.
Reload with:  lms load \"$MODEL_LOCAL\" --context-length $MIN_CONTEXT
This is a refusal and not a warning: at 16384 a second repair round sits about
1,400 tokens from context_would_overflow, which \`repair\` reports as
\`model_failed\` — the same label a genuine model failure gets. The Phase-3 count
this run pre-registered cannot tell those apart, so it must not be taken."
WINDOW_START="$WINDOW"
ok "context window $WINDOW_START (floor $MIN_CONTEXT)"

# ---------------------------------------------------------------------------
next "The MCP config this run uses, and nothing the machine already had"
# ---------------------------------------------------------------------------
# THE SERVER DOES NOT INHERIT THE SHELL. Its env comes from the `env` block of
# its own entry, and Claude Code rewrites ~/.claude.json on exit — so
# `export LOCAL_CODER_*` reaches nothing. --strict-mcp-config guarantees the
# globally registered `local-coder` cannot claim the same name.
MCP_CFG="$TMP_DIR/b12-mcp.json"
node -e '
const fs = require("fs");
fs.writeFileSync(process.argv[1], JSON.stringify({
  mcpServers: { "local-coder": {
    command: "node",
    args: [process.argv[2] + "/dist/server.js"],
    env: {
      LOCAL_CODER_MAX_OUTPUT_TOKENS: "16384",
      LOCAL_CODER_CONTEXT_TOKENS: process.argv[3],
      LOCAL_CODER_TIMEOUT_MS: "600000",
      LOCAL_CODER_AUTO_CLAUDE_MD: "0",
    },
  } },
}, null, 2) + "\n");
' "$MCP_CFG" "$REPO" "$WINDOW_START" || refuse "could not write the MCP config"
node -e '
const c = require(process.argv[1]);
const a = c.mcpServers["local-coder"].args[0];
if (!require("fs").existsSync(a)) { console.error("server entry does not exist: " + a); process.exit(1); }
' "$MCP_CFG" || refuse "the MCP config does not point at a server that exists (is \$REPO quoted correctly?)"
ok "mcp config written and parsed back"

TELEMETRY="$REPO/.local-coder/telemetry.jsonl"
BASELINE=$(wc -c < "$TELEMETRY" 2>/dev/null | tr -d ' ')
[ -n "$BASELINE" ] || BASELINE=0
info "telemetry baseline $BASELINE bytes"

# THE CORPUS NEEDS A BASELINE TOO, AND SHIPPED WITHOUT ONE. `cp -R` of the whole
# directory presents every capture ever taken on this machine as this run's --
# `~/local-coder` already holds three from earlier work. Telemetry was baselined
# in bytes from the start; this is the same rule arriving late.
CORPUS_DIR="$REPO/.local-coder/corpus"
CORPUS_BEFORE="$TMP_DIR/corpus-before.txt"
ls "$CORPUS_DIR" 2>/dev/null | sort > "$CORPUS_BEFORE" || : > "$CORPUS_BEFORE"
CORPUS_PRE=$(wc -l < "$CORPUS_BEFORE" | tr -d ' ')
info "corpus entries already present: $CORPUS_PRE (these are NOT shipped)"

RUN_ID="$(date -u +%Y-%m-%d)-mac-b12-phase3-$SHORT"
OUT="${LC_RESULTS:-$HOME/lc-results}/$RUN_ID"
mkdir -p "$OUT" || refuse "could not create $OUT"
UNITS_JSON="$TMP_DIR/units.json"
: > "$UNITS_JSON"

# ---------------------------------------------------------------------------
next "Three units, one claude session each"
# ---------------------------------------------------------------------------
SPENT="0"
CLOSED=0
ATTEMPTED=0

# DEPENDENCY ORDER, not alphabetical. `strata` depends on nothing; `terms` calls
# `subagentShare` from it; `aggregate` calls `partitionByStrata`. A unit that
# closes stays applied, so each one is attempted against a tree where its
# dependencies are real rather than stubs.
for N in 1 2 3; do
  case $N in
    1) UNIT="strata" ;;
    2) UNIT="terms" ;;
    3) UNIT="aggregate" ;;
  esac
  SRC="src/cost/b12/$UNIT.ts"
  SPEC="docs/b12-scorer/UNIT-$N.md"
  TESTFILE="tests/b12-$UNIT.test.ts"
  [ -f "$REPO/$TESTFILE" ] || refuse "$TESTFILE is missing; this unit has no oracle"

  # THE BUDGET GATE. Between units and never inside one: 2.1.220 has no
  # --max-turns, so a runaway session is bounded by the clock alone. One unit per
  # invocation is what keeps that costing a unit rather than the run.
  OVER=$(node -e 'process.stdout.write(Number(process.argv[1]) >= Number(process.argv[2]) ? "yes" : "no")' "$SPENT" "$BUDGET_USD")
  if [ "$OVER" = "yes" ]; then
    warn "budget ceiling reached (\$$SPENT of \$$BUDGET_USD) — refusing to start unit $N"
    break
  fi

  say "unit $N/$UNIT  (spent so far: \$$SPENT of \$$BUDGET_USD)"
  ATTEMPTED=$((ATTEMPTED + 1))

  SESSION_ID=$(uuidgen | tr 'A-Z' 'a-z')
  case "$SESSION_ID" in
    ????????-????-????-????-????????????) : ;;
    *) refuse "uuidgen did not produce a uuid (got \"$SESSION_ID\"). The artifact reads the session back by this id." ;;
  esac

  PROMPT="Read exactly these files and no others: $SPEC (the specification), src/cost/b12/types.ts, and $SRC (the stub you are closing).

Then call mcp__local-coder__repair EXACTLY ONCE, with these arguments:
  files:         [\"$SRC\"]
  spec:          the full text of $SPEC, verbatim
  checks:        \"all\"
  max_rounds:    3
  context_files: [\"src/cost/b12/types.ts\", \"src/cost/rates.ts\"]

Then report, verbatim, the returned passed, rounds_used, stopped_because and
invocation_id.

ALSO report the returned \`diff\` field verbatim inside a fenced code block,
truncated to its first 400 lines if it is longer. When repair does not close, it
rolls the tree back and that diff is the ONLY surviving record of what the local
model actually wrote — without it nobody can tell a near miss from nonsense.

You MUST NOT write, edit or patch any file yourself. You MUST NOT use Bash, Glob,
Grep, Task or any search tool. You MUST NOT read $TESTFILE: it is the oracle, and
reading it into context is the cost this project exists to avoid.

If repair returns passed:false, call it a SECOND time with the same arguments and
the remaining_failures appended to the spec text. If the second call also returns
passed:false, STOP and report that. Do not implement it yourself — a body you
write closes the gate and destroys the measurement this run exists to produce."

  # Only this unit's oracle is in the gate `repair` has to close.
  stage_only "$UNIT"
  info "staged aside:$STAGED"

  UNIT_LOG="$OUT/unit-$N-$UNIT.claude.json"
  # TWO GUARDS, BOTH REQUIRED. --allowed-tools and --mcp-config are variadic and
  # swallow every following argument until one starts with `-`: the last option
  # before the prompt must be NON-variadic, and `--` must end option parsing.
  DISABLE_AUTOUPDATER=1 claude --print --output-format json \
    --model "$MODEL_CLAUDE" \
    --strict-mcp-config --mcp-config "$MCP_CFG" \
    --allowed-tools "mcp__local-coder__repair,mcp__local-coder__gate,Read" \
    --disallowedTools "Task,WebSearch,WebFetch,Glob,Grep,Edit,Write,Bash,NotebookEdit" \
    --session-id "$SESSION_ID" \
    --permission-mode "$PERMISSION_MODE" \
    -- \
    "$PROMPT" >"$UNIT_LOG" 2>"$OUT/unit-$N-$UNIT.stderr"
  CLAUDE_RC=$?
  info "claude exited $CLAUDE_RC"
  # Restore before ANYTHING is measured, so the number below is taken against
  # the tree as committed and not against the staged one.
  unstage

  # Cost, read off the envelope. AN ABSENT FIELD REFUSES; nothing in this
  # repository parses this envelope yet, so it gets no benefit of the doubt.
  UNIT_USD=$(node -e '
    const fs = require("fs");
    let t; try { t = fs.readFileSync(process.argv[1], "utf8"); } catch { process.stdout.write("ABSENT"); process.exit(0); }
    let o; try { o = JSON.parse(t); } catch { process.stdout.write("ABSENT"); process.exit(0); }
    const rows = Array.isArray(o) ? o : [o];
    let n = null;
    for (const r of rows) if (r && typeof r.total_cost_usd === "number") n = (n ?? 0) + r.total_cost_usd;
    process.stdout.write(n === null ? "ABSENT" : String(n));
  ' "$UNIT_LOG")
  if [ "$UNIT_USD" = "ABSENT" ]; then
    warn "the session envelope carried no total_cost_usd. The budget gate cannot see this unit, so the run stops here rather than continuing blind."
    UNIT_USD="0"
    BUDGET_BLIND=1
  fi
  SPENT=$(node -e 'process.stdout.write(String(Number(process.argv[1]) + Number(process.argv[2])))' "$SPENT" "$UNIT_USD")
  info "unit cost \$$UNIT_USD  (running total \$$SPENT)"

  # THE MEASUREMENT, TAKEN BY THIS SCRIPT AND NOT READ OFF CLAUDE'S NARRATION.
  # This unit's oracle alone — the pre-registration says "that unit's tests", and
  # the first attempt handed it everyone's.
  npx vitest run "$TESTFILE" >"$OUT/unit-$N-$UNIT.vitest.txt" 2>&1
  VITEST_RC=$?
  case $VITEST_RC in
    0) UNIT_STATE="closed"; CLOSED=$((CLOSED + 1)); ok "unit $N closed — vitest exit 0" ;;
    1) UNIT_STATE="red"; warn "unit $N still red" ;;
    *) UNIT_STATE="could_not_run"; warn "vitest exited $VITEST_RC — could not run, which is NOT the same as red" ;;
  esac

  node -e '
    const fs = require("fs");
    fs.appendFileSync(process.argv[1], JSON.stringify({
      unit: Number(process.argv[2]), name: process.argv[3], sessionId: process.argv[4],
      claudeExit: Number(process.argv[5]), vitestExit: Number(process.argv[6]),
      state: process.argv[7], usd: process.argv[8], model: process.argv[9],
    }) + "\n");
  ' "$UNITS_JSON" "$N" "$UNIT" "$SESSION_ID" "$CLAUDE_RC" "$VITEST_RC" "$UNIT_STATE" "$UNIT_USD" "$MODEL_CLAUDE"

  if [ "${BUDGET_BLIND:-0}" = "1" ]; then
    warn "stopping after unit $N: the budget gate is blind and continuing would be unbounded"
    break
  fi
done

# ---------------------------------------------------------------------------
next "The window, read again"
# ---------------------------------------------------------------------------
read_window
WINDOW_END="$WINDOW"
case "$WINDOW_END" in
  ''|*[!0-9]*) WINDOW_END="unknown" ;;
esac
if [ "$WINDOW_END" = "$WINDOW_START" ]; then
  ok "window held at $WINDOW_START"
else
  warn "WINDOW MOVED: $WINDOW_START -> $WINDOW_END. run 2026-08-04-mac-22 saw exactly this with the server still up. Every unit after the drift is suspect and the artifact records both readings."
fi

# ---------------------------------------------------------------------------
next "Telemetry, corpus, artifact"
# ---------------------------------------------------------------------------
node -e '
  const fs = require("fs");
  const [file, baseline, out] = process.argv.slice(1);
  let buf; try { buf = fs.readFileSync(file); } catch { fs.writeFileSync(out, ""); process.exit(0); }
  fs.writeFileSync(out, buf.subarray(Number(baseline)));
' "$TELEMETRY" "$BASELINE" "$OUT/telemetry-slice.jsonl"
info "telemetry slice $(wc -c < "$OUT/telemetry-slice.jsonl" | tr -d ' ') bytes"
# Only what THIS run captured. `comm -13` against the baseline listing, so a
# machine with prior captures ships the new ones and says how many it withheld.
CORPUS_NEW=0
mkdir -p "$OUT/corpus"
if [ -d "$CORPUS_DIR" ]; then
  ls "$CORPUS_DIR" 2>/dev/null | sort > "$TMP_DIR/corpus-after.txt"
  comm -13 "$CORPUS_BEFORE" "$TMP_DIR/corpus-after.txt" > "$TMP_DIR/corpus-new.txt" 2>/dev/null
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    cp -R "$CORPUS_DIR/$entry" "$OUT/corpus/" 2>/dev/null && CORPUS_NEW=$((CORPUS_NEW + 1))
  done < "$TMP_DIR/corpus-new.txt"
fi
info "corpus FROM THIS RUN: $CORPUS_NEW ($CORPUS_PRE pre-existing, withheld)"

mkdir -p "$REPO/evidence" || refuse "could not create $REPO/evidence"
ART="$REPO/evidence/$(date -u +%Y-%m-%d)-mac-b12-$SHORT.scorer.json"
rm -f "$ART"

# Provenance by QUOTED heredoc, values passed by ENV VAR NAME never positionally,
# and a sentinel read back out of the file that was written. An artifact whose
# provenance did not land is deleted by the trap rather than shipped.
MERGE_JS="$TMP_DIR/merge.cjs"
cat > "$MERGE_JS" <<'JS'
const { readFileSync, writeFileSync, existsSync } = require("fs");
const e = process.env;
const file = process.argv[2];
const units = existsSync(e.B12_UNITS)
  ? readFileSync(e.B12_UNITS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const closed = units.filter((u) => u.state === "closed").length;
const reading =
  units.length < 3 ? "incomplete — fewer than three units attempted"
  : closed >= 2 ? "R_repair reachable (>= 2 of 3)"
  : closed === 0 ? "R_repair unreachable (0 of 3) — B12's text must say it measures gate alone BEFORE Phase 4"
  : "INCONCLUSIVE (exactly 1 of 3) — the manifest may not be sealed on this";
const o = {
  runId: e.B12_RUN_ID,
  premise: "B12",
  phase: 3,
  preRegisteredIn: "PREMISES.md § B12 — PHASE 3 READING RULE",
  unitsAttempted: units.length,
  unitsClosed: closed,
  reading,
  units,
  spendUsd: e.B12_SPENT,
  budgetUsd: e.B12_BUDGET,
  contextWindow: { atStart: e.B12_WIN_START, atEnd: e.B12_WIN_END, floor: e.B12_MIN_CTX },
  // Counted apart so the archive cannot present an older capture as this run's.
  corpus: { fromThisRun: e.B12_CORPUS_NEW, preExistingWithheld: e.B12_CORPUS_PRE },
  context: {
    commit: e.B12_SHA,
    branch: e.B12_BRANCH,
    claudeVersion: e.B12_CLAUDE_VER,
    claudeBinarySha256: e.B12_CLAUDE_SHA,
    claudeModel: e.B12_MODEL,
    localModel: e.B12_LOCAL_MODEL,
    ratesSha256: e.B12_RATES,
    host: "mac",
  },
  caveat:
    "Three units, one repository, one local model. This is EXPOSURE, not a rate. " +
    "It decides nothing about R_gate, nothing about the bracket, and nothing about " +
    "whether B12 holds or falls.",
};
writeFileSync(file, JSON.stringify(o, null, 2) + "\n");
const back = JSON.parse(readFileSync(file, "utf8"));
if (!back.context || !back.context.commit) { console.error("provenance did not land in " + file); process.exit(1); }
process.stdout.write("B12-SCORER-OK closed=" + closed + "/" + units.length + "\n");
JS
[ -s "$MERGE_JS" ] || refuse "the merge script is empty; the artifact would have been finalised with no provenance"

MERGE_OUT=$(B12_RUN_ID="$RUN_ID" B12_UNITS="$UNITS_JSON" B12_SPENT="$SPENT" B12_BUDGET="$BUDGET_USD" \
  B12_WIN_START="$WINDOW_START" B12_WIN_END="$WINDOW_END" B12_MIN_CTX="$MIN_CONTEXT" \
  B12_SHA="$LOCAL_SHA" B12_BRANCH="$BRANCH" B12_CLAUDE_VER="$CLAUDE_VER" B12_CLAUDE_SHA="$CLAUDE_SHA" \
  B12_MODEL="$MODEL_CLAUDE" B12_LOCAL_MODEL="$MODEL_LOCAL" B12_RATES="$RATES_NOW" \
  B12_CORPUS_NEW="$CORPUS_NEW" B12_CORPUS_PRE="$CORPUS_PRE" \
  node "$MERGE_JS" "$ART" 2>&1)
case "$MERGE_OUT" in
  *B12-SCORER-OK*) ART_FINALISED=1; ok "$MERGE_OUT" ;;
  *) refuse "could not write provenance into the artifact, so it was removed rather than shipped.
$MERGE_OUT" ;;
esac
cp "$ART" "$OUT/" 2>/dev/null || true

# ---------------------------------------------------------------------------
next "Commit locally, and package for transport"
# ---------------------------------------------------------------------------
# EVERY ORACLE BACK BEFORE ANYTHING IS COMMITTED. Staging moves committed files
# out of the tree; a commit taken while one is still aside would record it as
# deleted. Checked rather than assumed, because the failure is silent.
unstage
for u in strata terms aggregate; do
  [ -f "$REPO/tests/b12-$u.test.ts" ] ||
    refuse "tests/b12-$u.test.ts did not come back from staging. Restore it with \`git checkout -- tests/\` before committing anything."
done
ok "all three oracles restored"

# The Mac cannot push. The bundle applies exactly; the diff is what gets read.
# SCOPED, NEVER `git add -A`. The blanket form sweeps in whatever else the
# checkout was carrying -- on the machine this was written against, that would
# have been an unrelated directory and the three untracked `contract-stability`
# artifacts B16's holding status rests on, all under a commit message about the
# scorer. A commit that claims one thing and contains another is worse than an
# uncommitted file.
if [ -n "$(git status --porcelain -- src/cost/b12 2>/dev/null)" ] || [ -f "$ART" ]; then
  git add src/cost/b12 >/dev/null 2>&1
  [ -f "$ART" ] && git add "$ART" >/dev/null 2>&1
  git commit -q -m "wip: scorer bodies authored by repair on the Mac ($RUN_ID)

$CLOSED of $ATTEMPTED units closed. Written by scripts/b12-scorer-mac.sh; the
bodies under src/cost/b12/ are the local model's, not a human's. Reviewed on the
other machine before this reaches main." >/dev/null 2>&1 &&
    ok "committed $(git rev-parse --short HEAD)" || warn "commit failed; the diff is still in the archive"
else
  info "nothing to commit — no unit changed a file"
fi
# EVERYTHING THE REMOTE LACKS, not just what this run made. The range used to
# start at the run's own first commit, which silently stranded anything committed
# on this machine BEFORE the run — and the first real use of this script had
# exactly that: three `evidence/` artifacts that exist on one Mac and back claims
# B16 is holding on. The Mac cannot push, so a commit the bundle omits has no
# other way off the machine.
BUNDLE_BASE=$(git rev-parse --verify --quiet "origin/$BRANCH" 2>/dev/null)
[ -n "$BUNDLE_BASE" ] || BUNDLE_BASE="$LOCAL_SHA"
git bundle create "$OUT/new-commits.bundle" "$BUNDLE_BASE..HEAD" >/dev/null 2>&1 ||
  info "no commits the remote lacks"
git log --oneline "$BUNDLE_BASE..HEAD" > "$OUT/commits.txt" 2>/dev/null || true
info "commits the bundle carries: $(wc -l < "$OUT/commits.txt" 2>/dev/null | tr -d ' ')"
git diff "$BUNDLE_BASE" HEAD > "$OUT/changes.diff" 2>/dev/null || true

ARCHIVE="${LC_RESULTS:-$HOME/lc-results}/$RUN_ID.tgz"
if tar -czf "$ARCHIVE" -C "$OUT" . 2>"$OUT/tar.err"; then
  ok "archive -> $ARCHIVE"
else
  warn "could not write $ARCHIVE — see $OUT/tar.err. $OUT still holds everything."
  ARCHIVE="$OUT"
fi

printf '\n\033[1mDONE\033[0m — %s of %s units closed.\n' "$CLOSED" "$ATTEMPTED"
printf '\nSend back exactly this one file:\n  %s\n' "$ARCHIVE"
printf '\nIt carries: the run artifact with provenance, the git bundle and diff of\n'
printf 'what the local model wrote, the telemetry slice, the corpus captures, and\n'
printf 'the per-unit claude and vitest logs.\n\n'
printf 'The one thing this script changed that it does not undo: node_modules/ and\n'
printf 'dist/ were rebuilt. Undo with:  rm -rf node_modules dist && npm ci\n\n'
