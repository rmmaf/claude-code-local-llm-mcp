#!/usr/bin/env bash
#
# corpus-run.sh — drive corpus #1: 20 synthetic mechanical failures, one at a
# time, and score what B6, B7 and B14 can read from the telemetry they leave.
#
#   bash scripts/corpus-run.sh setup     # prepare, then paste the one prompt
#   bash scripts/corpus-run.sh task N    # install task N (the prompt calls this)
#   bash scripts/corpus-run.sh check     # score the run
#   bash scripts/corpus-run.sh restore   # remove any installed fixture
#
# ONE TASK ON DISK AT A TIME, and that is not a convenience. Twenty broken
# fixtures at once would put the other nineteen's failures in every task's gate
# output, and `repair` loops until the gate is GREEN — which never happens with
# nineteen other files broken. Every task would return `max_rounds` and B6's
# close rate would be 0/20 by construction rather than by measurement.
#
# What it does NOT do: call `repair`. That is an MCP tool, so only Claude can.
# The prompt printed by `setup` drives the loop, alternating `task N` with a
# repair call, and `check` scores the rows those calls wrote.
#
# Written for macOS's bash 3.2: no associative arrays, no mapfile, no ${x,,}.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "$REPO_ROOT" ] || [ ! -f "$REPO_ROOT/package.json" ]; then
  echo "cannot locate the repo root from ${BASH_SOURCE[0]} — run this from a clone" >&2
  exit 1
fi

RESULTS_HOME="${LC_RESULTS:-$HOME/lc-results}"
POINTER="$RESULTS_HOME/.corpus-run-current"
TELEMETRY="$REPO_ROOT/.local-coder/telemetry.jsonl"
FIXTURES="$REPO_ROOT/scripts/corpus-fixtures.mjs"

# Bumped whenever setup, task and check stop agreeing about what they exchange.
# `check` refuses a setup stamped with anything else rather than scoring a run
# under a contract it no longer speaks.
CONTRACT="1"
ANALYZER_SENTINEL="// END-OF-CORPUS-ANALYZER-CONTRACT-1"

GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'

SUMMARY=""
note() { if [ -n "$SUMMARY" ]; then printf '%s\n' "$*" >> "$SUMMARY"; fi; printf '%s%s%s\n' "$DIM" "$*" "$OFF"; }
pass() { if [ -n "$SUMMARY" ]; then printf 'PASS  %s\n' "$*" >> "$SUMMARY"; fi; printf '%sPASS%s  %s\n' "$GREEN" "$OFF" "$*"; }
fail() { if [ -n "$SUMMARY" ]; then printf 'FAIL  %s\n' "$*" >> "$SUMMARY"; fi; printf '%sFAIL%s  %s\n' "$RED" "$OFF" "$*"; }
skip() { if [ -n "$SUMMARY" ]; then printf 'SKIP  %s\n' "$*" >> "$SUMMARY"; fi; printf '%sSKIP%s  %s\n' "$YELLOW" "$OFF" "$*"; }

# ---------------------------------------------------------------------- setup

do_setup() {
  RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  OUT="$RESULTS_HOME/corpus-$RUN_ID"
  mkdir -p "$OUT" || { echo "cannot create $OUT" >&2; exit 1; }
  SUMMARY="$OUT/summary.txt"
  : > "$SUMMARY"

  printf '\n%scorpus-run — setup%s\n' "$BOLD" "$OFF"
  printf '%s\n\n' "results: $OUT"
  note "repo: $REPO_ROOT"
  note "date_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [ ! -f "$FIXTURES" ]; then
    fail "scripts/corpus-fixtures.mjs is missing — nothing to install"
    exit 1
  fi

  if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
    skip "working tree is dirty — commit before pulling, or the pull may conflict"
    git -C "$REPO_ROOT" status --short > "$OUT/git-status.txt" 2>&1
    note "     (listed in $OUT/git-status.txt; setup continues without pulling)"
  else
    if git -C "$REPO_ROOT" pull --ff-only > "$OUT/git-pull.txt" 2>&1; then
      pass "pulled: $(git -C "$REPO_ROOT" log -1 --format='%h %s' 2>/dev/null)"
    else
      fail "git pull --ff-only failed — see $OUT/git-pull.txt; nothing was changed"
    fi
  fi

  # The MCP server runs dist/, so an unbuilt change is an unmeasured one.
  if (cd "$REPO_ROOT" && npm run build > "$OUT/build.txt" 2>&1); then
    pass "npm run build"
  else
    fail "npm run build failed — see $OUT/build.txt; the server would load the OLD code"
    note ""
    note "STOPPING. Rows written by the old server are indistinguishable from real ones."
    exit 1
  fi

  # The corpus leans on two things landing in dist. Check for them by name
  # rather than trusting that the build picked them up.
  for symbol in enforceOutputCap createCorpusWriter; do
    if grep -rq "$symbol" "$REPO_ROOT/dist" 2>/dev/null; then
      pass "dist carries $symbol"
    else
      fail "dist does NOT carry $symbol — this build predates what the run measures"
      note ""
      note "STOPPING. Check that the pull landed: git -C \"$REPO_ROOT\" log -1"
      exit 1
    fi
  done

  # Refuse to start on top of a leftover fixture.
  node "$FIXTURES" remove > "$OUT/pre-clean.json" 2>&1 || {
    fail "a file sits at a fixture path and is NOT one of ours — see $OUT/pre-clean.json"
    note "     move it, and nothing here will touch it"
    exit 1
  }

  # THE PRECONDITION, and the one most likely to be wrong on a given machine.
  #
  # `repair` stops when the gate goes GREEN. If anything in this repo is already
  # red, no task can ever reach green: every one returns `max_rounds`, B6 reads
  # 0/20, and the number would be about this checkout rather than about the
  # tool. This repo is known to have 4 pre-existing failures on Windows
  # (core.autocrlf), so the check is not hypothetical.
  printf '\n%schecking the tree is green before anything is installed%s\n' "$BOLD" "$OFF"
  if (cd "$REPO_ROOT" && npx tsc --noEmit > "$OUT/pre-tsc.txt" 2>&1); then
    pass "tsc is green"
  else
    fail "tsc is ALREADY red — see $OUT/pre-tsc.txt"
    note ""
    note "STOPPING. Every task would return max_rounds and B6 would read 0/20 about"
    note "this checkout rather than about repair. Fix the tree first."
    exit 1
  fi
  if (cd "$REPO_ROOT" && npm test > "$OUT/pre-test.txt" 2>&1); then
    pass "npm test is green"
  else
    fail "npm test is ALREADY red — see $OUT/pre-test.txt"
    note ""
    note "STOPPING for the 8 assertion tasks' sake: they end when the SUITE passes,"
    note "so a pre-existing failure makes all 8 unmeasurable. The 12 type tasks would"
    note "still work — re-run with only those if you want a partial corpus, and say so"
    note "when the result is recorded."
    exit 1
  fi

  BASELINE=0
  if [ -f "$TELEMETRY" ]; then
    BASELINE="$(wc -c < "$TELEMETRY" 2>/dev/null | tr -d ' ')"
    [ -n "$BASELINE" ] || BASELINE=0
  fi
  note "telemetry baseline: $BASELINE bytes"

  TOTAL="$(node "$FIXTURES" count)"
  note "tasks: $TOTAL"

  {
    echo "contract='$CONTRACT'"
    echo "run_id='$RUN_ID'"
    echo "repo_root='$REPO_ROOT'"
    echo "baseline='$BASELINE'"
    echo "total='$TOTAL'"
  } > "$OUT/state.env"
  : > "$OUT/tasks.jsonl"
  printf '%s\n' "$OUT" > "$POINTER"

  print_prompt "$TOTAL"
}

print_prompt() {
  total="$1"
  printf '\n%s--- restart Claude Code now ---%s\n' "$BOLD" "$OFF"
  printf '%s\n\n' "The MCP server loads dist/ at startup; without a restart it runs the old code."
  printf '%sPaste this one prompt. It drives all %s tasks.%s\n' "$BOLD" "$total" "$OFF"
  cat <<EOF

  Run this corpus of $total tasks. For i from 1 to $total, in order:

  1. Run: bash scripts/corpus-run.sh task \$i
     It prints one line of JSON with "files", "checks" and "spec".
  2. Call the repair tool with exactly those files, checks and spec, and
     max_rounds: 3.
  3. Report one line: the task id, stopped_because, and rounds.
  4. Go to the next i.

  Rules for the whole run, and they matter more than finishing fast:
  - Do NOT edit any file yourself, before, between or after repair calls.
  - Do NOT fix a task that repair failed to fix. A failure is the measurement.
  - Do NOT skip a task, and do NOT change the arguments the script printed.
  - If repair returns an error, report it and move on to the next i.

EOF
  printf 'When all %s are done:\n\n' "$total"
  printf '    bash scripts/corpus-run.sh check\n\n'
}

# ----------------------------------------------------------------------- task

do_task() {
  index="${1:-}"
  if [ -z "$index" ]; then
    echo "usage: bash scripts/corpus-run.sh task N" >&2
    exit 1
  fi
  if [ ! -f "$POINTER" ]; then
    echo "no setup found — run: bash scripts/corpus-run.sh setup" >&2
    exit 1
  fi
  OUT="$(cat "$POINTER")"
  info="$(node "$FIXTURES" install "$index")" || exit 1
  # Recorded with a timestamp so `check` can pair each repair row with the task
  # that was installed when it ran. Pairing by ORDER would silently mis-assign
  # everything after the first task that got retried or skipped.
  printf '{"index":%s,"installed_at":"%s","task":%s}\n' \
    "$index" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$info" >> "$OUT/tasks.jsonl"
  printf '%s\n' "$info"
}

# ---------------------------------------------------------------------- check

do_check() {
  if [ ! -f "$POINTER" ]; then
    echo "no setup found — run: bash scripts/corpus-run.sh setup" >&2
    exit 1
  fi
  OUT="$(cat "$POINTER")"
  if [ ! -f "$OUT/state.env" ]; then
    echo "setup state missing at $OUT/state.env — run setup again" >&2
    exit 1
  fi
  contract=""
  # shellcheck disable=SC1090
  . "$OUT/state.env"
  SUMMARY="$OUT/check.txt"
  : > "$SUMMARY"

  printf '\n%scorpus-run — check%s\n' "$BOLD" "$OFF"
  if [ "$contract" != "$CONTRACT" ]; then
    fail "that setup was made by a different version of this script (contract '${contract:-none}', this one speaks '$CONTRACT')"
    exit 1
  fi
  printf '%s\n\n' "run: $run_id"

  rm -f "$OUT/analyze.mjs"
  if ! write_analyzer "$OUT" || [ ! -f "$OUT/analyze.mjs" ] ||
     [ "$(tail -n 1 "$OUT/analyze.mjs" 2>/dev/null)" != "$ANALYZER_SENTINEL" ]; then
    fail "could not write a complete analyzer to $OUT — refusing to run whatever is there"
    exit 1
  fi

  CHECK_TELEMETRY="$repo_root/.local-coder/telemetry.jsonl"
  if [ ! -f "$CHECK_TELEMETRY" ]; then
    fail "no telemetry at $CHECK_TELEMETRY — did any repair call run?"
    exit 1
  fi

  node "$OUT/analyze.mjs" "$CHECK_TELEMETRY" "$baseline" "$OUT/tasks.jsonl" "$total" "$OUT/rows.jsonl" >> "$SUMMARY" 2>&1
  status=$?
  cat "$SUMMARY"

  if ! grep -q "^VERDICT:" "$SUMMARY" 2>/dev/null; then
    fail "the analyzer exited $status but never printed a verdict — treating this as no result"
    return 1
  fi
  printf '\nSend back: %s and %s\n' "$OUT/check.txt" "$OUT/rows.jsonl"
  case "$status" in
    0) printf '%sComplete.%s All tasks accounted for.\n\n' "$GREEN" "$OFF" ;;
    2) printf '%sIncomplete.%s Some tasks left no row — read the verdict above.\n\n' "$YELLOW" "$OFF" ;;
    *) printf '%sUnusable.%s Read the verdict above before recording anything.\n\n' "$RED" "$OFF" ;;
  esac
  return "$status"
}

write_analyzer() {
  local part="$1/analyze.$$.part.mjs"
  rm -f "$part"
  cat > "$part" <<'MJSEOF'
// Scores corpus #1. Written by `check` so the scorer and the code reading its
// exit status always come from the same copy of the runner.
import { readFileSync, writeFileSync } from "node:fs";

const [file, baselineRaw, tasksFile, totalRaw, rowsOut] = process.argv.slice(2);
const total = Number(totalRaw);

// Sliced as BYTES, matching what `wc -c` recorded. Reading to a string first
// would count UTF-16 units, so one non-ASCII character earlier in the log would
// shift the cut.
const fresh = readFileSync(file).subarray(Number(baselineRaw)).toString("utf8");
const repairs = [];
for (const line of fresh.split("\n")) {
  try {
    const row = JSON.parse(line);
    if (row.tool === "repair") repairs.push(row);
  } catch {
    // A partially written last line is expected while a tool is running.
  }
}
writeFileSync(rowsOut, repairs.map((r) => JSON.stringify(r)).join("\n") + "\n");

const installs = [];
for (const line of readFileSync(tasksFile, "utf8").split("\n")) {
  try {
    installs.push(JSON.parse(line));
  } catch {
    /* blank line */
  }
}

const out = [];
const say = (s) => out.push(s);
const finish = (code) => {
  console.log(out.join("\n"));
  process.exit(code);
};

say(`tasks installed: ${installs.length} of ${total}`);
say(`repair rows since setup: ${repairs.length}`);

// Pair each row with the task installed most recently BEFORE it was written.
// By order would mis-assign everything after the first retry or skip.
const paired = [];
for (const install of installs) {
  const at = Date.parse(install.installed_at);
  const next = installs.find((i) => Date.parse(i.installed_at) > at);
  const until = next === undefined ? Infinity : Date.parse(next.installed_at);
  const rows = repairs.filter((r) => {
    const t = Date.parse(r.ts);
    return t >= at && t < until;
  });
  paired.push({ install, rows });
}

const scored = [];
const noRow = [];
for (const { install, rows } of paired) {
  const task = install.task ?? {};
  // The LAST row in the window: if a call was somehow repeated, the final
  // attempt is the one that describes where the task ended up.
  const row = rows[rows.length - 1];
  if (row === undefined) {
    noRow.push(install);
    continue;
  }
  scored.push({ id: task.id, category: task.category, row });
}

say("");
say("--- per task ---");
for (const s of scored) {
  const d = s.row.detail ?? {};
  const trace = (d.rounds ?? [])
    .map((q) => `r${q.round}:${q.model_ms}+${q.gate_ms}ms ${q.failures_before}->${q.failures_after}${q.error ? " ERR" : ""}`)
    .join("  ");
  say(`  ${d.passed ? "PASS" : "fail"}  ${(s.id ?? "?").padEnd(30)} ${String(d.stopped_because).padEnd(12)} rounds=${s.row.turns_collapsed} model=${d.model ?? "null"}`);
  if (trace !== "") say(`        ${trace}`);
}
for (const i of noRow) {
  say(`  ----  ${(i.task?.id ?? "?").padEnd(30)} NO TELEMETRY ROW`);
}

// --------------------------------------------------------------------- B6
say("");
say("--- B6: close rate ---");
const closed = scored.filter((s) => s.row.detail?.passed === true);
if (scored.length === 0) {
  say("no scored task; B6 gets nothing from this run");
} else {
  const pct = (100 * closed.length) / scored.length;
  say(`  ${closed.length} of ${scored.length} closed within max_rounds = ${pct.toFixed(1)}%`);
  say(`  (falls below 30%, holds at or above 50% — PREMISES.md B6)`);
  for (const cat of ["type", "import", "assert"]) {
    const inCat = scored.filter((s) => s.category === cat);
    if (inCat.length === 0) continue;
    const ok = inCat.filter((s) => s.row.detail?.passed === true).length;
    say(`    ${cat.padEnd(7)} ${ok}/${inCat.length}`);
  }
  say("  SYNTHETIC, WITH A CHOSEN DISTRIBUTION. This is not a sample of what this");
  say("  project's failures look like — it is 8 type errors, 4 missing imports and");
  say("  8 failing assertions because someone picked those numbers. Record it with");
  say("  that on the same line as the rate, never as a footnote.");
}

// --------------------------------------------------------------------- B7
say("");
say("--- B7: seconds per round ---");
const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
};
const completed = [];
const firstOfCall = [];
const laterInCall = [];
for (const s of scored) {
  for (const q of s.row.detail?.rounds ?? []) {
    // A round that errored never re-ran the gate, so its gate_ms is 0 and its
    // model_ms measures a ceiling, not a round. Those are censored.
    if (typeof q.gate_ms !== "number" || q.gate_ms <= 0) continue;
    const secs = (q.model_ms + q.gate_ms) / 1000;
    completed.push(secs);
    (q.round === 1 ? firstOfCall : laterInCall).push(secs);
  }
}
if (completed.length === 0) {
  say("  no completed round: every round errored, so there is no per-round figure");
} else {
  say(`  median over ${completed.length} completed rounds: ${median(completed).toFixed(2)} s`);
  say(`  (falls above 150 s — PREMISES.md B7)`);
  if (firstOfCall.length > 0) say(`    round 1 of a call (n=${firstOfCall.length}): median ${median(firstOfCall).toFixed(2)} s`);
  if (laterInCall.length > 0) say(`    rounds 2+       (n=${laterInCall.length}): median ${median(laterInCall).toFixed(2)} s`);
  say(`    very first round of the run: ${completed[0].toFixed(2)} s`);
  say("  The split is reported because run 2026-08-04-mac-07 measured 12.6 s cold");
  say("  against ~2 s warm, so a single median hides which one it is made of.");
}

// -------------------------------------------------------------------- B14
say("");
say("--- B14: did anything truncate after passing the pre-flight? ---");
const truncated = scored.filter((s) =>
  (s.row.detail?.rounds ?? []).some((q) => /truncat/i.test(q.error ?? ""))
);
say(`  ${truncated.length} of ${scored.length} scored tasks hit a truncation`);
say(`  (B14 falls above 10%)`);
for (const t of truncated) say(`    ${t.id}`);
if (noRow.length > 0) {
  say("");
  say(`  ${noRow.length} task(s) left no row at all. A pre-flight refusal throws before`);
  say("  repairLoop, so it writes nothing — those are refusals OR calls that never ran,");
  say("  and the two look identical from here. Read the session before counting them.");
}

// ----------------------------------------------------------------- verdict
say("");
say("--- verdict ---");
if (scored.length === 0) {
  say("VERDICT: UNUSABLE — no task produced a telemetry row.");
  finish(1);
}
if (installs.length < total || noRow.length > 0) {
  say(`VERDICT: INCOMPLETE — ${scored.length} of ${total} tasks scored.`);
  say("The numbers above are real for the tasks that ran, and are NOT the corpus.");
  finish(2);
}
say(`VERDICT: complete — all ${total} tasks scored.`);
finish(0);
// END-OF-CORPUS-ANALYZER-CONTRACT-1
MJSEOF
  if [ $? -ne 0 ]; then
    rm -f "$part"
    return 1
  fi
  if [ "$(tail -n 1 "$part" 2>/dev/null)" != "$ANALYZER_SENTINEL" ]; then
    rm -f "$part"
    return 1
  fi
  if ! node --check "$part" >/dev/null 2>&1; then
    rm -f "$part"
    return 1
  fi
  if ! mv -f "$part" "$1/analyze.mjs"; then
    rm -f "$part"
    return 1
  fi
}

# -------------------------------------------------------------------- restore

do_restore() {
  printf '\n%scorpus-run — restore%s\n\n' "$BOLD" "$OFF"
  if node "$FIXTURES" remove; then
    pass "fixture paths are clear"
  else
    fail "a file sits at a fixture path and is NOT one of ours — left untouched"
    printf '\n'
    return 1
  fi
  note "rebuild before your next real session: npm run build"
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
    note ""
    note "still dirty (your own work, untouched by this script):"
    git -C "$REPO_ROOT" status --short
  fi
  printf '\n'
}

case "${1:-}" in
  setup)   do_setup ;;
  task)    do_task "${2:-}" ;;
  check)   do_check ;;
  restore) do_restore ;;
  *)
    cat <<EOF
usage: bash scripts/corpus-run.sh {setup|task N|check|restore}

  setup     pull, build, verify dist, verify the tree is GREEN, record the
            telemetry baseline, print the one prompt that drives the run
  task N    install task N (one on disk at a time) and print its repair args
  check     score every task's telemetry row: B6's rate, B7's median with the
            cold/warm split, B14's truncation count
  restore   remove any installed fixture

The repair calls are Claude's to make: repair is an MCP tool. Everything either
side of that is here.
EOF
    exit 1
    ;;
esac
