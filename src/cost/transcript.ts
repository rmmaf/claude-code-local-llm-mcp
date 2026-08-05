import { promises as fs } from "node:fs";
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
  file: string;
  sessionId: string;
  requests: BilledRequest[];
  toolResults: ToolResultRecord[];
  /** Lines that failed to parse — a live session's last line is often partial. */
  skippedLines: number;
}

interface RawRecord {
  type?: string;
  uuid?: string;
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

/** Parse one transcript file. Unparseable lines are counted, never fatal. */
export async function readTranscript(file: string): Promise<Transcript> {
  const text = await fs.readFile(file, "utf8");

  const records: RawRecord[] = [];
  let skippedLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as RawRecord);
    } catch {
      skippedLines++;
    }
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
    if (record.type !== "assistant" || typeof record.requestId !== "string") continue;

    const toolUses = readToolUses(record.message?.content);
    for (const use of toolUses) toolNames.set(use.id, use.name);

    const existing = byRequest.get(record.requestId);
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
    const uuid = typeof record.uuid === "string" ? record.uuid : record.requestId;
    byRequest.set(record.requestId, {
      requestId: record.requestId,
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
    file,
    sessionId: requests[0]?.sessionId ?? path.basename(file, ".jsonl"),
    requests,
    toolResults,
    skippedLines,
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
