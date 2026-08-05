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
# It leaves the tree as it found it. The one file it creates is removed by a
# trap, including on interrupt.
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
BRANCH="claude/project-status-pdf-d726eb"
MODEL="${B12_MODEL:-mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2}"
# `acceptEdits` covers file edits; whether an MCP tool call still prompts in
# `--print` mode I could not test from Windows. If the session comes back having
# called nothing, that is the likely cause -- re-run with
# B12_PERMISSION_MODE=bypassPermissions. Named here rather than guessed at.
PERMISSION_MODE="${B12_PERMISSION_MODE:-acceptEdits}"
SCRATCH_SRC="src/b12-scratch.ts"
OUT_DIR="$HOME/Desktop"

step=0
say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    ok    %s\n' "$1"; }
info() { printf '    ..    %s\n' "$1"; }
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
# Sets GIT_RC and GIT_TRACKED. Callers decide what to do; nobody guesses.
git_tracked_changes() {
  GIT_TRACKED=""
  local raw
  raw=$(git status --porcelain 2>&1)
  GIT_RC=$?
  [ $GIT_RC -ne 0 ] && return 0
  [ -z "$raw" ] && return 0
  GIT_TRACKED=$(printf '%s
' "$raw" | grep -v "^?? " || true)
  return 0
}

cleanup() {
  if [ "${SCRATCH_MINE:-0}" = "1" ] && [ -n "${REPO:-}" ] && [ -f "$REPO/$SCRATCH_SRC" ]; then
    rm -f "$REPO/$SCRATCH_SRC"
    printf '    ..    removed %s\n' "$SCRATCH_SRC"
  fi
  [ -n "${MCP_CFG:-}" ] && rm -f "$MCP_CFG"
  return 0
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
next "Tools this needs"

for bin in git node npm claude; do
  command -v "$bin" >/dev/null 2>&1 || refuse "\`$bin\` is not on PATH"
done
ok "git, node, npm, claude present"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
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

git_tracked_changes
[ $GIT_RC -eq 0 ] || refuse "git status failed (exit $GIT_RC). The tree was never inspected, and an uninspected tree must not read as a clean one."
if [ -n "$GIT_TRACKED" ]; then
  printf '%s
' "$GIT_TRACKED" | sed 's/^/      /'
  refuse "the working tree has tracked changes. Checking out over them would either fail or lose them, and neither belongs in a measurement run. Commit or stash, then re-run."
fi
ok "tree clean of tracked changes (git status ran, exit 0)"

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

# ---------------------------------------------------------------------------
next "Local model"

info "starting LM Studio's server (no-op if already up)"
lms server start >/dev/null 2>&1 || true

if ! lms ps 2>/dev/null | grep -q "$MODEL"; then
  info "loading $MODEL — this can take a while on first run"
  lms load "$MODEL" >/dev/null 2>&1 || refuse \
    "could not load $MODEL. Check \`lms ls\` for what is downloaded, then re-run with B12_MODEL=<id> to pick another."
fi

REACHABLE=$(node -e '
fetch("http://localhost:1234/v1/models")
  .then(r => r.json())
  .then(d => console.log((d.data || []).map(m => m.id).join(",")))
  .catch(() => console.log(""));
' 2>/dev/null)
[ -n "$REACHABLE" ] || refuse \
  "LM Studio is not answering on http://localhost:1234/v1. \`repair\` cannot do work without it, and a pre-flight where \`repair\` aborts reports \`excludedForeign: 1\` and no repair row — it fails, correctly, but you will have spent the setup for nothing."
ok "model endpoint answering: $REACHABLE"

# ---------------------------------------------------------------------------
next "MCP server, scoped to this run"

MCP_CFG=$(mktemp -t b12mcp)
[ -n "$MCP_CFG" ] || refuse "mktemp produced no path for the temporary --mcp-config"
cat > "$MCP_CFG" <<JSON
{"mcpServers":{"local-coder":{"type":"stdio","command":"node","args":["$REPO/dist/server.js"],"env":{}}}}
JSON
[ -s "$MCP_CFG" ] || refuse "the temporary --mcp-config is empty; claude would start with no server and the treatment arm would be a control"
ok "wrote a temporary --mcp-config (your global Claude config is untouched)"

# ---------------------------------------------------------------------------
next "Work for repair to close"

# NEVER CLOBBER. The clean-tree check above filters `^?? `, so it says nothing
# about UNTRACKED files -- and a pre-existing src/b12-scratch.ts, yours or left
# by an interrupted run, would be overwritten here and then DELETED by the trap.
# The script would have destroyed work while reporting a clean run.
if [ -e "$REPO/$SCRATCH_SRC" ]; then
  refuse "$SCRATCH_SRC already exists. This script creates and deletes that exact path, so it will not touch a file it did not create. Move or remove it, then re-run."
fi
cat > "$REPO/$SCRATCH_SRC" <<'TS'
// Created by scripts/b12-preflight-mac.sh and removed by its trap.
// A deliberate type error, so `gate` is mechanically red and `repair` has
// exactly one failure to close. Without this the pre-flight is ceremony:
// `repair` on a green tree reports "nothing to do" and exercises nothing.
export const answer: number = "not a number";
TS
SCRATCH_MINE=1
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

DISABLE_AUTOUPDATER=1 claude --print \
  --session-id "$SESSION_ID" \
  --permission-mode "$PERMISSION_MODE" \
  --mcp-config "$MCP_CFG" \
  --allowed-tools "mcp__local-coder__gate,mcp__local-coder__repair" \
  "Call mcp__local-coder__gate exactly once. It will be red: src/b12-scratch.ts has a type error. Then call mcp__local-coder__repair exactly once to fix that file. Do not edit any file yourself, do not use Bash, and do not call any other tool." \
  >/dev/null 2>&1
CLAUDE_EXIT=$?

if [ $CLAUDE_EXIT -ne 0 ]; then
  info "claude exited $CLAUDE_EXIT — continuing, because the pre-flight reads the transcript and will say what it found"
else
  ok "scratch session finished"
fi

# ---------------------------------------------------------------------------
next "Pre-flight"

STAMP=$(date -u +%Y-%m-%d)
SHORT=$(printf '%s' "$LOCAL_SHA" | cut -c1-7)   # from the sha already validated above
[ -n "$STAMP" ] && [ -n "$SHORT" ] || refuse "could not build the artifact filename (stamp=\"$STAMP\" short=\"$SHORT\")"
ART="$REPO/evidence/$STAMP-mac-b12-$SHORT.preflight.json"
mkdir -p "$REPO/evidence"

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
# Guarded like the trap is. Reaching here without having created the file is
# not reachable by the linear flow -- and "not reachable" is the reasoning that
# failed six times in this session's other rule, so it is checked instead.
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
  node -e '
    const fs = require("fs");
    const [file, sha, branch, ver, model, session, leftover, untracked, rc] = process.argv.slice(1);
    const o = JSON.parse(fs.readFileSync(file, "utf8"));
    o.context = {
      commit: sha, branch, claudeVersion: ver, model, sessionId: session, host: "mac",
      // `null` is UNKNOWN, never `true`. If the check could not run, saying
      // the tree was as found would be evidence invented by a failure.
      treeCheckRan: rc === "0",
      treeAsFound: rc === "0" ? leftover.length === 0 : null,
      trackedChangesLeftBehind: leftover ? leftover.split("
") : [],
      untrackedFilesPresent: untracked ? untracked.split("
") : [],
    };
    fs.writeFileSync(file, JSON.stringify(o, null, 2) + "
");
  ' "$ART" "$LOCAL_SHA" "$BRANCH" "$CLAUDE_VER" "$MODEL" "$SESSION_ID" "$LEFTOVER" "$UNTRACKED" "$TREE_RC"
  cp "$ART" "$OUT_DIR/" 2>/dev/null && ok "copied to $OUT_DIR/$(basename "$ART")"
fi

# ---------------------------------------------------------------------------
say "Result"

if [ $PRE_EXIT -eq 0 ]; then
  printf '    PRE-FLIGHT PASSED
'
else
  printf '    PRE-FLIGHT FAILED — the artifact says which check, and that is a real answer
'
fi

if [ $TREE_RC -ne 0 ]; then
  printf '
    TREE INTEGRITY UNKNOWN — git status failed (exit %s). The artifact
' "$TREE_RC"
  printf '    records this as unknown rather than as clean.
'
elif [ -n "$LEFTOVER" ]; then
  printf '
    THE TREE IS NOT AS IT WAS FOUND — repair touched more than the
'
  printf '    scratch file. This is recorded in the artifact too:
'
  printf '%s
' "$LEFTOVER" | sed 's/^/      /'
else
  printf '
    tree is as it was found
'
fi

# Never name a path that is not there: a reported artifact that does not exist
# is the same class of false statement this run exists to catch.
if [ -f "$ART" ]; then
  printf '
    artifact: %s
' "$ART"
  [ -f "$OUT_DIR/$(basename "$ART")" ] && printf '    also at: %s
' "$OUT_DIR/$(basename "$ART")"
  printf '
    Send that one file back. It carries the seven checks, the commit,
'
  printf '    the Claude Code version, the model, the session id, and whether the
'
  printf '    tree came back as it was found.

'
else
  printf '
    NO ARTIFACT WAS WRITTEN — the pre-flight did not get far enough to
'
  printf '    produce one. The output above is all there is.

'
fi

exit $PRE_EXIT
