#!/usr/bin/env bash
#
# b12-mac-round.sh — the whole Mac round in one command.
#
#   bash scripts/b12-mac-round.sh [/path/to/unpacked/clone]
#
# Runs the eight measurements PREMISES.md predicted for 2026-08-15, in the order
# that spends the cheap ones first, and packages everything for the trip back.
#
# WHY A SCRIPT AND NOT A LIST OF COMMANDS. A list run by hand produces a result
# nobody can audit: which steps ran, in what order, against which tree, and
# which ones were quietly skipped when something looked wrong. This writes that
# down. The summary names every step it did NOT run and why, because a round
# reported as "done" while three measurements were skipped is the exact shape of
# claim this registry exists to prevent.
#
# IT REFUSES RATHER THAN IMPROVISES — but only where refusing is right:
#   - the GATE (tree identity, cleanliness, build) is fatal: everything after it
#     would be measuring an unknown tree, and a measurement of an unknown tree
#     says nothing about the known one;
#   - an individual MEASUREMENT failing is RECORDED and the round CONTINUES. A
#     paid session going wrong must not discard the ones that already worked.
#
# ENVIRONMENT:
#   B12_SUITE_RUNS=5        how many full-suite runs M1 makes
#   B12_SKIP="M7 M8"        steps to skip on purpose (recorded as skipped-by-request)
#   B12_ONLY="M1 M4"        run only these (everything else recorded as not-requested)
#
# Bash 3.2 compatible (macOS default). No associative arrays, no ${x,,}.

set -u
set -o pipefail

SUITE_RUNS="${B12_SUITE_RUNS:-5}"
SKIP="${B12_SKIP:-}"
ONLY="${B12_ONLY:-}"

# THE BINARY MAY NOT MOVE UNDER US. M3 records a version and M7 measures a cap
# FOR that version; an auto-update between them makes the pair describe two
# different binaries while looking like one measurement.
export DISABLE_AUTOUPDATER=1

if [ "${1:-}" != "" ]; then REPO="$1"; else REPO=$(git rev-parse --show-toplevel 2>/dev/null); fi
[ -n "${REPO:-}" ] || { printf 'REFUSED — no git work tree here, and no path given.\n'; exit 2; }
cd "$REPO" || { printf 'REFUSED — cannot cd to %s\n' "$REPO"; exit 2; }

# CANONICALISE, AND DO IT HERE. Every "$REPO/..." path below is built AFTER this
# cd, so a RELATIVE argument doubles the prefix: run as
# `bash b12-mac/scripts/b12-mac-round.sh b12-mac` — the exact shape of the
# unpack-and-run one-liner I handed over — and the gate looks for
# `b12-mac/b12-mac/.b12-round-pin`, finds nothing, and refuses while blaming the
# archive. It cost a Mac session, and it never reproduced here because every
# local test passed an absolute path.
#
# `pwd -P` and not `pwd`: it also resolves /var -> /private/var, the macOS
# symlink that made M4 read 0/6 and look like a scientific result.
REPO=$(pwd -P)

OUT="$REPO/b12-mac-round"
LOGS="$OUT/logs"
rm -rf "$OUT"; mkdir -p "$LOGS" || { printf 'REFUSED — cannot create %s\n' "$OUT"; exit 2; }

# One line per step: "ID<TAB>STATUS<TAB>EXIT<TAB>NOTE". Read back by node at the
# end. A flat file rather than an array so bash 3.2 is not a constraint.
LEDGER="$OUT/ledger.tsv"
: > "$LEDGER"

# THE ROUND'S ZERO MARK. Everything the packaging step gathers must be NEWER
# than this file. The Desktop and evidence/ both hold artifacts from earlier
# rounds and from the Windows machine, and the old bare globs swept them into
# the tarball as though this round had produced them — including, in a round
# where the pre-flight refused and wrote nothing, a preflight.json from a
# different day. A returned artifact that cannot say which run made it is not
# evidence of that run.
MARKER="$OUT/.round-start"
: > "$MARKER"

say()   { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()    { printf '   + %s\n' "$*"; }
warn()  { printf '   ! %s\n' "$*"; }
die()   { printf '\nREFUSED — %s\n\nNothing was measured. Fix the above and re-run; the gate is idempotent.\n' "$*"; exit 1; }
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$LEDGER"; }

# `case` on space-padded lists: bash 3.2 has no arrays worth using here.
wanted() {
  case " $SKIP " in *" $1 "*) return 1 ;; esac
  [ -z "$ONLY" ] && return 0
  case " $ONLY " in *" $1 "*) return 0 ;; esac
  return 1
}
why_not() {
  case " $SKIP " in *" $1 "*) printf 'skipped by request (B12_SKIP)'; return ;; esac
  printf 'not requested (B12_ONLY=%s)' "$ONLY"
}

# ---------------------------------------------------------------------------
say "GATE — the tree this round measures"

command -v git  >/dev/null 2>&1 || die "git not found"
command -v node >/dev/null 2>&1 || die "node not found"
command -v npm  >/dev/null 2>&1 || die "npm not found"
ok "git, node, npm present"

# THE PIN TRAVELS WITH THE ARCHIVE; IT IS NOT BAKED INTO THIS FILE.
#
# An earlier draft hardcoded the sha — and went stale before it was ever run,
# because committing this script moved HEAD past it. That is precisely the rot
# that left `b12-preflight-mac.sh` pointing at a branch 279 commits behind the
# work, and it is not worth repeating in the file written to avoid it.
#
# `.b12-round-pin` is written when the archive is CUT, by the machine that knows
# which commit it cut. Missing pin and no B12_EXPECT_SHA is a refusal, not a
# default: a round that guesses which tree it is measuring measures nothing.
PIN_FILE="$REPO/.b12-round-pin"
if [ -n "${B12_EXPECT_SHA:-}" ]; then
  EXPECT_SHA="$B12_EXPECT_SHA"
  PIN_FROM="B12_EXPECT_SHA"
elif [ -f "$PIN_FILE" ]; then
  EXPECT_SHA=$(tr -d ' \t\r\n' < "$PIN_FILE")
  PIN_FROM=".b12-round-pin"
else
  die "no .b12-round-pin in $REPO and no B12_EXPECT_SHA set — this archive does not say which commit it is supposed to be, and guessing is how a round measures the wrong tree"
fi
case "$EXPECT_SHA" in
  ????????????????????????????????????????) : ;;
  *) die "the pin from $PIN_FROM is not a full 40-character sha (got \"$EXPECT_SHA\")" ;;
esac

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null)
[ "$HEAD_SHA" = "$EXPECT_SHA" ] || die "HEAD is \"$HEAD_SHA\" but $PIN_FROM says \"$EXPECT_SHA\". This is not the archive it claims to be."
ok "at the pinned commit $(git rev-parse --short HEAD) (pin from $PIN_FROM)"

# TRACKED changes only. Untracked files are the operator's business; tracked
# ones mean the source is not what the commit says, which is the CRLF trap that
# already refused one pre-flight in this round.
DIRTY=$(git status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')
[ "$DIRTY" = "0" ] || {
  git status --porcelain --untracked-files=no | head -20
  die "$DIRTY tracked file(s) differ from the commit. If they are all source files, the archive was cut with CRLF line endings — ask for a re-cut rather than committing over it."
}
ok "no tracked changes"

say "GATE — build"
npm ci --silent >/dev/null 2>&1 || die "npm ci failed — run it by hand to see why"
npm run build --silent >/dev/null 2>&1 || die "npm run build failed — run it by hand to see why"
[ -f "dist/cost/cli.js" ] || die "dist/cost/cli.js missing after a build that reported success"
ok "installed and built"

# ---------------------------------------------------------------------------
say "M2/M3 — the machine's own facts"
if wanted M2; then
  {
    printf 'platform_arch_node: '; node -e "console.log(process.platform, process.arch, process.version)"
    printf 'vitest: ';             npx vitest --version 2>&1 | tail -1
    printf 'claude: ';             claude --version 2>&1 | tail -1
    printf 'claude_sha256: ';      shasum -a 256 "$(command -v claude)" 2>/dev/null | awk '{print $1}'
    printf 'lms: ';                (command -v lms >/dev/null 2>&1 && echo present) || echo absent
  } > "$LOGS/M2-M3.txt" 2>&1
  cat "$LOGS/M2-M3.txt" | sed 's/^/   /'
  record M2 ran 0 "machine facts captured"
  record M3 ran 0 "version and binary digest captured"
else
  warn "$(why_not M2)"; record M2 skipped "" "$(why_not M2)"; record M3 skipped "" "$(why_not M3)"
fi

# ---------------------------------------------------------------------------
say "M1 — the full suite, $SUITE_RUNS times"
if wanted M1; then
  M1_FAILS=0
  i=1
  while [ "$i" -le "$SUITE_RUNS" ]; do
    printf '   run %s/%s ... ' "$i" "$SUITE_RUNS"
    # FULL output kept per run, not a tail. The Windows signature is TWO failed
    # suites with ZERO failed tests and an EMPTY message; a tail shows the
    # counts and throws away the only thing that could name a cause.
    npm test > "$LOGS/M1-run$i.txt" 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then printf 'green\n'; else printf 'RED (exit %s) — see logs/M1-run%s.txt\n' "$rc" "$i"; M1_FAILS=$((M1_FAILS+1)); fi
    i=$((i+1))
  done
  if [ "$M1_FAILS" -eq 0 ]; then
    record M1 ran 0 "$SUITE_RUNS/$SUITE_RUNS green"
  else
    record M1 ran 1 "$M1_FAILS of $SUITE_RUNS RED — the prediction was $SUITE_RUNS/$SUITE_RUNS green, so this FALSIFIES it"
  fi
else
  warn "$(why_not M1)"; record M1 skipped "" "$(why_not M1)"
fi

# ---------------------------------------------------------------------------
say "M4 — the mutation matrix (the Mac firing artifact)"
if wanted M4; then
  # THE RUN ID IS PER-ROUND, NOT HARDCODED. It used to read
  # "2026-08-15-mac-dryrun-1" — the id of a round that has since been COMMITTED.
  # Running this a second time overwrote that committed artifact, and the
  # resulting tracked change then made M5 and M8 both refuse with "the working
  # tree has tracked changes": three failures, none of them naming the cause.
  # `b12-mutate.mjs` now refuses on an existing artifact; this makes sure the
  # honest case never has to hit that refusal. "dryrun" stays in the name
  # because that is what this is, and the audit reads the id.
  # ONE `date` call, then split it: two calls can straddle a second boundary and
  # put a date and a time from different seconds into the same id.
  RUN_STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)     # 2026-08-16T17:05:03Z
  RUN_DATE="${RUN_STAMP%%T*}"                  # 2026-08-16
  RUN_HMS="${RUN_STAMP#*T}"; RUN_HMS="${RUN_HMS%Z}"
  RUN_TIME=$(printf '%s' "$RUN_HMS" | tr -d ':')
  RUN_ID="$RUN_DATE-mac-dryrun-$(git rev-parse --short HEAD)-$RUN_TIME"
  ok "run id $RUN_ID"
  node scripts/b12-mutate.mjs "$RUN_ID" --at "$RUN_STAMP" > "$LOGS/M4.txt" 2>&1
  rc=$?
  tail -4 "$LOGS/M4.txt" | sed 's/^/   /'
  # EXIT 1 MEANS THE MATRIX RAN AND NOT EVERY CONTROL FIRED — which is the
  # EXPECTED Mac outcome while the m4 pair stands withdrawn. Reporting that as
  # "did NOT complete" is how the 2026-08-15 summary came to contradict its own
  # log, which ended "NOT ALL FIRED (5/6)". 2 is a refusal before any work, 3 a
  # refusal during it; only those two mean nothing was measured.
  case "$rc" in
    0) record M4 ran 0 "matrix completed — ALL controls fired" ;;
    1) record M4 ran 1 "matrix COMPLETED, not all controls fired — see logs/M4.txt (this is a result, not a failure)" ;;
    2) record M4 failed 2 "refused before running — see logs/M4.txt" ;;
    *) record M4 failed "$rc" "matrix did NOT complete — see logs/M4.txt" ;;
  esac
else
  warn "$(why_not M4)"; record M4 skipped "" "$(why_not M4)"
fi

# ---------------------------------------------------------------------------
say "M6b — the subagent rate-key probe, TREATMENT shape"
if wanted M6b; then
  # THE RE-RUN THE FIRST ONE OWED. The earlier probe ran in CONTROL shape and
  # said so; the scored observations are the treatment arm, which loads the MCP
  # server. B12_REPO is what makes it generate the config.
  B12_REPO="$REPO" bash scripts/b12-subagent-key-probe-mac.sh > "$LOGS/M6b.txt" 2>&1
  rc=$?
  grep -E "verdict=|INHERITS|DIFFERS|control shape" "$LOGS/M6b.txt" | sed 's/^/   /'
  [ "$rc" -eq 0 ] && record M6b ran 0 "$(grep -o 'verdict=[a-z]*' "$LOGS/M6b.txt" | head -1)" || record M6b failed "$rc" "probe failed — see logs/M6b.txt"
else
  warn "$(why_not M6b)"; record M6b skipped "" "$(why_not M6b)"
fi

# ---------------------------------------------------------------------------
say "M5 — the PHASE 1 pre-flight"
if wanted M5; then
  B12_EXPECT_SHA="$EXPECT_SHA" bash scripts/b12-preflight-mac.sh > "$LOGS/M5.txt" 2>&1
  rc=$?
  tail -6 "$LOGS/M5.txt" | sed 's/^/   /'
  [ "$rc" -eq 0 ] && record M5 ran 0 "pre-flight completed" || record M5 failed "$rc" "pre-flight refused or failed — see logs/M5.txt"
else
  warn "$(why_not M5)"; record M5 skipped "" "$(why_not M5)"
fi

# ---------------------------------------------------------------------------
say "M7 — the client truncation cap"
if wanted M7; then
  bash scripts/b12-truncationcap-probe-mac.sh > "$LOGS/M7.txt" 2>&1
  rc=$?
  tail -4 "$LOGS/M7.txt" | sed 's/^/   /'
  [ "$rc" -eq 0 ] && record M7 ran 0 "cap probe completed" || record M7 failed "$rc" "cap probe failed — see logs/M7.txt"
else
  warn "$(why_not M7)"; record M7 skipped "" "$(why_not M7)"
fi

# ---------------------------------------------------------------------------
say "M8 — the installedChars re-probe"
if wanted M8; then
  # THE PIN REACHES THIS ONE TOO. On 2026-08-15 M8 refused on `git fetch` while
  # the pre-flight beside it ran offline, because only the pre-flight had been
  # given the mode. Passing it here is what makes the repair reach the round.
  B12_EXPECT_SHA="$EXPECT_SHA" bash scripts/b12-installedchars-probe-mac.sh > "$LOGS/M8.txt" 2>&1
  rc=$?
  tail -4 "$LOGS/M8.txt" | sed 's/^/   /'
  [ "$rc" -eq 0 ] && record M8 ran 0 "probe completed" || record M8 failed "$rc" "probe failed — see logs/M8.txt"
else
  warn "$(why_not M8)"; record M8 skipped "" "$(why_not M8)"
fi

# ---------------------------------------------------------------------------
say "Summary"

# Built by node so the ledger and the printed summary cannot disagree: one
# source, read twice, rather than two that drift.
node - "$LEDGER" "$OUT/summary.json" "$HEAD_SHA" <<'JS'
const { readFileSync, writeFileSync } = require("node:fs");
const [, , ledger, out, sha] = process.argv;
const rows = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => {
  const [id, status, exit, note] = l.split("\t");
  return { id, status, exit: exit === "" ? null : Number(exit), note };
});
// THE VOCABULARY IS CLOSED, AND ANYTHING OUTSIDE IT IS A DEFECT — not a row to
// drop. The reader used to partition on "ran" and "skipped" only, so a third
// status would have appeared in neither list and vanished from the summary
// while still sitting in the ledger. A step that ran and is reported nowhere is
// worse than one reported as failed.
const KNOWN = ["ran", "failed", "skipped"];
const unknown = rows.filter((r) => !KNOWN.includes(r.status));
if (unknown.length) {
  console.error(
    `REFUSED: ledger carries ${unknown.length} row(s) with a status this reader does not ` +
      `know (${[...new Set(unknown.map((r) => r.status))].join(", ")}). ` +
      `A summary that silently omits a measured step is worse than no summary.`
  );
  process.exit(2);
}
// "ran" means the step produced an answer, INCLUDING an answer of "not all
// controls fired" — see M4's exit-1 case. "failed" means it did not.
const ran = rows.filter((r) => r.status === "ran");
const summary = {
  document: "b12-mac-round",
  commit: sha,
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  host: "mac",
  steps: rows,
  // NAMED, not counted. "6 of 8" invites a reader to assume the other two were
  // unimportant; the ids say which questions have no answer in this round.
  ranIds: ran.map((r) => r.id),
  failedIds: rows.filter((r) => r.status === "failed").map((r) => r.id),
  skippedIds: rows.filter((r) => r.status === "skipped").map((r) => r.id),
};
writeFileSync(out, JSON.stringify(summary, null, 2) + "\n", "utf8");
for (const r of rows) {
  // KEYED ON STATUS, like the lists above. Keying the printed mark on the exit
  // code while the lists key on status is how the printed round and its own
  // summary.json came to disagree: M1 answering "2 of 5 red" and M4 answering
  // "5 of 6 fired" both exit nonzero, and both are ANSWERS. They were printed
  // as FAIL directly above a FAILED: line that did not name them.
  const mark = r.status === "skipped" ? "  -  " : r.status === "failed" ? " FAIL" : "  ok ";
  console.log(`  ${mark} ${r.id.padEnd(4)} ${r.note}`);
}
console.log("");
if (summary.failedIds.length) console.log(`  FAILED: ${summary.failedIds.join(", ")}`);
if (summary.skippedIds.length) console.log(`  NO ANSWER THIS ROUND: ${summary.skippedIds.join(", ")}`);
JS

# Artifacts the probes write outside $OUT, gathered so one file carries all.
#
# `-newer "$MARKER"` everywhere, and *.probe.json added. The old version used
# bare globs and omitted `*.probe.json` entirely — which meant M7's cap artifact
# and M8's installedChars artifact, the two the committing machine actually
# needs, stayed on the Mac while the tarball claimed to carry "the artifacts".
# The logs name their paths; the logs are not the JSON.
mkdir -p "$OUT/evidence"
GATHERED=0
gather() {  # gather <dest-subdir> <file>
  [ -f "$2" ] || return 0
  [ "$2" -nt "$MARKER" ] || return 0
  cp "$2" "$OUT/$1/" 2>/dev/null && GATHERED=$((GATHERED + 1))
}
gather "" "$HOME/b12-subagent-key-probe.json"
for f in "$HOME/Desktop"/*.preflight.json; do gather "" "$f"; done
for f in "$REPO/evidence"/*.firing.json; do gather evidence "$f"; done
for f in "$REPO/evidence"/*.probe.json;  do gather evidence "$f"; done
ok "$GATHERED artifact(s) produced by THIS round gathered"

say "Send this one file back"
TARBALL="$HOME/b12-mac-round-$(git rev-parse --short HEAD).tgz"
rm -f "$TARBALL"
tar -czf "$TARBALL" -C "$REPO" b12-mac-round 2>/dev/null && ok "$TARBALL" || warn "could not write $TARBALL — send $OUT instead"
printf '\n   It carries the summary, every step log, and the %s artifact(s) THIS round\n   produced. Artifacts already on the machine from earlier rounds are NOT\n   swept in — a tarball that cannot say which run made a file is not evidence\n   of that run. git status of the clone is not included; run it if asked.\n\n' "$GATHERED"
