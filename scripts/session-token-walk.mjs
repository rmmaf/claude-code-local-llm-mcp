#!/usr/bin/env node
/**
 * B19's oracle: what a session's billed token vector is, counted independently
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
 * B19 quotes it so that both implementations answer to the premise text rather
 * than to each other: the main directory's `*.jsonl` files, plus
 * `<sessionId>/subagents/**` recursively, de-duplicated by record `uuid`.
 *
 * ADMISSION, in the three steps `PREMISES.md` B19 fixes and freezes:
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
 * WHAT THIS DELIBERATELY DOES NOT DECIDE. `cacheWrite` is the TOP-LEVEL
 * `cache_creation_input_tokens` and the TTL split never overrides it — see
 * `classes()` for why, and for the 42,558 tokens that ride on the choice. The
 * 1h/5m ATTRIBUTION is not scored here and B19 says so; the disagreeing records
 * are COUNTED and their tokens TOTALLED rather than resolved. Nor is
 * `usage.iterations` summed — it rolls up to the top level.
 *
 * WHAT AN EARLIER DRAFT GOT WRONG, kept here because the shape recurs. Its
 * disjointness invariant could not fail: per-source uuid sets were populated
 * after the de-duplication guard, so a uuid present in both a main and a
 * subagent file was recorded against main alone and the subagent occurrence was
 * dropped. It reported `sharedUuids: 0` on a corpus built to violate it, while
 * silently discarding that subagent's request. **A check that cannot fail reads
 * as verification and is not one** — the same failure as the meter printing
 * `(N main, 0 subagent)`. `tests/session-token-walk.test.ts` now holds a corpus
 * where the invariant FAILS, so the claim cannot rot back.
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
 * One record's four classes.
 *
 * `cacheWrite` is the TOP-LEVEL `cache_creation_input_tokens`, and the TTL split
 * is never allowed to override it. That is not a preference, it is the rule
 * `readUsage` already documents — "the split is authoritative when present *and
 * consistent*; otherwise attribute the whole cache write to the 5-minute TTL" —
 * and that text predates every line of B19, so choosing it cannot be fitting.
 *
 * It matters because the two disagree. Fifteen records in this corpus carry a
 * top-level total of 0 against an `ephemeral_1h` of 2,452 to 4,911, and taking
 * the larger of the two — which an earlier draft of this file did — puts 42,558
 * tokens on the oracle's side of a comparison whose other side, once repaired to
 * require consistency, will report 0. B19 would then fall on a rule this file
 * chose rather than on anything the meter did.
 *
 * The 15 records and their 42,558 split-only tokens are REPORTED, both as a
 * count and as a total, so the quantity is visible and unscored rather than
 * invisible and absorbed. Which reading Anthropic actually bills is not
 * decidable from these files and B19 says in terms that it does not score TTL
 * attribution; whoever wants that answer needs a premise of their own.
 */
function classes(usage) {
  const split = usage.cache_creation;
  const hasSplit = split !== undefined && split !== null && typeof split === "object";
  const oneHour = hasSplit ? int(split.ephemeral_1h_input_tokens) : 0;
  const fiveMin = hasSplit ? int(split.ephemeral_5m_input_tokens) : 0;
  const total = int(usage.cache_creation_input_tokens);
  return {
    input: int(usage.input_tokens),
    cacheRead: int(usage.cache_read_input_tokens),
    cacheWrite: total,
    output: int(usage.output_tokens),
    splitDisagrees: hasSplit && oneHour + fiveMin !== total,
    splitOnlyTokens: hasSplit ? Math.max(0, oneHour + fiveMin - total) : 0,
  };
}

function walkSession(dir, sessionId) {
  const files = sessionFiles(dir, sessionId);
  const ordered = [{ file: files.main, isSubagent: false }, ...files.subagents.map((f) => ({ file: f, isSubagent: true }))];

  const seenUuid = new Set();
  // uuid -> bitmask, 1 = seen in the main file, 2 = seen in a subagent file.
  // Recorded for EVERY admitted record, BEFORE the de-duplication decision. An
  // earlier draft populated per-source sets after the `seenUuid` guard, which
  // made the disjointness invariant below unable to fail: main is walked first,
  // so a uuid present in both files was only ever added to the main set and the
  // subagent occurrence was dropped as a duplicate. The check reported
  // sharedUuids 0 by construction while silently discarding the subagent's
  // request. A check that cannot fail reads as verification and is not one.
  const uuidSources = new Map();
  const groups = new Map(); // requestId -> { last, isSubagent, records, files:Set, firstOutput }

  const perFile = [];
  const versions = new Set();
  let uuidDuplicates = 0;
  let excludedApiError = 0;
  let skippedUnparseable = 0;
  let splitDisagreements = 0;
  let splitOnlyTokens = 0;
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
      // Source is recorded first, so the invariant sees the occurrence even when
      // the accounting drops it as a duplicate.
      uuidSources.set(uuid, (uuidSources.get(uuid) ?? 0) | (isSubagent ? 2 : 1));
      if (seenUuid.has(uuid)) {
        uuidDuplicates += 1;
        continue;
      }
      seenUuid.add(uuid);
      admitted += 1;

      if (typeof record.version === "string") versions.add(record.version);
      if (typeof record.sessionId === "string" && record.sessionId !== sessionId) sessionIdMismatch += 1;

      // Step 3 — group by requestId; the LAST write wins because files and lines
      // are walked in order. A record with no requestId is its own group.
      const rid = typeof record.requestId === "string" ? record.requestId : `__norid__${uuid}`;
      const c = classes(usage);
      if (c.splitDisagrees) splitDisagreements += 1;
      splitOnlyTokens += c.splitOnlyTokens;
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

  // Counted from uuidSources, which saw every occurrence, not from the
  // de-duplicated accounting sets. These three can and do disagree, and that is
  // the whole point of the invariant.
  let inMain = 0;
  let inSub = 0;
  let inBoth = 0;
  for (const mask of uuidSources.values()) {
    if (mask & 1) inMain += 1;
    if (mask & 2) inSub += 1;
    if (mask === 3) inBoth += 1;
  }

  return {
    sessionId,
    claudeCodeVersions: [...versions].sort(),
    files: { main: path.relative(dir, files.main), subagents: files.subagents.map((f) => path.relative(dir, f)), perFile },
    records: {
      admitted: seenUuid.size,
      main: inMain,
      subagent: inSub,
      uuidDuplicatesDropped: uuidDuplicates,
      excludedApiError,
      skippedUnparseable,
    },
    // B19's invariant: |uuids(main) U uuids(sub)| == |main| + |sub|, i.e. no uuid
    // occurs on both sides. Without it the union can pass by two errors
    // cancelling. `tests/session-token-walk.test.ts` holds a corpus where it
    // FAILS, because an invariant never shown to fail is not evidence.
    uuidDisjoint: {
      mainUuids: inMain,
      subagentUuids: inSub,
      sharedUuids: inBoth,
      holds: inBoth === 0,
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
      ttlSplitOnlyTokens: splitOnlyTokens,
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
  const ttlTokens = walked.reduce((n, s) => n + s.diagnostics.ttlSplitOnlyTokens, 0);
  const shared = walked.reduce((n, s) => n + s.uuidDisjoint.sharedUuids, 0);
  console.log(
    `\noutput tokens a first-record-wins dedup would drop: ${lost.toLocaleString("en-US")}` +
      `\nrecords whose TTL split disagrees with its total: ${ttl}, carrying ${ttlTokens.toLocaleString("en-US")} ` +
      `tokens the split reports and the total does not` +
      `\n  (counted, not resolved -- cacheWrite is the top-level total on BOTH sides; B19 does not score attribution)` +
      `\nuuids occurring in both a main and a subagent file: ${shared}  (must be 0)`
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
