#!/usr/bin/env bash
#
# b12-installedchars-probe-mac.sh — the paired probe that PREMISES.md § B12
# pre-declared, run end to end on the Mac.
#
#   bash scripts/b12-installedchars-probe-mac.sh [/path/to/clone]
#
# WHAT IT MEASURES. `installedChars` — the per-arm resident system-prompt delta
# on the pinned binary — estimated by the paired first-request usage delta:
# k = 3 replicates, each one fresh treatment session and one fresh control
# session, identical but for the arm; the statistic is the FIRST billed
# request's TOTAL prompt token count — input + cacheWrite + cacheRead, a sum
# every prompt token lands in exactly once, so it is INVARIANT to cache state.
# (The original input+cacheWrite form demanded cacheRead = 0, and the API
# refuted it: prompt cache is prefix-keyed ACROSS sessions — cacheRead=22099
# on a fresh session id, measured here. The amendment is dated in
# PREMISES.md § B12, made before any delta existed.) The pre-declaration was
# registered BEFORE this script existed and may not be adjusted to fit its
# result: SUSTAINED iff all three deltas are identical, non-negative and
# finite; anything else takes the retract-and-re-register branch. k = 3 and
# tolerance 0 are CHOSEN constants, recorded as such there.
#
# BOTH ARMS ARE STRICT — treatment `--strict-mcp-config --mcp-config <cfg>`,
# control `--strict-mcp-config` — mirroring `observe()`, which was corrected
# the same day for the same measured reason: the first run of this probe found
# ~30 claude.ai ACCOUNT connectors on the work Mac (`claude mcp list`), which
# `claude mcp remove` cannot remove and a work machine cannot drop. Without
# strict on the treatment they merge into one arm and not the other. Strict on
# both makes the account state ARM-INVARIANT: either strict excludes it
# (clean) or it lands identically in both arms and CANCELS in the paired
# subtraction — in both worlds the delta isolates this server. The connector
# roster is recorded in the artifact, not refused on.
# NOT claimed as byte-for-byte argv equivalence with observe(): no manifest
# exists yet, so there are no `pinned.extraArgs` and no sealed MCP config;
# both are calibration key components, which is why the value is RE-TAKEN
# when a manifest seals.
#
# WHAT KEEPS THE PAIR A PAIR. Memory and settings enter the system prompt, so
# a write between a replicate's two arms would not cancel in the subtraction.
# The probe therefore hashes the environment (global + project settings,
# CLAUDE.md, and this cwd's memory directory) before EVERY session and once at
# the end, and REFUSES on any movement. It also proves the treatment
# installation actually works — one proof session, outside the measured six,
# must show a `mcp__local-coder__status` tool_use in its transcript — so a
# silently failed MCP init cannot masquerade as a genuine zero delta.
#
# WHAT IT CHANGES, stated plainly rather than implied:
#   - it runs `npm ci` and `npm run build`, which REWRITES dist/ in the clone;
#   - it CHECKS OUT $BRANCH and does NOT switch back — the branch you were on
#     is printed at the end with the command to return to it;
#   - it writes ONE artifact into evidence/ (REFUSING if the path exists —
#     never deleting a prior probe) and copies it to $HOME/Desktop;
#   - it does NOT touch MEASUREMENTS.jsonl: the row it earns is carried INSIDE
#     the artifact (`measurementsRow`, ts stamped by this script at write
#     time), with the exact append command for the machine that commits — this
#     one cannot push, and a locally-appended row would collide with the pull
#     that brings the committed one back;
#   - the seven sessions (1 proof + 6 measured) write ordinary Claude Code
#     transcripts under ~/.claude/projects; they are calibration scratch, not
#     observations, and no run is registered, so no contamination clause
#     attaches.
#
# Optional pins, asserted when set and recorded either way:
#   B12_EXPECT_CLAUDE_VERSION  substring the version must contain
#   B12_EXPECT_CLAUDE_SHA256   exact sha256 of the claude binary
#   B12_PERMISSION_MODE        proof session only (default acceptEdits; use
#                              bypassPermissions if the tool is never called)
#
# THE CALIBRATION KEY IS DUAL. Both arms of the real run deliver their own
# policy blob via `--append-system-prompt`, so both blobs sit INSIDE the delta
# this probe measures — (treatment blob − control blob) rides alongside the
# MCP installation. To calibrate a manifest that seals blobs, this probe must
# run UNDER those blobs. Provide all four, or none:
#   B12_POLICY_REPO            path to the policy repo clone (full, not shallow)
#   B12_POLICY_COMMIT          the sealed commit, full 40-hex
#   B12_POLICY_TREATMENT_PATH  path inside the repo, e.g. treatment.md
#   B12_POLICY_CONTROL_PATH    path inside the repo, e.g. control.md
# With none set the probe is EXPLORATORY: the dual key records nulls, no
# policy is delivered, and the validator will refuse it against any manifest
# that seals blobs — which every registrable manifest now does.
#
# THIS SCRIPT REFUSES RATHER THAN IMPROVISES. Bash 3.2 compatible.

set -u
set -o pipefail

if [ "${1:-}" != "" ]; then
  REPO="$1"
else
  REPO=$(git rev-parse --show-toplevel 2>/dev/null)
  [ -n "$REPO" ] || REPO="$HOME/local-coder"
fi
BRANCH="${B12_PROBE_BRANCH:-claude/b12-installedchars-probe}"
PERMISSION_MODE="${B12_PERMISSION_MODE:-acceptEdits}"
OUT_DIR="$HOME/Desktop"
[ -d "$OUT_DIR" ] || OUT_DIR="$HOME"

# The one prompt, byte-identical across all six measured sessions. It must not
# invite a tool call: a tool round trip happens AFTER the first billed request,
# so it would not move the statistic, but a session that did work is not the
# quiet-scratch shape this calibration claims to measure.
PROMPT="Reply with exactly: ok. Do not use any tools."
PROOF_PROMPT="Call mcp__local-coder__status exactly once, then reply: done. Do not call any other tool."

TMP_DIR=""
TMP_MINE=0
ART=""
ART_FINALISED=0
CLEANED=0
START_REF=""

step=0
say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    ok    %s\n' "$1"; }
info() { printf '    ..    %s\n' "$1"; }
warn() { printf '    !!    %s\n' "$1"; }
refuse() {
  printf '\n\033[1mREFUSED\033[0m — %s\n\n' "$1" >&2
  printf 'Nothing was measured. Fix the above and re-run; the script is idempotent.\n' >&2
  exit 1
}
next() { step=$((step + 1)); say "$step. $1"; }

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
  [ "${CLEANED:-0}" = "1" ] && return 0
  CLEANED=1
  # An artifact without its verdict must not survive. The filename carries a
  # per-run time component and creation REFUSES on an existing path, so the
  # only file this can remove is the one THIS run created and never finished.
  if [ "${ART_FINALISED:-0}" = "0" ] && [ -n "${ART:-}" ] && [ -f "$ART" ]; then
    rm -f "$ART"
    printf '    ..    removed an artifact that never got its verdict\n'
  fi
  [ "${TMP_MINE:-0}" = "1" ] && [ -n "${TMP_DIR:-}" ] && rm -rf "$TMP_DIR"
  return 0
}
on_signal() {
  printf '\n\033[1mINTERRUPTED\033[0m — stopping here. Nothing was measured.\n' >&2
  cleanup
  trap - INT TERM EXIT
  kill -"$1" "$$"
}
trap cleanup EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

# ---------------------------------------------------------------------------
next "Tools this needs"

for bin in git node npm claude uuidgen shasum; do
  command -v "$bin" >/dev/null 2>&1 || refuse "\`$bin\` is not on PATH"
done
ok "git, node, npm, claude, uuidgen, shasum present"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) refuse "could not read node's major version (got \"$NODE_MAJOR\")" ;;
esac
[ "$NODE_MAJOR" -ge 18 ] || refuse "node $NODE_MAJOR is too old; package.json requires >= 18"
ok "node $(node -v)"

# EXIT CODE FIRST, THEN SHAPE — a failing `claude --version` must not fill the
# artifact with its own error text.
CLAUDE_VER=$(claude --version 2>/dev/null)
CV_RC=$?
[ $CV_RC -eq 0 ] || refuse "claude --version exited $CV_RC. The version is part of the calibration key and may not be guessed at."
CLAUDE_VER=$(printf '%s' "$CLAUDE_VER" | head -1)
case "$CLAUDE_VER" in
  *[0-9].[0-9]*) : ;;
  *) refuse "claude --version returned \"$CLAUDE_VER\", which does not look like a version" ;;
esac

CLAUDE_BIN=$(command -v claude)
[ -n "$CLAUDE_BIN" ] && [ -e "$CLAUDE_BIN" ] || refuse "could not resolve the claude binary path (got \"$CLAUDE_BIN\")"
CLAUDE_SHA=$(shasum -a 256 "$CLAUDE_BIN" 2>/dev/null | cut -d' ' -f1)
printf '%s' "$CLAUDE_SHA" | grep -qE '^[0-9a-f]{64}$' || refuse "could not sha256 the claude binary at $CLAUDE_BIN (got \"$CLAUDE_SHA\")"
ok "claude $CLAUDE_VER — sha256 $(printf '%s' "$CLAUDE_SHA" | cut -c1-12)…"

# A pin is asserted when the caller declares one; otherwise the values are
# recorded and the artifact says no pin was declared. An absent manifest cannot
# be enforced, but a wrong binary can still be refused by whoever knows it.
if [ -n "${B12_EXPECT_CLAUDE_VERSION:-}" ]; then
  case "$CLAUDE_VER" in
    *"$B12_EXPECT_CLAUDE_VERSION"*) ok "version matches the declared pin $B12_EXPECT_CLAUDE_VERSION" ;;
    *) refuse "binary is $CLAUDE_VER, caller pinned $B12_EXPECT_CLAUDE_VERSION" ;;
  esac
fi
if [ -n "${B12_EXPECT_CLAUDE_SHA256:-}" ]; then
  [ "$CLAUDE_SHA" = "$B12_EXPECT_CLAUDE_SHA256" ] || refuse "binary sha256 $CLAUDE_SHA != pinned $B12_EXPECT_CLAUDE_SHA256"
  ok "binary sha256 matches the declared pin"
fi

# ---------------------------------------------------------------------------
next "Repository"

git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || refuse "no git work tree at $REPO (pass the path as the first argument)"
cd "$REPO" || refuse "cannot enter $REPO"
REPO=$(pwd -P)
[ -n "$REPO" ] || refuse "pwd -P returned nothing"

REPO_NAME=$(node -p "require('$REPO/package.json').name" 2>/dev/null)
[ "$REPO_NAME" = "local-coder-mcp" ] || refuse "$REPO is not this project (package.json name is \"$REPO_NAME\", expected local-coder-mcp)"
ok "repository identified as local-coder-mcp"

git_tracked_changes
[ $GIT_RC -eq 0 ] || refuse "git status failed (exit $GIT_RC); an uninspected tree must not read as a clean one"
if [ -n "$GIT_TRACKED" ]; then
  printf '%s\n' "$GIT_TRACKED" | sed 's/^/      /'
  refuse "the working tree has tracked changes. Commit or stash, then re-run."
fi
ok "tree clean of tracked changes"

START_REF=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse HEAD 2>/dev/null || true)

info "fetching origin/$BRANCH"
git fetch origin "$BRANCH" --quiet || refuse "git fetch failed — is the remote reachable?"
if ! git checkout -q "$BRANCH" 2>/dev/null; then
  if ! git checkout -q -b "$BRANCH" "origin/$BRANCH" 2>/dev/null; then
    HOLDER=$(git worktree list 2>/dev/null | grep "\[$BRANCH\]" | head -1 || true)
    [ -n "$HOLDER" ] && refuse "$BRANCH is already checked out in another worktree: $HOLDER"
    refuse "could not check out $BRANCH"
  fi
fi
# The merge's own failure is preserved, not discarded: `|| true` here would
# leave whatever state the failed merge created to be diagnosed later by a
# SHA comparison that cannot say WHY.
MERGE_OUT=$(git merge --ff-only "origin/$BRANCH" 2>&1)
[ $? -eq 0 ] || { printf '%s\n' "$MERGE_OUT" | sed 's/^/      /'; refuse "could not fast-forward to origin/$BRANCH (output above)"; }

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
[ "$LOCAL_SHA" = "$REMOTE_SHA" ] || refuse "HEAD is $(git rev-parse --short HEAD) but origin/$BRANCH is $(git rev-parse --short origin/$BRANCH) — not at the tip"
ok "at the tip of $BRANCH — $(git rev-parse --short HEAD)"

# ---------------------------------------------------------------------------
next "MCP environment, recorded"

# Both arms run strict, so nothing here can move the delta: whatever the
# account or project carries is either excluded from both arms or lands in
# both identically and cancels. It is still RECORDED — a reader of the
# artifact should see what the machine had, not be told it did not matter and
# have to take that on faith. Best effort: a failing `claude mcp list` is
# itself recorded rather than fatal, since the measurement no longer rests on
# its answer.
MCP_JSON_PRESENT="false"
[ -e "$REPO/.mcp.json" ] && MCP_JSON_PRESENT="true"
MCP_LIST=$(claude mcp list 2>&1)
MCP_LIST_RC=$?
[ $MCP_LIST_RC -eq 0 ] || MCP_LIST="(claude mcp list exited $MCP_LIST_RC) $MCP_LIST"
MCP_LIST=$(printf '%s' "$MCP_LIST" | head -c 8000)
ok "recorded (.mcp.json present: $MCP_JSON_PRESENT; connector roster goes into the artifact)"

# ---------------------------------------------------------------------------
next "Build"

info "npm ci (this takes a minute)"
npm ci --silent >/dev/null 2>&1 || refuse "npm ci failed — run it by hand to see why"
npm run build --silent >/dev/null 2>&1 || refuse "npm run build failed — run it by hand to see why"
[ -f "dist/server.js" ] || refuse "dist/server.js is missing after a build that reported success"
ok "built"

TMP_DIR=$(mktemp -d -t b12ic)
[ -n "$TMP_DIR" ] || refuse "mktemp -d produced no directory"
TMP_MINE=1

MCP_CFG="$TMP_DIR/mcp.json"
cat > "$MCP_CFG" <<JSON
{"mcpServers":{"local-coder":{"type":"stdio","command":"node","args":["$REPO/dist/server.js"],"env":{}}}}
JSON
node -e '
const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const s = c.mcpServers && c.mcpServers["local-coder"];
if (!s || !Array.isArray(s.args) || !require("node:fs").existsSync(s.args[0])) process.exit(1);
' "$MCP_CFG" 2>/dev/null || refuse "the temporary --mcp-config is not a usable config pointing at $REPO/dist/server.js (a quote or backslash in the checkout path will do this)"
MCP_SHA=$(shasum -a 256 "$MCP_CFG" | cut -d' ' -f1)
ok "wrote a temporary --mcp-config (your global Claude config is untouched)"

# ---------------------------------------------------------------------------
next "Environment hash — what must not move between arms"

# Memory and settings enter the system prompt. The pair subtraction cancels
# them only while they are IDENTICAL across the two arms of a replicate, so
# the environment is hashed before every session and any movement refuses.
# Hashed: global and project settings files, the in-repo CLAUDE.md, and this
# cwd's memory directory under ~/.claude/projects (slug = cwd with every
# non-alphanumeric character replaced by '-', the client's own rule).
ENV_JS="$TMP_DIR/envhash.cjs"
cat > "$ENV_JS" <<'JS'
const { readFileSync, readdirSync, existsSync, statSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const repo = process.argv[2];
const slug = repo.replace(/[^A-Za-z0-9]/g, "-");
const memDir = path.join(os.homedir(), ".claude", "projects", slug, "memory");
const files = [
  path.join(os.homedir(), ".claude", "settings.json"),
  path.join(os.homedir(), ".claude", "settings.local.json"),
  path.join(repo, ".claude", "settings.json"),
  path.join(repo, ".claude", "settings.local.json"),
  path.join(repo, "CLAUDE.md"),
];
const walk = (d) => {
  let out = [];
  let entries;
  try { entries = readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else out.push(p);
  }
  return out;
};
if (existsSync(memDir) && statSync(memDir).isDirectory()) files.push(...walk(memDir));
const h = createHash("sha256");
for (const f of files.sort()) {
  let body = null;
  try { body = readFileSync(f); } catch { continue; }
  h.update(f);
  h.update("\u0000");
  h.update(body);
  h.update("\u0000");
}
process.stdout.write(h.digest("hex"));
JS
env_hash() { node "$ENV_JS" "$REPO" 2>/dev/null; }
ENV_HASH_0=$(env_hash)
printf '%s' "$ENV_HASH_0" | grep -qE '^[0-9a-f]{64}$' || refuse "could not hash the environment (settings + CLAUDE.md + memory)"
ok "environment hash $(printf '%s' "$ENV_HASH_0" | cut -c1-12)…"

# ---------------------------------------------------------------------------
next "Per-arm policy blobs — the DUAL calibration-key component"

# See the header: both arms deliver their own blob in the real run, so a probe
# that wants to calibrate a sealing manifest must deliver the SAME blobs, from
# the SAME object store the manifest seals — `git cat-file blob <commit>:<path>`,
# never a working-tree file.
POLICY_REPO="${B12_POLICY_REPO:-}"
POLICY_COMMIT="${B12_POLICY_COMMIT:-}"
POLICY_T_PATH="${B12_POLICY_TREATMENT_PATH:-}"
POLICY_C_PATH="${B12_POLICY_CONTROL_PATH:-}"
POLICY_SET=0
if [ -n "$POLICY_REPO" ] || [ -n "$POLICY_COMMIT" ] || [ -n "$POLICY_T_PATH" ] || [ -n "$POLICY_C_PATH" ]; then
  [ -n "$POLICY_REPO" ] && [ -n "$POLICY_COMMIT" ] && [ -n "$POLICY_T_PATH" ] && [ -n "$POLICY_C_PATH" ] \
    || refuse "partial policy declaration — set all of B12_POLICY_REPO, B12_POLICY_COMMIT, B12_POLICY_TREATMENT_PATH, B12_POLICY_CONTROL_PATH, or none"
  POLICY_SET=1
fi
POLICY_T_SHA=""
POLICY_C_SHA=""
TREATMENT_POLICY=""
CONTROL_POLICY=""
policy_blob_sha() {
  # $1 path inside the policy repo. Bytes from the object store, hashed as bytes.
  git -C "$POLICY_REPO" cat-file blob "$POLICY_COMMIT:$1" 2>/dev/null | shasum -a 256 | cut -d' ' -f1
}
if [ $POLICY_SET -eq 1 ]; then
  case "$POLICY_COMMIT" in
    ????????????????????????????????????????) : ;;
    *) refuse "B12_POLICY_COMMIT must be the full 40-hex sealed commit (got \"$POLICY_COMMIT\")" ;;
  esac
  [ -d "$POLICY_REPO" ] || refuse "B12_POLICY_REPO $POLICY_REPO does not exist — transport the hashed policy bundle and clone it first"
  POLICY_SHALLOW=$(git -C "$POLICY_REPO" rev-parse --is-shallow-repository 2>/dev/null)
  [ "$POLICY_SHALLOW" = "false" ] || refuse "the policy repo at $POLICY_REPO is shallow or not a git repository — an object store that cannot prove its history cannot prove the sealed commit"
  git -C "$POLICY_REPO" cat-file -e "$POLICY_COMMIT^{commit}" 2>/dev/null || refuse "sealed commit $POLICY_COMMIT is not reachable in $POLICY_REPO"
  git -C "$POLICY_REPO" cat-file -e "$POLICY_COMMIT:$POLICY_T_PATH" 2>/dev/null || refuse "$POLICY_COMMIT:$POLICY_T_PATH is not readable in $POLICY_REPO"
  git -C "$POLICY_REPO" cat-file -e "$POLICY_COMMIT:$POLICY_C_PATH" 2>/dev/null || refuse "$POLICY_COMMIT:$POLICY_C_PATH is not readable in $POLICY_REPO"
  # Content EXACT, trailing newlines preserved: bare $(cat) strips them, and
  # the run harness (b12-run.mjs) delivers the blob byte-exactly — a probe
  # that delivered different bytes would calibrate a different system prompt.
  TREATMENT_POLICY=$(git -C "$POLICY_REPO" cat-file blob "$POLICY_COMMIT:$POLICY_T_PATH" 2>/dev/null; printf x)
  TREATMENT_POLICY=${TREATMENT_POLICY%x}
  CONTROL_POLICY=$(git -C "$POLICY_REPO" cat-file blob "$POLICY_COMMIT:$POLICY_C_PATH" 2>/dev/null; printf x)
  CONTROL_POLICY=${CONTROL_POLICY%x}
  POLICY_T_SHA=$(policy_blob_sha "$POLICY_T_PATH")
  POLICY_C_SHA=$(policy_blob_sha "$POLICY_C_PATH")
  printf '%s' "$POLICY_T_SHA" | grep -qE '^[0-9a-f]{64}$' || refuse "could not hash the treatment policy blob"
  printf '%s' "$POLICY_C_SHA" | grep -qE '^[0-9a-f]{64}$' || refuse "could not hash the control policy blob"
  ok "policy blobs resolved — treatment $(printf '%s' "$POLICY_T_SHA" | cut -c1-12)…, control $(printf '%s' "$POLICY_C_SHA" | cut -c1-12)…"
else
  info "no policy blobs declared — EXPLORATORY probe; the dual key records nulls and cannot calibrate a registrable manifest"
fi

assert_env_still() {
  # $1 names the boundary, for the refusal.
  local now
  now=$(env_hash)
  [ "$now" = "$ENV_HASH_0" ] || refuse "the environment (settings/CLAUDE.md/memory) moved $1. The pair subtraction cannot cancel a change between arms; the probe is void. Re-run."
}

# ---------------------------------------------------------------------------
next "Proof session — the treatment installation actually works"

# A failed MCP initialization would masquerade as a genuine zero delta: claude
# answers the prompt, exits 0, and the schemas were simply never resident. One
# proof session OUTSIDE the measured six must show a tool_use of
# mcp__local-coder__status in its transcript — the tool cannot be called
# unless the server registered it. status is read-only and does not need LM
# Studio to answer.
USAGE_JS="$TMP_DIR/usage.cjs"
cat > "$USAGE_JS" <<'JS'
// ONE extractor, ONE admission rule, exits enumerated so the shell refuses by
// NAME: 2 transcript missing · 4 no billed request · 5 malformed usage
// fields. The rule mirrors the meter's: an ASSISTANT record carrying a
// requestId and message.usage, with isApiErrorMessage !== true — PREMISES.md
// records that synthetic API-error records carry real request ids and
// all-zero usage, and admitting one here would measure an outage, not an
// installation.
//
// THE STATISTIC IS THE TOTAL PROMPT SIZE: input + cacheCreation + cacheRead.
// Every prompt token is billed in exactly one of those three classes, so the
// sum is INVARIANT to cache state — and cache state cannot be controlled:
// prompt cache is prefix-keyed ACROSS sessions, measured on this machine as
// cacheRead=22099 on a fresh session id run right after the proof session.
// The earlier input+cacheWrite form with a cacheRead-must-be-zero veto was
// unsatisfiable back-to-back inside the TTL; the amendment is dated in
// PREMISES.md § B12, made before any delta existed.
const { readdirSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const [sessionId, outPath, arm, rep] = process.argv.slice(2);
const root = path.join(os.homedir(), ".claude", "projects");
let transcript = null;
const walk = (d, depth) => {
  if (depth > 3 || transcript !== null) return;
  let entries;
  try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === sessionId + ".jsonl") { transcript = p; return; }
  }
};
if (existsSync(root)) walk(root, 0);
if (!transcript) process.exit(2);
let first = null;
let firstRaw = null;
const tools = [];
const intOk = (n) => Number.isInteger(n) && n >= 0;
for (const line of readFileSync(transcript, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let rec;
  try { rec = JSON.parse(line); } catch { continue; }
  const content = rec && rec.message && rec.message.content;
  if (Array.isArray(content)) {
    for (const c of content) if (c && c.type === "tool_use" && typeof c.name === "string") tools.push(c.name);
  }
  if (
    first === null &&
    rec &&
    rec.type === "assistant" &&
    rec.isApiErrorMessage !== true &&
    rec.requestId &&
    rec.message &&
    rec.message.usage
  ) {
    const u = rec.message.usage;
    first = {
      requestId: rec.requestId,
      model: (rec.message && rec.message.model) || null,
      input: u.input_tokens ?? 0,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
      cacheCreation5m: (u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens) ?? null,
      cacheCreation1h: (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) ?? null,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    };
    firstRaw = line;
  }
}
if (first === null) process.exit(4);
if (!intOk(first.input) || !intOk(first.cacheCreation) || !intOk(first.cacheRead)) {
  process.stderr.write(`non-integer usage fields: input=${first.input} cacheCreation=${first.cacheCreation} cacheRead=${first.cacheRead}`);
  process.exit(5);
}
const promptTokens = first.input + first.cacheCreation + first.cacheRead;
const out = { arm, replicate: Number(rep), sessionId, transcript, toolsCalled: tools, first, firstRecordRaw: firstRaw, promptTokens };
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
process.stdout.write(`tokens=${promptTokens} (in=${first.input} cw=${first.cacheCreation} cr=${first.cacheRead}) model=${first.model ?? "?"} tools=${tools.length}\n`);
JS

PROOF_SID=$(uuidgen | tr 'A-Z' 'a-z')
case "$PROOF_SID" in
  ????????-????-????-????-????????????) : ;;
  *) refuse "uuidgen did not produce a uuid (got \"$PROOF_SID\")" ;;
esac
assert_env_still "before the proof session"
info "proof session $PROOF_SID"
PROOF_LOG="$TMP_DIR/claude-proof.log"
DISABLE_AUTOUPDATER=1 claude --print \
  --session-id "$PROOF_SID" \
  --strict-mcp-config \
  --mcp-config "$MCP_CFG" \
  --allowed-tools "mcp__local-coder__status" \
  --permission-mode "$PERMISSION_MODE" \
  --output-format json \
  -- \
  "$PROOF_PROMPT" >"$PROOF_LOG" 2>&1
PROOF_RC=$?
if [ $PROOF_RC -ne 0 ]; then
  tail -20 "$PROOF_LOG" 2>/dev/null | sed 's/^/      /'
  refuse "the proof session exited $PROOF_RC. Without it the six measured sessions could be measuring a server that never initialized."
fi
node "$USAGE_JS" "$PROOF_SID" "$TMP_DIR/proof.json" proof 0 >/dev/null 2>"$TMP_DIR/proof.err"
PROOF_X_RC=$?
[ $PROOF_X_RC -eq 0 ] || refuse "could not read the proof session back (extractor exit $PROOF_X_RC)"
case "$(cat "$TMP_DIR/proof.json" 2>/dev/null)" in
  *'"mcp__local-coder__status"'*) ok "the treatment shape registers this server's tools (status was called)" ;;
  *) refuse "the proof session never called mcp__local-coder__status, so the MCP install cannot be shown to work. If a permission prompt blocked it, re-run with B12_PERMISSION_MODE=bypassPermissions." ;;
esac

# ---------------------------------------------------------------------------
next "Six sessions: 3 replicates x (treatment, control)"

run_arm() {
  # $1 replicate, $2 arm. Mirrors observe()'s arm flags and option order: a
  # NON-VARIADIC option sits immediately before the prompt and `--` ends
  # option parsing — the variadic-swallow defect is documented in b12-run.mjs
  # and this shape is the guard.
  local REP="$1" ARM="$2" SID LOG RC PROBE_OUT
  SID=$(uuidgen | tr 'A-Z' 'a-z')
  case "$SID" in
    ????????-????-????-????-????????????) : ;;
    *) refuse "uuidgen did not produce a uuid (got \"$SID\")" ;;
  esac
  assert_env_still "before replicate $REP $ARM"
  LOG="$TMP_DIR/claude-r${REP}-${ARM}.log"
  info "replicate $REP, $ARM — session $SID"
  # Four explicit blocks, not a spliced array: the argv IS the measurement's
  # shape, and each block mirrors observe()'s order — the per-arm policy (a
  # single-argument option) sits before `--output-format`, which stays the
  # NON-VARIADIC guard immediately ahead of `--` and the prompt.
  if [ "$ARM" = "treatment" ]; then
    if [ $POLICY_SET -eq 1 ]; then
      DISABLE_AUTOUPDATER=1 claude --print \
        --session-id "$SID" \
        --strict-mcp-config \
        --mcp-config "$MCP_CFG" \
        --append-system-prompt "$TREATMENT_POLICY" \
        --output-format json \
        -- \
        "$PROMPT" >"$LOG" 2>&1
      RC=$?
    else
      DISABLE_AUTOUPDATER=1 claude --print \
        --session-id "$SID" \
        --strict-mcp-config \
        --mcp-config "$MCP_CFG" \
        --output-format json \
        -- \
        "$PROMPT" >"$LOG" 2>&1
      RC=$?
    fi
  else
    if [ $POLICY_SET -eq 1 ]; then
      DISABLE_AUTOUPDATER=1 claude --print \
        --session-id "$SID" \
        --strict-mcp-config \
        --append-system-prompt "$CONTROL_POLICY" \
        --output-format json \
        -- \
        "$PROMPT" >"$LOG" 2>&1
      RC=$?
    else
      DISABLE_AUTOUPDATER=1 claude --print \
        --session-id "$SID" \
        --strict-mcp-config \
        --output-format json \
        -- \
        "$PROMPT" >"$LOG" 2>&1
      RC=$?
    fi
  fi
  if [ $RC -ne 0 ]; then
    tail -20 "$LOG" 2>/dev/null | sed 's/^/      /'
    refuse "claude exited $RC on replicate $REP $ARM. A failed arm is not a replicate."
  fi
  PROBE_OUT=$(node "$USAGE_JS" "$SID" "$TMP_DIR/rep${REP}-${ARM}.json" "$ARM" "$REP" 2>"$TMP_DIR/usage.err")
  case $? in
    0) ok "replicate $REP $ARM — $PROBE_OUT" ;;
    2) refuse "claude wrote no transcript for $SID (replicate $REP $ARM). The statistic lives in the transcript, so there is nothing to measure." ;;
    4) refuse "no billed (assistant, non-apiError) request found in the transcript of replicate $REP $ARM" ;;
    5) refuse "malformed usage on replicate $REP $ARM: $(cat "$TMP_DIR/usage.err")" ;;
    *) refuse "the usage extractor failed unexpectedly on replicate $REP $ARM" ;;
  esac
}

for REP in 1 2 3; do
  run_arm "$REP" treatment
  run_arm "$REP" control
done

# THE CALIBRATION KEY MUST NOT MOVE MID-PROBE — pre-declared, and checked for
# EVERY component this machine can see: binary version, binary hash, the
# --mcp-config bytes, and the environment hash.
CLAUDE_VER_AFTER=$(claude --version 2>/dev/null | head -1)
CLAUDE_SHA_AFTER=$(shasum -a 256 "$CLAUDE_BIN" 2>/dev/null | cut -d' ' -f1)
MCP_SHA_AFTER=$(shasum -a 256 "$MCP_CFG" | cut -d' ' -f1)
[ "$CLAUDE_VER_AFTER" = "$CLAUDE_VER" ] || refuse "claude --version changed mid-probe (\"$CLAUDE_VER\" -> \"$CLAUDE_VER_AFTER\"). The key moved; the probe is void. Re-run."
[ "$CLAUDE_SHA_AFTER" = "$CLAUDE_SHA" ] || refuse "the claude binary's sha256 changed mid-probe. The key moved; the probe is void. Re-run."
[ "$MCP_SHA_AFTER" = "$MCP_SHA" ] || refuse "the --mcp-config bytes changed mid-probe. The key moved; the probe is void. Re-run."
if [ $POLICY_SET -eq 1 ]; then
  # Git objects are immutable, so movement here means the OBJECT STORE moved
  # under the key — repo swapped, replaced or pruned mid-probe.
  POLICY_T_SHA_AFTER=$(policy_blob_sha "$POLICY_T_PATH")
  POLICY_C_SHA_AFTER=$(policy_blob_sha "$POLICY_C_PATH")
  [ "$POLICY_T_SHA_AFTER" = "$POLICY_T_SHA" ] || refuse "the treatment policy blob's bytes changed mid-probe. The key moved; the probe is void. Re-run."
  [ "$POLICY_C_SHA_AFTER" = "$POLICY_C_SHA" ] || refuse "the control policy blob's bytes changed mid-probe. The key moved; the probe is void. Re-run."
fi
assert_env_still "after the last session"
ok "binary, mcp-config, policy blobs and environment unchanged across the probe"

# ---------------------------------------------------------------------------
next "Verdict and artifact"

# ONE stamp, taken once, names the file AND the run id — a probe crossing UTC
# midnight must not carry two dates. The time component makes each probe's
# identity unique; an existing path is a REFUSAL, never an overwrite: two
# probes on the same day and commit are two measurements, and evidence is
# append-only.
STAMP_DATE=$(date -u +%Y-%m-%d)
STAMP_TIME=$(date -u +%H%M%S)
SHORT=$(printf '%s' "$LOCAL_SHA" | cut -c1-7)
[ -n "$STAMP_DATE" ] && [ -n "$STAMP_TIME" ] && [ -n "$SHORT" ] || refuse "could not build the artifact identity"
ART="$REPO/evidence/$STAMP_DATE-mac-b12-installedchars-$SHORT-$STAMP_TIME.probe.json"
mkdir -p "$REPO/evidence" || refuse "could not create $REPO/evidence"
[ -e "$ART" ] && refuse "$ART already exists. A prior probe's evidence is not this run's to delete."

VERDICT_JS="$TMP_DIR/verdict.cjs"
cat > "$VERDICT_JS" <<'JS'
// The verdict is computed in ONE place, from the six files the extractor
// wrote, and the artifact carries everything a reader needs to re-adjudicate:
// the raw first-request records verbatim, the deltas, the calibration key,
// and — as `measurementsRow` — the MEASUREMENTS.jsonl line to be appended
// VERBATIM by the machine that commits, with the append command beside it.
const { readFileSync, writeFileSync } = require("node:fs");
const e = process.env;
const art = process.argv[2];
const tmp = process.argv[3];
const reps = [];
for (let r = 1; r <= 3; r++) {
  const t = JSON.parse(readFileSync(`${tmp}/rep${r}-treatment.json`, "utf8"));
  const c = JSON.parse(readFileSync(`${tmp}/rep${r}-control.json`, "utf8"));
  if (t.first.model !== c.first.model) {
    console.error(`replicate ${r}: treatment ran on ${t.first.model}, control on ${c.first.model} — the arms are not paired`);
    process.exit(1);
  }
  reps.push({ replicate: r, treatment: t, control: c, deltaTokens: t.promptTokens - c.promptTokens });
}
const proof = JSON.parse(readFileSync(`${tmp}/proof.json`, "utf8"));
const deltas = reps.map((r) => r.deltaTokens);
const sustained = deltas.every((d) => Number.isFinite(d)) && deltas.every((d) => d === deltas[0]) && deltas[0] >= 0;
const deltaTokens = sustained ? deltas[0] : null;
// The adapter, declared as an adapter in the pre-declaration: the measurement
// is native in tokens; the shipped interface divides chars by the frozen 3.7,
// so chars := tokens x 3.7 makes the divisor cancel exactly. Integer tokens x
// 3.7 has at most one decimal; nothing is rounded away.
const installedChars = sustained ? Math.round(deltaTokens * 3.7 * 10) / 10 : null;
const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const runId = `${e.B12_STAMP_DATE}-mac-b12-installedchars-${e.B12_SHORT}-${e.B12_STAMP_TIME}`;
const row = sustained
  ? {
      run_id: runId, ts, machine: "mac-01",
      metric: "installed_system_prompt_token_delta_on_pinned_binary",
      value: deltaTokens, unit: "tokens", premise: "B12",
      method: `scripts/b12-installedchars-probe-mac.sh at ${e.B12_SHA_SHORT} on claude ${e.B12_CLAUDE_VER} (binary sha256 ${e.B12_CLAUDE_SHA.slice(0, 12)}...); proof session showed mcp__local-coder__status callable; 3 replicates x (treatment --strict-mcp-config --mcp-config, control --strict-mcp-config), first billed assistant non-apiError request, TOTAL prompt tokens (input+cacheWrite+cacheRead, cache-invariant), treatment minus control; artifact ${e.B12_ART_NAME}`,
      note: `DELTAS ${deltas.join(", ")} — IDENTICAL, SUSTAINED. installedChars adapter: ${installedChars} chars (tokens x 3.7, divisor cancels). Calibration key: binary sha256 ${e.B12_CLAUDE_SHA.slice(0, 12)}... x arm x mcp-config ${e.B12_MCP_SHA.slice(0, 12)}... x env ${e.B12_ENV_HASH.slice(0, 12)}... x policy blobs ${e.B12_POLICY_T_SHA ? `treatment ${e.B12_POLICY_T_SHA.slice(0, 12)}... control ${e.B12_POLICY_C_SHA.slice(0, 12)}... (delivered per arm via --append-system-prompt)` : "NONE (exploratory — the value is re-taken when blobs are sealed, and when a manifest pins extraArgs or its own MCP config)"}. Branch: the F24 harness pass proceeds.`,
    }
  : {
      run_id: runId, ts, machine: "mac-01",
      metric: "installedchars_probe_delta_spread",
      value: Math.max(...deltas) - Math.min(...deltas), unit: "tokens", premise: "B12",
      method: `scripts/b12-installedchars-probe-mac.sh at ${e.B12_SHA_SHORT} on claude ${e.B12_CLAUDE_VER}; 3 replicates x 2 arms, first billed assistant non-apiError request, TOTAL prompt tokens (input+cacheWrite+cacheRead, cache-invariant); artifact ${e.B12_ART_NAME}`,
      note: `DELTAS ${deltas.join(", ")} — NOT SUSTAINED (pre-declared tolerance is zero${deltas.some((d) => d < 0) ? "; a negative delta is present" : ""}). PREMISES.md § B12 fixes the branch: retract and re-register, with this probe as the recorded cause.`,
    };
const rowLine = JSON.stringify(row);
const artifact = {
  document: "installedChars paired probe — the measurement PREMISES.md § B12 pre-declared",
  runId, ts,
  context: {
    commit: e.B12_SHA, branch: e.B12_BRANCH, host: "mac",
    claudeVersion: e.B12_CLAUDE_VER, claudeBinaryPath: e.B12_CLAUDE_BIN,
    claudeBinarySha256: e.B12_CLAUDE_SHA, mcpConfigSha256: e.B12_MCP_SHA,
    environmentSha256: e.B12_ENV_HASH,
    declaredPin: {
      version: e.B12_EXPECT_VER || null,
      binarySha256: e.B12_EXPECT_SHA || null,
      note: "asserted when set; no manifest exists yet, so there is no sealed pin to consume",
    },
    // DUAL — both arms deliver their own blob via --append-system-prompt in
    // the real run, so both hashes are calibration-key components. Nulls name
    // an EXPLORATORY probe, which cannot calibrate a sealing manifest.
    policyBlobSha256s: {
      treatment: e.B12_POLICY_T_SHA || null,
      control: e.B12_POLICY_C_SHA || null,
    },
    policyBlobProvenance: e.B12_POLICY_T_SHA
      ? { repo: e.B12_POLICY_REPO, commit: e.B12_POLICY_COMMIT, treatmentPath: e.B12_POLICY_T_PATH, controlPath: e.B12_POLICY_C_PATH }
      : null,
    policyBlobNote: e.B12_POLICY_T_SHA
      ? "both arms delivered their sealed blob via --append-system-prompt, read from the policy repo's object store (git cat-file blob <commit>:<path>)"
      : "EXPLORATORY — no policy blobs delivered; every registrable manifest seals blobs, so this probe must be re-taken under them",
    cwd: e.B12_REPO, prompt: e.B12_PROMPT, proofPrompt: e.B12_PROOF_PROMPT,
    argvShape: {
      treatment: `claude --print --session-id <id> --strict-mcp-config --mcp-config <cfg>${e.B12_POLICY_T_SHA ? " --append-system-prompt <treatment policy>" : ""} --output-format json -- <prompt>`,
      control: `claude --print --session-id <id> --strict-mcp-config${e.B12_POLICY_C_SHA ? " --append-system-prompt <control policy>" : ""} --output-format json -- <prompt>`,
      note: "mirrors observe()'s arm flags and option order in scripts/b12-run.mjs (both arms strict since 2026-08-08 — the first probe run found ~30 claude.ai account connectors on the work Mac, unremovable by claude mcp remove; strict on both makes them arm-invariant: excluded from both, or present in both and cancelled by the paired subtraction). NOT byte-for-byte — no manifest exists, so no pinned.extraArgs and no sealed MCP config.",
    },
    mcpJsonPresentInClone: e.B12_MCP_JSON_PRESENT === "true",
    mcpList: e.B12_MCP_LIST,
  },
  preDeclaration: "PREMISES.md § B12, registered before this probe ran; k = 3 and tolerance 0 are CHOSEN constants, labelled there",
  proofSession: proof,
  replicates: reps,
  deltasTokens: deltas,
  sustained,
  deltaTokens,
  installedCharsAdapter: installedChars,
  verdictBranch: sustained ? "repair-proceeds (F24 harness pass)" : "retract-and-re-register (probe is the recorded cause)",
  measurementsRow: rowLine,
  measurementsRowTransport:
    "ts was read from this machine's clock by the command that authored the row; the committing machine transports the bytes VERBATIM and must refuse if the run_id already exists. Append command (run from the repo root on the committing machine): node -e \"const fs=require('fs');const a=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const row=a.measurementsRow;const id=JSON.parse(row).run_id;const m=fs.readFileSync('MEASUREMENTS.jsonl','utf8');if(m.includes(id)){console.error('run_id already present: '+id);process.exit(1);}fs.appendFileSync('MEASUREMENTS.jsonl',row+'\\n');console.log('appended '+id);\" <this artifact file>",
};
writeFileSync(art, JSON.stringify(artifact, null, 2) + "\n");
const back = JSON.parse(readFileSync(art, "utf8"));
if (!back.context || !back.context.commit || typeof back.sustained !== "boolean" || !back.measurementsRow) {
  console.error("provenance did not land in " + art);
  process.exit(1);
}
process.stdout.write(`B12-PROBE-OK sustained=${back.sustained} deltas=${deltas.join(",")}\n`);
JS
VERDICT_OUT=$(B12_SHA="$LOCAL_SHA" B12_SHA_SHORT="$(git rev-parse --short HEAD)" B12_SHORT="$SHORT" \
  B12_STAMP_DATE="$STAMP_DATE" B12_STAMP_TIME="$STAMP_TIME" \
  B12_BRANCH="$BRANCH" B12_CLAUDE_VER="$CLAUDE_VER" B12_CLAUDE_BIN="$CLAUDE_BIN" \
  B12_CLAUDE_SHA="$CLAUDE_SHA" B12_MCP_SHA="$MCP_SHA" B12_ENV_HASH="$ENV_HASH_0" B12_REPO="$REPO" \
  B12_PROMPT="$PROMPT" B12_PROOF_PROMPT="$PROOF_PROMPT" B12_MCP_LIST="$MCP_LIST" \
  B12_MCP_JSON_PRESENT="$MCP_JSON_PRESENT" \
  B12_EXPECT_VER="${B12_EXPECT_CLAUDE_VERSION:-}" B12_EXPECT_SHA="${B12_EXPECT_CLAUDE_SHA256:-}" \
  B12_POLICY_REPO="$POLICY_REPO" B12_POLICY_COMMIT="$POLICY_COMMIT" \
  B12_POLICY_T_PATH="$POLICY_T_PATH" B12_POLICY_C_PATH="$POLICY_C_PATH" \
  B12_POLICY_T_SHA="$POLICY_T_SHA" B12_POLICY_C_SHA="$POLICY_C_SHA" \
  B12_ART_NAME="$(basename "$ART")" \
  node "$VERDICT_JS" "$ART" "$TMP_DIR" 2>&1)
VERDICT_RC=$?
# Producer exit zero AND an exact sentinel on its own line — a failed node
# whose stderr happens to contain the magic words must not be read as success.
if [ $VERDICT_RC -ne 0 ] || ! printf '%s\n' "$VERDICT_OUT" | grep -qE '^B12-PROBE-OK sustained=(true|false) deltas=-?[0-9]+,-?[0-9]+,-?[0-9]+$'; then
  printf '%s\n' "$VERDICT_OUT" | sed 's/^/      /' >&2
  refuse "could not compute the verdict or write the artifact (node exit $VERDICT_RC); it was removed rather than left half-written"
fi
ART_FINALISED=1

COPIED=0
if cp "$ART" "$OUT_DIR/" 2>/dev/null; then
  COPIED=1
  ok "copied to $OUT_DIR/$(basename "$ART")"
else
  warn "could not copy to $OUT_DIR — the copy in evidence/ is canonical; send that one"
fi

# ---------------------------------------------------------------------------
say "Result"

case "$VERDICT_OUT" in
  *"sustained=true"*)
    printf '    SUSTAINED — the three deltas agree. The repair proceeds: the F24\n'
    printf '    harness pass wires this value per observation, and it is re-taken\n'
    printf '    whenever any calibration-key component changes (binary, MCP config,\n'
    printf '    policy blobs, environment).\n'
    ;;
  *)
    printf '    NOT SUSTAINED — the deltas disagree or one is negative. The branch\n'
    printf '    was fixed before this run: retract and re-register, with this\n'
    printf '    artifact as the recorded cause. That is a real answer, not a failure.\n'
    ;;
esac

printf '\n    artifact: %s\n' "$ART"
[ "$COPIED" = "1" ] && printf '    also at:  %s\n' "$OUT_DIR/$(basename "$ART")"
printf '\n    Send that one file back. It carries the proof session, the six\n'
printf '    measured sessions with their RAW first-request records, the deltas,\n'
printf '    the calibration key, and — inside it — `measurementsRow` plus the\n'
printf '    exact append command for the machine that commits. This machine\n'
printf '    cannot push, and MEASUREMENTS.jsonl here was deliberately not\n'
printf '    touched, so the next pull will not conflict.\n\n'
printf '    Before the next pull on this Mac, remove the local artifact copy so\n'
printf '    the committed one can land:  rm "%s"\n\n' "$ART"

NOW_REF=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null || true)
if [ -n "$START_REF" ] && [ "$START_REF" != "$NOW_REF" ]; then
  printf '    Your clone is now on %s. You were on %s:\n' "$NOW_REF" "$START_REF"
  printf '        git -C %s checkout %s\n\n' "$REPO" "$START_REF"
fi

exit 0
