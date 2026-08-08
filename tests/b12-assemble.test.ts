/**
 * ORACLE FOR UNIT 5's PURE CORE — `src/cost/b12/assemble.ts`, over constructed
 * `RunArchive` VALUES. The hostile on-disk cases live in `b12-archive.test.ts`;
 * here every disposition path, every archive-level clause, the selection order,
 * the registered conventions and the F25 handling are functions of literals.
 *
 * Every guard is shown FIRING and shown NOT firing — a check that cannot fail
 * is worse than no check (`DECISIONS.md`), and the F24 pass's oracle style is
 * kept: build ONE coherent default in which only the known-always-fired check
 * (clause 8 — `FINDINGS.md` F23) fires, then break exactly one thing per test.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_RATES } from "../src/cost/rates.js";
import { transcriptFromRecords } from "../src/cost/transcript.js";
import type { RawRecord } from "../src/cost/transcript.js";
import type { TelemetryRecord } from "../src/telemetry.js";
import {
  assembleRun,
  committedOrderReplay,
  DISPOSITION_PRECEDENCE,
  instrumentWriteTriggers,
  pacingFacts,
} from "../src/cost/b12/assemble.js";
import { identify } from "../src/cost/b12/coverage.js";
import { isLocalToolResult } from "../src/cost/report.js";
import type {
  ArchivedObservation,
  GitAudit,
  ManifestTask,
  ObservationRecord,
  RunArchive,
  RunlogRow,
} from "../src/cost/b12/types.js";
import { at } from "./b12-fixtures.js";

const RUN = "run-01";
const H64 = (c: string): string => c.repeat(64);
const SHA40 = (c: string): string => c.repeat(40);

// ---------------------------------------------------------------------------
// builders — one coherent default, broken one field at a time
// ---------------------------------------------------------------------------

function billed(
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
function toolResultRec(sessionId: string, toolUseId: string, ms: number, payload: unknown): RawRecord {
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

function telemetryRow(ms: number, over: Partial<TelemetryRecord> = {}): TelemetryRecord {
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

function recordOf(taskId: string, sessionId: string, over: Partial<ObservationRecord> = {}): ObservationRecord {
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

interface ObsOver {
  attempt?: number;
  records?: RawRecord[];
  telemetry?: TelemetryRecord[];
  record?: Partial<ObservationRecord> | null;
  snapshotBefore?: ArchivedObservation["snapshotBefore"];
  snapshotAfter?: ArchivedObservation["snapshotAfter"];
  invocationIds?: string[];
  identityIntact?: boolean;
}

function obsOf(taskId: string, over: ObsOver = {}): ArchivedObservation {
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
        : { ts: at(-1_000), slugsWalked: 4, files: 2, requestIds: ["rq-prior"] },
    snapshotAfter:
      over.snapshotAfter !== undefined
        ? over.snapshotAfter
        : {
            ts: at(60_000),
            slugsWalked: 4,
            files: 3,
            requestIds: ["rq-prior", ...(record?.originatedRequestIds ?? [])],
          },
    problems: [],
  };
}

function taskOf(id: string, over: Partial<ManifestTask> = {}): ManifestTask {
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
    fileScope: ["src/"],
    ...over,
  };
}

const PINNED = {
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

function runlogOf(observations: readonly ArchivedObservation[]): RunlogRow[] {
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

interface ArchiveOver {
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

function archiveOf(over: ArchiveOver = {}): RunArchive {
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

const AUDIT_CLEAN: GitAudit = { ran: true, verdict: "clean", reasons: [], inputs: { head: "abc" } };

// The default actual invocation MATCHES the pin: `voidConditions` 19 fails
// closed on an absent side (the fifth diff round's second finding), so a
// clean default archive must supply the invocation it was scored by.
function assemble(archive: RunArchive, gitAudit: GitAudit = AUDIT_CLEAN, actual: string | null = PINNED.scoringCommand) {
  return assembleRun({ archive, gitAudit, scoringCommandActual: actual });
}

const check = (result: { archiveChecks: { clause: string; fired: boolean; detail: string }[] }, prefix: string) => {
  const found = result.archiveChecks.find((c) => c.clause.startsWith(prefix));
  if (found === undefined) throw new Error(`no archive check starts with "${prefix}"`);
  return found;
};

const cfOf = (out: ReturnType<typeof assembleRun>, taskId: string, attempt = 1) =>
  out.counterfactual.observations.find((o) => o.taskId === taskId && o.attempt === attempt);

// ---------------------------------------------------------------------------

describe("the default archive — one coherent value, and what fires on it", () => {
  it("only clause 8 fires, and it names F23 — the artifact cannot yet carry two brackets", () => {
    const out = assemble(archiveOf());
    const fired = out.result.archiveChecks.filter((c) => c.fired);
    expect(fired.map((c) => c.clause)).toEqual(["voidConditions 8 — measured cap and both brackets"]);
    expect(fired[0]!.detail).toMatch(/F23/);
    // The archive-level void OVERRIDES the arithmetic's (clause 3 would have
    // named the 1-of-20 count): a void the arithmetic cannot see is still a void.
    expect(out.result.verdict).toBe("void");
    expect(out.result.voidClause).toMatch(/^voidConditions 8/);
  });

  it("the single observation is scored, admitted, and its report fields are the hand-derived ones", () => {
    const out = assemble(archiveOf());
    const cf = cfOf(out, "t1")!;
    expect(cf.disposition).toBe("scored");
    expect(cf.firedPredicates).toEqual([]);
    // One 1,000-token 1h cache write at 2.0x = 2,000 units; O = 310.8 chars /
    // 3.7 × writeComponent(1h) = 84 × 2.0 = 168.
    expect(cf.aO).toBeCloseTo(2_000, 9);
    expect(cf.oO).toBeCloseTo(168, 9);
    expect(cf.aPlusSPositive).toBe(true); // PREMISES § B12: reported, deciding nothing
    expect(cf.perTaskDenominatorShare).toBe(1);
    expect(out.result.rLo).toBeCloseTo((0 - 168) / 2_000, 12);
    expect(out.result.admitted).toBe(1);
  });

  it("the registered conventions are labelled on the artifact, not buried", () => {
    const out = assemble(archiveOf());
    expect(out.result.dispositionPrecedence).toMatch(/REGISTERED CONVENTION/);
    expect(out.result.schema).toBe("b12-result/1");
    expect(out.counterfactual.schema).toBe("b12-counterfactual/1");
  });
});

describe("the disposition table — every predicate FIRING, with its control", () => {
  it("void(execution_error) on a harness outcome, and NOT on completed", () => {
    const out = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { outcome: "exited_nonzero" } })] })
    );
    expect(cfOf(out, "t1")!.disposition).toBe("void(execution_error)");
    expect(cfOf(assemble(archiveOf()), "t1")!.disposition).toBe("scored");
  });

  it("void(execution_error) when the lineage holds no billed assistant turn", () => {
    const records = [toolResultRec("sess-t1-1", "tu-1", 0, { note: "no billed request here" })];
    const out = assemble(archiveOf({ observations: [obsOf("t1", { records })] }));
    expect(cfOf(out, "t1")!.disposition).toBe("void(execution_error)");
    expect(cfOf(out, "t1")!.firedPredicates.join(" ")).toMatch(/no billed assistant turn/);
  });

  it("censored is an OUTCOME, not an error — the observation stays scored", () => {
    const out = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { censored: true, outcome: "censored" } })] })
    );
    expect(cfOf(out, "t1")!.disposition).toBe("scored");
  });

  it("void(version_drift) against the pinned version, and clause 7 reports it", () => {
    const out = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { binaryVersion: "2.1.222" } })] })
    );
    expect(cfOf(out, "t1")!.disposition).toBe("void(version_drift)");
    expect(check(out.result, "voidConditions 7").fired).toBe(true);
  });

  it("void(instrument_write) when a tool_use touches the telemetry log — run-level via clause 9", () => {
    const sessionId = "sess-t1-1";
    const records = [
      billed("rq-t1", sessionId, 0, {
        write1h: 1_000,
        content: [
          { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "cat .local-coder/telemetry.jsonl" } },
        ],
      }),
    ];
    const out = assemble(archiveOf({ observations: [obsOf("t1", { records })] }));
    expect(cfOf(out, "t1")!.disposition).toBe("void(instrument_write)");
    expect(check(out.result, "voidConditions 9").fired).toBe(true);
    // control: an innocuous command scans clean
    expect(instrumentWriteTriggers([billed("r", "s", 0, { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "npx tsc --noEmit" } }] })])).toEqual([]);
    // Windows spelling is normalised before matching
    expect(
      instrumentWriteTriggers([
        billed("r", "s", 0, { content: [{ type: "tool_use", id: "x", name: "Read", input: { file_path: "C:\\repo\\.local-coder\\telemetry.jsonl" } }] }),
      ])
    ).toEqual([".local-coder/telemetry.jsonl"]);
  });

  it("void(rate_key_mixed) when the window's OWN requests span two keys", () => {
    const sessionId = "sess-t1-1";
    const records = [
      billed("rq-t1", sessionId, 0, { write1h: 1_000 }),
      billed("rq-t1b", sessionId, 1_000, { write1h: 100, model: "other-model" }),
    ];
    const out = assemble(
      archiveOf({
        observations: [obsOf("t1", { records, record: { originatedRequestIds: ["rq-t1", "rq-t1b"] } })],
      })
    );
    expect(cfOf(out, "t1")!.disposition).toBe("void(rate_key_mixed)");
  });

  it("void(withheld) fires on provenanceUnavailable ONLY", () => {
    // A local tool result with NO invocation id anywhere: localResults > 0,
    // byInvocation empty — report.ts's own predicate, quoted by admissionRule 5.
    const sessionId = "sess-t1-1";
    const records = [
      billed("rq-t1", sessionId, 0, {
        write1h: 1_000,
        content: [{ type: "tool_use", id: "tu-1", name: "mcp__local-coder__gate" }],
      }),
      toolResultRec(sessionId, "tu-1", 500, { content: [{ type: "text", text: "gate output, no id echoed" }] }),
    ];
    const out = assemble(archiveOf({ observations: [obsOf("t1", { records })] }));
    expect(cfOf(out, "t1")!.disposition).toBe("void(withheld)");
  });

  it("ambiguous > 0 does NOT void — admissionRule 6 admits it to the fall arithmetic, hold-excluded", () => {
    // THE DEFENDED READING (plan gate R4): one invocation id echoed by two
    // lineages is ambiguous; the observation stays `scored` and is excluded
    // from the hold arithmetic inside `aggregate` — a void here would drop it
    // from the fall bounds, which rule 6 forbids in its own words.
    const id = "aaaaaaaa-1111-2222-3333-444444444444";
    const lineage = (taskId: string, ms: number): RawRecord[] => [
      billed(`rq-${taskId}`, `sess-${taskId}-1`, ms, {
        write1h: 1_000,
        content: [{ type: "tool_use", id: `tu-${taskId}`, name: "mcp__local-coder__gate" }],
      }),
      toolResultRec(`sess-${taskId}-1`, `tu-${taskId}`, ms + 500, {
        content: [{ type: "text", text: JSON.stringify({ invocation_id: id }) }],
      }),
    ];
    const out = assemble(
      archiveOf({
        tasks: [taskOf("t1"), taskOf("t2")],
        observations: [
          obsOf("t1", { records: lineage("t1", 0), telemetry: [telemetryRow(600, { invocation_id: id })] }),
          obsOf("t2", { records: lineage("t2", 500_000) }),
        ],
      })
    );
    const cf = cfOf(out, "t1")!;
    expect(cf.disposition).toBe("scored");
    expect(cf.holdExcluded).toBe(true);
  });

  it("void(sibling_inheritance) when an originated id sits in the cumulative union", () => {
    const out = assemble(
      archiveOf({
        tasks: [taskOf("t1"), taskOf("t2")],
        observations: [
          obsOf("t1"),
          obsOf("t2", {
            records: [billed("rq-t1", "sess-t2-1", 200_000, { write1h: 100 })],
            record: { originatedRequestIds: ["rq-t1"] },
          }),
        ],
      })
    );
    expect(cfOf(out, "t2")!.disposition).toBe("void(sibling_inheritance)");
    expect(cfOf(out, "t1")!.disposition).toBe("scored");
  });

  it("void(task_failed) against the DECLARED expected exit", () => {
    const out = assemble(archiveOf({ observations: [obsOf("t1", { record: { accepted: false } })] }));
    expect(cfOf(out, "t1")!.disposition).toBe("void(task_failed)");
  });

  it("void(pacing) on a gap longer than the shortest TTL in play, and clause 20 reports it", () => {
    const sessionId = "sess-t1-1";
    const records = [
      billed("rq-t1", sessionId, 0, { write1h: 1_000 }),
      billed("rq-t1b", sessionId, 2 * 3_600_000, { write1h: 100 }),
    ];
    const out = assemble(
      archiveOf({
        observations: [obsOf("t1", { records, record: { originatedRequestIds: ["rq-t1", "rq-t1b"] } })],
      })
    );
    expect(cfOf(out, "t1")!.disposition).toBe("void(pacing)");
    expect(check(out.result, "voidConditions 20").fired).toBe(true);
    // control: ten minutes apart is inside the 1h TTL
    const calm = pacingFacts(
      transcriptFromRecords(
        [billed("a", "s", 0, { write1h: 10 }), billed("b", "s", 600_000, { write1h: 10 })],
        { files: ["/f"], skippedLines: 0, sessionId: "s" }
      ),
      new Set(["a", "b"]),
      DEFAULT_RATES,
      1
    );
    expect(calm.exceeded).toBeNull();
  });

  it("not_started is lawful and reported with its disposition", () => {
    const out = assemble(archiveOf({ tasks: [taskOf("t1"), taskOf("t2")], observations: [obsOf("t1")] }));
    expect(out.result.dispositions).toContainEqual({ taskId: "t2", arm: "treatment", disposition: "not_started" });
  });

  it("precedence is the registered order, and EVERY fired predicate is published", () => {
    // exited_nonzero AND accepted false: execution_error precedes task_failed in
    // the closed list's published order, and both matches are on the face.
    const out = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { outcome: "exited_nonzero", accepted: false } })] })
    );
    const cf = cfOf(out, "t1")!;
    expect(cf.disposition).toBe("void(execution_error)");
    expect(cf.firedPredicates.some((p) => p.startsWith("void(task_failed)"))).toBe(true);
    expect(DISPOSITION_PRECEDENCE.indexOf("void(execution_error)")).toBeLessThan(
      DISPOSITION_PRECEDENCE.indexOf("void(task_failed)")
    );
  });
});

describe("F25 at scoring time — reported by name, no disposition minted, nothing thrown", () => {
  it("accepted null with nothing else fired is a declaration failure with NO terms", () => {
    const out = assemble(archiveOf({ observations: [obsOf("t1", { record: { accepted: null } })] }));
    expect(out.result.declarationFailures).toHaveLength(1);
    expect(out.result.declarationFailures[0]!.reasons.join(" ")).toMatch(/F25/);
    expect(cfOf(out, "t1")).toBeUndefined(); // no terms, outside every domain — registered in FINDINGS
    expect(out.result.admitted).toBe(0);
  });

  it("a missing verificationStratum still gets terms, and both declared cells go unevaluable", () => {
    const out = assemble(
      archiveOf({ tasks: [taskOf("t1", { verificationStratum: null })], observations: [obsOf("t1")] })
    );
    expect(out.result.declarationFailures).toHaveLength(1);
    expect(cfOf(out, "t1")).toBeDefined(); // terms exist — the shipped unknownStratum machinery judges
    expect(out.result.strata.testRed.evaluable).toBe(false);
    expect(out.result.strata.typesOnly.evaluable).toBe(false);
  });

  it("a treatment record with no calibrated installedChars is refused terms, never defaulted", () => {
    const out = assemble(archiveOf({ observations: [obsOf("t1", { record: { installedChars: null } })] }));
    expect(cfOf(out, "t1")).toBeUndefined();
    expect(out.result.declarationFailures[0]!.reasons.join(" ")).toMatch(/installedChars/);
  });

  it("an unreadable observation.json is reported, not thrown", () => {
    const out = assemble(archiveOf({ observations: [obsOf("t1", { record: null })] }));
    expect(out.result.declarationFailures).toHaveLength(1);
    expect(out.result.verdict).toBe("void");
  });
});

describe("admissionRule 12 — re-runs: both archived, both published, one discretionary", () => {
  it("the LAST attempt scores (registered convention) and both fractions are published", () => {
    const out = assemble(
      archiveOf({
        observations: [
          obsOf("t1", { record: { outcome: "exited_nonzero" } }),
          obsOf("t1", { attempt: 2 }),
        ],
      })
    );
    expect(out.result.reruns).toEqual([{ taskId: "t1", arm: "treatment", attempts: 2, scoredAttempt: 2 }]);
    expect(cfOf(out, "t1", 1)).toBeDefined();
    expect(cfOf(out, "t1", 2)).toBeDefined();
    expect(cfOf(out, "t1", 2)!.aPlusSPositive).toBe(true); // admitted
    expect(cfOf(out, "t1", 1)!.aPlusSPositive).toBeNull(); // published, not admitted
    expect(check(out.result, "admissionRule 12").fired).toBe(false);
  });

  it("a second discretionary re-run fires the budget check and the excess is barred", () => {
    const out = assemble(
      archiveOf({
        tasks: [taskOf("t1"), taskOf("t2")],
        observations: [
          obsOf("t1", { record: { outcome: "exited_nonzero" } }),
          obsOf("t1", { attempt: 2 }),
          obsOf("t2", { record: { outcome: "exited_nonzero" } }),
          obsOf("t2", { attempt: 2 }),
        ],
      })
    );
    expect(check(out.result, "admissionRule 12").fired).toBe(true);
    // the second discretionary re-run (t2's, later in run order) is barred
    expect(cfOf(out, "t2", 2)!.aPlusSPositive).toBeNull();
  });

  it("a re-run after void(version_drift) does not consume the discretionary budget", () => {
    const out = assemble(
      archiveOf({
        tasks: [taskOf("t1"), taskOf("t2")],
        observations: [
          obsOf("t1", { record: { binaryVersion: "2.1.222" } }),
          obsOf("t1", { attempt: 2 }),
          obsOf("t2", { record: { outcome: "exited_nonzero" } }),
          obsOf("t2", { attempt: 2 }),
        ],
      })
    );
    expect(check(out.result, "admissionRule 12").fired).toBe(false);
    expect(check(out.result, "admissionRule 12").detail).toMatch(/1 discretionary/);
  });
});

describe("selection — the committed order, and the metamorphic pair", () => {
  const manyTasks = (ids: string[]): { tasks: ManifestTask[]; observations: ArchivedObservation[] } => ({
    tasks: ids.map((id) => taskOf(id)),
    observations: ids.map((id) => obsOf(id)),
  });

  it("shuffling the observation array changes NOTHING — the manifest order governs", () => {
    const { tasks, observations } = manyTasks(["t1", "t2", "t3"]);
    const forward = assemble(archiveOf({ tasks, observations }));
    const reversed = assemble(archiveOf({ tasks, observations: [...observations].reverse() }));
    expect(reversed.result.dispositions).toEqual(forward.result.dispositions);
    expect(reversed.result.rLo).toBe(forward.result.rLo);
  });

  it("changing ONLY the manifest order changes which first 20 are selected", () => {
    const ids = Array.from({ length: 21 }, (_, i) => `t${String(i + 1).padStart(2, "0")}`);
    const { tasks, observations } = manyTasks(ids);
    const a = assemble(archiveOf({ tasks, observations }));
    // t21 first: it displaces t20 from the admitted twenty.
    const rotated = [tasks[20]!, ...tasks.slice(0, 20)];
    const b = assemble(archiveOf({ tasks: rotated, observations, runlogRows: [] }));
    const admittedOf = (out: ReturnType<typeof assembleRun>): string[] =>
      out.counterfactual.observations.filter((o) => o.aPlusSPositive !== null).map((o) => o.taskId);
    expect(admittedOf(a)).toContain("t20");
    expect(admittedOf(a)).not.toContain("t21");
    expect(admittedOf(b)).toContain("t21");
    expect(admittedOf(b)).not.toContain("t20");
    expect(a.result.admitted).toBe(20);
    expect(b.result.admitted).toBe(20);
  });

  it("an invalid observation cannot admit even when every predicate reads scored", () => {
    const out = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { valid: false, invalidReasons: ["drift"] } })] })
    );
    expect(cfOf(out, "t1")!.disposition).toBe("scored");
    expect(cfOf(out, "t1")!.aPlusSPositive).toBeNull(); // not admitted
    expect(out.result.admitted).toBe(0);
  });
});

describe("committedOrderReplay — voidConditions 3's order half, retrospective", () => {
  const tasks = [taskOf("t1"), taskOf("t2"), taskOf("t3")];
  // The session must be the attempt's own — the binding half of clause 2's
  // replay refuses a row it cannot show to be an attempt's row.
  const row = (taskId: string, i: number, attempt = 1): RunlogRow => ({
    ts: at(i * 1_000),
    runId: RUN,
    taskId,
    arm: "treatment",
    sessionId: `sess-${taskId}-${attempt}`,
    outcome: "completed",
    valid: true,
    accepted: true,
    originated: 1,
  });

  it("fires when a task first ran before its predecessor", () => {
    const archive = archiveOf({ tasks, observations: [obsOf("t2")], runlogRows: [row("t2", 0)] });
    expect(committedOrderReplay(archive)).toMatch(/before its predecessor t1/);
    expect(check(assemble(archive).result, "voidConditions 2").fired).toBe(true);
  });

  it("a late RE-RUN is not an order event (admissionRule 12 has no temporal clause)", () => {
    const archive = archiveOf({
      tasks,
      observations: [obsOf("t1"), obsOf("t2"), obsOf("t1", { attempt: 2 })],
      runlogRows: [row("t1", 0), row("t2", 1), row("t1", 2, 2)],
    });
    expect(committedOrderReplay(archive)).toBeNull();
  });

  it("fires on a task the committed order does not contain, and on a corrupt runlog", () => {
    expect(
      committedOrderReplay(
        archiveOf({ tasks, observations: [obsOf("t1"), obsOf("tX")], runlogRows: [row("t1", 0), row("tX", 1)] })
      )
    ).toMatch(/does not contain/);
    expect(
      committedOrderReplay(archiveOf({ tasks, observations: [obsOf("t1")], runlogRows: [row("t1", 0)], corruptLines: 1 }))
    ).toMatch(/corrupt/);
  });

  it("ABSENT runlog evidence is not compliance — a run with no rows cannot replay its order", () => {
    // The diff review's second finding: an empty runlog passed as clean while
    // the archive held real attempts. Every archived attempt needs its row,
    // and every row its directory.
    expect(
      committedOrderReplay(archiveOf({ tasks, observations: [obsOf("t1")], runlogRows: [] }))
    ).toMatch(/1 archived attempt\(s\) but 0 runlog row\(s\)/);
    expect(
      committedOrderReplay(
        archiveOf({ tasks, observations: [obsOf("t1")], runlogRows: [row("t1", 0), row("t2", 1)] })
      )
    ).toMatch(/no observation directory survives/);
  });

  it("the rows must be THESE attempts' rows — the fifth round's session and run bindings", () => {
    // Count equality holds but the row records another session: the
    // correspondence the counts assert is fake, and the replay refuses.
    expect(
      committedOrderReplay(
        archiveOf({
          tasks,
          observations: [obsOf("t1")],
          runlogRows: [{ ...row("t1", 0), sessionId: "sess-somebody-else" }],
        })
      )
    ).toMatch(/no runlog row for t1 records/);
    // A row naming another run is foreign evidence in this run's log.
    expect(
      committedOrderReplay(
        archiveOf({ tasks, observations: [obsOf("t1")], runlogRows: [{ ...row("t1", 0), runId: "other-run" }] })
      )
    ).toMatch(/foreign evidence/);
    // An empty sessionId on either side is a binding that cannot be shown.
    expect(
      committedOrderReplay(
        archiveOf({ tasks, observations: [obsOf("t1")], runlogRows: [{ ...row("t1", 0), sessionId: "" }] })
      )
    ).toMatch(/cannot be bound to its session/);
    // the negative control: the attempt's own session replays clean
    expect(
      committedOrderReplay(archiveOf({ tasks, observations: [obsOf("t1")], runlogRows: [row("t1", 0)] }))
    ).toBeNull();
  });
});

describe("the archive-level clauses — each fired and each held", () => {
  it("design.artifacts 1 fires on a missing HEAD blob and on a post-start commit", () => {
    const missing = assemble(archiveOf({ git: { manifestBlobSha256: null } }));
    expect(check(missing.result, "design.artifacts 1").fired).toBe(true);
    expect(missing.result.voidClause).toMatch(/^design\.artifacts 1/); // first in table order
    const touched = assemble(archiveOf({ git: { manifestCommitsAfterStart: ["deadbeef"] } }));
    expect(check(touched.result, "design.artifacts 1").fired).toBe(true);
    expect(check(assemble(archiveOf()).result, "design.artifacts 1").fired).toBe(false);
  });

  it("voidConditions 4 fires when rates.json drifts from the frozen blob or the pin", () => {
    const drifted = assemble(archiveOf({ ratesSha256: H64("0") }));
    expect(check(drifted.result, "voidConditions 4 — rates").fired).toBe(true);
    expect(check(assemble(archiveOf()).result, "voidConditions 4 — rates").fired).toBe(false);
  });

  it("voidConditions 12 fires on a component hash that moved, and on a missing policy blob hash", () => {
    const components = {
      claudeMd: "h-claude",
      memory: "h-mem",
      settings: "h-set",
      settingsLocal: "h-setl",
      mcpConfigPassed: "h-mcp",
      policyBlob: "h-pol",
      allowlist: null,
    };
    const drifted = assemble(
      archiveOf({
        observations: [
          obsOf("t1", {
            record: { instructionHashes: { pre: { ...components }, post: { ...components, settings: "MOVED" } } },
          }),
        ],
      })
    );
    expect(check(drifted.result, "voidConditions 12").fired).toBe(true);
    const missingPolicy = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { policyBlobSha256: null } })] })
    );
    expect(check(missingPolicy.result, "voidConditions 12").fired).toBe(true);
    expect(check(assemble(archiveOf()).result, "voidConditions 12").fired).toBe(false);
  });

  it("voidConditions 13 fires on a memory write and on a snapshot that is not the pinned one", () => {
    const components = {
      claudeMd: "h-claude",
      memory: "h-mem",
      settings: "h-set",
      settingsLocal: "h-setl",
      mcpConfigPassed: "h-mcp",
      policyBlob: "h-pol",
      allowlist: null,
    };
    const written = assemble(
      archiveOf({
        observations: [
          obsOf("t1", {
            record: { instructionHashes: { pre: { ...components }, post: { ...components, memory: "WROTE" } } },
          }),
        ],
      })
    );
    expect(check(written.result, "voidConditions 13").fired).toBe(true);
    const wrongSnapshot = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { memorySnapshotSha256: H64("f") } })] })
    );
    expect(check(wrongSnapshot.result, "voidConditions 13").fired).toBe(true);
    expect(check(assemble(archiveOf()).result, "voidConditions 13").fired).toBe(false);
  });

  it("voidConditions 14 fires on a missing or zero-count snapshot", () => {
    const missing = assemble(archiveOf({ observations: [obsOf("t1", { snapshotBefore: null })] }));
    expect(check(missing.result, "voidConditions 14").fired).toBe(true);
    const zero = assemble(
      archiveOf({
        observations: [
          obsOf("t1", { snapshotBefore: { ts: at(0), slugsWalked: 0, files: 0, requestIds: [] } }),
        ],
      })
    );
    expect(check(zero.result, "voidConditions 14").fired).toBe(true);
    expect(check(assemble(archiveOf()).result, "voidConditions 14").fired).toBe(false);
  });

  it("voidConditions 11 fires when an observation's base commit is not its declared one", () => {
    const out = assemble(archiveOf({ observations: [obsOf("t1", { record: { baseCommit: SHA40("9") } })] }));
    expect(check(out.result, "voidConditions 11").fired).toBe(true);
    expect(check(assemble(archiveOf()).result, "voidConditions 11").fired).toBe(false);
  });

  it("voidConditions 19 compares the scoring command and publishes the ambiguity id set", () => {
    const pinnedCmd = PINNED.scoringCommand;
    const match = assemble(archiveOf(), AUDIT_CLEAN, pinnedCmd);
    expect(check(match.result, "voidConditions 19").fired).toBe(false);
    const differ = assemble(archiveOf(), AUDIT_CLEAN, "node something-else.js");
    expect(check(differ.result, "voidConditions 19").fired).toBe(true);
    expect(match.result.scoringCommand).toEqual({ pinned: pinnedCmd, actual: pinnedCmd });
    expect(Array.isArray(match.result.ambiguityIdSet)).toBe(true);
  });

  it("voidConditions 19 FAILS CLOSED — an absent pin or an unsupplied invocation is never clean", () => {
    // The fifth diff round's second finding: certifying "the registered
    // command scored this run" needs both sides of the comparison.
    const noActual = assemble(archiveOf(), AUDIT_CLEAN, null);
    expect(check(noActual.result, "voidConditions 19").fired).toBe(true);
    expect(check(noActual.result, "voidConditions 19").detail).toMatch(/not supplied/);
    const noPin = assemble(archiveOf({ pinned: { scoringCommand: undefined } }));
    expect(check(noPin.result, "voidConditions 19").fired).toBe(true);
    expect(check(noPin.result, "voidConditions 19").detail).toMatch(/no scoring command is pinned/);
  });

  it("voidConditions 7 and 20 fire when their pins are absent — a sealed manifest carries both", () => {
    const noVersion = assemble(archiveOf({ pinned: { claudeCodeVersion: undefined } }));
    expect(check(noVersion.result, "voidConditions 7").fired).toBe(true);
    const noCeiling = assemble(archiveOf({ pinned: { pacingCacheWriteShareCeiling: undefined } }));
    expect(check(noCeiling.result, "voidConditions 20").fired).toBe(true);
  });
});

describe("the diff review's trust boundaries — absent evidence is never clean", () => {
  it("a suspect telemetry source prices NOTHING: integrity failure, fired check, no terms", () => {
    const out = assemble(
      archiveOf({
        tasks: [taskOf("t1"), taskOf("t2")],
        observations: [obsOf("t1"), { ...obsOf("t2"), telemetryIntact: false, problems: ["telemetry.jsonl carries 1 corrupt line(s)"] }],
      })
    );
    expect(out.result.integrityFailures).toEqual([
      {
        taskId: "t2",
        arm: "treatment",
        attempt: 1,
        reasons: ["the telemetry identity source is not intact", "telemetry.jsonl carries 1 corrupt line(s)"],
      },
    ]);
    expect(check(out.result, "design.artifacts 6").fired).toBe(true);
    expect(cfOf(out, "t2")).toBeUndefined(); // no terms from a tampered source
    expect(cfOf(out, "t1")).toBeDefined();
    // the negative control: an intact archive holds the check quiet
    expect(check(assemble(archiveOf()).result, "design.artifacts 6").fired).toBe(false);
  });

  it("cross-wired identity prices NOTHING — the fifth round's first finding", () => {
    // Evidence whose own identity does not bind to the directory it was
    // scored from would apply one task's acceptance and telemetry to another;
    // it is an integrity failure with no terms, never a scored observation.
    const crossWired = obsOf("t2", {
      identityIntact: false,
    });
    crossWired.problems.push("observation.json names t9/treatment while the directory names t2/treatment");
    const out = assemble(
      archiveOf({ tasks: [taskOf("t1"), taskOf("t2")], observations: [obsOf("t1"), crossWired] })
    );
    expect(check(out.result, "design.artifacts 6").fired).toBe(true);
    expect(cfOf(out, "t2")).toBeUndefined(); // no terms under a borrowed name
    expect(out.result.integrityFailures).toHaveLength(1);
    expect(out.result.integrityFailures[0]!.reasons.join(" ")).toMatch(/cross-wired or unshowable/);
    expect(out.result.verdict).toBe("void");
    // the negative control: a bound identity computes terms as ever
    expect(cfOf(assemble(archiveOf()), "t1")).toBeDefined();
  });

  it("a record with NO instruction hashes fires clause 12 — unshowable is not clean", () => {
    const out = assemble(archiveOf({ observations: [obsOf("t1", { record: { instructionHashes: null } })] }));
    expect(check(out.result, "voidConditions 12").fired).toBe(true);
    expect(check(out.result, "voidConditions 12").detail).toMatch(/no instruction hashes at all/);
  });

  it("missing memory evidence fires clause 13 in each of its three shapes", () => {
    const noRestoration = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { memorySnapshotSha256: null } })] })
    );
    expect(check(noRestoration.result, "voidConditions 13").fired).toBe(true);
    expect(check(noRestoration.result, "voidConditions 13").detail).toMatch(/no restoration hash/);
    const noPin = assemble(archiveOf({ pinned: { memorySnapshotSha256: undefined } }));
    expect(check(noPin.result, "voidConditions 13").fired).toBe(true);
    expect(check(noPin.result, "voidConditions 13").detail).toMatch(/pins no memory snapshot/);
  });

  it("evidence that differs from HEAD prices nothing — dirty files bar terms and fire the committed-evidence check", () => {
    // The second diff round's first finding: the commit barrier proves the
    // WRITE; the replay must prove the READ. A dirty path is positive
    // evidence of tampering, so the observation loses its terms too.
    const dirtyObs = { ...obsOf("t2"), evidenceCommitted: false };
    const out = assemble(
      archiveOf({
        tasks: [taskOf("t1"), taskOf("t2")],
        observations: [obsOf("t1"), dirtyObs],
        evidenceCommitted: { state: "dirty", dirty: [`evidence/${RUN}/obs-t2-treatment/telemetry.jsonl`] },
      })
    );
    expect(check(out.result, "design.artifacts 6 — committed evidence").fired).toBe(true);
    expect(cfOf(out, "t2")).toBeUndefined();
    expect(out.result.integrityFailures[0]!.reasons.join(" ")).toMatch(/differ from HEAD/);
    // control: a clean state holds the check quiet
    expect(check(assemble(archiveOf()).result, "design.artifacts 6 — committed evidence").fired).toBe(false);
  });

  it("UNSHOWABLE committedness fires the check but does not fabricate a tampering claim — terms still publish", () => {
    const unshowable = { ...obsOf("t1"), evidenceCommitted: null };
    const out = assemble(
      archiveOf({ observations: [unshowable], evidenceCommitted: { state: "unshowable", dirty: [] } })
    );
    expect(check(out.result, "design.artifacts 6 — committed evidence").fired).toBe(true);
    expect(check(out.result, "design.artifacts 6 — committed evidence").detail).toMatch(/UNSHOWABLE/);
    expect(cfOf(out, "t1")).toBeDefined(); // the partial bracket is owed either way
    expect(out.result.verdict).toBe("void");
  });

  it("a manifest whose scored bytes are not HEAD's blob fires artifact 1 — a path proves nothing about bytes", () => {
    const out = assemble(archiveOf({ git: { manifestMatchesHead: false } }));
    const c = check(out.result, "design.artifacts 1");
    expect(c.fired).toBe(true);
    expect(c.detail).toMatch(/NOT HEAD's blob/);
  });

  it("an unestablishable freeze window fires artifact 1 — a freeze that cannot be shown held is not a freeze", () => {
    // The fourth adversarial round: the window was anchored on the runlog
    // row's END-of-observation ts, and a null anchor read as "held".
    const out = assemble(archiveOf({ git: { manifestCommitsAfterStart: null } }));
    const c = check(out.result, "design.artifacts 1");
    expect(c.fired).toBe(true);
    expect(c.detail).toMatch(/freeze window could not be established/);
  });

  it("rates verification fails CLOSED — an absent pin or an unreadable frozen blob is never clean", () => {
    const noFrozen = assemble(archiveOf({ git: { ratesSha256AtFrozenCommit: null } }));
    expect(check(noFrozen.result, "voidConditions 4 — rates").fired).toBe(true);
    expect(check(noFrozen.result, "voidConditions 4 — rates").detail).toMatch(/cannot be SHOWN/);
    const noPin = assemble(archiveOf({ pinned: { ratesSha256: undefined } }));
    expect(check(noPin.result, "voidConditions 4 — rates").fired).toBe(true);
    // the control: with all three hashes present and equal, the check is quiet
    expect(check(assemble(archiveOf()).result, "voidConditions 4 — rates").fired).toBe(false);
  });

  it("a register that cannot be shown complete fires clause 1's check — discrepancies are never mere annotations", () => {
    // The third adversarial round: a locally deleted MEASUREMENTS row turned
    // an abandoned run into a reported-but-deciding-nothing discrepancy.
    const out = assemble(
      archiveOf({
        register: {
          priorRuns: [],
          discrepancies: [
            "evidence/old-run.b12.tasks.json is committed but MEASUREMENTS.jsonl carries no old-run row — registration is conjunctive and this is neither registered nor clean",
          ],
        },
      })
    );
    const c = check(out.result, "voidConditions 1 — the register");
    expect(c.fired).toBe(true);
    expect(c.detail).toMatch(/cannot be shown complete/);
    expect(check(assemble(archiveOf()).result, "voidConditions 1 — the register").fired).toBe(false);
  });

  it("clause 19 compares the derived ambiguity universe against the SEALED invocation inventory", () => {
    // A sealed id the rebuilt transcript no longer carries means a tool result
    // was dropped somewhere — the ambiguity universe silently shrank.
    const out = assemble(
      archiveOf({
        observations: [obsOf("t1", { invocationIds: ["aaaaaaaa-9999-8888-7777-666666666666"] })],
      })
    );
    expect(check(out.result, "voidConditions 19").fired).toBe(true);
    expect(check(out.result, "voidConditions 19").detail).toMatch(/sealed id\(s\) absent/);
  });
});

describe("the clause 4–6 audit — an input, never a silent pass", () => {
  it("{ran: false} leaves clauses 4–6 UNCHECKED on the face, never 'clean'", () => {
    const out = assemble(archiveOf(), { ran: false });
    expect(out.result.uncheckedClauses).toHaveLength(3);
    expect(out.result.uncheckedClauses.join(" ")).toMatch(/voidConditions 5/);
    expect(out.result.gitAudit).toEqual({ ran: false });
  });

  it("a committed audit that returned void fires as a check and names its reasons", () => {
    const out = assemble(archiveOf(), {
      ran: true,
      verdict: "void",
      reasons: ["src/cost/report.ts changed after the first scored observation"],
      inputs: { head: "abc" },
    });
    expect(out.result.uncheckedClauses).toHaveLength(0);
    const audit = check(out.result, "voidConditions 4–6");
    expect(audit.fired).toBe(true);
    expect(audit.detail).toMatch(/report\.ts changed/);
  });

  it("a clean audit is on the face and fires nothing", () => {
    const out = assemble(archiveOf(), AUDIT_CLEAN);
    expect(check(out.result, "voidConditions 4–6").fired).toBe(false);
  });
});

describe("control arms and the run-level ledger", () => {
  it("admissionRule 13: control observations never enter the primary arithmetic", () => {
    const controlObs: ArchivedObservation = {
      ...obsOf("t1"),
      arm: "control",
      dir: `evidence/${RUN}/obs-t1-control`,
      record: { ...recordOf("t1", "sess-t1-c"), arm: "control", installedChars: { value: null, reason: "control arm" } },
    };
    const out = assemble(archiveOf({ observations: [obsOf("t1"), controlObs] }));
    expect(out.counterfactual.observations.every((o) => o.arm === "treatment")).toBe(true);
    expect(check(out.result, "admissionRule 13").detail).toMatch(/1 control observation/);
  });

  it("every universe key is accounted for: owned, contested, unsliced or unowned", () => {
    // The assertion that does not go through the units (UNIT-5.md "Done when"):
    // identity is stamped once per archive file, so every physical line appears
    // under ONE key everywhere, and the ledger names what it could not place.
    const id = "bbbbbbbb-1111-2222-3333-444444444444";
    const sessionId = "sess-t1-1";
    const records = [
      billed("rq-t1", sessionId, 0, {
        write1h: 1_000,
        content: [{ type: "tool_use", id: "tu-1", name: "mcp__local-coder__gate" }],
      }),
      toolResultRec(sessionId, "tu-1", 500, {
        content: [{ type: "text", text: JSON.stringify({ invocation_id: id }) }],
      }),
    ];
    const telemetry = [
      telemetryRow(600, { invocation_id: id }),
      telemetryRow(700), // no id — unverifiable, unowned
      telemetryRow(90_000_000), // outside every window — unsliced
    ];
    const out = assemble(archiveOf({ observations: [obsOf("t1", { records, telemetry })] }));
    const coverage = out.result.coverage;
    const universeKeys = telemetry.map((_, i) =>
      JSON.stringify([`evidence/${RUN}/obs-t1-treatment/telemetry.jsonl`, i])
    );
    for (const key of universeKeys) {
      const accounted =
        coverage.ownedBy.has(key) ||
        coverage.contested.some((c) => c.key === key) ||
        coverage.unsliced.includes(key) ||
        coverage.unownedRows.some((r) => r.key === key);
      expect.soft(accounted, `key ${key} vanished from the ledger`).toBe(true);
    }
    expect(coverage.unsliced).toHaveLength(1);
  });

  it("the round trip: the units called by hand produce the same bracket", () => {
    const out = assemble(archiveOf());
    // By hand, not through assemble: one admitted observation, A=2000, S=0,
    // O=168 — poolRatio gives (0-168)/2000 at both horizons.
    expect(out.result.rLo).toBeCloseTo(-0.084, 12);
    expect(out.result.rHi).toBeCloseTo(-0.084, 12);
    expect(out.result.rHiPlus.evaluable).toBe(true);
    if (out.result.rHiPlus.evaluable) expect(out.result.rHiPlus.value).toBeCloseTo(-0.084, 12);
    expect(out.result.recomputations.rLoMinusTask).toBe(0); // largest task dropped → empty set
    expect(out.result.recomputations.rAll).toBeCloseTo(-0.084, 12);
  });
});
