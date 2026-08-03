#!/usr/bin/env bash
#
# mac-check.sh — set up and diagnose local-coder on a Mac, then collect the
# results into one archive to send back.
#
#   bash scripts/mac-check.sh
#
# What it does NOT do: run a Claude Code session. B6 and B7 come from `repair`'s
# own returned payload during real work, which is yours to drive. This script
# gets everything else out of the way first and tells you what is actually
# broken before you start.
#
# Every step is non-fatal and recorded. A step that cannot run is reported as
# SKIP, never silently passed — a green run that skipped the model probe would
# be worse than a red one.
#
# Written for macOS's bash 3.2: no associative arrays, no mapfile, no ${x,,}.

set -u

LMS_URL="${LM_STUDIO_URL:-http://localhost:1234/v1}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "$REPO_ROOT" ] || [ ! -f "$REPO_ROOT/package.json" ]; then
  echo "cannot locate the repo root from ${BASH_SOURCE[0]} — run this from a clone" >&2
  exit 1
fi

# Every run gets its own directory. Reusing one would let a step that failed
# today be answered by yesterday's file, and would tar artifacts from several
# runs into one archive — a measurement has to belong to exactly one run.
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RESULTS_HOME="${LC_RESULTS:-$HOME/lc-results}"
OUT="$RESULTS_HOME/$RUN_ID"
ARCHIVE="$RESULTS_HOME/lc-results-$RUN_ID.tgz"

mkdir -p "$OUT"
SUMMARY="$OUT/summary.txt"
: > "$SUMMARY"

GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'

note() { printf '%s\n' "$*" | tee -a "$SUMMARY" >/dev/null; printf '%s%s%s\n' "$DIM" "$*" "$OFF"; }
pass() { printf 'PASS  %s\n' "$*" >> "$SUMMARY"; printf '%sPASS%s  %s\n' "$GREEN" "$OFF" "$*"; }
fail() { printf 'FAIL  %s\n' "$*" >> "$SUMMARY"; printf '%sFAIL%s  %s\n' "$RED" "$OFF" "$*"; }
skip() { printf 'SKIP  %s\n' "$*" >> "$SUMMARY"; printf '%sSKIP%s  %s\n' "$YELLOW" "$OFF" "$*"; }

printf '\n%s\n' "local-coder mac check — results go to $OUT"
printf '%s\n\n' "repo: $REPO_ROOT"

# ---------------------------------------------------------------- environment
{
  echo "date_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "macos: $(sw_vers -productVersion 2>/dev/null || echo unknown)"
  echo "arch: $(uname -m)"
  echo "node: $(node -v 2>/dev/null || echo MISSING)"
  echo "npm: $(npm -v 2>/dev/null || echo MISSING)"
  echo "mem_total_bytes: $(sysctl -n hw.memsize 2>/dev/null || echo unknown)"
  echo "lm_studio_url: $LMS_URL"
  echo "git_commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "git_branch: $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
} > "$OUT/environment.txt"
note "environment recorded → environment.txt"

if ! command -v node >/dev/null 2>&1; then
  fail "node is not installed — nothing below can run"
  exit 1
fi

# ------------------------------------------------------------------- 1. build
printf '\n%s\n' "1. install and build"
if (cd "$REPO_ROOT" && npm install) > "$OUT/npm-install.txt" 2>&1; then
  pass "npm install (runs prepare → tsc)"
else
  fail "npm install — see npm-install.txt"
fi

# --------------------------------------------------------------------- 2. lms
printf '\n%s\n' "2. the lms CLI"
LMS_BIN=""
if command -v lms >/dev/null 2>&1; then
  LMS_BIN="$(command -v lms)"
elif [ -x "$HOME/.lmstudio/bin/lms" ]; then
  LMS_BIN="$HOME/.lmstudio/bin/lms"
fi

if [ -n "$LMS_BIN" ]; then
  pass "lms found at $LMS_BIN"
  if "$LMS_BIN" ls --json > "$OUT/lms-ls.json" 2>"$OUT/lms-ls.err"; then
    pass "lms ls --json captured → lms-ls.json"
  else
    fail "lms ls --json failed — see lms-ls.err. Model SIZES will be unknown, so
      auto-selection falls back to catalog order instead of largest-that-fits"
  fi
else
  skip "lms not on PATH and not at ~/.lmstudio/bin/lms. Install it from LM Studio
      (Settings → Developer) or add it to PATH. Without it the server still
      works, but it cannot size models and auto-selection degrades to
      catalog order"
fi

# ------------------------------------------------------- 3. server reachable?
printf '\n%s\n' "3. LM Studio server"
if curl -fsS --max-time 5 "$LMS_URL/models" -o "$OUT/lmstudio-models.json" 2>"$OUT/lmstudio-models.err"; then
  pass "server reachable at $LMS_URL"
else
  fail "server NOT reachable at $LMS_URL — run \`lms server start\` (or start it
      from the LM Studio app) and re-run this script. Steps 4 and 5 below will
      report what they can, but the smoke test needs this"
fi

# ------------------------------------------------- 4. status, the real answer
printf '\n%s\n' "4. status — catalog, sizes, memory, what auto-selection would pick"
# Has to sit in the repo root so `./src/...` resolves. PID-suffixed and refused
# if it already exists: a fixed name would clobber, and then DELETE, a file of
# the same name that happened to be there. Trapped so an interrupted run does
# not leave the working tree dirty.
PROBE="$REPO_ROOT/.mac-check-status.$$.mts"
if [ -e "$PROBE" ]; then
  fail "refusing to overwrite an existing $PROBE"
  PROBE=""
else
  trap '[ -n "${PROBE:-}" ] && rm -f "$PROBE"' EXIT INT TERM
fi
[ -n "$PROBE" ] && cat > "$PROBE" <<'TS'
import { promises as fsp } from "node:fs";
import { loadConfig } from "./src/config.js";
import { DEFAULT_MODEL_CATALOG, loadModelCatalog } from "./src/models-csv.js";
import { runStatus } from "./src/tools/status.js";
import { buildCatalogReport, serializeReport } from "./src/selection.js";
import { getLmsModels } from "./src/lms.js";

const config = loadConfig(process.env, process.cwd());
const csvPath = config.modelsCsvPath;
config.models = await loadModelCatalog(csvPath);
const status = await runStatus(config);

// config.models_csv_path records the ENV VAR, not what loaded. loadModelCatalog
// falls back to the built-in catalog on an unreadable file AND on a file with no
// usable rows, warning only to stderr — so a set path proves intent, never that
// the CSV is in force. Both fallbacks `return DEFAULT_MODEL_CATALOG` itself, so
// reference identity settles it exactly, with no false positive on a CSV that
// happens to list the same models.
const usingDefault = config.models === DEFAULT_MODEL_CATALOG;
const catalog_source = {
  csv_path: csvPath,
  in_force: usingDefault ? "built-in-default" : "csv",
  models_loaded: config.models.length,
};
// No reason is guessed here on purpose. An earlier version probed the path with
// fs.access and reported "read but no usable rows" whenever that succeeded --
// but access is not readFile: a directory, a file with no read permission, or a
// file created after loadModelCatalog already gave up all pass it, and the
// stated reason would have been fiction. loadModelCatalog logs the real reason
// from the real attempt to stderr, which the caller captures in status.err, so
// 5b quotes that instead of re-deriving it.

// Size every model LM Studio OFFERS, not just the catalog ones, by running the
// offered ids back through the server's own matcher. Reused rather than
// re-parsed so the script cannot disagree with the server about identity.
const lms = await getLmsModels();
// serializeReport, not the raw report: buildCatalogReport returns camelCase and
// status serialises to snake_case. Emitting the raw shape here would silently
// give `offered` different field names from `catalog` in the same file.
const offered = buildCatalogReport(
  status.models.map((m) => ({ model: m, objective: "" })),
  status.models,
  lms,
  null,
  null
).map(serializeReport);
process.stdout.write(JSON.stringify({ ...status, offered, catalog_source }, null, 2) + "\n");
TS
if [ -n "$PROBE" ] && (cd "$REPO_ROOT" && npx tsx "$PROBE") > "$OUT/status.json" 2>"$OUT/status.err"; then
  pass "status captured → status.json"
  node -e '
    const s = require(process.argv[1]);
    const avail = s.catalog.filter((m) => m.available === true);
    const sized = s.catalog.filter((m) => m.size_gb !== null);
    console.log("  reachable:      " + s.reachable);
    console.log("  lms_available:  " + s.lms_available);
    console.log("  catalog:        " + s.catalog.length + " model(s), " + avail.length +
                " offered by /models, " + sized.length + " with a known size");
    console.log("  usable free:    " + (s.memory.usable_free_gb ?? "unknown") + " GB of " +
                (s.memory.total_gb ?? "?") + " GB");
    console.log("  would pick:     " + s.auto_selection.model);
    console.log("  because:        " + s.auto_selection.reason);
  ' "$OUT/status.json" 2>/dev/null | tee -a "$SUMMARY"
else
  fail "status probe failed — see status.err"
fi
rm -f "$PROBE"

# ------------------------------- 5. does the catalog match what you DOWNLOADED?
printf '\n%s\n' "5. catalog vs what LM Studio actually offers"
if [ -s "$OUT/status.json" ]; then
  node -e '
    const fs = require("fs");
    const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (s.models.length === 0) {
      console.log("  LM Studio lists no models at all — nothing to match against.");
      process.exit(3);
    }
    const EMBED = /embed/i, CODER = /coder|code/i;

    // (a) Informational: catalog entries LM Studio does not offer.
    const missing = s.catalog.filter((m) => m.available !== true).map((m) => m.model);
    if (missing.length === 0) {
      console.log("  every model in the catalog in force is offered by LM Studio.");
    } else {
      // Squash to letters and digits so quantisation spellings collapse. The
      // server matcher only strips HYPHEN-separated quant tokens (-4bit, -mlx),
      // so LM Studio ids using @ (…-mlx@8bit) do not match it. GUESS, printed
      // as one: it saves re-downloading a model that is already on disk.
      const squash = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
      for (const want of missing) {
        const w = squash(want.split("/").pop());
        const near = s.models.filter((h) => { const x = squash(h); return x.includes(w) || w.includes(x); });
        console.log("  NOT offered: " + want +
          (near.length ? "\n     but you appear to already have: " + near.join(", ") +
                         "\n     (same base model, different id spelling — nothing to download)" : ""));
      }
    }

    // (b) Always write the recommendation — deliberately NOT conditional on
    // anything above. The previous version only wrote a CSV when a catalog
    // model was missing, so a catalog that was complete but wrong (every id
    // present, a 27 GB general model at the top) could never be repaired by
    // the same script that flagged it.
    const usable = s.offered.filter((m) => !EMBED.test(m.model));
    const embeds = s.offered.filter((m) => EMBED.test(m.model)).map((m) => m.model);
    if (embeds.length) console.log("  excluded, cannot serve chat completions: " + embeds.join(", "));

    const coders = usable.filter((m) => CODER.test(m.model));
    const rows = (coders.length ? coders : usable)
      .map((m) => ({ id: m.model, gb: m.size_gb }))
      .sort((a, b) => (b.gb ?? -1) - (a.gb ?? -1));

    // The objective is not a comment: the models tool shows it to the
    // orchestrator, which picks by purpose from exactly this text. An earlier
    // version wrote "AUTO-GENERATED — rewrite this" into the field, so an
    // unreviewed catalog fed the orchestrator an instruction aimed at a human.
    // Write a real description instead, and mark it [auto] so 5b can tell a
    // generated line from a reviewed one.
    const kind = coders.length ? "coding model" : "model (NOT identified as a coding model)";

    // A superlative has to be earned. Sizes sort unknowns last, so the bottom
    // row is not necessarily the smallest — an unsized model could be smaller
    // than everything or larger than everything. Claim "largest"/"smallest"
    // only when every size is known, there is more than one model, and the
    // extreme is not tied. Otherwise state the size and stop.
    const known = rows.filter((r) => r.gb !== null).map((r) => r.gb);
    const allKnown = known.length === rows.length && rows.length > 1;
    const maxGb = known.length ? Math.max.apply(null, known) : null;
    const minGb = known.length ? Math.min.apply(null, known) : null;
    const soleMax = allKnown && known.filter((g) => g === maxGb).length === 1;
    const soleMin = allKnown && known.filter((g) => g === minGb).length === 1;

    const describe = (r) => {
      if (r.gb === null) return `Local ${kind}, size unknown [auto]`;
      const base = `Local ${kind}, ${r.gb} GB`;
      if (soleMax && r.gb === maxGb) return `${base} — the largest here, most capable, needs the most memory [auto]`;
      if (soleMin && r.gb === minGb) return `${base} — the smallest here, fastest, lowest memory [auto]`;
      return `${base} [auto]`;
    };
    const csv = rows.map((r) => `${r.id},"${describe(r)}"`).join("\n") + "\n";
    fs.writeFileSync(process.argv[2], csv);

    if (!coders.length) {
      console.log("  NO model name looks like a coding model. Wrote all " + rows.length + " usable");
      console.log("  model(s) instead — choose by hand. repair on a general-purpose model is not");
      console.log("  what B6 and B7 mean to measure.");
      process.exit(2);
    }
    const left = usable.filter((m) => !CODER.test(m.model)).map((m) => m.model);
    console.log("  wrote " + rows.length + " coding model(s) → models.local.csv, largest first");
    console.log("  (largest first matters: selection falls back to the FIRST entry when sizes");
    console.log("   are unknown, and to the largest that FITS when they are)");
    if (left.length) console.log("  left out, not coding models: " + left.join(", "));
    console.log("  rewrite the objectives before relying on the models tool — they are what it reads.");
    process.exit(0);
  ' "$OUT/status.json" "$OUT/models.local.csv" 2>/dev/null | tee -a "$SUMMARY"
  # PIPESTATUS is clobbered by the next pipeline, so read it on the next line.
  case "${PIPESTATUS[0]}" in
    0) pass "wrote a coder-only catalog → $OUT/models.local.csv
      to use it:  export LOCAL_CODER_MODELS_CSV=\"$OUT/models.local.csv\"" ;;
    2) fail "no installed model looks like a coding model — see above" ;;
    *) skip "could not compare — LM Studio offered no models" ;;
  esac
else
  skip "no status.json to compare against"
fi

# ---------------------------------- 5b. audit the catalog that is IN FORCE
# Deliberately NOT conditional on anything above. A catalog can be fully
# "available" and still be wrong — an already-exported placeholder CSV lists
# only ids LM Studio offers, so the missing-model check above passes it and
# says "nothing to do" over a catalog holding an embedding model and a
# general-purpose model as the auto-selection pick.
printf '\n%s\n' "5b. audit of the catalog actually in force"
if [ -s "$OUT/status.json" ]; then
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const EMBED = /embed/i, CODER = /coder|code/i;
    let bad = 0;
    const src = s.catalog_source;
    console.log("  catalog in force: " + (src.in_force === "csv" ? src.csv_path : "BUILT-IN DEFAULT"));
    if (src.in_force === "csv") {
      console.log("     " + src.models_loaded + " model(s) loaded from it");
    } else if (src.csv_path === null) {
      console.log("     no LOCAL_CODER_MODELS_CSV set in this shell");
    } else {
      console.log("     LOCAL_CODER_MODELS_CSV points at " + src.csv_path + " but that file is");
      console.log("     NOT what is running. Whatever you edited there is having no effect.");
      // Quote the server, do not infer. It logged why the real read failed.
      let reason = null;
      try {
        reason = require("fs").readFileSync(process.argv[2], "utf8")
          .split("\n").filter((l) => l.includes("models-csv:")).pop();
      } catch (e) { /* status.err unreadable — say so rather than guess */ }
      console.log(reason && reason.trim() !== ""
        ? "     the server said: " + reason.trim()
        : "     the server did not say why in status.err. Do not assume a reason.");
      bad++;
    }
    const embeds = s.catalog.filter((m) => EMBED.test(m.model)).map((m) => m.model);
    if (embeds.length) {
      console.log("  embedding model(s) in the catalog: " + embeds.join(", "));
      console.log("     these cannot serve chat completions — delete those lines");
      bad++;
    }
    // The objective is what the models tool shows the orchestrator when it
    // picks by purpose. A catalog can be otherwise perfect and still be feeding
    // it text this script wrote from a filename.
    const auto = s.catalog.filter((m) => /\[auto\]/.test(m.objective || ""));
    if (auto.length) {
      console.log("     " + auto.length + " of " + s.catalog.length +
        " objective(s) are still auto-described from the model name.");
      console.log("     Auto-selection by memory ignores objectives, so B6/B7 are unaffected —");
      console.log("     but the models tool reads these verbatim, so a model picked by purpose");
      console.log("     would be picked from a guess about what the filename means.");
      bad++;
    }

    const free = s.memory.usable_free_gb;
    console.log("  auto-selection would use: " + s.auto_selection.model +
      " (usable free: " + (free ?? "unknown") + " GB)");
    if (!CODER.test(s.auto_selection.model)) {
      console.log("     that does not look like a coding model. Selection takes the largest");
      console.log("     that FITS, so repair would run on it and B6/B7 would measure the");
      console.log("     wrong model. Remove the larger non-coder entries.");
      bad++;
    }

    // The check above is about THIS moment, and "largest that fits" moves with
    // free RAM. A non-coder bigger than every coder is a trap that passes while
    // memory is tight and fires the moment it is not — same catalog, different
    // verdict, and the model under measurement changes without anyone editing
    // anything. Flag it as latent rather than waiting for the run where it bites.
    // Only when the current pick IS a coder — otherwise the warning above
    // already covers it, and saying "not being picked right now" about the
    // model that just got picked would contradict the line above it.
    const sized = CODER.test(s.auto_selection.model)
      ? s.catalog.filter((m) => m.size_gb !== null) : [];
    const coderGb = sized.filter((m) => CODER.test(m.model)).map((m) => m.size_gb);
    if (coderGb.length) {
      const biggestCoder = Math.max.apply(null, coderGb);
      const looming = sized.filter((m) => !CODER.test(m.model) && m.size_gb > biggestCoder);
      if (looming.length) {
        console.log("     LATENT: " + looming.map((m) => m.model + " (" + m.size_gb + " GB)").join(", "));
        console.log("     is larger than every coding model in the catalog (biggest coder: " +
          biggestCoder + " GB). It is not being picked right now only because it does not fit.");
        console.log("     Free some memory and it wins, silently changing the model repair runs on.");
        bad++;
      }
    }
    process.exit(bad ? 1 : 0);
  ' "$OUT/status.json" "$OUT/status.err" 2>/dev/null | tee -a "$SUMMARY"
  if [ "${PIPESTATUS[0]}" -eq 0 ]; then
    pass "catalog in force looks sane"
  else
    fail "catalog in force needs editing — see the lines above"
  fi
else
  skip "no status.json to audit"
fi

# ------------------------------------------------------------ 6. smoke test
printf '\n%s\n' "6. smoke test — the <file>-block contract, end to end"
if [ -s "$OUT/lmstudio-models.json" ]; then
  if (cd "$REPO_ROOT" && npm run smoke-test) > "$OUT/smoke-test.txt" 2>&1; then
    pass "smoke test — status + a real diff that git apply accepted"
  else
    fail "smoke test — see smoke-test.txt. This is the gate: if the local model
      cannot produce a diff that applies, nothing downstream is worth running"
  fi
else
  skip "smoke test needs a reachable LM Studio server (step 3 failed)"
fi

# ------------------------------------------------------------ 7. offline suite
printf '\n%s\n' "7. offline test suite"
if (cd "$REPO_ROOT" && npm test) > "$OUT/npm-test.txt" 2>&1; then
  pass "npm test — all green"
else
  TESTLINE="$(grep -E '^ *Tests ' "$OUT/npm-test.txt" | tail -1)"
  note "  ${TESTLINE:-see npm-test.txt}"
  note "  (4 failures are expected ONLY on Windows — CRLF and path separators."
  note "   On macOS this should be all green. Anything red here is real.)"
  fail "npm test — see npm-test.txt"
fi

# ------------------------------------------------------------- 8. collect
printf '\n%s\n' "8. collect"
if [ -f "$REPO_ROOT/.local-coder/telemetry.jsonl" ]; then
  cp "$REPO_ROOT/.local-coder/telemetry.jsonl" "$OUT/telemetry-mac.jsonl"
  pass "telemetry copied ($(wc -l < "$OUT/telemetry-mac.jsonl" | tr -d ' ') rows)"
else
  skip "no telemetry yet — it appears once gate/implement/repair run inside a
      Claude Code session on this machine"
fi

if tar -czf "$ARCHIVE" -C "$OUT" . 2>"$OUT/tar.err"; then
  pass "archive → $ARCHIVE"
else
  fail "could not write $ARCHIVE — see $OUT/tar.err. The per-run directory
      $OUT still holds everything"
fi

printf '\n%s\n' "-------- summary (run $RUN_ID) --------"
grep -E '^(PASS|FAIL|SKIP)' "$SUMMARY" || true
printf '\n%s\n' "Next, and only if the smoke test passed:"
printf '%s\n' "  claude mcp add local-coder -e LOCAL_CODER_MODELS_CSV=\"\$LOCAL_CODER_MODELS_CSV\" -- node \"$REPO_ROOT/dist/server.js\""
printf '%s\n' "  restart Claude Code, then work a real task using implement / repair."
printf '%s\n' "  B6 comes from repair's payload (passed, rounds_used), B7 from"
printf '%s\n' "  rounds[].model_latency_ms and gate_ms. Neither needs the cost meter,"
printf '%s\n' "  which is why they are not blocked by G1 being reopened."
printf '%s\n\n' "  Re-run this script afterwards; it writes a NEW run directory and archive."
