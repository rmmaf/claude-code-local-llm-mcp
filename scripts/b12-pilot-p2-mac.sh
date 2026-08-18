#!/usr/bin/env bash
#
# b12-pilot-p2-mac.sh — B12 pilot, phase P2: optional model pin, the M8
# re-probe under sealed blobs, TWO local commits, manifest build, M5, and the
# five manifest preflights — ending at CHECKPOINT 2.
#
#   bash scripts/b12-pilot-p2-mac.sh [/path/to/unpacked/clone]
#   B12_PIN_MODEL=<catalog-id> bash scripts/b12-pilot-p2-mac.sh   # owner said pin
#
# COSTS ~8 CHEAP claude sessions (7 in the M8 probe, 1 in M5's scratch) and
# makes exactly two local commits in this clone (the probe artifact, then the
# filled manifest-config). It never pushes — this machine cannot reach git.
#
# REFUSES TO START unless P1 ran clean in this same b12-pilot-round/ — a P2
# without P1's gate would be spending sessions against unverified premises.
# Every refusal names the next action.
#
# Bash 3.2 compatible (macOS default). No associative arrays, no ${x,,},
# no GNU-only flags.

set -u
set -o pipefail

export DISABLE_AUTOUPDATER=1

CLAUDE_VER_PIN="2.1.221"
CLAUDE_SHA_PIN="7a181f36ed0fc4fbac6cee4ecf2b615eff93d8b434221fff5d7c878dc5ebf380"
POLICY_BASELINE="3d0bccb3aa390b363058543469c05dd6140ce9c1"

# ---------------------------------------------------------------------------
if [ "${1:-}" != "" ]; then REPO="$1"; else REPO=$(git rev-parse --show-toplevel 2>/dev/null); fi
[ -n "${REPO:-}" ] || { printf 'REFUSED — no git work tree here and no path given. cd into ~/b12-tree and re-run.\n'; exit 2; }
cd "$REPO" || { printf 'REFUSED — cannot cd to %s.\n' "$REPO"; exit 2; }
REPO=$(pwd -P)

if [ "$REPO" != "$HOME/b12-tree" ]; then
  printf 'REFUSED — this clone is at %s, but the pinned .b12-mcp.json embeds\n%s/b12-tree/dist/server.js, so any other path makes the mcp-config sha lie.\nUnpack at ~/b12-tree exactly, run P1 there, then re-run this.\n' "$REPO" "$HOME"
  exit 2
fi

OUT="$REPO/b12-pilot-round"
LOGS="$OUT/logs"
LEDGER="$OUT/ledger.tsv"

say()   { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()    { printf '   + %s\n' "$*"; }
warn()  { printf '   ! %s\n' "$*"; }
die()   { printf '\nREFUSED — %s\n\nNothing was spent. Fix the above and re-run; the gate is idempotent.\n' "$*"; exit 1; }
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$LEDGER"; }
sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# P2 REFUSES IF THE ROUND DIR IS MISSING — that means P1 did not run, and P1's
# gate is what proves the pins before anything is spent.
[ -d "$OUT" ] || die "$OUT does not exist — P1 did not run. Run \`bash scripts/b12-pilot-p1-mac.sh\` first, paste checkpoint 1, and wait for the answer"
[ -d "$LOGS" ] || die "$OUT exists but has no logs/ — the round dir is not one P1 built. Move it aside by hand and run P1"
[ -f "$LEDGER" ] || die "no ledger at $LEDGER — P1 did not finish its setup. Re-run \`bash scripts/b12-pilot-p1-mac.sh\`"

# A TAKEN RETRACT BRANCH ENDS THE ROUND — the marker is written by M8's
# pre-declared NOT SUSTAINED branch, and no later run may probe the same
# pinned tree into a friendlier verdict.
if [ -f "$OUT/.retract" ]; then
  RETRACT_STAMP=$(awk 'NR == 1 { print $2 }' "$OUT/.retract" 2>/dev/null)
  RETRACT_ART=$(awk 'NR == 1 { print $3 }' "$OUT/.retract" 2>/dev/null)
  printf '\nREFUSED — the pre-declared retract branch was taken on %s (artifact %s).\nThis round is OVER; adjudication happens off-Mac; a new round requires a fresh\ncut and pin.\n' "${RETRACT_STAMP:-an unrecorded date}" "${RETRACT_ART:-unrecorded}"
  exit 2
fi

FAILED_IDS=$(awk -F'\t' '$2 == "failed" { print $1 }' "$LEDGER" | tr '\n' ' ')
if [ -n "$(printf '%s' "$FAILED_IDS" | tr -d ' ')" ]; then
  # NO REFUSAL YET: a P2 that died AFTER its commits leaves failed row(s) AND
  # moves HEAD past the pin, and only the pin gate below can tell that lawful
  # resume apart from anything else. The refusal, if one is due, happens there.
  warn "ledger carries failed row(s): $FAILED_IDS— the pin gate below decides whether this is a lawful P2 resume"
else
  ok "P1's ledger present, no failed rows"
fi

# THE PHASE'S ZERO MARK — artifacts this phase gathers must be newer than it,
# so an earlier round's probe or preflight can never be mistaken for today's.
P2_MARKER="$OUT/.p2-start"
: > "$P2_MARKER"

# ---------------------------------------------------------------------------
say "GATE (cheap re-run) — tree, pins, binaries"

# Pin gate. A FRESH P2 runs BEFORE its own commits, so pin == HEAD exactly.
# A P2 that died AFTER its commits RESUMES instead: pin an ancestor of HEAD,
# the diff surface exactly its own two committed files, and its ledger showing
# M8 and COMMIT2 ran — anything else is a refusal, never a guess.
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
RESUME_P2=0
M8_REL=""
if [ "$HEAD_SHA" = "$EXPECT_SHA" ]; then
  ok "at the pinned commit $(git rev-parse --short HEAD)"
else
  RESUME_WHY=""
  if ! git merge-base --is-ancestor "$EXPECT_SHA" "$HEAD_SHA" 2>/dev/null; then
    RESUME_WHY="the pin is not an ancestor of HEAD"
  else
    DIFF_NAMES=$(git diff --name-only "$EXPECT_SHA..HEAD" 2>/dev/null)
    DIFF_COUNT=$(printf '%s\n' "$DIFF_NAMES" | grep -c '[^[:space:]]' || true)
    CONFIG_SEEN=0
    BAD_SURFACE=""
    OLDIFS=$IFS; IFS='
'
    for f in $DIFF_NAMES; do
      case "$f" in
        b12-corpus/manifest-config.json) CONFIG_SEEN=1 ;;
        evidence/*installedchars*.probe.json)
          if [ -n "$M8_REL" ]; then BAD_SURFACE="$BAD_SURFACE $f"; else M8_REL="$f"; fi ;;
        *) BAD_SURFACE="$BAD_SURFACE $f" ;;
      esac
    done
    IFS=$OLDIFS
    if [ "$DIFF_COUNT" != "2" ] || [ "$CONFIG_SEEN" != "1" ] || [ -z "$M8_REL" ] || [ -n "$BAD_SURFACE" ]; then
      RESUME_WHY="the diff surface pin..HEAD is not exactly b12-corpus/manifest-config.json plus one evidence/*installedchars*.probe.json"
    elif [ "$(git rev-list --count "$EXPECT_SHA..$HEAD_SHA" 2>/dev/null)" != "2" ]; then
      RESUME_WHY="pin..HEAD is not exactly the 2 P2 commits (a third commit can hide behind the same two pathnames)"
    elif ! awk -F'\t' '$1 == "M8" && $2 == "ran" { f = 1 } END { exit f ? 0 : 1 }' "$LEDGER"; then
      RESUME_WHY="the ledger has no ran row for M8"
    elif ! awk -F'\t' '$1 == "COMMIT2" && $2 == "ran" { f = 1 } END { exit f ? 0 : 1 }' "$LEDGER"; then
      RESUME_WHY="the ledger has no ran row for COMMIT2"
    else
      RESUME_P2=1
    fi
  fi
  if [ "$RESUME_P2" != "1" ]; then
    printf '   commits past the pin:\n'; git log --oneline "$EXPECT_SHA..HEAD" 2>/dev/null | sed 's/^/      /'
    die "HEAD is $HEAD_SHA but the pin is $EXPECT_SHA, and this tree does not qualify as a P2 resume: $RESUME_WHY. When P2 died after its commits, re-run P2 — it resumes past the local commits — but only over exactly its own committed surface with M8 and COMMIT2 ran in the ledger. Anything else: adjudicate before touching this tree"
  fi
  [ -f "$REPO/$M8_REL" ] || die "$M8_REL is in history but not on disk — the tree is inconsistent; adjudicate"
  M8_ART="$REPO/$M8_REL"
  ok "resume — pin is an ancestor, diff surface is P2's own two commits, M8 and COMMIT2 ran"
fi
if [ -n "$(printf '%s' "$FAILED_IDS" | tr -d ' ')" ] && [ "$RESUME_P2" != "1" ]; then
  die "the round's ledger carries failed row(s): $FAILED_IDS— if these are P1 steps or a P2 step before its commits, fix the cause and re-run P1 (it opens a fresh round and spends nothing; the old round is moved aside, never deleted). If P2 failed after its commits, re-run P2 — it resumes past the local commits"
fi

GIT_STATUS_ERR="$OUT/.git-status-stderr"
GIT_STATUS_OUT=$(git status --porcelain --untracked-files=no 2>"$GIT_STATUS_ERR")
GIT_STATUS_RC=$?
[ "$GIT_STATUS_RC" -eq 0 ] || die "git status failed (exit $GIT_STATUS_RC): $(cat "$GIT_STATUS_ERR" 2>/dev/null) — an uninspected tree must not read as a clean one"
rm -f "$GIT_STATUS_ERR"
DIRTY=$(printf '%s\n' "$GIT_STATUS_OUT" | grep -c '[^[:space:]]' || true)
[ "$DIRTY" = "0" ] || { git status --porcelain --untracked-files=no | head -20; die "$DIRTY tracked file(s) differ from the commit — P2 commits on top of what is there, so start clean; adjudicate the changes above first"; }
ok "no tracked changes"

for f in dist/server.js dist/cost/b12/capture.js dist/cost/cli.js; do
  [ -f "$f" ] || die "$f is missing — P1's build did not survive; re-run \`bash scripts/b12-pilot-p1-mac.sh\`"
done
ok "dist artifacts present (no rebuild in P2)"

HOOKS_PATH=$(git config --get core.hooksPath 2>/dev/null)
[ "$HOOKS_PATH" = ".githooks" ] || die "git core.hooksPath is \"$HOOKS_PATH\", expected .githooks — P2's commits must run the pins-check hook. Check \`npm config get ignore-scripts\`, run \`npm run hooks:install\`, re-run"
git var GIT_AUTHOR_IDENT >/dev/null 2>&1 || die "git has no author identity here, and P2 makes two commits. Set it (locally is fine): git -C $REPO config user.name \"<name>\" && git -C $REPO config user.email \"<email>\" — then re-run"
ok "hooks installed, commit identity present"

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
case "$NODE_VER" in v22.23.*) : ;; *) die "node is $NODE_VER, pinned toolchain is v22.23.x — install it, then re-run" ;; esac
VITEST_VER=$(npx vitest --version 2>/dev/null | tail -1)
case "$VITEST_VER" in *vitest/4.1*) : ;; *) die "vitest reports \"$VITEST_VER\", pinned toolchain is vitest/4.1 — re-run npm ci, then re-run" ;; esac
ok "claude $CLAUDE_VER (sha ok), node $NODE_VER, $VITEST_VER"

# The policy repo P1 cloned — M8 seals ITS blobs, so its state is a premise.
[ -d "$HOME/b12-policy" ] || die "~/b12-policy does not exist — P1's M-POLICY clones it from the bundle; re-run \`bash scripts/b12-pilot-p1-mac.sh\`"
git -C "$HOME/b12-policy" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "~/b12-policy is not a git work tree — move it aside and re-run P1"
[ "$(git -C "$HOME/b12-policy" rev-parse --is-shallow-repository 2>/dev/null)" = "false" ] || die "~/b12-policy is a shallow clone — findPolicyBlob refuses it; re-run P1 against a bundle created with --all"
git -C "$HOME/b12-policy" merge-base --is-ancestor "$POLICY_BASELINE" HEAD 2>/dev/null || die "~/b12-policy HEAD does not descend from the shipped baseline $POLICY_BASELINE — re-run P1 to restore the bundle clone"
POLICY_DIRTY=$(git -C "$HOME/b12-policy" status --porcelain 2>/dev/null)
[ -z "$POLICY_DIRTY" ] || { printf '%s\n' "$POLICY_DIRTY" | sed 's/^/      /'; die "~/b12-policy has uncommitted changes (above) — a half-appended pin clause, most likely; adjudicate: commit it by hand or re-run P1 to restore the clone"; }
git -C "$HOME/b12-policy" cat-file -e HEAD:treatment.md 2>/dev/null || die "~/b12-policy HEAD has no treatment.md — re-run P1"
git -C "$HOME/b12-policy" cat-file -e HEAD:control.md 2>/dev/null || die "~/b12-policy HEAD has no control.md — re-run P1"
ok "~/b12-policy at $(git -C "$HOME/b12-policy" rev-parse --short HEAD), clean, full, descends from the baseline"

command -v lms >/dev/null 2>&1 || die "the lms CLI is missing — M8's treatment arm needs the local server; install LM Studio's CLI, then re-run"
ok "lms present"

# ---------------------------------------------------------------------------
# Packaging BEFORE any step, for the signal trap. No tarball in P2 either —
# the round stays on disk for Q; summary.json is the phase's durable state.
package_round() {
say "Summary"

node - "$LEDGER" "$OUT/summary.json" "$(git rev-parse HEAD)" "$EXPECT_SHA" <<'JS'
const { readFileSync, writeFileSync } = require("node:fs");
const [, , ledger, out, sha, pin] = process.argv;
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
const summary = {
  document: "b12-pilot-round",
  phase: "P2",
  commit: sha,
  head: sha,
  pin,
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  host: "mac",
  steps: rows,
  ranIds: rows.filter((r) => r.status === "ran").map((r) => r.id),
  failedIds: rows.filter((r) => r.status === "failed").map((r) => r.id),
  skippedIds: rows.filter((r) => r.status === "skipped").map((r) => r.id),
};
writeFileSync(out, JSON.stringify(summary, null, 2) + "\n", "utf8");
for (const r of rows) {
  const mark = r.status === "skipped" ? "  -  " : r.status === "failed" ? " FAIL" : "  ok ";
  console.log(`  ${mark} ${r.id.padEnd(10)} ${r.note}`);
}
if (summary.failedIds.length) console.log(`\n  FAILED: ${summary.failedIds.join(", ")}`);
JS

ok "summary.json updated at $OUT (ledger and logs beside it) — Q reads them in place"
}

CURRENT_STEP=""
on_signal() {
  trap - INT TERM
  for _s in $CURRENT_STEP; do
    grep -q "^$_s$(printf '	')" "$LEDGER" 2>/dev/null || record "$_s" failed 130 "interrupted by signal mid-step"
  done
  warn "interrupted — writing the summary for what already ran"
  package_round
  exit 130
}
trap on_signal INT TERM

fail_step() { # fail_step <id> <exit> <note-and-next-action>
  record "$1" failed "$2" "$3"
  printf '\nREFUSED — %s\n' "$3"
  package_round
  exit 1
}

# ---------------------------------------------------------------------------
say "M-PIN — the owner's model decision from checkpoint 1"
if [ "$RESUME_P2" = "1" ]; then
  [ -z "${B12_PIN_MODEL:-}" ] || warn "resume ignores B12_PIN_MODEL — the decision is already sealed in COMMIT2"
  record M-PIN skipped "" "already done, resuming"
  ok "already done, resuming"
elif [ -n "${B12_PIN_MODEL:-}" ]; then
  CURRENT_STEP=M-PIN
  [ -f "$LOGS/M-MODEL.txt" ] || fail_step M-PIN 1 "logs/M-MODEL.txt is missing — P1's model probe did not run in this round; re-run P1 and come back"
  CATALOG_IDS=$(node -e '
const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write((Array.isArray(s.catalog) ? s.catalog : []).map((m) => m.model).join(", "));
' "$LOGS/M-MODEL.txt" 2>/dev/null)
  node -e '
const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const cat = (Array.isArray(s.catalog) ? s.catalog : []).map((m) => m.model);
process.exit(cat.includes(process.argv[2]) ? 0 : 1);
' "$LOGS/M-MODEL.txt" "$B12_PIN_MODEL" || fail_step M-PIN 1 "B12_PIN_MODEL=\"$B12_PIN_MODEL\" is not a catalog id in P1's M-MODEL probe. The catalog holds: ${CATALOG_IDS:-(empty)}. Pass one of those exactly, or run without B12_PIN_MODEL to leave selection free"

  # A second clause would move the blob sha AGAIN and make two pins claim one
  # decision. The IDENTICAL clause is an idempotent restart; a DIFFERENT id is
  # a refusal that hands the choice back.
  EXISTING_PIN_LINES=$(git -C "$HOME/b12-policy" cat-file blob HEAD:treatment.md | grep -F "Always pass model")
  if [ -n "$EXISTING_PIN_LINES" ]; then
    OTHER_PIN_LINE=$(printf '%s\n' "$EXISTING_PIN_LINES" | grep -vF "Always pass model: \"$B12_PIN_MODEL\"" | head -1)
    if [ -n "$OTHER_PIN_LINE" ]; then
      fail_step M-PIN 1 "treatment.md at ~/b12-policy HEAD already pins a model in this line: $OTHER_PIN_LINE — two pins must not claim one decision. Either re-run with B12_PIN_MODEL set to that same id, or restore ~/b12-policy from the bundle (re-run P1) and re-run P2 from scratch"
    fi
    PIN_COMMIT=$(git -C "$HOME/b12-policy" rev-parse --short HEAD)
    record M-PIN ran 0 "pin clause for $B12_PIN_MODEL already committed at $PIN_COMMIT — append skipped (idempotent restart)"
    ok "pin clause for $B12_PIN_MODEL already committed — nothing appended"
  else
    git -C "$HOME/b12-policy" var GIT_AUTHOR_IDENT >/dev/null 2>&1 || fail_step M-PIN 1 "no git identity in ~/b12-policy — set git -C ~/b12-policy config user.name/user.email, then re-run"
    # THE APPEND IS ONE BULLET LINE, no leading blank line: the file already ends
    # with a newline (guarded anyway), so the clause lands as its own last line.
    node -e '
const fs = require("node:fs");
const f = process.argv[1], id = process.argv[2];
let t = fs.readFileSync(f, "utf8");
if (!t.endsWith("\n")) t += "\n";
fs.writeFileSync(f, t + `- Always pass model: "${id}" to repair, scaffold and implement.\n`, "utf8");
' "$HOME/b12-policy/treatment.md" "$B12_PIN_MODEL" || fail_step M-PIN 1 "could not append the pin clause to ~/b12-policy/treatment.md — is it writable?"
    git -C "$HOME/b12-policy" add treatment.md \
      && git -C "$HOME/b12-policy" commit -q -m "pin the local model for B12: $B12_PIN_MODEL (owner decision at pilot checkpoint 1)" > "$LOGS/M-PIN.txt" 2>&1
    RC=$?
    [ "$RC" -eq 0 ] || { cat "$LOGS/M-PIN.txt" | sed 's/^/   /'; fail_step M-PIN "$RC" "could not commit the pin in ~/b12-policy (details above) — fix and re-run; the working copy now differs from HEAD, so the gate will insist you adjudicate"; }
    PIN_COMMIT=$(git -C "$HOME/b12-policy" rev-parse --short HEAD)
    record M-PIN ran 0 "pinned $B12_PIN_MODEL; policy commit $PIN_COMMIT"
    ok "pinned $B12_PIN_MODEL in ~/b12-policy at $PIN_COMMIT"
  fi
else
  record M-PIN skipped "" "B12_PIN_MODEL not set — selection left free (owner decision at checkpoint 1)"
  ok "no pin requested — selection left free"
fi

# EITHER WAY the commit M8 seals blobs from is read back from the repo itself.
POLICY_COMMIT=$(git -C "$HOME/b12-policy" rev-parse HEAD)

# ---------------------------------------------------------------------------
# THE FOUR COMMITTED STEPS run only on a fresh P2 — a resume already carries
# their two commits, and re-running them would double-commit. The bodies stay
# at column 0, like every function body in this file.
if [ "$RESUME_P2" != "1" ]; then

# ---------------------------------------------------------------------------
say "M8 — installedChars re-probe under sealed blobs (7 cheap sessions)"
CURRENT_STEP=M8
B12_EXPECT_SHA="$EXPECT_SHA" \
B12_MCP_CONFIG="$REPO/.b12-mcp.json" \
B12_POLICY_REPO="$HOME/b12-policy" \
B12_POLICY_COMMIT="$POLICY_COMMIT" \
B12_POLICY_TREATMENT_PATH=treatment.md \
B12_POLICY_CONTROL_PATH=control.md \
  bash scripts/b12-installedchars-probe-mac.sh "$REPO" > "$LOGS/M8.txt" 2>&1
RC=$?
tail -6 "$LOGS/M8.txt" | sed 's/^/   /'

# The artifact must be THIS phase's — newer than .p2-start — not a leftover.
M8_ART=""
for f in "$REPO/evidence/"*installedchars*.probe.json; do
  [ -f "$f" ] || continue
  [ "$f" -nt "$P2_MARKER" ] || continue
  if [ -z "$M8_ART" ] || [ "$f" -nt "$M8_ART" ]; then M8_ART="$f"; fi
done

read_sustained() { # prints true/false/unknown for $1
  node -e '
try {
  const a = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(a.sustained === true ? "true" : a.sustained === false ? "false" : "unknown");
} catch { process.stdout.write("unknown"); }
' "$1" 2>/dev/null
}

# THE PROBE EXITS 0 FOR BOTH VERDICTS — its sentinel accepts sustained=true
# and sustained=false alike. A nonzero exit means the probe malfunctioned and
# its own cleanup removed the artifact; the verdict never reaches disk.
if [ "$RC" -eq 0 ]; then
  [ -n "$M8_ART" ] || fail_step M8 1 "the probe exited 0 but no evidence/*installedchars*.probe.json newer than this phase's start exists — read $LOGS/M8.txt; an artifact that cannot be tied to this run must not be committed"
  SUSTAINED=$(read_sustained "$M8_ART")
  case "$SUSTAINED" in
    true)
      record M8 ran 0 "SUSTAINED — $(basename "$M8_ART")"
      ok "SUSTAINED — artifact $(basename "$M8_ART")"
      ;;
    false)
      # THE PRE-DECLARED RETRACT BRANCH — a lawful verdict, not a malfunction:
      # the ledger says ran, the phase stops here, and nothing is committed.
      # The durable marker ENDS the round: both gates refuse on it, so no later
      # run can re-probe the same pinned tree into a friendlier verdict. The
      # marker and an artifact copy ride home inside the round directory.
      cp "$M8_ART" "$OUT/" 2>/dev/null
      [ -f "$OUT/$(basename "$M8_ART")" ] || fail_step M8 1 "could not copy the NOT SUSTAINED artifact into the round dir — the retract must travel home; fix the disk and re-run the probe"
      # The marker is the LAST durable act: a failure before it leaves the
      # round re-runnable, a failure after it cannot happen.
      printf 'RETRACT %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$M8_ART")" > "$OUT/.retract"
      [ -s "$OUT/.retract" ] || fail_step M8 1 "could not write $OUT/.retract — without the marker a later run could re-probe the pinned tree; fix the disk and re-run the probe"
      record M8 ran 0 "NOT SUSTAINED — pre-declared retract branch"
      printf '\n=========================== RETRACT CHECKPOINT (M8) ===========================\n'
      printf 'STOP — pre-declared branch: do not run the pilot, do not commit.\n'
      printf 'The installedChars re-probe came back NOT SUSTAINED. PREMISES.md § B12 fixes\nthe branch: retract and re-register, with this probe as the recorded cause.\n'
      printf 'artifact: %s\n' "$M8_ART"
      printf 'This round is OVER — the .retract marker makes every later P2/Q here refuse.\nSend this block and the round directory %s home\n(it carries the ledger, summary, .retract, and a copy of the artifact) for the\nretract-and-re-register adjudication. Nothing was committed; no paid session\nwas spent.\n' "$OUT"
      printf '===============================================================================\n'
      package_round
      exit 0
      ;;
    *)
      fail_step M8 1 "the probe exited 0 but $(basename "$M8_ART") has no boolean sustained (read back \"$SUSTAINED\") — the artifact is malformed; read $LOGS/M8.txt and adjudicate before committing anything"
      ;;
  esac
else
  fail_step M8 "$RC" "the probe failed (exit $RC) and its own cleanup removed the artifact — read $LOGS/M8.txt. Nothing was committed; fix the cause and re-run the probe. Note: re-running P2 first requires re-running P1 (the ledger now carries a failed row, and P1 spends nothing)"
fi

# ---------------------------------------------------------------------------
say "COMMIT 1 — the probe artifact enters history"
CURRENT_STEP=COMMIT1
M8_REL="evidence/$(basename "$M8_ART")"
git add "$M8_REL" && git commit -q -m "evidence(mac): installedChars re-probe under sealed blobs + pinned mcp config" > "$LOGS/COMMIT1.txt" 2>&1
RC=$?
[ "$RC" -eq 0 ] || { cat "$LOGS/COMMIT1.txt" | sed 's/^/   /'; fail_step COMMIT1 "$RC" "git commit failed (exit $RC, details above) — if the pre-commit pins-check refused, read its output; do not bypass the hook"; }
record COMMIT1 ran 0 "committed $M8_REL at $(git rev-parse --short HEAD)"
ok "commit 1: $(git log -1 --format='%h %s')"

# ---------------------------------------------------------------------------
say "FILL — the Mac-local pins enter the config"
CURRENT_STEP=FILL
# B12_PROBE names the artifact COMMIT1 just committed, so the fill's default
# lexical pick is never exercised — the pin is the file, not a sort order.
B12_POLICY_REPO="$HOME/b12-policy" B12_POLICY_COMMIT="$POLICY_COMMIT" \
B12_PROBE="$M8_REL" \
  node scripts/b12-fill-mac-pins.mjs > "$LOGS/FILL.txt" 2>&1
RC=$?
tail -6 "$LOGS/FILL.txt" | sed 's/^/   /'
[ "$RC" -eq 0 ] || fail_step FILL "$RC" "fill-mac-pins refused (exit $RC) — its stderr above names the missing premise; read $LOGS/FILL.txt in full, fix, and note commit 1 already landed (a P2 re-run now requires operator adjudication, not a blind retry)"
record FILL ran 0 "manifest-config.json filled (probe, capture, blobs, pilotRunId)"
ok "pins filled"

# ---------------------------------------------------------------------------
say "COMMIT 2 — the filled config enters history"
CURRENT_STEP=COMMIT2
git add b12-corpus/manifest-config.json && git commit -q -m "config(b12): Mac-local pins filled for the pilot (probe, capture, blobs, pilotRunId)" > "$LOGS/COMMIT2.txt" 2>&1
RC=$?
[ "$RC" -eq 0 ] || { cat "$LOGS/COMMIT2.txt" | sed 's/^/   /'; fail_step COMMIT2 "$RC" "git commit failed (exit $RC, details above) — if the pre-commit pins-check refused, the fill wrote something the pins disagree with; adjudicate, do not bypass the hook"; }
record COMMIT2 ran 0 "committed b12-corpus/manifest-config.json at $(git rev-parse --short HEAD)"
ok "commit 2: $(git log -1 --format='%h %s')"

# After both commits the tree must again be clean of tracked changes.
POST_STATUS=$(git status --porcelain --untracked-files=no 2>/dev/null)
POST_RC=$?
[ "$POST_RC" -eq 0 ] || fail_step COMMIT2 "$POST_RC" "git status failed after the commits — an uninspected tree must not read as a clean one; run it by hand"
[ -z "$POST_STATUS" ] || { printf '%s\n' "$POST_STATUS" | sed 's/^/      /'; fail_step COMMIT2 1 "tracked changes remain after both commits (above) — the fill touched more than manifest-config.json; adjudicate before building anything"; }
ok "tree clean again after the two commits"

else
  # RESUME — the earlier attempt's two commits already carry the probe artifact
  # and the filled config; BUILD onward is safe to re-run (M5 costs one cheap
  # session, and that is acceptable).
  say "RESUME — M8, COMMIT1, FILL and COMMIT2 are already in history"
  for _s in M8 COMMIT1 FILL COMMIT2; do record "$_s" skipped "" "already done, resuming"; done
  ok "probe artifact $M8_REL and the filled config committed by the earlier attempt — starting at BUILD"
fi

# ---------------------------------------------------------------------------
say "BUILD — plan, then build, the five pilot manifests"
CURRENT_STEP=BUILD
# pilotRunId is read from the config — the single source — never retyped.
PILOT_RUN_ID=$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync("b12-corpus/manifest-config.json", "utf8")).pilotRunId || ""))' 2>/dev/null)
[ -n "$PILOT_RUN_ID" ] || fail_step BUILD 1 "could not read pilotRunId from b12-corpus/manifest-config.json — the fill should have set it; read $LOGS/FILL.txt"
case "$PILOT_RUN_ID" in
  *[!A-Za-z0-9._-]*) fail_step BUILD 1 "pilotRunId \"$PILOT_RUN_ID\" carries characters that do not belong in a filename — adjudicate the fill before building" ;;
esac
PILOT_TASKS=$(node -e '
const c = JSON.parse(require("node:fs").readFileSync("b12-corpus/manifest-config.json", "utf8"));
const p = c.pilot;
if (!Array.isArray(p) || p.length !== 5) { console.error(`pilot array has ${Array.isArray(p) ? p.length : "no"} entries, expected 5`); process.exit(1); }
for (const t of p) {
  if (typeof t !== "string" || !/^[A-Za-z0-9._-]+$/.test(t)) { console.error(`bad task id: ${JSON.stringify(t)}`); process.exit(1); }
  process.stdout.write(t + "\n");
}
' 2>"$LOGS/BUILD-tasks.err")
RC=$?
[ "$RC" -eq 0 ] || fail_step BUILD "$RC" "the config's pilot array is not five clean task ids ($(cat "$LOGS/BUILD-tasks.err" 2>/dev/null)) — adjudicate the config"

node scripts/b12-manifest.mjs plan b12-corpus/manifest-config.json --pilot-only > "$LOGS/BUILD-plan.txt" 2>&1
RC=$?
if [ "$RC" -ne 0 ] || grep -q "REFUSED" "$LOGS/BUILD-plan.txt"; then
  grep -n "REFUSED" "$LOGS/BUILD-plan.txt" | head -5 | sed 's/^/   /'
  fail_step BUILD "$RC" "manifest plan exited $RC (refusals above) — read $LOGS/BUILD-plan.txt; the refusal is the deliverable, do not silence it with a guess"
fi
ok "plan clean (zero refusals)"
node scripts/b12-manifest.mjs build b12-corpus/manifest-config.json --pilot-only > "$LOGS/BUILD.txt" 2>&1
RC=$?
if [ "$RC" -ne 0 ] || grep -q "REFUSED" "$LOGS/BUILD.txt"; then
  grep -n "REFUSED" "$LOGS/BUILD.txt" | head -5 | sed 's/^/   /'
  fail_step BUILD "$RC" "manifest build exited $RC (refusals above) — read $LOGS/BUILD.txt"
fi

# Exactly five, one per task in the committed order, every one UNTRACKED —
# _beforeYouBuild 2: a committed pilot manifest makes the later full build
# refuse on all five.
MCOUNT=0
for f in "$REPO/evidence/$PILOT_RUN_ID".b12.pilot-*.manifest.json; do
  [ -f "$f" ] && MCOUNT=$((MCOUNT + 1))
done
[ "$MCOUNT" -eq 5 ] || fail_step BUILD 1 "expected exactly 5 files at evidence/$PILOT_RUN_ID.b12.pilot-*.manifest.json, found $MCOUNT — read $LOGS/BUILD.txt"
for TASK in $PILOT_TASKS; do
  MF="evidence/$PILOT_RUN_ID.b12.pilot-$TASK.manifest.json"
  [ -f "$REPO/$MF" ] || fail_step BUILD 1 "no manifest for task $TASK at $MF — the build and the config's pilot array disagree; read $LOGS/BUILD.txt"
  if git ls-files --error-unmatch "$MF" >/dev/null 2>&1; then
    fail_step BUILD 1 "$MF is TRACKED — pilot manifests must stay untracked (_beforeYouBuild 2, the full build refuses on tracked output paths); adjudicate how it got committed, do not git rm blindly"
  fi
done
record BUILD ran 0 "pilotRunId $PILOT_RUN_ID; 5 manifests built, all untracked"
ok "5 manifests for $PILOT_RUN_ID, all untracked"

# ---------------------------------------------------------------------------
say "M5 — the pre-flight (1 cheap scratch session)"
CURRENT_STEP=M5
# HEAD HAS MOVED by the two commits above, so the expectation passed to the
# pre-flight is the CURRENT head — its offline check is HEAD == B12_EXPECT_SHA.
NEW_HEAD=$(git rev-parse HEAD)
B12_EXPECT_SHA="$NEW_HEAD" bash scripts/b12-preflight-mac.sh "$REPO" > "$LOGS/M5.txt" 2>&1
RC=$?
tail -8 "$LOGS/M5.txt" | sed 's/^/   /'
[ "$RC" -eq 0 ] || fail_step M5 "$RC" "the pre-flight refused or failed (exit $RC) — read $LOGS/M5.txt; its artifact (if any) says which check"

# The session id comes out of the artifact THIS phase produced. evidence/ is
# canonical; the Desktop copy is the fallback when evidence/ somehow lacks one.
PRE_ART=""
for f in "$REPO/evidence/"*.preflight.json "$HOME/Desktop/"*.preflight.json; do
  [ -f "$f" ] || continue
  [ "$f" -nt "$P2_MARKER" ] || continue
  if [ -z "$PRE_ART" ] || [ "$f" -nt "$PRE_ART" ]; then PRE_ART="$f"; fi
done
[ -n "$PRE_ART" ] || fail_step M5 1 "the pre-flight exited 0 but no *.preflight.json newer than this phase's start exists in evidence/ or ~/Desktop — read $LOGS/M5.txt; do not reuse an older artifact's session"
SESSION_ID=$(node -e '
const a = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const s = a && a.context && a.context.sessionId;
if (typeof s !== "string" || !s) process.exit(1);
process.stdout.write(s);
' "$PRE_ART" 2>/dev/null)
RC=$?
[ "$RC" -eq 0 ] || fail_step M5 "$RC" "could not read context.sessionId from $PRE_ART — the artifact's shape moved; read it by hand"
case "$SESSION_ID" in
  ????????-????-????-????-????????????) : ;;
  *) fail_step M5 1 "context.sessionId in $(basename "$PRE_ART") is \"$SESSION_ID\", not a uuid — the preflights below would join against garbage; adjudicate" ;;
esac
record M5 ran 0 "pre-flight passed; session $SESSION_ID from $(basename "$PRE_ART")"
ok "session $SESSION_ID (from $(basename "$PRE_ART"))"

# ---------------------------------------------------------------------------
say "PREFLIGHT x5 — every manifest against the scratch session"
for TASK in $PILOT_TASKS; do
  CURRENT_STEP="PF-$TASK"
  MF="evidence/$PILOT_RUN_ID.b12.pilot-$TASK.manifest.json"
  node scripts/b12-run.mjs preflight --manifest "$MF" --session "$SESSION_ID" --out "$OUT/preflight-$TASK.json" > "$LOGS/PF-$TASK.txt" 2>&1
  RC=$?
  if [ "$RC" -ne 0 ]; then
    printf '   failing lines from logs/PF-%s.txt:\n' "$TASK"
    grep -iE 'fail|refus' "$LOGS/PF-$TASK.txt" | head -20 | sed 's/^/      /'
    tail -5 "$LOGS/PF-$TASK.txt" | sed 's/^/      /'
    fail_step "PF-$TASK" "$RC" "preflight for $TASK exited $RC (failing checks above) — every one of the five must pass before any paid session; fix the cause, then adjudicate the P2 re-run (two commits already landed)"
  fi
  record "PF-$TASK" ran 0 "preflight ok"
  ok "$TASK"
done

# ---------------------------------------------------------------------------
CURRENT_STEP=CHECK2
DIFF_NAMES=$(git diff --name-only "$EXPECT_SHA..HEAD" 2>/dev/null)
DIFF_COUNT=$(printf '%s\n' "$DIFF_NAMES" | grep -c '[^[:space:]]' || true)
[ "$DIFF_COUNT" = "2" ] || { printf '%s\n' "$DIFF_NAMES" | sed 's/^/      /'; fail_step CHECK2 1 "the diff surface pin..HEAD is $DIFF_COUNT file(s), not the exact 2 (probe artifact + manifest-config) Q insists on — adjudicate before going further; Q will refuse this tree"; }

# THE PINNED LINE REPORTS THE SEALED STATE — the treatment blob COMMIT2 pinned
# into the config — never the environment and never the policy repo's HEAD.
SEALED_REF=$(node -e '
const c = JSON.parse(require("node:fs").readFileSync("b12-corpus/manifest-config.json", "utf8"));
const t = c.pinned && c.pinned.policyBlobs && c.pinned.policyBlobs.treatment;
if (!t || typeof t.commit !== "string" || !t.commit || typeof t.path !== "string" || !t.path) process.exit(1);
process.stdout.write(t.commit + ":" + t.path);
' 2>/dev/null)
RC=$?
[ "$RC" -eq 0 ] || fail_step CHECK2 "$RC" "b12-corpus/manifest-config.json carries no policyBlobs.treatment.{commit,path} — the fill did not seal the treatment blob; adjudicate before pasting any checkpoint"
SEALED_TREATMENT=$(git -C "$HOME/b12-policy" cat-file blob "$SEALED_REF" 2>/dev/null)
RC=$?
[ "$RC" -eq 0 ] || fail_step CHECK2 "$RC" "cannot read the sealed treatment blob $SEALED_REF from ~/b12-policy — the sealed commit must exist in the policy repo; adjudicate (was the clone moved or rewound after the fill?)"
SEALED_PIN_ID=$(printf '%s\n' "$SEALED_TREATMENT" | grep -o 'Always pass model: "[^"]*"' | head -1 | sed 's/^Always pass model: "//; s/"$//')
if [ -n "$SEALED_PIN_ID" ]; then
  PIN_LINE="PINNED (sealed clause): $SEALED_PIN_ID"
else
  PIN_LINE="no pin (selection decides)"
fi
record CHECK2 ran 0 "diff surface pin..HEAD is exactly 2 files; sealed treatment blob readable"

CURRENT_STEP=""
trap - INT TERM
package_round

M8_SUMMARY=$(node -e '
const a = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const d = Array.isArray(a.deltasTokens) ? a.deltasTokens.join(", ") : "?";
process.stdout.write(`sustained=${a.sustained}  deltas(tokens)=[${d}]  installedCharsAdapter=${a.installedCharsAdapter}  branch=${a.verdictBranch}`);
' "$M8_ART" 2>/dev/null) || M8_SUMMARY="(could not re-read $M8_ART — open it by hand)"
# PIN_LINE was derived at CHECK2 from the SEALED treatment blob, never from
# the environment or the policy repo's HEAD.

say "CHECKPOINT 2 — paste the block below to the orchestrator, then WAIT"
printf '\n'
printf '=================== B12 PILOT CHECKPOINT 2 (paste this whole block) ===================\n'
printf 'phase          P2 complete — ~8 cheap sessions spent, two local commits made\n'
printf 'HEAD           %s\n' "$(git rev-parse HEAD)"
printf 'pin            %s\n' "$EXPECT_SHA"
printf 'commits since the pin:\n'
git log --format='  %h %s' "$EXPECT_SHA..HEAD"
printf 'diff surface (must be exactly 2 files):\n'
git diff --stat "$EXPECT_SHA..HEAD" | sed 's/^/  /'
printf 'M8             %s\n' "$M8_SUMMARY"
printf '  artifact     %s\n' "$M8_REL"
printf 'policy         commit %s\n' "$POLICY_COMMIT"
printf '  %s\n' "$PIN_LINE"
printf 'pilotRunId     %s\n' "$PILOT_RUN_ID"
printf 'manifests (sha256 first 12):\n'
for TASK in $PILOT_TASKS; do
  MF="evidence/$PILOT_RUN_ID.b12.pilot-$TASK.manifest.json"
  printf '  %s  %s\n' "$(sha_of "$REPO/$MF" | cut -c1-12)" "$MF"
done
printf 'preflights (tail of each log):\n'
for TASK in $PILOT_TASKS; do
  printf '  -- %s --\n' "$TASK"
  tail -2 "$LOGS/PF-$TASK.txt" | sed 's/^/     /'
done
printf '\n'
printf 'GO = run `bash scripts/b12-pilot-run-mac.sh`; NO-GO = send this block and wait.\n'
printf '=======================================================================================\n'
printf '\nDo not run phase Q until the orchestrator answers GO — Q spends the five PAID\npilot sessions.\n\n'
exit 0
