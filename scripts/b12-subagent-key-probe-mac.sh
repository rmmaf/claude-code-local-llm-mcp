#!/bin/bash
# B12 — SUBAGENT RATE-KEY PROBE.  Mac only.  Writes nothing into the repository.
#
# THE ONE QUESTION: inside a `claude --print` session, do a SUBAGENT's billed
# requests carry the SAME rate key as the main thread's?
#
# WHY IT DECIDES SOMETHING. `voidConditions` 10 and `void(rate_key_mixed)`
# (src/cost/b12/assemble.ts:646) both key on `rateKey(model, speed)` over an
# observation's OWN requests. If a subagent serves on a different key, EVERY
# observation carrying a subagent is void at observation level, the `multi`
# stratum holds fewer than 5 admitted observations, and `voidConditions` 3
# returns `open` — never a hold, never a fall. The frozen covariate list expects
# subagents: covariate 1 records a share measured from 0% to 78%. This is a
# SWITCH, not a rate, and one session answers it.
#
# PRE-DECLARED PREDICTION, WRITTEN INTO THIS FILE BEFORE IT WAS EVER RUN, and
# copied verbatim into the artifact so the two cannot drift:
#   -> `inherits`.  Reasoning: Claude Code resolves one model per session and
#      the Agent tool takes an explicit per-agent model OVERRIDE, which implies
#      inheritance is the default when none is given.  Confidence: moderate.
#      `differs` is the decision-relevant result and would change the design
#      before anything is sealed.  `no-subagent` is a REFUSAL, not a pass.
#
# THIS SCRIPT MIRRORS THE HARNESS RATHER THAN REIMPLEMENTING IT, and the first
# draft did not — an adversarial review found it took the LAST record's model
# and sidechain flag where `src/cost/transcript.ts:514-532` keeps the FIRST
# ("Everything else stays with the first record on purpose"), walked every
# project in unspecified readdir order where `sessionFiles` is main-transcript-
# first then sorted, and collapsed every key-less record into one group. A probe
# whose key differs from the harness's key answers a different question. Each
# mirrored rule below carries the line it mirrors.
#
# WHAT THIS PROBE DOES NOT ESTABLISH, stated here rather than found later:
#   - Nothing about the TREATMENT arm's MCP shape unless B12_MCP_CONFIG is set;
#     the default runs the CONTROL argv shape. The primary observations are
#     treatment-arm sessions (`admissionRule` 13), so an unset run leaves that
#     gap open and the artifact says so.
#   - Nothing about the sealed per-arm policy blobs; none are delivered here.
#   - Nothing about how many subagents a real manifest task spawns, or nested
#     ones. Sidechain cardinality is REPORTED, never enforced.
#   - It is NOT a sandbox. The session's working directory is a scratch dir
#     outside the repository and the prompt asks for no file access, but a
#     working directory does not constrain what a process may address. The
#     claim this script makes is narrower and checkable: IT writes nothing into
#     the repository. The session also necessarily writes vendor transcripts
#     under ~/.claude, which is the evidence being read.
#
# One machine-produced JSON artifact, no hand-typed measurement.
# This machine does not push: send the artifact back.

set -u

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
step=0
next() { step=$((step+1)); printf '\n%s== %d. %s%s\n' "$DIM" "$step" "$1" "$RST"; }
ok()   { printf '   %s+%s %s\n' "$GRN" "$RST" "$1"; }
warn() { printf '   %s!%s %s\n' "$YEL" "$RST" "$1"; }
refuse() { printf '\n%sREFUSED:%s %s\n\n' "$RED" "$RST" "$1" >&2; exit 1; }

OUT="${1:-./b12-subagent-key-probe.json}"
case "$OUT" in
  -h|--help)
    printf 'usage: %s [output.json]\n  env: B12_MCP_CONFIG=<path>   run the TREATMENT argv shape instead of control\n' "$0"
    exit 0 ;;
esac

# ---------------------------------------------------------------------------
next "The binary, and its identity"

command -v claude >/dev/null 2>&1 || refuse "claude is not on PATH"
CLAUDE_BIN="$(command -v claude)"
# BSD readlink has no -f. The fallback is the PATH entry, which `shasum`
# follows, so the HASH is of the target's bytes either way — but the recorded
# path is then the launcher, not the canonical target, and the artifact says so.
CLAUDE_REAL="$(readlink -f "$CLAUDE_BIN" 2>/dev/null || echo "$CLAUDE_BIN")"
[ "$CLAUDE_REAL" = "$CLAUDE_BIN" ] && PATH_CANONICAL=false || PATH_CANONICAL=true
CLAUDE_VER="$(claude --version 2>/dev/null | head -1)"
[ -n "$CLAUDE_VER" ] || refuse "claude --version produced nothing"
CLAUDE_SHA="$(shasum -a 256 "$CLAUDE_REAL" 2>/dev/null | awk '{print $1}')"
printf '%s' "$CLAUDE_SHA" | grep -qE '^[0-9a-f]{64}$' \
  || refuse "could not hash the claude binary at $CLAUDE_REAL — the identity is the point of the artifact"
ok "$CLAUDE_VER  ${CLAUDE_SHA:0:12}…"

if [ "${DISABLE_AUTOUPDATER:-}" = "1" ]; then
  ok "DISABLE_AUTOUPDATER=1"
else
  warn "DISABLE_AUTOUPDATER is not 1 — an auto-update mid-probe changes the binary this artifact names"
fi

# ---------------------------------------------------------------------------
next "A scratch working directory, pointed away from the repository"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/b12-subagent-probe.XXXXXX")" || refuse "could not create a scratch directory"
cleanup() { [ -n "${SCRATCH:-}" ] && rm -rf "$SCRATCH"; }
trap cleanup EXIT
ok "$SCRATCH"

SESSION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
printf '%s' "$SESSION_ID" | grep -qE '^[0-9a-f-]{36}$' || refuse "uuidgen did not produce a uuid"
ok "session id $SESSION_ID"

# ---------------------------------------------------------------------------
next "The session — one subagent, nothing else"

PROMPT='Use the Task tool to launch exactly one general-purpose subagent. That subagent'"'"'s entire job is to reply with the single word: ok. When it returns, reply with the single word: done. Do not read files, do not run commands, do not use any other tool.'

# BOTH shapes are strict, mirroring scripts/b12-run.mjs:2816. Without
# --strict-mcp-config the account's own connectors merge in and the probe is
# measuring a different session than the harness runs.
if [ -n "${B12_MCP_CONFIG:-}" ]; then
  [ -f "$B12_MCP_CONFIG" ] || refuse "B12_MCP_CONFIG=$B12_MCP_CONFIG does not exist"
  MCP_ARGS=(--strict-mcp-config --mcp-config "$B12_MCP_CONFIG")
  ARGV_SHAPE="treatment: --print --session-id <id> --strict-mcp-config --mcp-config <path> --output-format json -- <prompt>"
  ok "treatment shape, mcp config $B12_MCP_CONFIG"
else
  MCP_ARGS=(--strict-mcp-config)
  ARGV_SHAPE="control: --print --session-id <id> --strict-mcp-config --output-format json -- <prompt>"
  warn "control shape (no --mcp-config). The primary observations are TREATMENT arm; set B12_MCP_CONFIG to probe that shape."
fi

# ERREXIT IS DELIBERATELY NEVER ENABLED. A draft turned it on after this call,
# which would kill the process at a non-zero `node` BEFORE `NODE_RC=$?` could
# read the status — the refusal below could never print and a failed reader
# would look like silent success. Every fallible step checks its own code.
#
# `--` ends option parsing so the prompt cannot be swallowed by a variadic
# option — the defect that made the first Mac pre-flight exit 1 with no session.
CLI_OUT="$(cd "$SCRATCH" && claude --print --session-id "$SESSION_ID" "${MCP_ARGS[@]}" --output-format json -- "$PROMPT" 2>"$SCRATCH/stderr.txt")"
CLI_RC=$?
CLI_ERR="$(cat "$SCRATCH/stderr.txt" 2>/dev/null)"
if [ $CLI_RC -ne 0 ]; then
  printf '%s\n' "$CLI_ERR" | sed 's/^/      /' >&2
  refuse "claude --print exited $CLI_RC. No transcript to read; nothing was written."
fi
ok "session returned (exit 0)"

# ---------------------------------------------------------------------------
next "Reading the transcripts the way the harness reads them"

VERDICT_JS="$SCRATCH/verdict.mjs"
cat >"$VERDICT_JS" <<'NODE_EOF'
import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSION = process.env.PROBE_SESSION;
const OUT = process.env.PROBE_OUT;
// The vendor root. Hardcoding THIS is not the defect B20 names — the harness
// hardcodes it too (src/cost/transcript.ts:598, scripts/b12-run.mjs:610). What
// B20 forbids is hardcoding the layout WITHIN a session, and this file does not.
const ROOT = path.join(os.homedir(), ".claude", "projects");
const die = (m) => { console.error("REFUSED: " + m); process.exit(2); };

/** Every *.jsonl under a directory, recursively, SORTED. Mirrors jsonlUnder. */
function jsonlUnder(dir, out = []) {
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    // THROW, never []. Returning empty here is the exact defect that made a
    // corpus with agent logs one directory over come back as a clean
    // single-threaded session (PREMISES.md B19).
    die(`cannot read ${dir}: ${e.message} — refusing rather than reporting an empty session`);
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsonlUnder(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out.sort();
}

// ---- THE FILE UNION, mirroring src/cost/transcript.ts sessionFiles ----------
// "its main transcript, THEN every .jsonl anywhere under <sessionId>/, sorted.
//  Order is load-bearing: a requestId group takes its usage from the LAST
//  record in file order, so the main transcript comes first."
let slugs;
try { slugs = readdirSync(ROOT, { withFileTypes: true }); } catch (e) { die(`cannot read ${ROOT}: ${e.message}`); }
const owningSlugs = slugs
  .filter((d) => d.isDirectory())
  .map((d) => path.join(ROOT, d.name))
  .filter((d) => existsSync(path.join(d, `${SESSION}.jsonl`)));
if (owningSlugs.length === 0) die(`no slug under ${ROOT} carries ${SESSION}.jsonl — the session wrote no main transcript`);
if (owningSlugs.length > 1) die(`${owningSlugs.length} slugs carry ${SESSION}.jsonl — ambiguous, refusing`);
const slugDir = owningSlugs[0];
const harnessUnion = [path.join(slugDir, `${SESSION}.jsonl`), ...jsonlUnder(path.join(slugDir, SESSION))];

// ---- THE DISCREPANCY SCAN, and it REFUSES rather than annotating -----------
// If this session's records live anywhere the harness's union does not reach —
// a different slug, a sibling directory, a subagent file carrying its own
// sessionId — then the harness would MISS them and this probe would answer a
// question about a subset. That is the false negative this scan exists for.
function allJsonl(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { die(`cannot read ${dir}: ${e.message}`); }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) allJsonl(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}
const everyFile = allJsonl(ROOT);
const readText = (f) => { try { return readFileSync(f, "utf8"); } catch (e) { die(`cannot read ${f}: ${e.message}`); } };
const carriesOurSession = new Set();
let unparsableAnywhere = 0;
for (const f of everyFile) {
  for (const line of readText(f).split("\n")) {
    if (line.trim() === "") continue;
    let r;
    try { r = JSON.parse(line); } catch { unparsableAnywhere++; continue; }
    if (r?.sessionId === SESSION) { carriesOurSession.add(f); break; }
  }
}
const unionSet = new Set(harnessUnion);
const outsideUnion = [...carriesOurSession].filter((f) => !unionSet.has(f)).sort();

// ---- ADMISSION, mirroring PREMISES.md B20's four steps ---------------------
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
const readSpeed = (usage) => {           // src/cost/transcript.ts:196
  const v = usage?.speed;
  return typeof v === "string" && v !== "" ? v : null;
};
const readModel = (message) => message?.model ?? "unknown";   // :530
const rateKey = (model, speed) => (speed === null || speed === "standard" ? model : `${model}@${speed}`); // rates.ts:93

const groups = new Map();
const seenUuid = new Set();
let noKeySeq = 0, admittedRecords = 0, recordsScanned = 0;
let unparsableInUnion = 0, admittedWithoutSessionId = 0, admittedWithoutUuid = 0;

for (const f of harnessUnion) {
  for (const line of readText(f).split("\n")) {
    if (line.trim() === "") continue;
    let r;
    try { r = JSON.parse(line); } catch { unparsableInUnion++; continue; }
    recordsScanned++;
    // Step 1. Admit assistant records carrying usage; exclude api errors and
    // synthetic BY THOSE FIELDS and never by usage reading zero.
    if (r?.type !== "assistant") continue;
    if (r?.message?.usage === undefined) continue;
    if (r.isApiErrorMessage === true) continue;
    if (r?.message?.model === "<synthetic>") continue;
    // Step 2. sessionId equality, UNCONDITIONALLY. A record with no sessionId
    // at all is excluded AND marks the session suspect — counted, never quietly
    // dropped, because dropping them silently is how a session with real
    // traffic comes back empty.
    if (typeof r.sessionId !== "string") { admittedWithoutSessionId++; continue; }
    if (r.sessionId !== SESSION) continue;
    // Step 3. De-duplicate by uuid — RECORD identity across the union.
    if (typeof r.uuid === "string") {
      if (seenUuid.has(r.uuid)) continue;
      seenUuid.add(r.uuid);
    } else {
      admittedWithoutUuid++;
    }
    admittedRecords++;
    // Step 4. Group by requestId. A record with no requestId is its OWN group
    // of one: the fallback carries a monotonic sequence so two key-less records
    // cannot collapse into each other (src/cost/transcript.ts:491-495).
    const rid =
      typeof r.requestId === "string"
        ? r.requestId
        : `__norid__${typeof r.uuid === "string" ? r.uuid : `#${noKeySeq++}`}`;
    const g = groups.get(rid);
    if (g === undefined) {
      // FIRST record fixes model, sidechain and file — "Everything else stays
      // with the first record on purpose" (src/cost/transcript.ts:514-532).
      groups.set(rid, {
        requestId: rid,
        model: readModel(r.message),
        isSidechain: r.isSidechain === true,
        speed: readSpeed(r.message?.usage),
        firstFile: f,
        lastFile: f,
        files: new Set([f]),
        sides: new Set([r.isSidechain === true]),
        models: new Set([readModel(r.message)]),
        firstRaw: JSON.stringify(r),
        lastRaw: JSON.stringify(r),
        records: 1,
      });
    } else {
      // LAST record carries usage and speed, and ONLY those.
      g.speed = readSpeed(r.message?.usage);
      g.lastFile = f;
      g.files.add(f);
      g.sides.add(r.isSidechain === true);
      g.models.add(readModel(r.message));
      g.lastRaw = JSON.stringify(r);
      g.records++;
    }
  }
}

// ---- SUSPECT CONDITIONS. B20 requires these and the first draft had none. ---
const suspect = [];
if (admittedWithoutSessionId > 0)
  suspect.push(`${admittedWithoutSessionId} admitted record(s) carry no sessionId (B20 admission step 2 marks the session suspect)`);
const spanningFiles = [...groups.values()].filter((g) => g.files.size > 1);
if (spanningFiles.length > 0)
  suspect.push(`${spanningFiles.length} requestId group(s) span more than one file — last-write-wins is undefined there (B20 admission step 4)`);
const spanningSides = [...groups.values()].filter((g) => g.sides.size > 1);
if (spanningSides.length > 0)
  suspect.push(`${spanningSides.length} requestId group(s) hold BOTH main and sidechain records — the side of the request is undefined`);
const spanningModels = [...groups.values()].filter((g) => g.models.size > 1);
if (spanningModels.length > 0)
  suspect.push(`${spanningModels.length} requestId group(s) hold more than one model — the key of the request is undefined`);
if (outsideUnion.length > 0)
  suspect.push(
    `${outsideUnion.length} file(s) carry this session's records OUTSIDE the harness's file union (${outsideUnion.map(rel).join(", ")}) — ` +
      `the harness would not read them, so any verdict here is about a subset`
  );
if (unparsableInUnion > 0)
  suspect.push(`${unparsableInUnion} unparsable line(s) inside the harness union — a skipped line may be the one that mattered`);

const main = [], side = [];
for (const g of groups.values()) (g.isSidechain ? side : main).push(g);
const uniq = (xs) => [...new Set(xs)].sort();
const keyOf = (g) => rateKey(g.model, g.speed);
const mainKeys = uniq(main.map(keyOf));
const sideKeys = uniq(side.map(keyOf));

// ---- VERDICT. Every uncertain state is a refusal, never an inheritance. -----
let verdict, why;
if (suspect.length > 0) {
  verdict = "suspect";
  why = `the session is SUSPECT and is not scored: ${suspect.join("; ")}`;
} else if (side.length === 0) {
  verdict = "no-subagent";
  why =
    "ZERO sidechain-billed requests, so the question was not put. This is a REFUSAL, not an inheritance result. " +
    "Either the Task tool was not reached in --print mode — itself decision-relevant, because a harness that cannot " +
    "spawn subagents has an EMPTY multi stratum by construction — or the prompt did not land. Re-run; a repeat is the finding.";
} else if (main.length === 0) {
  verdict = "no-main";
  why = "sidechain requests exist but the main thread billed none — the comparison has no left-hand side";
} else if (mainKeys.length === 1 && sideKeys.length === 1 && sideKeys[0] === mainKeys[0]) {
  verdict = "inherits";
  why = `every billed request on both sides carries ${mainKeys[0]}`;
} else {
  verdict = "differs";
  why =
    `main ${JSON.stringify(mainKeys)} vs subagent ${JSON.stringify(sideKeys)} — an observation carrying a subagent ` +
    `would span more than one rate key and be void(rate_key_mixed) at observation level`;
}

const artifact = {
  schema: "b12-subagent-key-probe/2",
  ts: new Date().toISOString(),
  preDeclaredPrediction:
    "inherits. Written into scripts/b12-subagent-key-probe-mac.sh before this script was ever run; git log witnesses " +
    "the commit that carried it. `differs` is the decision-relevant result. `no-subagent` and `suspect` are refusals, not passes.",
  context: {
    host: "mac",
    claudeVersion: process.env.PROBE_VER,
    claudeBinaryPath: process.env.PROBE_BIN,
    claudeBinaryPathIsCanonical: process.env.PROBE_CANON === "true",
    claudeBinarySha256: process.env.PROBE_SHA,
    disableAutoupdater: process.env.PROBE_AUTOUPD || "(unset)",
    argvShape: process.env.PROBE_ARGV,
    mcpConfig: process.env.PROBE_MCP || null,
    cwd: process.env.PROBE_CWD,
    prompt: process.env.PROBE_PROMPT,
    sessionId: SESSION,
  },
  method: {
    fileUnion: "mirrors src/cost/transcript.ts sessionFiles — <slug>/<sessionId>.jsonl FIRST, then every *.jsonl under <slug>/<sessionId>/ recursively, sorted; order is load-bearing",
    admission: "mirrors PREMISES.md B20 — type=assistant with message.usage; isApiErrorMessage and model '<synthetic>' excluded BY FIELD, never by usage reading zero; record.sessionId equality required; de-duplicated by uuid; grouped by requestId",
    fieldSources: "model and isSidechain from the group's FIRST record, usage and speed from its LAST (src/cost/transcript.ts:514-532); rateKey per src/cost/rates.ts:93",
    discrepancyScan: "every *.jsonl under ~/.claude/projects read for records claiming this sessionId; any file outside the harness union is a REFUSAL, not a note",
    slugDir: rel(slugDir),
    harnessUnion: harnessUnion.map(rel),
    filesCarryingOurSession: [...carriesOurSession].map(rel).sort(),
    filesOutsideHarnessUnion: outsideUnion.map(rel),
  },
  counts: {
    filesScannedForDiscrepancy: everyFile.length,
    recordsScannedInUnion: recordsScanned,
    admittedRecords,
    requestGroups: groups.size,
    mainGroups: main.length,
    subagentGroups: side.length,
    admittedWithoutUuid,
    admittedWithoutSessionId,
    unparsableLinesInUnion: unparsableInUnion,
    unparsableLinesAnywhere: unparsableAnywhere,
    // REPORTED, NEVER ENFORCED: distinct files carrying sidechain records is a
    // floor on the subagent count, not the count. Cardinality is not checked.
    distinctFilesCarryingSidechainGroups: uniq(side.map((g) => rel(g.firstFile))).length,
  },
  suspectReasons: suspect,
  mainRateKeys: mainKeys,
  subagentRateKeys: sideKeys,
  verdict,
  why,
  // EVERY group's first and last raw record, so the verdict is re-derivable
  // from the artifact rather than believed. Bounded by group count, which is
  // single digits for a probe this small.
  groups: [...groups.values()].map((g) => ({
    requestId: g.requestId,
    isSidechain: g.isSidechain,
    model: g.model,
    speed: g.speed,
    key: keyOf(g),
    records: g.records,
    firstFile: rel(g.firstFile),
    lastFile: rel(g.lastFile),
    firstRaw: g.firstRaw,
    lastRaw: g.records > 1 ? g.lastRaw : null,
  })),
  doesNotEstablish: [
    "nothing about the treatment MCP shape unless context.mcpConfig above is non-null",
    "nothing about the sealed per-arm policy blobs — none were delivered",
    "nothing about how many subagents a real manifest task spawns, or their share",
    "nothing about nested subagents; sidechain cardinality is reported, never enforced",
    "not a sandbox — the session's cwd is outside the repository and the prompt asks for no file access, but a working directory does not constrain a process",
    "one session, one Claude Code build — the transcript layout is vendor-internal and has moved before",
  ],
};

const tmp = `${OUT}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(artifact, null, 2) + "\n", "utf8");
renameSync(tmp, OUT);
process.stdout.write(
  `B12-SUBAGENT-PROBE verdict=${verdict} main=${JSON.stringify(mainKeys)} sub=${JSON.stringify(sideKeys)}\n`
);
NODE_EOF

PROBE_SESSION="$SESSION_ID" PROBE_OUT="$OUT" PROBE_VER="$CLAUDE_VER" \
PROBE_BIN="$CLAUDE_REAL" PROBE_CANON="$PATH_CANONICAL" PROBE_SHA="$CLAUDE_SHA" \
PROBE_AUTOUPD="${DISABLE_AUTOUPDATER:-}" PROBE_ARGV="$ARGV_SHAPE" \
PROBE_MCP="${B12_MCP_CONFIG:-}" PROBE_CWD="$SCRATCH" PROBE_PROMPT="$PROMPT" \
node "$VERDICT_JS"
NODE_RC=$?

if [ $NODE_RC -ne 0 ]; then
  refuse "the reader exited $NODE_RC; no artifact was written"
fi
[ -f "$OUT" ] || refuse "the reader exited 0 but wrote no artifact at $OUT"

# ---------------------------------------------------------------------------
next "Verdict"

VERDICT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).verdict)' "$OUT" 2>/dev/null)"
case "$VERDICT" in
  inherits)
    ok "INHERITS — subagents carry the main thread's rate key. The multi stratum is reachable." ;;
  differs)
    warn "DIFFERS — a subagent serves on another key. Every observation carrying a subagent is void(rate_key_mixed),"
    warn "the multi stratum holds fewer than 5 admitted, and voidConditions 3 returns open." ;;
  no-subagent)
    warn "NO SUBAGENT RAN. A refusal, not a pass — read \"why\" in the artifact." ;;
  suspect)
    warn "SUSPECT — the session is not scored. Read \"suspectReasons\": something about the layout is not what the harness assumes." ;;
  *)
    warn "verdict: ${VERDICT:-<unreadable>} — read the artifact" ;;
esac

printf '\n   artifact: %s\n' "$OUT"
printf '   %sThis machine does not push. Send that file back; it is committed on the Windows side.%s\n\n' "$DIM" "$RST"

case "$VERDICT" in
  inherits|differs) exit 0 ;;
  *) exit 3 ;;
esac
