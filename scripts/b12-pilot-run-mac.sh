#!/usr/bin/env bash
#
# b12-pilot-run-mac.sh — B12 pilot, phase Q: the five PAID pilot sessions,
# record verification, and the return package.
#
#   bash scripts/b12-pilot-run-mac.sh [/path/to/unpacked/clone]
#   B12_RESUME=1 bash scripts/b12-pilot-run-mac.sh   # continue an interrupted Q
#
# RUN THIS ONLY AFTER THE ORCHESTRATOR ANSWERED GO TO CHECKPOINT 2. Each of
# the five sessions is PAID: a refusal here is cheap, a wasted session is
# expensive, and a silently wrong measurement is worst — so every session's
# exit is classified against the record on disk, an observation once recorded
# is NEVER discarded, and nothing is ever auto-retried.
#
# Bash 3.2 compatible (macOS default). No associative arrays, no ${x,,},
# no GNU-only flags.

set -u
set -o pipefail

export DISABLE_AUTOUPDATER=1

CLAUDE_VER_PIN="2.1.221"
CLAUDE_SHA_PIN="7a181f36ed0fc4fbac6cee4ecf2b615eff93d8b434221fff5d7c878dc5ebf380"

# ---------------------------------------------------------------------------
if [ "${1:-}" != "" ]; then REPO="$1"; else REPO=$(git rev-parse --show-toplevel 2>/dev/null); fi
[ -n "${REPO:-}" ] || { printf 'REFUSED — no git work tree here and no path given. cd into ~/b12-tree and re-run.\n'; exit 2; }
cd "$REPO" || { printf 'REFUSED — cannot cd to %s.\n' "$REPO"; exit 2; }
REPO=$(pwd -P)

if [ "$REPO" != "$HOME/b12-tree" ]; then
  printf 'REFUSED — this clone is at %s, but the pinned .b12-mcp.json embeds\n%s/b12-tree/dist/server.js, so any other path makes the mcp-config sha lie.\nRun the pilot from ~/b12-tree exactly (P1 -> P2 -> this).\n' "$REPO" "$HOME"
  exit 2
fi

OUT="$REPO/b12-pilot-round"
LOGS="$OUT/logs"
LEDGER="$OUT/ledger.tsv"

say()   { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()    { printf '   + %s\n' "$*"; }
warn()  { printf '   ! %s\n' "$*"; }
die()   { printf '\nREFUSED — %s\n\nNo paid session was spent by this refusal. Fix the above and re-run; the gate is idempotent.\n' "$*"; exit 1; }
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$LEDGER"; }
sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# Q APPENDS to the round P1 opened and P2 continued — it NEVER moves a prior
# b12-pilot-round aside, because a resumed round continues the SAME ledger and
# the record file counts against exactly these rows.
[ -d "$OUT" ] || die "$OUT does not exist — P1 did not run here. The order is: P1, checkpoint 1, P2, checkpoint 2, GO, then this"
[ -f "$LEDGER" ] || die "no ledger at $LEDGER — the round dir is not one P1 built; run P1"
[ -d "$LOGS" ] || die "$OUT has no logs/ — the round dir is not one P1 built; run P1"

# A TAKEN RETRACT BRANCH ENDS THE ROUND — the marker is written by P2's M8
# pre-declared NOT SUSTAINED branch; a pilot after it would spend paid
# sessions against a retracted premise.
if [ -f "$OUT/.retract" ]; then
  RETRACT_STAMP=$(awk 'NR == 1 { print $2 }' "$OUT/.retract" 2>/dev/null)
  RETRACT_ART=$(awk 'NR == 1 { print $3 }' "$OUT/.retract" 2>/dev/null)
  printf '\nREFUSED — the pre-declared retract branch was taken on %s (artifact %s).\nThis round is OVER; adjudication happens off-Mac; a new round requires a fresh\ncut and pin.\n' "${RETRACT_STAMP:-an unrecorded date}" "${RETRACT_ART:-unrecorded}"
  exit 2
fi

# ---------------------------------------------------------------------------
say "GATE (cheap re-run) — tree, diff surface, binaries"

PIN_FILE="$REPO/.b12-round-pin"
if [ -n "${B12_EXPECT_SHA:-}" ]; then
  EXPECT_SHA="$B12_EXPECT_SHA"; PIN_FROM="B12_EXPECT_SHA"
elif [ -f "$PIN_FILE" ]; then
  EXPECT_SHA=$(tr -d ' \t\r\n' < "$PIN_FILE"); PIN_FROM=".b12-round-pin"
else
  die "no .b12-round-pin and no B12_EXPECT_SHA — the tree cannot say which commit it should be; re-cut the archive"
fi
case "$EXPECT_SHA" in
  ????????????????????????????????????????) : ;;
  *) die "the pin from $PIN_FROM is not a full 40-character sha (got \"$EXPECT_SHA\")" ;;
esac
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null)

# AFTER P2 the pin is an ANCESTOR of HEAD, and the diff surface between them
# is EXACTLY P2's two commits: the probe artifact and the filled config.
# Anything else on that surface means hands touched the tree since checkpoint
# 2, and a paid run against it would measure an unadjudicated instrument.
[ "$HEAD_SHA" = "$EXPECT_SHA" ] && die "HEAD equals the pin — P2 has not committed here (checkpoint 2 never happened). Run \`bash scripts/b12-pilot-p2-mac.sh\`, paste checkpoint 2, and wait for GO"
git merge-base --is-ancestor "$EXPECT_SHA" "$HEAD_SHA" 2>/dev/null || die "the pin $EXPECT_SHA is not an ancestor of HEAD $HEAD_SHA — this is not the tree checkpoint 2 described; adjudicate before spending anything"
DIFF_NAMES=$(git diff --name-only "$EXPECT_SHA..$HEAD_SHA" 2>/dev/null)
DIFF_RC=$?
[ "$DIFF_RC" -eq 0 ] || die "git diff --name-only failed (exit $DIFF_RC) — an uninspected diff surface must not read as a clean one"
DIFF_COUNT=$(printf '%s\n' "$DIFF_NAMES" | grep -c '[^[:space:]]' || true)
M8_ART_REL=""
CONFIG_SEEN=0
BAD_SURFACE=""
OLDIFS=$IFS; IFS='
'
for f in $DIFF_NAMES; do
  case "$f" in
    b12-corpus/manifest-config.json) CONFIG_SEEN=1 ;;
    evidence/*.probe.json)
      if [ -n "$M8_ART_REL" ]; then BAD_SURFACE="$BAD_SURFACE $f"; else M8_ART_REL="$f"; fi ;;
    *) BAD_SURFACE="$BAD_SURFACE $f" ;;
  esac
done
IFS=$OLDIFS
if [ "$DIFF_COUNT" != "2" ] || [ "$CONFIG_SEEN" != "1" ] || [ -z "$M8_ART_REL" ] || [ -n "$BAD_SURFACE" ]; then
  printf '   diff surface pin..HEAD:\n'; printf '%s\n' "$DIFF_NAMES" | sed 's/^/      /'
  die "the diff surface pin..HEAD must be EXACTLY b12-corpus/manifest-config.json plus one evidence/*.probe.json — it is not (above). Someone or something committed past checkpoint 2; adjudicate, do not run the pilot on this tree"
fi
[ -f "$REPO/$M8_ART_REL" ] || die "$M8_ART_REL is in history but not on disk — the tree is inconsistent; adjudicate"
# The pathname set alone cannot see a THIRD commit hiding behind the same two
# files — the commit count can.
COMMITS_PAST=$(git rev-list --count "$EXPECT_SHA..$HEAD_SHA" 2>/dev/null)
RL_RC=$?
[ "$RL_RC" -eq 0 ] || die "git rev-list --count failed (exit $RL_RC) — an uncounted history must not read as a clean one"
[ "$COMMITS_PAST" = "2" ] || die "pin..HEAD is $COMMITS_PAST commit(s), not the exact 2 from checkpoint 2 — the tree moved after checkpoint 2; re-run P2 so the checkpoint describes THIS head"
ok "pin is an ancestor; diff surface is exactly the two P2 files; exactly 2 commits"

GIT_STATUS_ERR="$OUT/.git-status-stderr"
GIT_STATUS_OUT=$(git status --porcelain --untracked-files=no 2>"$GIT_STATUS_ERR")
GIT_STATUS_RC=$?
[ "$GIT_STATUS_RC" -eq 0 ] || die "git status failed (exit $GIT_STATUS_RC): $(cat "$GIT_STATUS_ERR" 2>/dev/null) — an uninspected tree must not read as a clean one"
rm -f "$GIT_STATUS_ERR"
DIRTY=$(printf '%s\n' "$GIT_STATUS_OUT" | grep -c '[^[:space:]]' || true)
[ "$DIRTY" = "0" ] || { git status --porcelain --untracked-files=no | head -20; die "$DIRTY tracked file(s) differ from HEAD — the sessions would run against bytes no checkpoint described; adjudicate first"; }
ok "no tracked changes"

for f in dist/server.js dist/cost/b12/capture.js dist/cost/cli.js; do
  [ -f "$f" ] || die "$f is missing — the built instrument is gone; re-run P1 (it rebuilds) and then adjudicate how dist/ vanished"
done
ok "dist artifacts present"

command -v claude >/dev/null 2>&1 || die "claude is not on PATH — install Claude Code $CLAUDE_VER_PIN"
CLAUDE_VER=$(claude --version 2>/dev/null); CV_RC=$?
[ "$CV_RC" -eq 0 ] || die "claude --version exited $CV_RC — fix the install, then re-run"
CLAUDE_VER=$(printf '%s' "$CLAUDE_VER" | head -1)
case "$CLAUDE_VER" in
  *"$CLAUDE_VER_PIN"*) : ;;
  *) die "claude --version says \"$CLAUDE_VER\", pins were measured for $CLAUDE_VER_PIN. The binary moved — restore claude $CLAUDE_VER_PIN or re-probe cap+installedChars before any run" ;;
esac
CLAUDE_SHA=$(sha_of "$(command -v claude)")
[ "$CLAUDE_SHA" = "$CLAUDE_SHA_PIN" ] || die "the claude binary hashes to $CLAUDE_SHA, pin is $CLAUDE_SHA_PIN. The binary moved — restore claude $CLAUDE_VER_PIN or re-probe cap+installedChars before any run"
NODE_VER=$(node --version 2>/dev/null)
case "$NODE_VER" in v22.23.*) : ;; *) die "node is $NODE_VER, pinned toolchain is v22.23.x — the manifest would refuse every observe; install it, then re-run" ;; esac
VITEST_VER=$(npx vitest --version 2>/dev/null | tail -1)
case "$VITEST_VER" in *vitest/4.1*) : ;; *) die "vitest reports \"$VITEST_VER\", pinned toolchain is vitest/4.1 — re-run npm ci, then re-run" ;; esac
ok "claude $CLAUDE_VER (sha ok), node $NODE_VER, $VITEST_VER"

# The committed MCP config must still point at THIS tree (findMcpConfig never
# checks args[0], so this is the one place it is compared before spending).
node -e '
const cfg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const s = cfg.mcpServers && cfg.mcpServers["local-coder"];
if (!s || s.command !== "node" || !Array.isArray(s.args) || s.args[0] !== process.argv[2] + "/dist/server.js") process.exit(1);
' "$REPO/.b12-mcp.json" "$REPO" 2>/dev/null || die ".b12-mcp.json does not point at $REPO/dist/server.js — the clone is not at the pinned path or the config moved; adjudicate"
ok ".b12-mcp.json points at this tree"

command -v lms >/dev/null 2>&1 || die "the lms CLI is missing — the treatment arm needs the local server; install LM Studio's CLI, then re-run"
ok "lms present"

# ---------------------------------------------------------------------------
say "GATE — P2 finished, manifests present, checkpoint 2 markers"

PILOT_RUN_ID=$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync("b12-corpus/manifest-config.json", "utf8")).pilotRunId || ""))' 2>/dev/null)
[ -n "$PILOT_RUN_ID" ] || die "could not read pilotRunId from b12-corpus/manifest-config.json — P2's fill did not land; run P2"
case "$PILOT_RUN_ID" in
  *[!A-Za-z0-9._-]*) die "pilotRunId \"$PILOT_RUN_ID\" carries characters that do not belong in a filename — adjudicate the config" ;;
esac
PILOT_TASKS=$(node -e '
const c = JSON.parse(require("node:fs").readFileSync("b12-corpus/manifest-config.json", "utf8"));
const p = c.pilot;
if (!Array.isArray(p) || p.length !== 5) { console.error(`pilot array has ${Array.isArray(p) ? p.length : "no"} entries, expected 5`); process.exit(1); }
for (const t of p) {
  if (typeof t !== "string" || !/^[A-Za-z0-9._-]+$/.test(t)) { console.error(`bad task id: ${JSON.stringify(t)}`); process.exit(1); }
  process.stdout.write(t + "\n");
}
' 2>"$LOGS/Q-tasks.err")
RC=$?
[ "$RC" -eq 0 ] || die "the config's pilot array is not five clean task ids ($(cat "$LOGS/Q-tasks.err" 2>/dev/null)) — a partial task list must never pass; adjudicate the config, do not spend against it"

MCOUNT=0
for f in "$REPO/evidence/$PILOT_RUN_ID".b12.pilot-*.manifest.json; do
  [ -f "$f" ] && MCOUNT=$((MCOUNT + 1))
done
[ "$MCOUNT" -eq 5 ] || die "expected exactly 5 manifests at evidence/$PILOT_RUN_ID.b12.pilot-*.manifest.json, found $MCOUNT — P2's build did not finish (or the files were moved); re-run P2 only after adjudicating"
for TASK in $PILOT_TASKS; do
  MF="evidence/$PILOT_RUN_ID.b12.pilot-$TASK.manifest.json"
  [ -f "$REPO/$MF" ] || die "no manifest for task $TASK at $MF — P2's build and the config disagree; adjudicate"
  if git ls-files --error-unmatch "$MF" >/dev/null 2>&1; then
    die "$MF is TRACKED — pilot manifests must stay untracked (_beforeYouBuild 2); adjudicate how it got committed before spending anything"
  fi
done
ok "5 manifests for $PILOT_RUN_ID, one per task, all untracked"

# P2's summary must say every P2 step ran — checkpoint 2 was printed from
# exactly these rows, and GO was given against that print.
[ -f "$OUT/summary.json" ] || die "no $OUT/summary.json — P2 did not finish (its summary is written at its end); run P2 to completion first"
PF_IDS=""
for TASK in $PILOT_TASKS; do PF_IDS="$PF_IDS PF-$TASK"; done
MISSING_STEPS=$(node -e '
const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const ran = new Set(s.ranIds || []);
const missing = process.argv.slice(2).filter((n) => !ran.has(n));
process.stdout.write(missing.join(", "));
' "$OUT/summary.json" M8 COMMIT1 FILL COMMIT2 BUILD M5 CHECK2 $PF_IDS 2>&1)
MS_RC=$?
[ "$MS_RC" -eq 0 ] || die "P2's summary.json is unreadable ($MISSING_STEPS) — re-run P2's checkpoint or inspect the file; an unreadable summary must never read as a pass"
[ -z "$MISSING_STEPS" ] || die "the round summary does not show these P2 steps as ran: $MISSING_STEPS — checkpoint 2 cannot have been printed from a finished P2; run P2 to completion and get GO again"
# The summary's recorded head must BE this head — a tree that moved after the
# checkpoint printed is not the tree GO was given against.
P2_HEAD=$(node -e '
const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const h = s.head;
if (typeof h !== "string" || !h) { console.error("summary carries no head field"); process.exit(1); }
process.stdout.write(h);
' "$OUT/summary.json" 2>&1)
PH_RC=$?
[ "$PH_RC" -eq 0 ] || die "P2's summary.json does not carry the head it checkpointed ($P2_HEAD) — re-run P2 (its summary records head) or inspect the file"
[ "$P2_HEAD" = "$HEAD_SHA" ] || die "HEAD is $HEAD_SHA but P2's summary checkpointed head $P2_HEAD — the tree moved after checkpoint 2; re-run P2 so the checkpoint describes THIS head"
ok "P2's steps all ran; summary head matches HEAD (checkpoint 2 markers present)"

# ---------------------------------------------------------------------------
# Packaging BEFORE any step so the signal handler can call it. Q's package is
# the real one: summary + the return tarball with the evidence copies.
PACKAGE_MODE=partial
RECORD="$REPO/evidence/$PILOT_RUN_ID.b12.pilot.json"
PATCH_FILES=""
MISSING_TASKS_Q=""

record_count() { # prints the record's observation count (0 when absent); exit 1 when unreadable
  if [ ! -f "$1" ]; then printf '0'; return 0; fi
  node -e '
try {
  const a = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const n = Array.isArray(a.observations) ? a.observations.length : NaN;
  if (!Number.isInteger(n)) process.exit(1);
  process.stdout.write(String(n));
} catch { process.exit(1); }
' "$1" 2>/dev/null
}

task_seen() { # prints how many observations in record $1 carry taskId $2 (0 when absent); exit 1 when unreadable
  if [ ! -f "$1" ]; then printf '0'; return 0; fi
  node -e '
try {
  const a = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const o = Array.isArray(a.observations) ? a.observations : null;
  if (!o) process.exit(1);
  process.stdout.write(String(o.filter((x) => x && x.taskId === process.argv[2]).length));
} catch { process.exit(1); }
' "$1" "$2" 2>/dev/null
}

package_round() {
say "Summary"

REC_COUNT=$(record_count "$RECORD") || REC_COUNT="unreadable"
node - "$LEDGER" "$OUT/summary.json" "$(git rev-parse HEAD)" "$EXPECT_SHA" "$PILOT_RUN_ID" "$REC_COUNT" "$RECORD" $PILOT_TASKS <<'JS'
const { readFileSync, writeFileSync } = require("node:fs");
const [, , ledger, out, sha, pin, pilotRunId, recCount, recordPath, ...tasks] = process.argv;
const rows = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => {
  const [id, status, exit, note] = l.split("\t");
  return { id, status, exit: exit === "" ? null : Number(exit), note };
});
const KNOWN = ["ran", "failed", "skipped"];
const unknown = rows.filter((r) => !KNOWN.includes(r.status));
if (unknown.length) {
  console.error(`REFUSED: ledger carries ${unknown.length} row(s) with unknown status (${[...new Set(unknown.map((r) => r.status))].join(", ")}).`);
  process.exit(2);
}
// AN ABORTED ROUND IS A FACT, NOT A SUCCESS — the summary carries which of
// the five tasks the record actually holds, by identity, not by count.
let recordedTasks = [];
try {
  const rec = JSON.parse(readFileSync(recordPath, "utf8"));
  recordedTasks = (Array.isArray(rec.observations) ? rec.observations : []).map((o) => o && o.taskId).filter(Boolean);
} catch {}
const missingTasks = tasks.filter((t) => !recordedTasks.includes(t));
const summary = {
  document: "b12-pilot-round",
  phase: "Q",
  commit: sha,
  head: sha,
  pin,
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  host: "mac",
  steps: rows,
  ranIds: rows.filter((r) => r.status === "ran").map((r) => r.id),
  failedIds: rows.filter((r) => r.status === "failed").map((r) => r.id),
  skippedIds: rows.filter((r) => r.status === "skipped").map((r) => r.id),
  pilotRunId,
  recordCount: /^\d+$/.test(recCount) ? Number(recCount) : null,
  partial: missingTasks.length > 0,
  missingTasks,
};
writeFileSync(out, JSON.stringify(summary, null, 2) + "\n", "utf8");
for (const r of rows) {
  const mark = r.status === "skipped" ? "  -  " : r.status === "failed" ? " FAIL" : "  ok ";
  console.log(`  ${mark} ${r.id.padEnd(18)} ${r.note}`);
}
if (summary.failedIds.length) console.log(`\n  FAILED: ${summary.failedIds.join(", ")}`);
if (summary.skippedIds.length) console.log(`  SKIPPED: ${summary.skippedIds.join(", ")}`);
if (missingTasks.length) console.log(`\n  PARTIAL — task(s) missing from the record: ${missingTasks.join(", ")}`);
JS
SUM_RC=$?
if [ "$SUM_RC" -ne 0 ]; then
  record SUMMARY failed "$SUM_RC" "summary write exited $SUM_RC — summary.json on disk is stale, do not send it as final"
  printf '\nSTOPPED — the summary writer exited %s, so %s/summary.json is STALE.\nDo not package or send it as final; the observations on disk are untouched.\nOperator adjudicates.\n' "$SUM_RC" "$OUT"
  return 1
fi
node -e '
const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
process.exit(s.document === "b12-pilot-round" && s.phase === "Q" ? 0 : 1);
' "$OUT/summary.json" 2>/dev/null
SUM_RC=$?
if [ "$SUM_RC" -ne 0 ]; then
  record SUMMARY failed 1 "summary.json re-read does not identify phase Q of b12-pilot-round"
  printf '\nSTOPPED — %s/summary.json re-read does not identify itself as phase Q of\nb12-pilot-round — a stale or foreign summary must not be packaged as final.\nOperator adjudicates.\n' "$OUT"
  return 1
fi

say "Return package"
mkdir -p "$OUT/return"
GATHERED=0
gather_ret() { # gather_ret <abs-file>
  if [ -f "$1" ]; then
    if cp "$1" "$OUT/return/" 2>/dev/null; then GATHERED=$((GATHERED + 1)); else warn "could not copy $1"; fi
  else
    warn "not on disk (not gathered): $1"
  fi
}
gather_ret "$RECORD"
gather_ret "$REPO/$M8_ART_REL"
gather_ret "$REPO/b12-corpus/manifest-config.json"
for _t in $PILOT_TASKS; do
  gather_ret "$REPO/evidence/$PILOT_RUN_ID.b12.pilot-$_t.manifest.json"
done
gather_ret "$REPO/.b12-mcp.json"
ok "$GATHERED file(s) copied into b12-pilot-round/return/"

TARBALL="$HOME/b12-pilot-$(git rev-parse --short HEAD).tgz"
rm -f "$TARBALL"
if ! tar -czf "$TARBALL" -C "$REPO" b12-pilot-round 2>/dev/null; then
  warn "could not write $TARBALL — send the directory $OUT instead"
  return 0
fi

# OPENED AND CHECKED BEFORE IT IS HANDED OVER — the cut script's own lesson:
# every transport failure so far was invisible at packing time and cost a day.
LISTING=$(tar -t -z -f "$TARBALL" 2>/dev/null | sed 's|^\./||')
TAR_RC=$?
if [ "$TAR_RC" -ne 0 ]; then
  if [ "$PACKAGE_MODE" = "final" ]; then
    printf '\nREFUSED — the archive at %s cannot be read back (tar -t exited %s).\nDo not send it. Fix the cause (disk full? partial write?), then repackage by\nre-running this script under B12_RESUME=1.\n' "$TARBALL" "$TAR_RC"
    return 1
  fi
  warn "the archive at $TARBALL cannot be read back (tar -t exited $TAR_RC) — do not send it; send the directory $OUT instead"
  return 0
fi
MISSING_NAMES=""
for name in \
  "b12-pilot-round/ledger.tsv" \
  "b12-pilot-round/summary.json" \
  "b12-pilot-round/b12-policy-return.bundle" \
  "b12-pilot-round/return/$(basename "$RECORD")" \
  "b12-pilot-round/return/$(basename "$M8_ART_REL")" \
  "b12-pilot-round/return/manifest-config.json" \
  "b12-pilot-round/return/.b12-mcp.json"; do
  printf '%s\n' "$LISTING" | grep -qxF "$name" || MISSING_NAMES="$MISSING_NAMES $name"
done
for _t in $PILOT_TASKS; do
  for name in \
    "b12-pilot-round/return/$PILOT_RUN_ID.b12.pilot-$_t.manifest.json" \
    "b12-pilot-round/preflight-$_t.json"; do
    printf '%s\n' "$LISTING" | grep -qxF "$name" || MISSING_NAMES="$MISSING_NAMES $name"
  done
done
# The patches promised are EXACTLY the files format-patch reported writing —
# the captured list, not a glob over whatever is in the directory now.
for p in $PATCH_FILES; do
  name="b12-pilot-round/patches/$(basename "$p")"
  printf '%s\n' "$LISTING" | grep -qxF "$name" || MISSING_NAMES="$MISSING_NAMES $name"
done
printf '%s\n' "$LISTING" | grep -q '^b12-pilot-round/logs/.' || MISSING_NAMES="$MISSING_NAMES b12-pilot-round/logs/(no-entries)"
if [ -n "$MISSING_NAMES" ]; then
  if [ "$PACKAGE_MODE" = "final" ]; then
    printf '\nREFUSED — the archive at %s is missing:\n' "$TARBALL"
    for m in $MISSING_NAMES; do printf '      %s\n' "$m"; done
    printf 'Do NOT send it. Find each missing file (the warnings above say which never\nexisted), adjudicate, and re-run the packaging by re-running this script under\nB12_RESUME=1 once the causes are fixed.\n'
    return 1
  fi
  warn "PARTIAL package — missing from the archive:"
  for m in $MISSING_NAMES; do printf '      %s\n' "$m"; done
  warn "send it anyway, WITH this terminal output, and say the round was interrupted"
else
  ok "$TARBALL — every required name is present in the archive"
fi
return 0
}

CURRENT_STEP=""
on_signal() {
  trap - INT TERM
  for _s in $CURRENT_STEP; do
    grep -q "^$_s$(printf '	')" "$LEDGER" 2>/dev/null || record "$_s" failed 130 "interrupted by signal mid-step"
  done
  warn "interrupted — packaging what already exists (a recorded observation is never discarded)"
  PACKAGE_MODE=partial
  package_round
  exit 130
}
trap on_signal INT TERM

stop_run() { # stop_run <id> <exit> <note-and-next-action>
  record "$1" failed "$2" "$3"
  printf '\nSTOPPED — %s\n' "$3"
  PACKAGE_MODE=partial
  package_round
  exit 1
}

# ---------------------------------------------------------------------------
say "LOCKS — leftover locks or tmp files mean an operator decision, not a sweep"
CURRENT_STEP=LOCKS
FOUND_LOCKS=""
for p in "$REPO/evidence/".session-lock-* "$REPO/evidence/".runlog-lock-* "$REPO/evidence/".*.b12.pilot.json.tmp-*; do
  [ -e "$p" ] || continue
  FOUND_LOCKS="$FOUND_LOCKS$p
"
done
if [ -n "$FOUND_LOCKS" ]; then
  printf '   found:\n'
  printf '%s' "$FOUND_LOCKS" | sed 's/^/      /'
  printf '   A lock dir means a session may still be live or died mid-write; a tmp file\n'
  printf '   may hold the ONLY copy of a paid observation. This script will NEVER remove\n'
  printf '   them. Confirm no live process, merge any tmp by hand into the record, remove\n'
  printf '   the leftovers yourself, and only then re-run.\n'
  stop_run LOCKS 1 "lock/tmp leftovers in evidence/ (listed above) — operator adjudicates; nothing was spent"
fi
record LOCKS ran 0 "no lock dirs, no tmp pilot files"
ok "evidence/ clean of locks and tmp files"

# ---------------------------------------------------------------------------
say "FRESH RECORD — the pilot file must be this round's, or explicitly resumed"
CURRENT_STEP=FRESH
RESUME_TASKS=""
if [ -f "$RECORD" ] && [ -z "${B12_RESUME:-}" ]; then
  stop_run FRESH 1 "$RECORD already exists and B12_RESUME is not set. If it is THIS round's interrupted run, re-run with B12_RESUME=1 (the same ledger continues). If it is an older round's, adjudicate — move it aside by hand, never delete a paid observation"
fi
if [ -n "${B12_RESUME:-}" ]; then
  if [ -f "$RECORD" ]; then
    # THE RESUME GATE IS IDENTITY-BASED, never a row count: every observation
    # must be arm=treatment, carry one of the config's five taskIds, and no
    # taskId may appear twice. A failed ledger row that FOLLOWED a written
    # record (the post-write refusal) no longer blocks the resume.
    FRESH_ERR=$(node -e '
const a = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if (a.schema !== "b12-pilot/1") { console.error(`schema is ${JSON.stringify(a.schema)}, expected "b12-pilot/1"`); process.exit(1); }
if (a.runId !== process.argv[2]) { console.error(`runId is ${JSON.stringify(a.runId)}, expected ${JSON.stringify(process.argv[2])}`); process.exit(1); }
const tasks = process.argv.slice(3);
const obs = Array.isArray(a.observations) ? a.observations : null;
if (!obs) { console.error("observations is not an array"); process.exit(1); }
const seen = new Set();
for (const o of obs) {
  const t = o && o.taskId;
  const arm = o && o.arm;
  if (arm !== "treatment") { console.error(`observation for taskId ${JSON.stringify(t)} carries arm ${JSON.stringify(arm)}, expected "treatment"`); process.exit(1); }
  if (!tasks.includes(t)) { console.error(`taskId ${JSON.stringify(t)} is not one of the five in the config pilot array`); process.exit(1); }
  if (seen.has(t)) { console.error(`taskId ${JSON.stringify(t)} appears twice`); process.exit(1); }
  seen.add(t);
}
' "$RECORD" "$PILOT_RUN_ID" $PILOT_TASKS 2>&1)
    RC=$?
    [ "$RC" -eq 0 ] || stop_run FRESH "$RC" "resume identity check failed: $FRESH_ERR — the record needs operator adjudication before anything is spent on top of it"
    RESUME_TASKS=$(node -e '
const a = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write((a.observations || []).map((o) => o && o.taskId).filter(Boolean).join(" "));
' "$RECORD" 2>/dev/null)
    # A ledger ran Q row whose observation is GONE means the record lost a paid
    # observation — resume must refuse, never quietly re-run the task.
    LOST_TASKS=""
    for _t in $(awk -F'\t' '$2 == "ran" && $1 ~ /^Q-/ { sub(/^Q-/, "", $1); print $1 }' "$LEDGER" | sort -u); do
      case " $RESUME_TASKS " in
        *" $_t "*) : ;;
        *) LOST_TASKS="$LOST_TASKS $_t" ;;
      esac
    done
    [ -z "$LOST_TASKS" ] || stop_run FRESH 1 "the record lost$LOST_TASKS which the ledger shows ran — adjudicate; never re-run it"
    record FRESH ran 0 "resume: already recorded task(s): ${RESUME_TASKS:-none}"
    ok "resuming — already recorded: ${RESUME_TASKS:-none}"
  else
    PRIOR_RAN=$(awk -F'\t' '$1 ~ /^Q-/ && $2 == "ran"' "$LEDGER" | wc -l | tr -d ' ')
    [ "$PRIOR_RAN" = "0" ] || stop_run FRESH 1 "B12_RESUME=1 with $PRIOR_RAN ran Q row(s) in the ledger but NO record file — a recorded observation is missing from disk; operator adjudicates, nothing is spent on top of a hole"
    record FRESH ran 0 "resume requested but no record exists and no prior ran rows — proceeding as fresh"
    ok "resume requested; nothing recorded yet, running fresh"
  fi
else
  record FRESH ran 0 "no prior pilot record — fresh round"
  ok "fresh round"
fi

# ---------------------------------------------------------------------------
say "LMS — free the RAM before the arm that selects by it"
CURRENT_STEP=LMS
# A model still resident from P2's probe skews `selection` for the treatment
# sessions — the run must open on the same free-RAM footing every time.
UNLOAD_OUT=$(lms unload --all 2>&1)
UNLOAD_RC=$?
{ printf 'lms unload --all -> exit %s\n%s\n\nlms ps:\n' "$UNLOAD_RC" "$UNLOAD_OUT"; lms ps 2>&1; } > "$LOGS/Q-lms.txt"
[ "$UNLOAD_RC" -eq 0 ] || stop_run LMS "$UNLOAD_RC" "lms unload --all exited $UNLOAD_RC (logs/Q-lms.txt) — free the RAM by hand (lms ps; quit LM Studio apps), then re-run — a resident model would skew selection for the treatment arm"
record LMS ran 0 "unload clean; lms ps in logs/Q-lms.txt"
ok "unloaded (lms ps logged)"

# ---------------------------------------------------------------------------
say "THE FIVE PAID SESSIONS — committed order, back to back"
for TASK in $PILOT_TASKS; do
  CURRENT_STEP="Q-$TASK"

  SKIP_THIS=0
  for done_task in $RESUME_TASKS; do
    [ "$done_task" = "$TASK" ] && SKIP_THIS=1
  done
  if [ "$SKIP_THIS" = "1" ]; then
    record "Q-$TASK" skipped "" "already recorded"
    ok "$TASK — already recorded, skipped"
    continue
  fi

  record_count "$RECORD" >/dev/null || stop_run "Q-$TASK" 1 "the pilot record at $RECORD is unreadable BEFORE the session — nothing was spent for $TASK; operator adjudicates the record file"

  printf '   %s ... ' "$TASK"
  # Redirect, NOT tee: the exit code must be node's, and pipefail is not a
  # substitute for not putting a pipe there at all.
  node scripts/b12-run.mjs pilot --manifest "evidence/$PILOT_RUN_ID.b12.pilot-$TASK.manifest.json" --task "$TASK" --arm treatment > "$LOGS/Q-$TASK.txt" 2>&1
  RC=$?

  # THE POST-SESSION CHECK IS BY IDENTITY: this taskId, present exactly once —
  # not a count that any concurrent append could satisfy.
  SEEN_AFTER=$(task_seen "$RECORD" "$TASK")
  RCC=$?
  [ "$RCC" -eq 0 ] || stop_run "Q-$TASK" 1 "the pilot record became unreadable AFTER the $TASK session (exit $RC) — the tmp-file doctrine in appendPilotRecord names the recovery; operator adjudicates, never re-run blindly"
  if [ "$SEEN_AFTER" -gt 1 ]; then
    printf 'DUPLICATE RECORD (exit %s)\n' "$RC"
    stop_run "Q-$TASK" "$RC" "taskId $TASK appears $SEEN_AFTER times in the record after its session — no taskId may appear twice; the record needs operator adjudication"
  fi

  if [ "$RC" -eq 0 ]; then
    if [ "$SEEN_AFTER" -eq 1 ]; then
      printf 'ok (taskId %s recorded once)\n' "$TASK"
      record "Q-$TASK" ran 0 "recorded (taskId present exactly once)"
    else
      printf 'EXIT 0 BUT NO RECORD\n'
      stop_run "Q-$TASK" 0 "exit 0 but taskId $TASK was not appended to the record — a paid session left no observation; read logs/Q-$TASK.txt and adjudicate before anything else runs"
    fi
  elif grep -q 'b12-run: REFUSED' "$LOGS/Q-$TASK.txt"; then
    printf 'REFUSED (exit %s)\n' "$RC"
    grep 'b12-run: REFUSED' "$LOGS/Q-$TASK.txt" | head -3 | sed 's/^/      /'
    if [ "$SEEN_AFTER" -eq 1 ]; then
      printf '      NOTE: the record WAS appended before the refusal (taskId %s present) — a\n' "$TASK"
      printf '      post-write refusal (worktree removal is the known one); the observation\n'
      printf '      is safe. The refusal itself is still systemic.\n'
      stop_run "Q-$TASK" "$RC" "refused AFTER appending the record (taskId $TASK present exactly once) — refusals are systemic and pre-spend for the REMAINING tasks; read logs/Q-$TASK.txt, adjudicate, resume with B12_RESUME=1"
    else
      printf '      no record was appended (taskId %s absent).\n' "$TASK"
      stop_run "Q-$TASK" "$RC" "refused, no record appended — refusals are systemic; fix the named cause (logs/Q-$TASK.txt), then resume with B12_RESUME=1"
    fi
  elif grep -q 'INVALID:' "$LOGS/Q-$TASK.txt"; then
    REASONS=$(grep 'INVALID:' "$LOGS/Q-$TASK.txt" | sed 's/^ *INVALID: *//' | tr '\n' ';' | tr -d '\t' | cut -c1-200)
    if [ "$SEEN_AFTER" -eq 1 ]; then
      printf 'INVALID but recorded (exit %s) — continuing\n' "$RC"
      grep 'INVALID:' "$LOGS/Q-$TASK.txt" | head -5 | sed 's/^/      /'
      record "Q-$TASK" ran "$RC" "INVALID but recorded ($REASONS) — a paid session is never discarded"
    else
      printf 'INVALID and NOT recorded (exit %s)\n' "$RC"
      stop_run "Q-$TASK" "$RC" "log says INVALID ($REASONS) but taskId $TASK was not appended — the observation is lost unless a tmp file holds it; operator adjudicates"
    fi
  else
    printf 'UNKNOWN EXIT SHAPE (exit %s)\n' "$RC"
    tail -5 "$LOGS/Q-$TASK.txt" | sed 's/^/      /'
    stop_run "Q-$TASK" "$RC" "exit $RC with neither 'b12-run: REFUSED' nor 'INVALID:' in logs/Q-$TASK.txt — never auto-retry an unknown shape; operator reads the log and adjudicates"
  fi
done

# ---------------------------------------------------------------------------
say "VERIFY RECORD — schema, identity, completeness, and the forbidden-key shape"
CURRENT_STEP=VERIFY
[ -f "$RECORD" ] || stop_run VERIFY 1 "no pilot record at $RECORD after the sessions — if every task was skipped this resume had nothing to do, otherwise the record vanished; operator adjudicates"
VERIFY_OUT=$(node - "$RECORD" "$PILOT_RUN_ID" "$REPO" $PILOT_TASKS 2>&1 <<'JS'
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
(async () => {
  const [, , file, runId, repo, ...tasks] = process.argv;
  const a = JSON.parse(readFileSync(file, "utf8"));
  const fail = (m) => { console.error(m); process.exit(1); };
  if (a.schema !== "b12-pilot/1") fail(`schema is ${JSON.stringify(a.schema)}, expected "b12-pilot/1"`);
  if (a.runId !== runId) fail(`runId is ${JSON.stringify(a.runId)}, expected ${JSON.stringify(runId)}`);
  // IDENTITY, NOT COUNT: every observation arm=treatment, every taskId one of
  // the config's five, no taskId twice — a violating record needs adjudication.
  const obs = Array.isArray(a.observations) ? a.observations : null;
  if (!obs) fail("observations is not an array");
  const seen = new Set();
  for (const o of obs) {
    const t = o && o.taskId;
    const arm = o && o.arm;
    if (arm !== "treatment") fail(`observation for taskId ${JSON.stringify(t)} carries arm ${JSON.stringify(arm)}, expected "treatment" — the record needs operator adjudication`);
    if (!tasks.includes(t)) fail(`taskId ${JSON.stringify(t)} is not one of the five in the config pilot array — the record needs operator adjudication`);
    if (seen.has(t)) fail(`taskId ${JSON.stringify(t)} appears twice — the record needs operator adjudication`);
    seen.add(t);
  }
  // The harness's own shape teeth, imported rather than re-implemented; the
  // manual forbidden-key walk is the fallback if the export ever disappears.
  const mod = await import(pathToFileURL(path.join(repo, "scripts", "b12-run.mjs")).href);
  if (typeof mod.assertPilotShape === "function") {
    mod.assertPilotShape(a);
  } else {
    const keys = Array.isArray(mod.PILOT_FORBIDDEN_KEYS)
      ? mod.PILOT_FORBIDDEN_KEYS
      : ["rLo", "rHi", "rHiPlus", "uncappedBracket", "bracket", "verdict", "admitted", "recomputations", "strata", "hold"];
    const walk = (v, trail) => {
      if (Array.isArray(v)) { for (const x of v) walk(x, trail); return; }
      if (v === null || typeof v !== "object") return;
      for (const [k, val] of Object.entries(v)) {
        if (keys.includes(k)) fail(`forbidden key "${k}" under ${trail.join(".")}`);
        walk(val, trail.concat(k));
      }
    };
    walk(a, ["pilot"]);
  }
  const missing = tasks.filter((t) => !seen.has(t));
  if (missing.length) {
    process.stdout.write(`partial: ${obs.length} of ${tasks.length} task(s) recorded, missing ${missing.join(", ")} — an aborted round is a fact, not a success`);
  } else {
    process.stdout.write(`ok: all ${tasks.length} tasks recorded once each; schema/runId/identity/shape all hold`);
  }
})().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
JS
)
RC=$?
[ "$RC" -eq 0 ] || stop_run VERIFY "$RC" "record verification failed: $VERIFY_OUT — the observations stay on disk untouched; operator adjudicates before the package is called complete"
# EVERY ledger ran Q row must still have its observation in the record — a ran
# row whose taskId is gone means the record lost a paid observation.
RECORDED_TASKS=$(node -e '
const a = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write((a.observations || []).map((o) => o && o.taskId).filter(Boolean).join(" "));
' "$RECORD" 2>/dev/null)
LOST_TASKS=""
for _t in $(awk -F'\t' '$2 == "ran" && $1 ~ /^Q-/ { sub(/^Q-/, "", $1); print $1 }' "$LEDGER" | sort -u); do
  case " $RECORDED_TASKS " in
    *" $_t "*) : ;;
    *) LOST_TASKS="$LOST_TASKS $_t" ;;
  esac
done
[ -z "$LOST_TASKS" ] || stop_run VERIFY 1 "the record lost$LOST_TASKS which the ledger shows ran — adjudicate; never re-run it"
# Never-attempted tasks make the round PARTIAL: it still packages, but the
# final banner and the exit code must say so.
MISSING_TASKS_Q=""
for _t in $PILOT_TASKS; do
  case " $RECORDED_TASKS " in
    *" $_t "*) : ;;
    *) MISSING_TASKS_Q="$MISSING_TASKS_Q $_t" ;;
  esac
done
record VERIFY ran 0 "$VERIFY_OUT"
ok "$VERIFY_OUT"

# ---------------------------------------------------------------------------
say "POLICY BUNDLE — the policy repo's state travels back"
CURRENT_STEP=BUNDLE
if [ -d "$HOME/b12-policy" ]; then
  git -C "$HOME/b12-policy" bundle create "$OUT/b12-policy-return.bundle" --all > "$LOGS/BUNDLE.txt" 2>&1
  RC=$?
  [ "$RC" -eq 0 ] || stop_run BUNDLE "$RC" "git bundle create failed (exit $RC) — read logs/BUNDLE.txt; the pilot record is safe, fix the bundle and resume with B12_RESUME=1"
  record BUNDLE ran 0 "b12-policy-return.bundle written (--all)"
  ok "b12-policy-return.bundle"
else
  stop_run BUNDLE 1 "~/b12-policy does not exist — it held the sealed blobs; if it was moved after P2, restore it, then resume with B12_RESUME=1"
fi

# ---------------------------------------------------------------------------
say "PATCHES — the two commits travel back as bytes"
CURRENT_STEP=PATCHES
# patches/ is built FRESH — a stale file in it would ride the archive as this
# round's bytes. Moved aside timestamped, round convention, never deleted.
if [ -d "$OUT/patches" ]; then
  PATCHES_ASIDE="$OUT/patches.prior-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$OUT/patches" "$PATCHES_ASIDE" || stop_run PATCHES 1 "could not move the stale patches/ aside to $(basename "$PATCHES_ASIDE") — nothing is ever deleted; fix the cause (permissions?), then resume with B12_RESUME=1"
  warn "stale patches/ moved aside to $(basename "$PATCHES_ASIDE")"
fi
mkdir -p "$OUT/patches"
git format-patch "$EXPECT_SHA..HEAD" -o "$OUT/patches" > "$LOGS/PATCHES.txt" 2>&1
RC=$?
[ "$RC" -eq 0 ] || stop_run PATCHES "$RC" "git format-patch failed (exit $RC) — read logs/PATCHES.txt; fix and resume with B12_RESUME=1"
# The list format-patch itself reported writing IS the set the archive must
# carry — captured here, checked name by name in the read-back inventory.
PATCH_FILES=$(grep '\.patch$' "$LOGS/PATCHES.txt" 2>/dev/null)
PATCH_COUNT=$(printf '%s\n' "$PATCH_FILES" | grep -c '\.patch$' || true)
[ "$PATCH_COUNT" -gt 0 ] || stop_run PATCHES 1 "git format-patch exited 0 but reported no .patch file for pin..HEAD (logs/PATCHES.txt) — the two commits must travel back as bytes; adjudicate"
# EXACT BOTH DIRECTIONS: what format-patch reported == what patches/ holds.
REPORTED_SET=$(for p in $PATCH_FILES; do basename "$p"; done | sort)
DIR_SET=$(ls "$OUT/patches" 2>/dev/null | sort)
if [ "$REPORTED_SET" != "$DIR_SET" ]; then
  printf '   format-patch reported:\n'; printf '%s\n' "$REPORTED_SET" | sed 's/^/      /'
  printf '   patches/ holds:\n'; printf '%s\n' "$DIR_SET" | sed 's/^/      /'
  stop_run PATCHES 1 "patches/ does not hold exactly the set format-patch reported (both listings above) — a stale or vanished patch; adjudicate, then resume with B12_RESUME=1"
fi
record PATCHES ran 0 "$PATCH_COUNT patch file(s) for pin..HEAD"
ok "$PATCH_COUNT patch file(s)"

# ---------------------------------------------------------------------------
CURRENT_STEP=""
trap - INT TERM
PACKAGE_MODE=final
package_round
PKG_RC=$?
if [ "$PKG_RC" -ne 0 ]; then
  exit 1
fi

TARBALL="$HOME/b12-pilot-$(git rev-parse --short HEAD).tgz"
# A PARTIAL round packages and travels, but it NEVER wears the COMPLETE banner
# and never exits 0 — an aborted round is a fact, not a success.
if [ -n "$MISSING_TASKS_Q" ]; then
  printf '\nPARTIAL ROUND packaged — missing:%s\n' "$MISSING_TASKS_Q"
  if [ -f "$TARBALL" ]; then
    printf 'Send %s home WITH this terminal output and say the\nround was aborted. The missing tasks were never attempted — the orchestrator\ndecides whether a resume may attempt them.\n' "$TARBALL"
  else
    printf 'The tarball could not be written — send the whole directory instead:\n  %s\nWITH this terminal output, and say the round was aborted.\n' "$OUT"
  fi
  exit 1
fi
printf '\n'
printf '=======================================================================================\n'
printf 'PHASE Q COMPLETE.\n'
printf '\n'
# Never name a path that is not there — a reported package that does not exist
# is the same class of false statement this run exists to catch.
if [ -f "$TARBALL" ]; then
  printf 'The return package is:  %s\n' "$TARBALL"
else
  printf 'The tarball could not be written — send the whole directory instead:\n  %s\n' "$OUT"
fi
printf '\n'
printf 'Send it back; reconciliation commits the bytes on Windows. It carries the round\n'
printf 'ledger and summary, every session log, the five preflight artifacts, the pilot\n'
printf 'record, the M8 probe artifact, the filled manifest-config, the five manifests,\n'
printf 'the mcp config, the two commits as patches, and the policy repo as a bundle.\n'
printf 'This machine cannot push, and nothing here tried to.\n'
printf '=======================================================================================\n\n'
exit 0
