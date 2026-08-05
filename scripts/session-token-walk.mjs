#!/usr/bin/env node
/**
 * B17's oracle: what a session's billed token vector is, counted independently
 * of `src/cost/`.
 *
 * WHY THIS EXISTS. B1 fell at +231% and its record could name only one half of
 * the failure: the meter counted 65% of `/usage`'s cache-read tokens and the
 * scope of the gap "could not be determined from the data available". It is
 * determinable, and it needed no comparator at all. Since Claude Code 2.1.219 a
 * session is not one file, and `listTranscripts` does a non-recursive `readdir`
 * (`src/cost/transcript.ts:319-331`), so every subagent record is invisible to
 * the meter. This file enumerates what the meter should have seen.
 *
 * WHY IT IMPORTS NOTHING FROM `src/cost/`, AND MUST NOT. An oracle that shared
 * code with the thing it checks agrees by construction. The independence that
 * matters here is of the DISCOVERY RULE — which files, which records, which
 * record of a group — not of the arithmetic, which is integer addition either
 * way. Sharing a helper would silently re-import the bug.
 *
 * THE RULE IS NOT MINE. It is Claude Code 2.1.219's own shipped enumerator, and
 * B17 quotes it so that both implementations answer to the premise text rather
 * than to each other: the main directory's `*.jsonl` files, plus
 * `<sessionId>/subagents/**` recursively, de-duplicated by record `uuid`.
 *
 * ADMISSION, in the three steps `PREMISES.md` B17 fixes and freezes:
 *
 *   1. Admit records with `type: "assistant"` carrying `message.usage`.
 *      Exclude `isApiErrorMessage: true` and `model: "<synthetic>"` — they carry
 *      a real `requestId` and all-zero usage, so they must be excluded by those
 *      fields and NEVER by usage reading zero, since a legitimate record can
 *      also read zero at the top level.
 *   2. De-duplicate by `uuid`. That is RECORD identity across the file union,
 *      not request identity.
 *   3. Group by `requestId`; take the group's usage from its LAST record in file
 *      order.
 *
 * Step 3 is the one that found a defect. `src/cost/transcript.ts:239-243` keeps
 * the FIRST record and discards later usage, on the recorded ground that usage
 * repeats verbatim per content block. It does, except for `output_tokens`: over
 * this project 327 of 1,647 multi-record groups differ, in 327 of 327 the first
 * record is the smaller, and the rule drops 655,570 output tokens — 19.27% of
 * all output, at the 5.0x multiplier. `stop_reason` looks like the terminal
 * marker and is not one: 27 groups carry none and 1,300 carry several, while
 * last-in-file-order agrees with the maximum on 2,482 of 2,482.
 *
 * NO FILENAME FILTER. `subagents/workflows/wf_<id>/journal.jsonl` ends in
 * `.jsonl` and is not a request log, but it is excluded by the record predicate
 * rather than by matching its name — a name pattern rots, and the per-file
 * admitted counts below make the exclusion observable instead of assumed.
 *
 * WHAT THIS DELIBERATELY DOES NOT DECIDE. `cacheWrite` is reported as a single
 * total, `max(cache_creation_input_tokens, ephemeral_1h + ephemeral_5m)`, which
 * is what the meter's two classes sum to. The 1h/5m ATTRIBUTION is not scored
 * here and B17 says so: one record in this corpus carries a top-level 0 against
 * an `ephemeral_1h` of 278, and that disagreement is COUNTED and reported rather
 * than resolved. Nor is `usage.iterations` summed — it rolls up to the top level.
 *
 *   node scripts/session-token-walk.mjs walk
 *   node scripts/session-token-walk.mjs walk --session 5fe28335-5fb0-41bc-bdaa-23c84011ec1e
 *   node scripts/session-token-walk.mjs walk --json > evidence/<run_id>.walk.json
 *   node scripts/session-token-walk.mjs files --session <id>
 *
 * Options: --dir=<transcripts> (default: this project's slug under
 * ~/.claude/projects), --root=<project> (what the slug is derived from),
 * --session=<id>, --json.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const flags = new Map(
  argv.filter((a) => a.startsWith("--")).map((a) => {
    const i = a.indexOf("=");
    return i === -1 ? [a.slice(2), "true"] : [a.slice(2, i), a.slice(i + 1)];
  })
);
const positional = argv.filter((a) => !a.startsWith("--"));
const command = positional[0];

const die = (message) => {
  console.error(message);
  process.exit(1);
};

/**
 * Claude Code's project slug: the absolute path with every non-alphanumeric
 * character replaced by a dash. Re-derived here rather than imported, for the
 * independence reason in the header.
 */
function transcriptDir(root, home) {
  const slug = path.resolve(root).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(home, ".claude", "projects", slug);
}

/** Every `*.jsonl` under a directory, recursively. Missing directory is empty. */
function jsonlUnder(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonlUnder(full));
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out.sort();
}

/**
 * The file union of one session: its main transcript, then every `.jsonl` under
 * `<sessionId>/subagents/` recursively. Order is load-bearing — step 3 takes the
 * LAST record in file order — so the main file comes first and subagent files
 * are sorted, deterministically.
 */
function sessionFiles(dir, sessionId) {
  const main = path.join(dir, `${sessionId}.jsonl`);
  try {
    statSync(main);
  } catch {
    die(`no main transcript for session ${sessionId} in ${dir}`);
  }
  return { main, subagents: jsonlUnder(path.join(dir, sessionId, "subagents")) };
}

function listSessions(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    die(`no transcript directory at ${dir}`);
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => e.name.slice(0, -".jsonl".length))
    .sort();
}

const int = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * One record's four classes. `cacheWrite` takes the larger of the top-level
 * total and the TTL split rather than trusting either: they disagree in this
 * corpus, the disagreement is counted by the caller, and picking the larger is
 * the reading that cannot silently drop a token that was written.
 */
function classes(usage) {
  const split = usage.cache_creation;
  const oneHour = split && typeof split === "object" ? int(split.ephemeral_1h_input_tokens) : 0;
  const fiveMin = split && typeof split === "object" ? int(split.ephemeral_5m_input_tokens) : 0;
  const total = int(usage.cache_creation_input_tokens);
  return {
    input: int(usage.input_tokens),
    cacheRead: int(usage.cache_read_input_tokens),
    cacheWrite: Math.max(total, oneHour + fiveMin),
    output: int(usage.output_tokens),
    splitDisagrees: split !== undefined && split !== null && oneHour + fiveMin !== total,
  };
}

function walkSession(dir, sessionId) {
  const files = sessionFiles(dir, sessionId);
  const ordered = [{ file: files.main, isSubagent: false }, ...files.subagents.map((f) => ({ file: f, isSubagent: true }))];

  const seenUuid = new Set();
  const mainUuids = new Set();
  const subUuids = new Set();
  const groups = new Map(); // requestId -> { last, isSubagent, records, files:Set, firstOutput }

  const perFile = [];
  const versions = new Set();
  let uuidDuplicates = 0;
  let excludedApiError = 0;
  let skippedUnparseable = 0;
  let splitDisagreements = 0;
  let sessionIdMismatch = 0;

  for (const { file, isSubagent } of ordered) {
    let admitted = 0;
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        skippedUnparseable += 1;
        continue;
      }
      if (record === null || typeof record !== "object") continue;

      // Step 1 — admit.
      if (record.type !== "assistant") continue;
      const message = record.message;
      if (message === null || typeof message !== "object") continue;
      const usage = message.usage;
      if (usage === null || typeof usage !== "object") continue;
      if (record.isApiErrorMessage === true || message.model === "<synthetic>") {
        excludedApiError += 1;
        continue;
      }

      // Step 2 — de-duplicate by uuid, which is RECORD identity.
      const uuid = record.uuid;
      if (typeof uuid !== "string") continue;
      if (seenUuid.has(uuid)) {
        uuidDuplicates += 1;
        continue;
      }
      seenUuid.add(uuid);
      (isSubagent ? subUuids : mainUuids).add(uuid);
      admitted += 1;

      if (typeof record.version === "string") versions.add(record.version);
      if (typeof record.sessionId === "string" && record.sessionId !== sessionId) sessionIdMismatch += 1;

      // Step 3 — group by requestId; the LAST write wins because files and lines
      // are walked in order. A record with no requestId is its own group.
      const rid = typeof record.requestId === "string" ? record.requestId : `__norid__${uuid}`;
      const c = classes(usage);
      if (c.splitDisagrees) splitDisagreements += 1;
      const existing = groups.get(rid);
      if (existing === undefined) {
        groups.set(rid, { last: c, isSubagent, records: 1, files: new Set([file]), firstOutput: c.output });
      } else {
        existing.last = c;
        existing.records += 1;
        existing.files.add(file);
      }
    }
    perFile.push({ file: path.relative(dir, file), isSubagent, admitted });
  }

  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let mainRequests = 0;
  let subagentRequests = 0;
  let multiRecordGroups = 0;
  let groupsWhereFirstDiffersFromLast = 0;
  let outputLostByFirstWins = 0;
  let groupsSpanningFiles = 0;

  for (const g of groups.values()) {
    tokens.input += g.last.input;
    tokens.cacheRead += g.last.cacheRead;
    tokens.cacheWrite += g.last.cacheWrite;
    tokens.output += g.last.output;
    if (g.isSubagent) subagentRequests += 1;
    else mainRequests += 1;
    if (g.records > 1) multiRecordGroups += 1;
    if (g.firstOutput !== g.last.output) {
      groupsWhereFirstDiffersFromLast += 1;
      outputLostByFirstWins += g.last.output - g.firstOutput;
    }
    if (g.files.size > 1) groupsSpanningFiles += 1;
  }

  const requests = mainRequests + subagentRequests;
  let unionSize = 0;
  for (const u of mainUuids) if (subUuids.has(u)) unionSize += 1;

  return {
    sessionId,
    claudeCodeVersions: [...versions].sort(),
    files: { main: path.relative(dir, files.main), subagents: files.subagents.map((f) => path.relative(dir, f)), perFile },
    records: {
      admitted: seenUuid.size,
      main: mainUuids.size,
      subagent: subUuids.size,
      uuidDuplicatesDropped: uuidDuplicates,
      excludedApiError,
      skippedUnparseable,
    },
    // B17's invariant: |uuids(main) U uuids(sub)| == |main| + |sub|. Without it
    // the union can pass by two errors cancelling.
    uuidDisjoint: {
      mainUuids: mainUuids.size,
      subagentUuids: subUuids.size,
      sharedUuids: unionSize,
      holds: unionSize === 0,
    },
    requests: {
      total: requests,
      main: mainRequests,
      subagent: subagentRequests,
      subagentShare: requests === 0 ? 0 : Number((subagentRequests / requests).toFixed(4)),
    },
    tokens,
    diagnostics: {
      multiRecordGroups,
      groupsWhereFirstDiffersFromLast,
      outputLostByFirstWins,
      groupsSpanningFiles,
      ttlSplitDisagreements: splitDisagreements,
      sessionIdMismatch,
    },
  };
}

const RULE =
  "main *.jsonl + <sessionId>/subagents/** recursive; admit type=assistant with message.usage, " +
  "excluding isApiErrorMessage/synthetic; dedup by uuid; group by requestId; take the LAST record in file order";

function main() {
  const root = flags.get("root") ?? process.cwd();
  const dir = flags.get("dir") ?? transcriptDir(root, os.homedir());
  const only = flags.get("session");
  const json = flags.get("json") === "true";

  if (command === "files") {
    if (only === undefined) die("files needs --session=<id>");
    const files = sessionFiles(dir, only);
    console.log(JSON.stringify({ dir, sessionId: only, files: [files.main, ...files.subagents] }));
    return;
  }

  if (command !== "walk") {
    console.error("usage: session-token-walk.mjs {walk|files} [--dir=<d>] [--root=<p>] [--session=<id>] [--json]");
    process.exit(1);
  }

  const sessions = only === undefined ? listSessions(dir) : [only];
  if (sessions.length === 0) die(`no transcripts found in ${dir}`);
  const walked = sessions.map((s) => walkSession(dir, s));

  if (json) {
    console.log(JSON.stringify({ tool: "session-token-walk", rule: RULE, dir, sessions: walked }, null, 2));
    return;
  }

  const pad = (s, w) => String(s).padStart(w);
  console.log(`${RULE}\n${dir}\n`);
  console.log(
    ["session ", "files", "reqs", "sub%", "input", "cacheRead", "cacheWrite", "output", "uuid?"]
      .map((h, i) => (i === 0 ? h.padEnd(9) : pad(h, [0, 6, 6, 6, 9, 12, 11, 10, 6][i])))
      .join(" ")
  );
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const s of walked) {
    for (const k of Object.keys(totals)) totals[k] += s.tokens[k];
    console.log(
      [
        s.sessionId.slice(0, 8).padEnd(9),
        pad(1 + s.files.subagents.length, 6),
        pad(s.requests.total, 6),
        pad(`${(s.requests.subagentShare * 100).toFixed(0)}%`, 6),
        pad(s.tokens.input.toLocaleString("en-US"), 9),
        pad(s.tokens.cacheRead.toLocaleString("en-US"), 12),
        pad(s.tokens.cacheWrite.toLocaleString("en-US"), 11),
        pad(s.tokens.output.toLocaleString("en-US"), 10),
        pad(s.uuidDisjoint.holds ? "ok" : "FAIL", 6),
      ].join(" ")
    );
  }
  console.log(
    `\n${"TOTAL".padEnd(9)} ${pad("", 6)} ${pad(walked.reduce((n, s) => n + s.requests.total, 0), 6)} ` +
      `${pad("", 6)} ${pad(totals.input.toLocaleString("en-US"), 9)} ` +
      `${pad(totals.cacheRead.toLocaleString("en-US"), 12)} ${pad(totals.cacheWrite.toLocaleString("en-US"), 11)} ` +
      `${pad(totals.output.toLocaleString("en-US"), 10)}`
  );
  const lost = walked.reduce((n, s) => n + s.diagnostics.outputLostByFirstWins, 0);
  const ttl = walked.reduce((n, s) => n + s.diagnostics.ttlSplitDisagreements, 0);
  console.log(
    `\noutput tokens a first-record-wins dedup would drop: ${lost.toLocaleString("en-US")}` +
      `\nrecords whose TTL split disagrees with its total: ${ttl}  (counted, not resolved -- B17 does not score attribution)`
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
