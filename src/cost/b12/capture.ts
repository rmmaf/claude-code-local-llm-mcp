/**
 * B12's CAPTURE — `design.artifacts` 6. Archives an observation; decides nothing.
 *
 * WHY THIS LIVES IN `src/cost/b12/` AND NOT IN `scripts/`. `voidConditions` 5
 * freezes exactly "`src/cost/**`, `src/telemetry.ts`, gate's or repair's
 * telemetry emission, or `scripts/b12-run.mjs`" after the first scored
 * observation. A `scripts/b12-archive.mjs` would sit at a path that clause does
 * not name, so it could be edited afterwards without tripping the source-drift
 * VOID — a hole in the frozen guard opened by nothing but a file layout. Here it
 * is inside the frozen set. `scripts/b12-run.mjs` keeps the orchestration and
 * the commit barrier and calls this.
 *
 * WHAT IT IS FOR. `.local-coder/telemetry.jsonl` is gitignored as per-machine,
 * session transcripts live outside the repository and are rewritten by the
 * vendor, and every observation runs in a worktree that `git worktree remove
 * --force` destroys — so the frozen clause says, in its own words, that without
 * this archive "the VOID conditions' own re-emission escape hatch cannot be
 * exercised and the run cannot be corrected, only discarded — which is character
 * for character why B1 cannot be re-adjudicated."
 *
 * **THE COPIES ARE NOT EVIDENCE BESIDE A RUN-LEVEL LOG. THERE IS NO RUN-LEVEL
 * LOG.** The MCP server's root is its own `process.cwd()` (`server.ts` →
 * `config.ts`), which is the worktree, and the worktree does not survive the
 * task. So identity keys on the ARCHIVE PATH: ordinals restart per file, paths
 * differ, and `identify`'s `JSON.stringify([source, ordinal])` stays globally
 * unique without making concatenation order load-bearing. See
 * `docs/b12-scorer/UNIT-5.md` step 2, which named a log that does not exist and
 * is corrected.
 *
 * IT DECIDES NOTHING. No row is classified credited or refused here — that is
 * `buildCounterfactual`'s at scoring time, and a second implementation of the
 * join is how the meter and the oracle drifted apart four separate times. No
 * lineage is collapsed into one `Transcript` here either: which records compose
 * a lineage under one anchor is UNIT 5's decision, and this module archives the
 * files it would need to make it.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { parseTelemetryLines, parseTelemetryText, TELEMETRY_REL_PATH, type TelemetryRecord } from "../../telemetry.js";
import { isLocalToolResult, lineagesOf } from "../report.js";
import { readTranscript, type RawRecord, type Transcript } from "../transcript.js";

/** Bumped only when a reader would misread an older directory. */
export const CAPTURE_SCHEMA = "b12-obs-archive/1";

/**
 * The reduction, and it is `RawRecord` exactly.
 *
 * `design.artifacts` 6 wants "the admitted records reduced to the fields the
 * meter reads". The parser DECLARES that set, so the reduction is not a
 * judgement — it is a projection onto `RawRecord`, and `METERED_KEYS` below is
 * held to it by the compiler rather than by this sentence.
 */
export type MeteredRecord = RawRecord;

/**
 * Every key of `MeteredRecord`, listed once so the projection can be written as
 * a loop instead of twelve hand-copied lines.
 *
 * **THE ASSERT BELOW IS THE POINT.** `RawRecord`'s fields are all optional, so
 * adding one would NOT break an object literal that omits it — the archive would
 * silently start dropping a field the meter reads, and every oracle would stay
 * green because no fixture carries it yet. `Missing` catches that at build time.
 */
const METERED_KEYS = [
  "type",
  "uuid",
  "isApiErrorMessage",
  "parentUuid",
  "requestId",
  "sessionId",
  "timestamp",
  "isSidechain",
  "isCompactSummary",
  "compactMetadata",
  "toolUseResult",
  "message",
] as const satisfies readonly (keyof MeteredRecord)[];

type MissingMeteredKey = Exclude<keyof MeteredRecord, (typeof METERED_KEYS)[number]>;
/** `true` only while `METERED_KEYS` covers `MeteredRecord`. Widening it is the defect. */
type AssertMeteredKeysComplete = [MissingMeteredKey] extends [never] ? true : MissingMeteredKey;
const _meteredKeysComplete: AssertMeteredKeysComplete = true;
void _meteredKeysComplete;

/** `message`, narrowed the same way the parser narrows it. */
const MESSAGE_KEYS = ["model", "usage", "content"] as const satisfies readonly (keyof NonNullable<
  MeteredRecord["message"]
>)[];

type MissingMessageKey = Exclude<keyof NonNullable<MeteredRecord["message"]>, (typeof MESSAGE_KEYS)[number]>;
type AssertMessageKeysComplete = [MissingMessageKey] extends [never] ? true : MissingMessageKey;
const _messageKeysComplete: AssertMessageKeysComplete = true;
void _messageKeysComplete;

/**
 * One transcript line, projected onto the metered fields.
 *
 * A key ABSENT from the input stays absent from the output — it is not written
 * as `undefined`. The distinction survives `JSON.stringify`, which drops
 * `undefined` properties but would keep an explicit `null`, and "the field was
 * not there" is a different fact from "the field was there and empty" for every
 * one of these.
 *
 * Returns `null` for anything that is not an object, so a malformed line is
 * dropped with a count rather than crashing the capture or being archived as
 * `{}` — which would read as an admitted record carrying nothing.
 */
export function reduceRecord(raw: unknown): MeteredRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of METERED_KEYS) {
    if (!(key in source)) continue;
    if (key !== "message") {
      out[key] = source[key];
      continue;
    }
    const message = source["message"];
    if (typeof message !== "object" || message === null) {
      out["message"] = message;
      continue;
    }
    const from = message as Record<string, unknown>;
    const narrowed: Record<string, unknown> = {};
    for (const inner of MESSAGE_KEYS) if (inner in from) narrowed[inner] = from[inner];
    out["message"] = narrowed;
  }
  return out as MeteredRecord;
}

/** One archived transcript file: what it was, what it hashed to, what it held. */
export interface ArchivedTranscript {
  /** Absolute at capture time, kept so a reader can say WHICH file this was. */
  sourcePath: string;
  /** Of the file's bytes as they were read, before any reduction. */
  sha256: string;
  /** The parser's own anchor for the file, or null if it admitted nothing. */
  sessionId: string | null;
  /** Admitted billed `requestId`s — what `lineagesOf` joins on. */
  requestIds: string[];
  /** Lines that were not objects. Reported, never silently dropped. */
  droppedLines: number;
  records: MeteredRecord[];
}

export interface HashedFile {
  /** Relative to the worktree, with `/` separators on every platform. */
  path: string;
  sha256: string;
}

/**
 * `design.artifacts` 6, as a value.
 *
 * `acceptanceExitCodes` and the pre/post `requestId` diff are NOT here: both
 * already live on `observation.json`, which `scripts/b12-run.mjs` writes into
 * the same directory, and duplicating them would create two places that can
 * disagree about one fact.
 */
export interface ObservationArchive {
  schema: typeof CAPTURE_SCHEMA;
  taskId: string;
  arm: string;
  sessionId: string;
  /** Every file in the observation's lineage, reduced. */
  lineage: ArchivedTranscript[];
  /**
   * Which slugs were walked to find them. A lineage found by searching one
   * directory is a lineage that cannot see a fork into another, and a run whose
   * search covered fewer slugs than it wrote to is the same defect
   * `takeSnapshot` already refuses on.
   */
  slugsSearched: string[];
  transcriptsSearched: number;
  /**
   * The ARM's telemetry rows, VERBATIM and unclassified.
   *
   * A fresh `git worktree add` starts with no `telemetry.jsonl` — it is
   * gitignored, and `rates.json` is the only tracked file under that directory
   * — so every row here was written inside this worktree. That used to be the
   * whole argument, and it had a hole (R33): the ACCEPTANCE COMMAND runs in
   * the same tree, after the arm and before this capture, so a `npm test` that
   * reaches gate or repair appends rows that the worktree argument admits and
   * the measured session never wrote.
   *
   * `scopeTelemetry` does not save this. Its ±60,000 ms window — which
   * `admissionRule` 5 fixes by hand — admits any row NEAR the session's
   * requests whether or not the transcript names its `invocation_id`, and
   * acceptance runs seconds after the arm. So the boundary is drawn HERE, at
   * the byte offset the harness reads before acceptance starts, and the rows
   * past it are archived beside this array instead of inside it.
   */
  telemetry: TelemetryRecord[];
  /**
   * The rows the ACCEPTANCE COMMAND wrote — REPORTED, DECIDING NOTHING.
   *
   * Not discarded: acceptance running the tool under measurement is a fact
   * about the observation worth having on the record, and the same doctrine
   * that keeps `endPorcelain` keeps these. Nothing scores them.
   */
  telemetryAfterAcceptance: TelemetryRecord[];
  /**
   * Where the split was made: the log's size in bytes at the moment acceptance
   * began, or `null` when the harness did not take it (no acceptance command,
   * or a caller that predates the boundary). `null` means "no split", and the
   * whole log is the arm's — the pre-R33 reading, said out loud.
   */
  telemetryBoundaryBytes: number | null;
  /** The prefix identity the boundary was taken with, and whether it survived
   * to capture. `null`/`null` means the harness took no digest — the pre-R36
   * reading, in which a truncating acceptance command is invisible. */
  telemetryPrefixSha256: string | null;
  telemetryPrefixIntact: boolean | null;
  /** Lines in the ARM's own segment that did not parse. Zero is the only clean
   * value: the log is read after the tool exited, so a partial line is a row
   * something stopped mid-write, not a tool still running. */
  telemetryMalformedLines: number;
  /** Files `jsonlUnder` listed and `readTranscript` could not READ — as opposed
   * to could not parse. Their billed requests leave no trace in the archive. */
  unreadableTranscripts: Array<{ path: string; why: string }>;
  /**
   * Local tool invocations in the lineage with no row of their own in the arm's
   * segment. REPORTED, DECIDING NOTHING: a tool whose preflight refuses emits
   * no row by design, so this is not an error count — it is the gap a reader
   * has to be able to see before they can ask why it is there.
   */
  invocationsWithoutRow: string[];
  /**
   * What makes this archive's ATTRIBUTION untrustworthy — a rewritten or
   * truncated telemetry prefix, a malformed row in the arm's segment, a
   * transcript that could not be read. Empty is the only clean value; the
   * assembler refuses terms on a non-empty one, under the archive-integrity
   * check that already covers a corrupt or drifted telemetry source.
   */
  attributionProblems: string[];
  /**
   * Where the rows were found, and whether that was where the harness expected.
   *
   * `telemetryFound: false` is NOT a refusal. B12 measures "installed, not
   * invoked", `readTelemetry` defines a missing file as an empty log, and an arm
   * that called no local tool is a legitimate observation. It is reported so the
   * assembler can tell that case apart from a mis-scoped root.
   */
  telemetryPath: string;
  telemetryFound: boolean;
  /**
   * The ids the join owns: non-null `invocation_id`s on results from THIS
   * server's tools, `isLocalToolResult` first (`FINDINGS.md` F10).
   */
  invocationIds: string[];
  /**
   * Every regular file in the worktree at the task's END, hashed.
   *
   * A SUPERSET ON PURPOSE. "sha256 of every source file" fixes the moment and
   * not the range: the frozen text nowhere equates "source file" with tracked
   * files, with `fileScope`, or with the instrument's own sources, and choosing
   * one as THE scoring interpretation would mint a rule after the freeze. So the
   * capture hashes everything and labels the declared scope inside it. Extra
   * evidence is not a new admission rule, and nothing here refuses on the extra.
   */
  sourceFiles: HashedFile[];
  /** The manifest's declared scope for this task, labelled, never enforced. */
  declaredFileScope: string[] | null;
  /**
   * Whether the worktree was dirty when the capture was taken — which is AFTER
   * acceptance, so it answers "did the ACCEPTANCE COMMAND write into the tree":
   * coverage output, a build directory, a lock file.
   *
   * It is not "did the arm commit its work". The harness commits whatever the
   * arm left, in the arm's own throwaway worktree, BEFORE acceptance runs, and
   * `endCommit` names that commit — so `admissionRule` 3's "exits 0 at its end
   * commit" is true by construction rather than by hope. The arm's own habit is
   * recorded separately as `armLeftUncommitted` on the observation.
   *
   * Reported, deciding nothing: the frozen text supplies no disposition for it,
   * and `sourceFiles` above hashes whatever the command left behind.
   */
  dirtyAtCapture: boolean;
}

export interface CaptureInput {
  taskId: string;
  arm: string;
  /** The session the arm was invoked with — the lineage's seed. */
  sessionId: string;
  /** The worktree the arm ran in. Still on disk: capture precedes its removal. */
  treeDir: string;
  /** Every `~/.claude/projects/<slug>` directory to search. */
  slugDirs: string[];
  /** `git status --porcelain` output from the worktree, already taken. */
  porcelain: string;
  declaredFileScope?: string[] | null;
  /**
   * The telemetry log's size in bytes THE MOMENT BEFORE the acceptance command
   * ran — see `telemetryBoundaryBytes`. Omitted or null means no split.
   */
  telemetryBytesAtAcceptance?: number | null;
  /**
   * The sha256 of those same bytes, taken in the SAME breath as the count
   * (R36). A count alone cannot tell "the arm wrote 10 KB and acceptance
   * appended" from "acceptance replaced the log and wrote 1 KB": both leave a
   * boundary the clamp accepts. The digest is what makes the prefix an
   * IDENTITY rather than a length.
   */
  telemetryPrefixSha256AtAcceptance?: string | null;
  /**
   * TEST SEAM, never passed by `scripts/b12-run.mjs`: how the oracle makes one
   * listed transcript refuse to be READ. A real `EACCES`/`EBUSY` cannot be
   * produced deterministically on Windows, and the distinction between a file
   * that will not parse and a file that will not open is the whole of R36#3.
   */
  readTranscriptFor?: (file: string) => Promise<Transcript>;
}

/**
 * The boundary probe, taken by the harness immediately before acceptance.
 *
 * It lives here so the log's location is known in ONE place: a second spelling
 * of `.local-coder/telemetry.jsonl` in the harness is how the boundary would
 * come to be measured against a file nobody writes. A missing log is 0 — the
 * fresh-worktree case, where the arm called no local tool.
 */
export async function telemetryBytesIn(treeDir: string): Promise<number> {
  try {
    return (await fs.stat(path.join(treeDir, TELEMETRY_REL_PATH))).size;
  } catch {
    return 0;
  }
}

/**
 * The acceptance boundary AS AN IDENTITY, not a length (R36).
 *
 * A byte count alone cannot tell "the arm wrote 10 KB and acceptance appended
 * to it" from "acceptance truncated the log and wrote 1 KB": the capture
 * clamps the count to the new length and hands the acceptance rows to the arm,
 * where `scopeTelemetry`'s ±60 s window admits them and the arm gains a saving
 * it never made. Reading the BYTES once and taking both figures off the same
 * read is also what stops a write landing between a `stat` and a hash.
 */
export async function telemetryBoundaryIn(
  treeDir: string
): Promise<{ bytes: number; sha256: string | null }> {
  try {
    const raw = await fs.readFile(path.join(treeDir, TELEMETRY_REL_PATH));
    return { bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") };
  } catch {
    // No log yet is a lawful boundary of zero — and a zero-length prefix has a
    // digest like any other, so the capture still compares something.
    return { bytes: 0, sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex") };
  }
}

async function sha256Of(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function jsonlUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  await walk(dir);
  return out;
}

async function filesUnder(dir: string, skip: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  await walk(dir);
  return out;
}

/**
 * The indices of every transcript in the seed's lineage.
 *
 * PURE, and over the PRODUCTION rule: `lineagesOf` is the union-find on shared
 * admitted `requestId`s, and a third implementation of it here is how two copies
 * of one rule drift apart. The seed is matched on the parser's own `sessionId`
 * anchor rather than on a filename, because a filename is a convention and
 * `record.sessionId` is the data.
 *
 * A seed that matches NOTHING returns an empty array rather than everything. An
 * empty lineage is a fact the caller can refuse on; a lineage silently widened
 * to the whole machine is a denominator that is not the observation's.
 */
export function lineageIndices(transcripts: readonly Transcript[], sessionId: string): number[] {
  const components = lineagesOf(transcripts);
  const seeds = new Set<number>();
  for (let i = 0; i < transcripts.length; i++) {
    if (transcripts[i]!.sessionId === sessionId) seeds.add(components[i]!);
  }
  if (seeds.size === 0) return [];
  const out: number[] = [];
  for (let i = 0; i < transcripts.length; i++) if (seeds.has(components[i]!)) out.push(i);
  return out;
}

/** Reduce one transcript file's lines, keeping the count of what was not an object. */
export function reduceFile(text: string): { records: MeteredRecord[]; droppedLines: number } {
  const records: MeteredRecord[] = [];
  let droppedLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      droppedLines++;
      continue;
    }
    const reduced = reduceRecord(parsed);
    if (reduced === null) droppedLines++;
    else records.push(reduced);
  }
  return { records, droppedLines };
}

/**
 * Build the archive. IMPURE — this is the whole filesystem surface of the
 * capture, and everything above it is a function of values with its own oracle.
 *
 * Called after the acceptance command and BEFORE `git worktree remove --force`,
 * which is the only window in which the worktree and its telemetry log both
 * still exist.
 */
/**
 * Whether a `readTranscript` failure is the file REFUSING TO BE READ rather
 * than refusing to parse. The distinction decides whether the omission is
 * lawful (a `.jsonl` that holds no admitted request relates to no lineage) or
 * evidence that the archive is short (R36).
 *
 * Read by errno, not by message: the messages are Node's and change between
 * versions, while `ENOENT`/`EACCES`/`EPERM`/`EBUSY`/`EISDIR`/`EMFILE` do not.
 */
function isUnreadable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    ["ENOENT", "EACCES", "EPERM", "EBUSY", "EISDIR", "EMFILE", "ENFILE", "EIO"].includes(code)
  );
}

export async function captureObservation(input: CaptureInput): Promise<ObservationArchive> {
  const files = (await Promise.all(input.slugDirs.map((d) => jsonlUnder(d)))).flat();
  const transcripts: Transcript[] = [];
  const kept: string[] = [];
  const unreadableTranscripts: Array<{ path: string; why: string }> = [];
  const readOne = input.readTranscriptFor ?? readTranscript;
  for (const file of files) {
    try {
      transcripts.push(await readOne(file));
      kept.push(file);
    } catch (error) {
      // A file that will not PARSE is not this observation's lineage and cannot
      // join one: `lineagesOf` relates transcripts by shared admitted request
      // ids, and a file yielding none relates to nothing.
      //
      // A file that could not be READ is a different animal (R36), and until
      // now both landed here in the same silence. `jsonlUnder` listed it
      // moments ago, so the bytes existed and are gone or unreachable — its
      // billed requests and its tool-result ownership leave the archive
      // without a trace, the surviving files keep `lineage` non-empty so the
      // harness's empty-lineage guard never fires, and the arm quietly loses
      // whatever that file held. Recorded, and it makes the archive suspect.
      const why = error instanceof Error ? error.message : String(error);
      if (isUnreadable(error)) unreadableTranscripts.push({ path: file, why });
    }
  }

  const lineage: ArchivedTranscript[] = [];
  const invocationIds = new Set<string>();
  for (const index of lineageIndices(transcripts, input.sessionId)) {
    const file = kept[index]!;
    const transcript = transcripts[index]!;
    const text = await fs.readFile(file, "utf8");
    const { records, droppedLines } = reduceFile(text);
    lineage.push({
      sourcePath: file,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      sessionId: transcript.sessionId,
      requestIds: [...new Set(transcript.requests.map((r) => r.requestId))].sort(),
      droppedLines,
      records,
    });
    for (const result of transcript.toolResults) {
      if (!isLocalToolResult(result)) continue;
      if (result.invocationId !== null) invocationIds.add(result.invocationId);
    }
  }

  const telemetryPath = path.join(input.treeDir, TELEMETRY_REL_PATH);
  let telemetryFound = true;
  let raw = Buffer.alloc(0);
  try {
    raw = await fs.readFile(telemetryPath);
  } catch {
    telemetryFound = false;
  }
  const boundary = input.telemetryBytesAtAcceptance ?? null;
  // A cut that lands MID-LINE gives the partial row to the ARM. The stat can
  // fall between an append's open and its bytes, and a row being written when
  // acceptance starts was started by the arm; splitting it would destroy the
  // row on both sides instead of attributing it.
  // R36: THE BOUNDARY IS A BYTE COUNT AND A BYTE COUNT HAS NO IDENTITY. If the
  // acceptance command truncates, deletes or rewrites the log, `boundary` is
  // clamped to the NEW length and the acceptance rows land in the arm's own
  // segment — `scopeTelemetry`'s ±60 s window admits them, and the arm gains a
  // saving it never made. The prefix digest taken WITH the count is what makes
  // the two comparable: the bytes before the cut must still be the bytes the
  // count was taken over.
  const attributionProblems: string[] = [];
  const prefixClaim = input.telemetryPrefixSha256AtAcceptance ?? null;
  let prefixIntact: boolean | null = null;
  if (boundary !== null && prefixClaim !== null) {
    if (raw.length < boundary) {
      prefixIntact = false;
      attributionProblems.push(
        `the telemetry log is SHORTER (${raw.length} bytes) than it was when the acceptance boundary was taken (${boundary}) — it was truncated or replaced, and the split cannot say which rows are the arm's`
      );
    } else {
      prefixIntact = createHash("sha256").update(raw.subarray(0, boundary)).digest("hex") === prefixClaim;
      if (!prefixIntact) {
        attributionProblems.push(
          "the telemetry bytes before the acceptance boundary are not the bytes the boundary was taken over — the log was rewritten, and the split cannot say which rows are the arm's"
        );
      }
    }
  }
  let cut = boundary === null ? raw.length : Math.min(Math.max(boundary, 0), raw.length);
  if (cut > 0 && cut < raw.length && raw[cut - 1] !== 0x0a) {
    const nl = raw.indexOf(0x0a, cut);
    cut = nl === -1 ? raw.length : nl + 1;
  }
  const armSegment = parseTelemetryLines(raw.subarray(0, cut).toString("utf8"));
  const telemetry = armSegment.records;
  const telemetryAfterAcceptance = parseTelemetryText(raw.subarray(cut).toString("utf8"));
  // A malformed line in a log read AFTER the tool exited is not "a partial
  // last line while a tool is running" — it is a row that was being written
  // when something stopped it, and the saving it carried is gone.
  if (armSegment.malformed > 0) {
    attributionProblems.push(
      `${armSegment.malformed} telemetry line(s) in the arm's own segment do not parse — a row interrupted mid-write is a saving this archive cannot account for`
    );
  }
  for (const t of unreadableTranscripts) {
    attributionProblems.push(`a transcript in this observation's slugs could not be read (${t.path}): ${t.why}`);
  }
  // REPORTED, DECIDING NOTHING — and the reason is a lawful counter-example,
  // not squeamishness. A tool whose PREFLIGHT refuses emits no row at all by
  // `emission.ts`'s own state machine (`not-started` emits NOTHING), while its
  // tool result is still in the transcript. So "every local invocation has a
  // row" is false on a path the design intends, and a guard built on it would
  // refuse lawful observations. The count is published so a reader can SEE the
  // gap and ask why, which is what R36 was actually pointing at.
  const rowIds = new Set(telemetry.map((r) => r.invocation_id).filter((x): x is string => typeof x === "string"));
  const invocationsWithoutRow = [...invocationIds].filter((id) => !rowIds.has(id)).sort();

  const sourcePaths = await filesUnder(input.treeDir, (name) => name === ".git");
  const sourceFiles: HashedFile[] = [];
  for (const file of sourcePaths) {
    sourceFiles.push({
      path: path.relative(input.treeDir, file).split(path.sep).join("/"),
      sha256: await sha256Of(file),
    });
  }
  sourceFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    schema: CAPTURE_SCHEMA,
    taskId: input.taskId,
    arm: input.arm,
    sessionId: input.sessionId,
    lineage,
    slugsSearched: input.slugDirs.map((d) => path.basename(d)).sort(),
    transcriptsSearched: files.length,
    telemetry,
    telemetryAfterAcceptance,
    telemetryBoundaryBytes: boundary,
    telemetryPrefixSha256: prefixClaim,
    telemetryPrefixIntact: prefixIntact,
    telemetryMalformedLines: armSegment.malformed,
    unreadableTranscripts,
    invocationsWithoutRow,
    attributionProblems,
    telemetryPath,
    telemetryFound,
    invocationIds: [...invocationIds].sort(),
    sourceFiles,
    declaredFileScope: input.declaredFileScope ?? null,
    dirtyAtCapture: input.porcelain.trim().length > 0,
  };
}
