#!/usr/bin/env bash
#
# b12-truncationcap-probe-mac.sh — measures the CLIENT truncation cap of the
# pinned Claude Code binary, in CHARACTERS, on the Mac.
#
#   bash scripts/b12-truncationcap-probe-mac.sh [/path/to/clone]
#
# WHAT IT MEASURES. `clientTruncationCap` — the length at which Claude Code
# truncates a tool result before storing it in the transcript. The cap is in
# CHARACTERS, not bytes or tokens: the meter's frozen divisor consumes chars
# (`rates.ts`), and the gate measures `raw.length` on the string it returns
# (`gate.ts`) — so the probe must measure the same unit or calibrate nothing.
# `voidConditions` 8 voids a run "if no cap was measured for the version that
# ran"; this artifact is that measurement, and the manifest seals it as
# `pinned.clientTruncationCap` beside the version and binary sha it belongs to.
#
# HOW. Each replicate is one fresh `--print` session whose prompt pins ONE
# exact Bash command: a generator that prints an 80,000-char ASCII sentinel
# (1,000 lines x 80 chars, every line self-identifying). The transcript is
# then read back and the STORED tool result measured. Hardened, each clause a
# named refusal rather than a hope:
#   - exactly ONE Bash tool_use in the whole transcript, its `input.command`
#     byte-identical to the pinned generator — a session that ran anything
#     else measured something else;
#   - the tool_result is found by its `tool_use_id` LINK to that tool_use,
#     never by position;
#   - the measured string is `toolUseResult.stdout` — the STRING the client
#     stored — never a re-serialized wrapper, whose braces and escapes would
#     inflate the count (the wrapper's size is recorded BESIDE the number so
#     a reader can see the distinction, not take it on faith);
#   - `stdoutChars === utf8Bytes` — the sentinel is pure ASCII, so any
#     non-ASCII byte in the stored copy is decoration (an ellipsis, a marker)
#     and REFUSES;
#   - the stored stdout must be a CONTIGUOUS SLICE of the sentinel — any
#     inserted text (truncation banners, elision markers) REFUSES, because a
#     cap measured over decoration is not the cap;
#   - `0 < stdoutChars < 80000` in EVERY replicate — 80,000 means the client
#     did not truncate (the cap was NOT measured, only bounded from below)
#     and 0 means breakage; BOTH refuse the probe rather than record a lie;
#   - 3 replicates, all three stored lengths IDENTICAL — a cap that moves
#     between sessions is not a constant the meter may divide by.
#
# WHAT IT CHANGES, stated plainly:
#   - it writes ONE artifact into evidence/ (REFUSING if the path exists —
#     never deleting a prior probe) and copies it to $HOME/Desktop;
#   - it does NOT touch MEASUREMENTS.jsonl: the row it earns is carried
#     INSIDE the artifact (`measurementsRow`), with the exact append command
#     for the machine that commits — this one cannot push;
#   - the 3 sessions run in a THROWAWAY cwd under the temp dir, so their
#     transcripts land in that cwd's slug — calibration scratch, outside any
#     project slug a run would snapshot; no run is registered, so no
#     contamination clause attaches.
#
# Optional pins, asserted when set and recorded either way:
#   B12_EXPECT_CLAUDE_VERSION  substring the version must contain
#   B12_EXPECT_CLAUDE_SHA256   exact sha256 of the claude binary
#   B12_PERMISSION_MODE        default acceptEdits; the Bash tool itself is
#                              pre-approved via --allowed-tools
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
PERMISSION_MODE="${B12_PERMISSION_MODE:-acceptEdits}"
OUT_DIR="$HOME/Desktop"
[ -d "$OUT_DIR" ] || OUT_DIR="$HOME"

TMP_DIR=""
TMP_MINE=0
ART=""
ART_FINALISED=0
CLEANED=0

step=0
say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    ok    %s\n' "$1"; }
info() { printf '    ..    %s\n' "$1"; }
refuse() {
  printf '\n\033[1mREFUSED\033[0m — %s\n\n' "$1" >&2
  printf 'Nothing was measured. Fix the above and re-run; the script is idempotent.\n' >&2
  exit 1
}
next() { step=$((step + 1)); say "$step. $1"; }

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

for bin in git node claude uuidgen shasum; do
  command -v "$bin" >/dev/null 2>&1 || refuse "\`$bin\` is not on PATH"
done
ok "git, node, claude, uuidgen, shasum present"

# ---------------------------------------------------------------------------
next "The binary the cap belongs to"

# EXIT CODE FIRST, THEN SHAPE — a failing `claude --version` must not fill the
# artifact with its own error text.
CLAUDE_VER=$(claude --version 2>/dev/null)
CV_RC=$?
[ $CV_RC -eq 0 ] || refuse "claude --version exited $CV_RC. The cap is measured FOR a version (voidConditions 8) and the version may not be guessed at."
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

if [ -n "${B12_EXPECT_CLAUDE_VERSION:-}" ]; then
  case "$CLAUDE_VER" in
    *"$B12_EXPECT_CLAUDE_VERSION"*) ok "version matches the declared pin $B12_EXPECT_CLAUDE_VERSION" ;;
    *) refuse "binary is $CLAUDE_VER, caller pinned $B12_EXPECT_CLAUDE_VERSION" ;;
  esac
fi
if [ -n "${B12_EXPECT_CLAUDE_SHA256:-}" ]; then
  [ "$CLAUDE_SHA" = "$B12_EXPECT_CLAUDE_SHA256" ] || refuse "binary sha256 does not match the declared pin"
  ok "binary sha256 matches the declared pin"
fi

# ---------------------------------------------------------------------------
next "The repository the evidence lands in"

[ -d "$REPO" ] || refuse "$REPO does not exist"
cd "$REPO" || refuse "could not cd into $REPO"
[ -f "package.json" ] || refuse "$REPO has no package.json — is this the clone?"
REPO_NAME=$(node -p 'require("./package.json").name' 2>/dev/null)
[ "$REPO_NAME" = "local-coder-mcp" ] || refuse "$REPO is not this project (package.json name is \"$REPO_NAME\", expected local-coder-mcp)"
LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null)
case "$LOCAL_SHA" in
  ????????????????????????????????????????) : ;;
  *) refuse "could not read HEAD as a commit sha (got \"$LOCAL_SHA\")" ;;
esac
# The committed row will say "scripts/b12-truncationcap-probe-mac.sh at
# <commit>" — so the script that runs must BE that commit's copy, or the
# provenance line is a lie the reader cannot catch.
SELF_REL="scripts/b12-truncationcap-probe-mac.sh"
if [ -f "$SELF_REL" ]; then
  SELF_HEAD=$(git rev-parse "HEAD:$SELF_REL" 2>/dev/null)
  SELF_DISK=$(git hash-object -- "$SELF_REL" 2>/dev/null)
  [ -n "$SELF_HEAD" ] && [ "$SELF_HEAD" = "$SELF_DISK" ] \
    || refuse "$SELF_REL on disk differs from HEAD's copy — commit (or check out) the script before it signs a provenance line with this commit"
else
  refuse "$SELF_REL is not in the clone — run the committed copy, not a loose one"
fi
ok "repository identified — HEAD $(git rev-parse --short HEAD), script matches HEAD"

TMP_DIR=$(mktemp -d -t b12cap)
[ -n "$TMP_DIR" ] || refuse "mktemp -d produced no directory"
TMP_MINE=1
SESS_CWD="$TMP_DIR/session-cwd"
mkdir -p "$SESS_CWD" || refuse "could not create the throwaway session cwd"

# ---------------------------------------------------------------------------
next "The sentinel"

# 1,000 lines x 80 chars (79 + newline) = 80,000 chars, every byte ASCII,
# every line self-identifying — so a stored copy can be checked to be a
# CONTIGUOUS SLICE of it and nothing else. The generator is the ONE command
# the sessions are allowed to run, pinned byte-for-byte.
SENTINEL_CMD=$(cat <<'CMD'
node -e "const l=[];for(let i=0;i<1000;i++)l.push('B12CAPSENTINEL '+String(i).padStart(4,'0')+' '+'x'.repeat(59));process.stdout.write(l.join('\n')+'\n')"
CMD
)
SENTINEL_CHECK=$(node -e "const l=[];for(let i=0;i<1000;i++)l.push('B12CAPSENTINEL '+String(i).padStart(4,'0')+' '+'x'.repeat(59));const s=l.join('\n')+'\n';if(s.length!==80000||Buffer.byteLength(s,'utf8')!==80000)process.exit(1);process.stdout.write(require('node:crypto').createHash('sha256').update(s,'utf8').digest('hex'))") \
  || refuse "the sentinel generator does not produce exactly 80,000 ASCII chars on THIS machine's node — the measurement premise fails before any session"
printf '%s' "$SENTINEL_CHECK" | grep -qE '^[0-9a-f]{64}$' || refuse "could not hash the sentinel"
ok "sentinel verified locally — 80,000 chars, sha256 $(printf '%s' "$SENTINEL_CHECK" | cut -c1-12)…"

PROMPT="Run this exact command with the Bash tool, exactly once, and then reply with exactly: done. Do not run any other command, do not retry it, and do not use any other tool.

$SENTINEL_CMD"

# ---------------------------------------------------------------------------
next "The extractor — the transcript is the measurement"

EXTRACT_JS="$TMP_DIR/extract.cjs"
cat > "$EXTRACT_JS" <<'JS'
// Reads ONE session's transcript back and measures the STORED tool result.
// Exit codes are the refusal taxonomy; the caller names each one:
//   2 no transcript   3 tool-call shape wrong   4 no linked tool_result
//   5 stdout not a string   6 chars != utf8 bytes (decoration or non-ASCII)
//   7 out of range (0, or the full 80,000 = nothing truncated)
//   8 stored stdout is not a contiguous slice of the sentinel (decoration)
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const [sid, outPath, cwd] = process.argv.slice(2);
const expectCmd = process.env.B12_CAP_CMD;
if (!expectCmd) { process.stderr.write("no B12_CAP_CMD in the environment"); process.exit(3); }
const lines = [];
for (let i = 0; i < 1000; i++) lines.push("B12CAPSENTINEL " + String(i).padStart(4, "0") + " " + "x".repeat(59));
const sentinel = lines.join("\n") + "\n";
if (sentinel.length !== 80000) { process.stderr.write("sentinel rebuild is not 80,000 chars"); process.exit(3); }
const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
const transcript = path.join(os.homedir(), ".claude", "projects", slug, `${sid}.jsonl`);
if (!existsSync(transcript)) process.exit(2);
const records = [];
for (const line of readFileSync(transcript, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try { records.push(JSON.parse(line)); } catch { /* non-JSON lines are not records */ }
}
// EXACTLY ONE tool_use in the whole transcript, and it is the pinned Bash
// command — a session that called anything else measured something else.
const toolUses = [];
for (const r of records) {
  const content = r?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (block?.type === "tool_use") toolUses.push(block);
  }
}
if (toolUses.length !== 1) {
  process.stderr.write(`expected exactly 1 tool_use in the transcript, found ${toolUses.length}`);
  process.exit(3);
}
const use = toolUses[0];
if (use.name !== "Bash") { process.stderr.write(`the one tool_use is ${use.name}, not Bash`); process.exit(3); }
if (use.input?.command !== expectCmd) {
  process.stderr.write("the Bash command in the transcript is not byte-identical to the pinned generator");
  process.exit(3);
}
// The tool_result found by its tool_use_id LINK, never by position.
let resultRecord = null;
let linked = 0;
for (const r of records) {
  const content = r?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (block?.type === "tool_result" && block?.tool_use_id === use.id) {
      linked += 1;
      resultRecord = r;
    }
  }
}
if (linked !== 1 || resultRecord === null) {
  process.stderr.write(`expected exactly 1 tool_result linked to ${use.id}, found ${linked}`);
  process.exit(4);
}
// The measured string is toolUseResult.stdout — what the client STORED —
// never a re-serialized wrapper. The wrapper's size is recorded beside it.
const tur = resultRecord.toolUseResult;
if (!tur || typeof tur !== "object" || typeof tur.stdout !== "string") {
  process.stderr.write("toolUseResult.stdout is not a string on the linked record");
  process.exit(5);
}
const stored = tur.stdout;
const stdoutChars = stored.length;
const utf8Bytes = Buffer.byteLength(stored, "utf8");
const wrapperChars = JSON.stringify(tur).length;
if (stdoutChars !== utf8Bytes) {
  process.stderr.write(`stdoutChars ${stdoutChars} != utf8Bytes ${utf8Bytes} — a non-ASCII byte in a pure-ASCII sentinel is decoration`);
  process.exit(6);
}
if (!(stdoutChars > 0 && stdoutChars < 80000)) {
  process.stderr.write(
    stdoutChars === 0
      ? "the stored stdout is EMPTY — breakage, not a cap"
      : `the stored stdout is ${stdoutChars} chars — the client did not truncate, so the cap was NOT measured (only bounded from below); raise the sentinel and re-run`
  );
  process.exit(7);
}
if (!sentinel.includes(stored)) {
  process.stderr.write("the stored stdout is not a contiguous slice of the sentinel — inserted text (a truncation banner, an elision marker) means the measured length is cap plus decoration");
  process.exit(8);
}
const out = {
  sessionId: sid,
  toolUseId: use.id,
  stdoutChars,
  utf8Bytes,
  wrapperChars,
  isPrefix: sentinel.startsWith(stored),
  storedSha256: createHash("sha256").update(stored, "utf8").digest("hex"),
  storedHead: stored.slice(0, 120),
  storedTail: stored.slice(-120),
};
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
process.stdout.write(`chars=${stdoutChars} bytes=${utf8Bytes} wrapper=${wrapperChars} prefix=${out.isPrefix}\n`);
JS
ok "extractor written"

# ---------------------------------------------------------------------------
next "Three sessions, one pinned command each"

run_replicate() {
  # $1 replicate number.
  local REP="$1" SID LOG RC EX_OUT
  SID=$(uuidgen | tr 'A-Z' 'a-z')
  case "$SID" in
    ????????-????-????-????-????????????) : ;;
    *) refuse "uuidgen did not produce a uuid (got \"$SID\")" ;;
  esac
  LOG="$TMP_DIR/claude-cap-r${REP}.log"
  info "replicate $REP — session $SID"
  # Strict with NO --mcp-config: zero servers, so nothing account-side rides
  # into the session. The Bash tool is pre-approved; headless cannot answer a
  # permission prompt.
  (cd "$SESS_CWD" && DISABLE_AUTOUPDATER=1 claude --print \
    --session-id "$SID" \
    --strict-mcp-config \
    --allowed-tools "Bash" \
    --permission-mode "$PERMISSION_MODE" \
    --output-format json \
    -- \
    "$PROMPT") >"$LOG" 2>&1
  RC=$?
  if [ $RC -ne 0 ]; then
    tail -20 "$LOG" 2>/dev/null | sed 's/^/      /'
    refuse "claude exited $RC on replicate $REP. A failed session is not a replicate."
  fi
  EX_OUT=$( (cd "$SESS_CWD" && B12_CAP_CMD="$SENTINEL_CMD" node "$EXTRACT_JS" "$SID" "$TMP_DIR/cap-r${REP}.json" "$SESS_CWD") 2>"$TMP_DIR/extract.err" )
  case $? in
    0) ok "replicate $REP — $EX_OUT" ;;
    2) refuse "claude wrote no transcript for $SID (replicate $REP). The cap lives in the transcript, so there is nothing to measure." ;;
    3) refuse "replicate $REP did not run EXACTLY the pinned command, exactly once: $(cat "$TMP_DIR/extract.err")" ;;
    4) refuse "replicate $REP has no tool_result linked to its one tool_use: $(cat "$TMP_DIR/extract.err")" ;;
    5) refuse "replicate $REP stored no stdout STRING — the wrapper is not the measurement: $(cat "$TMP_DIR/extract.err")" ;;
    6) refuse "replicate $REP failed the ASCII purity check: $(cat "$TMP_DIR/extract.err")" ;;
    7) refuse "replicate $REP is out of the measurable range: $(cat "$TMP_DIR/extract.err")" ;;
    8) refuse "replicate $REP stored decorated output: $(cat "$TMP_DIR/extract.err")" ;;
    *) refuse "the extractor failed unexpectedly on replicate $REP: $(cat "$TMP_DIR/extract.err")" ;;
  esac
}

run_replicate 1
run_replicate 2
run_replicate 3

# The binary must not have moved across the three sessions — the cap belongs
# to ONE binary, and a mid-probe update would split the three replicates
# across two of them.
CLAUDE_VER_AFTER=$(claude --version 2>/dev/null | head -1)
CLAUDE_SHA_AFTER=$(shasum -a 256 "$CLAUDE_BIN" 2>/dev/null | cut -d' ' -f1)
[ "$CLAUDE_VER_AFTER" = "$CLAUDE_VER" ] || refuse "claude --version changed mid-probe (\"$CLAUDE_VER\" -> \"$CLAUDE_VER_AFTER\"). The probe is void. Re-run."
[ "$CLAUDE_SHA_AFTER" = "$CLAUDE_SHA" ] || refuse "the claude binary's sha256 changed mid-probe. The probe is void. Re-run."
ok "binary unchanged across the probe"

# ---------------------------------------------------------------------------
next "Verdict and artifact"

STAMP_DATE=$(date -u +%Y-%m-%d)
STAMP_TIME=$(date -u +%H%M%S)
SHORT=$(printf '%s' "$LOCAL_SHA" | cut -c1-7)
[ -n "$STAMP_DATE" ] && [ -n "$STAMP_TIME" ] && [ -n "$SHORT" ] || refuse "could not build the artifact identity"
ART="$REPO/evidence/$STAMP_DATE-mac-b12-truncationcap-$SHORT-$STAMP_TIME.probe.json"
mkdir -p "$REPO/evidence" || refuse "could not create $REPO/evidence"
[ -e "$ART" ] && refuse "$ART already exists. A prior probe's evidence is not this run's to delete."

VERDICT_JS="$TMP_DIR/verdict.cjs"
cat > "$VERDICT_JS" <<'JS'
// The verdict is computed in ONE place, from the three files the extractor
// wrote, and the artifact carries everything a reader needs to re-adjudicate:
// the per-replicate numbers, the sentinel's definition and hash, and — as
// `measurementsRow` — the MEASUREMENTS.jsonl line to be appended VERBATIM by
// the machine that commits, with the append command beside it.
const { readFileSync, writeFileSync } = require("node:fs");
const e = process.env;
const art = process.argv[2];
const tmp = process.argv[3];
const reps = [];
for (let r = 1; r <= 3; r++) reps.push(JSON.parse(readFileSync(`${tmp}/cap-r${r}.json`, "utf8")));
const caps = reps.map((r) => r.stdoutChars);
// IDENTICAL, all three — a cap that moves between sessions is not a constant
// the meter may divide by. The extractor already held each replicate to
// 0 < chars < 80000, ASCII purity, and sentinel containment.
if (!(caps[0] === caps[1] && caps[1] === caps[2])) {
  console.error(`replicate caps disagree: ${caps.join(", ")} — not a constant; the probe is void`);
  process.exit(1);
}
const cap = caps[0];
const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const runId = `${e.B12_STAMP_DATE}-mac-b12-truncationcap-${e.B12_SHORT}-${e.B12_STAMP_TIME}`;
const row = {
  run_id: runId, ts, machine: "mac-01",
  metric: "client_truncation_cap_chars",
  value: cap, unit: "chars", premise: "B12",
  method: `scripts/b12-truncationcap-probe-mac.sh at ${e.B12_SHA_SHORT} on claude ${e.B12_CLAUDE_VER} (binary sha256 ${e.B12_CLAUDE_SHA.slice(0, 12)}...); 3 replicates, each ONE pinned Bash command printing an 80,000-char ASCII sentinel; measured string is toolUseResult.stdout from the transcript record LINKED by tool_use_id (never the serialized wrapper); per replicate: chars === utf8 bytes, 0 < chars < 80000, stored stdout a contiguous slice of the sentinel; artifact ${e.B12_ART_NAME}`,
  note: `CAPS ${caps.join(", ")} — IDENTICAL. The cap is in CHARACTERS (the meter divides chars; the gate measures raw.length). Wrapper sizes ${reps.map((r) => r.wrapperChars).join(", ")} recorded beside the measurement to show the wrapper was NOT what was measured. voidConditions 8: this is the measured cap for claude ${e.B12_CLAUDE_VER}; the manifest seals it as pinned.clientTruncationCap with this artifact's path and sha256.`,
};
const rowLine = JSON.stringify(row);
const artifact = {
  document: "clientTruncationCap probe — the measured cap voidConditions 8 requires",
  runId, ts,
  context: {
    commit: e.B12_SHA, host: "mac",
    claudeVersion: e.B12_CLAUDE_VER, claudeBinaryPath: e.B12_CLAUDE_BIN,
    claudeBinarySha256: e.B12_CLAUDE_SHA,
    permissionMode: e.B12_PERMISSION_MODE,
    sessionCwd: "a throwaway directory under the probe's temp dir — its transcripts are calibration scratch in that cwd's slug, outside any project slug a run would snapshot",
    declaredPin: {
      version: e.B12_EXPECT_VER || null,
      binarySha256: e.B12_EXPECT_SHA || null,
      note: "asserted when set; recorded either way",
    },
  },
  sentinel: {
    command: e.B12_CAP_CMD,
    chars: 80000,
    lines: 1000,
    lineLength: 80,
    sha256: e.B12_SENTINEL_SHA,
    note: "pure ASCII, every line self-identifying; verified to be exactly 80,000 chars on this machine before any session ran",
  },
  prompt: e.B12_PROMPT,
  argvShape: "claude --print --session-id <id> --strict-mcp-config --allowed-tools Bash --permission-mode <mode> --output-format json -- <prompt> (strict with NO --mcp-config: zero servers)",
  replicates: reps,
  clientTruncationCap: cap,
  unit: "chars",
  measurementsRow: rowLine,
  measurementsRowTransport:
    "ts was read from this machine's clock by the command that authored the row; the committing machine transports the bytes VERBATIM and must refuse if the run_id already exists. Append command (run from the repo root on the committing machine): node -e \"const fs=require('fs');const a=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const row=a.measurementsRow;const id=JSON.parse(row).run_id;const m=fs.readFileSync('MEASUREMENTS.jsonl','utf8');if(m.includes(id)){console.error('run_id already present: '+id);process.exit(1);}fs.appendFileSync('MEASUREMENTS.jsonl',row+'\\n');console.log('appended '+id);\" <this artifact file>",
};
writeFileSync(art, JSON.stringify(artifact, null, 2) + "\n");
const back = JSON.parse(readFileSync(art, "utf8"));
if (!back.context || !back.context.commit || !Number.isFinite(back.clientTruncationCap) || !back.measurementsRow) {
  console.error("provenance did not land in " + art);
  process.exit(1);
}
process.stdout.write(`B12-CAPPROBE-OK cap=${cap}\n`);
JS
VERDICT_OUT=$(B12_SHA="$LOCAL_SHA" B12_SHA_SHORT="$(git rev-parse --short HEAD)" B12_SHORT="$SHORT" \
  B12_STAMP_DATE="$STAMP_DATE" B12_STAMP_TIME="$STAMP_TIME" \
  B12_CLAUDE_VER="$CLAUDE_VER" B12_CLAUDE_BIN="$CLAUDE_BIN" B12_CLAUDE_SHA="$CLAUDE_SHA" \
  B12_PERMISSION_MODE="$PERMISSION_MODE" B12_CAP_CMD="$SENTINEL_CMD" \
  B12_SENTINEL_SHA="$SENTINEL_CHECK" B12_PROMPT="$PROMPT" \
  B12_EXPECT_VER="${B12_EXPECT_CLAUDE_VERSION:-}" B12_EXPECT_SHA="${B12_EXPECT_CLAUDE_SHA256:-}" \
  B12_ART_NAME="$(basename "$ART")" \
  node "$VERDICT_JS" "$ART" "$TMP_DIR" 2>&1)
VERDICT_RC=$?
# Producer exit zero AND an exact sentinel on its own line — a failed node
# whose stderr happens to contain the magic words must not be read as success.
if [ $VERDICT_RC -ne 0 ] || ! printf '%s\n' "$VERDICT_OUT" | grep -qE '^B12-CAPPROBE-OK cap=[0-9]+$'; then
  printf '%s\n' "$VERDICT_OUT" | sed 's/^/      /' >&2
  refuse "could not compute the verdict or write the artifact (node exit $VERDICT_RC); it was removed rather than left half-written"
fi
ART_FINALISED=1

COPIED=0
if cp "$ART" "$OUT_DIR/" 2>/dev/null; then
  COPIED=1
fi

say "DONE"
printf '%s\n' "$VERDICT_OUT" | sed 's/^/    /'
info "artifact: $ART"
[ $COPIED -eq 1 ] && info "copied to: $OUT_DIR/$(basename "$ART")"
info "next: commit the artifact on the machine that can push; the manifest seals"
info "      pinned.clientTruncationCap = the measured cap, beside this artifact's"
info "      path and sha256, for claude $CLAUDE_VER on this binary."
