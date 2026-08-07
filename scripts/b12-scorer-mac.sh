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
# own vitest run exits 0. The tool's word is not the measurement -- and neither
# is vitest's on its own, which is what this script used to read. Both conjuncts
# now come from their own instrument, and a unit that produced no observation at
# all (`no_response`, `no_repair_call`, `could_not_run`) counts toward NEITHER
# side and makes the run's reading `incomplete`.
#
# WHAT IT CHANGES IN YOUR CLONE, stated plainly rather than implied:
#   - writes implementation bodies into src/cost/b12/{strata,terms,aggregate}.ts
#     in that dependency order, skipping any unit whose tests are already green
#     (the local model does this through `repair`, not this script)
#   - runs `npm ci` and `npm run build`, so node_modules/ and dist/ are rebuilt.
#     NOTE: `npm ci` triggers `prepare`, which runs the build -- so the install
#     COMPILES src/cost/b12/*.ts before any unit is attempted, and a leftover
#     body that does not typecheck takes the whole step down.
#   - appends to .local-coder/telemetry.jsonl and .local-coder/corpus/ (both
#     gitignored) as a side effect of calling the tools
#   - writes ONE new file under evidence/ and ONE .tgz under ~/lc-results/
#   - makes ONE local git commit if anything went green. It never pushes.
# It creates and removes a temp dir under $TMPDIR and nothing else.
#
# bash 3.2 compatible: no associative arrays, no mapfile, no ${x,,}.
#
# Usage:  bash scripts/b12-scorer-mac.sh [/path/to/repo]
#
# Environment:
#   B12_ONLY=<unit>          attempt ONE unit (strata|terms|aggregate) and record
#                            the others as carried, not scored. Requires
#                            B12_CARRIED_FROM.
#   B12_CARRIED_FROM=<runId> the run that measured the units this one skips.
#   B12_RESUME=1             this is the same exposure resuming after a crash, so
#                            a body already on disk is expected and an
#                            already-green unit is skipped as
#                            inherited-unverified.
#
# The decision logic in step 7 and the telemetry-window reader are exercised by
# scripts/b12-scorer-selftest.sh, which extracts them VERBATIM from this file
# and drives them against fabricated windows. Run it after editing either.

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

# A LEFTOVER BODY CAN BRICK THE INSTALL, not merely fail a test, and it took
# three round trips to find that out. Appended to step 4's refusals when the log
# names a file under src/cost/b12/. Not auto-reset: it is the operator's
# evidence and discarding it is not this script's call to make silently.
leftover_hint() {
  grep -q 'src/cost/b12/' "$1" 2>/dev/null || return 0
  cat <<'HINT'

THE BUILD IS COMPILING A LEFTOVER BODY, which is why this is an install failure
and not a test failure. `npm ci` runs `prepare`, `prepare` runs `npm run build`,
so src/cost/b12/*.ts is compiled BEFORE any unit is attempted -- a partial body
from a run that died mid-unit takes down step 4 for EVERY unit, including the
ones that would have worked. The resumption rule lets earlier bodies through on
purpose; it did not consider one that does not compile.

A file with type errors was never a closed unit: repair closes on the gate and
the gate runs tsc. So resetting it discards nothing this run could have counted.
Keep the diff first anyway -- what the local model wrote is information this
project has already lost once:

  mkdir -p ~/lc-results
  git diff src/cost/b12/ > ~/lc-results/leftover-bodies.diff
HINT
  # A BARE `git checkout --` IS A NO-OP HERE and this text used to print one.
  # The last step of this script COMMITS whatever the local model wrote, so on
  # any machine that has run it once the "clean" state git restores IS the body.
  # The stub exists only at the pinned commit. Printed rather than folded into
  # the quoted heredoc above, which must stay quoted: the text is full of
  # backticks and would otherwise be run as commands.
  printf '  git checkout %s -- src/cost/b12/<the file tsc named above>\n\n' "$STUBS_FROZEN_AT"
}

# The frozen inputs. A run that cannot prove it started from these proves nothing.
RATES_FROZEN_AT="3541625"
# THE STUBS THIS EXPOSURE STARTS FROM, pinned to a commit instead of inferred
# from the working tree -- because the tree cannot answer the question. The last
# step of this script COMMITS the bodies the local model wrote, so on the next
# run `git status` is clean while all three answers are already on disk, the
# fresh-exposure guard sees nothing to object to, and the already-green skip
# reports ">= 2 of 3" having called `repair` zero times. That is the whole
# measurement produced by a run that measured nothing.
#
# The check below re-verifies that these really are stubs rather than trusting
# this comment: a pin at the wrong commit makes every comparison meaningless in
# the direction that passes.
#
# MOVED OFF d0253e1 BY THE SCORER-CORRECTNESS PASS (F1/F2a/F2b/F3). Those units'
# stubs changed -- headers, doc comments, and the specs they point at -- so a run
# still pinned at d0253e1 would refuse every unit as "already carrying a body"
# when nothing had been written. The pin has to move with the stub or the guard
# fires on its own repairs.
#
# CONSEQUENCE, STATED RATHER THAN DISCOVERED: `strata` is NOT a stub here, so
# this pin cannot start a run that attempts it -- the "not implemented" check
# below refuses, by name. That is the rule PREMISES already carries ("Do not
# re-run a unit that already has an observation ... that is a second draw at the
# same bar") now enforced by the harness. An exposure that genuinely wants all
# three reset has to move this pin deliberately, which is a visible act.
STUBS_FROZEN_AT="3d27f08"
# EXPOSURE B. `src/cost/report.ts` joins context_files, and the floor doubles
# BECAUSE of it: that file is 51,747 B ~ 14,800 tokens, which puts aggregate's
# corrective retry near 29,000 against 32,768's ~29,491 usable budget -- inside
# the margin where context_would_overflow is reported as `model_failed` and the
# Phase-3 count cannot tell the two apart. Both changes are pre-registered
# together in PREMISES.md § B12 - PHASE-3 EXPOSURE B, with the admission that a
# result under two moved conditions cannot attribute.
EXPOSURE="${B12_EXPOSURE:-B}"
MIN_CONTEXT=65536
CONTEXT_FILES='"src/cost/b12/types.ts", "src/cost/rates.ts", "src/cost/report.ts"'
# THE TWO LIMITS THAT DECIDE HOW MANY ATTEMPTS THE MODEL ACTUALLY GETS, and they
# have to be set as a PAIR. `repair`'s budget defaults to 300 s and this script
# never passed one, while the prompt asks for `max_rounds: 3` -- so
# `run 2026-08-07-mac-b12-phase3-c40e9f4` delivered TWO productive rounds on
# `aggregate` and stopped on `budget` in both calls. The registered condition was
# not the condition that ran.
#
# Raising the budget alone would trade a truncation for a starvation. The
# per-request timeout is `min(config.timeoutMs, remaining)` (`src/tools/shared.ts`),
# and `src/tools/repair.ts` records the hazard by name: when the two are equal,
# round 1's request is issued with the WHOLE budget as its timeout. At 600/600
# one slow round eats the two after it.
#
# So: a per-request ceiling that clears real work and cuts a dead backend off
# early, and a budget that fits three of those. Longest LEGITIMATE round observed
# across three exposures is 132 s (exposure A; `aggregate` typically 106-132 s).
# The 149 s and 256 s rounds were not generations -- one was a request handed the
# remaining budget as its timeout, the other was the backend returning HTTP 400.
# 180 s therefore clears the real maximum by 36% while no single request can take
# more than 30% of the budget.
#
# A single ROUND can still consume most of the budget: generation permits a
# corrective retry, and the gate after it receives whatever is left. Recorded,
# not fixed -- gates run in ~2 s here, and the property worth keeping is that no
# REQUEST can starve its successors.
#
# BOTH ARE VERIFIED FROM TELEMETRY AFTERWARDS, not merely asked for. They reach
# `repair` through a PROMPT -- the session is asked to pass them -- and both are
# optional arguments with defaults, so a session that drops one is silently
# measured at 300 s and 3 rounds with nothing recording that it happened. That is
# the same shape as exposure B's context-files VOID, which was registered and
# could not be checked because the field did not exist. It exists now.
TIMEOUT_MS=180000
BUDGET_SECONDS=600
MAX_ROUNDS=3
# A fresh exposure may not inherit a body closed under the OLD condition: that
# would let one closure out of two attempts reach the ">= 2 of 3" bar and
# silently loosen a threshold this project refuses to move. Resuming a run the
# machine killed MID-exposure is the opposite case and is what B12_RESUME=1 is
# for -- same condition, so an already-green unit is legitimately skipped.
RESUME="${B12_RESUME:-0}"
# ONE UNIT, NAMED. Exposure B gave `strata` and `terms` a fair draw and gave
# `aggregate` none at all -- both of its `repair` calls died in the LM Studio
# backend with zero tokens generated. Re-running all three to finish it would
# hand those two a SECOND draw at the same bar, which inflates the chance of
# reaching ">= 2 of 3" without anything about `repair` having changed. This
# attempts only the unit that has no observation; the others are recorded as
# carried from the run that measured them, and are not scored again here.
ONLY="${B12_ONLY:-}"
CARRIED_FROM="${B12_CARRIED_FROM:-}"
case "$ONLY" in
  "")                     UNITS_TO_ATTEMPT="strata terms aggregate" ;;
  strata|terms|aggregate) UNITS_TO_ATTEMPT="$ONLY" ;;
  *) refuse "B12_ONLY=\"$ONLY\" does not name a unit. Expected one of: strata, terms, aggregate." ;;
esac
# A partial run that cannot say where the rest was measured is a partial run
# presenting itself as a whole one. The id goes INTO the artifact, so a later
# reader assembling the exposure has both halves by name rather than by memory.
if [ -n "$ONLY" ] && [ -z "$CARRIED_FROM" ]; then
  refuse "B12_ONLY=$ONLY needs B12_CARRIED_FROM=<the run id that measured the other units>.

This run will attempt ONE unit. Its artifact must name the run holding the
others, or the >= 2 of 3 reading has no second source and the artifact reads as
though one unit were the whole exposure. Example:

  B12_ONLY=$ONLY B12_CARRIED_FROM=2026-08-06-mac-b12-phase3-f2932ff \\
    bash scripts/b12-scorer-mac.sh"
fi
# It goes into a JSON string in the artifact by direct interpolation, so a quote
# or a backslash in it would produce a file that parses as something else --
# and the artifact is verified by reading it back, not by hoping.
case "$CARRIED_FROM" in
  *[\"\\]*) refuse "B12_CARRIED_FROM contains a quote or a backslash. It is written into the artifact as a JSON string, and this one would not survive the round trip." ;;
esac
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

# ORPHANED ORACLES, FROM A RUN THE MACHINE DID NOT LET FINISH.
# `stage_only` holds the other units' oracles outside tests/ for the duration of
# a unit and `cleanup` puts them back -- but a KERNEL PANIC RUNS NO TRAP. Two
# IOGPUFamily panics on 2026-08-06 killed the box mid-unit, and what they left
# behind is exactly two deleted tracked files. The next run then refuses on them:
# correct by the letter, but it is refusing a condition THIS SCRIPT CREATED and
# can prove is benign, and the cost is a human round trip before every retry.
#
# Narrow on purpose, because "restore what looks stale" is how evidence dies.
# Only DELETIONS, only of the three known oracle paths, and the repair is
# `git checkout --` of a committed file -- which cannot lose content, because a
# deleted file has none. A MODIFIED oracle is not touched and still refuses:
# that one has content, and content is exactly what must not be silently thrown
# away. Everything else outside src/cost/b12/ refuses as before.
ORPHANED=""
for u in strata terms aggregate; do
  if printf '%s\n' "$RAW" | grep -qE "^(D |.D) tests/b12-$u\.test\.ts$"; then
    ORPHANED="$ORPHANED tests/b12-$u.test.ts"
  fi
done
if [ -n "$ORPHANED" ]; then
  warn "oracle(s) left staged aside by a run that died mid-unit:$ORPHANED"
  for f in $ORPHANED; do
    git -C "$REPO" checkout -- "$f" ||
      refuse "could not restore $f. Restore by hand with:  git checkout -- tests/"
  done
  RAW=$(git status --porcelain 2>/dev/null)
  GIT_RC=$?
  [ $GIT_RC -eq 0 ] || refuse "git status exited $GIT_RC after restoring the oracles"
  ok "restored from HEAD:$ORPHANED"
fi
# TRACKED CHANGES REFUSE; UNTRACKED FILES DO NOT — the same split
# `b12-preflight-mac.sh:103-112` makes, and it matters on a real machine. A Mac
# checkout carries untracked artifacts that belong to other premises entirely:
# on `~/local-coder` the three `contract-stability.json` files B16's holding
# status rests on were sitting untracked, and a blanket dirty-tree refusal is one
# short step from a blanket `git clean` that destroys them.
TRACKED=$(printf '%s\n' "$RAW" | grep -v '^?? ' | grep -E '^..' || true)
UNTRACKED_N=$(printf '%s\n' "$RAW" | grep -c '^?? ')
# A unit body that a PREVIOUS attempt closed is not contamination -- it is the
# result. `run 2026-08-06-mac-b12-phase3` (attempt 2) died with the machine
# during unit 3, leaving `strata.ts` closed and applied; refusing on it would
# have cost that work, the money it took, and another shot at whatever killed the
# box. Changes under `src/cost/b12/` are allowed through and re-verified below;
# everything else tracked still refuses.
FOREIGN=$(printf '%s\n' "$TRACKED" | grep -v ' src/cost/b12/' || true)
if [ -n "$FOREIGN" ]; then
  refuse "the working tree has TRACKED changes outside src/cost/b12/. This script commits what the local model writes, so every other tracked change must be dealt with first.
$FOREIGN"
fi
# types.ts SHARES THE DIRECTORY AND IS NOT A UNIT. The allowance above is for
# bodies the local model wrote; the type module is contract, authored on the
# other machine and arriving by `git pull`. A local edit to it changes what every
# unit is measured against, so it refuses like anything else tracked.
CONTRACT=$(printf '%s\n' "$TRACKED" | grep -E ' src/cost/b12/types\.ts$' || true)
if [ -n "$CONTRACT" ]; then
  refuse "src/cost/b12/types.ts is modified locally. It is CONTRACT, not result: every unit is measured against it, and this script will not score a unit against a type module it cannot attribute.
$CONTRACT"
fi

# THE FRESH-EXPOSURE GUARD, ANCHORED ON THE CONTRACT RATHER THAN ON THE TREE.
# What it used to do was read `git status` — which cannot see a body this script
# COMMITTED at the end of an earlier run. A second run on a clean tree therefore
# passed this guard with all three answers already on disk, skipped all three as
# already-green, and printed ">= 2 of 3" with zero `repair` calls made. The
# escape hatch it offered was a no-op for the same reason: `git checkout --`
# restores the committed body, not the stub.
#
# Per FILE, because types.ts lives in the same directory and is real code. Per
# ATTEMPTED unit, because a unit this run does not score cannot bias its count —
# which is exactly what makes B12_ONLY legitimate rather than a loophole.
#
# The markers are load-bearing, as in step 7: scripts/b12-scorer-selftest.sh
# extracts this region VERBATIM and drives it against throwaway repositories
# built to have exactly the property being tested — including the one that made
# this rewrite necessary, a body COMMITTED by an earlier run, which leaves the
# tree clean and the answer already on disk.
# >>> B12-STUB-GUARD
git -C "$REPO" rev-parse --verify "$STUBS_FROZEN_AT^{commit}" >/dev/null 2>&1 ||
  refuse "$STUBS_FROZEN_AT is not a commit in this clone, and it is what the stubs are pinned to. Nothing below can be verified against it. Try \`git fetch\` first."
if [ "$RESUME" = "1" ]; then
  warn "B12_RESUME=1: the stub check is SKIPPED, because resuming means bodies from THIS exposure are expected. An already-green unit is recorded inherited-unverified and counted as neither closed nor red — this run holds no repair evidence for it."
else
  DIRTY=""
  for u in $UNITS_TO_ATTEMPT; do
    FROZEN_BLOB=$(git -C "$REPO" rev-parse "$STUBS_FROZEN_AT:src/cost/b12/$u.ts" 2>/dev/null)
    [ -n "$FROZEN_BLOB" ] ||
      refuse "src/cost/b12/$u.ts does not exist at $STUBS_FROZEN_AT, so this run has no stub to start it from."
    git -C "$REPO" show "$STUBS_FROZEN_AT:src/cost/b12/$u.ts" 2>/dev/null | grep -q 'not implemented' ||
      refuse "src/cost/b12/$u.ts at $STUBS_FROZEN_AT does not contain \"not implemented\", so it is not a stub. STUBS_FROZEN_AT points at the wrong commit, and every comparison here would pass for the wrong reason."
    NOW_BLOB=$(git -C "$REPO" hash-object "$REPO/src/cost/b12/$u.ts" 2>/dev/null)
    [ -n "$NOW_BLOB" ] || refuse "could not hash src/cost/b12/$u.ts"
    [ "$NOW_BLOB" = "$FROZEN_BLOB" ] || DIRTY="$DIRTY $u"
  done
  if [ -n "$DIRTY" ]; then
    RESET_PATHS=""
    for u in $DIRTY; do RESET_PATHS="$RESET_PATHS src/cost/b12/$u.ts"; done
    refuse "unit(s) this run will attempt already carry a body:$DIRTY

They differ from their stub at $STUBS_FROZEN_AT. Committed or not, a pre-filled
answer is not something \`repair\` closed here — and carrying one into a fresh
exposure lets a single closure reach the \">= 2 of 3\" bar, loosening a threshold
PREMISES.md refuses to move. Three units, one condition, denominator three.

Keep what the local model wrote before resetting; this project has lost it once:

  mkdir -p ~/lc-results
  git diff $STUBS_FROZEN_AT -- src/cost/b12/ > ~/lc-results/leftover-bodies.diff
  git checkout $STUBS_FROZEN_AT --$RESET_PATHS

NOT a bare \`git checkout --\`: this script commits the bodies it produces, so
the state git would restore is the body itself.

If instead you are RESUMING a run this machine killed mid-exposure — same
condition throughout, so an already-green unit is legitimately skipped:
  B12_RESUME=1 bash scripts/b12-scorer-mac.sh"
  fi
  ok "every unit this run attempts is byte-identical to its stub at $STUBS_FROZEN_AT"
fi
# <<< B12-STUB-GUARD
if [ "${UNTRACKED_N:-0}" -gt 0 ]; then
  warn "$UNTRACKED_N untracked path(s) present. They are LEFT ALONE and never committed: this run commits src/cost/b12/ and its own artifact, nothing else."
fi
# NOT "no tracked changes", which this line used to claim while allowing bodies
# under src/cost/b12/ straight past it. What was actually established is
# narrower, and saying the narrow thing is the point.
if [ -n "$TRACKED" ]; then
  info "tracked changes present, all under src/cost/b12/ — allowed here, and judged per attempted unit above"
else
  ok "no tracked changes"
fi

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

# Created BEFORE the install rather than after it: the npm and build logs live
# in here, and a refusal that cannot write its log is a refusal with nothing to
# say. The trap already handles TMP_DIR being empty, so moving it earlier is
# strictly safer than the failure it prevents.
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/b12scorer.XXXXXX") || refuse "could not create a temp dir"
TMP_MINE=1

# ---------------------------------------------------------------------------
next "Install, build, and verify the build BY SYMBOL"
# ---------------------------------------------------------------------------
# THE OUTPUT IS KEPT. This shipped as `>/dev/null 2>&1 || refuse "both failed"`,
# which is the defect a3e9a8f already fixed once in the window refusal: it names
# the symptom and withholds the cure. `npm ci` fails for a dozen unrelated
# reasons and none of them are guessable from "both failed". The tail goes INTO
# the refusal string, because the temp dir holding the log is removed by the
# trap on the way out.
NPM_LOG="$TMP_DIR/npm.log"
npm ci --no-audit --no-fund >"$NPM_LOG" 2>&1
if [ $? -ne 0 ]; then
  npm install --no-audit --no-fund >>"$NPM_LOG" 2>&1 ||
    refuse "npm ci AND npm install both failed. Last 25 lines:

$(tail -25 "$NPM_LOG" 2>/dev/null)
$(leftover_hint "$NPM_LOG")
Other causes worth checking, in this order:
  xcode-select -p && xcrun --version   # an OS update can leave the CLT stale
  npm cache verify                     # a panic mid-write corrupts ~/.npm/_cacache"
  warn "npm ci failed and npm install succeeded — node_modules may not match the lockfile, and the artifact cannot tell"
fi
npm run build >"$TMP_DIR/build.log" 2>&1
BUILD_RC=$?
[ $BUILD_RC -eq 0 ] || refuse "npm run build exited $BUILD_RC. Last 25 lines:

$(tail -25 "$TMP_DIR/build.log" 2>/dev/null)
$(leftover_hint "$TMP_DIR/build.log")"
# The MCP server loads dist/ at startup. Trusting the build is how a stale dist
# has already fooled this project; check for the symbol the run depends on.
grep -q "excludedForeignUnits" "$REPO/dist/cost/report.js" ||
  refuse "dist/cost/report.js has no excludedForeignUnits — the build did not land the instrument repair this run scores against"
ok "dist/ carries excludedForeignUnits"

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
  lms unload --all; lms load \"$MODEL_LOCAL\" --context-length $MIN_CONTEXT

If \`lms ps\` shows the model loaded under a DIFFERENT id than \"$MODEL_LOCAL\", that is
the other cause: pass the served id in B12_LOCAL_MODEL rather than renaming
anything." ;;
esac
[ "$WINDOW" -ge "$MIN_CONTEXT" ] || refuse "the loaded context window is $WINDOW, under the $MIN_CONTEXT floor.
Reload with:  lms load \"$MODEL_LOCAL\" --context-length $MIN_CONTEXT
This is a refusal and not a warning. Exposure $EXPOSURE passes src/cost/report.ts
as a context file — 51,747 B, about 14,800 tokens — and at 32768 that puts
aggregate's corrective retry near 29,000 against a ~29,491 usable budget.
\`repair\` reports context_would_overflow as \`model_failed\`, the same label a
genuine model failure gets, and the Phase-3 count cannot tell those apart. Run
2026-08-06-mac-b12-phase3-d746d07 measured a largest prompt of 14,231 tokens
WITHOUT that file; the floor doubled because the file was added, not by taste."
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
      LOCAL_CODER_TIMEOUT_MS: process.argv[4],
      LOCAL_CODER_AUTO_CLAUDE_MD: "0",
    },
  } },
}, null, 2) + "\n");
' "$MCP_CFG" "$REPO" "$WINDOW_START" "$TIMEOUT_MS" || refuse "could not write the MCP config"
# READ BACK, because this one is now load-bearing on the measurement rather than
# on whether the server starts. A timeout that silently stayed at its old value
# would put every round back under the ceiling this run exists to move.
node -e '
const c = require(process.argv[1]);
const got = c.mcpServers["local-coder"].env.LOCAL_CODER_TIMEOUT_MS;
if (got !== process.argv[2]) { console.error("timeout is " + got + ", expected " + process.argv[2]); process.exit(1); }
' "$MCP_CFG" "$TIMEOUT_MS" || refuse "the per-request timeout did not land in the MCP config"
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
# THE MACHINE ITSELF, READ BEFORE ANY UNIT RUNS.
# Two attempts died to kernel panics in `com.apple.iokit.IOGPUFamily` --
# "completeMemory() prepare count underflow" @IOGPUMemory.cpp:550 and "pending
# memory object unexpectedly found in non pending hash" @IOGPUGroupMemory.cpp:528.
# Those are GPU buffer-lifecycle invariants, NOT memory: the kernel's own
# `Compressor Info` read 2% and 1% of limit with swap OK at each one. So the OS
# build and the inference runtime are load-bearing on this premise's evidence,
# and until now the artifact recorded NEITHER. A run that changes the machine in
# order to stop crashing has to be able to say which machine it was.
# ---------------------------------------------------------------------------
OS_PRODUCT=$(sw_vers -productVersion 2>/dev/null); [ -n "$OS_PRODUCT" ] || OS_PRODUCT="unknown"
OS_BUILD=$(sw_vers -buildVersion 2>/dev/null);     [ -n "$OS_BUILD" ]   || OS_BUILD="unknown"
KERNEL=$(uname -r 2>/dev/null);                    [ -n "$KERNEL" ]     || KERNEL="unknown"
"$LMS_BIN" runtime ls >"$OUT/lms-runtime.txt" 2>&1
MLX_RUNTIME=$(grep -i mlx "$OUT/lms-runtime.txt" 2>/dev/null | head -1 | tr -s ' \011' ' ')
[ -n "$MLX_RUNTIME" ] || MLX_RUNTIME="unknown"
# THE KERNEL'S OWN CRASH RECORD, and it is read BEFORE rather than after on
# purpose: a panic kills this script outright, so there is no after-reading to
# take. The NEXT attempt's before-reading is what shows the new file -- which is
# how a crash gets attributed to a run instead of guessed at. `2026-08-06` cost
# two runs and an hour of arguing about a voltage stabiliser for want of this.
PANIC_DIR="/Library/Logs/DiagnosticReports"
PANIC_N=$(ls "$PANIC_DIR"/*.panic 2>/dev/null | wc -l | tr -d ' ')
[ -n "$PANIC_N" ] || PANIC_N="unknown"
PANIC_LAST=$(ls -t "$PANIC_DIR"/*.panic 2>/dev/null | head -1)
PANIC_LAST=$(basename "${PANIC_LAST:-none}")
ok "macOS $OS_PRODUCT ($OS_BUILD), kernel $KERNEL"
ok "runtime $MLX_RUNTIME"
info "kernel panics already on this machine: $PANIC_N (newest $PANIC_LAST)"

# ---------------------------------------------------------------------------
next "Three units, one claude session each"
# ---------------------------------------------------------------------------
SPENT="0"
CLOSED=0
ATTEMPTED=0
INHERITED=0
NOT_HERE=0
VOIDS=""

# ---------------------------------------------------------------------------
# THE PER-UNIT TELEMETRY WINDOW, and the reason this file has one at all.
#
# A unit's state used to come from `npx vitest`'s exit code alone. That code
# answers "are the tests green?" and nothing else, so it reports the SAME `red`
# for a model that generated three attempts and got them wrong and for a model
# that generated nothing at all. Exposure B's `aggregate` was the second kind --
# both `repair` calls died inside the LM Studio backend, zero tokens, HTTP 400 --
# and the artifact printed it as an observation. It was not one, and the whole
# run's "1 of 3" was wrong on the strength of it.
#
# The evidence that separates them is `repair`'s own row in
# .local-coder/telemetry.jsonl, which the tool writes whatever happens. This
# reads the bytes appended between the offset taken just before a unit's
# `claude` call and now: the unit staged every other oracle aside and its prompt
# permits exactly one editable file, so every repair row in that window is this
# unit's.
#
# It also answers, from the same rows, the two things exposure B pre-registered
# as VOID conditions and had no way to check: which local model actually served
# the call, and which context files the prompt actually carried.
# ---------------------------------------------------------------------------
UNIT_WINDOW_JS="$TMP_DIR/unit-window.cjs"
cat > "$UNIT_WINDOW_JS" <<'JS'
const fs = require("fs");
const e = process.env;
const out = process.argv[2];
let buf;
try { buf = fs.readFileSync(e.B12_TELE); } catch { buf = Buffer.alloc(0); }
const rows = [];
for (const line of buf.subarray(Number(e.B12_FROM) || 0).toString("utf8").split("\n")) {
  if (line.trim() === "") continue;
  let r; try { r = JSON.parse(line); } catch { continue; }
  rows.push(r);
}
const repairs = rows.filter((r) => r && r.tool === "repair");
// CONJUNCT ONE of the pre-registered rule. The other is vitest, taken by the
// shell; neither substitutes for the other.
const passed = repairs.filter((r) => r.detail && r.detail.passed === true).length;
// Did the model produce ANYTHING? An attempt is one request that came back with
// a body. Zero attempts across every round of every call is the signature of a
// backend that died before generation, which B15 already rules is not an
// observation -- it just had no way to say so here.
let attempts = 0;
for (const r of repairs) {
  const rounds = (r.detail && Array.isArray(r.detail.rounds)) ? r.detail.rounds : [];
  for (const rd of rounds) attempts += Array.isArray(rd.attempts) ? rd.attempts.length : 0;
}
// The model that SERVED the call, against the one this run declares. The
// preflight has recorded this since `b12-preflight-mac.sh:682` and never
// compared it; a scorer that does not compare it is scoring an unnamed model.
const models = [...new Set(repairs.map((r) => r.detail && r.detail.model).filter((m) => typeof m === "string"))];
const modelVerdict = models.length === 0 ? "unknown"
  : models.every((m) => m === e.B12_MODEL_EXPECT) ? "ok" : "mismatch";
// The context files the prompt CARRIED. An absent key is `unknown`, never a
// pass: the row predates the field, so the condition is unverifiable -- and
// unverifiable is a VOID, not a green light. Enumerate the good values and
// refuse everything the rule does not name, as the frozen-rates compare does.
const want = JSON.parse("[" + e.B12_CTX_EXPECT + "]");
const withKey = repairs.filter((r) =>
  r.detail && Object.prototype.hasOwnProperty.call(r.detail, "context_files") && r.detail.context_files !== null);
const seen = new Set();
for (const r of withKey) for (const p of (r.detail.context_files || [])) seen.add(p);
const ctxVerdict = repairs.length === 0 ? "no-rows"
  : withKey.length < repairs.length ? "unknown"
  : want.every((p) => seen.has(p)) ? "ok" : "missing";
// THE TWO LIMITS, as RESOLVED by the tool rather than as asked for in the
// prompt. They decide how many attempts the model got, they reach `repair`
// through a session that may drop them, and both have defaults -- so a run can
// be measured at 300 s while its own registration says 600 and nothing
// contradicts it. Absent is `unknown`, never a pass, for the same reason as the
// context files: a row that predates the field cannot answer the question.
const budgets = [...new Set(repairs.map((r) => r.detail && r.detail.budget_seconds))];
const roundCaps = [...new Set(repairs.map((r) => r.detail && r.detail.max_rounds))];
const limitsVerdict = repairs.length === 0 ? "no-rows"
  : budgets.some((b) => typeof b !== "number") || roundCaps.some((m) => typeof m !== "number") ? "unknown"
  : budgets.every((b) => b === Number(e.B12_BUDGET_EXPECT)) &&
    roundCaps.every((m) => m === Number(e.B12_ROUNDS_EXPECT)) ? "ok" : "mismatch";
fs.writeFileSync(out, JSON.stringify({
  repairCalls: repairs.length,
  repairPassed: passed,
  attemptsSeen: attempts,
  localModelObserved: models,
  localModelVerdict: modelVerdict,
  contextFilesExpected: want,
  contextFilesObserved: [...seen].sort(),
  contextFilesVerdict: ctxVerdict,
  rowsWithoutContextKey: repairs.length - withKey.length,
  budgetSecondsExpected: Number(e.B12_BUDGET_EXPECT),
  budgetSecondsObserved: budgets,
  maxRoundsExpected: Number(e.B12_ROUNDS_EXPECT),
  maxRoundsObserved: roundCaps,
  limitsVerdict,
  invocationIds: repairs.map((r) => r.invocation_id).filter(Boolean),
}, null, 2) + "\n");
// One line, five fields, for the shell. Anything else on stdout is a failure to
// produce it, and the shell checks the shape rather than trusting the exit code.
process.stdout.write([repairs.length, passed, attempts, modelVerdict, ctxVerdict, limitsVerdict].join(" ") + "\n");
JS
[ -s "$UNIT_WINDOW_JS" ] || refuse "the telemetry-window reader is empty; every unit below would be scored on the vitest exit code alone, which is the defect this run exists to fix"

# ONE ROW PER UNIT, and the only place rows are written. Called with the unit's
# state and, when there is one, the path to its telemetry-window JSON.
record_unit() {
  node -e '
    const fs = require("fs");
    const [units, n, name, state, extraJson, windowFile] = process.argv.slice(1);
    let row = { unit: Number(n), name, state };
    try { row = Object.assign(row, JSON.parse(extraJson)); } catch {}
    if (windowFile) {
      try { row.telemetryWindow = JSON.parse(fs.readFileSync(windowFile, "utf8")); }
      catch { row.telemetryWindow = "unreadable"; }
    }
    fs.appendFileSync(units, JSON.stringify(row) + "\n");
  ' "$UNITS_JSON" "$1" "$2" "$3" "$4" "${5:-}"
}

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

  # NOT SCORED HERE. Recorded rather than skipped silently: a denominator of
  # three with one unit measured is the reading, and the artifact has to carry
  # the name of the run that holds the others so a later reader can assemble the
  # exposure from both instead of from one and a memory.
  case " $UNITS_TO_ATTEMPT " in
    *" $UNIT "*) : ;;
    *)
      info "unit $N/$UNIT — not attempted here (B12_ONLY=$ONLY); carried from $CARRIED_FROM"
      NOT_HERE=$((NOT_HERE + 1))
      record_unit "$N" "$UNIT" "not-attempted-here" \
        "{\"carriedFrom\":\"$CARRIED_FROM\",\"note\":\"this run neither attempted nor scored this unit\"}"
      continue
      ;;
  esac

  # RESUMPTION. A unit an earlier attempt already closed is skipped, not
  # re-attempted: `repair` closing it once is the fact this run exists to
  # establish, and a crash afterwards did not un-close it.
  npx vitest run "$TESTFILE" >"$OUT/unit-$N-$UNIT.pre.vitest.txt" 2>&1
  if [ $? -eq 0 ]; then
    # ON A FRESH EXPOSURE THIS IS NOT GOOD NEWS. The guard above verified this
    # file byte-identical to its stub at $STUBS_FROZEN_AT, and the stub throws
    # `not implemented`. An oracle that a stub satisfies cannot fail -- and a
    # check that cannot fail is worse than no check, because every unit measured
    # against it closes for free and the run reports a reachability it never saw.
    if [ "$RESUME" != "1" ]; then
      refuse "unit $N/$UNIT is byte-identical to its stub at $STUBS_FROZEN_AT, and $TESTFILE PASSES anyway.

The stub throws \"not implemented\". An oracle it satisfies cannot fail, so it
cannot measure anything: every unit scored against it would close for free.

Fix the oracle before scoring a single unit on it. Its output is in:
  $OUT/unit-$N-$UNIT.pre.vitest.txt"
    fi
    # Under B12_RESUME=1 it IS legitimate -- same condition, a unit this
    # exposure already closed. But this run holds no repair evidence for it, and
    # the pre-registered rule needs BOTH conjuncts. So it counts as neither
    # closed nor red, and says which of the two it is missing.
    warn "unit $N/$UNIT is already green (B12_RESUME=1) — skipped. This run has no repair row for it, so it is recorded inherited-unverified and counted toward NEITHER side."
    INHERITED=$((INHERITED + 1))
    record_unit "$N" "$UNIT" "inherited-unverified" \
      "{\"note\":\"green under B12_RESUME=1; closed by an earlier run within this exposure. This run called repair for it zero times and therefore verified only one of the two conjuncts.\"}"
    continue
  fi

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
  max_rounds:    $MAX_ROUNDS
  budget_seconds: $BUDGET_SECONDS
  context_files: [$CONTEXT_FILES]

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

  # THE WINDOW OPENS HERE, immediately before the call, in bytes -- the same
  # idiom the run-wide baseline uses. Everything appended past this offset is
  # this unit's, because only this unit runs between here and the read below.
  UNIT_TELE_BEFORE=$(wc -c < "$TELEMETRY" 2>/dev/null | tr -d ' ')
  [ -n "$UNIT_TELE_BEFORE" ] || UNIT_TELE_BEFORE=0

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

  # THE WINDOW CLOSES HERE, and it is read BEFORE vitest runs: vitest writes no
  # telemetry, but reading first keeps the window bounded by the call it names.
  UNIT_TELE_JSON="$OUT/unit-$N-$UNIT.repair.json"
  WINDOW_LINE=$(B12_TELE="$TELEMETRY" B12_FROM="$UNIT_TELE_BEFORE" \
    B12_MODEL_EXPECT="$MODEL_LOCAL" B12_CTX_EXPECT="$CONTEXT_FILES" \
    B12_BUDGET_EXPECT="$BUDGET_SECONDS" B12_ROUNDS_EXPECT="$MAX_ROUNDS" \
    node "$UNIT_WINDOW_JS" "$UNIT_TELE_JSON" 2>&1 | head -1)
  R_CALLS=""; R_PASSED=""; R_ATTEMPTS=""; R_MODEL=""; R_CTX=""; R_LIMITS=""
  read -r R_CALLS R_PASSED R_ATTEMPTS R_MODEL R_CTX R_LIMITS <<WINDOW
$WINDOW_LINE
WINDOW
  # SHAPE, NOT EXIT CODE. An unreadable window is recorded as one: every count
  # goes to zero, which lands the unit in `no_repair_call` or
  # `vitest_green_unverified` -- both of which mean "no observation", which is
  # exactly what an unreadable window leaves behind.
  TELE_OK=1
  # Each field on its own. Concatenating them first would let "2" with two empty
  # siblings read as a valid all-digits string, and the empties would then reach
  # `[ "" -ge 1 ]` below as a silent false.
  for v in "$R_CALLS" "$R_PASSED" "$R_ATTEMPTS"; do
    case "$v" in
      ''|*[!0-9]*) TELE_OK=0 ;;
    esac
  done
  [ -n "$R_MODEL" ] && [ -n "$R_CTX" ] && [ -n "$R_LIMITS" ] || TELE_OK=0
  if [ "$TELE_OK" != "1" ]; then
    warn "could not read this unit's telemetry window (\"$WINDOW_LINE\"). Recorded as no observation rather than guessed at."
    R_CALLS=0; R_PASSED=0; R_ATTEMPTS=0; R_MODEL="unknown"; R_CTX="unknown"; R_LIMITS="unknown"
  fi
  info "repair rows $R_CALLS, passed $R_PASSED, generation attempts $R_ATTEMPTS"

  # THE MEASUREMENT, TAKEN BY THIS SCRIPT AND NOT READ OFF CLAUDE'S NARRATION.
  # This unit's oracle alone — the pre-registration says "that unit's tests", and
  # the first attempt handed it everyone's.
  npx vitest run "$TESTFILE" >"$OUT/unit-$N-$UNIT.vitest.txt" 2>&1
  VITEST_RC=$?
  # BOTH CONJUNCTS, EACH FROM ITS OWN INSTRUMENT, and a closed list of outcomes
  # in which every member is distinguishable from the evidence actually held.
  # Only `closed` counts toward the pre-registered bar; `no_response`,
  # `no_repair_call` and `could_not_run` count toward NEITHER side, because a
  # round with no response is not an observation.
  #
  # The markers are load-bearing: scripts/b12-scorer-selftest.sh extracts the
  # region between them VERBATIM and drives it against fabricated windows. A
  # copy of this logic in a test file would be a test of the copy -- and this
  # project has already shipped four refusals whose text was read and never run.
  # >>> B12-STATE-BLOCK
  case $VITEST_RC in
    0)
      if [ "$R_PASSED" -ge 1 ]; then
        UNIT_STATE="closed"; CLOSED=$((CLOSED + 1))
        ok "unit $N CLOSED — vitest exit 0 AND repair returned passed:true"
      else
        UNIT_STATE="vitest_green_unverified"
        warn "unit $N: vitest exit 0, but no repair row in this unit's window returned passed:true. Green and UNVERIFIED — not counted as a closure. (This is the state that used to be silently counted as one.)"
      fi
      ;;
    1)
      if [ "$R_ATTEMPTS" -gt 0 ]; then
        UNIT_STATE="red"; warn "unit $N still red after $R_ATTEMPTS generation attempt(s) — the model ran and did not close it"
      elif [ "$R_CALLS" -gt 0 ]; then
        UNIT_STATE="no_response"
        warn "unit $N: repair was called $R_CALLS time(s) and the model generated NOTHING — zero attempts across every round. This is not a failed repair, it is NO OBSERVATION, and it counts toward neither side."
      else
        UNIT_STATE="no_repair_call"
        warn "unit $N: not one repair row appeared in this unit's telemetry window. The tool under measurement was never invoked."
      fi
      ;;
    *) UNIT_STATE="could_not_run"; warn "vitest exited $VITEST_RC — could not run, which is NOT the same as red" ;;
  esac

  # THE TWO VOID CONDITIONS EXPOSURE B PRE-REGISTERED AND COULD NOT CHECK.
  # Recorded per unit and never refused mid-run: a run that stops here stops
  # without saying what it measured, and the VOID belongs in the reading.
  case "$R_MODEL" in
    ok) ok "local model verified in telemetry: $MODEL_LOCAL" ;;
    mismatch)
      warn "VOID: a repair row names a local model other than $MODEL_LOCAL. See $UNIT_TELE_JSON."
      VOIDS="$VOIDS local-model-mismatch:$UNIT" ;;
    *)
      warn "VOID: no repair row carried a model name, so the local model is UNVERIFIED for this unit."
      VOIDS="$VOIDS local-model-unverified:$UNIT" ;;
  esac
  case "$R_CTX" in
    ok) ok "context files verified in telemetry: $CONTEXT_FILES" ;;
    missing)
      warn "VOID: a context file this exposure declares never reached the model. See $UNIT_TELE_JSON."
      VOIDS="$VOIDS context-file-missing:$UNIT" ;;
    no-rows)
      warn "VOID: no repair row, so the context condition is unverifiable for this unit."
      VOIDS="$VOIDS context-unverifiable:$UNIT" ;;
    *)
      warn "VOID: detail.context_files is absent from a repair row — that row predates the field, so this exposure's context condition is UNVERIFIABLE. Unverifiable is not satisfied."
      VOIDS="$VOIDS context-unverifiable:$UNIT" ;;
  esac
  # THE LIMITS THE MODEL ACTUALLY RAN UNDER. They travel through a prompt and
  # both have defaults, so a session that dropped one would be measured at 300 s
  # and 3 rounds while this run's registration says otherwise — and nothing here
  # would have contradicted it before the field existed.
  case "$R_LIMITS" in
    ok) ok "limits verified in telemetry: budget ${BUDGET_SECONDS}s, max_rounds $MAX_ROUNDS" ;;
    mismatch)
      warn "VOID: a repair row ran under limits other than budget ${BUDGET_SECONDS}s / max_rounds $MAX_ROUNDS. The session did not pass what the prompt asked for. See $UNIT_TELE_JSON."
      VOIDS="$VOIDS limits-mismatch:$UNIT" ;;
    no-rows)
      warn "VOID: no repair row, so the limits are unverifiable for this unit."
      VOIDS="$VOIDS limits-unverifiable:$UNIT" ;;
    *)
      warn "VOID: detail.budget_seconds or detail.max_rounds is absent from a repair row — that row predates the field, so how many attempts the model got is UNVERIFIABLE."
      VOIDS="$VOIDS limits-unverifiable:$UNIT" ;;
  esac
  # <<< B12-STATE-BLOCK

  record_unit "$N" "$UNIT" "$UNIT_STATE" \
    "{\"sessionId\":\"$SESSION_ID\",\"claudeExit\":$CLAUDE_RC,\"vitestExit\":$VITEST_RC,\"usd\":\"$UNIT_USD\",\"model\":\"$MODEL_CLAUDE\"}" \
    "$UNIT_TELE_JSON"

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
// CLOSED MEANS BOTH CONJUNCTS. `already-green` used to be counted here, which
// is how a run that called `repair` zero times could report ">= 2 of 3".
const closed = units.filter((u) => u.state === "closed").length;
const red = units.filter((u) => u.state === "red").length;
const inherited = units.filter((u) => u.state === "inherited-unverified").length;
const notHere = units.filter((u) => u.state === "not-attempted-here");
// STATES THAT ARE NOT OBSERVATIONS. Each one means the model did not get a fair
// draw at this unit, so it counts toward neither side of the pre-registered rule
// and it stops the run from rendering a verdict at all. Exposure B's `aggregate`
// was `no_response` and was published as `red`, and `red` is an observation.
const NO_OBSERVATION = ["no_response", "no_repair_call", "could_not_run", "vitest_green_unverified"];
const blind = units.filter((u) => NO_OBSERVATION.includes(u.state));
const voids = (e.B12_VOIDS || "").split(/\s+/).filter(Boolean);
// The artifact does NOT combine runs. Every reading this project has published
// was written by hand into PREMISES.md with the artifact as its evidence, and a
// script that arithmetics across two runs would be inventing the one number the
// whole pre-registration exists to protect.
const reading =
  e.B12_ONLY
    ? "partial — " + (closed + red + blind.length) + " unit(s) attempted here (" + e.B12_ONLY +
      "), " + notHere.length + " carried from " + e.B12_CARRIED_FROM + ". NO verdict is rendered: " +
      "the >= 2 of 3 reading spans both runs and is written by hand into PREMISES.md with both " +
      "artifacts as evidence."
  : blind.length > 0
    ? "incomplete — " + blind.length + " unit(s) produced no observation (" +
      blind.map((u) => u.name + ": " + u.state).join(", ") + "). A unit the model never got a fair " +
      "draw at counts toward neither side, so this run cannot be read against the 2/1/0 rule."
  : units.length < 3 ? "incomplete — fewer than three units attempted"
  : closed >= 2 ? "R_repair reachable (>= 2 of 3)"
  : closed === 0 ? "R_repair unreachable (0 of 3) — B12's text must say it measures gate alone BEFORE Phase 4"
  : "INCONCLUSIVE (exactly 1 of 3) — the manifest may not be sealed on this";
const o = {
  runId: e.B12_RUN_ID,
  premise: "B12",
  phase: 3,
  // WHICH exposure, and the condition that defines it. Exposure A and B answer
  // the same pre-registered question under different context_files and windows,
  // and a reader pooling them would be pooling two conditions.
  exposure: e.B12_EXPOSURE,
  contextFiles: e.B12_CONTEXT_FILES,
  resumedWithinExposure: e.B12_RESUME === "1",
  preRegisteredIn:
    "PREMISES.md § B12 — PHASE-3 EXPOSURE " + e.B12_EXPOSURE,
  // Scoped to this run, and each state counted where it belongs rather than
  // folded into a single number that reads as a result.
  onlyUnit: e.B12_ONLY || null,
  carriedFrom: e.B12_ONLY ? e.B12_CARRIED_FROM : null,
  unitsAttemptedHere: closed + red + blind.length,
  unitsClosedHere: closed,
  unitsRedHere: red,
  unitsWithNoObservation: blind.map((u) => ({ name: u.name, state: u.state })),
  unitsInheritedUnverified: inherited,
  unitsNotAttemptedHere: notHere.map((u) => u.name),
  // Pre-registered VOID conditions, evaluated against telemetry rather than
  // declared. An empty array means every one of them was checked and held; it
  // does NOT mean none were checked -- the per-unit telemetryWindow below says
  // which verdict each check returned.
  voids,
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
    // REQUESTED AND OBSERVED, split. The preflight has recorded the served
    // model since `b12-preflight-mac.sh:672-682`; the scorer declared one and
    // never looked. A run whose rows name a different model is scoring a model
    // it cannot name, which `voids` above now says out loud.
    localModel: {
      requested: e.B12_LOCAL_MODEL,
      observed: [...new Set(units.flatMap((u) =>
        (u.telemetryWindow && Array.isArray(u.telemetryWindow.localModelObserved))
          ? u.telemetryWindow.localModelObserved : []))],
    },
    ratesSha256: e.B12_RATES,
    host: "mac",
    // Recorded because they are suspects, not decoration. Two attempts on
    // 2026-08-06 died to IOGPUFamily panics, and the fix being tried is an OS
    // update plus a runtime update -- a change to the machine that must not be
    // invisible in the evidence a later reader compares across attempts.
    os: e.B12_OS,
    osBuild: e.B12_OS_BUILD,
    kernel: e.B12_KERNEL,
    inferenceRuntime: e.B12_RUNTIME,
    kernelPanicsBeforeRun: e.B12_PANIC_N,
    newestPanicBeforeRun: e.B12_PANIC_LAST,
  },
  caveat:
    "Three units, one repository, one local model. This is EXPOSURE, not a rate. " +
    "It decides nothing about R_gate, nothing about the bracket, and nothing about " +
    "whether B12 holds or falls.",
};
writeFileSync(file, JSON.stringify(o, null, 2) + "\n");
const back = JSON.parse(readFileSync(file, "utf8"));
if (!back.context || !back.context.commit) { console.error("provenance did not land in " + file); process.exit(1); }
process.stdout.write("B12-SCORER-OK closed=" + closed + " red=" + red + " no-observation=" + blind.length +
  " inherited=" + inherited + " not-here=" + notHere.length + " voids=" + voids.length + "\n");
JS
[ -s "$MERGE_JS" ] || refuse "the merge script is empty; the artifact would have been finalised with no provenance"

MERGE_OUT=$(B12_RUN_ID="$RUN_ID" B12_UNITS="$UNITS_JSON" B12_SPENT="$SPENT" B12_BUDGET="$BUDGET_USD" \
  B12_WIN_START="$WINDOW_START" B12_WIN_END="$WINDOW_END" B12_MIN_CTX="$MIN_CONTEXT" \
  B12_SHA="$LOCAL_SHA" B12_BRANCH="$BRANCH" B12_CLAUDE_VER="$CLAUDE_VER" B12_CLAUDE_SHA="$CLAUDE_SHA" \
  B12_MODEL="$MODEL_CLAUDE" B12_LOCAL_MODEL="$MODEL_LOCAL" B12_RATES="$RATES_NOW" \
  B12_CORPUS_NEW="$CORPUS_NEW" B12_CORPUS_PRE="$CORPUS_PRE" B12_INHERITED="$INHERITED" \
  B12_OS="$OS_PRODUCT" B12_OS_BUILD="$OS_BUILD" B12_KERNEL="$KERNEL" B12_RUNTIME="$MLX_RUNTIME" \
  B12_PANIC_N="$PANIC_N" B12_PANIC_LAST="$PANIC_LAST" \
  B12_EXPOSURE="$EXPOSURE" B12_CONTEXT_FILES="$CONTEXT_FILES" B12_RESUME="$RESUME" \
  B12_ONLY="$ONLY" B12_CARRIED_FROM="$CARRIED_FROM" B12_VOIDS="$VOIDS" \
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

$CLOSED of $ATTEMPTED attempted units closed here. Written by scripts/b12-scorer-mac.sh; the
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

# "%s of %s" with CLOSED over ATTEMPTED read "1 of 2" on a run that closed
# NOTHING: the 1 was `strata`, inherited and skipped, so it was never one of the
# 2. The artifact had it right the whole time and the terminal line -- the only
# number most readings will ever see -- presented inherited work as this run's.
# The denominator of the pre-registered rule is THREE, and the split has to be
# on its face. It now also has to show the units that produced NO observation,
# which is the distinction that made exposure B's reading wrong.
printf '\n\033[1mDONE\033[0m — %s of 3 units CLOSED here (repair passed:true AND vitest 0).\n' "$CLOSED"
printf '   %s attempted here, %s inherited-unverified, %s not attempted here.\n' \
  "$ATTEMPTED" "$INHERITED" "$NOT_HERE"
node -e '
  const fs = require("fs");
  let rows = [];
  try { rows = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse); } catch {}
  for (const r of rows) {
    const w = r.telemetryWindow;
    const detail = (w && typeof w === "object")
      ? "  (repair calls " + w.repairCalls + ", passed " + w.repairPassed + ", attempts " + w.attemptsSeen + ")"
      : "";
    process.stdout.write("   unit " + r.unit + " " + r.name + ": " + r.state + detail + "\n");
  }
' "$UNITS_JSON" 2>/dev/null || true
[ -n "$VOIDS" ] && printf '   \033[1mVOID conditions triggered:\033[0m%s\n' "$VOIDS"
printf '\nSend back exactly this one file:\n  %s\n' "$ARCHIVE"
printf '\nIt carries: the run artifact with provenance, the git bundle and diff of\n'
printf 'what the local model wrote, the telemetry slice, the corpus captures, and\n'
printf 'the per-unit claude and vitest logs.\n\n'
printf 'The one thing this script changed that it does not undo: node_modules/ and\n'
printf 'dist/ were rebuilt. Undo with:  rm -rf node_modules dist && npm ci\n\n'
