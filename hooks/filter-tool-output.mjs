#!/usr/bin/env node
/**
 * PostToolUse hook — DEAD, UNREGISTERED, AND NOT TO BE INSTALLED.
 *
 * ⚠ THIS FILE IS KEPT ON DISK AS A RETEST FIXTURE, NOT AS A FEATURE. It was
 * intended to keep command noise out of Claude's context, and it does condense
 * text correctly — 604 lines to 4 on a failing test run. That was never the
 * question. The question was whether `hookSpecificOutput.updatedToolOutput`
 * changes what Claude Code STORES AND BILLS, and the measured answer is no:
 * on a real command the hook fired, filtered 30,136 bytes down to 8,462 and
 * wrote its spill file, and the transcript recorded 30,000 characters of raw
 * output anyway. The replacement never arrived. See `PREMISES.md § B2`
 * (**fallen**, `run 2026-08-02-win-03`) and `ROADMAP.md § G2` (**closed —
 * dead**). The hook is unregistered from `.claude/settings.json` and is off the
 * critical path of every Bash call.
 *
 * DO NOT REGISTER IT. No saving from this hook may be reported as measured,
 * anywhere. The only sanctioned way it comes back is G2's reopening condition,
 * which is written down with its threshold and its ONE attempt fixed in
 * advance: return `{stdout, stderr, interrupted, isImage}` — the shape a Bash
 * result actually has, and the specific reason the bare-string form failed —
 * and show `cache_creation_input_tokens` dropping measurably on the following
 * request, under a new `run_id`. Suppression that does work lives in `gate`,
 * which controls its own returned payload and needs no hook.
 *
 * What the body below still gets right, and why it is worth keeping:
 * - Why suppression is worth anything at all: a token that enters the context is
 *   paid for once as a cache write and then re-read on EVERY later request in
 *   the session. Measured on a real 69-request session, a token entering at
 *   turn 0 cost 8.8x the input rate.
 * - Why it is reversible: arXiv 2607.12161 measured an arm that removed 38% of
 *   tool-output tokens and cost 6.8% MORE, dropping patch application from 27/40
 *   to 15/40 — because it destroyed the verbatim anchors edits depend on. Every
 *   suppression here writes the full text to .local-coder/spill/ and says so.
 * - Contract: JSON on stdin, JSON on stdout. Fails open — any error prints `{}`
 *   and exits 0, so a bug here can never break a session.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Below this, suppression cannot pay for its own risk. */
const MIN_BYTES = 2048;
/** Give up unless we remove at least this fraction — a small win is not worth it. */
const MIN_GAIN = 0.15;
/** Head/tail budget for the last-resort cap. */
const HEAD_LINES = 120;
const TAIL_LINES = 80;
/** Cap on error lines rescued from an elided middle. */
const MAX_LIFTED = 60;

/**
 * Lines that must survive verbatim. Errors are the payload, and diff/patch
 * markers are the anchors a later edit matches against.
 */
const PINNED =
  /(^|\b)(err|error|fatal|fail|fails|failed|failure|failing|exception|traceback|panic|assert\w*|cannot|denied|refused|not ok|undefined reference|segmentation fault|TS\d{4}|\w*Error)\b|^\s*at\s+\S+\s*\(|^[+-]{3}\s|^@@\s|^\s*[✕✖×✗]/i;

/** Commands whose output IS the anchor, never noise. Bail out entirely. */
const VERBATIM_COMMAND = /\bgit\s+(diff|show|status|log|blame|apply|stash)\b|\bdiff\b|\bpatch\b/;

/** Pure progress: percentages, bars, throughput counters, spinner frames. */
const PROGRESS =
  /^\s*(\[?\d{1,3}%\]?|[#=>.█░●-]{6,})\s*$|\b\d+(\.\d+)?\s?[KMG]i?B\/s\b|\b(ETA|eta)\s+\d|^\s*[|/\\-]\s*$/;

/** Package-manager chatter that carries no signal once the command succeeded. */
const INSTALL_NOISE =
  /^\s*(Collecting|Downloading|Downloaded|Using cached|Requirement already satisfied|Fetching|Resolving|Extracting|Preparing|Building wheel|Stored in directory|Unpacking|Selecting previously)\b|node_modules[/\\]/;

/** Per-item success lines, dropped only when the run reported no failure. */
const ITEM_OK =
  /^\s*([✓✔√]|ok\b|PASS(ED)?\b|SKIP(PED)?\b)|\b(PASS|ok)\s+\S+\.(test|spec)\.\w+/i;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Collapse runs of identical lines. Two repeats stay verbatim (cheap, and
 * preserves the shape of short paired output); longer runs become one line
 * plus a count, which is lossless in meaning.
 */
function collapseRepeats(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let run = 1;
    while (i + run < lines.length && lines[i + run] === lines[i]) run++;
    if (run > 2) {
      out.push(`${lines[i]}    [x${run}]`);
    } else {
      for (let k = 0; k < run; k++) out.push(lines[i]);
    }
    i += run;
  }
  return out;
}

function condense(text) {
  const original = text.split("\n");

  let lines = original.filter((line) => {
    if (line.trim() === "") return true;
    // PINNED is checked first, so a line like "PASSED: 3, FAILED: 2" survives
    // even though it also matches ITEM_OK.
    if (PINNED.test(line)) return true;
    if (PROGRESS.test(line)) return false;
    if (INSTALL_NOISE.test(line)) return false;
    // Per-item success lines are never load-bearing — the run's summary line
    // survives, and dropping them is what makes a failing test run readable
    // instead of 600 lines of PASS around the one FAIL that matters.
    if (ITEM_OK.test(line)) return false;
    return true;
  });

  lines = collapseRepeats(lines);

  const squeezed = [];
  for (const line of lines) {
    if (line.trim() === "" && (squeezed[squeezed.length - 1] ?? "").trim() === "") continue;
    squeezed.push(line);
  }
  lines = squeezed;

  if (lines.length > HEAD_LINES + TAIL_LINES) {
    const total = lines.length;
    const head = lines.slice(0, HEAD_LINES);
    const tail = lines.slice(-TAIL_LINES);
    const lifted = lines
      .slice(HEAD_LINES, total - TAIL_LINES)
      .filter((line) => PINNED.test(line))
      .slice(0, MAX_LIFTED);
    lines = [
      ...head,
      ...(lifted.length > 0
        ? ["", `[local-coder] ${lifted.length} error line(s) lifted from the elided middle:`, ...lifted]
        : []),
      "",
      `[local-coder] ... ${total - HEAD_LINES - TAIL_LINES} middle line(s) elided ...`,
      "",
      ...tail,
    ];
  }

  return { text: lines.join("\n"), originalLines: original.length, keptLines: lines.length };
}

function spill(cwd, full) {
  const digest = createHash("sha256").update(full).digest("hex").slice(0, 12);
  const rel = path.join(".local-coder", "spill", `${digest}.txt`);
  const abs = path.join(cwd, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, full, "utf8");
  return rel.split(path.sep).join("/");
}

function recordTelemetry(cwd, entry) {
  try {
    const file = path.join(cwd, ".local-coder", "telemetry.jsonl");
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch {
    // Telemetry is bookkeeping; never let it affect the hook's decision.
  }
}

function decide(input) {
  if (input.tool_name !== "Bash") return {};

  const response = input.tool_response ?? {};
  if (response.interrupted === true || response.isImage === true) return {};

  const stdout = typeof response.stdout === "string" ? response.stdout : "";
  const stderr = typeof response.stderr === "string" ? response.stderr : "";
  const joiner = stdout === "" || stdout.endsWith("\n") ? "" : "\n";
  const combined = stderr === "" ? stdout : `${stdout}${joiner}${stderr}`;
  if (combined.length < MIN_BYTES) return {};

  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  // Diffs, patches and git porcelain are anchors: their exact bytes are the
  // point. This guard is what keeps us out of the failure mode that made
  // blanket compression cost more than it saved.
  if (VERBATIM_COMMAND.test(command) || /^diff --git |^@@ .* @@/m.test(combined)) return {};

  const result = condense(combined);
  const gain = 1 - result.text.length / combined.length;
  if (gain < MIN_GAIN) return {};

  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  const spillPath = spill(cwd, combined);
  const suppressed = result.originalLines - result.keptLines;
  const updated =
    `${result.text}\n\n[local-coder] ${suppressed} of ${result.originalLines} line(s) suppressed ` +
    `(${Math.round(gain * 100)}% smaller). Full output preserved at ${spillPath} — read it if you need ` +
    `an exact line.`;

  recordTelemetry(cwd, {
    tool: "hook:Bash",
    bytes_raw: combined.length,
    bytes_returned: updated.length,
    turns_collapsed: 0,
    latency_ms: 0,
    detail: { command: command.slice(0, 120), spill: spillPath, lines_suppressed: suppressed },
  });

  return {
    hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: updated },
    suppressOutput: true,
  };
}

async function main() {
  const raw = await readStdin();
  if (raw.trim() === "") return {};
  return decide(JSON.parse(raw));
}

main()
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch(() => process.stdout.write("{}"))
  .finally(() => process.exit(0));
