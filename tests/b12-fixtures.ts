/**
 * Shared fixtures for the B12 scorer's three per-unit oracles.
 *
 * WHY THREE FILES AND NOT ONE. The first attempt put all thirteen assertions in
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

import type { CreditedLedgerRow, RefusedLedgerRow, RowDisposition } from "../src/cost/report.js";
import type {
  Arm,
  B12Observation,
  IdentifiedRow,
  KeyedRow,
  ObservationTerms,
  RunTelemetryCoverage,
} from "../src/cost/b12/types.js";
import { identify, runCoverage } from "../src/cost/b12/coverage.js";
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
  toolUseId: string
): string {
  const write1h = usage.write1h ?? 0;
  return req(requestId, ms, usage, {
    message: {
      model: "test-model",
      content: [{ type: "tool_use", id: toolUseId, name: "mcp__local-coder__gate" }],
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
  return {
    invocationId: null,
    tool: "gate",
    ts: at(0),
    disposition: "credited",
    thread: "main",
    index: 0,
    segmentSize: 2,
    ttl: "1h",
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

export function terms(over: Partial<ObservationTerms> = {}): ObservationTerms {
  return {
    taskId: "t-1",
    arm: "treatment",
    disposition: "scored",
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
    subagentShare: { evaluable: true, value: { own: 1, sidechain: 0, share: 0, stratum: "solo" } },
    perDelivery: {},
    billedRequestCount: 1,
    rateKeys: ["test-model"],
    verificationStratum: "test-red",
    ...over,
  };
}
