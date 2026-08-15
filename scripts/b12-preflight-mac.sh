#!/usr/bin/env bash
#
# b12-preflight-mac.sh — run B12's pre-flight on the Mac, end to end.
#
#   bash b12-preflight-mac.sh [/path/to/claude-code-local-llm-mcp]
#
# The pre-flight exists to spend ten minutes instead of forty-five sessions and
# one of two attempts. It is the only step that exercises `repair` against a real
# local model, which the Windows machine cannot do at all: `mcp__local-coder__status`
# there reports `reachable: false`, `lms_available: false`, `models: []`, and the
# catalog's first entry is an `mlx-community` build — Apple Silicon only.
#
# THIS SCRIPT REFUSES RATHER THAN IMPROVISES. Every precondition is checked and
# named, and nothing continues past a failure: a run that carried on past a bad
# assertion would leave an artifact indistinguishable from a clean one, which is
# the failure this whole registry exists to prevent.
#
# WHAT IT CHANGES IN YOUR CLONE, stated plainly rather than implied:
#   - it runs `npm ci`, which rebuilds node_modules from the lockfile;
#   - it CHECKS OUT $BRANCH and does NOT switch back — the branch you were on is
#     printed at the end with the command to return to it;
#   - it creates and removes one file, src/b12-scratch.ts;
#   - it writes one artifact into evidence/;
#   - it runs `npm run build`, which REWRITES dist/ in the clone;
#   - it copies its report to $HOME/Desktop (OUT_DIR), outside the clone.
# Everything else it touches lives in a temp directory it made and removes.
#
# Bash 3.2 compatible (macOS default). No associative arrays, no `${x,,}`.

set -u
set -o pipefail

# RUNNABLE FROM ANYWHERE. With an argument -- absolute or relative -- the `cd`
# plus `pwd -P` below resolves it. WITHOUT one, prefer the repository the caller
# is standing in: falling straight to a hardcoded default refuses for anyone
# whose clone lives elsewhere, and "cd into the repo and run it" is the most
# natural way to use this.
if [ "${1:-}" != "" ]; then
  REPO="$1"
else
  REPO=$(git rev-parse --show-toplevel 2>/dev/null)
  [ -n "$REPO" ] || REPO="$HOME/Documents/GitHub/claude-code-local-llm-mcp"
fi
# THE BRANCH THIS PRE-FLIGHT MEASURES. Overridable, and pinned by default
# because a pre-flight has to name the tree it measured.
#
# IT WENT STALE ONCE AND THE SCRIPT COULD NOT NOTICE. It read
# `claude/project-status-pdf-d726eb` until 2026-08-14, by which time that branch
# was 279 commits behind the work — no one-scoring-invocation loop, no
# `blobSha` tri-state, none of it. The tip check below would have passed, since
# it compares HEAD against `origin/$BRANCH` and the Mac would have been exactly
# at the tip OF THE WRONG BRANCH, producing an artifact that looks like a clean
# pre-flight of an instrument nobody is going to run.
#
# So: override with B12_BRANCH when preflighting something else, and CHECK THIS
# LINE against the branch you actually intend. The refusal below proves you are
# at a tip; only this line says which.
BRANCH="${B12_BRANCH:-claude/b12-orchestrator-pinning-check-ccc397}"
MODEL="${B12_MODEL:-mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2}"
# `acceptEdits` covers file edits; whether an MCP tool call still prompts in
# `--print` mode I could not test from Windows. If the session comes back having
# called nothing, that is the likely cause -- re-run with
# B12_PERMISSION_MODE=bypassPermissions. Named here rather than guessed at.
PERMISSION_MODE="${B12_PERMISSION_MODE:-acceptEdits}"
# THE LIMITS THE SCRATCH SESSION RUNS UNDER, PASSED RATHER THAN INHERITED.
# Until 2026-08-14 the prompt below asked for a `repair` call with no limits at
# all, so what it ran under was whatever the product happened to default to that
# day -- and that number moved (300 -> 240) for reasons having nothing to do with
# this script. An artifact that cannot say which limits produced it is the defect
# this whole registry exists to prevent, and `b12-scorer-mac.sh` already refuses
# to run without pinning its own pair (:254-256).
#
# 240 and 3 are the VALUES a PHASE 5 observation ends up under: `b12-run.mjs`
# pins neither `budget_seconds` nor `LOCAL_CODER_TIMEOUT_MS`, so an observation
# inherits `DEFAULT_BUDGET_SECONDS` (240) and reaches 3 rounds by the tool's own
# default. PHASE 3's 600/180000 pair is deliberately NOT copied: that harness
# asks whether `repair` CAN close a large unit, and a rehearsal at limits no
# observation uses rehearses nothing.
#
# CORRECTED 2026-08-14, SAME DAY, after an adversarial review: this block first
# said an observation "takes max_rounds from the task's own repairMaxRounds".
# IT DOES NOT. `repairMaxRounds` is validated (b12-manifest.mjs:457), carried
# into the manifest (:480) and archived (archive.ts:256), and then nothing
# transmits it: `b12-run.mjs:2880` hands the session `task.prompt` alone, and no
# corpus prompt mentions `repair` at all. The observation matches 3 by COINCIDENCE
# of the tool's default, and would archive clean at `max_rounds: 10`. That is a
# gap in PHASE 5, not in this script, and `scripts/b12-run.mjs` is inside clause
# 5's PINNED_PATHS, so closing it is the owner's decision and not this commit's.
#
# WHICH IS ALSO WHY THE PROMPT PINNING THEM IS A DIVERGENCE, NAMED RATHER THAN
# HIDDEN: PHASE 5 delivers no limits, this rehearsal delivers two. The pin buys a
# deterministic scratch run and an artifact that can be compared with the next
# one; it does NOT exercise the inheritance path an observation actually takes.
# And the scratch defect is a one-line type error that has always closed in one
# round, so neither the third round nor the 240-second deadline is reached: these
# limits are RECORDED here, never BOUND. A green preflight is not evidence that
# budget enforcement works.
#
# What the probe below DOES verify, since 2026-08-14: it joins the telemetry row
# by `invocation_id` and reads `detail.budget_seconds` / `detail.max_rounds` back,
# so the artifact carries asked AND observed and says whether they agreed. Before
# that it could only ever record what was asked -- the limits live on the
# telemetry row and never on the returned result.
REPAIR_BUDGET_SECONDS="${B12_REPAIR_BUDGET_SECONDS:-240}"
REPAIR_MAX_ROUNDS="${B12_REPAIR_MAX_ROUNDS:-3}"
SCRATCH_SRC="src/b12-scratch.ts"
OUT_DIR="$HOME/Desktop"
[ -d "$OUT_DIR" ] || OUT_DIR="$HOME"

# NOTHING THE CLEANUP TOUCHES IS INHERITED FROM THE ENVIRONMENT.
#
# `TMP_DIR` is an ordinary variable name and the trap is installed long before
# the script assigns it, so ANY early refusal -- `lms` missing, a dirty tree --
# ran `rm -rf` on whatever the caller happened to have exported. Measured: a
# directory of unrelated files, deleted. `set -u` does not help, because the
# variable IS set; that is the whole problem.
#
# Cleared here, and each removal is additionally gated on a flag this script
# sets only after it created the thing.
TMP_DIR=""
TMP_MINE=0
SCRATCH_MINE=0
CLAUDE_LOG=""
MERGE_JS=""
PROBE_JS=""
CLEANED=0
ART=""
ART_FINALISED=0
START_REF=""

step=0
say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    ok    %s\n' "$1"; }
info() { printf '    ..    %s\n' "$1"; }
warn() { printf '    !!    %s\n' "$1"; }
refuse() {
  printf '\n\033[1mREFUSED\033[0m — %s\n\n' "$1" >&2
  printf 'Nothing was scored. Fix the above and re-run; the script is idempotent.\n' >&2
  exit 1
}
next() { step=$((step + 1)); say "$step. $1"; }

# ONE RULE, ONE PLACE: tracked changes, with git's exit status CHECKED rather
# than inferred from empty output.
#
# `$(git status ... | grep -v "^?? " || true)` returns "" when git fails, and ""
# reads as "clean". A check that cannot run reported the good outcome -- at the
# start it let the run proceed over a tree it never inspected, and at the end it
# wrote `treeAsFound: true` into the artifact. That is false safety evidence, in
# a file whose whole job is to be trusted later.
#
# STDERR IS NOT FOLDED IN. It used to capture `2>&1`, and git writes warnings to
# stderr while still exiting 0 -- so a warning line, which does not start with
# `?? `, survived the filter and became a "tracked change". That refused a clean
# tree at the start, and at the end reported `repair touched more than the
# scratch file` about a file that does not exist. The porcelain shape is also
# asserted, so nothing that is not a status line can reach the caller.
#
# Sets GIT_RC and GIT_TRACKED. Callers decide what to do; nobody guesses.
git_tracked_changes() {
  GIT_TRACKED=""
  local raw
  raw=$(git status --porcelain 2>/dev/null)
  GIT_RC=$?
  [ $GIT_RC -ne 0 ] && return 0
  [ -z "$raw" ] && return 0
  GIT_TRACKED=$(printf '%s\n' "$raw" | grep -E '^[MADRCU!? ][MADRCU!? ] ' | grep -v '^?? ' || true)
  return 0
}

cleanup() {
  # Runs from both the EXIT trap and the signal handlers. Idempotent by flag so
  # the second pass does not print removals a second time.
  [ "${CLEANED:-0}" = "1" ] && return 0
  CLEANED=1
  if [ "${SCRATCH_MINE:-0}" = "1" ] && [ -n "${REPO:-}" ] && [ -f "$REPO/$SCRATCH_SRC" ]; then
    rm -f "$REPO/$SCRATCH_SRC"
    printf '    ..    removed %s\n' "$SCRATCH_SRC"
  fi
  # AN ARTIFACT WITHOUT ITS PROVENANCE MUST NOT SURVIVE THIS RUN.
  #
  # `$ART` is a pure function of the UTC date and the pinned commit, so every
  # run on a given day at the tip targets the SAME filename -- and the harness
  # writes it only at the very end, after refusals that exit first. So an
  # interrupted or refused run could leave a scored file at exactly the
  # deliverable path, which the next run's `[ -f "$ART" ]` would find, stamp
  # with TODAY's provenance and announce as today's result. The file that gets
  # sent back would be a previous run's scoring wearing this run's commit.
  if [ "${ART_FINALISED:-0}" = "0" ] && [ -n "${ART:-}" ] && [ -f "$ART" ]; then
    rm -f "$ART"
    printf '    ..    removed an artifact that never got its provenance block\n'
  fi
  [ "${TMP_MINE:-0}" = "1" ] && [ -n "${TMP_DIR:-}" ] && rm -rf "$TMP_DIR"
  return 0
}

# A SIGNAL HANDLER THAT RETURNS DOES NOT STOP THE SCRIPT.
#
# `trap cleanup EXIT INT TERM` with a handler ending in `return 0` was measured
# to run the handler and then RESUME at the statement after the interrupted
# command. So Ctrl-C during `claude --print` deleted the fixture and the
# --mcp-config and then carried on into the pre-flight, scoring a session that
# had been killed mid-flight -- and if the interrupt landed after both tool
# calls, the file left behind said `passed: true`. The interrupt produced the
# artifact instead of preventing it.
#
# These restore the default disposition and re-raise, so the shell dies of the
# signal (130/143) exactly where it was interrupted.
on_signal() {
  printf '\n\033[1mINTERRUPTED\033[0m — stopping here. Nothing was scored.\n' >&2
  cleanup
  trap - INT TERM EXIT
  kill -"$1" "$$"
}
trap cleanup EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

# ---------------------------------------------------------------------------
next "Tools this needs"

for bin in git node npm claude; do
  command -v "$bin" >/dev/null 2>&1 || refuse "\`$bin\` is not on PATH"
done
ok "git, node, npm, claude present"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) refuse "could not read node's major version (got \"$NODE_MAJOR\"). An unreadable version must not be compared as a number." ;;
esac
[ "$NODE_MAJOR" -ge 18 ] || refuse "node $NODE_MAJOR is too old; package.json requires >= 18"
ok "node $(node -v)"

command -v lms >/dev/null 2>&1 || refuse \
  "the \`lms\` CLI is missing. Without it there is no local model, and \`repair\` is exactly what this pre-flight exists to exercise. Install LM Studio's CLI, then re-run."
ok "lms present"

# EXIT CODE FIRST, THEN SHAPE. The previous version captured `2>&1` and only
# checked for emptiness -- so a failing `claude --version` filled the variable
# with its own error text, passed the non-empty test, and was written into the
# artifact as `claudeVersion: "Error: cannot read config"`. Widening the capture
# to stderr is what made the check unable to fail.
CLAUDE_VER=$(claude --version 2>/dev/null)
CV_RC=$?
[ $CV_RC -eq 0 ] || refuse "claude --version exited $CV_RC. The version is part of the evidence and may not be guessed at."
CLAUDE_VER=$(printf '%s' "$CLAUDE_VER" | head -1)
case "$CLAUDE_VER" in
  *[0-9].[0-9]*) : ;;
  *) refuse "claude --version returned \"$CLAUDE_VER\", which does not look like a version. Recording it would put a sentence where a number belongs." ;;
esac
ok "claude $CLAUDE_VER"

# ---------------------------------------------------------------------------
next "Repository"

# ASK GIT, NOT THE FILESYSTEM. In a linked worktree `.git` is a FILE containing
# `gitdir: ...`, not a directory, so `[ -d "$REPO/.git" ]` refused a perfectly
# valid checkout -- and the no-argument path made that a self-contradiction: it
# detected the repository with `git rev-parse --show-toplevel` and then rejected
# it with a test git had nothing to do with.
git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || refuse "no git work tree at $REPO (pass the path as the first argument)"
cd "$REPO" || refuse "cannot enter $REPO"
# ABSOLUTE from here on. A relative path would be written into the temporary
# --mcp-config, and Claude Code resolves that against ITS cwd, not this one.
REPO=$(pwd -P)
[ -n "$REPO" ] || refuse "pwd -P returned nothing; every path below would be built from an empty string"

# IDENTITY, not just "a git repo". Auto-detection could land on whatever clone
# the caller happened to be inside, and a mistyped argument on some neighbour --
# either way the next steps would fetch a branch into a stranger and build it.
REPO_NAME=$(node -p "require('$REPO/package.json').name" 2>/dev/null)
[ "$REPO_NAME" = "local-coder-mcp" ] || refuse "$REPO is not this project (package.json name is \"$REPO_NAME\", expected local-coder-mcp). Pass the right path as the first argument."
ok "repository identified as local-coder-mcp"

# THE CHEAPEST REFUSAL GOES FIRST. This is a plain filesystem test that depends
# on nothing below it, and it used to sit after `npm ci`, the build and the
# model load -- so the one guard protecting the operator's own file only fired
# after several minutes of work that then had to be thrown away. It costs
# nothing here and is checked again at the point of use.
[ -e "$REPO/$SCRATCH_SRC" ] && refuse \
  "$SCRATCH_SRC already exists. This script creates and deletes that exact path, so it will not touch a file it did not create. Move or remove it, then re-run."

git_tracked_changes
[ $GIT_RC -eq 0 ] || refuse "git status failed (exit $GIT_RC). The tree was never inspected, and an uninspected tree must not read as a clean one."
if [ -n "$GIT_TRACKED" ]; then
  printf '%s\n' "$GIT_TRACKED" | sed 's/^/      /'
  refuse "the working tree has tracked changes. Checking out over them would either fail or lose them, and neither belongs in a measurement run. Commit or stash, then re-run."
fi
ok "tree clean of tracked changes (git status ran, exit 0)"

# REMEMBERED BEFORE IT IS CHANGED, so the closing report can hand back the exact
# command to undo the one mutation this script does not undo itself.
START_REF=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse HEAD 2>/dev/null || true)

info "fetching origin/$BRANCH"
git fetch origin "$BRANCH" --quiet || refuse "git fetch failed — is the remote reachable?"
if ! git checkout -q "$BRANCH" 2>/dev/null; then
  if ! git checkout -q -b "$BRANCH" "origin/$BRANCH" 2>/dev/null; then
    # The likeliest cause in a repository that uses worktrees, and git's own
    # message is swallowed above, so name it rather than leave the reader
    # guessing at "could not check out".
    HOLDER=$(git worktree list 2>/dev/null | grep "\[$BRANCH\]" | head -1 || true)
    if [ -n "$HOLDER" ]; then
      refuse "$BRANCH is already checked out in another worktree: $HOLDER. Run this from that directory, or remove that worktree."
    fi
    refuse "could not check out $BRANCH"
  fi
fi
git merge --ff-only "origin/$BRANCH" --quiet 2>/dev/null || true

# TWO EMPTY STRINGS ARE EQUAL. With `git rev-parse` failing on both sides this
# read as "at the tip" and let the run proceed against an unknown commit -- the
# same false-safe shape as the git-status and tsc checks, wearing a comparison
# instead of a grep.
LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null)
REMOTE_SHA=$(git rev-parse "origin/$BRANCH" 2>/dev/null)
case "$LOCAL_SHA" in
  ????????????????????????????????????????) : ;;
  *) refuse "could not read HEAD as a commit sha (got \"$LOCAL_SHA\")" ;;
esac
case "$REMOTE_SHA" in
  ????????????????????????????????????????) : ;;
  *) refuse "could not read origin/$BRANCH as a commit sha (got \"$REMOTE_SHA\")" ;;
esac
[ "$LOCAL_SHA" = "$REMOTE_SHA" ] || refuse \
  "HEAD is $(git rev-parse --short HEAD) but origin/$BRANCH is $(git rev-parse --short origin/$BRANCH). The Mac is not at the tip, and a pre-flight of the wrong instrument says nothing about the right one."
ok "at the tip of $BRANCH — $(git rev-parse --short HEAD)"

# ---------------------------------------------------------------------------
next "Build"

info "npm ci (this takes a minute)"
npm ci --silent >/dev/null 2>&1 || refuse "npm ci failed — run it by hand to see why"
npm run build --silent >/dev/null 2>&1 || refuse "npm run build failed — run it by hand to see why"
[ -f "dist/cost/cli.js" ] || refuse "dist/cost/cli.js is missing after a build that reported success"
[ -f "dist/server.js" ] || refuse "dist/server.js is missing after a build that reported success"
ok "built"

# EXTENSIONS MATTER TO EVERY CONSUMER, and `mktemp -t` gives random ones.
# `--mcp-config` takes "JSON files or strings", so a path that does not look
# like a file is a candidate for being parsed as a literal string; and node
# refuses a script whose extension it does not know outright --
# ERR_UNKNOWN_FILE_EXTENSION, measured. One directory, named files inside it.
# Created here rather than at step 5 because the model check below needs it.
TMP_DIR=$(mktemp -d -t b12pre)
[ -n "$TMP_DIR" ] || refuse "mktemp -d produced no directory"
TMP_MINE=1

# ---------------------------------------------------------------------------
next "Local model"

info "starting LM Studio's server (no-op if already up)"
lms server start >/dev/null 2>&1 || true

# THE ID YOU ASK FOR IS NOT THE ID THAT IS SERVED, and this project already
# knows it. `src/selection.ts` matches a catalog name against what `/models`
# answers with `matchModel`: normalized-exact first, then a conservative pass
# over basenames and stripped quant/format suffixes, returning the QUALITY so a
# fuzzy match is surfaced and never trusted silently.
#
# I wrote a second rule -- `case ",$REACHABLE," in *",$MODEL,"*` -- and it
# refused a Mac where the model was loaded and answering, because LM Studio
# serves `qwen3-coder-30b-a3b-instruct-dwq-v2` for
# `mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2`. That is this
# registry's oldest defect: two implementations of one rule that never meet.
# This imports the real one out of the `dist/` just built.
#
# `lms ps` is gone with it. Its check was the same string compare, so it never
# recognised a loaded model either -- and its answer ran `lms load` on something
# already resident, which is why that Mac's endpoint listed the 30B TWICE
# (`...-dwq-v2` and `...-dwq-v2:2`). A second copy of a 30B model changes how
# much RAM is free, and free RAM is what `selectModelForMemory` selects on. The
# endpoint lists exactly what is loaded, so it is asked directly and once.
MODELS_JS="$TMP_DIR/models.mjs"
cat > "$MODELS_JS" <<'JS'
import { pathToFileURL } from "node:url";
const { matchModel } = await import(pathToFileURL(process.argv[3]).href);
let ids = null;
try {
  const r = await fetch("http://localhost:1234/v1/models");
  ids = ((await r.json()).data || []).map((m) => m.id);
} catch {
  ids = null;
}
// `reachable` and `loaded` are separate answers. An endpoint that is up with
// nothing loaded returns an empty list, and reading that as "not answering"
// would send the operator to restart a server that is already running.
if (ids === null) {
  process.stdout.write("no\tnone\t\t\n");
} else {
  const m = matchModel(process.argv[2], ids);
  process.stdout.write(`yes\t${m.quality}\t${m.value ?? ""}\t${ids.join(",")}\n`);
}
JS
probe_models() {
  MODEL_LINE=$(node "$MODELS_JS" "$MODEL" "$REPO/dist/selection.js" 2>/dev/null || true)
  REACH_OK=$(printf '%s' "$MODEL_LINE" | cut -f1)
  MATCH_Q=$(printf '%s' "$MODEL_LINE" | cut -f2)
  MATCH_ID=$(printf '%s' "$MODEL_LINE" | cut -f3)
  REACHABLE=$(printf '%s' "$MODEL_LINE" | cut -f4)
}

# THE PROBE RAN AND THE ENDPOINT ANSWERED -- asserted after EVERY call, not just
# the first. `$1` names which call, so a failure says whether it happened before
# or after the load.
assert_probe_ran() {
  [ -n "$MODEL_LINE" ] || refuse "the model probe produced no output at all$1 (node failed). An unasked endpoint must not read as a working one."
  [ "$REACH_OK" = "yes" ] || refuse \
    "LM Studio is not answering on http://localhost:1234/v1$1. \`repair\` cannot do work without it, and a pre-flight where \`repair\` aborts reports \`excludedForeign: 1\` and no repair row — it fails, correctly, but you will have spent the setup for nothing."
}

probe_models
assert_probe_ran ""

if [ "$MATCH_Q" = "none" ]; then
  info "loading $MODEL — this can take a while on first run"
  lms load "$MODEL" >/dev/null 2>&1 || refuse \
    "could not load $MODEL. Check \`lms ls\` for what is downloaded, then re-run with B12_MODEL=<id> to pick another."
  probe_models
  assert_probe_ran " after \`lms load\`"
fi

# THE ONE PLACE THE MODEL IS DECLARED RESOLVED, AND IT ASSERTS THE GOOD VALUES.
#
# The post-load re-check used to be `[ "$MATCH_Q" = "none" ] && refuse` -- a test
# for one specific way of being wrong. `none` is what the probe says when it RAN
# and matched nothing; when the probe itself failed every field came back EMPTY,
# and "" is not "none", so the check passed. Measured: the run printed
# `ok endpoint serves it as "" (match: )` and carried on with no served id, no
# match quality and no endpoint list, which would have reached the artifact as
# three nulls sitting under a green line.
#
# So it enumerates what "resolved" means instead. This runs on both paths -- the
# model was already loaded, or it was just loaded -- so neither can skip it.
case "$MATCH_Q" in
  exact|fuzzy) : ;;
  none) refuse "the endpoint serves nothing matching $MODEL (it serves: $REACHABLE). Recording it as the model would be an assumption, not a measurement." ;;
  *) refuse "the model probe reported a match quality of \"$MATCH_Q\", which is neither exact, fuzzy nor none. A value the rule does not name must not be read as one that it does." ;;
esac
[ -n "$MATCH_ID" ] || refuse "the probe reported a $MATCH_Q match and named no served id. Half an answer is not an answer."
ok "endpoint serves it as \"$MATCH_ID\" (match: $MATCH_Q)"
[ "$MATCH_Q" = "fuzzy" ] && info "fuzzy means the served id differs from the catalog id; both go into the artifact"

# A SECOND COPY IS NOT FREE. `id:2` is LM Studio's second instance of the same
# model, and the RAM it holds is RAM `selectModelForMemory` will not count as
# free -- which can push the server onto the 14B while everything here reports
# the 30B as present.
case ",$REACHABLE," in
  *",$MATCH_ID:"*) warn "the endpoint lists more than one instance of $MATCH_ID; \`lms unload\` the spare if RAM is tight" ;;
esac

# WHAT LM STUDIO SERVES IS STILL NOT WHAT THE MCP SERVER PICKS. The config below
# passes `"env":{}`, and the server chooses in src/selection.ts: the largest
# CATALOG entry that fits free RAM, falling back to catalog[0]. So none of the
# above establishes which model `repair` ran on. That is read back out of the
# session afterwards and recorded as its own field.

# ---------------------------------------------------------------------------
next "MCP server, scoped to this run"

MCP_CFG="$TMP_DIR/mcp.json"
cat > "$MCP_CFG" <<JSON
{"mcpServers":{"local-coder":{"type":"stdio","command":"node","args":["$REPO/dist/server.js"],"env":{}}}}
JSON
# SIZE IS NOT VALIDITY. `$REPO` is interpolated into a JSON string literal with
# no escaping, so a quote or a backslash anywhere in the checkout path produces
# a syntactically invalid config -- with plenty of bytes in it. The guard this
# replaces asked only `[ -s ]`, and the one before that tested a variable that
# could not be empty while its refusal message named a `mktemp` it never called.
node -e '
const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const s = c.mcpServers && c.mcpServers["local-coder"];
if (!s || !Array.isArray(s.args) || !require("node:fs").existsSync(s.args[0])) process.exit(1);
' "$MCP_CFG" 2>/dev/null || refuse "the temporary --mcp-config is not a usable config pointing at $REPO/dist/server.js (a quote or backslash in the checkout path will do this)"
ok "wrote a temporary --mcp-config (your global Claude config is untouched)"

# ---------------------------------------------------------------------------
next "Work for repair to close"

# NEVER CLOBBER. Checked at step 2 as well; re-checked at the point of use
# because the window between them contains `git checkout` and `npm ci`.
if [ -e "$REPO/$SCRATCH_SRC" ]; then
  refuse "$SCRATCH_SRC already exists. This script creates and deletes that exact path, so it will not touch a file it did not create. Move or remove it, then re-run."
fi
# OWNED BEFORE IT IS WRITTEN, so a partial write is still removed by the trap.
SCRATCH_MINE=1
cat > "$REPO/$SCRATCH_SRC" <<'TS'
// Created by scripts/b12-preflight-mac.sh and removed by its trap.
// A deliberate type error, so `gate` is mechanically red and `repair` has
// exactly one failure to close. Without this the pre-flight is ceremony:
// `repair` on a green tree reports "nothing to do" and exercises nothing.
export const answer: number = "not a number";
TS
# A FAILED WRITE READS AS A PASSING FIXTURE. The heredoc's status was discarded,
# so a read-only checkout or a full disk left no file, tsc then exited 0, and
# the refusal that fired said "tsc still passes with the scratch error in
# place" -- pointing the reader at a type error that was never written.
[ -s "$REPO/$SCRATCH_SRC" ] || refuse "could not write $SCRATCH_SRC (is the checkout writable?)"
ok "created $SCRATCH_SRC"

# Exit 0 means the fixture is not doing its job. Exit 1 or 2 means type errors,
# which is what we want. ANYTHING ELSE means tsc could not run -- and reading
# that as "red, as intended" is the same false-safe shape as the git check:
# `npx` missing or offline would have been recorded as a working fixture.
npx tsc -p tsconfig.json --noEmit >/dev/null 2>&1
TSC_RC=$?
case $TSC_RC in
  0) refuse "tsc still passes with the scratch error in place, so \`gate\` will not be red and \`repair\` will have nothing to close. Look at $SCRATCH_SRC." ;;
  1|2) ok "tsc is red, as intended (exit $TSC_RC)" ;;
  *) refuse "tsc could not run (exit $TSC_RC). A tool that failed to start is not a red gate, and treating it as one would certify a fixture nobody compiled." ;;
esac

# ---------------------------------------------------------------------------
next "Scratch session: one gate call, one repair call"

SESSION_ID=$(uuidgen | tr 'A-Z' 'a-z')
case "$SESSION_ID" in
  ????????-????-????-????-????????????) : ;;
  *) refuse "uuidgen did not produce a uuid (got \"$SESSION_ID\"). The pre-flight reads the session back by this id, so an empty one would read somebody else's session or none." ;;
esac
info "session $SESSION_ID"

# ITS OUTPUT IS KEPT, AND INSIDE THE DIRECTORY THE TRAP ALREADY REMOVES. The
# first real run exited 1 and wrote no transcript, and the one thing that would
# have said why had been sent to /dev/null. Its own `mktemp` was also the single
# temp path with no guard: had it failed, the redirection would have failed, the
# command would never have run, and `$?` would still have been 1 -- recorded as
# "claude exited 1" about a claude that never started.
CLAUDE_LOG="$TMP_DIR/claude.log"

# THE PROMPT MUST NOT FOLLOW A VARIADIC OPTION.
#
# `claude --help` declares `--allowedTools, --allowed-tools <tools...>` and
# `--mcp-config <configs...>`: both variadic, both consuming every following
# argument until one starts with `-`. The prompt sat immediately after
# `--allowed-tools`, so it was swallowed as another tool name and claude ran
# with NO PROMPT. Measured, three invocations on the same machine:
#
#   --allowed-tools "Foo" "<prompt>"          -> Error: Input must be provided
#                                                either through stdin or as a
#                                                prompt argument when using --print
#   --allowed-tools "Foo" --permission-mode X "<prompt>"  -> reached the API
#   --allowed-tools "Foo" -- "<prompt>"                   -> reached the API
#
# That is exactly the Mac's `claude exited 1` with no transcript at all. Two
# independent guards now: the last option before the prompt is non-variadic,
# and `--` ends option parsing.
#
# `--strict-mcp-config` is new here. Without it Claude Code MERGES this file
# with the machine's user/project-scoped servers, and a globally registered
# `local-coder` would claim the same name -- so the tools called might have been
# served by some other build, and the artifact would credit this commit for it.
DISABLE_AUTOUPDATER=1 claude --print \
  --strict-mcp-config \
  --mcp-config "$MCP_CFG" \
  --allowed-tools "mcp__local-coder__gate,mcp__local-coder__repair" \
  --session-id "$SESSION_ID" \
  --permission-mode "$PERMISSION_MODE" \
  -- \
  "Call mcp__local-coder__gate exactly once. It will be red: src/b12-scratch.ts has a type error. Then call mcp__local-coder__repair EXACTLY ONCE, with these arguments and no others: files: [\"$SCRATCH_SRC\"], spec: \"the type error in $SCRATCH_SRC must be fixed so the checks pass\", max_rounds: $REPAIR_MAX_ROUNDS, budget_seconds: $REPAIR_BUDGET_SECONDS. Pass max_rounds and budget_seconds explicitly even though they have defaults — this run is only comparable to another if the limits it ran under are known. Do not edit any file yourself, do not use Bash, and do not call any other tool." \
  >"$CLAUDE_LOG" 2>&1
CLAUDE_EXIT=$?

if [ $CLAUDE_EXIT -ne 0 ]; then
  info "claude exited $CLAUDE_EXIT — its output is below and goes into the artifact"
  tail -20 "$CLAUDE_LOG" 2>/dev/null | sed 's/^/      /'
else
  ok "scratch session finished"
fi
CLAUDE_LOG_TAIL=$(tail -c 4000 "$CLAUDE_LOG" 2>/dev/null || true)

# READ BACK WHAT ACTUALLY HAPPENED, rather than asserting it. Two things the
# run cannot otherwise know: whether a transcript exists at all (the previous
# failure mode, which surfaced only as an ENOENT deep inside the harness), and
# WHICH MODEL served `repair` -- the server chooses its own, so `$MODEL` is a
# request, not a measurement.
PROBE_JS="$TMP_DIR/probe.cjs"
cat > "$PROBE_JS" <<'JS'
const { readdirSync, readFileSync, existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const sessionId = process.argv[2];
const repo = process.argv[3] || "";
const root = path.join(os.homedir(), ".claude", "projects");
// `transcriptFound` is decided HERE and nowhere else. Both consumers -- the
// shell's terminal warning and the artifact's provenance block -- used to derive
// it themselves from the shape of this JSON, which is two implementations of a
// one-line rule that could disagree the moment this file changes.
const out = {
  transcript: null,
  transcriptFound: false,
  tools: [],
  repairModel: null,
  // The id `repair` returns AND writes on its telemetry row, which is what makes
  // the join below exact rather than a guess over a time window.
  repairInvocationId: null,
  repairLimits: null,
};
const walk = (d, depth) => {
  if (depth > 3 || out.transcript !== null) return;
  let entries;
  try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === sessionId + ".jsonl") { out.transcript = p; return; }
  }
};
if (existsSync(root)) walk(root, 0);
// The repair result travels as JSON inside a text block, so the shape is dug
// for rather than assumed: any object carrying both `rounds_used` and a string
// `model` is repair's own return value. Not found stays null, never a guess.
const dig = (v, depth) => {
  if (depth > 8 || v === null || v === undefined) return;
  if (typeof v === "string") {
    if (v.length > 1 && (v[0] === "{" || v[0] === "[")) {
      let p;
      try { p = JSON.parse(v); } catch { return; }
      dig(p, depth + 1);
    }
    return;
  }
  if (Array.isArray(v)) { for (const x of v) dig(x, depth + 1); return; }
  if (typeof v === "object") {
    if ("rounds_used" in v && typeof v.model === "string") {
      out.repairModel = v.model;
      if (typeof v.invocation_id === "string") out.repairInvocationId = v.invocation_id;
    }
    for (const k of Object.keys(v)) dig(v[k], depth + 1);
  }
};
if (out.transcript) {
  for (const line of readFileSync(out.transcript, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const content = rec && rec.message && rec.message.content;
    if (Array.isArray(content)) {
      for (const c of content) if (c && c.type === "tool_use" && typeof c.name === "string") out.tools.push(c.name);
    }
    dig(rec.toolUseResult, 0);
  }
}
out.transcriptFound = out.transcript !== null;
// WHAT THE CALL ACTUALLY RAN UNDER. The limits reach the model through prose and
// live on the telemetry row's `detail`, never on the returned result, so the
// result alone cannot answer this and an artifact built from it could only ever
// say what was ASKED. Joined by `invocation_id`, which `repair` both returns and
// writes: exact, so a second repair call in the same window cannot be mistaken
// for this one, and no time-window heuristic is needed.
//
// Absent telemetry, an absent id and an unreadable file all leave `repairLimits`
// null. Null is "not known", which is a different answer from a mismatch, and
// the artifact keeps them apart.
if (repo && out.repairInvocationId) {
  try {
    const tel = readFileSync(path.join(repo, ".local-coder", "telemetry.jsonl"), "utf8");
    for (const line of tel.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || row.tool !== "repair" || row.invocation_id !== out.repairInvocationId) continue;
      const d = row.detail || {};
      out.repairLimits = {
        budget_seconds: typeof d.budget_seconds === "number" ? d.budget_seconds : null,
        max_rounds: typeof d.max_rounds === "number" ? d.max_rounds : null,
      };
    }
  } catch { /* leaves null */ }
}
process.stdout.write(JSON.stringify(out));
JS
PROBE=$(node "$PROBE_JS" "$SESSION_ID" "$REPO" 2>/dev/null || true)
case "$PROBE" in
  '{'*) : ;;
  *) PROBE=""; warn "could not read the session back; the artifact will record that as unknown rather than as absent" ;;
esac
# BOTH KNOWN ANSWERS ARE MATCHED POSITIVELY, and anything else is named unknown.
# This was `*'"transcript":null'*` with everything else falling to `ok
# "transcript found"` -- so a probe whose output no longer carried that exact
# substring, for any reason, reported the good outcome. Same shape as the model
# check above, in the same file, written the same hour.
if [ -n "$PROBE" ]; then
  case "$PROBE" in
    *'"transcriptFound":true'*)
      ok "transcript found; tools called are recorded in the artifact"
      ;;
    *'"transcriptFound":false'*)
      warn "CLAUDE WROTE NO TRANSCRIPT for $SESSION_ID. The pre-flight below will"
      warn "fail on the harness, not on the instrument — read scratchSession.log"
      warn "in the artifact before concluding anything about the meter."
      ;;
    *)
      warn "the probe answered but did not say whether a transcript exists; the"
      warn "artifact records that as unknown rather than as either answer."
      ;;
  esac
  # THE LIMITS, READ BACK RATHER THAN ASSUMED. Every branch is matched
  # positively and the fall-through is named unknown, the same shape as the
  # transcript check above and for the same reason: a probe whose output stops
  # carrying one of these substrings must not land on the good outcome.
  case "$PROBE" in
    *'"repairLimits":null'*|*'"repairLimits": null'*)
      warn "the repair call's limits could not be read back from telemetry, so the"
      warn "artifact records what the prompt ASKED and nothing about what ran."
      ;;
    *'"repairLimits":{'*)
      # Substring match on the pair the prompt demanded. Exact numbers, so a
      # session that passed something else cannot satisfy it.
      case "$PROBE" in
        *"\"budget_seconds\":$REPAIR_BUDGET_SECONDS,\"max_rounds\":$REPAIR_MAX_ROUNDS"*)
          ok "limits verified in telemetry: budget ${REPAIR_BUDGET_SECONDS}s, max_rounds $REPAIR_MAX_ROUNDS"
          ;;
        *)
          warn "THE REPAIR CALL RAN UNDER LIMITS THE PROMPT DID NOT ASK FOR. The"
          warn "session did not pass budget ${REPAIR_BUDGET_SECONDS}s / max_rounds $REPAIR_MAX_ROUNDS."
          warn "Read repairLimits.observed in the artifact; this run is not"
          warn "comparable with one that ran under the asked-for pair."
          ;;
      esac
      ;;
    *)
      warn "the probe said nothing about the repair limits; recorded as unknown."
      ;;
  esac
fi

# ---------------------------------------------------------------------------
next "Pre-flight"

STAMP=$(date -u +%Y-%m-%d)
SHORT=$(printf '%s' "$LOCAL_SHA" | cut -c1-7)   # from the sha already validated above
[ -n "$STAMP" ] && [ -n "$SHORT" ] || refuse "could not build the artifact filename (stamp=\"$STAMP\" short=\"$SHORT\")"
ART="$REPO/evidence/$STAMP-mac-b12-$SHORT.preflight.json"
mkdir -p "$REPO/evidence" || refuse "could not create $REPO/evidence"

# THE ONLY FILE AT THIS PATH MUST BE THIS RUN'S. The name is a pure function of
# the date and the pinned commit, and the harness writes it only after refusals
# that exit first -- so without this a refused run's leftover would be found
# below, stamped with today's provenance and shipped as today's result.
rm -f "$ART"

# NOT wrapped in `set -e`/`set +e`: errexit is never on in this script, and
# turning it on here would abort before the result is printed, on the very
# `cmd && ...` lines below. A pre-flight that fails must still say so.
DISABLE_AUTOUPDATER=1 node scripts/b12-run.mjs preflight \
  --session "$SESSION_ID" \
  --out "$ART"
PRE_EXIT=$?

# THE TREE VERDICT GOES INTO THE ARTIFACT, AND BEFORE IT IS COPIED.
#
# It used to be printed to the terminal only, and printed AFTER the artifact
# had already been finalised and copied to the Desktop. So the one file that
# gets sent back -- the whole point of this run -- carried no record of whether
# `repair` had touched anything beyond the scratch file. A reader holding only
# the artifact would have had incorrect evidence, and would not have known it.
[ "${SCRATCH_MINE:-0}" = "1" ] && rm -f "$REPO/$SCRATCH_SRC"
SCRATCH_MINE=0
git_tracked_changes
TREE_RC=$GIT_RC
LEFTOVER="$GIT_TRACKED"
# Informational only -- no verdict is drawn from it, so an empty result on
# failure costs nothing. Said here so the next reader does not have to work out
# why this one is allowed the pattern the two above are not.
UNTRACKED=$(git status --porcelain 2>/dev/null | grep "^?? " || true)

# The artifact is kept whether it passed or failed. A failed pre-flight is the
# result the pre-flight exists to produce; hiding it would defeat the point.
if [ -f "$ART" ]; then
  # A QUOTED HEREDOC, NOT `node -e`. The inline form had three JS strings whose
  # "\n" arrived as a REAL newline -- the escaping crossed Python, bash and JS,
  # and JS is where it broke. This crashed on the Mac and the artifact went out
  # with no commit, no version and no tree verdict: the provenance the run exists
  # to carry. A quoted heredoc is passed through verbatim by bash.
  #
  # VALUES ARRIVE BY NAME, NOT BY POSITION. Eleven positional arguments meant one
  # missing value silently shifted every field after it -- the commit landing in
  # `branch`, the branch in `claudeVersion`. Environment variables cannot shift.
  MERGE_JS="$TMP_DIR/merge.cjs"
  cat > "$MERGE_JS" <<'JS'
const { readFileSync, writeFileSync } = require("node:fs");
const e = process.env;
const file = process.argv[2];
const o = JSON.parse(readFileSync(file, "utf8"));
const rc = e.B12_TREE_RC;
const leftover = e.B12_LEFTOVER || "";
const untracked = e.B12_UNTRACKED || "";
let probe = null;
try { probe = JSON.parse(e.B12_PROBE || "null"); } catch { probe = null; }
o.context = {
  commit: e.B12_SHA,
  branch: e.B12_BRANCH,
  claudeVersion: e.B12_CLAUDE_VER,
  host: "mac",
  // NAMED FOR WHAT EACH ONE IS. `model` used to be written here as fact from a
  // variable that only ever reached `lms load`; the server selects its own.
  modelRequestedFromLmStudio: e.B12_MODEL,
  // The id the endpoint actually answers to, and HOW it was matched. `fuzzy`
  // means the served spelling differs from the catalog spelling -- recorded,
  // not smoothed over, because a reader comparing two runs by model name would
  // otherwise see two different models.
  modelServedAs: e.B12_MATCH_ID || null,
  modelMatchQuality: e.B12_MATCH_Q || null,
  modelsServedByLmStudio: (e.B12_REACHABLE || "").split(",").filter(Boolean),
  modelUsedByRepair: probe && probe.repairModel ? probe.repairModel : null,
  // WHAT THE PROMPT ASKED FOR, which is not the same as what the call ran under.
  // The limits reach the model through prose, so a session that dropped one
  // would be recorded here as if it had not — the scorer closes that gap by
  // reading `detail.budget_seconds` back out of telemetry and VOIDing on a
  // mismatch, and this script does not. `asked` is the honest word.
  // ASKED and OBSERVED, kept apart on purpose. The limits travel to the model
  // through prose, so what the prompt demanded and what the call ran under are
  // two different facts and only the second one is a measurement. `agreed` is
  // null when either side is unknown -- absent telemetry is not agreement, and
  // it is not a mismatch either.
  //
  // `asked` is null when the variable did not arrive, DELIBERATELY and not by way
  // of a NaN that JSON.stringify would quietly flatten to the same thing.
  repairLimits: (() => {
    const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
    const asked = { budget_seconds: num(e.B12_REPAIR_BUDGET), max_rounds: num(e.B12_REPAIR_ROUNDS) };
    const observed = (probe && probe.repairLimits) || null;
    const both = observed !== null && asked.budget_seconds !== null && asked.max_rounds !== null;
    return {
      asked,
      observed,
      agreed: both
        ? observed.budget_seconds === asked.budget_seconds && observed.max_rounds === asked.max_rounds
        : null,
      joinedBy: probe && probe.repairInvocationId ? "invocation_id" : null,
    };
  })(),
  serverEnv: {},
  strictMcpConfig: true,
  sessionId: e.B12_SESSION,
  treeCheckRan: rc === "0",
  treeAsFound: rc === "0" ? leftover.length === 0 : null,
  trackedChangesLeftBehind: leftover ? leftover.split("\n") : [],
  untrackedFilesPresent: untracked ? untracked.split("\n") : [],
  scratchSession: {
    exitCode: Number(e.B12_CLAUDE_EXIT),
    // Taken from the probe, not re-derived: `null` when the probe did not say,
    // which is a third answer and not the absence of a problem.
    transcriptFound: probe && typeof probe.transcriptFound === "boolean" ? probe.transcriptFound : null,
    toolsCalled: probe ? probe.tools : null,
    log: e.B12_CLAUDE_LOG || "",
  },
};
writeFileSync(file, JSON.stringify(o, null, 2) + "\n");
// READ BACK, THEN ANNOUNCE. A zero-byte merge.cjs -- an interrupted `cat`, a
// full temp volume -- makes node exit 0 having done nothing, so success could
// not be read from its status. The caller looks for this sentinel instead: an
// assertion of what happened, not the absence of an error.
const back = JSON.parse(readFileSync(file, "utf8"));
if (!back.context || !back.context.commit) {
  console.error("provenance did not land in " + file);
  process.exit(1);
}
process.stdout.write("B12-PROVENANCE-OK checks=" + (Array.isArray(back.checks) ? back.checks.length : 0) + "\n");
JS
  [ -s "$MERGE_JS" ] || refuse "the temporary merge script is empty; the artifact would have been finalised with no provenance"
  MERGE_OUT=$(B12_SHA="$LOCAL_SHA" B12_BRANCH="$BRANCH" B12_CLAUDE_VER="$CLAUDE_VER" \
    B12_MODEL="$MODEL" B12_REACHABLE="$REACHABLE" B12_SESSION="$SESSION_ID" \
    B12_MATCH_ID="$MATCH_ID" B12_MATCH_Q="$MATCH_Q" \
    B12_LEFTOVER="$LEFTOVER" B12_UNTRACKED="$UNTRACKED" B12_TREE_RC="$TREE_RC" \
    B12_CLAUDE_EXIT="$CLAUDE_EXIT" B12_CLAUDE_LOG="$CLAUDE_LOG_TAIL" B12_PROBE="$PROBE" \
    B12_REPAIR_BUDGET="$REPAIR_BUDGET_SECONDS" B12_REPAIR_ROUNDS="$REPAIR_MAX_ROUNDS" \
    node "$MERGE_JS" "$ART" 2>&1)
  NCHECKS=""
  case "$MERGE_OUT" in
    *B12-PROVENANCE-OK*)
      ART_FINALISED=1
      NCHECKS=$(printf '%s\n' "$MERGE_OUT" | sed -n 's/.*B12-PROVENANCE-OK checks=\([0-9]*\).*/\1/p' | head -1)
      ;;
    *)
      printf '%s\n' "$MERGE_OUT" | sed 's/^/      /' >&2
      # The artifact is removed by the trap: un-provenanced, it is
      # indistinguishable from a good one once it leaves this machine.
      refuse "could not write provenance into the artifact, so it was removed rather than sent. The pre-flight itself exited $PRE_EXIT — re-run and it will be re-scored."
      ;;
  esac

  # RECORDED, NOT RE-DERIVED. `cp` used to discard its reason and print nothing
  # at all on failure, while the closing report separately tested whether a file
  # of that NAME sat on the Desktop -- and the name is deterministic, so a
  # previous run's copy answered yes for a copy that never happened.
  COPIED=0
  if cp "$ART" "$OUT_DIR/" 2>&1; then
    COPIED=1
    ok "copied to $OUT_DIR/$(basename "$ART")"
  else
    warn "could not copy to $OUT_DIR (reason above) — send the copy in evidence/ instead"
  fi
fi

# ---------------------------------------------------------------------------
say "Result"

if [ $PRE_EXIT -eq 0 ]; then
  printf '    PRE-FLIGHT PASSED\n'
else
  printf '    PRE-FLIGHT FAILED — the artifact says which check, and that is a real answer\n'
fi

if [ $TREE_RC -ne 0 ]; then
  printf '\n    TREE INTEGRITY UNKNOWN — git status failed (exit %s). The artifact\n' "$TREE_RC"
  printf '    records this as unknown rather than as clean.\n'
elif [ -n "$LEFTOVER" ]; then
  printf '\n    THE TREE IS NOT AS IT WAS FOUND — repair touched more than the\n'
  printf '    scratch file. This is recorded in the artifact too:\n'
  printf '%s\n' "$LEFTOVER" | sed 's/^/      /'
else
  printf '\n    tree is as it was found\n'
fi

# Never name a path that is not there: a reported artifact that does not exist
# is the same class of false statement this run exists to catch.
if [ -f "$ART" ]; then
  printf '\n    artifact: %s\n' "$ART"
  [ "$COPIED" = "1" ] && printf '    also at: %s\n' "$OUT_DIR/$(basename "$ART")"
  # The count is read back from the file rather than written from memory: the
  # line used to promise "the seven checks" and the harness emits eleven, or
  # five when it cannot reach the session.
  printf '\n    Send that one file back. It carries %s checks, the commit, the\n' "${NCHECKS:-?}"
  printf '    Claude Code version, which model LM Studio served and which one\n'
  printf '    repair actually used, the session id, whether claude wrote a\n'
  printf '    transcript at all, and whether the tree came back as it was found.\n\n'
else
  printf '\n    NO ARTIFACT WAS WRITTEN — the pre-flight did not get far enough to\n'
  printf '    produce one. The output above is all there is.\n\n'
fi

# THE ONE MUTATION THIS SCRIPT DOES NOT UNDO. Restoring the branch automatically
# would be a third checkout on a tree `repair` has just written to; naming it is
# honest and costs nothing.
NOW_REF=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null || true)
if [ -n "$START_REF" ] && [ "$START_REF" != "$NOW_REF" ]; then
  printf '    Your clone is now on %s. You were on %s:\n' "$NOW_REF" "$START_REF"
  printf '        git -C %s checkout %s\n\n' "$REPO" "$START_REF"
fi

exit $PRE_EXIT
