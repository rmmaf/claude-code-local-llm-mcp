#!/usr/bin/env bash
#
# b12-pilot-p1-mac.sh — B12 pilot, phase P1: gate + environment facts +
# targeted model-fit measurement + CHECKPOINT 1.
#
#   bash scripts/b12-pilot-p1-mac.sh [/path/to/unpacked/clone]
#
# SPENDS NOTHING. No paid session, no commit, no network git. Its whole job is
# to prove the machine and the tree are exactly what the pins say, measure
# which local models FIT (the owner-ordered targeted measurement, 2026-08-17),
# and print CHECKPOINT 1 for the operator to paste to the orchestrator. The
# first phase that spends anything is P2 (~8 cheap sessions), and P2 refuses to
# start unless this phase's ledger exists with no failed row.
#
# IT REFUSES RATHER THAN IMPROVISES, and every refusal names the next action:
# a refusal here is cheap, a wasted paid session is expensive, and a silently
# wrong measurement is worst of all.
#
# Bash 3.2 compatible (macOS default). No associative arrays, no ${x,,},
# no GNU-only flags.

set -u
set -o pipefail

# THE BINARY MAY NOT MOVE UNDER US. The gate records claude's version and
# digest against pins measured for 2.1.221; an auto-update between P1 and Q
# would make the pilot describe two binaries while looking like one run.
export DISABLE_AUTOUPDATER=1

# THE PINS THIS PHASE COMPARES THE LIVE MACHINE AGAINST. All were measured and
# committed on the authoring side (manifest-config.json `pinned`, the policy
# bundle baseline); none is guessed here.
CLAUDE_VER_PIN="2.1.221"
CLAUDE_SHA_PIN="7a181f36ed0fc4fbac6cee4ecf2b615eff93d8b434221fff5d7c878dc5ebf380"
MCP_SHA_PIN="2acd39a05a0ed999a26de49171148c271d5b585d6443f2def0ae5fb42fc9973c"
SNAPSHOT_SHA_PIN="b1a185159b59805d30af78c108b704cfe182be232a0bb867caf558392c686528"
POLICY_BASELINE="3d0bccb3aa390b363058543469c05dd6140ce9c1"
POLICY_TREATMENT_SHA="74feef2ee19380dca4eaf3245ac4c1518c71187bd533fe5bba71d3c2f49188b6"
POLICY_CONTROL_SHA="30c024fe1c5f0a8e922f76a5194d491a768c647e42f9a95c08f8a9e087eab5fb"

# ---------------------------------------------------------------------------
# Locate and canonicalise the tree BEFORE building any "$REPO/..." path.
# `pwd -P` also resolves /var -> /private/var — both lessons already cost a
# Mac session each (see scripts/b12-mac-round.sh:43-57).
if [ "${1:-}" != "" ]; then REPO="$1"; else REPO=$(git rev-parse --show-toplevel 2>/dev/null); fi
[ -n "${REPO:-}" ] || { printf 'REFUSED — no git work tree here and no path given. cd into the unpacked clone at ~/b12-tree (or pass its path) and re-run.\n'; exit 2; }
cd "$REPO" || { printf 'REFUSED — cannot cd to %s. Pass the unpacked clone path and re-run.\n' "$REPO"; exit 2; }
REPO=$(pwd -P)

# THE UNPACK PATH IS PART OF THE PIN. The committed .b12-mcp.json embeds
# args[0] = /Users/rodrigomonteiro/b12-tree/dist/server.js, so a clone at any
# other path makes the mcp-config sha describe a config that points somewhere
# else — the sha would still match while the meaning lied.
if [ "$REPO" != "$HOME/b12-tree" ]; then
  printf 'REFUSED — this clone is at %s\nbut the pinned .b12-mcp.json embeds %s/b12-tree/dist/server.js,\nso any other path makes the mcp-config sha lie.\n' "$REPO" "$HOME"
  printf 'Unpack at ~/b12-tree exactly:\n  mkdir -p ~/b12-tree && tar -xzf <archive>.tgz -C ~/b12-tree\n  cd ~/b12-tree && bash scripts/b12-pilot-p1-mac.sh\n'
  exit 2
fi

OUT="$REPO/b12-pilot-round"
LOGS="$OUT/logs"
# THE RETRACT MARKER OUTRANKS THE MOVE-ASIDE. P2 and Q refuse on it, but this
# script used to relocate the whole round directory unconditionally — so
# "re-run P1, it spends nothing" (a documented recovery) would carry the
# marker away in b12-pilot-round-prev-* and unlock a fresh seven-session
# re-probe of the SAME pinned tree, letting a later sustained=true supersede
# the pre-declared false. Found by the R1 verifier's stated attack.
if [ -f "$OUT/.retract" ]; then
  RETRACT_LINE=$(cat "$OUT/.retract" 2>/dev/null || printf 'RETRACT (unreadable)')
  printf 'REFUSED — the pre-declared retract branch was already taken in this tree:\n  %s\n' "$RETRACT_LINE"
  printf 'This round is OVER; adjudication happens off-Mac. A new round requires a fresh\n'
  printf 'cut and pin — unpack the NEW archive at ~/b12-tree (this tree keeps the retract\n'
  printf 'evidence; send %s home as it is).\n' "$OUT"
  exit 2
fi
# A PRIOR ROUND'S STATE IS MOVED ASIDE, NEVER DELETED — evidence of paid
# measurements has been erased by an rm here before (b12-mac-round.sh:61-73).
if [ -e "$OUT" ]; then
  PREV="$OUT-prev-$(date -u +%Y%m%d-%H%M%S)"
  [ -e "$PREV" ] && PREV="$PREV-$$"
  mv "$OUT" "$PREV" || { printf 'REFUSED — %s exists and cannot be moved aside. Move it by hand, then re-run.\n' "$OUT"; exit 2; }
  printf '   ! a previous pilot round left state at %s — moved to %s, nothing deleted\n' "$OUT" "$PREV"
fi
mkdir -p "$LOGS" || { printf 'REFUSED — cannot create %s. Check permissions and disk space, then re-run.\n' "$OUT"; exit 2; }

# One line per step: "ID<TAB>STATUS<TAB>EXIT<TAB>NOTE"; vocabulary is closed
# (ran|failed|skipped). P2 and Q append to THIS ledger — it is the round's.
LEDGER="$OUT/ledger.tsv"
: > "$LEDGER"

# THE ROUND'S ZERO MARK. Later phases compare artifact mtimes against their
# own phase markers; this one records when the round opened.
MARKER="$OUT/.round-start"
: > "$MARKER"

say()   { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()    { printf '   + %s\n' "$*"; }
warn()  { printf '   ! %s\n' "$*"; }
die()   { printf '\nREFUSED — %s\n\nNothing was measured. Fix the above and re-run; the gate is idempotent.\n' "$*"; exit 1; }
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$LEDGER"; }
sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }
is_hex64() { [ "${#1}" -eq 64 ] || return 1; case "$1" in *[!0-9a-f]*) return 1 ;; esac; return 0; }

# ---------------------------------------------------------------------------
say "GATE — the tree this pilot measures"

command -v git  >/dev/null 2>&1 || die "git not found — install the Xcode command line tools, then re-run"
command -v node >/dev/null 2>&1 || die "node not found — install node 22, then re-run"
command -v npm  >/dev/null 2>&1 || die "npm not found — install node 22 (npm ships with it), then re-run"
ok "git, node, npm present"

# THE PIN TRAVELS WITH THE ARCHIVE (written by the cut script); it is not
# baked into this file, which went stale once before it was ever run.
PIN_FILE="$REPO/.b12-round-pin"
if [ -n "${B12_EXPECT_SHA:-}" ]; then
  EXPECT_SHA="$B12_EXPECT_SHA"
  PIN_FROM="B12_EXPECT_SHA"
elif [ -f "$PIN_FILE" ]; then
  EXPECT_SHA=$(tr -d ' \t\r\n' < "$PIN_FILE")
  PIN_FROM=".b12-round-pin"
else
  die "no .b12-round-pin in $REPO and no B12_EXPECT_SHA set — this archive does not say which commit it is supposed to be. Re-cut it with scripts/b12-cut-mac-archive.mjs, or set B12_EXPECT_SHA=<40-hex> if you know the pin"
fi
case "$EXPECT_SHA" in
  ????????????????????????????????????????) : ;;
  *) die "the pin from $PIN_FROM is not a full 40-character sha (got \"$EXPECT_SHA\") — re-cut the archive rather than guessing" ;;
esac

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null)
[ "$HEAD_SHA" = "$EXPECT_SHA" ] || die "HEAD is \"$HEAD_SHA\" but $PIN_FROM says \"$EXPECT_SHA\". This is not the tree it claims to be — re-cut (archive mode) or re-clone and re-check the pinned sha (clone mode) rather than measuring an unknown tree"
ok "at the pinned commit $(git rev-parse --short HEAD) (pin from $PIN_FROM)"

# CLONE MODE PERSISTS THE PIN. A weekday round arrives by `git clone`, not by
# archive, so no cut script ever wrote .b12-round-pin — the operator passes
# B12_EXPECT_SHA once, to THIS phase. P2 and Q read the file as their fallback,
# and a forgotten env var there would refuse a round P1 already verified; the
# file is written only AFTER the HEAD check above proved the sha names this
# very tree, which is exactly the fact the cut script proves before writing it.
if [ "$PIN_FROM" = "B12_EXPECT_SHA" ] && [ ! -f "$PIN_FILE" ]; then
  printf '%s\n' "$EXPECT_SHA" > "$PIN_FILE" \
    || die "could not persist the pin to $PIN_FILE — P2 and Q would each need B12_EXPECT_SHA by hand"
  ok "pin persisted to .b12-round-pin for P2 and Q (clone mode)"
fi

# THE EOL SETTINGS ARE WRITTEN INTO THE CLONE'S OWN CONFIG, both modes. The
# cut script does this for archive mode because `git clone -c` does not
# persist; a weekday `git clone` arrives with an EMPTY local config, and M4's
# pristine worktrees check out under whatever this repo's config says — so an
# unset value falls through to the machine's global autocrlf. Idempotent for
# archive mode (the cut already wrote the same values).
git config --local core.autocrlf false || die "cannot write core.autocrlf into the clone's config"
git config --local core.eol lf || die "cannot write core.eol into the clone's config"

# TRACKED changes only; EXIT CODE checked before the count; stderr kept out of
# the porcelain stream (all three lessons at b12-mac-round.sh:146-166).
GIT_STATUS_ERR="$OUT/.git-status-stderr"
GIT_STATUS_OUT=$(git status --porcelain --untracked-files=no 2>"$GIT_STATUS_ERR")
GIT_STATUS_RC=$?
[ "$GIT_STATUS_RC" -eq 0 ] || die "git status failed (exit $GIT_STATUS_RC): $(cat "$GIT_STATUS_ERR" 2>/dev/null) — an uninspected tree must not read as a clean one"
rm -f "$GIT_STATUS_ERR"
DIRTY=$(printf '%s\n' "$GIT_STATUS_OUT" | grep -c '[^[:space:]]' || true)
[ "$DIRTY" = "0" ] || {
  git status --porcelain --untracked-files=no | head -20
  die "$DIRTY tracked file(s) differ from the commit. If they are all source files the archive was cut with CRLF line endings — ask for a re-cut rather than committing over it"
}
ok "no tracked changes"

say "GATE — build"
npm ci --silent >/dev/null 2>&1 || die "npm ci failed — run it by hand to see why (network for the npm registry is required once)"
npm run build --silent >/dev/null 2>&1 || die "npm run build failed — run it by hand to see why"
for f in dist/server.js dist/cost/b12/capture.js dist/cost/cli.js; do
  [ -f "$f" ] || die "$f is missing after a build that reported success — run \`npm run build\` by hand and read its output"
done
ok "installed and built (dist/server.js, dist/cost/b12/capture.js, dist/cost/cli.js present)"

# npm ci runs `prepare` -> hooks:install -> `git config core.hooksPath
# .githooks`. A global npm ignore-scripts=true silently defeats that, and P2's
# two commits then run without the pins-check hook.
HOOKS_PATH=$(git config --get core.hooksPath 2>/dev/null)
[ "$HOOKS_PATH" = ".githooks" ] || die "git core.hooksPath is \"$HOOKS_PATH\", expected .githooks. npm ci should have installed it via the prepare script — check \`npm config get ignore-scripts\` (true silently defeats it), then run \`npm run hooks:install\` and re-run"
ok "core.hooksPath is .githooks (pre-commit pins-check will run for P2's commits)"

say "GATE — binary facts vs pins (the live machine, not a recollection)"
command -v claude >/dev/null 2>&1 || die "claude is not on PATH — install Claude Code $CLAUDE_VER_PIN, then re-run"
CLAUDE_VER=$(claude --version 2>/dev/null)
CV_RC=$?
[ "$CV_RC" -eq 0 ] || die "claude --version exited $CV_RC — the version is part of the evidence and may not be guessed; fix the install, then re-run"
CLAUDE_VER=$(printf '%s' "$CLAUDE_VER" | head -1)
case "$CLAUDE_VER" in
  *"$CLAUDE_VER_PIN"*) : ;;
  *) die "claude --version says \"$CLAUDE_VER\" but the pins were measured for $CLAUDE_VER_PIN. The binary moved — restore claude $CLAUDE_VER_PIN or re-probe cap+installedChars before any run" ;;
esac
CLAUDE_BIN=$(command -v claude)
CLAUDE_SHA=$(sha_of "$CLAUDE_BIN")
[ "$CLAUDE_SHA" = "$CLAUDE_SHA_PIN" ] || die "the claude binary at $CLAUDE_BIN hashes to $CLAUDE_SHA, but the pin is $CLAUDE_SHA_PIN. The binary moved — restore claude $CLAUDE_VER_PIN or re-probe cap+installedChars before any run"
ok "claude $CLAUDE_VER, binary sha256 matches the pin"

NODE_VER=$(node --version 2>/dev/null)
case "$NODE_VER" in
  v22.23.*) : ;;
  *) die "node --version says \"$NODE_VER\" but the pinned run toolchain is v22.23.x — the manifest will refuse every observe on this machine. Install node v22.23, then re-run" ;;
esac
VITEST_VER=$(npx vitest --version 2>/dev/null | tail -1)
case "$VITEST_VER" in
  *vitest/4.1*) : ;;
  *) die "npx vitest --version says \"$VITEST_VER\" but the pinned run toolchain is vitest/4.1 — re-run npm ci (the lockfile pins it) and check what \`npx vitest --version\` prints" ;;
esac
ok "node $NODE_VER, $VITEST_VER — both match the pinned run toolchain"

# ---------------------------------------------------------------------------
# PACKAGING IS A FUNCTION, DEFINED BEFORE ANY STEP RUNS, so the signal handler
# can call it. P1 cuts NO tarball: summary.json and ledger.tsv stay on disk —
# they are P2's and Q's gate inputs. Body not re-indented: the heredoc's JS
# terminator must sit at column 0.
package_round() {
say "Summary"

node - "$LEDGER" "$OUT/summary.json" "$HEAD_SHA" "$EXPECT_SHA" <<'JS'
const { readFileSync, writeFileSync } = require("node:fs");
const [, , ledger, out, sha, pin] = process.argv;
const rows = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => {
  const [id, status, exit, note] = l.split("\t");
  return { id, status, exit: exit === "" ? null : Number(exit), note };
});
// THE VOCABULARY IS CLOSED — a status this reader does not know is a defect,
// not a row to drop (b12-mac-round.sh:196-210).
const KNOWN = ["ran", "failed", "skipped"];
const unknown = rows.filter((r) => !KNOWN.includes(r.status));
if (unknown.length) {
  console.error(
    `REFUSED: ledger carries ${unknown.length} row(s) with a status this reader does not ` +
      `know (${[...new Set(unknown.map((r) => r.status))].join(", ")}).`
  );
  process.exit(2);
}
const summary = {
  document: "b12-pilot-round",
  phase: "P1",
  commit: sha,
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

ok "summary.json and ledger.tsv stay at $OUT — P2 and Q read them in place; no tarball for P1"
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

# A step failure is FATAL in P1: every later step and both later phases would
# be reasoning from an unverified premise. The row is written, the summary is
# written, and the exit is nonzero so nothing downstream mistakes this for done.
fail_step() { # fail_step <id> <exit> <note-and-next-action>
  record "$1" failed "$2" "$3"
  printf '\nREFUSED — %s\n' "$3"
  package_round
  exit 1
}

# ---------------------------------------------------------------------------
say "M-CORPUS — the pilot plan's corpus, verified deep"
CURRENT_STEP=M-CORPUS
[ -f "b12-corpus/pilot-plan.json" ] || fail_step M-CORPUS 1 "b12-corpus/pilot-plan.json does not exist in this archive — re-cut the archive from a tree that has it"
node scripts/b12-author.mjs verify-corpus b12-corpus/pilot-plan.json --deep > "$LOGS/M-CORPUS.txt" 2>&1
RC=$?
tail -4 "$LOGS/M-CORPUS.txt" | sed 's/^/   /'
[ "$RC" -eq 0 ] || fail_step M-CORPUS "$RC" "verify-corpus failed (exit $RC) — read $LOGS/M-CORPUS.txt; the corpus tags may not have been transported (see _transport in b12-corpus/manifest-config.json)"
record M-CORPUS ran 0 "verify-corpus --deep green"
ok "corpus verified"

# ---------------------------------------------------------------------------
say "M-POLICY — the out-of-repo policy bundle, cloned and proven"
CURRENT_STEP=M-POLICY
# Resolution order: explicit env, then the COMMITTED copy (the weekday default
# — it rides the clone, so the one-command entry needs no side files), then the
# legacy ~/Downloads drop. What must stay OUT of this repo is the CLONED policy
# repo at ~/b12-policy (findPolicyBlob refuses an in-repo resolution); the
# bundle is transport bytes, and the blobs' provenance is the policy repo
# commit it carries, not the medium it rode.
if [ -n "${B12_POLICY_BUNDLE:-}" ]; then
  BUNDLE="$B12_POLICY_BUNDLE"
elif [ -f "$REPO/b12-corpus/policy-transport/b12-policy.bundle" ]; then
  BUNDLE="$REPO/b12-corpus/policy-transport/b12-policy.bundle"
else
  BUNDLE="$HOME/Downloads/b12-policy.bundle"
fi
[ -f "$BUNDLE" ] || fail_step M-POLICY 1 "no policy bundle at $BUNDLE — expected it committed at b12-corpus/policy-transport/ (or copy one to ~/Downloads, or set B12_POLICY_BUNDLE=<path>), then re-run"

# The sidecar sha256 is verified when present. Both formats tolerated:
# `<hex>  <name>` (shasum -c style) and a bare hex line.
SIDECAR="$BUNDLE.sha256"
if [ -f "$SIDECAR" ]; then
  WANT=$(head -1 "$SIDECAR" | awk '{print $1}')
  is_hex64 "$WANT" || fail_step M-POLICY 1 "$SIDECAR exists but its first token is not a 64-hex sha256 (got \"$WANT\") — fix or remove the sidecar, then re-run"
  GOT=$(sha_of "$BUNDLE")
  [ "$GOT" = "$WANT" ] || fail_step M-POLICY 1 "the bundle hashes to $GOT but $SIDECAR says $WANT — the bundle was corrupted in transport; re-copy it, then re-run"
  ok "bundle sha256 matches its sidecar"
else
  warn "no $SIDECAR — bundle integrity rests on the clone checks below"
fi

if [ -e "$HOME/b12-policy" ]; then
  PPREV="$HOME/b12-policy-prev-$(date -u +%Y%m%d-%H%M%S)"
  [ -e "$PPREV" ] && PPREV="$PPREV-$$"
  mv "$HOME/b12-policy" "$PPREV" || fail_step M-POLICY 1 "$HOME/b12-policy exists and cannot be moved aside — move it by hand, then re-run"
  warn "a previous ~/b12-policy was moved to $PPREV — nothing deleted"
fi

git clone --quiet "$BUNDLE" "$HOME/b12-policy" > "$LOGS/M-POLICY.txt" 2>&1
RC=$?
[ "$RC" -eq 0 ] || fail_step M-POLICY "$RC" "git clone of the bundle failed (exit $RC) — read $LOGS/M-POLICY.txt; the bundle may be truncated, re-copy it"

SHALLOW=$(git -C "$HOME/b12-policy" rev-parse --is-shallow-repository 2>/dev/null)
[ "$SHALLOW" = "false" ] || fail_step M-POLICY 1 "the policy clone reports --is-shallow-repository=$SHALLOW — findPolicyBlob refuses a shallow clone; re-create the bundle with --all and re-run"

POLICY_HEAD=$(git -C "$HOME/b12-policy" rev-parse HEAD 2>/dev/null)
[ "$POLICY_HEAD" = "$POLICY_BASELINE" ] || fail_step M-POLICY 1 "policy HEAD is $POLICY_HEAD but the shipped baseline is $POLICY_BASELINE — the bundle carries the wrong tip; re-cut the bundle from the baseline and re-send"

# Blob shas recomputed from the OBJECT STORE, not from the checkout — the
# checkout can drift (line endings, editors); the object store cannot.
T_GOT=$(git -C "$HOME/b12-policy" cat-file blob HEAD:treatment.md | shasum -a 256 | awk '{print $1}')
C_GOT=$(git -C "$HOME/b12-policy" cat-file blob HEAD:control.md | shasum -a 256 | awk '{print $1}')
[ "$T_GOT" = "$POLICY_TREATMENT_SHA" ] || fail_step M-POLICY 1 "treatment.md blob is $T_GOT, shipped value is $POLICY_TREATMENT_SHA — the bundle's content is not the sealed baseline; re-cut and re-send it"
[ "$C_GOT" = "$POLICY_CONTROL_SHA" ] || fail_step M-POLICY 1 "control.md blob is $C_GOT, shipped value is $POLICY_CONTROL_SHA — the bundle's content is not the sealed baseline; re-cut and re-send it"
record M-POLICY ran 0 "cloned at $POLICY_BASELINE, full clone, both blob shas match"
ok "~/b12-policy at $(git -C "$HOME/b12-policy" rev-parse --short HEAD), both blobs match the shipped shas"

# ---------------------------------------------------------------------------
say "M-MCP — the committed MCP config, byte-pinned and pointing HERE"
CURRENT_STEP=M-MCP
[ -f "$REPO/.b12-mcp.json" ] || fail_step M-MCP 1 ".b12-mcp.json is missing at the repo root — the archive was cut wrong; re-cut and re-send it"
MCP_GOT=$(sha_of "$REPO/.b12-mcp.json")
[ "$MCP_GOT" = "$MCP_SHA_PIN" ] || fail_step M-MCP 1 ".b12-mcp.json hashes to $MCP_GOT but the pin is $MCP_SHA_PIN — the config's bytes moved; re-cut the archive rather than editing it here"
# STRING EQUALITY, not existsSync: findMcpConfig never checks args[0], so this
# is the one place the embedded path is compared to the tree actually running.
node -e '
const cfg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const s = cfg.mcpServers && cfg.mcpServers["local-coder"];
if (!s) { console.error("no mcpServers[\"local-coder\"] entry"); process.exit(1); }
if (s.command !== "node") { console.error(`command is ${JSON.stringify(s.command)}, expected "node"`); process.exit(1); }
const want = process.argv[2] + "/dist/server.js";
if (!Array.isArray(s.args) || s.args[0] !== want) {
  console.error(`args[0] is ${JSON.stringify(s.args && s.args[0])}, expected ${JSON.stringify(want)}`);
  process.exit(1);
}
' "$REPO/.b12-mcp.json" "$REPO" > "$LOGS/M-MCP.txt" 2>&1
RC=$?
[ "$RC" -eq 0 ] || { cat "$LOGS/M-MCP.txt" | sed 's/^/   /'; fail_step M-MCP "$RC" ".b12-mcp.json does not point at THIS tree's dist/server.js (details above) — the clone is not at the pinned path, or the config moved; unpack at ~/b12-tree exactly and re-run"; }
record M-MCP ran 0 "sha matches pin; command=node; args[0] points at this tree"
ok "mcp config sha $MCP_GOT, args[0] == $REPO/dist/server.js"

# ---------------------------------------------------------------------------
say "M-SNAPSHOT — the memory snapshot hash, after sweeping Finder junk"
CURRENT_STEP=M-SNAPSHOT
# .DS_Store is gitignored, so git status stays clean while the directory hash
# moves — the exact hazard _macLocal.memorySnapshot names. Deleted, not moved:
# it is Finder-materialised junk this machine created, not evidence.
[ -d "$REPO/b12-corpus/memory-snapshot" ] || fail_step M-SNAPSHOT 1 "b12-corpus/memory-snapshot does not exist — the archive was cut wrong (hashMemoryDir would hash an empty list and blame the pin); re-cut and re-send it"
find "$REPO/b12-corpus/memory-snapshot" -name .DS_Store -delete 2>/dev/null
SNAP_LINE=$(node - "$REPO" 2>&1 <<'JS'
const path = require("node:path");
const { pathToFileURL } = require("node:url");
(async () => {
  const repo = process.argv[2];
  const mod = await import(pathToFileURL(path.join(repo, "scripts", "b12-run.mjs")).href);
  const r = mod.hashMemoryDir(path.join(repo, "b12-corpus", "memory-snapshot"));
  // A SENTINEL LINE, matched exactly by the caller — stderr noise merged into
  // the capture must not be readable as a hash.
  process.stdout.write(`SNAPSHOT ${r.sha256} ${r.files}\n`);
})().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
JS
)
RC=$?
[ "$RC" -eq 0 ] || fail_step M-SNAPSHOT "$RC" "could not hash the snapshot via hashMemoryDir ($(printf '%s' "$SNAP_LINE" | tr '\n\t' '  ' | cut -c1-200)) — check that scripts/b12-run.mjs still exports it"
SNAP_SHA=$(printf '%s\n' "$SNAP_LINE" | sed -n 's/^SNAPSHOT \([0-9a-f]\{64\}\) \([0-9][0-9]*\)$/\1/p' | head -1)
SNAP_FILES=$(printf '%s\n' "$SNAP_LINE" | sed -n 's/^SNAPSHOT \([0-9a-f]\{64\}\) \([0-9][0-9]*\)$/\2/p' | head -1)
[ -n "$SNAP_SHA" ] || fail_step M-SNAPSHOT 1 "the snapshot hasher exited 0 but printed no SNAPSHOT sentinel ($(printf '%s' "$SNAP_LINE" | tr '\n\t' '  ' | cut -c1-200)) — a hash that cannot be read must not be compared"
if [ "$SNAP_SHA" != "$SNAPSHOT_SHA_PIN" ]; then
  printf '   files in the snapshot dir:\n'
  find "$REPO/b12-corpus/memory-snapshot" -type f | sed 's/^/      /'
  fail_step M-SNAPSHOT 1 "memory snapshot hashes to $SNAP_SHA ($SNAP_FILES file(s)) but the pin is $SNAPSHOT_SHA_PIN — the committed snapshot moved or the dir carries extra files (list above); re-cut the archive rather than editing here"
fi
record M-SNAPSHOT ran 0 "hash matches pin ($SNAP_FILES file(s), .DS_Store swept)"
ok "snapshot hash matches the pin ($SNAP_FILES file(s))"

# ---------------------------------------------------------------------------
say "M-MODEL — the targeted model-fit measurement (owner-ordered 2026-08-17)"
CURRENT_STEP=M-MODEL
command -v lms >/dev/null 2>&1 || fail_step M-MODEL 1 "the lms CLI is missing — without it there is no local model and checkpoint 1 cannot answer the owner's question; install LM Studio's CLI, then re-run"
# No-op if already up; the measurement is about MODELS, not a stopped server.
lms server start >/dev/null 2>&1 || true
UNLOAD_OUT=$(lms unload --all 2>&1)
UNLOAD_RC=$?
{ printf 'lms unload --all -> exit %s\n%s\n\nlms ps:\n' "$UNLOAD_RC" "$UNLOAD_OUT"; lms ps 2>&1; } > "$LOGS/M-MODEL-lms.txt"
[ "$UNLOAD_RC" -eq 0 ] && ok "lms unload --all (RAM freed; the fit question is about the MODEL, not the leftovers)" || warn "lms unload --all exited $UNLOAD_RC — free RAM may be understated; see logs/M-MODEL-lms.txt"

# The import/config pattern is scripts/b12-repair-pace.mjs:100-140's, reused
# rather than re-implemented — the product's own answer, not a second opinion.
node - "$REPO" "$LOGS/M-MODEL.txt" "$LOGS/M-MODEL-digest.txt" > "$LOGS/M-MODEL-probe.log" 2>&1 <<'JS'
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { writeFileSync } = require("node:fs");
(async () => {
  const [, , repo, outFile, digestFile] = process.argv;
  const load = (rel) => import(pathToFileURL(path.join(repo, ...rel.split("/"))).href);
  const { loadConfig } = await load("dist/config.js");
  const config = loadConfig();
  const { loadModelCatalog } = await load("dist/models-csv.js");
  const { runStatus } = await load("dist/tools/status.js");
  config.models = await loadModelCatalog(config.modelsCsvPath);
  const status = await runStatus(config);
  writeFileSync(outFile, JSON.stringify(status, null, 2) + "\n", "utf8");
  const lines = [];
  lines.push(`endpoint reachable: ${status.reachable === true}   lms available: ${status.lms_available === true}`);
  const free = status.memory ? status.memory.usable_free_gb : null;
  lines.push(`usable free RAM: ${free === null || free === undefined ? "?" : free} GB (after lms unload --all)`);
  const cat = Array.isArray(status.catalog) ? status.catalog : [];
  for (const m of cat) {
    lines.push(
      `  ${m.model} -> served ${m.resolved_id || "(none)"}  available=${m.available === true}` +
        ` (match: ${m.available_match || "n/a"})  fits=${m.fits === true}  size=${m.size_gb == null ? "?" : m.size_gb} GB`
    );
  }
  const fitting = cat.filter((m) => m.fits === true).length;
  lines.push(`${fitting} of ${cat.length} catalog model(s) fit usable free RAM`);
  const auto = status.auto_selection || {};
  lines.push(`auto-selection would take: ${auto.model || "(none)"} — ${auto.reason || "(no reason reported)"}`);
  writeFileSync(digestFile, lines.join("\n") + "\n", "utf8");
})().catch((e) => {
  console.error(`M-MODEL probe errored: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
});
JS
RC=$?
if [ "$RC" -ne 0 ]; then
  cat "$LOGS/M-MODEL-probe.log" | sed 's/^/   /'
  fail_step M-MODEL "$RC" "the model probe itself errored (exit $RC) — read $LOGS/M-MODEL-probe.log; is LM Studio's server up (\`lms server start\`)? Zero models fitting would have been an ANSWER, this is not one"
fi
[ -s "$LOGS/M-MODEL-digest.txt" ] || fail_step M-MODEL 1 "the probe exited 0 but wrote no digest — read $LOGS/M-MODEL-probe.log and $LOGS/M-MODEL.txt"
cat "$LOGS/M-MODEL-digest.txt" | sed 's/^/   /'
# `ran` EVEN IF ZERO MODELS FIT — that is an answer, and checkpoint 1 exists
# to carry it to the owner. `failed` is reserved for the probe not answering.
record M-MODEL ran 0 "unload exit $UNLOAD_RC; status probed; digest in logs/M-MODEL-digest.txt (zero fits would still be an answer)"
ok "full status JSON at logs/M-MODEL.txt"

# ---------------------------------------------------------------------------
CURRENT_STEP=""
trap - INT TERM
package_round

say "CHECKPOINT 1 — paste the block below to the orchestrator, then WAIT"
printf '\n'
printf '=================== B12 PILOT CHECKPOINT 1 (paste this whole block) ===================\n'
printf 'phase          P1 complete — nothing spent, nothing committed\n'
printf 'tree           %s\n' "$REPO"
printf 'HEAD           %s\n' "$HEAD_SHA"
printf 'pin            %s (from %s)\n' "$EXPECT_SHA" "$PIN_FROM"
printf 'claude         %s  binary sha256 %s\n' "$CLAUDE_VER" "$CLAUDE_SHA"
printf 'node           %s   vitest %s\n' "$NODE_VER" "$VITEST_VER"
printf 'policy repo    ~/b12-policy at %s (full clone)\n' "$POLICY_HEAD"
printf '  treatment.md %s\n' "$T_GOT"
printf '  control.md   %s\n' "$C_GOT"
printf 'mcp config     .b12-mcp.json sha256 %s (args[0] verified against this tree)\n' "$MCP_GOT"
printf 'mem snapshot   %s (%s file(s))\n' "$SNAP_SHA" "$SNAP_FILES"
printf 'M-MODEL        (the targeted measurement)\n'
sed 's/^/  /' "$LOGS/M-MODEL-digest.txt"
printf '\n'
printf 'QUESTION FOR THE OWNER — PIN A MODEL? To pin, re-run as:\n'
printf '  B12_PIN_MODEL=<catalog-id> bash scripts/b12-pilot-p2-mac.sh\n'
printf 'or, to leave selection free:\n'
printf '  bash scripts/b12-pilot-p2-mac.sh\n'
printf '=======================================================================================\n'
printf '\nDo not run P2 until the orchestrator answers — P2 spends ~8 cheap sessions\nand makes two local commits.\n\n'
exit 0
