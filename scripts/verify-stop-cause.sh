#!/usr/bin/env bash
#
# verify-stop-cause.sh — check the two instrument fixes of run 2026-08-03-mac-06
# against a real local model, and collect B7's first per-round timings.
#
#   bash scripts/verify-stop-cause.sh setup     # prepare, then paste the prompts
#   bash scripts/verify-stop-cause.sh check     # score what the session produced
#   bash scripts/verify-stop-cause.sh restore   # remove the fixtures
#
# What it does NOT do: run the tests. `repair` is an MCP tool, so only Claude
# can call it — a shell cannot. This script does every deterministic part and
# hands you three prompts; `check` then scores the telemetry those calls wrote.
#
# What is being verified, and why a mocked test is not enough: the unit suite
# already pins the classification on both sides of the boundary with a fake
# clock. What it cannot produce is a real `model_ms`, and B7 has never had one.
#
# Written for macOS's bash 3.2: no associative arrays, no mapfile, no ${x,,}.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "$REPO_ROOT" ] || [ ! -f "$REPO_ROOT/package.json" ]; then
  echo "cannot locate the repo root from ${BASH_SOURCE[0]} — run this from a clone" >&2
  exit 1
fi

RESULTS_HOME="${LC_RESULTS:-$HOME/lc-results}"
POINTER="$RESULTS_HOME/.verify-stop-cause-current"
TELEMETRY="$REPO_ROOT/.local-coder/telemetry.jsonl"
SMALL="src/scratch-stopcause-small.ts"
LARGE="src/scratch-stopcause-large.ts"

GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'

SUMMARY=""
note() { if [ -n "$SUMMARY" ]; then printf '%s\n' "$*" >> "$SUMMARY"; fi; printf '%s%s%s\n' "$DIM" "$*" "$OFF"; }
pass() { if [ -n "$SUMMARY" ]; then printf 'PASS  %s\n' "$*" >> "$SUMMARY"; fi; printf '%sPASS%s  %s\n' "$GREEN" "$OFF" "$*"; }
fail() { if [ -n "$SUMMARY" ]; then printf 'FAIL  %s\n' "$*" >> "$SUMMARY"; fi; printf '%sFAIL%s  %s\n' "$RED" "$OFF" "$*"; }
skip() { if [ -n "$SUMMARY" ]; then printf 'SKIP  %s\n' "$*" >> "$SUMMARY"; fi; printf '%sSKIP%s  %s\n' "$YELLOW" "$OFF" "$*"; }

# ---------------------------------------------------------------------- setup

do_setup() {
  RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  OUT="$RESULTS_HOME/verify-stop-cause-$RUN_ID"
  mkdir -p "$OUT" || { echo "cannot create $OUT" >&2; exit 1; }
  SUMMARY="$OUT/summary.txt"
  : > "$SUMMARY"

  printf '\n%sverify-stop-cause — setup%s\n' "$BOLD" "$OFF"
  printf '%s\n\n' "results: $OUT"
  note "repo: $REPO_ROOT"
  note "date_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # A dirty tree is not fatal, but a pull on top of uncommitted work is how the
  # Mac's own selectModelsBestFit would get lost. Say so before pulling.
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
    skip "working tree is dirty — commit before pulling, or the pull may conflict"
    git -C "$REPO_ROOT" status --short > "$OUT/git-status.txt" 2>&1
    note "     (listed in $OUT/git-status.txt; setup continues without pulling)"
  else
    # --ff-only, not --rebase: a rebase that stops on a conflict leaves the
    # repository mid-rebase, and a script that walks away from that has made a
    # mess it did not warn about. A fast-forward either happens or changes
    # nothing at all.
    if git -C "$REPO_ROOT" pull --ff-only > "$OUT/git-pull.txt" 2>&1; then
      pass "pulled: $(git -C "$REPO_ROOT" log -1 --format='%h %s' 2>/dev/null)"
    else
      fail "git pull --ff-only failed (diverged history?) — see $OUT/git-pull.txt; nothing was changed"
    fi
  fi

  # Refuse to write over anything already sitting at the fixture paths. They are
  # obscure names, so this should never fire — but "should never" is not a
  # reason to overwrite a file whose contents were never looked at.
  for rel in "$SMALL" "$LARGE"; do
    if [ -e "$REPO_ROOT/$rel" ]; then
      fail "$rel already exists — refusing to overwrite it"
      note "     if it is a leftover from an earlier run: bash scripts/verify-stop-cause.sh restore"
      note "     if it is yours: move it, and nothing here will touch it"
      exit 1
    fi
  done

  # The MCP server runs dist/server.js, so an unbuilt fix is an untested one.
  #
  # Everything from here down is a HARD STOP, not a report. A run whose server
  # does not carry the fix produces rows that look exactly like real ones and
  # mean nothing, and the earlier version of this script said so and then
  # printed the prompts anyway — inviting a whole Mac session of invalid
  # evidence. If the instrument is not in place, there is nothing to measure.
  if (cd "$REPO_ROOT" && npm run build > "$OUT/build.txt" 2>&1); then
    pass "npm run build"
  else
    fail "npm run build failed — see $OUT/build.txt; the server would load the OLD code"
    note ""
    note "STOPPING. Nothing was written to src/, and no prompts follow: rows produced"
    note "by the old server are indistinguishable from real ones and would poison the log."
    exit 1
  fi

  # Verify the built artifact actually carries the fix rather than assuming the
  # build picked it up. This is the whole reason the run is worth doing.
  if [ ! -f "$REPO_ROOT/dist/tools/repair.js" ]; then
    fail "dist/tools/repair.js missing — the build did not produce a server to run"
    note ""
    note "STOPPING. Nothing was written to src/, and no prompts follow."
    exit 1
  fi
  if grep -q "remainingAtIssue" "$REPO_ROOT/dist/tools/repair.js" 2>/dev/null; then
    pass "dist carries the stop-cause fix (remainingAtIssue present)"
  else
    fail "dist/tools/repair.js does NOT contain the fix"
    note ""
    note "STOPPING. Nothing was written to src/, and no prompts follow: this build"
    note "predates the fix, so every row it wrote would be evidence about the old code."
    note "Check that the pull actually landed: git -C \"$REPO_ROOT\" log -1"
    exit 1
  fi

  # Where the telemetry ends right now, in BYTES. `check` reads only past this
  # offset, so the repair rows already in the log cannot be scored as this
  # run's. Bytes and not lines: a line count has to agree with however the
  # reader decides to split, and a single blank line in the log is enough to
  # shift the cut by one row — which is a wrong answer that still looks like a
  # measurement.
  BASELINE=0
  if [ -f "$TELEMETRY" ]; then
    BASELINE="$(wc -c < "$TELEMETRY" 2>/dev/null | tr -d ' ')"
    [ -n "$BASELINE" ] || BASELINE=0
  fi
  note "telemetry baseline: $BASELINE bytes"

  # Context only. This is what THIS shell sees, and the MCP server inherits the
  # environment Claude Code was launched with, which need not be the same. It is
  # recorded because it is worth knowing, and it is NOT what `check` scores
  # against — see the analyzer, which learns the ceiling from the run itself.
  TIMEOUT_MS="${LOCAL_CODER_TIMEOUT_MS:-300000}"
  note "LOCAL_CODER_TIMEOUT_MS in this shell (context, not the server's): $TIMEOUT_MS"

  # Quoted: an unquoted path with a space becomes a command when `check` sources
  # this file.
  {
    echo "run_id='$RUN_ID'"
    echo "repo_root='$REPO_ROOT'"
    echo "baseline='$BASELINE'"
    echo "timeout_ms='$TIMEOUT_MS'"
  } > "$OUT/state.env"
  printf '%s\n' "$OUT" > "$POINTER"

  write_fixtures "$OUT"
  write_analyzer "$OUT"

  # A red gate is the precondition for every one of the three calls. Confirm it
  # rather than trust it — a fixture that compiles would make all three vacuous.
  if (cd "$REPO_ROOT" && npx tsc --noEmit > "$OUT/tsc-precheck.txt" 2>&1); then
    fail "tsc reports NO errors — the fixtures did not break the gate"
    note ""
    note "STOPPING. With a green gate `repair` returns on the spot with 0 rounds and"
    note "no timings, which is the one row this run cannot use. Clean up first:"
    note "  bash scripts/verify-stop-cause.sh restore"
    exit 1
  fi
  if grep -q "scratch-stopcause" "$OUT/tsc-precheck.txt" 2>/dev/null; then
    pass "tsc is red on the fixtures, so the gate has something to close"
  else
    skip "tsc is red but NOT on the fixtures — something else in the repo is broken"
    note "     see $OUT/tsc-precheck.txt. The prompts still follow, but a pre-existing"
    note "     failure means repair is being asked to fix more than the fixtures."
  fi

  print_prompts "$TIMEOUT_MS"
}

write_fixtures() {
  out="$1"
  # Small: one error, a handful of lines. Deliberately well under the 8192-token
  # output cap, because B0 says a file this repo's own size truncates — and a
  # truncated round produces no timings, which is the one thing this must yield.
  cat > "$REPO_ROOT/$SMALL" <<'TSEOF'
// Fixture for verify-stop-cause.sh. Deleted by the `restore` subcommand.
// Small on purpose: B0 (PREMISES.md) says a file of this repo's ordinary size
// truncates against the output cap, and a truncated round yields no timings.
export function twice(n: number): number {
  return n * "2";
}
TSEOF

  # Large: slow to regenerate, so a short budget is guaranteed to cut the
  # request off mid-generation rather than let it finish and fail on its merits.
  node - "$REPO_ROOT/$LARGE" <<'JSEOF'
const fs = require("node:fs");
const target = process.argv[2];
const lines = [
  "// Fixture for verify-stop-cause.sh. Deleted by the `restore` subcommand.",
  "// Large on purpose: regenerating it takes long enough that a short budget",
  "// cuts the request off instead of letting it finish.",
];
for (let i = 1; i <= 400; i++) {
  lines.push(`export function step${i}(n: number): number {`);
  lines.push(`  return n + ${i};`);
  lines.push("}");
}
lines.push("export function brokenOnPurpose(n: number): number {");
lines.push('  return n * "2";');
lines.push("}");
fs.writeFileSync(target, lines.join("\n") + "\n");
JSEOF

  if [ -f "$REPO_ROOT/$SMALL" ] && [ -f "$REPO_ROOT/$LARGE" ]; then
    pass "fixtures written: $SMALL ($(grep -c '' "$REPO_ROOT/$SMALL") lines), $LARGE ($(grep -c '' "$REPO_ROOT/$LARGE") lines)"
    printf '%s\n%s\n' "$SMALL" "$LARGE" > "$out/fixtures.txt"
  else
    fail "could not write the fixtures"
    note ""
    note "STOPPING. Without them the three prompts have nothing to repair."
    note "Remove any partial file by hand: the restore step only deletes files"
    note "carrying this script's marker, and a half-written one may not have it."
    exit 1
  fi
}

print_prompts() {
  timeout_ms="$1"
  printf '\n%s--- restart Claude Code now ---%s\n' "$BOLD" "$OFF"
  printf '%s\n\n' "The MCP server loads dist/ at startup; without a restart it runs the old code."

  printf '%sPaste prompt 1 — the per-round trace, which is what B7 needs%s\n' "$BOLD" "$OFF"
  cat <<EOF

  Call the repair tool with files: ["$SMALL"], checks: "types",
  max_rounds: 3, and spec: "twice must return n multiplied by 2, with no type
  errors". Do not edit any file yourself and do not fix it after repair returns.

EOF

  printf '%sPaste prompt 2 — expected stopped_because: budget%s\n' "$BOLD" "$OFF"
  cat <<EOF

  Call the repair tool with files: ["$LARGE"], checks: "types",
  budget_seconds: 30, and spec: "brokenOnPurpose must return n multiplied by 2,
  with no type errors". Do not edit any file yourself.

EOF

  printf '%sPaste prompt 3 — expected stopped_because: model_failed%s\n' "$BOLD" "$OFF"
  cat <<EOF

  Call the repair tool again with files: ["$LARGE"], checks: "types",
  budget_seconds: 900, and the same spec. Do not edit any file yourself.

EOF

  if [ "$timeout_ms" = "300000" ]; then
    printf '%sNote on prompt 3.%s ' "$YELLOW" "$OFF"
    cat <<'EOF'
At the default 300 s per-request ceiling, prompt 3 may
  never reach a timeout: the output cap bounds one request to roughly 8192
  tokens, so generation can end in truncation first. Both paths report
  model_failed, and `check` reads the error text to say WHICH happened rather
  than claiming coverage it did not get. To make the timeout path reachable and
  fast, relaunch Claude Code from a shell with:

      export LOCAL_CODER_TIMEOUT_MS=20000

  then re-run setup so the comparison uses the same value.
EOF
    printf '\n'
  fi

  printf 'When the three calls are done:\n\n'
  printf '    bash scripts/verify-stop-cause.sh check\n\n'
}

# ---------------------------------------------------------------------- check

do_check() {
  if [ ! -f "$POINTER" ]; then
    echo "no setup found — run: bash scripts/verify-stop-cause.sh setup" >&2
    exit 1
  fi
  OUT="$(cat "$POINTER")"
  if [ ! -f "$OUT/state.env" ]; then
    echo "setup state missing at $OUT/state.env — run setup again" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  . "$OUT/state.env"
  SUMMARY="$OUT/check.txt"
  : > "$SUMMARY"

  printf '\n%sverify-stop-cause — check%s\n' "$BOLD" "$OFF"
  printf '%s\n\n' "run: $run_id"

  # Rewritten HERE, not reused from setup. Setup may have run against an older
  # copy of this script, and an analyzer from then can answer with a contract
  # this one no longer speaks — observed: a stale analyzer returned 0 for a run
  # that established nothing, and the caller printed "Verified". The scorer and
  # the code reading its status now always come from the same file.
  write_analyzer "$OUT"

  # The telemetry setup measured, not whichever clone this copy of the script
  # happens to sit in. A byte offset only means something against the same file.
  CHECK_TELEMETRY="$repo_root/.local-coder/telemetry.jsonl"
  if [ "$repo_root" != "$REPO_ROOT" ]; then
    skip "this script is in $REPO_ROOT but setup measured $repo_root"
    note "     scoring $repo_root, which is where the baseline was taken"
  fi

  if [ ! -f "$CHECK_TELEMETRY" ]; then
    fail "no telemetry at $CHECK_TELEMETRY — did any repair call actually run?"
    exit 1
  fi

  # Not piped into tee: a pipeline reports the exit status of its LAST command,
  # so tee would swallow the analyzer's verdict and `check` would always look
  # successful. Write, keep the status, then show it.
  node "$OUT/analyze.mjs" "$CHECK_TELEMETRY" "$baseline" "$timeout_ms" "$OUT/rows.jsonl" >> "$SUMMARY" 2>&1
  status=$?
  cat "$SUMMARY"

  printf '\nSend back: %s and %s\n' "$OUT/check.txt" "$OUT/rows.jsonl"
  # Three statuses, because "nothing failed" is not "the run verified anything".
  # An all-SKIP run used to come back 0 and read as success while having
  # established none of the three things it exists to establish.
  case "$status" in
    0) printf '%sVerified.%s All three objectives established.\n\n' "$GREEN" "$OFF" ;;
    2) printf '%sIncomplete.%s Nothing contradicted the fix, but the run did not verify it.\n' "$YELLOW" "$OFF"
       printf 'Re-run the prompts named above. Do not record this as a verification.\n\n' ;;
    *) printf '%sFailed.%s A row contradicts the fix — read the verdict above.\n\n' "$RED" "$OFF" ;;
  esac
  return "$status"
}

write_analyzer() {
  cat > "$1/analyze.mjs" <<'MJSEOF'
// Scores the repair rows this run produced. Written by setup so `check` never
// depends on a file the repo might not have at the version being tested.
import { readFileSync, writeFileSync } from "node:fs";

const [file, baselineRaw, shellTimeoutRaw, rowsOut] = process.argv.slice(2);
const baselineBytes = Number(baselineRaw);
/** What the SETUP SHELL saw. Context for the reader; never a scoring input. */
const shellTimeoutMs = Number(shellTimeoutRaw);

// Sliced as BYTES on the raw buffer, matching what `wc -c` recorded. Reading to
// a string first and slicing that would count UTF-16 units, so one non-ASCII
// character anywhere earlier in the log would shift the cut. A fragment at the
// seam simply fails to parse below and is skipped.
const fresh = readFileSync(file).subarray(baselineBytes).toString("utf8");
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

const out = [];
const say = (s) => out.push(s);

// The three things this run exists to establish. Each ends as PASS, FAIL, or
// stays null for "never established". Tracking them by name is what stops an
// all-SKIP run from exiting 0: nothing failed, but nothing was verified either,
// and those are different answers. Reporting the second as success is how a
// verifier comes back green having checked nothing.
const objectives = { trace: null, budget: null, model_failed: null };

say(`new repair rows since setup: ${repairs.length}`);
if (repairs.length === 0) {
  say("FAIL  nothing to score — no repair call reached the telemetry");
  console.log(out.join("\n"));
  process.exit(1);
}

/** The ceiling the request actually got, as llm-client reports it verbatim. */
const appliedMs = (text) => {
  const m = /timed out after (\d+) ms/i.exec(text ?? "");
  return m ? Number(m[1]) : null;
};

for (const [i, r] of repairs.entries()) {
  const d = r.detail ?? {};
  say("");
  say(`[${i + 1}] stopped_because=${d.stopped_because} passed=${d.passed} rounds=${r.turns_collapsed} latency_ms=${r.latency_ms}`);
  for (const q of d.rounds ?? []) {
    const err = q.error ? ` error="${q.error.slice(0, 120)}"` : "";
    say(`      round ${q.round}: model_ms=${q.model_ms} gate_ms=${q.gate_ms} failures ${q.failures_before}->${q.failures_after}${err}`);
  }
  if (d.rounds === undefined) say("      (no per-round trace — this row came from a build without the fix)");
}

say("");
say("--- scoring ---");

// 1. B7's instrument: a round that ran, with both timings present.
const traced = repairs.find(
  (r) => Array.isArray(r.detail?.rounds) &&
    r.detail.rounds.some((q) => typeof q.model_ms === "number" && typeof q.gate_ms === "number" && q.gate_ms > 0)
);
// `rounds` ABSENT and `rounds` EMPTY are different findings and used to share a
// verdict. Absent means the server predates the fix; empty means the fix is in
// and no round ran. Blaming the build for the second sends the reader off to
// rebuild something that was never wrong.
const hasField = repairs.some((r) => Array.isArray(r.detail?.rounds));
if (traced) {
  const q = traced.detail.rounds.find((x) => typeof x.gate_ms === "number" && x.gate_ms > 0);
  objectives.trace = "PASS";
  say(`PASS  per-round trace reaches telemetry — model_ms=${q.model_ms} gate_ms=${q.gate_ms}`);
  say(`      B7 has its first real per-round figure: ${((q.model_ms + q.gate_ms) / 1000).toFixed(1)} s`);
} else if (repairs.some((r) => Array.isArray(r.detail?.rounds) && r.detail.rounds.length > 0)) {
  say("SKIP  rounds are traced but none re-ran the gate (every round errored), so no gate_ms to report");
} else if (hasField) {
  say("SKIP  the trace field is present, so the fix IS deployed, but every row ran 0 rounds");
  say("      — the gate was already green. Nothing to rebuild; prompt 1 needs a red gate.");
} else {
  objectives.trace = "FAIL";
  say("FAIL  no trace field in any row — the server that wrote them predates the fix");
  say("      (rebuild and restart Claude Code; these rows cannot answer B7)");
}

// 2 and 3. The two stop causes, scored against a ceiling LEARNED FROM THE RUN.
//
// The obvious comparison — applied vs LOCAL_CODER_TIMEOUT_MS as the setup shell
// saw it — is not sound. The MCP server inherits the environment Claude Code
// was launched with, and the shell that ran setup is a different process that
// need not agree. Scoring against it would produce confident PASS/FAIL verdicts
// resting on a number that may have had nothing to do with the run.
//
// The run can supply it instead. `applied = min(config.timeoutMs, remaining)`,
// so applied never exceeds the ceiling and EQUALS it whenever the budget was
// generous. Prompt 3 is built to be that call, so the largest applied value
// observed is the ceiling. Every row is then scored by comparison against it:
// below the ceiling means the budget was the binding constraint and the row
// must say `budget`; at the ceiling means the request broke its own limit and
// the row must say `model_failed`.
const errText = (r) => (r.detail?.rounds ?? []).map((q) => q.error).filter(Boolean).join(" ");
const timed = [];
for (const r of repairs) {
  const applied = appliedMs(errText(r));
  if (applied !== null) timed.push({ stop: r.detail?.stopped_because, applied });
}

const truncated = repairs.filter((r) => /truncat/i.test(errText(r)));
if (truncated.length > 0) {
  say(`SKIP  ${truncated.length} row(s) failed by TRUNCATION rather than a timeout — that is B0,`);
  say("      and those rows exercise the output contract, not the stop-cause branch");
}

const applied = timed.map((t) => t.applied);
const distinct = [...new Set(applied)];
if (timed.length === 0) {
  say("SKIP  no timed-out row at all — neither stop cause can be checked");
  say("      (prompt 2 and prompt 3 either did not run or never reached a timeout)");
} else if (distinct.length < 2) {
  say(`SKIP  every timed-out row applied the same ${distinct[0]} ms, so the ceiling cannot be`);
  say("      told apart from the budget. Re-run prompts 2 and 3: they must differ in");
  say("      budget_seconds, and only one of them may exceed the per-request ceiling.");
  say(`      (for reference, the setup shell saw LOCAL_CODER_TIMEOUT_MS=${shellTimeoutMs},`);
  say("       which is NOT evidence about the server and was not used to score anything)");
} else {
  const ceiling = Math.max(...applied);
  say(`per-request ceiling learned from the run: ${ceiling} ms (largest applied timeout observed)`);
  if (ceiling !== shellTimeoutMs) {
    say(`      note: the setup shell saw ${shellTimeoutMs} ms. The server's is what matters and`);
    say("      it is the learned value; a mismatch just means the two processes differ.");
  }
  for (const t of timed) {
    const expected = t.applied < ceiling ? "budget" : "model_failed";
    const key = expected === "budget" ? "budget" : "model_failed";
    if (t.stop === expected) {
      // A later PASS must not overwrite an earlier FAIL for the same objective.
      if (objectives[key] !== "FAIL") objectives[key] = "PASS";
      say(`PASS  applied ${t.applied} ms -> ${t.stop}${t.applied < ceiling ? " (the budget bound)" : " (its own ceiling bound)"}`);
    } else {
      objectives[key] = "FAIL";
      say(`FAIL  applied ${t.applied} ms should be ${expected}, row says ${t.stop}`);
    }
  }
}

// ------------------------------------------------------------------- verdict
//
// Three outcomes, not two. "Nothing failed" and "the run established what it
// set out to" are different claims, and only the second is success.
const names = { trace: "per-round trace (B7)", budget: "budget stop cause", model_failed: "model_failed stop cause" };
const failed = Object.keys(objectives).filter((k) => objectives[k] === "FAIL");
const missing = Object.keys(objectives).filter((k) => objectives[k] === null);
const done = Object.keys(objectives).filter((k) => objectives[k] === "PASS");

say("");
say("--- verdict ---");
for (const k of Object.keys(objectives)) {
  say(`  ${(objectives[k] ?? "NOT ESTABLISHED").padEnd(15)} ${names[k]}`);
}
/** Print everything collected, then exit. Nothing exits without printing. */
const finish = (code) => {
  console.log(out.join("\n"));
  process.exit(code);
};

say("");
if (failed.length > 0) {
  say(`VERDICT: FAILED — ${failed.map((k) => names[k]).join(", ")} contradicts the fix.`);
  finish(1);
}
if (missing.length > 0) {
  say(`VERDICT: INCOMPLETE — ${done.length} of 3 established; still missing: ${missing.map((k) => names[k]).join(", ")}.`);
  say("Nothing contradicted the fix, and nothing confirmed the missing part either.");
  say("Re-run the prompts that were skipped; do NOT record this as a verification.");
  finish(2);
}
say("VERDICT: verified — all 3 established. The label flipped with the ceiling and");
say("nothing else, and B7 has a real per-round figure for the first time.");
finish(0);
MJSEOF
}

# -------------------------------------------------------------------- restore

do_restore() {
  printf '\n%sverify-stop-cause — restore%s\n\n' "$BOLD" "$OFF"
  removed=0
  refused=0
  for rel in "$SMALL" "$LARGE"; do
    if [ ! -e "$REPO_ROOT/$rel" ]; then
      skip "$rel was not there"
      continue
    fi
    # Only delete what this script wrote. Both fixtures open with a marker line
    # naming this script; anything else at that path belongs to someone else,
    # and a cleanup step that deletes on the strength of a filename alone is how
    # a verification run destroys work it was never asked to touch.
    if head -n 1 "$REPO_ROOT/$rel" 2>/dev/null | grep -q "verify-stop-cause.sh"; then
      rm -f "$REPO_ROOT/$rel" && removed=$((removed + 1))
      pass "removed $rel"
    else
      refused=$((refused + 1))
      fail "$rel exists but is NOT one of this script's fixtures — left untouched"
      note "     first line: $(head -n 1 "$REPO_ROOT/$rel" 2>/dev/null)"
      note "     delete it yourself if you want it gone; a cleanup step does not get"
      note "     to decide that about a file it did not write"
    fi
  done
  # The fixtures were new files, never edits, so nothing of yours needed
  # reverting — that is why `restore` is an rm and not a git checkout.
  if [ "$removed" -gt 0 ]; then
    note "rebuild before your next real session: npm run build"
  fi
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
    note ""
    note "still dirty (this is your own work, untouched by this script):"
    git -C "$REPO_ROOT" status --short
  fi
  printf '\n'
  # Non-zero when something was left behind, so "restore" cannot look complete
  # while a fixture path still holds a file nobody has accounted for.
  [ "$refused" -eq 0 ]
}

case "${1:-}" in
  setup)   do_setup ;;
  check)   do_check ;;
  restore) do_restore ;;
  *)
    cat <<EOF
usage: bash scripts/verify-stop-cause.sh {setup|check|restore}

  setup     pull, build, verify dist carries the fix, write the fixtures,
            record the telemetry baseline, print the three prompts
  check     score the repair rows written since setup
  restore   delete the fixtures

The three repair calls are yours to drive: repair is an MCP tool, so only
Claude can call it. Everything either side of that is here.
EOF
    exit 1
    ;;
esac
