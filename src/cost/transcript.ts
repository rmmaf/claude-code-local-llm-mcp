import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

/**
 * Reader for Claude Code session transcripts (`~/.claude/projects/<slug>/*.jsonl`).
 *
 * The one thing that makes this file worth having: a single billed request is
 * written to the transcript as SEVERAL `assistant` records — one per content
 * block — each carrying an identical copy of `message.usage`. Summing the
 * records overcounts. Measured on a real session: 155 assistant records for 69
 * billed requests, inflating cache_read 2.3x. Everything here dedups by
 * `requestId` first and only then adds anything up.
 */

export interface TokenUsage {
  /** Fresh, uncached input. */
  input: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
  cacheRead: number;
  output: number;
}

export interface ToolUse {
  id: string;
  name: string;
}

export interface BilledRequest {
  requestId: string;
  sessionId: string;
  model: string;
  /**
   * `usage.speed` as reported by Claude Code ("standard", "fast", ...), or null
   * when the field is absent. Part of the price — see `rateKey` in rates.ts.
   */
  speed: string | null;
  isSidechain: boolean;
  timestampMs: number;
  /** Opaque id of the conversation thread: "main", or the root uuid of a subagent. */
  thread: string;
  /** Compaction segment within the thread. Context resets at each boundary. */
  segment: number;
  /** Position within thread+segment — the `t` of the positional multiplier. */
  index: number;
  /** Billed requests in the same thread+segment — the `T`. */
  segmentSize: number;
  usage: TokenUsage;
  toolUses: ToolUse[];
}

export interface ToolResultRecord {
  toolUseId: string | null;
  /** Tool name, resolved from the `tool_use` block this answers. */
  name: string | null;
  /** Serialized size of the result payload, the proxy for what entered context. */
  bytes: number;
  timestampMs: number;
  isSidechain: boolean;
  /** Conversation thread, so a subagent's tool call is not priced against main. */
  thread: string;
  /** `invocation_id` echoed by our own tools, for an exact telemetry join. */
  invocationId: string | null;
}

export interface Transcript {
  /** Every file the session was read from — main transcript first. */
  files: string[];
  /** Kept for the single-file callers and the report header. */
  file: string;
  sessionId: string;
  requests: BilledRequest[];
  toolResults: ToolResultRecord[];
  /** Lines that failed to parse — a live session's last line is often partial. */
  skippedLines: number;
  /**
   * RECORDS the rule admitted that carry no uuid, so nothing could de-duplicate
   * them — what it KEPT and cannot vouch for, not what it threw away.
   *
   * The unit is records, like every `excluded` count below and unlike
   * `requests`, which are `requestId` GROUPS. **Neither number bounds the
   * other, in either direction** — measured 3 against 1 request on a session
   * that is one group of three uuid-less records, and 2 against 4 on a session
   * where those two share a group and three others carry uuids. Comparing them
   * is meaningless; the bound that does hold is the count of admitted RECORDS,
   * which is not reported here.
   *
   * Counting per record rather than per group is the point: the risk is that any
   * ONE of them reappears in a second file with nothing able to catch it, so a
   * per-group count can understate it — equal when a group holds one such
   * record, lower when it holds several. B20's oracle counts the same way and
   * additionally marks such a session `suspect`, dropping it from the scored
   * set. All eleven sessions in that set report 0.
   */
  admittedWithoutUuid: number;
  /**
   * What the admission rule threw away, so a zero is never ambiguous. B20's
   * oracle reports the same four counts and the two must agree; a silent
   * exclusion is how a session with traffic reads as a clean one.
   */
  excluded: {
    duplicateUuid: number;
    apiError: number;
    foreignSession: number;
    noSessionId: number;
  };
}

/**
 * THE FIELDS THE METER READS — every one of them, and nothing else.
 *
 * This is `readTranscript`'s parse target, so the set is not a judgement about
 * what matters: it is what the parser declares it will look at. Everything else
 * Claude Code writes on a transcript line (`cwd`, `version`, `gitBranch`,
 * `userType`, `message.id`, `stop_reason`, …) is never read here and never will
 * be without this interface changing.
 *
 * **EXPORTED BECAUSE `design.artifacts` 6 NAMES THIS SET AND ENUMERATES IT
 * SHORT.** The clause says "the admitted records reduced to the fields the meter
 * reads" and then lists eight — `requestId, uuid, sessionId, type, model, usage,
 * timestamp, isApiErrorMessage` — which cannot rebuild a `Transcript`: no
 * threads without `parentUuid` and `isSidechain`, no segments without
 * `isCompactSummary`, no tool join without `message.content` and
 * `toolUseResult`. The criterion governs and the enumeration is incomplete
 * against it (`docs/b12-scorer/FINDINGS.md` F24), so `src/cost/b12/capture.ts`
 * reduces to THIS interface and a type-level assert there fails the build if the
 * two drift apart.
 *
 * `toolUseResult` is kept VERBATIM and cannot be summarised: the meter's number
 * is `JSON.stringify(record.toolUseResult).length`, and `readInvocationId` scans
 * the same string. Storing the derived byte count instead would archive the
 * meter's answer rather than its input, which is the one substitution an archive
 * built for re-scoring may not make.
 */
export interface RawRecord {
  type?: string;
  uuid?: string;
  isApiErrorMessage?: boolean;
  parentUuid?: string | null;
  requestId?: string;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  compactMetadata?: unknown;
  toolUseResult?: unknown;
  message?: {
    model?: string;
    usage?: Record<string, unknown>;
    content?: unknown;
  };
}

/**
 * An api-error record: `type: "assistant"`, a real `requestId`, all-zero usage,
 * and `model: "<synthetic>"`. Excluded by these fields and NEVER by usage
 * reading zero, since a legitimate record can read zero at the top level.
 *
 * Shared by the anchor and the billed-request loop deliberately. They disagreed
 * once — see `isBillableShape` — and a predicate written twice is a predicate
 * that will differ.
 */
function isApiError(record: RawRecord): boolean {
  return record.isApiErrorMessage === true || record.message?.model === "<synthetic>";
}

/**
 * The shape that may be a billed request, and therefore the ONLY shape allowed
 * to decide which session these files belong to.
 *
 * The anchor used to be the first `type: "assistant"` record carrying a
 * `sessionId`, api-error records included. One such record at the head of a file
 * — they lead a file often, being what a retry writes first — carrying a
 * different `sessionId` set the anchor to a session that owns nothing here, and
 * then every legitimate record was excluded as foreign. Measured on a fixture:
 * two real requests, both dropped, and the CLI printed NOTHING AT ALL.
 *
 * **A record the admission rule refuses to count must not be allowed to decide
 * what counts.**
 */
function isBillableShape(record: RawRecord): boolean {
  return (
    record.type === "assistant" &&
    typeof record.requestId === "string" &&
    record.message?.usage !== undefined &&
    !isApiError(record)
  );
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `usage.speed` when Claude Code reports one. Absent on older transcripts. */
function readSpeed(raw: Record<string, unknown> | undefined): string | null {
  const value = raw?.speed;
  return typeof value === "string" && value !== "" ? value : null;
}

function readUsage(raw: Record<string, unknown> | undefined): TokenUsage {
  if (raw === undefined) {
    return { input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0 };
  }
  const creation = raw.cache_creation;
  const split =
    creation !== null && typeof creation === "object"
      ? (creation as Record<string, unknown>)
      : undefined;

  const total = num(raw.cache_creation_input_tokens);
  const oneHour = split ? num(split.ephemeral_1h_input_tokens) : 0;
  const fiveMin = split ? num(split.ephemeral_5m_input_tokens) : 0;

  // The split is authoritative when present and consistent; otherwise attribute
  // the whole cache write to the 5-minute TTL, which is the cheaper class and
  // therefore the conservative guess (it never inflates a claimed saving).
  //
  // THE CONSISTENCY HALF WAS NEVER WRITTEN. The guard read `splitTotal > 0`, so
  // a split that disagreed with its own total was used anyway and
  // `Math.max(0, total - splitTotal)` silently swallowed the difference. Over
  // this project 15 records carry `cache_creation_input_tokens: 0` against an
  // `ephemeral_1h` of 2,452 to 4,911: the meter booked 42,558 cacheWrite-1h
  // tokens that the top-level field calls zero, in the class carrying the 2.0x
  // multiplier. 5,634 records are consistent and **none** has a split BELOW its
  // total, so the `Math.max` branch never fired in this corpus — it was covering
  // a case that does not occur while admitting the one that does.
  //
  // Now: equal or nothing. Either way the two classes sum to the top-level
  // total, which is what `scripts/session-token-walk.mjs` counts, so the two
  // sides of B20 agree on this record by construction rather than by luck.
  const splitTotal = oneHour + fiveMin;
  const useSplit = split !== undefined && splitTotal === total;

  return {
    input: num(raw.input_tokens),
    cacheWrite1h: useSplit ? oneHour : 0,
    cacheWrite5m: useSplit ? fiveMin : total,
    cacheRead: num(raw.cache_read_input_tokens),
    output: num(raw.output_tokens),
  };
}

function readToolUses(content: unknown): ToolUse[] {
  if (!Array.isArray(content)) return [];
  const out: ToolUse[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_use") continue;
    if (typeof b.id === "string" && typeof b.name === "string") out.push({ id: b.id, name: b.name });
  }
  return out;
}

function readToolResultId(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_result" && typeof b.tool_use_id === "string") return b.tool_use_id;
  }
  return null;
}

/**
 * Pull our tools' `invocation_id` out of a serialized tool result.
 *
 * Scanned from the serialized form rather than walked structurally on purpose:
 * a client is free to wrap the payload (`{content:[{type:"text",text:"…"}]}`,
 * an extra `structuredContent`, an escaped JSON string), and the id is the same
 * either way. Anchored to a UUID so it cannot match arbitrary prose.
 */
function readInvocationId(serialized: string): string | null {
  const match = /"invocation_id\\?"\s*:\s*\\?"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(
    serialized
  );
  return match === null ? null : (match[1] as string);
}

function parseTime(value: string | undefined): number {
  if (value === undefined) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Walk `parentUuid` links up to the highest ancestor that is still a sidechain
 * record. That root uuid identifies one subagent's conversation, so each
 * subagent gets its own `T` instead of being pooled with every other.
 */
function sidechainRoot(uuid: string, parents: Map<string, string | null>, sidechains: Set<string>): string {
  let current = uuid;
  for (let hops = 0; hops < 10_000; hops++) {
    const parent = parents.get(current);
    if (parent === undefined || parent === null || !sidechains.has(parent)) return current;
    current = parent;
  }
  return current;
}

/**
 * Parse ONE SESSION, which since Claude Code 2.1.219 is several files: the main
 * transcript plus every `.jsonl` under `<sessionId>/`. Passing a bare string
 * still reads a single file, which is what `--file` and the older tests do.
 *
 * The session's identity comes from THE RECORDS, not from the path. A caller may
 * pass one to be explicit, but with none the anchor is the first admitted
 * record's own `sessionId` — a filename is a convention and `record.sessionId` is
 * the data. Records that disagree with the anchor are excluded, because a file
 * sitting under a session's directory is not thereby a request OF that session.
 *
 * Anchoring on the FILENAME instead was tried and reverted the same hour: a
 * corpus whose files are named anything else came back with every record
 * excluded and the session read as empty, which is the false-empty failure this
 * repair exists to remove, reintroduced by the repair.
 *
 * Unparseable lines are counted, never fatal.
 */
export async function readTranscript(
  file: string | string[],
  sessionId?: string
): Promise<Transcript> {
  const files = typeof file === "string" ? [file] : [...file];
  if (files.length === 0) throw new Error("readTranscript needs at least one file");

  const raw: RawRecord[] = [];
  let skippedLines = 0;
  for (const one of files) {
    const text = await fs.readFile(one, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        raw.push(JSON.parse(line) as RawRecord);
      } catch {
        skippedLines++;
      }
    }
  }

  // PASS 0 — RECORD-LEVEL ADMISSION, APPLIED ONCE.
  //
  // Everything downstream iterates the result, because there is more than one
  // loop over these records and the previous version guarded only one of them.
  // Billed requests were de-duplicated and session-checked; `toolUseResult`
  // records were not, so a record present in two files of one session had its
  // bytes counted twice -- 3 records and 60,611 bytes on this corpus -- and a
  // foreign record's bytes would have been attributed here outright. Applying
  // the rule per consumer is how consumers drift apart; applying it once is why
  // they cannot.
  //
  // Only the two record-level concerns live here. `uuid` is RECORD identity
  // across the file union, and a `sessionId` that positively disagrees is
  // somebody else's record whatever kind it is. "Cannot tell whose" is a
  // different question and stays in the billed-request loop, where it is the
  // only place it can change a number.
  let anchor = sessionId;
  if (anchor === undefined) {
    for (const record of raw) {
      if (isBillableShape(record) && typeof record.sessionId === "string") {
        anchor = record.sessionId;
        break;
      }
    }
  }

  const records: RawRecord[] = [];
  const seenUuid = new Set<string>();
  const excluded = { duplicateUuid: 0, apiError: 0, foreignSession: 0, noSessionId: 0 };
  // Admitted but undedupable: the rule admits it, and nothing can catch it if
  // the same record ever appears in two files. Counted so the risk is stated.
  let admittedWithoutUuid = 0;
  let noKeySeq = 0;
  for (const record of raw) {
    if (typeof record.uuid === "string") {
      if (seenUuid.has(record.uuid)) {
        excluded.duplicateUuid++;
        continue;
      }
      seenUuid.add(record.uuid);
    }
    // A record with no uuid is simply not de-duplicable. Whether it is ADMITTED
    // is not this pass's question, and answering it here meant re-implementing
    // half the admission predicate -- assistant plus usage, without the api-error
    // or session checks -- so an api-error record with no uuid was counted as
    // admittedWithoutUuid AND as excluded.apiError. The same record, both ways.
    // The count now happens where admission actually happens, once.
    if (anchor !== undefined && typeof record.sessionId === "string" && record.sessionId !== anchor) {
      excluded.foreignSession++;
      continue;
    }
    records.push(record);
  }

  const parents = new Map<string, string | null>();
  const sidechains = new Set<string>();
  for (const record of records) {
    if (typeof record.uuid !== "string") continue;
    parents.set(record.uuid, record.parentUuid ?? null);
    if (record.isSidechain === true) sidechains.add(record.uuid);
  }

  // Pass 1: dedup usage by requestId, but collect tool_use blocks from EVERY
  // record of that request — the usage repeats, the content blocks do not.
  const byRequest = new Map<string, BilledRequest>();
  const toolNames = new Map<string, string>();
  /**
   * Compaction boundaries PER THREAD. A compaction resets one conversation's
   * context; main and each subagent have independent contexts. Pooling the
   * boundaries would let a subagent's compaction reset the main thread's `t`
   * (and vice versa), corrupting every positional multiplier derived from it.
   */
  const boundariesByThread = new Map<string, number[]>();

  for (const record of records) {
    if (record.isCompactSummary === true || record.compactMetadata !== undefined) {
      const uuid = typeof record.uuid === "string" ? record.uuid : null;
      const thread =
        record.isSidechain === true && uuid !== null ? sidechainRoot(uuid, parents, sidechains) : "main";
      const list = boundariesByThread.get(thread);
      if (list === undefined) boundariesByThread.set(thread, [parseTime(record.timestamp)]);
      else list.push(parseTime(record.timestamp));
    }
    // ADMISSION, the four steps `PREMISES.md` B20 fixes, in its order. The
    // meter and `scripts/session-token-walk.mjs` answer to that text rather than
    // to each other, which is the only reason a residual of exactly 0 means
    // anything. Every exclusion is counted; none is silent.
    // `requestId` is a GROUPING KEY, not an admission condition, and B20's rule
    // does not list it as one. Requiring it here silently dropped usage-bearing
    // records -- the mirror of the oracle silently dropping records with no
    // `uuid`. Opposite directions, both silent, and on a corpus where every
    // record carries both keys the two sides agreed by accident.
    if (record.type !== "assistant") continue;
    if (record.message?.usage === undefined) continue;
    if (isApiError(record)) {
      excluded.apiError++;
      continue;
    }
    // "Cannot tell whose it is" only changes a number here, so it is refused
    // here. Pass 0 already removed everything that positively belongs elsewhere.
    if (anchor !== undefined && typeof record.sessionId !== "string") {
      excluded.noSessionId++;
      continue;
    }

    const toolUses = readToolUses(record.message?.content);
    for (const use of toolUses) toolNames.set(use.id, use.name);

    // Admitted, and undedupable. Counted HERE -- past every exclusion -- so the
    // number cannot contradict the one beside it, and so it means what the
    // oracle's field of the same name means.
    if (typeof record.uuid !== "string") admittedWithoutUuid++;

    // A record with no `requestId` cannot be grouped with anything, so it is its
    // own group of one — which is what step 4 already implies and what the
    // oracle has always done.
    const rid =
      typeof record.requestId === "string"
        ? record.requestId
        : `__norid__${typeof record.uuid === "string" ? record.uuid : `#${noKeySeq++}`}`;
    const existing = byRequest.get(rid);
    if (existing !== undefined) {
      existing.toolUses.push(...toolUses);
      // THE LAST RECORD OF A GROUP CARRIES THE USAGE, NOT THE FIRST.
      //
      // This kept the first and discarded every later one, on the recorded
      // ground that "usage repeats verbatim on every content block of one
      // request" (`MEASUREMENTS.jsonl:9`, checked on one session at `:54`). It
      // repeats — except for `output_tokens`. Over this project 327 of 1,647
      // multi-record groups differ, and in 327 of 327 the FIRST record holds the
      // SMALLER value: intermediate records carry a partial completion count and
      // the terminal one carries the whole answer. Keeping the first dropped
      // 655,570 output tokens, 19.27% of all output, at the 5.0x multiplier.
      //
      // Last in file order, not `stop_reason`, which looks like the terminal
      // marker and is not one: 27 groups carry none at all and 1,300 carry more
      // than one, while last-in-order agrees with the maximum on 2,482 of 2,482.
      //
      // Usage and speed move together because they come from the same object —
      // taking the count from one record and its speed from another would price
      // a request at a rate it never ran at. Everything else stays with the
      // first record on purpose: `timestampMs`, `thread` and `segment` place the
      // request in the conversation, and a request is placed where it started.
      existing.usage = readUsage(record.message?.usage);
      existing.speed = readSpeed(record.message?.usage);
      continue;
    }

    const isSidechain = record.isSidechain === true;
    // Falls back to the grouping key, which is always a string by now.
    const uuid = typeof record.uuid === "string" ? record.uuid : rid;
    byRequest.set(rid, {
      requestId: rid,
      sessionId: record.sessionId ?? "",
      model: record.message?.model ?? "unknown",
      speed: readSpeed(record.message?.usage),
      isSidechain,
      timestampMs: parseTime(record.timestamp),
      thread: isSidechain ? sidechainRoot(uuid, parents, sidechains) : "main",
      segment: 0,
      index: 0,
      segmentSize: 0,
      usage: readUsage(record.message?.usage),
      toolUses,
    });
  }

  const requests = [...byRequest.values()].sort((a, b) => a.timestampMs - b.timestampMs);

  // Pass 2: assign segments (context resets at each compaction), then position
  // and size within thread+segment.
  for (const list of boundariesByThread.values()) list.sort((a, b) => a - b);
  const counts = new Map<string, number>();
  for (const request of requests) {
    const boundaries = boundariesByThread.get(request.thread) ?? [];
    request.segment = boundaries.filter((b) => b <= request.timestampMs).length;
    const key = `${request.thread}#${request.segment}`;
    const seen = counts.get(key) ?? 0;
    request.index = seen;
    counts.set(key, seen + 1);
  }
  for (const request of requests) {
    request.segmentSize = counts.get(`${request.thread}#${request.segment}`) ?? 1;
  }

  const toolResults: ToolResultRecord[] = [];
  for (const record of records) {
    if (record.toolUseResult === undefined) continue;
    const id = readToolResultId(record.message?.content);
    const serialized = JSON.stringify(record.toolUseResult);
    const uuid = typeof record.uuid === "string" ? record.uuid : null;
    toolResults.push({
      toolUseId: id,
      name: id !== null ? (toolNames.get(id) ?? null) : null,
      bytes: serialized.length,
      timestampMs: parseTime(record.timestamp),
      isSidechain: record.isSidechain === true,
      thread: record.isSidechain === true && uuid !== null ? sidechainRoot(uuid, parents, sidechains) : "main",
      invocationId: readInvocationId(serialized),
    });
  }

  return {
    files,
    file: files[0]!,
    sessionId: anchor ?? requests[0]?.sessionId ?? path.basename(files[0]!, ".jsonl"),
    requests,
    toolResults,
    skippedLines,
    admittedWithoutUuid,
    excluded,
  };
}

/**
 * Default transcript directory for a project root, mirroring Claude Code's own
 * slug: every non-alphanumeric character becomes a dash. Verified against a
 * live directory name — the dot in `.claude` is replaced too, so a narrower
 * separators-only regex silently points at a directory that does not exist.
 */
export function projectTranscriptDir(root: string, home: string): string {
  const slug = path.resolve(root).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(home, ".claude", "projects", slug);
}

/** List transcript files in a directory, newest last. Missing directory → []. */
export async function listTranscripts(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name));
  const stats = await Promise.all(
    files.map(async (file) => ({ file, mtime: (await fs.stat(file)).mtimeMs }))
  );
  return stats.sort((a, b) => a.mtime - b.mtime).map((s) => s.file);
}

/**
 * Every `*.jsonl` under a directory, recursively.
 *
 * ONLY `ENOENT` MAY BE SWALLOWED. A missing directory is a fact about the corpus
 * — a single-threaded session has none. `EACCES`, `ENOTDIR`, `EPERM` and `EIO`
 * are facts about this process, and returning `[]` for one of those reports "no
 * subagent traffic" for a session that has some, which is the defect this whole
 * repair exists to remove.
 */
async function jsonlUnder(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsonlUnder(full)));
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out.sort();
}

/**
 * The file union of one session: its main transcript, then every `.jsonl`
 * anywhere under `<sessionId>/`, sorted.
 *
 * NOT `<sessionId>/subagents/`. The layout has already moved once — that move is
 * why this repair exists — and a literal path segment is the same assumption
 * `listTranscripts` made with its non-recursive `readdir`. Order is load-bearing:
 * a `requestId` group takes its usage from the LAST record in file order, so the
 * main transcript comes first and the rest are sorted deterministically.
 */
export async function sessionFiles(dir: string, sessionId: string): Promise<string[]> {
  return [path.join(dir, `${sessionId}.jsonl`), ...(await jsonlUnder(path.join(dir, sessionId)))];
}

/** Session ids in a directory, oldest first — one per main transcript. */
export async function listSessionIds(dir: string): Promise<string[]> {
  const mains = await listTranscripts(dir);
  return mains.map((file) => path.basename(file, ".jsonl"));
}
