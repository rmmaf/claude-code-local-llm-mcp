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
  invocationOwners,
  lineagesOf,
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
import { listTranscripts, projectTranscriptDir, readTranscript, sessionFiles } from "../src/cost/transcript.js";
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

  it("reads a session as the union of its files, not just the main transcript", async () => {
    // The defect that reopened G1. `listTranscripts` did a non-recursive readdir,
    // so `<sessionId>/subagents/**` was invisible and a multi-agent session
    // reported roughly half its cache tokens while printing "0 subagent" -- a gap
    // that reads as a measurement.
    clock = 0;
    const dir = tempRoot();
    const sid = "sess-1";
    await fs.writeFile(path.join(dir, `${sid}.jsonl`), `${assistantRecord("req-main", { write1h: 100 })}\n`, "utf8");
    const nested = path.join(dir, sid, "subagents", "workflows", "wf_1");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(
      path.join(nested, "agent-x.jsonl"),
      `${assistantRecord("req-sub", { write1h: 700, read: 5000 }, { isSidechain: true })}\n`,
      "utf8"
    );

    const transcript = await readTranscript(await sessionFiles(dir, sid));
    expect(transcript.files).toHaveLength(2);
    expect(transcript.requests).toHaveLength(2);
    expect(transcript.requests.reduce((n, r) => n + r.usage.cacheRead, 0)).toBe(5000);
  });

  it("admits a usage-bearing record whose grouping or dedup key is missing", async () => {
    // `requestId` is a grouping key and `uuid` is a dedup key. B20's admission
    // rule lists neither as a condition, and each implementation had quietly
    // turned the key IT needed into one: the meter dropped records with no
    // requestId, the oracle dropped records with no uuid. Opposite directions,
    // both silent, so on a corpus where every record carries both — this one,
    // 5,669 of 5,669 — the two sides agreed by accident.
    clock = 0;
    const root = tempRoot();
    const bare = (extra: Record<string, unknown>, output: number): string => {
      const r: Record<string, unknown> = {
        type: "assistant",
        sessionId: "sess-1",
        timestamp: new Date(1_700_000_000_000).toISOString(),
        message: { model: "test-model", content: [], usage: { output_tokens: output } },
        ...extra,
      };
      return JSON.stringify(r);
    };
    const file = await writeTranscript(root, [
      bare({ uuid: "u1", requestId: "req-1" }, 100),
      bare({ uuid: "u2" }, 777), // no requestId: its own group of one
      bare({ requestId: "req-3" }, 555), // no uuid: admitted, but undedupable
    ]);

    const transcript = await readTranscript(file);
    expect(transcript.requests).toHaveLength(3);
    expect(transcript.requests.reduce((n, r) => n + r.usage.output, 0)).toBe(1432);
    // The undedupable one is counted AND reported: nothing can catch it if the
    // same record ever turns up in a second file.
    expect(transcript.admittedWithoutUuid).toBe(1);
  });

  it("never counts a REJECTED record as one it admitted", async () => {
    // The counter used to be incremented in the record-level pass, which knows
    // only "assistant plus usage" — half the admission predicate, missing the
    // api-error and session checks. So an api-error record with no uuid was
    // reported as admittedWithoutUuid: 1 AND excluded.apiError: 1. The same
    // record, counted both ways, in one payload: a reader would believe an
    // undedupable record had been billed when it had been thrown out.
    //
    // Two numbers computed from one rule drift apart the moment two places
    // compute them. The count now happens where admission happens.
    clock = 0;
    const root = tempRoot();
    const rejected = JSON.stringify({
      type: "assistant",
      sessionId: "sess-1",
      isApiErrorMessage: true,
      requestId: "req-2", // a real requestId, and no uuid
      timestamp: new Date(1_700_000_000_000).toISOString(),
      message: { model: "<synthetic>", content: [], usage: { output_tokens: 999 } },
    });
    const file = await writeTranscript(root, [assistantRecord("req-1", { output: 100 }), rejected]);

    const transcript = await readTranscript(file);
    expect(transcript.requests).toHaveLength(1);
    expect(transcript.excluded.apiError).toBe(1);
    expect(transcript.admittedWithoutUuid).toBe(0);
  });

  it("counts RECORDS, and neither that number nor the request count bounds the other", async () => {
    // BOTH DIRECTIONS, because prose about this field has now been wrong twice in
    // opposite ways. First an assertion that the counter can never exceed
    // `requests.length` -- false, and it passed only because that fixture's
    // counter is 0. Then a comment saying it "does exceed, whenever one group has
    // several such records" -- also false: that condition holds in case B below
    // and the counter is 2 against 4.
    //
    // A request is a `requestId` GROUP; this counter is over RECORDS, like every
    // `excluded.*` field beside it. Neither number bounds the other, so the two
    // are not comparable and this test says so in the only way that cannot rot.
    //
    // Counting per record is deliberate: the risk is that any ONE of them
    // reappears in a second file with nothing able to catch it, so a per-group
    // count can understate it -- equal when a group holds one such record, lower
    // when it holds several. The oracle agrees exactly and goes further --
    // `admittedWithoutUuid > 0` marks the session `suspect`, dropping it from
    // B20's scored set rather than comparing it. All eleven real sessions report
    // 0 on both sides, which is why no corpus run could have settled any of this.
    const noUuid = (rid: string, output: number): string =>
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-1",
        requestId: rid,
        timestamp: new Date(1_700_000_000_000).toISOString(),
        message: { model: "test-model", content: [], usage: { output_tokens: output } },
      });

    // A: one group of three uuid-less records. Counter 3, requests 1.
    clock = 0;
    const a = await readTranscript(
      await writeTranscript(tempRoot(), [noUuid("req-1", 10), noUuid("req-1", 20), noUuid("req-1", 30)])
    );
    expect(a.requests).toHaveLength(1);
    expect(a.admittedWithoutUuid).toBe(3);
    expect(a.admittedWithoutUuid).toBeGreaterThan(a.requests.length);
    // Still the LAST record of the group, unaffected by any of this.
    expect(a.requests[0]?.usage.output).toBe(30);

    // B: the same "one group with several such records", plus three groups that
    // carry uuids. Counter 2, requests 4 -- the condition holds and it does not
    // exceed, which is what refutes it as a sufficient one.
    clock = 0;
    const b = await readTranscript(
      await writeTranscript(tempRoot(), [
        noUuid("req-1", 10),
        noUuid("req-1", 20),
        assistantRecord("req-2", { output: 30 }),
        assistantRecord("req-3", { output: 40 }),
        assistantRecord("req-4", { output: 50 }),
      ])
    );
    expect(b.requests).toHaveLength(4);
    expect(b.admittedWithoutUuid).toBe(2);
    expect(b.admittedWithoutUuid).toBeLessThan(b.requests.length);
  });

  it("counts a record once when the same uuid appears in two files of one session", async () => {
    // RECORD identity across the union. Without it the union double-counts, and
    // the invariant `|uuids(main) U uuids(sub)| == |main| + |sub|` is what B20's
    // oracle checks on the other side.
    clock = 0;
    const dir = tempRoot();
    const sid = "sess-1";
    const shared = assistantRecord("req-1", { write1h: 100 });
    await fs.writeFile(path.join(dir, `${sid}.jsonl`), `${shared}\n`, "utf8");
    await fs.mkdir(path.join(dir, sid, "subagents"), { recursive: true });
    await fs.writeFile(path.join(dir, sid, "subagents", "agent-x.jsonl"), `${shared}\n`, "utf8");

    const transcript = await readTranscript(await sessionFiles(dir, sid));
    expect(transcript.requests).toHaveLength(1);
    expect(transcript.excluded.duplicateUuid).toBe(1);
  });

  it("never lets a rejected api-error record decide which session the files belong to", async () => {
    // An api-error record is type "assistant" with a real requestId, and a retry
    // writes one FIRST. When the anchor was "the first assistant record carrying
    // a sessionId", one of these at the head of a file — carrying a different
    // session — anchored the read to a session that owns nothing here, every
    // legitimate record was excluded as foreign, and the CLI printed NOTHING.
    // A record the admission rule refuses to count must not decide what counts.
    clock = 0;
    const root = tempRoot();
    const file = await writeTranscript(root, [
      assistantRecord("req-err", {}, { sessionId: "a-different-session", isApiErrorMessage: true }),
      assistantRecord("req-1", { write1h: 100 }),
      assistantRecord("req-2", { write1h: 200 }),
    ]);

    const transcript = await readTranscript(file);
    expect(transcript.sessionId).toBe("sess-1");
    expect(transcript.requests).toHaveLength(2);
    expect(transcript.requests.reduce((n, r) => n + r.usage.cacheWrite1h, 0)).toBe(300);
  });

  it("counts records out rather than losing them when an explicit session id matches nothing", async () => {
    // The other half: zero admitted is a fact that must be reportable, not an
    // absence. Every exclusion is counted so a caller can tell "this session had
    // no traffic" from "this read found none of it".
    clock = 0;
    const root = tempRoot();
    const file = await writeTranscript(root, [assistantRecord("req-1", { write1h: 100 })]);

    const transcript = await readTranscript(file, "some-other-session");
    expect(transcript.requests).toHaveLength(0);
    expect(transcript.excluded.foreignSession).toBe(1);
  });

  it("counts a tool result once when its record appears in two files, not just billed requests", async () => {
    // The admission rule was applied to the billed-request loop and not to the
    // one over tool results, which iterates the SAME records. On this project
    // that double-counted 3 records and 60,439 bytes. Applying the rule per
    // consumer is how consumers drift apart, so it is applied once, before both.
    clock = 0;
    const dir = tempRoot();
    const sid = "sess-1";
    const result = JSON.stringify({
      type: "user",
      uuid: "tool-result-1",
      sessionId: sid,
      timestamp: new Date(1_700_000_000_000).toISOString(),
      message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
      toolUseResult: { stdout: "x".repeat(1000), stderr: "", interrupted: false, isImage: false },
    });
    await fs.writeFile(
      path.join(dir, `${sid}.jsonl`),
      `${assistantRecord("req-1", { write1h: 100 })}\n${result}\n`,
      "utf8"
    );
    await fs.mkdir(path.join(dir, sid, "subagents"), { recursive: true });
    await fs.writeFile(path.join(dir, sid, "subagents", "agent-x.jsonl"), `${result}\n`, "utf8");

    const transcript = await readTranscript(await sessionFiles(dir, sid));
    expect(transcript.toolResults).toHaveLength(1);
    expect(transcript.excluded.duplicateUuid).toBe(1);
  });

  it("excludes a record that sits under the session directory but belongs to another session", async () => {
    // A file under a directory is not thereby a request OF that session. The
    // record says whose it is; believe the record, not the path.
    clock = 0;
    const dir = tempRoot();
    const sid = "sess-1";
    await fs.writeFile(path.join(dir, `${sid}.jsonl`), `${assistantRecord("req-1", { write1h: 100 })}\n`, "utf8");
    await fs.mkdir(path.join(dir, sid, "tool-results"), { recursive: true });
    await fs.writeFile(
      path.join(dir, sid, "tool-results", "other.jsonl"),
      `${assistantRecord("req-9", { write1h: 9999 }, { sessionId: "some-other-session" })}\n`,
      "utf8"
    );

    const transcript = await readTranscript(await sessionFiles(dir, sid));
    expect(transcript.requests).toHaveLength(1);
    expect(transcript.excluded.foreignSession).toBe(1);
    expect(transcript.requests[0]?.usage.cacheWrite1h).toBe(100);
  });

  it("excludes api-error records by their own fields, never by usage reading zero", async () => {
    clock = 0;
    const root = tempRoot();
    const file = await writeTranscript(root, [
      // A legitimate record whose usage is all zeros must still be admitted.
      assistantRecord("req-1", {}),
      assistantRecord("req-2", { output: 9 }, { isApiErrorMessage: true }),
      assistantRecord("req-3", { output: 9 }, { message: { model: "<synthetic>", content: [], usage: { output_tokens: 9 } } }),
    ]);

    const transcript = await readTranscript(file);
    expect(transcript.requests).toHaveLength(1);
    expect(transcript.excluded.apiError).toBe(2);
    expect(transcript.requests[0]?.usage.output).toBe(0);
  });

  it("takes the LAST record's usage in a requestId group, because the first one is partial", async () => {
    // The real shape: intermediate records carry a partial completion count and
    // the terminal record carries the whole answer. Over this project 327 of
    // 1,647 multi-record groups differ, and in 327 of 327 the first is smaller.
    // Keeping the first dropped 655,570 output tokens, 19.27% of all output, in
    // the class carrying the 5.0x multiplier.
    clock = 0;
    const root = tempRoot();
    const partial = (output: number, tool: string): string =>
      JSON.stringify({
        type: "assistant",
        requestId: "req-1",
        sessionId: "s",
        uuid: `u-${tool}-${output}`,
        timestamp: new Date(1_700_000_000_000 + output).toISOString(),
        message: {
          model: "test-model",
          content: [{ type: "tool_use", id: `tu-${output}`, name: tool }],
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 16_667,
            cache_read_input_tokens: 30_034,
            output_tokens: output,
            cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 16_667 },
          },
        },
      });
    const file = await writeTranscript(root, [partial(5, "Bash"), partial(5, "Read"), partial(695, "Edit")]);

    const transcript = await readTranscript(file);
    expect(transcript.requests).toHaveLength(1);
    const [request] = transcript.requests;
    expect(request?.usage.output).toBe(695);
    // The repeated fields are unchanged — usage repeats, it does not accumulate.
    expect(request?.usage.cacheRead).toBe(30_034);
    expect(request?.usage.cacheWrite5m).toBe(16_667);
    // Every tool_use block is still collected, from every record of the group.
    expect(request?.toolUses.map((t) => t.name)).toEqual(["Bash", "Read", "Edit"]);
  });

  it("places a request where it started even though its usage comes from the last record", async () => {
    // timestampMs, thread and segment stay with the FIRST record: a request is
    // placed in the conversation where it began, and only the counts move.
    clock = 0;
    const root = tempRoot();
    const at = (ms: number, output: number): string =>
      JSON.stringify({
        type: "assistant",
        requestId: "req-1",
        sessionId: "s",
        uuid: `u-${ms}`,
        timestamp: new Date(ms).toISOString(),
        message: {
          model: "test-model",
          content: [],
          usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: 0, output_tokens: output },
        },
      });
    const file = await writeTranscript(root, [at(1_700_000_000_000, 1), at(1_700_000_900_000, 900)]);

    const [request] = (await readTranscript(file)).requests;
    expect(request?.usage.output).toBe(900);
    expect(request?.timestampMs).toBe(1_700_000_000_000);
  });

  it("refuses a TTL split that disagrees with its own total, per the rule the comment always stated", async () => {
    // 15 records in this project carry exactly this: a top-level total of 0
    // against an ephemeral_1h between 2,452 and 4,911. The guard read
    // `splitTotal > 0`, so the split was used anyway and the meter booked 42,558
    // cacheWrite-1h tokens the top-level field calls zero — in the class carrying
    // the 2.0x multiplier, the most expensive of the five.
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
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
            cache_creation: { ephemeral_1h_input_tokens: 2452, ephemeral_5m_input_tokens: 0 },
          },
        },
      }),
    ]);

    const usage = (await readTranscript(file)).requests[0]?.usage;
    expect(usage?.cacheWrite1h).toBe(0);
    expect(usage?.cacheWrite5m).toBe(0);
  });

  it("keeps the two cache-write classes summing to the top-level total, split or not", async () => {
    // The property that makes this side agree with scripts/session-token-walk.mjs
    // by construction rather than by luck: whatever the split says, the classes
    // sum to cache_creation_input_tokens.
    const root = tempRoot();
    const usageFor = (total: number, h: number, m: number): string =>
      JSON.stringify({
        type: "assistant",
        requestId: `req-${total}-${h}-${m}`,
        sessionId: "s",
        uuid: `u-${total}-${h}-${m}`,
        timestamp: new Date(1_700_000_000_000).toISOString(),
        message: {
          model: "test-model",
          content: [],
          usage: {
            cache_creation_input_tokens: total,
            cache_read_input_tokens: 0,
            output_tokens: 0,
            cache_creation: { ephemeral_1h_input_tokens: h, ephemeral_5m_input_tokens: m },
          },
        },
      });
    const cases: Array<[number, number, number]> = [
      [1000, 1000, 0], // consistent, all 1h
      [1000, 400, 600], // consistent, split
      [0, 2452, 0], // split exceeds total — the real shape
      [900, 400, 100], // split below total — never seen here, still must balance
    ];
    const file = await writeTranscript(root, cases.map(([t, h, m]) => usageFor(t, h, m)));

    const transcript = await readTranscript(file);
    expect(transcript.requests).toHaveLength(4);
    for (const [i, [total]] of cases.entries()) {
      const u = transcript.requests[i]?.usage;
      expect(u!.cacheWrite1h + u!.cacheWrite5m).toBe(total);
    }
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

  // The slug comes from path.resolve, which is platform-dependent: a Windows
  // absolute path is a RELATIVE path on POSIX, so resolve prepends cwd and the
  // slug changes. Asserting one platform's literal made this fail on macOS.
  // Expectations are written out by hand rather than computed with the same
  // regex the implementation uses, which would only assert that a line equals
  // itself.
  it("mirrors Claude Code's project slug, dots included", () => {
    const [root, expected] =
      process.platform === "win32"
        ? ["C:\\Users\\me\\proj\\.claude\\wt", "C--Users-me-proj--claude-wt"]
        : ["/Users/me/proj/.claude/wt", "-Users-me-proj--claude-wt"];
    expect(path.basename(projectTranscriptDir(root, path.sep + "home"))).toBe(expected);
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
    expect(result.byTool[0]?.bytes.clampedUncapped).toBe(3700);
  });

  it("refuses a call whose invocation id two sessions both carry, on both sides", async () => {
    // The id join was built to beat the timestamp window, and it does. But an
    // `invocation_id` is CALL identity and it was being read as SESSION
    // OWNERSHIP. Claude Code writes a resumed or forked conversation's inherited
    // records into the new session file, so one `gate` result is physically
    // present in every descendant and EVERY descendant's join matches it.
    //
    // Measured on this project before the fix: one id in four transcripts, its
    // saving credited four times -- 21 gate rows on disk against 24 calls
    // attributed, 3,756,512 suppressed bytes against 4,043,702, 1.076x. The four
    // sessions shared 347 to 692 records pairwise and three had the same first
    // timestamp, which is what a fork looks like on disk.
    //
    // No rule recovers the owner from the files alone, so both sides refuse it
    // and report the magnitude. Under-counting is the safe direction here:
    // `G-stop` STOPS the project on a low number.
    clock = 0;
    const shared = "33333333-3333-4333-8333-333333333333";
    const at500 = new Date(1_700_000_000_500).toISOString();
    const lineage = async (): Promise<string> => {
      clock = 0;
      return writeTranscript(tempRoot(), [
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
          parentUuid: null,
          sessionId: "sess-1",
          timestamp: at500,
          message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
          toolUseResult: {
            content: [{ type: "text", text: JSON.stringify({ passed: false, invocation_id: shared }) }],
          },
        }),
        assistantRecord("req-2", { write1h: 100, read: 1000 }),
      ]);
    };
    const parent = await readTranscript(await lineage());
    const child = await readTranscript(await lineage());

    // The set is what makes it visible; neither transcript can see it alone.
    const ambiguous = invocationOwners([parent, child]);
    expect([...ambiguous]).toEqual([shared]);
    expect([...invocationOwners([parent])]).toEqual([]);

    // AND THE UNIT MATTERS. These two share every requestId, so they are one
    // lineage — a compaction continuation, not two conversations. Told to group
    // by lineage, the same call is NOT ambiguous, because a task window inside a
    // lineage owns it outright. Told nothing, it groups per transcript, which is
    // what a per-session report needs: four sessions that each print a total may
    // not each print the same call.
    expect([...invocationOwners([parent, child], lineagesOf([parent, child]))]).toEqual([]);
    expect(lineagesOf([parent, child])[0]).toBe(lineagesOf([parent, child])[1]);

    const row = {
      ts: at500,
      invocation_id: shared,
      tool: "gate",
      bytes_raw: 7400,
      bytes_returned: 3700,
      turns_collapsed: 0,
      latency_ms: 1,
    };
    for (const transcript of [parent, child]) {
      const result = buildCounterfactual(
        transcript,
        [row],
        DEFAULT_RATES,
        buildSessionReport(transcript, DEFAULT_RATES),
        ambiguous
      );
      expect(result.ambiguous).toBe(1);
      expect(result.byTool).toEqual([]);
      expect(result.unitsTotal).toBe(0);
      // Refused, not vanished: the magnitude is reported so the exclusion is
      // visible rather than reading as a session that simply saved nothing.
      expect(result.ambiguousUnits.units).toBeGreaterThan(0);
      expect(result.ambiguousUnits.unsized).toBe(0);
      // AND THE FRACTION IS WITHHELD, NOT ZERO. This session's only telemetry
      // was a real saving whose owner is unknown, so 0 would assert it saved
      // nothing -- a different false claim, and the dangerous one, since G-stop
      // stops the project on a low number. It reported 0.0000 before this.
      expect(result.savedFraction).toBeNull();
      // Every refusal class in ONE number, so a consumer deciding whether there
      // is anything to report cannot miss a class that was added later.
      expect(result.refusedRows).toBe(1);
    }

    // Without the set it is still credited once -- which is the pre-fix
    // behaviour, and the reason this is a defect of the CALLER's knowledge and
    // not of the join itself.
    const alone = buildCounterfactual(parent, [row], DEFAULT_RATES, buildSessionReport(parent, DEFAULT_RATES));
    expect(alone.byTool[0]?.calls).toBe(1);
  });

  it("withholds the saved fraction rather than reporting one built on timestamps", async () => {
    // `provenanceUnavailable` means this transcript DOES call our tools but no
    // result echoes an invocation id, so the exact join is gone and only the
    // timestamp fallback remains -- the very thing that cannot tell two sessions
    // apart. Reporting a number from it is worse than reporting none: `G-stop`
    // stops this project below 15%, so a confident low figure IS the decision.
    // Same treatment as session USD, withheld unless every model is priced.
    clock = 0;
    const file = await writeTranscript(tempRoot(), [
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
        parentUuid: null,
        sessionId: "sess-1",
        timestamp: new Date(1_700_000_000_500).toISOString(),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
        toolUseResult: { content: [{ type: "text", text: JSON.stringify({ passed: false }) }] }, // no echo
      }),
      assistantRecord("req-2", { write1h: 100, read: 1000 }),
    ]);
    const transcript = await readTranscript(file);
    const result = buildCounterfactual(
      transcript,
      [
        {
          ts: new Date(1_700_000_000_500).toISOString(),
          invocation_id: "44444444-4444-4444-8444-444444444444",
          tool: "gate",
          bytes_raw: 7400,
          bytes_returned: 3700,
          turns_collapsed: 0,
          latency_ms: 1,
        },
      ],
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES)
    );

    expect(result.provenanceUnavailable).toBe(true);
    // WITHHELD, and null is not 0: the units are still reported so the reader
    // can see there was something to withhold.
    expect(result.savedFraction).toBeNull();
    expect(result.unitsTotal).toBeGreaterThan(0);
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
    expect(result.byTool[0]?.bytes.clampedUncapped).toBe(3700);
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

  it("reports the magnitude of a refusal on a subagent thread, instead of zero", async () => {
    // The crediting path resolves the calling thread; the REFUSAL path shipped
    // hardcoding "main" -- the same bug inverted. On this fixture the only
    // main-thread request is at t=0, before the call at t=600, so no main
    // request matches and the refused magnitude came back 0. A refusal that
    // reports "nothing was refused" is precisely the silent exclusion the
    // counter was added to prevent, and sessions here run to 78% subagent.
    clock = 0;
    const id = "33333333-3333-4333-8333-333333333333";
    const at = (ms: number): string => new Date(1_700_000_000_000 + ms).toISOString();
    const file = await writeTranscript(tempRoot(), [
      assistantRecord("req-main-1", { write1h: 100, read: 50_000 }), // t = 0, main, BEFORE the call
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
      JSON.stringify({
        type: "assistant",
        requestId: "req-sub-2",
        sessionId: "sess-1",
        uuid: "s2",
        parentUuid: "s1",
        isSidechain: true,
        timestamp: at(900),
        message: {
          model: "test-model",
          content: [],
          usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: 400, output_tokens: 0 },
        },
      }),
    ]);

    const transcript = await readTranscript(file);
    const result = buildCounterfactual(
      transcript,
      [{ ts: at(600), invocation_id: id, tool: "gate", bytes_raw: 40_000, bytes_returned: 1_000, turns_collapsed: 0, latency_ms: 1 }],
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES),
      new Set([id]) // another session carries it too, so it is refused
    );

    expect(result.ambiguous).toBe(1);
    expect(result.byTool).toEqual([]);
    // The point of the test: refused, and the magnitude is KNOWN and non-zero.
    expect(result.ambiguousUnits.units).toBeGreaterThan(0);
    expect(result.ambiguousUnits.unsized).toBe(0);
  });

  it("counts a refusal it cannot size instead of summing the unknown as zero", async () => {
    // No request follows the call in any thread, so there is nothing to price
    // the refusal against. The amount withheld is UNKNOWN, and a sum cannot say
    // "plus some unknown amount" -- so it is counted separately rather than
    // folded in as 0, which would read as "we refused nothing worth having".
    clock = 0;
    const id = "55555555-5555-4555-8555-555555555555";
    const at = (ms: number): string => new Date(1_700_000_000_000 + ms).toISOString();
    const file = await writeTranscript(tempRoot(), [
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
        parentUuid: null,
        sessionId: "sess-1",
        timestamp: at(500),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
        toolUseResult: { content: [{ type: "text", text: JSON.stringify({ invocation_id: id }) }] },
      }),
      // and nothing after it: the session ends here.
    ]);

    const transcript = await readTranscript(file);
    const result = buildCounterfactual(
      transcript,
      [{ ts: at(9_000), invocation_id: id, tool: "gate", bytes_raw: 40_000, bytes_returned: 1_000, turns_collapsed: 0, latency_ms: 1 }],
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES),
      new Set([id])
    );

    expect(result.ambiguous).toBe(1);
    // Not "0 units refused": NO units sized, plus one refusal nobody could size.
    expect(result.ambiguousUnits.units).toBe(0);
    expect(result.ambiguousUnits.unsized).toBe(1);
  });

  it("does not borrow another thread's request to size a subagent's refusal", async () => {
    // The first fix for the hardcoded-"main" bug replaced it with a FALLBACK to
    // main, which is worse than the bug it replaced: it does not compute an
    // approximate answer, it computes a DIFFERENT one — against a thread that
    // never paid for the call — and returns it as known, with the unsized
    // counter reading 0.
    //
    // Measured on exactly this fixture before the fallback was removed:
    // 283,176 units reported as known, of which 270,000 came from the main
    // thread's cacheRead of 900,000 (turns_collapsed 3 x 900,000 x 0.1). The
    // subagent's own thread has nothing after the call at all, so the honest
    // answer is that the magnitude is unknown.
    clock = 0;
    const id = "77777777-7777-4777-8777-777777777777";
    const at = (ms: number): string => new Date(1_700_000_000_000 + ms).toISOString();
    const file = await writeTranscript(tempRoot(), [
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
      // Nothing follows on the SUBAGENT thread. A main-thread request does
      // follow, and it is the one the fallback used to reach for.
      JSON.stringify({
        type: "assistant",
        requestId: "req-main-2",
        sessionId: "sess-1",
        uuid: "m2",
        parentUuid: null,
        isSidechain: false,
        timestamp: at(900),
        message: {
          model: "test-model",
          content: [],
          usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: 900_000, output_tokens: 0 },
        },
      }),
    ]);

    const transcript = await readTranscript(file);
    const result = buildCounterfactual(
      transcript,
      [{ ts: at(600), invocation_id: id, tool: "gate", bytes_raw: 40_000, bytes_returned: 1_000, turns_collapsed: 3, latency_ms: 1 }],
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES),
      new Set([id])
    );

    expect(result.ambiguous).toBe(1);
    expect(result.ambiguousUnits.unsized).toBe(1);
    expect(result.ambiguousUnits.units).toBe(0);
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
    expect(gate?.unitsFromSuppression.clampedUncapped).toBeCloseTo(2000, 6);
    // 3,700 raw is under the 30,000 truncation ceiling, so capping changes nothing
    // and the row is byte-positive, so signing changes nothing either. All three
    // agree here ON PURPOSE: the variants must not move a case that has no reason
    // to move.
    expect(gate?.unitsFromSuppression.signedUncapped).toBeCloseTo(2000, 6);
    expect(gate?.unitsFromSuppression.signedCapped).toBeCloseTo(2000, 6);
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

    // 3 turns x 50,000 cached tokens x 0.1 = 15,000 units -- REPORTED.
    expect(result.byTool[0]?.unitsFromTurnCollapse).toBeCloseTo(15_000, 6);
    // AND IN NO SCORED NUMBER. `turns_collapsed` is a caller argument: `gate`
    // derives it from the `category` the caller passed and `repair` writes
    // `rounds.length` whether or not it closed the failure. Worse, the term
    // multiplies that self-declared count by the accumulated context while the
    // denominator counts the same cache read once, so padding the context before
    // a collapsing call raises the numerator faster than the denominator.
    //
    // This row suppressed no bytes at all, so with turn collapse excluded there
    // is nothing left to credit and the fraction is 0 -- which is the negative
    // control for the exclusion: it fired.
    expect(result.byTool[0]?.unitsTotal).toBe(0);
    expect(result.savedFraction).toBe(0);
  });

  it("keeps a call that ADDED bytes as the negative it is", async () => {
    // The shipped clamp records `max(0, raw - returned)`, so a tool call that
    // returned more than the operation produced counts as having saved nothing
    // rather than as having cost something. That is not rare here: a live gate
    // row in this project ran 431 raw against 1,205 returned, and
    // `run 2026-08-04-mac-09` measured tsc-gated `repair` net negative 12 of 12.
    // B12 may not consume the clamped figure; both are reported.
    clock = 0;
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const at = (ms: number): string => new Date(1_700_000_000_000 + ms).toISOString();
    const file = await writeTranscript(tempRoot(), [
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
        parentUuid: null,
        sessionId: "sess-1",
        timestamp: at(500),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
        toolUseResult: { content: [{ type: "text", text: JSON.stringify({ invocation_id: id }) }] },
      }),
      assistantRecord("req-2", { write1h: 100 }),
    ]);
    const transcript = await readTranscript(file);
    const result = buildCounterfactual(
      transcript,
      // The real shape of the measured row: a single type error summarised into
      // a larger structured payload than the raw output it described.
      [{ ts: at(500), invocation_id: id, tool: "gate", bytes_raw: 431, bytes_returned: 1_205, turns_collapsed: 0, latency_ms: 1 }],
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES)
    );

    const gate = result.byTool[0];
    expect(gate?.rowsNetNegative).toBe(1);
    expect(gate?.bytes.clampedUncapped).toBe(0);
    expect(gate?.bytes.signedUncapped).toBe(-774);
    expect(gate?.bytes.signedCapped).toBe(-774); // 431 is far under the ceiling
    // The scored figure is the signed one, so the call is a COST here.
    expect(gate?.unitsTotal).toBeLessThan(0);
    expect(gate?.unitsFromSuppression.clampedUncapped).toBe(0);
  });

  it("refuses to credit bytes that could never have reached a context", async () => {
    // The counterfactual world is "the agent ran this through Bash", and Claude
    // Code truncates a tool result at `clientTruncationCap` characters before it
    // enters the context -- B2 measured a 30,136-character result stored as
    // 30,000. So a tool that summarised 1.9 MB did not save 1.9 MB of context;
    // at most the ceiling could ever have arrived.
    clock = 0;
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const at = (ms: number): string => new Date(1_700_000_000_000 + ms).toISOString();
    const file = await writeTranscript(tempRoot(), [
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
        parentUuid: null,
        sessionId: "sess-1",
        timestamp: at(500),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
        toolUseResult: { content: [{ type: "text", text: JSON.stringify({ invocation_id: id }) }] },
      }),
      assistantRecord("req-2", { write1h: 100 }),
    ]);
    const transcript = await readTranscript(file);
    // B3's measured npm-test mode: 1,919,136 raw returned as 6,859.
    const result = buildCounterfactual(
      transcript,
      [{ ts: at(500), invocation_id: id, tool: "gate", bytes_raw: 1_919_136, bytes_returned: 6_859, turns_collapsed: 0, latency_ms: 1 }],
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES)
    );

    const gate = result.byTool[0];
    expect(gate?.bytes.signedUncapped).toBe(1_919_136 - 6_859);
    expect(gate?.bytes.signedCapped).toBe(DEFAULT_RATES.clientTruncationCap - 6_859);
    // 82x apart on this row, which is the size of the modelling choice.
    expect(gate!.bytes.signedUncapped / gate!.bytes.signedCapped).toBeGreaterThan(80);
    expect(gate?.unitsTotal).toBeCloseTo(
      ((DEFAULT_RATES.clientTruncationCap - 6_859) / DEFAULT_RATES.charsPerToken) * 2.0,
      6
    );
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
    expect(result.unverifiableUnits.units).toBeGreaterThan(0);
  });
});

/**
 * Against the REAL compiled CLI, because the last three defects all lived at a
 * boundary the unit tests did not cross. `buildCounterfactual` returned the
 * withheld row correctly the whole time; the report simply never printed it.
 */
describe("the cost-meter CLI", () => {
  const execFileAsync = promisify(execFile);

  it("reports a session that admitted nothing instead of printing nothing at all", async () => {
    // Skipping on `requests === 0` printed no session line, no zero and no
    // counts, so a session read through the wrong anchor became invisible rather
    // than merely wrong. A session whose only assistant records are api-errors
    // reaches the same branch honestly, and must still be visible.
    clock = 0;
    const root = tempRoot();
    const transcripts = tempRoot();
    await fs.writeFile(
      path.join(transcripts, "sess-1.jsonl"),
      `${[
        assistantRecord("req-a", {}, { isApiErrorMessage: true }),
        assistantRecord("req-b", {}, { isApiErrorMessage: true }),
      ].join("\n")}\n`,
      "utf8"
    );

    const cli = path.join(import.meta.dirname, "..", "dist", "cost", "cli.js");
    const { stdout } = await execFileAsync(process.execPath, [cli, "--dir", transcripts, "--root", root]);

    expect(stdout).toContain("0 billed requests");
    expect(stdout).toContain("apiError 2");
    expect(stdout).toContain("mis-read");
  }, 30_000);

  it("attributes to the session that was asked for, or to nothing at all", async () => {
    // --session X selects <X>.jsonl AND everything under <X>/. Discarding X and
    // anchoring on the first billable record let the report come back labelled Y
    // -- with X's own subagent records then excluded as foreign, silently. It
    // also made the meter identify a session by a different rule than the oracle
    // does, so B20's residual of 0 would have been agreement by coincidence.
    clock = 0;
    const root = tempRoot();
    const transcripts = tempRoot();
    // The file is named for one session and holds another's records.
    await fs.writeFile(
      path.join(transcripts, "sess-1.jsonl"),
      `${assistantRecord("req-1", { write1h: 100 }, { sessionId: "a-different-session" })}
`,
      "utf8"
    );

    const cli = path.join(import.meta.dirname, "..", "dist", "cost", "cli.js");
    const { stdout } = await execFileAsync(process.execPath, [cli, "--dir", transcripts, "--root", root, "--json"]);
    const payload = JSON.parse(stdout) as Array<{ session: { sessionId: string; requests: number; excluded: Record<string, number> } }>;

    expect(payload).toHaveLength(1);
    // Never Y's id on a report the operator asked about X.
    expect(payload[0]?.session.sessionId).toBe("sess-1");
    expect(payload[0]?.session.requests).toBe(0);
    expect(payload[0]?.session.excluded.foreignSession).toBe(1);
  }, 30_000);

  it("keeps --json parseable, and the admitted-nothing session inside the payload", async () => {
    // The zero-request branch wrote its human line unconditionally, so --json
    // emitted ANSI prose and then the array: unparseable, and B20 requires these
    // artifacts to be machine-produced. It also skipped before pushing, so the
    // session was missing from the payload entirely — the same invisibility one
    // layer out, this time inside the evidence file.
    clock = 0;
    const root = tempRoot();
    const transcripts = tempRoot();
    await fs.writeFile(
      path.join(transcripts, "sess-1.jsonl"),
      `${[
        assistantRecord("req-a", {}, { isApiErrorMessage: true }),
        assistantRecord("req-b", {}, { isApiErrorMessage: true }),
      ].join("\n")}\n`,
      "utf8"
    );

    const cli = path.join(import.meta.dirname, "..", "dist", "cost", "cli.js");
    const { stdout } = await execFileAsync(process.execPath, [cli, "--dir", transcripts, "--root", root, "--json"]);

    const payload = JSON.parse(stdout) as Array<{ session: { requests: number; excluded: Record<string, number> } }>;
    expect(payload).toHaveLength(1);
    expect(payload[0]?.session.requests).toBe(0);
    expect(payload[0]?.session.excluded.apiError).toBe(2);
    // Not one byte of prose: a consumer parses stdout whole.
    expect(stdout.trimStart().startsWith("[")).toBe(true);
  }, 30_000);

  it("shows withheld rows even when nothing at all was counted", async () => {
    clock = 0;
    const root = tempRoot();
    const transcripts = tempRoot();
    await fs.writeFile(
      path.join(transcripts, "sess-1.jsonl"),
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
      path.join(transcripts, "sess-1.jsonl"),
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
      path.join(transcripts, "sess-1.jsonl"),
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

    // m is $1/MTok and m@fast is $2/MTok, so their multipliers are ratios to
    // different bases. 2.0 + 0.5 + 0.5 = 3.0 is NOT "3x the input rate": the
    // real cost is 2.0x$1 + 0.5x$2 + 0.5x$2 = $4. Adding them is adding
    // quantities with different units, and labelling the sum a multiple of a
    // rate that no request paid.
    it("withholds the ratio when the segment mixes input prices", () => {
      const cost = entryCostOfSegment([req(0, "standard"), req(1, "fast"), req(2, "fast")], rates);
      expect(cost?.multiplier).toBeNull();
      expect(cost?.write).toBeNull();
      expect(cost?.reread).toBeNull();
      expect(cost?.keys).toEqual(["m", "m@fast"]);
    });

    it("still gives USD for a mixed segment, each term against its own price", () => {
      const cost = entryCostOfSegment([req(0, "standard"), req(1, "fast"), req(2, "fast")], rates);
      expect(cost?.usdPerMTok).toBeCloseTo(4.0, 6); // 2.0x$1 + 0.5x$2 + 0.5x$2
    });

    it("keeps the ratio when two keys happen to share an input price", () => {
      const sameBase = {
        ...DEFAULT_RATES,
        models: {
          "m": { inputPerMTok: 1, multipliers: { ...DEFAULT_MULTIPLIERS, cacheRead: 0.1 } },
          "m@fast": { inputPerMTok: 1, multipliers: { ...DEFAULT_MULTIPLIERS, cacheRead: 0.5 } },
        },
      };
      const cost = entryCostOfSegment([req(0, "standard"), req(1, "fast"), req(2, "fast")], sameBase);
      expect(cost?.multiplier).toBeCloseTo(3.0, 6); // one base, so the ratios do add
      expect(cost?.usdPerMTok).toBeCloseTo(3.0, 6);
    });

    it("agrees with positionalMultiplier when the segment is uniform", () => {
      const cost = entryCostOfSegment([req(0, "standard"), req(1, "standard"), req(2, "standard")], rates);
      const flat = positionalMultiplier(0, 3, multipliersFor(rates, "m"), "1h");
      expect(cost?.multiplier).toBeCloseTo(flat, 6);
    });

    it("keeps the ratio for a single unpriced key, where there is still one base", () => {
      const unpriced = { ...DEFAULT_RATES, models: {} };
      const cost = entryCostOfSegment([req(0, "standard"), req(1, "standard")], unpriced);
      expect(cost?.multiplier).toBeCloseTo(DEFAULT_MULTIPLIERS.cacheWrite1h + DEFAULT_MULTIPLIERS.cacheRead, 6);
      expect(cost?.usdPerMTok).toBeNull();
    });

    it("takes the write from turn 0, not from whichever request came first in the array", () => {
      const cost = entryCostOfSegment([req(2, "fast"), req(0, "standard"), req(1, "fast")], rates);
      expect(cost?.usdPerMTok).toBeCloseTo(4.0, 6); // write is turn 0's ($1 base), not fast's
    });

    // Two unpriced keys may well share a price — the rates file simply does not
    // say. Reporting "priced differently" here would assert a fact it does not
    // contain, the same way "we did not look" must never read as "nothing
    // changed". The report exposes the unpriced keys so the caller can say
    // "unknown" instead of inventing a comparison.
    it("does not claim two unpriced keys differ — it reports that they are unpriced", () => {
      const noPrices = { ...DEFAULT_RATES, models: {} };
      const cost = entryCostOfSegment([req(0, "standard"), req(1, "fast"), req(2, "fast")], noPrices);
      expect(cost?.multiplier).toBeNull();
      expect(cost?.usdPerMTok).toBeNull();
      expect(cost?.keys).toEqual(["m", "m@fast"]);
      expect(cost?.unpricedKeys).toEqual(["m", "m@fast"]);
      expect(cost?.sharesOneInputRate).toBeNull(); // unknown — NOT false
    });

    it("lists only the keys actually missing a price", () => {
      const partial = {
        ...DEFAULT_RATES,
        models: { "m": { inputPerMTok: 1 } },
      };
      const cost = entryCostOfSegment([req(0, "standard"), req(1, "fast")], partial);
      expect(cost?.unpricedKeys).toEqual(["m@fast"]);
      expect(cost?.usdPerMTok).toBeNull();
      // One known price plus one unknown does not settle whether they match.
      expect(cost?.sharesOneInputRate).toBeNull();
    });

    // A missing third price cannot make two unequal known prices equal, so this
    // is settled — false, not unknown. Reporting it as unknown understates what
    // the rates file actually says, the mirror of overstating it.
    it("settles the ratio from known prices even when another key is unpriced", () => {
      const partial = {
        ...DEFAULT_RATES,
        models: { "m": { inputPerMTok: 1 }, "m@fast": { inputPerMTok: 2 } },
      };
      const cost = entryCostOfSegment(
        [req(0, "standard"), req(1, "fast"), { ...req(2, "slow"), model: "other" } as BilledRequest],
        partial
      );
      expect(cost?.sharesOneInputRate).toBe(false);
      expect(cost?.multiplier).toBeNull();
      expect(cost?.usdPerMTok).toBeNull();
      expect(cost?.unpricedKeys).toEqual(["other@slow"]);
    });

    it("marks a uniform segment as sharing one input rate", () => {
      const cost = entryCostOfSegment([req(0, "standard"), req(1, "standard")], rates);
      expect(cost?.sharesOneInputRate).toBe(true);
    });

    it("reports differing known prices as settled, not unknown", () => {
      const cost = entryCostOfSegment([req(0, "standard"), req(1, "fast")], rates);
      expect(cost?.sharesOneInputRate).toBe(false);
      expect(cost?.usdPerMTok).toBeCloseTo(2.0 * 1 + 0.5 * 2, 6);
    });

    it("reports no unpriced keys when the whole segment is priced", () => {
      const cost = entryCostOfSegment([req(0, "standard"), req(1, "fast")], rates);
      expect(cost?.unpricedKeys).toEqual([]);
    });

    it("returns null for an empty segment", () => {
      expect(entryCostOfSegment([], rates)).toBeNull();
    });
  });
});
