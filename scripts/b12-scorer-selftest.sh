#!/usr/bin/env bash
#
# b12-scorer-selftest.sh — drive b12-scorer-mac.sh's two new decision points
# against fabricated evidence, and check what they actually decide.
#
# WHY THIS FILE EXISTS. `bash -n` parses; it does not expand. Four refusals in
# this project stated the symptom correctly and destroyed the cure, and one
# crashed on an unset variable in the message it had just been given, because
# the text was read and never run. The scorer's new logic decides whether a
# premise holds; it does not get to be the part nobody executes.
#
# WHAT MAKES IT A TEST OF THE SHIPPED CODE. Nothing here is a copy. Both units
# under test are EXTRACTED VERBATIM from scripts/b12-scorer-mac.sh at run time:
#   - the telemetry-window reader, between its `<<'JS'` and `JS` markers
#   - the state decision, between `# >>> B12-STATE-BLOCK` and `# <<< ...`
# A copy would pass forever while the original rotted.
#
# Runs anywhere bash and node run. It calls no model, starts no server, and
# touches nothing outside its own temp dir.
#
# Usage:  bash scripts/b12-scorer-selftest.sh

set -u
set -o pipefail

HERE=$(cd "$(dirname "$0")" && pwd -P)
SCORER="$HERE/b12-scorer-mac.sh"
[ -f "$SCORER" ] || { printf 'not found: %s\n' "$SCORER" >&2; exit 1; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/b12selftest.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); printf '    ok    %s\n' "$1"
  else
    FAIL=$((FAIL + 1)); printf '    FAIL  %s\n          expected: %s\n          actual:   %s\n' "$1" "$2" "$3"
  fi
}
head2() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
head2 "Extracting the code under test from $SCORER"
# ---------------------------------------------------------------------------
WINDOW_JS="$TMP/unit-window.cjs"
awk '/^cat > "\$UNIT_WINDOW_JS" <<.JS.$/{f=1;next} f&&/^JS$/{exit} f' "$SCORER" > "$WINDOW_JS"
[ -s "$WINDOW_JS" ] || { printf 'extraction failed: the telemetry-window reader is empty. Did its heredoc markers change?\n' >&2; exit 1; }
printf '    ..    telemetry-window reader: %s lines\n' "$(wc -l < "$WINDOW_JS" | tr -d ' ')"

STATE_SH="$TMP/state-block.sh"
awk '/^  # >>> B12-STATE-BLOCK$/{f=1;next} f&&/^  # <<< B12-STATE-BLOCK$/{exit} f' "$SCORER" > "$STATE_SH"
[ -s "$STATE_SH" ] || { printf 'extraction failed: the state block is empty. Did its markers change?\n' >&2; exit 1; }
printf '    ..    state decision: %s lines\n' "$(wc -l < "$STATE_SH" | tr -d ' ')"

# ---------------------------------------------------------------------------
head2 "The telemetry-window reader, against fabricated windows"
# ---------------------------------------------------------------------------
# A repair row as the tool actually writes one, reduced to the fields the reader
# looks at. Any field this fabricates that the tool does not write is a test
# passing against a shape that never occurs, so keep it to what src/tools/
# repair.ts records: tool, invocation_id, detail.{passed,model,context_files,rounds}.
row() { # row <passed> <model> <context_files json or -> <attempts per round, space separated>
  local passed="$1" model="$2" ctx="$3"; shift 3
  local rounds="" n=1
  for a in $@; do
    local atts=""
    local i=0
    while [ "$i" -lt "$a" ]; do
      atts="$atts{\"attempt\":$((i + 1)),\"finish_reason\":\"stop\"},"
      i=$((i + 1))
    done
    atts=${atts%,}
    rounds="$rounds{\"round\":$n,\"attempts\":[$atts]},"
    n=$((n + 1))
  done
  rounds=${rounds%,}
  local ctxfield=""
  [ "$ctx" = "-" ] || ctxfield=",\"context_files\":$ctx"
  printf '{"tool":"repair","invocation_id":"i%s","detail":{"passed":%s,"model":"%s"%s,"rounds":[%s]}}\n' \
    "$n" "$passed" "$model" "$ctxfield" "$rounds"
}
MODEL="qwen3-coder-30b-a3b-instruct-dwq-v2"
CTXJSON='["src/cost/b12/types.ts","src/cost/rates.ts","src/cost/report.ts"]'
CTXDECL='"src/cost/b12/types.ts", "src/cost/rates.ts", "src/cost/report.ts"'

read_window_of() { # read_window_of <telemetry file> <byte offset> [model expected]
  B12_TELE="$1" B12_FROM="$2" B12_MODEL_EXPECT="${3:-$MODEL}" B12_CTX_EXPECT="$CTXDECL" \
    node "$WINDOW_JS" "$TMP/window.json" 2>&1 | head -1
}

# A window that carries rows from an EARLIER unit before the offset. If the
# offset were ignored, the counts below would include them.
T="$TMP/telemetry.jsonl"
row true "$MODEL" "$CTXJSON" 1 > "$T"
OFFSET=$(wc -c < "$T" | tr -d ' ')

{ row false "$MODEL" "$CTXJSON" 3 2; } >> "$T"
check "rows before the offset are excluded" "1 0 5 ok ok" "$(read_window_of "$T" "$OFFSET")"

: > "$T"; row true "$MODEL" "$CTXJSON" 1 > "$T"
check "one call, passed, one attempt" "1 1 1 ok ok" "$(read_window_of "$T" 0)"

# EXPOSURE B'S AGGREGATE, which is the regression this whole change exists for:
# two repair calls, both dead in the backend, zero tokens generated.
: > "$T"; { row false "$MODEL" "$CTXJSON"; row false "$MODEL" "$CTXJSON"; } > "$T"
check "two calls, no rounds at all -> 0 attempts" "2 0 0 ok ok" "$(read_window_of "$T" 0)"

: > "$T"; row false "$MODEL" "$CTXJSON" 0 0 > "$T"
check "rounds present but empty -> 0 attempts" "1 0 0 ok ok" "$(read_window_of "$T" 0)"

: > "$T"
check "an empty window reports no rows" "0 0 0 unknown no-rows" "$(read_window_of "$T" 0)"

# A gate row in the same window is not a repair row.
: > "$T"; printf '{"tool":"gate","detail":{"passed":true}}\n' > "$T"
check "a gate row is not counted as a repair row" "0 0 0 unknown no-rows" "$(read_window_of "$T" 0)"

: > "$T"; printf 'this line is not json\n' > "$T"; row true "$MODEL" "$CTXJSON" 1 >> "$T"
check "an unparseable line is skipped, not fatal" "1 1 1 ok ok" "$(read_window_of "$T" 0)"

# --- the two VOID conditions -------------------------------------------------
: > "$T"; row true "some-other-model" "$CTXJSON" 1 > "$T"
check "a foreign local model is a mismatch" "1 1 1 mismatch ok" "$(read_window_of "$T" 0)"

: > "$T"; row true "$MODEL" - 1 > "$T"
check "an ABSENT context_files key is unknown, NOT a pass" "1 1 1 ok unknown" "$(read_window_of "$T" 0)"

: > "$T"; row true "$MODEL" 'null' 1 > "$T"
check "a null context_files is unknown, NOT a pass" "1 1 1 ok unknown" "$(read_window_of "$T" 0)"

: > "$T"; row true "$MODEL" '["src/cost/b12/types.ts","src/cost/rates.ts"]' 1 > "$T"
check "report.ts absent from the prompt is missing" "1 1 1 ok missing" "$(read_window_of "$T" 0)"

: > "$T"; row true "$MODEL" '[]' 1 > "$T"
check "an empty context list is missing, not unknown" "1 1 1 ok missing" "$(read_window_of "$T" 0)"

# Two rows, one carrying the key and one not: the run cannot claim the condition
# held on the strength of the row that happens to answer.
: > "$T"; { row false "$MODEL" "$CTXJSON" 1; row true "$MODEL" - 1; } > "$T"
check "one row without the key makes the whole unit unknown" "2 1 2 ok unknown" "$(read_window_of "$T" 0)"

# The JSON side file, which is what reaches the artifact.
: > "$T"; row true "$MODEL" "$CTXJSON" 2 > "$T"
read_window_of "$T" 0 >/dev/null
check "the side file records the observed context files" \
  "src/cost/b12/types.ts,src/cost/rates.ts,src/cost/report.ts" \
  "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).contextFilesObserved.join(",")' "$TMP/window.json")"
check "the side file records the observed model" "$MODEL" \
  "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).localModelObserved.join(",")' "$TMP/window.json")"

# ---------------------------------------------------------------------------
head2 "The state decision, against every branch"
# ---------------------------------------------------------------------------
# Driven with the same variable names the loop uses, under `set -u`, so a name
# this block reads and the loop does not set would fail here rather than on the
# Mac at unit 3 of a $40 run.
state_of() { # state_of <vitest rc> <calls> <passed> <attempts> [model verdict] [ctx verdict]
  (
    set -u
    ok()   { :; }
    info() { :; }
    warn() { :; }
    N=1; UNIT="aggregate"; CLOSED=0; VOIDS=""
    MODEL_LOCAL="$MODEL"; CONTEXT_FILES="$CTXDECL"; UNIT_TELE_JSON="/dev/null"
    VITEST_RC="$1"; R_CALLS="$2"; R_PASSED="$3"; R_ATTEMPTS="$4"
    R_MODEL="${5:-ok}"; R_CTX="${6:-ok}"
    UNIT_STATE=""
    . "$STATE_SH"
    printf '%s|%s|%s' "$UNIT_STATE" "$CLOSED" "$VOIDS"
  )
}

check "repair passed AND vitest 0 -> closed, counted"        "closed|1|"                  "$(state_of 0 1 1 3)"
check "vitest 0 with NO passed row -> green but unverified"  "vitest_green_unverified|0|" "$(state_of 0 1 0 3)"
check "vitest 0 with no repair row at all -> unverified"     "vitest_green_unverified|0|" "$(state_of 0 0 0 0)"
check "vitest 1 with attempts -> red"                        "red|0|"                     "$(state_of 1 2 0 5)"
check "vitest 1, calls made, ZERO attempts -> no_response"   "no_response|0|"             "$(state_of 1 2 0 0)"
check "vitest 1 and no repair row -> no_repair_call"         "no_repair_call|0|"          "$(state_of 1 0 0 0)"
check "vitest 2 -> could_not_run"                            "could_not_run|0|"           "$(state_of 2 1 0 3)"
check "vitest 127 -> could_not_run"                          "could_not_run|0|"           "$(state_of 127 1 0 3)"

# Only `closed` may ever increment the count the pre-registered rule reads.
check "no_response does not increment CLOSED"  "0" "$(state_of 1 2 0 0 | cut -d'|' -f2)"
check "green-unverified does not increment"    "0" "$(state_of 0 1 0 3 | cut -d'|' -f2)"

# The VOIDs, from the same evidence.
check "a model mismatch records a VOID" "closed|1| local-model-mismatch:aggregate" \
  "$(state_of 0 1 1 3 mismatch ok)"
check "an unverifiable context records a VOID" "closed|1| context-unverifiable:aggregate" \
  "$(state_of 0 1 1 3 ok unknown)"
check "a missing context file records a VOID" "closed|1| context-file-missing:aggregate" \
  "$(state_of 0 1 1 3 ok missing)"
check "no rows records BOTH VOIDs" "no_repair_call|0| local-model-unverified:aggregate context-unverifiable:aggregate" \
  "$(state_of 1 0 0 0 unknown no-rows)"

# ---------------------------------------------------------------------------
head2 "End to end: exposure B's aggregate, through both units at once"
# ---------------------------------------------------------------------------
# THE REGRESSION THIS WORK EXISTS FOR. Two repair calls that died inside the LM
# Studio backend before generating a token, and a red oracle. The old logic read
# the vitest exit code alone and published `red` — an observation — for a unit
# that had produced none. It must now come out `no_response`.
: > "$T"; { row false "$MODEL" "$CTXJSON"; row false "$MODEL" "$CTXJSON"; } > "$T"
LINE=$(read_window_of "$T" 0)
set -- $LINE
check "exposure B's aggregate reads as no_response, not red" "no_response|0|" \
  "$(state_of 1 "$1" "$2" "$3" "$4" "$5")"

# ---------------------------------------------------------------------------
printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[1mSELFTEST OK\033[0m — %s checks passed.\n\n' "$PASS"
else
  printf '\033[1mSELFTEST FAILED\033[0m — %s passed, %s failed.\n\n' "$PASS" "$FAIL"
  exit 1
fi
