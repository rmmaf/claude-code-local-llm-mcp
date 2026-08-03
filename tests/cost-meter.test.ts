import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCounterfactual,
  buildSessionReport,
  entryCostOfSegment,
  positionalMultiplier,
  priceUsage,
  scopeTelemetry,
} from "../src/cost/report.js";
import {
  DEFAULT_MULTIPLIERS,
  DEFAULT_RATES,
  inputPriceFor,
  loadRates,
  multipliersFor,
} from "../src/cost/rates.js";
import type { BilledRequest } from "../src/cost/transcript.js";
import { listTranscripts, projectTranscriptDir, readTranscript } from "../src/cost/transcript.js";
import { createTelemetryWriter, readTelemetry, TELEMETRY_REL_PATH } from "../src/telemetry.js";
import { makeTempRoot } from "./helpers.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = makeTempRoot("cost-meter-test-");
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
  }
});

interface FakeUsage {
  input?: number;
  write1h?: number;
  write5m?: number;
  read?: number;
  output?: number;
}

let clock = 0;

function assistantRecord(
  requestId: string,
  usage: FakeUsage,
  extra: Record<string, unknown> = {}
): string {
  const write1h = usage.write1h ?? 0;
  const write5m = usage.write5m ?? 0;
  return JSON.stringify({
    type: "assistant",
    requestId,
    sessionId: "sess-1",
    uuid: `uuid-${requestId}-${clock}`,
    parentUuid: null,
    isSidechain: false,
    timestamp: new Date(1_700_000_000_000 + clock++ * 1000).toISOString(),
    message: {
      model: "test-model",
      content: [],
      usage: {
        input_tokens: usage.input ?? 0,
        cache_creation_input_tokens: write1h + write5m,
        cache_read_input_tokens: usage.read ?? 0,
        output_tokens: usage.output ?? 0,
        cache_creation: {
          ephemeral_1h_input_tokens: write1h,
          ephemeral_5m_input_tokens: write5m,
        },
      },
    },
    ...extra,
  });
}

async function writeTranscript(root: string, lines: string[]): Promise<string> {
  const file = path.join(root, "session.jsonl");
  await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

describe("transcript parsing", () => {
  it("dedups usage by requestId while still collecting every tool_use block", async () => {
    clock = 0;
    const root = tempRoot();
    // One billed request written as three records, exactly as Claude Code does:
    // usage repeated verbatim, tool_use blocks spread across the records.
    const file = await writeTranscript(root, [
      assistantRecord("req-1", { write1h: 1000, read: 500, output: 100 }, {
        message: {
          model: "test-model",
          content: [{ type: "tool_use", id: "tu-1", name: "Bash" }],
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 500,
            output_tokens: 100,
            cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 },
          },
        },
      }),
      assistantRecord("req-1", { write1h: 1000, read: 500, output: 100 }, {
        message: {
          model: "test-model",
          content: [{ type: "tool_use", id: "tu-2", name: "Read" }],
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 500,
            output_tokens: 100,
            cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 },
          },
        },
      }),
      assistantRecord("req-2", { write1h: 200, read: 1500, output: 50 }),
    ]);

    const transcript = await readTranscript(file);

    expect(transcript.requests).toHaveLength(2);
    const [first] = transcript.requests;
    expect(first?.usage.cacheRead).toBe(500);
    expect(first?.usage.cacheWrite1h).toBe(1000);
    expect(first?.toolUses.map((t) => t.name)).toEqual(["Bash", "Read"]);
  });

  it("attributes an unsplit cache write to the cheaper 5m class", async () => {
    const root = tempRoot();
    const file = await writeTranscript(root, [
      JSON.stringify({
        type: "assistant",
        requestId: "req-1",
        sessionId: "s",
        uuid: "u1",
        timestamp: new Date(1_700_000_000_000).toISOString(),
        message: {
          model: "test-model",
          content: [],
          usage: { cache_creation_input_tokens: 800, cache_read_input_tokens: 0, output_tokens: 0 },
        },
      }),
    ]);

    const transcript = await readTranscript(file);
    expect(transcript.requests[0]?.usage.cacheWrite5m).toBe(800);
    expect(transcript.requests[0]?.usage.cacheWrite1h).toBe(0);
  });

  it("gives each subagent thread its own index and segment size", async () => {
    clock = 0;
    const root = tempRoot();
    const main = assistantRecord("req-main-1", { write1h: 100 });
    const sub = (id: string, uuid: string, parent: string | null): string =>
      JSON.stringify({
        type: "assistant",
        requestId: id,
        sessionId: "sess-1",
        uuid,
        parentUuid: parent,
        isSidechain: true,
        timestamp: new Date(1_700_000_000_000 + clock++ * 1000).toISOString(),
        message: {
          model: "test-model",
          content: [],
          usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 0 },
        },
      });

    const file = await writeTranscript(root, [
      main,
      sub("req-sub-a1", "a1", null),
      sub("req-sub-a2", "a2", "a1"),
      sub("req-sub-b1", "b1", null),
    ]);

    const transcript = await readTranscript(file);
    const threads = new Map(transcript.requests.map((r) => [r.requestId, r]));
    expect(threads.get("req-main-1")?.thread).toBe("main");
    // a1/a2 share a root; b1 is a different subagent, so it restarts at index 0.
    expect(threads.get("req-sub-a2")?.thread).toBe(threads.get("req-sub-a1")?.thread);
    expect(threads.get("req-sub-b1")?.thread).not.toBe(threads.get("req-sub-a1")?.thread);
    expect(threads.get("req-sub-a2")?.index).toBe(1);
    expect(threads.get("req-sub-b1")?.index).toBe(0);
    expect(threads.get("req-sub-a1")?.segmentSize).toBe(2);
  });

  it("resets the context segment at a compaction boundary", async () => {
    clock = 0;
    const root = tempRoot();
    const compact = JSON.stringify({
      type: "user",
      uuid: "compact-1",
      sessionId: "sess-1",
      isCompactSummary: true,
      timestamp: new Date(1_700_000_000_000 + 1500).toISOString(),
    });
    const file = await writeTranscript(root, [
      assistantRecord("req-1", { write1h: 100 }),
      assistantRecord("req-2", { write1h: 100 }),
      compact,
      assistantRecord("req-3", { write1h: 100 }),
    ]);

    const transcript = await readTranscript(file);
    const byId = new Map(transcript.requests.map((r) => [r.requestId, r]));
    expect(byId.get("req-2")?.segment).toBe(0);
    expect(byId.get("req-3")?.segment).toBe(1);
    expect(byId.get("req-3")?.index).toBe(0);
    expect(byId.get("req-1")?.segmentSize).toBe(2);
  });

  // A compaction resets ONE conversation's context. Pooling the boundaries
  // across threads corrupts `index` and `segmentSize` for every thread that did
  // not compact — and those two feed the positional multiplier.
  const at = (ms: number): string => new Date(1_700_000_000_000 + ms).toISOString();
  const subRecord = (id: string, uuid: string, parent: string | null, ms: number): string =>
    JSON.stringify({
      type: "assistant",
      requestId: id,
      sessionId: "sess-1",
      uuid,
      parentUuid: parent,
      isSidechain: true,
      timestamp: at(ms),
      message: {
        model: "test-model",
        content: [],
        usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 0 },
      },
    });

  it("does not let a main-thread compaction reset a subagent's segment", async () => {
    clock = 0;
    const root = tempRoot();
    const mainOne = assistantRecord("req-main-1", { write1h: 100 }); // t = 0
    clock = 2;
    const mainTwo = assistantRecord("req-main-2", { write1h: 100 }); // t = 2000

    const file = await writeTranscript(root, [
      mainOne,
      subRecord("req-sub-1", "s1", null, 1000),
      JSON.stringify({
        type: "user",
        uuid: "compact-main",
        sessionId: "sess-1",
        isCompactSummary: true,
        timestamp: at(1500),
      }),
      mainTwo,
      subRecord("req-sub-2", "s2", "s1", 3000),
    ]);

    const byId = new Map((await readTranscript(file)).requests.map((r) => [r.requestId, r]));
    expect(byId.get("req-main-1")?.segment).toBe(0);
    expect(byId.get("req-main-2")?.segment).toBe(1);
    expect(byId.get("req-sub-1")?.segment).toBe(0);
    expect(byId.get("req-sub-2")?.segment).toBe(0);
    expect(byId.get("req-sub-2")?.index).toBe(1);
    expect(byId.get("req-sub-1")?.segmentSize).toBe(2);
  });

  it("does not let a subagent's compaction reset the main thread", async () => {
    clock = 0;
    const root = tempRoot();
    const mainOne = assistantRecord("req-main-1", { write1h: 100 }); // t = 0
    clock = 2;
    const mainTwo = assistantRecord("req-main-2", { write1h: 100 }); // t = 2000

    const file = await writeTranscript(root, [
      mainOne,
      subRecord("req-sub-1", "s1", null, 1000),
      JSON.stringify({
        type: "user",
        uuid: "compact-sub",
        parentUuid: "s1",
        sessionId: "sess-1",
        isSidechain: true,
        isCompactSummary: true,
        timestamp: at(1500),
      }),
      mainTwo,
    ]);

    const byId = new Map((await readTranscript(file)).requests.map((r) => [r.requestId, r]));
    expect(byId.get("req-main-1")?.segment).toBe(0);
    expect(byId.get("req-main-2")?.segment).toBe(0);
    expect(byId.get("req-main-1")?.segmentSize).toBe(2);
  });

  it("counts unparseable lines instead of throwing", async () => {
    clock = 0;
    const root = tempRoot();
    const file = path.join(root, "s.jsonl");
    await fs.writeFile(file, `${assistantRecord("req-1", { output: 5 })}\n{"partial":`, "utf8");

    const transcript = await readTranscript(file);
    expect(transcript.requests).toHaveLength(1);
    expect(transcript.skippedLines).toBe(1);
  });

  it("mirrors Claude Code's project slug, dots included", () => {
    const dir = projectTranscriptDir("C:\\Users\\me\\proj\\.claude\\wt", "C:\\home");
    expect(path.basename(dir)).toBe("C--Users-me-proj--claude-wt");
  });

  it("returns no transcripts for a missing directory", async () => {
    await expect(listTranscripts(path.join(tempRoot(), "nope"))).resolves.toEqual([]);
  });
});

describe("pricing", () => {
  it("prices a known usage vector exactly", () => {
    const units = priceUsage(
      { input: 100, cacheWrite1h: 1000, cacheWrite5m: 400, cacheRead: 10_000, output: 200 },
      DEFAULT_MULTIPLIERS
    );
    expect(units.input).toBe(100);
    expect(units.cacheWrite).toBe(1000 * 2.0 + 400 * 1.25);
    expect(units.cacheRead).toBeCloseTo(1000, 6);
    expect(units.output).toBe(1000);
    expect(units.total).toBeCloseTo(100 + 2500 + 1000 + 1000, 6);
  });

  it("withholds session USD unless EVERY request's model is priced", async () => {
    clock = 0;
    const root = tempRoot();
    const file = await writeTranscript(root, [
      assistantRecord("req-1", { output: 1_000_000 }), // test-model, priced below
      assistantRecord("req-2", { output: 1_000_000 }, {
        message: {
          model: "unpriced-model",
          content: [],
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 1_000_000,
          },
        },
      }),
    ]);
    const transcript = await readTranscript(file);

    await fs.mkdir(path.join(root, ".local-coder"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".local-coder", "rates.json"),
      JSON.stringify({ models: { "test-model": { inputPerMTok: 3 } } }),
      "utf8"
    );
    const rates = await loadRates(root);

    // Summing only the priced model would report $15 and label it the session
    // total, dropping the other model's cost without a word.
    expect(buildSessionReport(transcript, rates).breakdown.usd).toBeNull();
  });

  it("prices a saving at its own matched request's model", async () => {
    clock = 0;
    const root = tempRoot();
    const id = "77777777-7777-4777-8777-777777777777";
    const file = await writeTranscript(root, [
      assistantRecord("req-1", { write1h: 100 }, {
        message: {
          model: "test-model",
          content: [{ type: "tool_use", id: "tu-1", name: "mcp__local-coder__gate" }],
          usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 },
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "res-1",
        sessionId: "sess-1",
        timestamp: new Date(1_700_000_000_500).toISOString(),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
        toolUseResult: { content: [{ type: "text", text: JSON.stringify({ invocation_id: id }) }] },
      }),
      // The request that would have cached the result runs on an UNPRICED model.
      assistantRecord("req-2", { write1h: 100, read: 1000 }, {
        message: {
          model: "unpriced-model",
          content: [],
          usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 0 },
        },
      }),
    ]);
    const transcript = await readTranscript(file);

    await fs.mkdir(path.join(root, ".local-coder"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".local-coder", "rates.json"),
      JSON.stringify({ models: { "test-model": { inputPerMTok: 3 } } }),
      "utf8"
    );
    const rates = await loadRates(root);

    const result = buildCounterfactual(
      transcript,
      [
        {
          ts: new Date(1_700_000_000_500).toISOString(),
          invocation_id: id,
          tool: "gate",
          bytes_raw: 7400,
          bytes_returned: 3700,
          turns_collapsed: 0,
          latency_ms: 1,
        },
      ],
      rates,
      buildSessionReport(transcript, rates)
    );

    // Reaching for the first priced model in the session would have invented a
    // dollar figure for a saving that fed an unpriced one.
    expect(result.byTool[0]?.unitsTotal).toBeGreaterThan(0);
    expect(result.byTool[0]?.usd).toBeNull();
    expect(result.usdTotal).toBeNull();
  });

  it("computes the positional multiplier from the segment length", () => {
    // The headline number: a token entering at turn 0 of a 41-request segment.
    expect(positionalMultiplier(0, 41, DEFAULT_MULTIPLIERS, "1h")).toBeCloseTo(6.0, 6);
    // The last request in a segment pays only the write.
    expect(positionalMultiplier(40, 41, DEFAULT_MULTIPLIERS, "1h")).toBeCloseTo(2.0, 6);
    expect(positionalMultiplier(0, 41, DEFAULT_MULTIPLIERS, "5m")).toBeCloseTo(5.25, 6);
  });

  it("reports USD only when a model price is configured", async () => {
    clock = 0;
    const root = tempRoot();
    const file = await writeTranscript(root, [assistantRecord("req-1", { output: 1_000_000 })]);
    const transcript = await readTranscript(file);

    expect(buildSessionReport(transcript, DEFAULT_RATES).breakdown.usd).toBeNull();

    await fs.mkdir(path.join(root, ".local-coder"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".local-coder", "rates.json"),
      JSON.stringify({ models: { "test-model": { inputPerMTok: 3 } } }),
      "utf8"
    );
    const rates = await loadRates(root);
    // 1M output tokens x 5.0 = 5M input-equivalent x $3/Mtok = $15.
    expect(buildSessionReport(transcript, rates).breakdown.usd).toBeCloseTo(15, 6);
  });

  it("falls back to defaults for a malformed rates file", async () => {
    const root = tempRoot();
    await fs.mkdir(path.join(root, ".local-coder"), { recursive: true });
    await fs.writeFile(path.join(root, ".local-coder", "rates.json"), "{not json", "utf8");
    await expect(loadRates(root)).resolves.toEqual(DEFAULT_RATES);
  });
});

describe("session report", () => {
  it("splits the bill into shares that sum to one", async () => {
    clock = 0;
    const root = tempRoot();
    const file = await writeTranscript(root, [
      assistantRecord("req-1", { write1h: 1000, read: 0, output: 100 }),
      assistantRecord("req-2", { write1h: 500, read: 1000, output: 100 }),
    ]);

    const report = buildSessionReport(await readTranscript(file), DEFAULT_RATES);
    const { share } = report.breakdown;
    expect(share.input + share.cacheWrite + share.cacheRead + share.output).toBeCloseTo(1, 10);
    expect(report.breakdown.units.cacheWrite).toBe(1500 * 2.0);
    expect(report.growth).toHaveLength(2);
    expect(report.growth[1]?.cacheRead).toBe(1000);
  });

  it("tallies tool result bytes per tool name", async () => {
    clock = 0;
    const root = tempRoot();
    const file = await writeTranscript(root, [
      JSON.stringify({
        type: "assistant",
        requestId: "req-1",
        sessionId: "s",
        uuid: "u1",
        timestamp: new Date(1_700_000_000_000).toISOString(),
        message: {
          model: "test-model",
          content: [{ type: "tool_use", id: "tu-1", name: "Bash" }],
          usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 0 },
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "u2",
        parentUuid: "u1",
        sessionId: "s",
        timestamp: new Date(1_700_000_001_000).toISOString(),
        toolUseResult: { stdout: "x".repeat(500) },
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
      }),
    ]);

    const report = buildSessionReport(await readTranscript(file), DEFAULT_RATES);
    expect(report.toolResultBytes.byTool.Bash?.calls).toBe(1);
    expect(report.toolResultBytes.byTool.Bash?.bytes).toBeGreaterThan(500);
  });
});

describe("telemetry and the counterfactual", () => {
  it("round-trips records and never throws on an unwritable root", async () => {
    const root = tempRoot();
    const writer = createTelemetryWriter(root, () => new Date(1_700_000_000_000));
    await writer.record({ tool: "gate", bytes_raw: 100, bytes_returned: 10, turns_collapsed: 0, latency_ms: 5 });

    const entries = await readTelemetry(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tool).toBe("gate");
    expect(entries[0]?.ts).toBe(new Date(1_700_000_000_000).toISOString());

    // A path that cannot be created must degrade to a warning, not an error.
    const blocked = createTelemetryWriter(path.join(root, "file.txt", "nested"));
    await fs.writeFile(path.join(root, "file.txt"), "x", "utf8");
    await expect(
      blocked.record({ tool: "gate", bytes_raw: 1, bytes_returned: 1, turns_collapsed: 0, latency_ms: 1 })
    ).resolves.toBeUndefined();
  });

  it("skips a partially written last line", async () => {
    const root = tempRoot();
    await fs.mkdir(path.join(root, ".local-coder"), { recursive: true });
    await fs.writeFile(
      path.join(root, TELEMETRY_REL_PATH),
      `{"ts":"2024-01-01T00:00:00.000Z","tool":"gate","bytes_raw":1,"bytes_returned":1,"turns_collapsed":0,"latency_ms":1}\n{"ts":"2024`,
      "utf8"
    );
    await expect(readTelemetry(root)).resolves.toHaveLength(1);
  });

  it("joins telemetry by invocation id and drops another session's rows", async () => {
    clock = 0;
    const root = tempRoot();
    const mine = "11111111-1111-4111-8111-111111111111";

    const file = await writeTranscript(root, [
      assistantRecord("req-1", { write1h: 100 }, {
        message: {
          model: "test-model",
          content: [{ type: "tool_use", id: "tu-1", name: "mcp__local-coder__gate" }],
          usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 },
        },
      }), // t = 0
      JSON.stringify({
        type: "user",
        uuid: "res-1",
        parentUuid: null,
        sessionId: "sess-1",
        timestamp: new Date(1_700_000_000_500).toISOString(),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
        toolUseResult: {
          content: [{ type: "text", text: JSON.stringify({ passed: false, invocation_id: mine }) }],
        },
      }),
      assistantRecord("req-2", { write1h: 100, read: 1000 }), // t = 1000
    ]);

    const transcript = await readTranscript(file);
    const session = buildSessionReport(transcript, DEFAULT_RATES);
    const at500 = new Date(1_700_000_000_500).toISOString();

    const result = buildCounterfactual(
      transcript,
      [
        { ts: at500, invocation_id: mine, tool: "gate", bytes_raw: 7400, bytes_returned: 3700, turns_collapsed: 0, latency_ms: 1 },
        // Same project, overlapping in time, different session. A timestamp
        // window cannot tell these apart and would count both.
        { ts: at500, invocation_id: "22222222-2222-4222-8222-222222222222", tool: "gate", bytes_raw: 999_999, bytes_returned: 0, turns_collapsed: 9, latency_ms: 1 },
      ],
      DEFAULT_RATES,
      session
    );

    expect(result.excludedForeign).toBe(1);
    expect(result.unverifiable).toBe(0);
    expect(result.byTool[0]?.calls).toBe(1);
    expect(result.byTool[0]?.turnsCollapsed).toBe(0);
    expect(result.byTool[0]?.bytesSuppressed).toBe(3700);
  });

  it("keeps the time window on every row the id join cannot vouch for", async () => {
    clock = 0;
    const root = tempRoot();
    const mine = "44444444-4444-4444-8444-444444444444";
    const file = await writeTranscript(root, [
      assistantRecord("req-1", { write1h: 100 }, {
        message: {
          model: "test-model",
          content: [{ type: "tool_use", id: "tu-1", name: "mcp__local-coder__repair" }],
          usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 },
        },
      }), // t = 0
      JSON.stringify({
        type: "user",
        uuid: "res-1",
        sessionId: "sess-1",
        timestamp: new Date(1_700_000_000_500).toISOString(),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
        toolUseResult: { content: [{ type: "text", text: JSON.stringify({ invocation_id: mine }) }] },
      }),
      assistantRecord("req-2", { write1h: 100, read: 1000 }), // t = 1000
    ]);
    const transcript = await readTranscript(file);

    const scoped = scopeTelemetry(transcript, [
      // Ours: admitted even though it lands well after the last request, because
      // the transcript recorded this id. A slow repair must not be dropped.
      { ts: new Date(1_700_000_600_000).toISOString(), invocation_id: mine, tool: "repair", bytes_raw: 10, bytes_returned: 1, turns_collapsed: 1, latency_ms: 1 },
      // A row from some other session, far outside the window (years earlier on
      // this fixture's clock — any gap over a minute would do). Letting
      // id-bearing rows skip the window admitted the whole telemetry history
      // whenever the exact join was unavailable, inflating savedFraction and
      // with it G-stop.
      { ts: new Date(1_600_000_000_000).toISOString(), invocation_id: "55555555-5555-4555-8555-555555555555", tool: "gate", bytes_raw: 9_999_999, bytes_returned: 0, turns_collapsed: 99, latency_ms: 1 },
    ]);

    expect(scoped.map((e) => e.invocation_id)).toEqual([mine]);
  });

  it("does not trust an invocation id quoted by some other tool's result", async () => {
    clock = 0;
    const root = tempRoot();
    const foreign = "66666666-6666-4666-8666-666666666666";
    const file = await writeTranscript(root, [
      assistantRecord("req-1", { write1h: 100 }, {
        message: {
          model: "test-model",
          content: [{ type: "tool_use", id: "tu-1", name: "Read" }],
          usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 },
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "res-1",
        sessionId: "sess-1",
        timestamp: new Date(1_700_000_000_500).toISOString(),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
        // Somebody read .local-coder/telemetry.jsonl. Every line of that file
        // carries an invocation_id and none of them are this session's.
        toolUseResult: {
          content: [{ type: "text", text: `{"tool":"gate","invocation_id":"${foreign}"}` }],
        },
      }),
      assistantRecord("req-2", { write1h: 100 }),
    ]);
    const transcript = await readTranscript(file);

    const scoped = scopeTelemetry(transcript, [
      {
        ts: new Date(1_600_000_000_000).toISOString(),
        invocation_id: foreign,
        tool: "gate",
        bytes_raw: 9_999_999,
        bytes_returned: 0,
        turns_collapsed: 99,
        latency_ms: 1,
      },
    ]);

    // Quoting an id is not producing one; the row stays subject to the window.
    expect(scoped).toHaveLength(0);
  });

  it("degrades loudly when gate ran but no result carried an invocation id", async () => {
    clock = 0;
    const root = tempRoot();
    const file = await writeTranscript(root, [
      assistantRecord("req-1", { write1h: 100 }, {
        message: {
          model: "test-model",
          content: [{ type: "tool_use", id: "tu-1", name: "mcp__local-coder__gate" }],
          usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 },
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "res-1",
        sessionId: "sess-1",
        timestamp: new Date(1_700_000_000_500).toISOString(),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
        // The client stored the result WITHOUT our echoed id — the assumption
        // the exact join rests on, and it has never been observed to hold.
        toolUseResult: { content: [{ type: "text", text: '{"passed":false}' }] },
      }),
      assistantRecord("req-2", { write1h: 100, read: 1000 }),
    ]);

    const transcript = await readTranscript(file);
    const session = buildSessionReport(transcript, DEFAULT_RATES);
    const result = buildCounterfactual(
      transcript,
      [
        {
          ts: new Date(1_700_000_000_500).toISOString(),
          invocation_id: "11111111-1111-4111-8111-111111111111",
          tool: "gate",
          bytes_raw: 7400,
          bytes_returned: 3700,
          turns_collapsed: 0,
          latency_ms: 1,
        },
      ],
      DEFAULT_RATES,
      session
    );

    // Excluding the row would report a confident 0% saving — the exact failure
    // this meter exists to prevent. Fall back to timestamps and say so.
    expect(result.provenanceUnavailable).toBe(true);
    expect(result.excludedForeign).toBe(0);
    // The row HAS an id — it is the transcript that carries none — so this is a
    // broken echo, not an unverifiable row, and it still counts.
    expect(result.unverifiable).toBe(0);
    expect(result.byTool[0]?.bytesSuppressed).toBe(3700);
  });

  it("prices a subagent's tool call against the subagent's own thread", async () => {
    clock = 0;
    const root = tempRoot();
    const id = "33333333-3333-4333-8333-333333333333";
    const at = (ms: number): string => new Date(1_700_000_000_000 + ms).toISOString();
    const sub = (reqId: string, uuid: string, parent: string | null, ms: number, read: number): string =>
      JSON.stringify({
        type: "assistant",
        requestId: reqId,
        sessionId: "sess-1",
        uuid,
        parentUuid: parent,
        isSidechain: true,
        timestamp: at(ms),
        message: {
          model: "test-model",
          content: [],
          usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: read, output_tokens: 0 },
        },
      });

    const file = await writeTranscript(root, [
      assistantRecord("req-main-1", { write1h: 100, read: 50_000 }), // t = 0, main
      // The subagent is the one that calls the tool, so the tool_use naming it
      // lives on the sidechain record.
      JSON.stringify({
        type: "assistant",
        requestId: "req-sub-1",
        sessionId: "sess-1",
        uuid: "s1",
        parentUuid: null,
        isSidechain: true,
        timestamp: at(500),
        message: {
          model: "test-model",
          content: [{ type: "tool_use", id: "tu-x", name: "mcp__local-coder__gate" }],
          usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 0 },
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "res-1",
        parentUuid: "s1",
        sessionId: "sess-1",
        isSidechain: true,
        timestamp: at(600),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-x" }] },
        toolUseResult: { content: [{ type: "text", text: JSON.stringify({ invocation_id: id }) }] },
      }),
      sub("req-sub-2", "s2", "s1", 900, 400),
    ]);

    const transcript = await readTranscript(file);
    const session = buildSessionReport(transcript, DEFAULT_RATES);
    const result = buildCounterfactual(
      transcript,
      [{ ts: at(600), invocation_id: id, tool: "gate", bytes_raw: 0, bytes_returned: 0, turns_collapsed: 1, latency_ms: 1 }],
      DEFAULT_RATES,
      session
    );

    // Skipping sidechains left this unmatched, discarding the saving entirely.
    // It now matches the subagent's next request and uses ITS cache read (400),
    // not the main thread's 50,000.
    expect(result.byTool[0]?.unmatched).toBe(0);
    expect(result.byTool[0]?.unitsFromTurnCollapse).toBeCloseTo(400 * 0.1, 6);
  });

  it("values suppressed bytes with the multiplier of the request that would have cached them", async () => {
    clock = 0;
    const root = tempRoot();
    // Two requests: the tool runs before the second, which has 1 re-read left.
    const gid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const file = await writeTranscript(root, [
      assistantRecord("req-1", { write1h: 100 }, {
        message: {
          model: "test-model",
          content: [{ type: "tool_use", id: "tu-1", name: "mcp__local-coder__gate" }],
          usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 },
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "res-1",
        sessionId: "sess-1",
        timestamp: new Date(1_700_000_000_500).toISOString(),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
        toolUseResult: { content: [{ type: "text", text: JSON.stringify({ invocation_id: gid }) }] },
      }),
      assistantRecord("req-2", { write1h: 100, read: 1000 }),
    ]);
    const transcript = await readTranscript(file);
    const session = buildSessionReport(transcript, DEFAULT_RATES);

    const result = buildCounterfactual(
      transcript,
      [
        {
          ts: new Date(1_700_000_000_500).toISOString(),
          invocation_id: gid,
          tool: "gate",
          bytes_raw: 3700 + 3700,
          bytes_returned: 3700,
          turns_collapsed: 0,
          latency_ms: 1,
        },
      ],
      DEFAULT_RATES,
      session
    );

    // 3700 bytes suppressed / 3.7 chars-per-token = 1000 tokens, entering at
    // index 1 of a 2-request segment => multiplier 2.0 + 0.1*0 = 2.0.
    const gate = result.byTool[0];
    expect(gate?.tool).toBe("gate");
    expect(gate?.unmatched).toBe(0);
    expect(gate?.unitsFromSuppression).toBeCloseTo(2000, 6);
    expect(gate?.unitsFromTurnCollapse).toBe(0);
  });

  it("values a collapsed turn as the context re-read it avoided", async () => {
    clock = 0;
    const root = tempRoot();
    const rid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const file = await writeTranscript(root, [
      assistantRecord("req-1", { write1h: 100, read: 50_000 }, {
        message: {
          model: "test-model",
          content: [{ type: "tool_use", id: "tu-r", name: "mcp__local-coder__repair" }],
          usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 50_000, output_tokens: 0 },
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "res-r",
        sessionId: "sess-1",
        timestamp: new Date(1_699_999_999_990).toISOString(),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-r" }] },
        toolUseResult: { content: [{ type: "text", text: JSON.stringify({ invocation_id: rid }) }] },
      }),
    ]);
    const transcript = await readTranscript(file);
    const session = buildSessionReport(transcript, DEFAULT_RATES);

    const result = buildCounterfactual(
      transcript,
      [
        {
          ts: new Date(1_699_999_999_990).toISOString(),
          invocation_id: rid,
          tool: "repair",
          bytes_raw: 0,
          bytes_returned: 0,
          turns_collapsed: 3,
          latency_ms: 1,
        },
      ],
      DEFAULT_RATES,
      session
    );

    // 3 turns x 50,000 cached tokens x 0.1 = 15,000 units, and it is a floor.
    expect(result.byTool[0]?.unitsFromTurnCollapse).toBeCloseTo(15_000, 6);
    expect(result.savedFraction).toBeGreaterThan(0);
    expect(result.savedFraction).toBeLessThan(1);
  });

  it("counts telemetry with no later request as unmatched rather than free saving", async () => {
    clock = 0;
    const root = tempRoot();
    const lid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const file = await writeTranscript(root, [
      assistantRecord("req-1", { write1h: 100 }, {
        message: {
          model: "test-model",
          content: [{ type: "tool_use", id: "tu-l", name: "mcp__local-coder__gate" }],
          usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 },
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "res-l",
        sessionId: "sess-1",
        // After the last billed request: nothing left to re-read the result.
        timestamp: new Date(1_700_000_060_000).toISOString(),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-l" }] },
        toolUseResult: { content: [{ type: "text", text: JSON.stringify({ invocation_id: lid }) }] },
      }),
    ]);
    const transcript = await readTranscript(file);
    const session = buildSessionReport(transcript, DEFAULT_RATES);

    const result = buildCounterfactual(
      transcript,
      [
        {
          ts: new Date(1_700_000_060_000).toISOString(),
          invocation_id: lid,
          tool: "gate",
          bytes_raw: 10_000,
          bytes_returned: 0,
          turns_collapsed: 0,
          latency_ms: 1,
        },
      ],
      DEFAULT_RATES,
      session
    );

    expect(result.byTool[0]?.unmatched).toBe(1);
    expect(result.unitsTotal).toBe(0);
  });

  it("does not count a saving whose row cannot point at a transcript entry", async () => {
    clock = 0;
    const root = tempRoot();
    const file = await writeTranscript(root, [
      assistantRecord("req-1", { write1h: 100 }),
      assistantRecord("req-2", { write1h: 100, read: 1000 }),
    ]);
    const transcript = await readTranscript(file);
    const session = buildSessionReport(transcript, DEFAULT_RATES);

    const result = buildCounterfactual(
      transcript,
      [
        // Shaped exactly like the row the dead PostToolUse hook wrote: a real
        // measurement of bytes it condensed, for a replacement Claude Code threw
        // away. It has no invocation id because it has no tool result of its own.
        {
          ts: new Date(1_700_000_000_500).toISOString(),
          tool: "hook:Bash",
          bytes_raw: 30_136,
          bytes_returned: 8_462,
          turns_collapsed: 0,
          latency_ms: 1,
        },
      ],
      DEFAULT_RATES,
      session
    );

    expect(result.unverifiable).toBe(1);
    expect(result.byTool).toEqual([]);
    expect(result.unitsTotal).toBe(0);
    expect(result.savedFraction).toBe(0);
    // Withheld, not hidden: the magnitude is reported so the exclusion is visible.
    expect(result.unverifiableUnits).toBeGreaterThan(0);
  });
});

/**
 * Against the REAL compiled CLI, because the last three defects all lived at a
 * boundary the unit tests did not cross. `buildCounterfactual` returned the
 * withheld row correctly the whole time; the report simply never printed it.
 */
describe("the cost-meter CLI", () => {
  const execFileAsync = promisify(execFile);

  it("shows withheld rows even when nothing at all was counted", async () => {
    clock = 0;
    const root = tempRoot();
    const transcripts = tempRoot();
    await fs.writeFile(
      path.join(transcripts, "session.jsonl"),
      `${[
        assistantRecord("req-1", { write1h: 100 }),
        assistantRecord("req-2", { write1h: 100, read: 1000 }),
      ].join("\n")}\n`,
      "utf8"
    );

    await fs.mkdir(path.join(root, ".local-coder"), { recursive: true });
    await fs.writeFile(
      path.join(root, TELEMETRY_REL_PATH),
      // Exactly the shape the dead hook wrote: no invocation id, so unverifiable.
      `${JSON.stringify({
        ts: new Date(1_700_000_000_500).toISOString(),
        tool: "hook:Bash",
        bytes_raw: 30_136,
        bytes_returned: 8_462,
        turns_collapsed: 0,
        latency_ms: 1,
      })}\n`,
      "utf8"
    );

    const cli = path.join(import.meta.dirname, "..", "dist", "cost", "cli.js");
    const { stdout } = await execFileAsync(process.execPath, [
      cli,
      "--dir",
      transcripts,
      "--root",
      root,
    ]);

    // It is the only telemetry in range, so gating the section on counted
    // savings made the exclusion invisible — a report claiming to surface
    // exclusions omitting the only one it had.
    expect(stdout).toContain("estimated savings from local tools");
    expect(stdout).toContain("nothing counted");
    expect(stdout).toContain("NOT counted");
    expect(stdout).toContain("units withheld");
  }, 30_000);

  it("says the log is empty rather than claiming rows were withheld", async () => {
    clock = 0;
    const root = tempRoot();
    const transcripts = tempRoot();
    // A session that DID call gate, whose result carries no invocation id, so
    // `provenanceUnavailable` is true — while the telemetry log does not exist.
    await fs.writeFile(
      path.join(transcripts, "session.jsonl"),
      `${[
        assistantRecord("req-1", { write1h: 100 }, {
          message: {
            model: "test-model",
            content: [{ type: "tool_use", id: "tu-1", name: "mcp__local-coder__gate" }],
            usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 },
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "res-1",
          sessionId: "sess-1",
          timestamp: new Date(1_700_000_000_500).toISOString(),
          message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
          toolUseResult: { content: [{ type: "text", text: JSON.stringify({ passed: true }) }] },
        }),
      ].join("\n")}\n`,
      "utf8"
    );

    const cli = path.join(import.meta.dirname, "..", "dist", "cost", "cli.js");
    const { stdout } = await execFileAsync(process.execPath, [
      cli,
      "--dir",
      transcripts,
      "--root",
      root,
    ]);

    // Folding provenanceUnavailable into the "is there anything to report"
    // predicate made a session with ZERO rows announce that every row had been
    // withheld, and swallowed this message.
    expect(stdout).toContain("savings appear once the local tools run");
    expect(stdout).not.toContain("every telemetry row in range was withheld");
    // The broken-echo warning still has to survive an empty log.
    expect(stdout).toContain("no result carried an invocation id");
  }, 30_000);

  it("distinguishes rows that exist but fall outside this session from no rows at all", async () => {
    clock = 0;
    const root = tempRoot();
    const transcripts = tempRoot();
    await fs.writeFile(
      path.join(transcripts, "session.jsonl"),
      `${[
        assistantRecord("req-1", { write1h: 100 }),
        assistantRecord("req-2", { write1h: 100, read: 1000 }),
      ].join("\n")}\n`,
      "utf8"
    );

    await fs.mkdir(path.join(root, ".local-coder"), { recursive: true });
    await fs.writeFile(
      path.join(root, TELEMETRY_REL_PATH),
      // No invocation id and far outside the ±60s window, so nothing admits it.
      `${JSON.stringify({
        ts: new Date(1_600_000_000_000).toISOString(),
        tool: "gate",
        bytes_raw: 10_000,
        bytes_returned: 100,
        turns_collapsed: 2,
        latency_ms: 1,
      })}\n`,
      "utf8"
    );

    const cli = path.join(import.meta.dirname, "..", "dist", "cost", "cli.js");
    const { stdout } = await execFileAsync(process.execPath, [
      cli,
      "--dir",
      transcripts,
      "--root",
      root,
    ]);

    expect(stdout).toContain("1 telemetry row(s) on disk, none in this session's range");
    // Neither of the other two stories: rows do exist, and none was withheld
    // by the provenance rule — they simply are not this session's.
    expect(stdout).not.toContain("savings appear once the local tools run");
    expect(stdout).not.toContain("every telemetry row in range was withheld");
  }, 30_000);
});

describe("against a real transcript, when one is present", () => {
  it("reproduces the dedup invariant on this machine's own sessions", async () => {
    const dir = projectTranscriptDir(process.cwd(), os.homedir());
    const files = await listTranscripts(dir);
    if (files.length === 0) return; // CI and fresh checkouts have none.

    const file = files[files.length - 1];
    expect(file).toBeDefined();
    const transcript = await readTranscript(file as string);

    const ids = new Set(transcript.requests.map((r) => r.requestId));
    expect(ids.size).toBe(transcript.requests.length);
    for (const request of transcript.requests) {
      expect(request.index).toBeLessThan(request.segmentSize);
      expect(request.usage.cacheRead).toBeGreaterThanOrEqual(0);
    }
  });
});

/**
 * Fast mode reports the SAME model string while billing at twice the rate.
 * Pricing on the model alone therefore halves a fast-mode session's total —
 * and a halved total reads as "the meter is broken", which is how a pricing
 * bug gets mistaken for the instrument failing.
 */
describe("speed is part of the price", () => {
  async function reportWith(
    speed: string | undefined,
    models: Record<string, { inputPerMTok: number }>
  ): Promise<number | null> {
    clock = 0;
    const root = tempRoot();
    const usage: Record<string, unknown> = {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1_000_000,
    };
    if (speed !== undefined) usage.speed = speed;
    const file = await writeTranscript(root, [
      assistantRecord("req-1", {}, { message: { model: "test-model", content: [], usage } }),
    ]);
    const transcript = await readTranscript(file);

    await fs.mkdir(path.join(root, ".local-coder"), { recursive: true });
    await fs.writeFile(path.join(root, ".local-coder", "rates.json"), JSON.stringify({ models }), "utf8");
    return buildSessionReport(transcript, await loadRates(root)).breakdown.usd;
  }

  // 1M output tokens x the 5.0 output multiplier = 5M input-equivalent units.
  it("charges fast mode at the fast rate, not the standard one", async () => {
    const usd = await reportWith("fast", {
      "test-model": { inputPerMTok: 3 },
      "test-model@fast": { inputPerMTok: 6 },
    });
    expect(usd).toBeCloseTo(30, 6); // 5M units x $6/MTok — NOT the $15 the standard key gives
  });

  it("leaves a session unpriced when its speed has no price, rather than halving it", async () => {
    const usd = await reportWith("fast", { "test-model": { inputPerMTok: 3 } });
    expect(usd).toBeNull();
  });

  it("still prices transcripts written before Claude Code reported a speed", async () => {
    const usd = await reportWith(undefined, { "test-model": { inputPerMTok: 3 } });
    expect(usd).toBeCloseTo(15, 6);
  });

  it("treats an explicit standard speed as the bare model key", async () => {
    const usd = await reportWith("standard", { "test-model": { inputPerMTok: 3 } });
    expect(usd).toBeCloseTo(15, 6);
  });

  // Multipliers layer across the speed suffix; the price deliberately does not.
  // Dropping a user's override because the request happened to run fast would
  // silently change their cost model — the regression this pair pins down.
  it("keeps a model's multiplier override when the request ran fast", () => {
    const rates = {
      ...DEFAULT_RATES,
      models: {
        "test-model": { inputPerMTok: 3, multipliers: { ...DEFAULT_MULTIPLIERS, output: 9 } },
        "test-model@fast": { inputPerMTok: 6 },
      },
    };
    expect(multipliersFor(rates, "test-model@fast").output).toBe(9);
    expect(multipliersFor(rates, "test-model@fast").cacheRead).toBe(DEFAULT_MULTIPLIERS.cacheRead);
  });

  it("lets a speed variant's own override win over the base model's", () => {
    const rates = {
      ...DEFAULT_RATES,
      models: {
        "test-model": { inputPerMTok: 3, multipliers: { ...DEFAULT_MULTIPLIERS, output: 9 } },
        "test-model@fast": { inputPerMTok: 6, multipliers: { ...DEFAULT_MULTIPLIERS, output: 11 } },
      },
    };
    expect(multipliersFor(rates, "test-model@fast").output).toBe(11);
  });

  it("does not fall back to the base model's price for an unpriced speed", () => {
    const rates = { ...DEFAULT_RATES, models: { "test-model": { inputPerMTok: 3 } } };
    expect(inputPriceFor(rates, "test-model@fast")).toBeNull();
    expect(inputPriceFor(rates, "test-model")).toBe(3);
  });

  // "USD not shown — set models['test-model'].inputPerMTok" is worse than no
  // hint at all when that line is already filled in and the speed key is what
  // is missing. The report has to say which key, not which model.
  it("names the unpriced KEY, not the model, so the hint is actionable", async () => {
    clock = 0;
    const root = tempRoot();
    const file = await writeTranscript(root, [
      assistantRecord("req-1", {}, {
        message: {
          model: "test-model",
          content: [],
          usage: { output_tokens: 1_000_000, speed: "fast" },
        },
      }),
    ]);
    const transcript = await readTranscript(file);
    await fs.mkdir(path.join(root, ".local-coder"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".local-coder", "rates.json"),
      JSON.stringify({ models: { "test-model": { inputPerMTok: 3 } } }),
      "utf8"
    );

    const breakdown = buildSessionReport(transcript, await loadRates(root)).breakdown;
    expect(breakdown.usd).toBeNull();
    expect(breakdown.unpricedKeys).toEqual(["test-model@fast"]);
  });

  it("reports no unpriced keys when everything is priced", async () => {
    const usd = await reportWith(undefined, { "test-model": { inputPerMTok: 3 } });
    expect(usd).not.toBeNull();
  });

  // /model and /fast are both togglable mid-segment. Applying turn 0's rate
  // across the whole span prices every re-read after the switch wrongly, and
  // the headline is the one number carrying the architecture's argument.
  describe("entryCostOfSegment", () => {
    const rates = {
      ...DEFAULT_RATES,
      models: {
        "m": { inputPerMTok: 1, multipliers: { ...DEFAULT_MULTIPLIERS, cacheRead: 0.1 } },
        "m@fast": { inputPerMTok: 2, multipliers: { ...DEFAULT_MULTIPLIERS, cacheRead: 0.5 } },
      },
    };
    const req = (index: number, speed: string | null): BilledRequest =>
      ({
        requestId: `r${index}`,
        sessionId: "s",
        model: "m",
        speed,
        isSidechain: false,
        timestampMs: index,
        thread: "main",
        segment: 0,
        index,
        segmentSize: 4,
        usage: { ...zero, cacheWrite1h: 10 },
        toolUses: [],
      }) as BilledRequest;
    const zero = { input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0 };

    it("sums each later request's own cache-read rate", () => {
      // turn 0 standard, then two fast turns: 2.0 write + 0.5 + 0.5.
      const cost = entryCostOfSegment([req(0, "standard"), req(1, "fast"), req(2, "fast")], rates);
      expect(cost?.multiplier).toBeCloseTo(3.0, 6);
      expect(cost?.keys).toEqual(["m", "m@fast"]);
    });

    it("agrees with positionalMultiplier when the segment is uniform", () => {
      const cost = entryCostOfSegment([req(0, "standard"), req(1, "standard"), req(2, "standard")], rates);
      const flat = positionalMultiplier(0, 3, multipliersFor(rates, "m"), "1h");
      expect(cost?.multiplier).toBeCloseTo(flat, 6);
    });

    it("takes the write from turn 0, not from whichever request came first in the array", () => {
      const cost = entryCostOfSegment([req(2, "fast"), req(0, "standard"), req(1, "fast")], rates);
      expect(cost?.write).toBe(DEFAULT_MULTIPLIERS.cacheWrite1h); // turn 0 is standard
      expect(cost?.multiplier).toBeCloseTo(3.0, 6);
    });

    it("returns null for an empty segment", () => {
      expect(entryCostOfSegment([], rates)).toBeNull();
    });
  });
});
