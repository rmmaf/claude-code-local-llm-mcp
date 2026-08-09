/**
 * Shared fixtures for the B12 scorer's four per-unit oracles — `b12-strata`
 * (UNIT 1), `b12-terms` (UNIT 2), `b12-aggregate` (UNIT 3) and `b12-coverage`
 * (UNIT 4). It was three when the rule below was written; UNIT 4 arrived later
 * and this file imports its module directly.
 *
 * WHY SEPARATE FILES AND NOT ONE. The first attempt put all thirteen assertions in
 * `tests/b12-scorer.test.ts`, and `repair` runs the PROJECT's test command — so a
 * unit could only return `passed: true` once every OTHER unit was implemented
 * too. `run 2026-08-06-mac-b12-phase3` measured the consequence: `repair`
 * implemented `strata.ts` correctly in round 1, the suite stayed red for reasons
 * outside that file, and the harness recorded it as a failure to close. The
 * criterion was unsatisfiable by construction and the run is void on that cause.
 *
 * Not a `.test.ts` file, so vitest does not collect it.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { isLocalToolResult } from "../src/cost/report.js";
import type { CreditedLedgerRow, RefusedLedgerRow, RowDisposition } from "../src/cost/report.js";
import type {
  ArchivedObservation,
  Arm,
  B12Observation,
  IdentifiedRow,
  KeyedRow,
  ManifestTask,
  ObservationRecord,
  ObservationTerms,
  RunArchive,
  RunlogRow,
  RunTelemetryCoverage,
} from "../src/cost/b12/types.js";
import type { AggregateInput } from "../src/cost/b12/aggregate.js";
import { identify, runCoverage } from "../src/cost/b12/coverage.js";
import { DEFAULT_RATES } from "../src/cost/rates.js";
import { transcriptFromRecords } from "../src/cost/transcript.js";
import type { RawRecord } from "../src/cost/transcript.js";
import type { TelemetryRecord } from "../src/telemetry.js";
import { makeTempRoot } from "./helpers.js";

/** Epoch base shared by every fixture, so timestamps are comparable across files. */
export const EPOCH = 1_700_000_000_000;
export const at = (ms: number): string => new Date(EPOCH + ms).toISOString();

/** Per-file temp-root registry. Each test file owns one and cleans it in afterEach. */
export function makeScratch(): { tempRoot: () => string; cleanup: () => Promise<void> } {
  const roots: string[] = [];
  return {
    tempRoot(): string {
      const root = makeTempRoot("b12-test-");
      roots.push(root);
      return root;
    },
    async cleanup(): Promise<void> {
      while (roots.length > 0) {
        const root = roots.pop();
        if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
      }
    },
  };
}

/**
 * A billed assistant record. `write1h` keeps every fixture on the 1h multiplier
 * (2.0x), so the hand-derived constants stay readable.
 */
export function req(
  requestId: string,
  ms: number,
  usage: { write1h?: number; read?: number },
  extra: Record<string, unknown> = {}
): string {
  const write1h = usage.write1h ?? 0;
  return JSON.stringify({
    type: "assistant",
    requestId,
    sessionId: "sess-1",
    uuid: `u-${requestId}`,
    parentUuid: null,
    isSidechain: false,
    timestamp: at(ms),
    message: {
      model: "test-model",
      content: [],
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: write1h,
        cache_read_input_tokens: usage.read ?? 0,
        output_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: 0 },
      },
    },
    ...extra,
  });
}

/** A sidechain record — its own thread, which is what makes a window `multi`. */
export function subRequest(requestId: string, ms: number, uuid: string): string {
  return JSON.stringify({
    type: "assistant",
    requestId,
    sessionId: "sess-1",
    uuid,
    parentUuid: null,
    isSidechain: true,
    timestamp: at(ms),
    message: {
      model: "test-model",
      content: [],
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 },
      },
    },
  });
}

/**
 * The `tool_use` block that makes a request the CALLER of an invocation.
 *
 * THE `cache_creation` SPLIT IS NOT OPTIONAL HERE. This overrides `message`
 * wholesale, so anything `req` put there is gone — and without the split the
 * transcript parser attributes the whole cache write to the 5-minute TTL, which
 * is its documented conservative guess. That silently priced this request at
 * 1.25x while `req`'s comment above promises 1h at 2.0x, and every constant
 * hand-derived from that promise was 75 units out on a 100-token write. Nothing
 * caught it because no oracle over this fixture had ever been executed.
 */
export function withToolUse(
  requestId: string,
  ms: number,
  usage: { write1h?: number },
  toolUseId: string,
  /**
   * The tool the request called. Defaults to ours; pass another name to build a
   * result that merely QUOTES an invocation id rather than producing one, which
   * is the case `isLocalToolResult` exists to separate.
   */
  toolName = "mcp__local-coder__gate"
): string {
  const write1h = usage.write1h ?? 0;
  return req(requestId, ms, usage, {
    message: {
      model: "test-model",
      content: [{ type: "tool_use", id: toolUseId, name: toolName }],
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: write1h,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: 0 },
      },
    },
  });
}

/** The result record that echoes our tool's `invocation_id` into the transcript. */
export function toolResult(toolUseId: string, invocationId: string, ms: number): string {
  return JSON.stringify({
    type: "user",
    uuid: `res-${toolUseId}`,
    parentUuid: null,
    sessionId: "sess-1",
    timestamp: at(ms),
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId }] },
    toolUseResult: {
      content: [{ type: "text", text: JSON.stringify({ invocation_id: invocationId }) }],
    },
  });
}

export async function writeSession(root: string, lines: string[]): Promise<string> {
  const file = path.join(root, "session.jsonl");
  await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

export function observation(over: Partial<B12Observation> = {}): B12Observation {
  return {
    taskId: "t-1",
    arm: "treatment" as Arm,
    sessionId: "sess-1",
    runId: "run-1",
    originatedRequestIds: [],
    accepted: true,
    valid: true,
    invalidReasons: [],
    censored: false,
    baseCommit: "0".repeat(40),
    endCommit: "1".repeat(40),
    treeHashAtStart: "2".repeat(40),
    verificationStratum: "test-red",
    ...over,
  };
}

/**
 * One credited ledger row. `units` and `unitsLo` are the SAME row at the two
 * horizons and default apart on purpose — a fixture where they coincide cannot
 * tell a per-horizon ranking from a shared one, which is the whole of `R_lo⁻ʳ`.
 */
export function creditedRow(over: Partial<CreditedLedgerRow> = {}): CreditedLedgerRow {
  // MATERIALIZE `{...base, ...over}` FIRST, then derive the uncapped pair from
  // the MATERIALIZED capped values — deriving from the base would hand a caller
  // who overrode `units` an uncapped pair describing the row it just replaced.
  // The base row is under the cap (`signed === capped`), where the two pairs
  // coincide by construction; an over-cap fixture passes its own pair.
  const materialized = {
    invocationId: null,
    tool: "gate",
    ts: at(0),
    disposition: "credited" as const,
    thread: "main",
    index: 0,
    segmentSize: 2,
    ttl: "1h" as const,
    multiplier: 2.1,
    rateKey: "test-model",
    bytesRaw: 10_000,
    bytesReturned: 1_000,
    signed: 9_000,
    capped: 9_000,
    turnsCollapsed: 0,
    units: 100,
    unitsLo: 60,
    passed: null,
    ...over,
  };
  return {
    ...materialized,
    unitsUncapped: over.unitsUncapped ?? materialized.units,
    unitsLoUncapped: over.unitsLoUncapped ?? materialized.unitsLo,
  };
}

/** An empty four-class ledger, for the arm of a test that is not the subject. */
export function ledger(over: Partial<ObservationTerms["refusals"]> = {}): ObservationTerms["refusals"] {
  return {
    ambiguous: { count: 0, units: 0, unsized: 0 },
    unverifiable: { count: 0, units: 0, unsized: 0 },
    excludedForeign: { count: 0, units: 0, unsized: 0 },
    unmatched: { count: 0, units: 0, unsized: 0 },
    ...over,
  };
}

/**
 * A keyed row. The key is what the run-level ledger identifies a physical
 * telemetry row by, so a fixture that wants two observations to hold the SAME row
 * gives them the same key, and one that wants two different rows must not.
 */
export function keyed(key: string, over: Partial<CreditedLedgerRow> = {}): KeyedRow {
  return { key, row: creditedRow(over) };
}

/**
 * A keyed REFUSED row. `units` and `unitsLo` are null together — the union says
 * so — and `null` here means nobody could size it, which is the only thing it
 * ever means.
 */
export function refused(
  key: string,
  disposition: Exclude<RowDisposition, "credited">,
  units: number | null
): KeyedRow {
  const row: RefusedLedgerRow = {
    invocationId: null,
    tool: "gate",
    ts: at(0),
    disposition,
    thread: null,
    index: null,
    segmentSize: null,
    ttl: null,
    multiplier: null,
    rateKey: null,
    bytesRaw: 10_000,
    bytesReturned: 1_000,
    signed: 9_000,
    capped: 9_000,
    turnsCollapsed: 0,
    units,
    unitsLo: units,
    passed: null,
  };
  return { key, row };
}

/** The universe argument of `runCoverage`, from keys alone. */
export function universeOf(...keys: string[]): IdentifiedRow[] {
  return keys.map((key) => ({
    key,
    record: { ts: at(0), tool: "gate", bytes_raw: 0, bytes_returned: 0, turns_collapsed: 0, latency_ms: 0 },
  }));
}

/**
 * A coverage that blocks nothing, for the arm of a test that is not the subject.
 *
 * Built by running the REAL `runCoverage` over the observations rather than by
 * hand-writing a clean-looking object: a fixture that fabricates
 * `exactlyOnce: true` would let every `rHiPlus` assertion in the suite pass while
 * the ledger it depends on was broken.
 */
export function coverageOf(all: readonly ObservationTerms[]): RunTelemetryCoverage {
  const keys = all.flatMap((t) => [...t.rows, ...t.unattributed].map((r) => r.key));
  return runCoverage(universeOf(...new Set(keys)), all);
}

/** `identify`, re-exported so an oracle can stamp its own artifact's rows. */
export { identify };

/**
 * An `AggregateInput` over `admitted`, with the coverage the set implies and an
 * empty prior-run register.
 *
 * `priorRuns: []` is a CLAIM — "this run has no predecessors" — and not a default
 * the caller may forget: `voidConditions` 1 makes omitting the register itself a
 * VOID, which is why the field is required on the type. Saying it once here keeps
 * every oracle honest about which claim it is making.
 */
export function aggregateInput(
  admitted: readonly ObservationTerms[],
  over: Partial<AggregateInput> = {}
): AggregateInput {
  return {
    runId: "run-1",
    admitted,
    dropped: [],
    coverage: coverageOf(admitted),
    priorRuns: [],
    ...over,
  };
}

/**
 * Twenty admitted observations — the smallest set the frozen design will score,
 * since `admissionRule` 2 fixes the count at exactly 20 and `holdsIf` 3 wants
 * five in each of the four cells.
 *
 * **TEN per cell, not five.** The four cells are two OVERLAPPING two-way splits
 * of the same twenty — `test-red`/`types-only` on `n % 2`, and `solo`/`multi` on
 * `n % 4 < 2` — so every observation sits in one cell of each split and each of
 * the four holds ten. That is twice `holdsIf` 3's floor, so no oracle built on
 * this fixture is sensitive to the boundary. The `>= 5` / `> 5` distinction is
 * pinned separately, by the hand-built five-observation cell in
 * `tests/b12-aggregate.test.ts` — a cell holding exactly five is the only
 * population that can tell those two rules apart.
 *
 * Anything below it now VOIDs on the count before any arithmetic is read, so a
 * two-observation fixture can no longer say anything about a verdict.
 */
export function twenty(
  over: (n: number) => Partial<ObservationTerms> = () => ({})
): ObservationTerms[] {
  return Array.from({ length: 20 }, (_unused, n) =>
    terms({
      taskId: `t${n}`,
      verificationStratum: n % 2 === 0 ? "test-red" : "types-only",
      subagentShare: {
        evaluable: true,
        value: { own: 1, sidechain: n % 4 < 2 ? 0 : 1, share: n % 4 < 2 ? 0 : 1, stratum: n % 4 < 2 ? "solo" : "multi" },
      },
      ...over(n),
    })
  );
}

export function terms(over: Partial<ObservationTerms> = {}): ObservationTerms {
  // Same materialize-first rule as `creditedRow`: the uncapped sums default to
  // the MATERIALIZED capped sums (an all-under-cap observation), so a caller
  // overriding `sLo`/`sHi` gets a coherent observation, and only a test ABOUT
  // the cap has to pass the uncapped pair itself.
  const materialized = {
    taskId: "t-1",
    arm: "treatment" as const,
    disposition: "scored" as const,
    aO: 0,
    sLo: 0,
    sHi: 0,
    oO: 0,
    rows: [] as KeyedRow[],
    refusals: ledger(),
    // Empty by default so an existing expectation still describes the same
    // arithmetic. A test about the unattributed rows has to say so.
    unattributed: [] as KeyedRow[],
    unattributedRefusals: ledger(),
    subagentShare: {
      evaluable: true as const,
      value: { own: 1, sidechain: 0, share: 0, stratum: "solo" as const },
    },
    perDelivery: {},
    billedRequestCount: 1,
    rateKeys: ["test-model"],
    verificationStratum: "test-red" as const,
    ...over,
  };
  return {
    ...materialized,
    sLoUncapped: over.sLoUncapped ?? materialized.sLo,
    sHiUncapped: over.sHiUncapped ?? materialized.sHi,
  };
}

// ---------------------------------------------------------------------------
// The UNIT 5 archive builders — one coherent default, broken one field at a
// time. Moved here from `b12-assemble.test.ts` unchanged, because clause 6's
// two-worktree control lives in `tests/cost-meter.test.ts` (the file the
// frozen text NAMES) and a second copy of this machinery is how two fixtures
// drift into testing different archives.
// ---------------------------------------------------------------------------

export const RUN = "run-01";
export const H64 = (c: string): string => c.repeat(64);
export const SHA40 = (c: string): string => c.repeat(40);

export function billed(
  requestId: string,
  sessionId: string,
  ms: number,
  over: {
    write1h?: number;
    write5m?: number;
    model?: string;
    sidechain?: boolean;
    content?: unknown[];
  } = {}
): RawRecord {
  const write1h = over.write1h ?? 0;
  const write5m = over.write5m ?? 0;
  return {
    type: "assistant",
    requestId,
    sessionId,
    uuid: `u-${sessionId}-${requestId}`,
    parentUuid: null,
    isSidechain: over.sidechain ?? false,
    timestamp: at(ms),
    message: {
      model: over.model ?? "test-model",
      content: over.content ?? [],
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: write1h + write5m,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: write5m },
      },
    },
  } as RawRecord;
}

/** A tool-result record whose payload is taken VERBATIM — no invocation id unless given. */
export function toolResultRec(sessionId: string, toolUseId: string, ms: number, payload: unknown): RawRecord {
  return {
    type: "user",
    uuid: `res-${sessionId}-${toolUseId}`,
    parentUuid: null,
    sessionId,
    timestamp: at(ms),
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId }] },
    toolUseResult: payload,
  } as RawRecord;
}

export function telemetryRow(ms: number, over: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    ts: at(ms),
    tool: "gate",
    bytes_raw: 5_000,
    bytes_returned: 1_000,
    turns_collapsed: 0,
    latency_ms: 10,
    ...over,
  };
}

export function recordOf(taskId: string, sessionId: string, over: Partial<ObservationRecord> = {}): ObservationRecord {
  const components = {
    claudeMd: "h-claude",
    memory: "h-mem",
    settings: "h-set",
    settingsLocal: "h-setl",
    mcpConfigPassed: "h-mcp",
    policyBlob: "h-pol",
    allowlist: null,
  };
  return {
    taskId,
    arm: "treatment",
    sessionId,
    runId: RUN,
    started: at(-500),
    outcome: "completed",
    valid: true,
    invalidReasons: [],
    censored: false,
    originatedRequestIds: [`rq-${taskId}`],
    accepted: true,
    acceptanceExpectedExit: 0,
    baseCommit: SHA40("0"),
    endCommit: SHA40("1"),
    treeHashAtStart: SHA40("2"),
    binaryVersion: "2.1.221",
    binarySha256: H64("b"),
    mcpConfigPassedSha256: H64("c"),
    mcpConfigPinned: H64("c"),
    policyBlobSha256: H64("d"),
    installedChars: { value: 310.8, adapter: "310.8", probeRunId: "probe-1" },
    memorySnapshotSha256: H64("e"),
    instructionHashes: { pre: { ...components }, post: { ...components } },
    ...over,
  };
}

export interface ObsOver {
  attempt?: number;
  records?: RawRecord[];
  telemetry?: TelemetryRecord[];
  record?: Partial<ObservationRecord> | null;
  snapshotBefore?: ArchivedObservation["snapshotBefore"];
  snapshotAfter?: ArchivedObservation["snapshotAfter"];
  invocationIds?: string[];
  identityIntact?: boolean;
}

export function obsOf(taskId: string, over: ObsOver = {}): ArchivedObservation {
  const attempt = over.attempt ?? 1;
  const sessionId = `sess-${taskId}-${attempt}`;
  // A re-run is a FRESH session with fresh request ids — reusing the first
  // attempt's would be the sibling inheritance `admissionRule` 4 refuses, and
  // the disposition table's own oracle proves it does.
  const rqId = attempt === 1 ? `rq-${taskId}` : `rq-${taskId}-r${attempt}`;
  const records = over.records ?? [billed(rqId, sessionId, 0, { write1h: 1_000 })];
  const dirName = `obs-${taskId}-treatment${attempt === 1 ? "" : `-r${attempt}`}`;
  const source = `evidence/${RUN}/${dirName}/telemetry.jsonl`;
  const files = [`/fake/${sessionId}.jsonl`];
  const record =
    over.record === null
      ? null
      : recordOf(taskId, sessionId, { originatedRequestIds: [rqId], ...(over.record ?? {}) });
  const transcript = transcriptFromRecords(records, { files, skippedLines: 0, sessionId });
  // The sealed inventory the capture would have written — derived from the
  // same records, so the fixture is coherent and clause 19's equality holds
  // unless a test breaks it on purpose.
  const sealedIds =
    over.invocationIds ??
    [...new Set(
      transcript.toolResults
        .filter(isLocalToolResult)
        .map((r) => r.invocationId)
        .filter((id): id is string => id !== null)
    )].sort();
  return {
    taskId,
    arm: "treatment",
    attempt,
    dir: `evidence/${RUN}/${dirName}`,
    telemetryIntact: true,
    identityIntact: over.identityIntact ?? true,
    evidenceCommitted: true,
    record,
    lineageRecords: records,
    lineageFiles: files,
    transcript,
    identified: identify(source, over.telemetry ?? []),
    telemetrySource: source,
    invocationIds: sealedIds,
    snapshotBefore:
      over.snapshotBefore !== undefined
        ? over.snapshotBefore
        : {
            ts: at(-1_000),
            identity: { runId: RUN, taskId, arm: "treatment", sessionId, phase: "before" },
            slugsWalked: 4,
            files: 2,
            requestIds: ["rq-prior"],
          },
    snapshotAfter:
      over.snapshotAfter !== undefined
        ? over.snapshotAfter
        : {
            ts: at(60_000),
            identity: { runId: RUN, taskId, arm: "treatment", sessionId, phase: "after" },
            slugsWalked: 4,
            files: 3,
            requestIds: ["rq-prior", ...(record?.originatedRequestIds ?? [])],
          },
    problems: [],
  };
}

export function taskOf(id: string, over: Partial<ManifestTask> = {}): ManifestTask {
  return {
    id,
    promptSha256: H64("f"),
    baseCommit: SHA40("0"),
    verificationStratum: "types-only",
    expectedSubagentStratum: "solo",
    acceptance: ["node -e ok"],
    acceptanceExpectedExit: 0,
    verificationCommands: ["npx tsc --noEmit"],
    gateCategory: "types",
    repairMaxRounds: 3,
    // NARROW on purpose (R2#3): `src/` covers `src/cost/**`, so the old
    // default fired admissionRule 7 on every fixture archive.
    fileScope: ["src/tools/"],
    ...over,
  };
}

export const PINNED = {
  claudeCodeVersion: "2.1.221",
  claudeBinarySha256: H64("b"),
  ratesSha256: H64("a"),
  clientTruncationCap: 30_000,
  pacingCacheWriteShareCeiling: 1,
  perTaskDenominatorShareCap: 0.5,
  scoringCommand: `node dist/cost/b12/emit.js ${RUN}`,
  memorySnapshotSha256: H64("e"),
  mcpConfigSha256: H64("c"),
};

export function runlogOf(observations: readonly ArchivedObservation[]): RunlogRow[] {
  return observations.map((o, i) => ({
    ts: at(i * 100_000),
    runId: RUN,
    taskId: o.taskId,
    arm: o.arm,
    sessionId: o.record?.sessionId ?? "",
    outcome: o.record?.outcome ?? "completed",
    valid: o.record?.valid === true,
    accepted: o.record?.accepted ?? null,
    originated: o.record?.originatedRequestIds.length ?? 0,
  }));
}

export interface ArchiveOver {
  tasks?: ManifestTask[];
  observations?: ArchivedObservation[];
  runlogRows?: RunlogRow[];
  corruptLines?: number;
  pinned?: Record<string, unknown>;
  git?: Partial<RunArchive["git"]>;
  register?: RunArchive["register"];
  evidenceCommitted?: RunArchive["evidenceCommitted"];
  ratesSha256?: string;
  problems?: string[];
}

export function archiveOf(over: ArchiveOver = {}): RunArchive {
  const tasks = over.tasks ?? [taskOf("t1")];
  const observations = over.observations ?? tasks.map((t) => obsOf(t.id));
  return {
    runId: RUN,
    manifest: { runId: RUN, tasks, pinned: { ...PINNED, ...(over.pinned ?? {}) }, abPairs: [], raw: {} },
    manifestSha256: H64("9"),
    observations,
    runlog: { rows: over.runlogRows ?? runlogOf(observations), corruptLines: over.corruptLines ?? 0 },
    rates: DEFAULT_RATES,
    ratesSha256: over.ratesSha256 ?? H64("a"),
    git: {
      manifestBlobSha256: "blob-in-head",
      manifestMatchesHead: true,
      manifestCommitsAfterStart: [],
      ratesSha256AtFrozenCommit: H64("a"),
      problems: [],
      ...(over.git ?? {}),
    },
    register: over.register ?? { priorRuns: [], discrepancies: [] },
    evidenceCommitted: over.evidenceCommitted ?? { state: "clean", dirty: [] },
    problems: over.problems ?? [],
  };
}
