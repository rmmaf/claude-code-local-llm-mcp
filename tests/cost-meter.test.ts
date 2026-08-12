import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  breakdownOfRequests,
  buildCounterfactual,
  buildSessionReport,
  entryCostOfSegment,
  invocationOwners,
  lineagesOf,
  positionalMultiplier,
  priceUsage,
  scopeTelemetry,
  unitsAddedByInstallation,
} from "../src/cost/report.js";
import type { CreditedRow } from "../src/cost/report.js";
import type { ClassifiedOutcome } from "../scripts/b12-run.d.mts";
import {
  DEFAULT_MULTIPLIERS,
  DEFAULT_RATES,
  inputPriceFor,
  loadRates,
  multipliersFor,
} from "../src/cost/rates.js";
import type { BilledRequest } from "../src/cost/transcript.js";
import { listSessionIds, listTranscripts, projectTranscriptDir, readTranscript, sessionFiles } from "../src/cost/transcript.js";
import { assembleRun } from "../src/cost/b12/assemble.js";
import { createTelemetryWriter, readTelemetry, TELEMETRY_REL_PATH } from "../src/telemetry.js";
import { archiveOf, billed, obsOf, PINNED, taskOf } from "./b12-fixtures.js";
import { makeTempRoot, removeTempRoot } from "./helpers.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = makeTempRoot("cost-meter-test-");
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    await removeTempRoot(root);
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

    // AND THE CREDITING HALF AT THE SCORING INVOCATION, not one layer below it
    // (R37#3). voidConditions 6 asks for "a per-session scoring invocation
    // REFUSING where the full-set invocation credits". The refusing half ran
    // through `buildCounterfactual` above; the crediting half stopped at
    // `invocationOwners` returning an empty set, which is an ownership fact and
    // not a scored one. The FULL-SET invocation is the same rows grouped by
    // LINEAGE -- these two transcripts are one compaction continuation -- and
    // it has to be shown crediting the very row the per-session one refuses.
    const fullSet = buildCounterfactual(
      parent,
      [row],
      DEFAULT_RATES,
      buildSessionReport(parent, DEFAULT_RATES),
      invocationOwners([parent, child], lineagesOf([parent, child]))
    );
    expect(fullSet.ambiguous).toBe(0);
    expect(fullSet.refusedRows).toBe(0);
    expect(fullSet.byTool[0]?.calls).toBe(1);
    expect(fullSet.unitsTotal).toBeGreaterThan(0);
    // Withheld on the per-session side, STATED on the full-set side: the two
    // outcomes the frozen sentence contrasts, both read off a scored result.
    expect(fullSet.savedFraction).not.toBeNull();
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

  it("charges the installed tool schemas once per segment and re-read after", async () => {
    // B12's harm is over tasks with the server INSTALLED, not invoked. The seven
    // schemas measured 15,227 characters of `tools/list` wire JSON on this build
    // plus a 900-character policy block, and they sit in the system prompt of
    // every thread whether or not a tool is called. Omitting this term lets an
    // unused tool look free.
    clock = 0;
    const file = await writeTranscript(tempRoot(), [
      assistantRecord("req-1", { write1h: 100 }),
      assistantRecord("req-2", { write1h: 100 }),
      assistantRecord("req-3", { write1h: 100 }),
    ]);
    const transcript = await readTranscript(file);
    const chars = 16_127;
    const units = unitsAddedByInstallation(transcript, DEFAULT_RATES, chars);

    // One main segment of 3 requests: entering at position 0 costs the 1h write
    // (2.0) plus two re-reads (0.1 each) = 2.2 per token.
    expect(units).toBeCloseTo((chars / DEFAULT_RATES.charsPerToken) * 2.2, 6);
    // It is NOT free and it is NOT tiny: ~4,360 tokens of context on this build.
    expect(units).toBeGreaterThan(9_000);
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

  it("credits a failed repair row at zero units — clause 6's failed-repair control", async () => {
    // `voidConditions` 6's FIRST named control, and it had no test until the
    // audit computer needed to pin its title: a repair that ABORTED writes the
    // row B16 needs (the request happened) with `bytes_raw: 0,
    // bytes_returned: 0` — and the meter must CREDIT that row at exactly zero
    // units, never refuse it, never let it claim a saving, never count it
    // toward a closure.
    clock = 0;
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const at = (ms: number): string => new Date(1_700_000_000_000 + ms).toISOString();
    const file = await writeTranscript(tempRoot(), [
      assistantRecord("req-1", { write1h: 100 }, {
        message: {
          model: "test-model",
          content: [{ type: "tool_use", id: "tu-1", name: "mcp__local-coder__repair" }],
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
      // The abort row's exact shape, from `runRepair`'s catch path.
      [{
        ts: at(500),
        invocation_id: id,
        tool: "repair",
        bytes_raw: 0,
        bytes_returned: 0,
        turns_collapsed: 0,
        latency_ms: 1,
        detail: { aborted: true, stopped_because: "aborted" },
      }],
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES)
    );

    const row = result.rows[0];
    expect(row?.disposition).toBe("credited"); // a row, never a refusal
    expect(row?.units).toBe(0);
    expect(row?.unitsLo).toBe(0);
    expect(row?.signed).toBe(0);
    // A failed repair did not close anything, and its row may not say it did.
    expect(row?.passed).not.toBe(true);
    const repair = result.byTool[0];
    expect(repair?.tool).toBe("repair");
    expect(repair?.unitsTotal).toBe(0);
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

describe("the B12 harness", () => {
  const runNode = promisify(execFile);
  const BUDGET = 45 * 60 * 1000;
  // Return type INFERRED, so the closed `ClassifiedOutcome` union reaches every
  // assertion below. Annotating it `outcome: string` — as this did — widens it
  // back and lets an assertion name a spelling no branch produces.
  const classify = async (over: Record<string, unknown>) => {
    // NO CAST. It used to read `mod as { classifyRun: (o: unknown) => ... }`,
    // which typed the argument as `unknown` and made this call site unchecked —
    // and it was carrying `wallMs: 1_000`, a field `classifyRun` does not take.
    // `wallMs` standing in as evidence of who ended the process is a defect the
    // harness fixed TWICE (see the enumeration in `b12-run.mjs`); the test kept
    // passing it afterwards, harmlessly at runtime and invisibly to everything
    // else. The shape now comes from `scripts/b12-run.d.mts`.
    const { classifyRun } = await import("../scripts/b12-run.mjs");
    return classifyRun({
      exitCode: 0,
      signal: null,
      errorCode: null,
      budgetMs: BUDGET,
      originatedCount: 12,
      slugsBefore: 3,
      slugsAfter: 3,
      // The covered-vs-written populations, satisfied by default (written is a
      // subset) so every outcome test above stays about ITS outcome. The rule
      // fails closed without them; the slug-coverage control fires them.
      coveredSlugs: ["slug-a", "slug-b", "slug-c"],
      writtenSlugs: ["slug-a"],
      ...over,
    });
  };

  it("keeps a budget timeout as a censored observation, not an invalid one", async () => {
    // `spawnSync` reports a timeout as ETIMEDOUT with a null exit status, and a
    // missing binary the same way but with ENOENT. Collapsing them into one
    // `failed` flag marked a timed-out arm INVALID and told the reader "the CLI
    // could not be spawned at all", which is not what happened.
    //
    // The direction is the point. The design keeps a censored arm as a LOWER
    // BOUND precisely "because dropping budget-exhausted control arms removes
    // exactly the evidence that favours the tools" — control arms are the long
    // ones, having no gate to answer in a single call. Invalidating them biases
    // toward a hold, which is the error that keeps a project running on a
    // premise that stopped being true.
    const timedOut = await classify({ exitCode: null, signal: "SIGTERM", errorCode: "ETIMEDOUT" });
    expect(timedOut.censored).toBe(true);
    expect(timedOut.valid).toBe(true);
    expect(timedOut.reasons).toEqual([]);

    // A SIGTERM WITHOUT `ETIMEDOUT` IS NOT OUR BUDGET. This assertion originally
    // read `censored: true` and encoded the defect it was meant to guard:
    // `spawnSync` sets ETIMEDOUT exactly when IT does the killing, so a SIGTERM
    // without one means something else ended the process, and calling that
    // censored accepts an outside kill as a budget exhaustion.
    const otherKill = await classify({ exitCode: null, signal: "SIGTERM", wallMs: BUDGET });
    expect(otherKill.censored).toBe(false);
    expect(otherKill.valid).toBe(false);

    // A censored arm need not have originated anything: killed before its first
    // billed request, it still measures "did not finish inside the budget".
    const killedEarly = await classify({ exitCode: null, signal: "SIGTERM", errorCode: "ETIMEDOUT", originatedCount: 0 });
    expect(killedEarly.censored).toBe(true);
    expect(killedEarly.valid).toBe(true);

    // But a broken run is still broken, and says which.
    const noBinary = await classify({ exitCode: null, errorCode: "ENOENT" });
    expect(noBinary.censored).toBe(false);
    expect(noBinary.valid).toBe(false);
    expect(noBinary.reasons[0]).toContain("ENOENT");

    // And an arm that ran to completion recording nothing is not an observation.
    const emptyButFinished = await classify({ originatedCount: 0 });
    expect(emptyButFinished.censored).toBe(false);
    expect(emptyButFinished.valid).toBe(false);
    expect(emptyButFinished.reasons[0]).toContain("no requestId was originated");
  });

  it("refuses an arm the CLI abandoned partway, however much it had already done", async () => {
    // The exit code was not passed into the rule AT ALL, so an execution failure
    // reached the archive as a complete observation. Measured:
    // `claude --definitely-not-a-flag` returns status 1 with NO spawn error, so
    // `errorCode` stayed null and `spawnFailed` stayed false. An arm that had
    // originated a few requests before an expired credential or a context
    // overflow killed it came back valid, and its truncated cost would have been
    // scored as a whole task.
    //
    // A non-zero exit is the CLI failing. It is NOT the same as the agent
    // failing the task: `claude --print` exits 0 either way, and a genuine
    // failure to solve the task is caught by the acceptance predicate as
    // `accepted: false` -- which is data, and is kept.
    const crashedLate = await classify({ exitCode: 1, originatedCount: 7 });
    expect(crashedLate.valid).toBe(false);
    expect(crashedLate.censored).toBe(false);
    expect(crashedLate.reasons.join(" ")).toContain("exited 1");

    // Killed by something that is not our budget is also not censored.
    const outsideSignal = await classify({ exitCode: null, signal: "SIGKILL", originatedCount: 7 });
    expect(outsideSignal.valid).toBe(false);
    expect(outsideSignal.censored).toBe(false);
    expect(outsideSignal.reasons.join(" ")).toContain("SIGKILL");

    // And one cause gives one reason: a missing binary is not also reported as
    // an abandoned run.
    const noBinary = await classify({ exitCode: null, errorCode: "ENOENT", originatedCount: 7 });
    expect(noBinary.reasons).toHaveLength(1);
    expect(noBinary.reasons[0]).toContain("ENOENT");
  });

  it("gives a failure the same verdict however late it happened", async () => {
    // Censoring was `ETIMEDOUT || (exitCode !== 0 && wallMs >= budgetMs)`, and
    // the second half used DURATION as evidence that WE stopped the process.
    // Duration says how long something took, not who ended it — so the same
    // failure, exit 1, came back invalid when early and censored-and-valid when
    // late. An arm that hung on a network call for the whole budget and then
    // died of an expired credential was archived as a legitimate
    // budget-exhausted observation, and it did not even need to have originated
    // anything to qualify.
    //
    // Only `ETIMEDOUT` is positive evidence: `spawnSync` sets it exactly when it
    // kills a child at the timeout it was given.
    const early = await classify({ exitCode: 1, wallMs: 1_000 });
    const late = await classify({ exitCode: 1, wallMs: BUDGET });
    expect(late.censored).toBe(false);
    expect(late.valid).toBe(false);
    expect(late.reasons[0]).toBe(early.reasons[0]);

    // A real budget kill still is one.
    const killed = await classify({ exitCode: null, signal: "SIGTERM", errorCode: "ETIMEDOUT", wallMs: BUDGET });
    expect(killed.censored).toBe(true);
    expect(killed.valid).toBe(true);

    // Whether the budget was enforced is a FACT the harness holds, not something
    // to read off the clock. This check first asked `wallMs >= budgetMs`, which
    // is the same duration-as-evidence mistake one line up: with a timeout
    // actually set, `spawnSync` raises ETIMEDOUT the moment the wall crosses, so
    // the question could essentially only be answered "yes" on a legitimate
    // completion whose measured wall included spawn overhead.
    const unenforced = await classify({ exitCode: 0, budgetEnforced: false });
    expect(unenforced.censored).toBe(false);
    expect(unenforced.valid).toBe(false);
    expect(unenforced.reasons.join(" ")).toContain("never enforced");
  });

  it("does not censor a child that finished, whatever the timer says", async () => {
    // `spawnSync` times the WHOLE call, so node's startup and teardown count
    // toward the budget. Measured: a child sleeping 330ms under a 400ms timeout
    // returns `status: 0` AND `ETIMEDOUT` at 405ms of wall clock.
    //
    // That child completed. Censoring it files a finished task as a lower bound
    // and discards the observation it actually produced -- and near the boundary
    // this is not rare, it is what every long-but-successful arm looks like.
    const boundary = await classify({ exitCode: 0, errorCode: "ETIMEDOUT", wallMs: 405, budgetMs: 400 });
    expect(boundary.censored).toBe(false);
    expect(boundary.valid).toBe(true);
    expect(boundary.reasons).toEqual([]);

    // A child that was actually killed has no exit status of its own.
    const killed = await classify({ exitCode: null, signal: "SIGTERM", errorCode: "ETIMEDOUT", wallMs: 416, budgetMs: 400 });
    expect(killed.censored).toBe(true);
    expect(killed.valid).toBe(true);
  });

  it("does not censor a FAILURE that happened to die as the timer crossed", async () => {
    // The previous repair wrote `exitCode !== 0` where it meant
    // `exitCode === null`, so it excluded the exit-0 boundary case it was
    // written for and admitted the exit-1 one it was not: a crash carrying
    // `ETIMEDOUT` came back censored and valid, with no reasons.
    //
    // Only a process that was really killed has no exit status of its own.
    const crashedAtBoundary = await classify({ exitCode: 1, errorCode: "ETIMEDOUT" });
    expect(crashedAtBoundary.outcome).toBe("exited_nonzero");
    expect(crashedAtBoundary.censored).toBe(false);
    expect(crashedAtBoundary.valid).toBe(false);
  });

  it("names every outcome, so an unhandled combination cannot become a default", async () => {
    // Six defects landed in this rule while it was a chain of `&&`s: three
    // fields it was never handed, two it should never have used (duration, in
    // consecutive repairs), and one `!== 0` that should have been `=== null`.
    // The shape was the problem -- a condition true of the case in mind is
    // easily also true of one that is not. The rule is now decided by case, and
    // every branch is named in the artifact rather than left as a fall-through
    // nobody chose.
    // TYPED TO THE CLOSED LIST, and neither side is cast. The expectations are
    // `ClassifiedOutcome`, so a spelling no branch produces is a compile error
    // rather than a red assertion — and `classify` returns the same union, so
    // the day a sixth outcome is added this table stops compiling until it is
    // listed here. That is the property the test's own title claims.
    const cases: Array<[Record<string, unknown>, ClassifiedOutcome]> = [
      [{}, "completed"],
      [{ exitCode: 0, errorCode: "ETIMEDOUT" }, "completed"],
      [{ exitCode: null, signal: "SIGTERM", errorCode: "ETIMEDOUT" }, "censored"],
      [{ exitCode: null, signal: "SIGKILL" }, "killed_by_signal"],
      [{ exitCode: 2 }, "exited_nonzero"],
      [{ exitCode: null, errorCode: "ENOENT" }, "spawn_failed"],
    ];
    for (const [over, expected] of cases) {
      const got = await classify(over);
      expect(got.outcome).toBe(expected);
    }
    // Exactly one outcome is both valid and not a completion.
    const censored = await classify({ exitCode: null, signal: "SIGTERM", errorCode: "ETIMEDOUT" });
    expect(censored.valid).toBe(true);
    expect(censored.censored).toBe(true);
  });

  it("admits exactly what the meter admits, on records that vary one field at a time", async () => {
    // `scripts/b12-run.mjs` re-implements B20's admission rule because it must
    // run before `dist/` exists. Two implementations of one rule that are never
    // compared is this project's signature defect: it produced a residual of 0
    // FOUR times for reasons belonging to the corpus rather than to the rules,
    // and reading them side by side found none of the four.
    //
    // So they are compared here, on a fixture that exercises every field the
    // rule mentions -- which the real corpus does not, since all 5,669 of its
    // records carry both keys and none is an api-error in an awkward place.
    const root = tempRoot();
    const slug = path.join(root, "slug-one");
    await fs.mkdir(slug, { recursive: true });
    const at = (ms: number): string => new Date(1_700_000_000_000 + ms).toISOString();
    const rec = (extra: Record<string, unknown>, ms: number): string =>
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-1",
        timestamp: at(ms),
        message: { model: "test-model", content: [], usage: { output_tokens: 10 } },
        ...extra,
      });
    const main = [
      rec({ uuid: "u1", requestId: "req-1" }, 0), // ordinary
      rec({ uuid: "u2" }, 1), // no requestId: admitted, ungroupable
      rec({ requestId: "req-3" }, 2), // no uuid: admitted, undedupable
      rec({ uuid: "u4", requestId: "req-4", isApiErrorMessage: true }, 3), // excluded by field
      JSON.stringify({
        type: "assistant",
        uuid: "u5",
        requestId: "req-5",
        sessionId: "sess-1",
        timestamp: at(4),
        message: { model: "<synthetic>", content: [], usage: { output_tokens: 0 } },
      }), // excluded by model
      JSON.stringify({ type: "user", uuid: "u6", sessionId: "sess-1", timestamp: at(5), message: { content: [] } }),
      "not json at all",
      "",
    ].join("\n");
    await fs.writeFile(path.join(slug, "sess-1.jsonl"), `${main}\n`, "utf8");
    // The same record in a subagent file: dedup by uuid must catch it ONCE.
    await fs.mkdir(path.join(slug, "sess-1", "subagents"), { recursive: true });
    await fs.writeFile(
      path.join(slug, "sess-1", "subagents", "agent-a.jsonl"),
      `${rec({ uuid: "u1", requestId: "req-1" }, 0)}\n${rec({ uuid: "u7", requestId: "req-7" }, 6)}\n`,
      "utf8"
    );

    const out = path.join(root, "snap.json");
    const script = path.join(process.cwd(), "scripts", "b12-run.mjs");
    await runNode(process.execPath, [script, "snapshot", "--root", root, "--out", out], {
      cwd: process.cwd(),
    });
    const snapshot = JSON.parse(await fs.readFile(out, "utf8"));
    const harness: string[] = snapshot.requestIds;

    // `design.artifacts` 5 asks the snapshot for "the directory count, the file
    // count, the id count AND PER-FILE SHA256". It carried the first three and a
    // file count with no list, so a transcript rewritten between the pre- and
    // post-snapshot was invisible — and the frozen text says the vendor rewrites
    // these files. Both fixture files, hashed, and the count still agrees with
    // the list it is a count of.
    //
    // `expect.soft`, FOUR FACTS, AND THE CHOICE IS THE POINT. Written as four
    // ordinary assertions the first failure ends the test and the three below it
    // never execute — so a planted defect proves only the topmost one while the
    // rest look checked and are not. That is exactly what happened here: the
    // omitted-subagent-file defect fired the length assertion and the hash and
    // sort assertions never ran. Soft assertions all evaluate, and each carries
    // its own message instead of one object diff the JSON reporter truncates.
    const hashes: Array<{ path: string; sha256: string }> = snapshot.fileHashes;
    const hashPaths = hashes.map((h) => h.path);
    // The count and the list are one fact stated twice, and they can drift:
    // `files` is the length of the WALK and `fileHashes` of what was READ.
    expect.soft(hashes.length, "fileHashes length disagrees with the file count").toBe(snapshot.files);
    expect
      .soft(hashes.map((h) => path.basename(h.path)).sort(), "the wrong files were hashed")
      .toEqual(["agent-a.jsonl", "sess-1.jsonl"]);
    expect
      .soft(hashes.find((h) => h.path.endsWith("sess-1.jsonl"))?.sha256, "the hash is not of the file bytes")
      .toBe(createHash("sha256").update(`${main}` + String.fromCharCode(10), "utf8").digest("hex"));
    // Sorted by path, so two snapshots of one machine diff line for line rather
    // than by whatever order the directory walk happened to return.
    expect.soft(hashPaths, "fileHashes is not sorted by path").toEqual([...hashPaths].sort());

    const meter = new Set<string>();
    for (const id of await listSessionIds(slug)) {
      const transcript = await readTranscript(await sessionFiles(slug, id), id);
      for (const request of transcript.requests) meter.add(request.requestId);
    }

    // req-1 once despite two files, req-3 and req-7 present, req-4 and req-5 out.
    expect([...harness].sort()).toEqual(["req-1", "req-3", "req-7"]);
    expect([...meter].filter((r) => !r.startsWith("__norid__")).sort()).toEqual(["req-1", "req-3", "req-7"]);
    expect([...harness].sort()).toEqual([...meter].filter((r) => !r.startsWith("__norid__")).sort());
  });

  it("the pilot table covers the frozen covariates and its shape guard refuses every aggregate", async () => {
    // Artifact 4: "No units, no bracket" — read as NO AGGREGATE and NO
    // bracket, never as a ban on the per-observation unit-valued covariates
    // the frozen list itself demands. The table's not-applicable rows are the
    // A/B-only ones, and nothing else.
    const { PILOT_COVARIATE_TABLE, assertPilotShape, buildPilotRecord, appendPilotRecord } = await import(
      "../scripts/b12-run.mjs"
    );
    expect(PILOT_COVARIATE_TABLE).toHaveLength(17);
    expect(
      PILOT_COVARIATE_TABLE.filter((r: { applicability: string }) => r.applicability !== "recorded").map(
        (r: { covariate: string }) => r.covariate
      )
    ).toEqual([
      "the A/B acceptance 2x2 (concordant/discordant)",
      "per A/B arm: turns, wall-clock, files read, tool bytes, billed count, ABBA position",
    ]);
    // Unit-VALUED per-observation covariates pass…
    expect(() => assertPilotShape({ observation: { aO: 123 }, telemetry: [{ bytes_raw: 5 }] })).not.toThrow();
    // …and every aggregate/bracket spelling refuses, at ANY depth.
    for (const key of ["rLo", "rHi", "rHiPlus", "uncappedBracket", "bracket", "verdict", "strata", "hold"]) {
      expect(() => assertPilotShape({ nested: { deep: { [key]: 1 } } })).toThrow(/forbidden key/);
    }
    // The appender accumulates into the ONE pilot file, table included.
    const root = tempRoot();
    await fs.mkdir(path.join(root, "evidence"), { recursive: true });
    const record = buildPilotRecord(
      {
        taskId: "t1",
        arm: "treatment",
        sessionId: "s1",
        outcome: "completed",
        valid: true,
        censored: false,
        accepted: true,
        invalidReasons: [],
      },
      { telemetry: [], lineage: [] }
    );
    await appendPilotRecord(root, "run-p", record);
    await appendPilotRecord(root, "run-p", { ...record, taskId: "t2" });
    const file = JSON.parse(await fs.readFile(path.join(root, "evidence", "run-p.b12.pilot.json"), "utf8"));
    expect(file.schema).toBe("b12-pilot/1");
    expect(file.observations).toHaveLength(2);
    expect(file.covariateTable).toEqual(PILOT_COVARIATE_TABLE);
  });

  it("the pilot append REFUSES rather than dropping an observation written under it", async () => {
    // R31. The pilot rewrites its one file whole and holds only the SESSION
    // lock, which is keyed by (runId, taskId, arm) — so two pilot tasks never
    // exclude each other, both read the same prior state, and the second write
    // silently drops the first. There is no obs dir, no runlog row and no
    // commit to reconstruct it from: the loss costs a paid session.
    //
    // The seam stands in for the writer the lock CANNOT cover — one that did
    // not take it. Suppress the re-read and `t9` below is simply gone.
    const { buildPilotRecord, appendPilotRecord } = await import("../scripts/b12-run.mjs");
    const root = tempRoot();
    await fs.mkdir(path.join(root, "evidence"), { recursive: true });
    const pilotFile = path.join(root, "evidence", "run-r.b12.pilot.json");
    const recordFor = (taskId: string) =>
      buildPilotRecord(
        {
          taskId,
          arm: "treatment",
          sessionId: `s-${taskId}`,
          outcome: "completed",
          valid: true,
          censored: false,
          accepted: true,
          invalidReasons: [],
        },
        { telemetry: [], lineage: [] }
      );

    await appendPilotRecord(root, "run-r", recordFor("t1"));

    let staged: string | null = null;
    await expect(
      appendPilotRecord(root, "run-r", recordFor("t2"), {
        beforeWrite: ({ tmp, atRead }) => {
          staged = tmp;
          // ATOMIC INSTALL, asserted where it is observable: the full next
          // state is already complete on disk under another name, and the
          // target still holds only what this call read. Structural — it
          // shows the target is never the half-written one, it does not
          // reproduce an OS-level torn write.
          const stagedState = JSON.parse(readFileSync(tmp, "utf8"));
          expect(stagedState.observations.map((o: { taskId: string }) => o.taskId)).toEqual(["t1", "t2"]);
          expect(JSON.parse(atRead!).observations).toHaveLength(1);
          // …and now the other writer completes, inside this call's window.
          const foreign = JSON.parse(atRead!);
          foreign.observations.push(recordFor("t9"));
          writeFileSync(pilotFile, JSON.stringify(foreign, null, 2) + "\n", "utf8");
        },
      })
    ).rejects.toThrow(/changed under this write/);

    // The other observation SURVIVED, and this one is recoverable by hand
    // instead of being re-run.
    const onDisk = JSON.parse(await fs.readFile(pilotFile, "utf8"));
    expect(onDisk.observations.map((o: { taskId: string }) => o.taskId)).toEqual(["t1", "t9"]);
    expect(staged).not.toBeNull();
    expect(JSON.parse(readFileSync(staged!, "utf8")).observations.map((o: { taskId: string }) => o.taskId)).toEqual([
      "t1",
      "t2",
    ]);
  });

  it("the pilot append takes the RUN-wide lock, not the per-task one", async () => {
    // The run lock's own header already said the session lock cannot serialize
    // a shared file. The pilot path took only the session lock anyway — the
    // sixth-and-now-seventh time a rule this repository had written down was
    // missing at a second site.
    const { acquireRunlogLock, buildPilotRecord, appendPilotRecord } = await import("../scripts/b12-run.mjs");
    const root = tempRoot();
    await fs.mkdir(path.join(root, "evidence"), { recursive: true });
    const record = buildPilotRecord(
      {
        taskId: "t1",
        arm: "treatment",
        sessionId: "s1",
        outcome: "completed",
        valid: true,
        censored: false,
        accepted: true,
        invalidReasons: [],
      },
      { telemetry: [], lineage: [] }
    );
    const held = acquireRunlogLock(path.join(root, "evidence"), "run-l");
    expect(held.ok).toBe(true);
    await expect(
      appendPilotRecord(root, "run-l", record, { lockAttempts: 2, lockWaitMs: 1 })
    ).rejects.toThrow(/holds this run's evidence lock/);
    // NOTHING was written while the other writer held the run.
    expect(existsSync(path.join(root, "evidence", "run-l.b12.pilot.json"))).toBe(false);
    held.release();
    await appendPilotRecord(root, "run-l", record, { lockAttempts: 2, lockWaitMs: 1 });
    expect(
      JSON.parse(await fs.readFile(path.join(root, "evidence", "run-l.b12.pilot.json"), "utf8")).observations
    ).toHaveLength(1);
  });

  it("the registration guard: one act, byte-identical bytes, and a prefix-preserved register", async () => {
    // voidConditions 1 registers a run as the manifest committed AND its row
    // written "by the same command" — so the guard proves the SAME introducing
    // commit, holds the manifest byte-identical across disk/HEAD/registration,
    // and reads MEASUREMENTS.jsonl by PREFIX, because appends after
    // registration are lawful and whole-file identity would refuse them.
    const { registrationGuard } = await import("../scripts/b12-run.mjs");
    const { execFile: ef } = await import("node:child_process");
    const { promisify: p } = await import("node:util");
    const sh = p(ef);
    const git = async (cwd: string, ...args: string[]) => (await sh("git", args, { cwd })).stdout.trim();

    const root = tempRoot();
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "guard-oracle");
    await git(root, "config", "user.email", "guard@example.invalid");
    await git(root, "config", "core.autocrlf", "false");
    await git(root, "config", "commit.gpgsign", "false");

    const manifestRel = "evidence/run-g.b12.tasks.json";
    const manifestBytes = `{"runId":"run-g","tasks":[{"id":"t1"}]}\n`;
    const regRow = `{"ts":"2026-08-09T00:00:00Z","b12_registration":true,"run_id":"run-g"}\n`;
    await fs.mkdir(path.join(root, "evidence"), { recursive: true });
    await fs.writeFile(path.join(root, manifestRel), manifestBytes, "utf8");
    await fs.writeFile(path.join(root, "MEASUREMENTS.jsonl"), regRow, "utf8");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "the registration act");

    // POSITIVE: one act, coherent everywhere.
    expect(registrationGuard(root, "run-g", manifestBytes)).toEqual([]);

    // POSITIVE with a lawful post-registration append on disk.
    await fs.appendFile(path.join(root, "MEASUREMENTS.jsonl"), `{"metric":"later","run_id":"other"}\n`, "utf8");
    expect(registrationGuard(root, "run-g", manifestBytes)).toEqual([]);

    // NEGATIVE: an unregistered run.
    expect(registrationGuard(root, "run-h", manifestBytes).join(" ")).toMatch(/0 registration row/);

    // NEGATIVE: a manifest and a row born in SEPARATE commits — two acts.
    const manifest2 = "evidence/run-i.b12.tasks.json";
    await fs.writeFile(path.join(root, manifest2), `{"runId":"run-i","tasks":[{"id":"t1"}]}\n`, "utf8");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "manifest alone");
    await fs.appendFile(
      path.join(root, "MEASUREMENTS.jsonl"),
      `{"ts":"2026-08-09T00:01:00Z","b12_registration":true,"run_id":"run-i"}\n`,
      "utf8"
    );
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "row alone");
    expect(registrationGuard(root, "run-i", `{"runId":"run-i","tasks":[{"id":"t1"}]}\n`).join(" ")).toMatch(
      /two commits are two acts/
    );

    // NEGATIVE: the working tree rewrites the register instead of appending.
    await fs.writeFile(path.join(root, "MEASUREMENTS.jsonl"), `{"rewritten":true}\n`, "utf8");
    expect(registrationGuard(root, "run-g", manifestBytes).join(" ")).toMatch(/does not preserve HEAD's content as a byte prefix/);
  }, 30_000);

  it("a REFUSED observation leaves no worktree behind — the tree is owned from its first byte", async () => {
    // R14's second finding: `observe` created the `.b12` worktree BEFORE the
    // prompt-hash and registration guards, and `refuse()` exits the process,
    // so no `finally` could reach a cleanup. Every retry leaked a full
    // checkout plus a live worktree registration. Both refusals below used to
    // sit past the creation; now they precede it, and an exit hook covers
    // whatever comes after.
    const { execFile: ef } = await import("node:child_process");
    const { promisify: p } = await import("node:util");
    const { createHash: ch } = await import("node:crypto");
    const sh = p(ef);
    const git = async (cwd: string, ...args: string[]) => (await sh("git", args, { cwd })).stdout.trim();

    const harness = path.join(process.cwd(), "scripts", "b12-run.mjs");
    const harnessSha = ch("sha256").update(await fs.readFile(harness)).digest("hex");
    const prompt = "Fix the failing check in t1.";
    const manifestOf = (promptSha: string): Record<string, unknown> => ({
      runId: "run-w",
      pinned: {
        claudeCodeVersion: "2.1.221",
        claudeBinarySha256: "b".repeat(64),
        ratesSha256: "a".repeat(64),
        clientTruncationCap: 30_000,
        pacingCacheWriteShareCeiling: 0.9,
        perTaskDenominatorShareCap: 0.25,
        scoringCommand: "node dist/cost/b12/emit.js run-w",
        b12RunSha256: harnessSha,
        claudeMdSha256: "d".repeat(64),
        settingsSha256s: { settings: null, settingsLocal: null },
        installedCharsProbe: "evidence/probe.json",
        installedCharsProbeSha256: "e".repeat(64),
        policyBlobs: {
          treatment: { repo: "../b12-policy", commit: "f".repeat(40), path: "treatment.md", sha256: "1".repeat(64) },
          control: { repo: "../b12-policy", commit: "f".repeat(40), path: "control.md", sha256: "2".repeat(64) },
        },
        perArmTimeoutMs: 2_700_000,
        extraArgs: [],
      },
      abPairs: ["t1", "t2", "t3"].map((taskId, i) => ({
        id: `pair-${i}`,
        taskId,
        order: i % 2 === 0 ? "treatment-first" : "control-first",
      })),
      tasks: ["t1", "t2", "t3"].map((id) => ({
        id,
        prompt,
        promptSha256: id === "t1" ? promptSha : ch("sha256").update(prompt, "utf8").digest("hex"),
        baseCommit: "0".repeat(40),
        verificationStratum: "types-only",
        expectedSubagentStratum: "solo",
        acceptance: ['node -e "process.exit(0)"'],
        acceptanceExpectedExit: 0,
        verificationCommands: ["npx tsc --noEmit"],
        gateCategory: "types",
        repairMaxRounds: 3,
        fileScope: ["src/tools/"],
      })),
    });

    const root = tempRoot();
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "worktree-oracle");
    await git(root, "config", "user.email", "wt@example.invalid");
    await git(root, "config", "core.autocrlf", "false");
    await git(root, "config", "commit.gpgsign", "false");
    await fs.mkdir(path.join(root, "evidence"), { recursive: true });
    const manifestRel = "evidence/run-w.b12.tasks.json";
    const manifestAbs = path.join(root, manifestRel);
    // A WRONG prompt hash — the manifest is otherwise complete and sealed to
    // this very harness, so the run reaches the prompt check.
    await fs.writeFile(manifestAbs, JSON.stringify(manifestOf("c".repeat(64)), null, 2) + "\n", "utf8");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "the manifest, unregistered");

    const observe = async (): Promise<{ code: number; stderr: string }> => {
      try {
        await sh(process.execPath, [harness, "observe", "--manifest", manifestRel, "--task", "t1"], { cwd: root });
        return { code: 0, stderr: "" };
      } catch (error) {
        const e = error as { code?: number; stderr?: string };
        return { code: e.code ?? -1, stderr: e.stderr ?? "" };
      }
    };
    const noWorktree = async (why: string): Promise<void> => {
      expect({ why, b12: existsSync(path.join(root, ".b12")) }).toEqual({ why, b12: false });
      // `git worktree list` names the main checkout and nothing else.
      expect((await git(root, "worktree", "list")).split("\n").filter(Boolean)).toHaveLength(1);
    };

    const badPrompt = await observe();
    expect(badPrompt.code).not.toBe(0);
    expect(badPrompt.stderr).toMatch(/prompt sha256/);
    await noWorktree("a refused prompt hash");

    // Now the hash is right and the run is simply NOT REGISTERED — the guard
    // the comment always claimed ran "before any worktree".
    await fs.writeFile(
      manifestAbs,
      JSON.stringify(manifestOf(ch("sha256").update(prompt, "utf8").digest("hex")), null, 2) + "\n",
      "utf8"
    );
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "the manifest, still unregistered");
    const unregistered = await observe();
    expect(unregistered.code).not.toBe(0);
    expect(unregistered.stderr).toMatch(/registration guard/);
    await noWorktree("a refused registration guard");

    // R16's other half: a refusal must not leave a CLAIMED evidence attempt
    // behind either. The claim is append-only and the scorer reads an empty
    // one as an observation with no identity — a void bought with a paid
    // session. No attempt reached the claim here, so evidence/<runId>/ holds
    // nothing at all.
    expect(existsSync(path.join(root, "evidence", "run-w"))).toBe(false);
  }, 60_000);

  describe("policy blob provenance — the seal is {repo, commit, path, sha256} and delivery reads the object store", () => {
    // CHANNEL 5 says "committed out-of-repo blob"; the previous schema sealed
    // a live file plus a separate hash, which is committed NOWHERE — editing
    // file and hash together satisfied it. The resolver now reads
    // `git cat-file blob <commit>:<path>` from the policy repo, so every
    // refusal below is a leg of that provenance: shape, containment,
    // transport, encoding, and the sealed hash itself.
    const sh = promisify(execFile);
    const git = async (cwd: string, ...args: string[]) => (await sh("git", args, { cwd })).stdout.trim();
    const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

    const TREATMENT = "You are the treatment arm. Delegate mechanical work.\n";
    const CONTROL = "You are the control arm. Work alone.\n";
    // 0xff is valid in no UTF-8 sequence, so the utf8 round-trip cannot be exact.
    const BINARY = Buffer.from([0x59, 0x6f, 0xff, 0x0a]);

    const policyRepo = async () => {
      const dir = tempRoot();
      await git(dir, "init", "-q");
      await git(dir, "config", "user.name", "policy-oracle");
      await git(dir, "config", "user.email", "policy@example.invalid");
      await git(dir, "config", "core.autocrlf", "false");
      await git(dir, "config", "commit.gpgsign", "false");
      await fs.writeFile(path.join(dir, "treatment.md"), TREATMENT, "utf8");
      await fs.writeFile(path.join(dir, "control.md"), CONTROL, "utf8");
      await fs.writeFile(path.join(dir, "binary.md"), BINARY);
      await git(dir, "add", "-A");
      await git(dir, "commit", "-q", "-m", "the policy pair");
      const commit = await git(dir, "rev-parse", "HEAD");
      return { dir, commit };
    };

    const manifestFor = (repo: string, commit: string, treatmentOver: Record<string, unknown> = {}) => ({
      pinned: {
        policyBlobs: {
          treatment: { repo, commit, path: "treatment.md", sha256: sha(TREATMENT), ...treatmentOver },
          control: { repo, commit, path: "control.md", sha256: sha(CONTROL) },
        },
      },
    });

    it("resolves a clean seal to the exact committed bytes, provenance on the blob", async () => {
      const { findPolicyBlob } = await import("../scripts/b12-run.mjs");
      const { dir, commit } = await policyRepo();
      const { blob, why } = findPolicyBlob(manifestFor(dir, commit), "treatment");
      expect(why).toBeNull();
      expect(blob).not.toBeNull();
      expect(blob!.content).toBe(TREATMENT);
      expect(blob!.sha256).toBe(sha(TREATMENT));
      expect(blob!.commit).toBe(commit);
      expect(blob!.path).toBe("treatment.md");
      expect(blob!.declaredPath).toBe(`${dir}@${commit}:treatment.md`);
      expect(path.isAbsolute(blob!.repoDir)).toBe(true);
    }, 30_000);

    it("refuses a sealed sha the delivered bytes do not hash to", async () => {
      const { findPolicyBlob } = await import("../scripts/b12-run.mjs");
      const { dir, commit } = await policyRepo();
      const { blob, why } = findPolicyBlob(manifestFor(dir, commit, { sha256: "f".repeat(64) }), "treatment");
      expect(blob).toBeNull();
      expect(why).toMatch(/moved under the seal/);
    }, 30_000);

    it("refuses a commit the transported clone does not carry", async () => {
      const { findPolicyBlob } = await import("../scripts/b12-run.mjs");
      const { dir, commit } = await policyRepo();
      const { blob, why } = findPolicyBlob(manifestFor(dir, "deadbeef".repeat(5)), "treatment");
      expect(commit).not.toBe("deadbeef".repeat(5));
      expect(blob).toBeNull();
      expect(why).toMatch(/not reachable in the treatment policy repo/);
    }, 30_000);

    it("refuses a path absent from the sealed commit", async () => {
      const { findPolicyBlob } = await import("../scripts/b12-run.mjs");
      const { dir, commit } = await policyRepo();
      const { blob, why } = findPolicyBlob(manifestFor(dir, commit, { path: "nope.md" }), "treatment");
      expect(blob).toBeNull();
      expect(why).toMatch(/nope\.md is not readable/);
    }, 30_000);

    it("refuses an abbreviated commit — provenance pins the full id", async () => {
      const { findPolicyBlob } = await import("../scripts/b12-run.mjs");
      const { dir, commit } = await policyRepo();
      const { blob, why } = findPolicyBlob(manifestFor(dir, commit.slice(0, 12)), "treatment");
      expect(blob).toBeNull();
      expect(why).toMatch(/FULL 40-hex commit/);
    }, 30_000);

    it("refuses a traversing path — git object paths have one spelling", async () => {
      const { findPolicyBlob } = await import("../scripts/b12-run.mjs");
      const { dir, commit } = await policyRepo();
      const { blob, why } = findPolicyBlob(manifestFor(dir, commit, { path: "../escape.md" }), "treatment");
      expect(blob).toBeNull();
      expect(why).toMatch(/one spelling/);
    }, 30_000);

    it("refuses a policy repo inside the repository under test — CHANNEL 5's wall", async () => {
      const { findPolicyBlob } = await import("../scripts/b12-run.mjs");
      const { commit } = await policyRepo();
      const { blob, why } = findPolicyBlob(manifestFor(".", commit), "treatment");
      expect(blob).toBeNull();
      expect(why).toMatch(/inside the repository under test/);
    }, 30_000);

    it("names the transport step when the locator resolves to nothing", async () => {
      const { findPolicyBlob } = await import("../scripts/b12-run.mjs");
      const { commit } = await policyRepo();
      const missing = path.join(tempRoot(), "never-cloned");
      const { blob, why } = findPolicyBlob(manifestFor(missing, commit), "treatment");
      expect(blob).toBeNull();
      expect(why).toMatch(/transport the hashed policy bundle/);
    }, 30_000);

    it("refuses a shallow clone — an object store that cannot prove its history", async () => {
      const { findPolicyBlob } = await import("../scripts/b12-run.mjs");
      const { dir, commit } = await policyRepo();
      const dest = path.join(tempRoot(), "shallow-clone");
      // A plain local-path clone ignores --depth; the file:// form makes git
      // honour it, which is exactly the clone a careless transport produces.
      const url = "file://" + (path.sep === "/" ? dir : "/" + dir.replace(/\\/g, "/"));
      await sh("git", ["clone", "-q", "--depth", "1", url, dest]);
      const { blob, why } = findPolicyBlob(manifestFor(dest, commit), "treatment");
      expect(blob).toBeNull();
      expect(why).toMatch(/SHALLOW clone/);
    }, 30_000);

    it("refuses bytes that are not UTF-8 text — argv delivery cannot carry them exactly", async () => {
      const { findPolicyBlob } = await import("../scripts/b12-run.mjs");
      const { dir, commit } = await policyRepo();
      const { blob, why } = findPolicyBlob(
        manifestFor(dir, commit, { path: "binary.md", sha256: sha(BINARY) }),
        "treatment"
      );
      expect(blob).toBeNull();
      expect(why).toMatch(/not valid UTF-8 text/);
    }, 30_000);

    it("resolving one arm still requires the OTHER arm's declaration — a pair or nothing", async () => {
      const { findPolicyBlob } = await import("../scripts/b12-run.mjs");
      const { dir, commit } = await policyRepo();
      const m = manifestFor(dir, commit) as { pinned: { policyBlobs: Record<string, unknown> } };
      delete m.pinned.policyBlobs.control;
      const { blob, why } = findPolicyBlob(m, "treatment");
      expect(blob).toBeNull();
      expect(why).toMatch(/policyBlobs\.control/);
      const none = findPolicyBlob({ pinned: {} }, "treatment");
      expect(none.blob).toBeNull();
      expect(none.why).toMatch(/BOTH arms/);
    }, 30_000);

    it("the manifest gap sweep holds the seal's shape without touching git", async () => {
      const { manifestDeclarationGaps } = await import("../scripts/b12-run.mjs");
      const gaps = manifestDeclarationGaps({
        pinned: {
          policyBlobs: {
            treatment: { repo: "../b12-policy", commit: "abc", path: "t.md", sha256: "d" },
            control: null,
          },
        },
      });
      expect(gaps.some((g) => /policyBlobs\.treatment must pin a FULL 40-hex commit/.test(g))).toBe(true);
      expect(gaps.some((g) => /policyBlobs\.control must be a .*provenance tuple/.test(g))).toBe(true);
    });
  });

  it("the two admissionRule-7 implementations agree, case for case", async () => {
    // The harness re-implements the scope grammar because it must run before
    // dist/ exists. Two copies that are never compared is this project's
    // signature defect; this is the comparison.
    const harness = await import("../scripts/b12-run.mjs");
    const scorer = await import("../src/cost/b12/filescope.js");
    const cases = [
      "src/tools/",
      "src/example.ts",
      "src/cost/**",
      "src/cost/",
      "evidence/**",
      "PREMISES.md",
      "scripts/session-token-walk.mjs",
      "src/../src/cost/**",
      "src\\cost\\",
      "C:\\repo\\src",
      "\\\\server\\share",
      "/absolute",
      "a//b",
      "src/*.ts",
      "src/?",
      "src",
      // CASE ALIASES — Windows and default macOS filesystems alias case, so
      // these name protected trees wearing different bytes.
      "SRC/COST/",
      "Src/Cost/inner.ts",
      "EVIDENCE/**",
      "premises.md",
      // WINDOWS PATH ALIASES (R21) — Win32 strips a component's trailing dots
      // and spaces, `:` names an NTFS stream, `NAME~1` is an 8.3 short name.
      // Each of these OPENS a protected path while comparing unequal to it,
      // so the grammar refuses them rather than the comparison folding them.
      "src/cost./**",
      "src/cost /**",
      "STATE.md.",
      "STATE.md ",
      "evidence./",
      "STATE.md::$DATA",
      "scripts/SESSIO~1.MJS",
    ];
    for (const raw of cases) {
      expect({ raw, parsed: harness.parseScopeEntry(raw) }).toEqual({ raw, parsed: scorer.parseScopeEntry(raw) });
    }
    expect(harness.PROTECTED_SCOPES).toEqual([...scorer.PROTECTED_SCOPES]);
    const tasks = cases.map((scope, i) => ({ id: `t${i}`, fileScope: [scope] }));
    expect(harness.fileScopeViolations(tasks)).toEqual(scorer.fileScopeViolations(tasks));
    // And the aliases FIRE, in both implementations alike: a case-folded name
    // for the instrument set is the instrument set.
    for (const impl of [harness, scorer]) {
      const fired = impl.fileScopeViolations([
        { id: "alias-dir", fileScope: ["SRC/COST/"] },
        { id: "alias-file", fileScope: ["Src/Cost/inner.ts"] },
        { id: "alias-doc", fileScope: ["premises.md"] },
      ]);
      expect(fired.join(" ")).toMatch(/alias-dir.*intersects the instrument set at src\/cost/);
      expect(fired.join(" ")).toMatch(/alias-file.*intersects the instrument set at src\/cost/);
      expect(fired.join(" ")).toMatch(/alias-doc.*intersects the instrument set at PREMISES\.md/);
      // R21: the Windows aliases are REFUSED BY THE GRAMMAR, in both copies —
      // `src/cost./**` opens `src/cost` on Windows (reproduced with
      // `Get-Item`) and compares unequal to it, so admitting it as
      // "non-intersecting" would hand a task the scoring instrument.
      const aliased = impl.fileScopeViolations([
        { id: "trailing-dot", fileScope: ["src/cost./**"] },
        { id: "trailing-space", fileScope: ["src/cost /**"] },
        { id: "doc-dot", fileScope: ["STATE.md."] },
        { id: "stream", fileScope: ["STATE.md::$DATA"] },
        { id: "short-name", fileScope: ["scripts/SESSIO~1.MJS"] },
      ]);
      expect(aliased.join(" ")).toMatch(/trailing-dot.*dot or space/);
      expect(aliased.join(" ")).toMatch(/trailing-space.*dot or space/);
      expect(aliased.join(" ")).toMatch(/doc-dot.*dot or space/);
      expect(aliased.join(" ")).toMatch(/stream.*colon in a segment/);
      expect(aliased.join(" ")).toMatch(/short-name.*8\.3 short-name/);
      expect(aliased).toHaveLength(5);
      // …and the lawful spellings of the same names still pass the grammar,
      // so the refusal is aimed at the alias and not at the dot.
      expect(impl.fileScopeViolations([{ id: "ok", fileScope: ["src/tools/", "docs/notes.md", "a.b.c/d.e"] }])).toEqual([]);
    }
  });

  it("mints a UNIQUE session id per attempt and refuses a concurrent same-task acquire — in and across processes", async () => {
    // R7's finding, closed: `stamp()` has one-second resolution, so the old
    // hash input minted the SAME id for two attempts inside a second. The
    // nonce ends it; the lock makes the race a refusal. Both halves here,
    // including a REAL second process against a held lock — `mkdir` is the
    // OS's atomicity, and only another process can prove it cross-process.
    const { mintSessionId, acquireSessionLock } = await import("../scripts/b12-run.mjs");
    const a = mintSessionId("m".repeat(64), "run-x", "t1", "treatment");
    const b = mintSessionId("m".repeat(64), "run-x", "t1", "treatment");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const root = tempRoot();
    const held = acquireSessionLock(root, "run-x", "t1", "treatment");
    expect(held.ok).toBe(true);
    // Same process, second acquire: refused.
    expect(acquireSessionLock(root, "run-x", "t1", "treatment").ok).toBe(false);
    // A DIFFERENT task/arm is not contested.
    const other = acquireSessionLock(root, "run-x", "t2", "treatment");
    expect(other.ok).toBe(true);
    other.release();
    // A real second process against the held lock: refused there too.
    const script = path.join(process.cwd(), "scripts", "b12-run.mjs");
    const probe = await runNode(process.execPath, [
      "-e",
      `import(${JSON.stringify(String(new URL(`file:///${script.split("\\\\").join("/")}`)))}).then(m => process.stdout.write(String(m.acquireSessionLock(${JSON.stringify(root)}, "run-x", "t1", "treatment").ok)))`,
    ]);
    expect(probe.stdout.trim()).toBe("false");
    // Released, the claim is takeable again — by anyone.
    held.release();
    expect(acquireSessionLock(root, "run-x", "t1", "treatment").ok).toBe(true);
  }, 30_000);

  it("rejects a resumed session whose ids came from a sibling worktree — clause 6's two-worktree control", async () => {
    // TWO WORKTREES, TWO SLUGS, both covered by the pre-snapshot — the frozen
    // control's own topology. Worktree A's session already carries `rq-inh-x`;
    // the arm in worktree B RESUMES that session, so B's transcript holds
    // `rq-inh-x` beside its own new `rq-inh-y`. A snapshot of ONE slug returns
    // inherited = 0 for an arm that wrote to another — the check that cannot
    // fail — which is why the fixture must have two.
    const billable = (requestId: string, sessionId: string, ms: number): string =>
      JSON.stringify({
        type: "assistant",
        uuid: `u-${sessionId}-${requestId}`,
        requestId,
        sessionId,
        timestamp: new Date(1_700_000_000_000 + ms).toISOString(),
        message: { model: "test-model", content: [], usage: { output_tokens: 1 } },
      });
    const root = tempRoot();
    const slugA = path.join(root, "worktree-a");
    const slugB = path.join(root, "worktree-b");
    await fs.mkdir(slugA, { recursive: true });
    await fs.mkdir(slugB, { recursive: true });
    await fs.writeFile(path.join(slugA, "sess-a.jsonl"), `${billable("rq-inh-x", "sess-a", 0)}\n`, "utf8");
    await fs.writeFile(path.join(slugB, "sess-b.jsonl"), `${billable("rq-b-base", "sess-b", 1)}\n`, "utf8");

    const { takeSnapshot } = await import("../scripts/b12-run.mjs");
    const before = takeSnapshot(root);
    expect(before.slugs).toEqual(["worktree-a", "worktree-b"]);
    expect(before.requestIds).toContain("rq-inh-x");

    // The resume: worktree B gains the inherited lineage plus one new id.
    await fs.writeFile(
      path.join(slugB, "sess-resumed.jsonl"),
      `${billable("rq-inh-x", "sess-resumed", 2)}\n${billable("rq-inh-y", "sess-resumed", 3)}\n`,
      "utf8"
    );
    const after = takeSnapshot(root);

    // The REAL derivation (`observe`'s own line): the inherited id is NOT
    // originated, BY CONSTRUCTION — the pre-snapshot covered the sibling slug.
    const originated = after.requestIds.filter((id) => !before.requestIds.includes(id));
    expect(originated).toEqual(["rq-inh-y"]);

    // THE CONTROL: a record that CLAIMS the inherited id anyway reaches the
    // scorer with these very snapshots archived, and the cumulative union
    // REJECTS it — `inherited > 0` is void(sibling_inheritance), never scored.
    const narrowed = (s: { ts: string; slugsWalked: number; files: number; requestIds: string[] }) => ({
      ts: s.ts,
      // These machine snapshots were not taken FOR the archived observation,
      // and a wrong stamp would be the cross-wiring the archive reader fires
      // on — a typed absence is the honest value here.
      identity: null,
      slugsWalked: s.slugsWalked,
      files: s.files,
      requestIds: s.requestIds,
    });
    const out = assembleRun({
      archive: archiveOf({
        tasks: [taskOf("t1"), taskOf("t2")],
        observations: [
          // The honest observation: its snapshots are the REAL pair above and
          // its record claims exactly what the derivation returned.
          obsOf("t1", {
            records: [billed("rq-inh-y", "sess-t1-1", 0, { write1h: 100 })],
            record: { originatedRequestIds: ["rq-inh-y"] },
            snapshotBefore: narrowed(before),
            snapshotAfter: narrowed(after),
          }),
          // The hostile one: it claims the id the sibling worktree already held.
          obsOf("t2", {
            records: [billed("rq-inh-x", "sess-t2-1", 10, { write1h: 100 })],
            record: { originatedRequestIds: ["rq-inh-x"] },
          }),
        ],
      }),
      gitAudit: { ran: false },
      scoringCommandActual: PINNED.scoringCommand,
    });
    const cf = (taskId: string) => out.counterfactual.observations.find((o) => o.taskId === taskId);
    expect(cf("t1")?.disposition).toBe("scored");
    expect(cf("t2")?.disposition).toBe("void(sibling_inheritance)");
  });

  it("rejects a run whose snapshot covered fewer slugs than it wrote to — clause 6's slug-coverage control", async () => {
    // The frozen predicate compares POPULATIONS: the pre-snapshot's covered
    // slugs against the slugs the originated ids landed in. The slug COUNT
    // grows here (1 → 2), so the shrink check reads nothing — which is exactly
    // why counts cannot carry this clause.
    const billable = (requestId: string, sessionId: string, ms: number): string =>
      JSON.stringify({
        type: "assistant",
        uuid: `u-${sessionId}-${requestId}`,
        requestId,
        sessionId,
        timestamp: new Date(1_700_000_000_000 + ms).toISOString(),
        message: { model: "test-model", content: [], usage: { output_tokens: 1 } },
      });
    const root = tempRoot();
    const slugA = path.join(root, "worktree-a");
    await fs.mkdir(slugA, { recursive: true });
    await fs.writeFile(path.join(slugA, "sess-a.jsonl"), `${billable("rq-cov-a", "sess-a", 0)}\n`, "utf8");

    const { takeSnapshot, classifyRun } = await import("../scripts/b12-run.mjs");
    const before = takeSnapshot(root);
    expect(before.slugs).toEqual(["worktree-a"]);

    // The arm writes into a slug the pre-snapshot never walked.
    const slugB = path.join(root, "worktree-b");
    await fs.mkdir(slugB, { recursive: true });
    await fs.writeFile(path.join(slugB, "sess-b.jsonl"), `${billable("rq-cov-b", "sess-b", 1)}\n`, "utf8");
    const after = takeSnapshot(root);

    // The attribution `observe` performs, over the snapshot's own populations.
    const originated = after.requestIds.filter((id) => !before.requestIds.includes(id));
    const originatedSet = new Set(originated);
    const writtenSlugs = Object.entries(after.slugRequestIds)
      .filter(([, ids]) => ids.some((id) => originatedSet.has(id)))
      .map(([slug]) => slug);
    expect(writtenSlugs).toEqual(["worktree-b"]);

    const base = {
      exitCode: 0,
      signal: null,
      errorCode: null,
      budgetMs: 1_000,
      budgetEnforced: true,
      originatedCount: originated.length,
      slugsBefore: before.slugsWalked,
      slugsAfter: after.slugsWalked,
    };
    // FIRING: a written slug outside the covered set voids the run — and the
    // shrink reason stays silent, because 1 → 2 is not a shrink.
    const fired = classifyRun({ ...base, coveredSlugs: before.slugs, writtenSlugs });
    expect(fired.valid).toBe(false);
    expect(fired.reasons.join(" ")).toMatch(/covered fewer slugs than the run wrote to/);
    expect(fired.reasons.join(" ")).not.toMatch(/scope shrank/);
    // NOT firing: written ⊆ covered is a clean run.
    const clean = classifyRun({ ...base, coveredSlugs: after.slugs, writtenSlugs });
    expect(clean.valid).toBe(true);
    expect(clean.reasons).toEqual([]);
    // And the rule fails CLOSED when the populations are not handed to it —
    // a coverage predicate that silently skips is the vacuous check the
    // snapshot exists to kill.
    const unhanded = classifyRun({
      ...base,
      coveredSlugs: undefined as unknown as string[],
      writtenSlugs: undefined as unknown as string[],
    });
    expect(unhanded.valid).toBe(false);
    expect(unhanded.reasons.join(" ")).toMatch(/not handed to the rule/);
  });

  it("cannot report a passing pre-flight without a fresh call to check", async () => {
    // The first version asserted NONE of the five conditions the frozen design
    // names and printed PASSED on a machine where all of them fail: 12 ambiguous
    // rows, 4 foreign, 6 sessions withholding. The design's own cost of that is
    // stated -- "the difference between losing ten minutes and losing forty-five
    // sessions plus an attempt" -- so a pre-flight that cannot check must say so
    // rather than pass.
    //
    // Scoping matters as much as the assertions: those 12 ambiguous rows are
    // facts about accumulated continuation lineages, not about whether the join
    // works now. Checked against history the list either always fails or means
    // nothing, so it is checked against ONE scratch session that called the
    // tools -- and with no session id there is nothing to check.
    // Pointed at a fixture, not at this machine's 56 slugs: a check whose cost
    // and result depend on unrelated history is not a check.
    const root = tempRoot();
    const slug = path.join(root, "slug-one");
    await fs.mkdir(slug, { recursive: true });
    await fs.writeFile(
      path.join(slug, "sess-1.jsonl"),
      JSON.stringify({
        type: "assistant",
        uuid: "u1",
        requestId: "req-1",
        sessionId: "sess-1",
        timestamp: new Date(1_700_000_000_000).toISOString(),
        message: { model: "test-model", content: [], usage: { output_tokens: 10 } },
      }) + "\n",
      "utf8"
    );
    const script = path.join(process.cwd(), "scripts", "b12-run.mjs");
    const failure = await runNode(process.execPath, [script, "preflight", "--root", root], {
      cwd: process.cwd(),
    }).catch((e: { code: number; stdout: string }) => e);

    // Exit 1, and it names the check it could not make rather than failing opaquely.
    expect((failure as { code: number }).code).toBe(1);
    expect((failure as { stdout: string }).stdout).toMatch(/FAIL {2}fresh-call assertions ran/);
    // The parts it CAN check still report, so a real failure is distinguishable
    // from "could not look".
    expect((failure as { stdout: string }).stdout).toMatch(/ok {4}snapshot covers every project slug/);
  }, 30_000);

  it("reports a missing claude as a failed check rather than exiting with nothing said", async () => {
    // Every precondition the preflight has is a `check()` that can come back
    // red. The binary was the one that called `process.exit` instead -- so on a
    // machine without `claude` the preflight wrote no checks, no artifact and an
    // EMPTY stdout, withholding the one fact it existed to state. CI is exactly
    // that machine, and it is where this was found: the run that should have
    // said `FAIL  claude on PATH` said nothing.
    //
    // PATH is emptied rather than the lookup stubbed, so this asserts observable
    // behaviour on a machine without the binary instead of behaviour against a
    // seam invented for the test. It is deterministic on a machine that HAS
    // claude, which the CI failure was not.
    const root = tempRoot();
    const slug = path.join(root, "slug-one");
    await fs.mkdir(slug, { recursive: true });
    await fs.writeFile(
      path.join(slug, "sess-1.jsonl"),
      JSON.stringify({
        type: "assistant",
        uuid: "u1",
        requestId: "req-1",
        sessionId: "sess-1",
        timestamp: new Date(1_700_000_000_000).toISOString(),
        message: { model: "test-model", content: [], usage: { output_tokens: 10 } },
      }) + "\n",
      "utf8"
    );
    const emptyDir = tempRoot();
    await fs.mkdir(emptyDir, { recursive: true });
    // Every spelling of PATH is dropped, not just the uppercase one: Windows
    // carries `Path`, and leaving it in place would spread the real PATH back in
    // beside the empty one and let the lookup succeed on some platforms only.
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^path$/i.test(k)) env[k] = v;
    env.PATH = emptyDir;

    const script = path.join(process.cwd(), "scripts", "b12-run.mjs");
    const failure = await runNode(process.execPath, [script, "preflight", "--root", root], {
      cwd: process.cwd(),
      env,
    }).catch((e: { code: number; stdout: string }) => e);

    expect((failure as { code: number }).code).toBe(1);
    expect((failure as { stdout: string }).stdout).toMatch(/FAIL {2}claude on PATH/);
    // And the rest of the preflight still runs, so the artifact names what is
    // wrong instead of being absent.
    expect((failure as { stdout: string }).stdout).toMatch(/ok {4}snapshot covers every project slug/);
  }, 30_000);

  it("refuses a snapshot that found nothing rather than reporting an empty machine", async () => {
    // A snapshot returning zero ids is a scoping error -- four worktrees mean
    // four slugs, and a run scored against the wrong tree returns a confident
    // 0.0000 on every observation, which is a FALL on the primary instrument.
    const root = tempRoot();
    await fs.mkdir(path.join(root, "empty-slug"), { recursive: true });
    const script = path.join(process.cwd(), "scripts", "b12-run.mjs");
    await expect(
      runNode(process.execPath, [script, "snapshot", "--root", root], { cwd: process.cwd() })
    ).rejects.toThrow(/REFUSED/);
  });

  describe("the UNIT-5 pass: the re-run directory grammar, round-tripped", () => {
    // `admissionRule` 12 archives BOTH attempts; one directory name per
    // task/arm cannot hold two, so the harness suffixes re-runs and the
    // scorer's `parseObsDirName` must read the same grammar back — two halves
    // of one rule, compared here so they cannot drift apart.
    it("what the harness writes, the scorer parses — and a first attempt keeps its name", async () => {
      const { obsDirName } = await import("../scripts/b12-run.mjs");
      const { parseObsDirName } = await import("../src/cost/b12/archive.js");
      expect(obsDirName("t1", "treatment", 1)).toBe("obs-t1-treatment");
      expect(parseObsDirName(obsDirName("t1", "treatment", 1))).toEqual({
        taskId: "t1",
        arm: "treatment",
        attempt: 1,
      });
      expect(parseObsDirName(obsDirName("fix-the-parser", "control", 3))).toEqual({
        taskId: "fix-the-parser",
        arm: "control",
        attempt: 3,
      });
    });

    it("the negative control: a name neither side owns parses to nothing", async () => {
      const { parseObsDirName } = await import("../src/cost/b12/archive.js");
      // `-r1` is a name the harness NEVER writes (attempt 1 is unsuffixed), so
      // accepting it would let a fabricated duplicate directory shadow a first
      // attempt.
      expect(parseObsDirName("obs-t1-treatment-r1")).toBeNull();
    });

    it("claimObsDir claims atomically — an existing attempt is never reused, never clobbered", async () => {
      // The third adversarial round: exists-then-create let two observes pick
      // one directory and overwrite each other's six files. The non-recursive
      // mkdir IS the claim; a second caller gets the next attempt.
      const { claimObsDir } = await import("../scripts/b12-run.mjs");
      const root = makeTempRoot("b12-claim-");
      try {
        const first = claimObsDir(root, "t1", "treatment");
        const second = claimObsDir(root, "t1", "treatment");
        const third = claimObsDir(root, "t1", "treatment");
        expect(first.attempt).toBe(1);
        expect(second.attempt).toBe(2);
        expect(third.attempt).toBe(3);
        expect(new Set([first.dir, second.dir, third.dir]).size).toBe(3);
        expect(path.basename(second.dir)).toBe("obs-t1-treatment-r2");
      } finally {
        await removeTempRoot(root);
      }
    });
  });

  /**
   * SIXTY SECONDS, and the reason is measured (R46).
   *
   * These guards build REAL git repositories in temp directories and spawn
   * dozens of `git` processes each. Under vitest's 5s default they pass on an
   * idle machine and time out on a busy one — then teardown races the still-
   * running child and fails with `EBUSY: rmdir`. That is the whole of the
   * intermittency chased across R42–R45: not racy-clean, not `makePristine`
   * residue, not ordering. A load-sensitive budget.
   *
   * It mattered beyond this file: `tests/cost-meter.test.ts` is a
   * CONFORMANCE_FILE, and `--attest-suite` runs it in a clean worktree
   * REQUIRING exit 0 — so clause 6's attestation was load-sensitive too.
   *
   * The number matches what `tests/b12-audit.test.ts` already gives its own
   * git-heavy e2e tests. This is the house figure, not a new one.
   */
  describe("the F24 pass: every new guard shown FIRING", { timeout: 60_000 }, () => {
    // The house rule — `DECISIONS.md § a check that cannot fail is worse than no
    // check` — applied to the guards this pass added, the same shape VOID 6
    // demands of the meter's own six controls. All on the exported pure
    // functions: the `classifyRun` precedent, testable without a session.
    const load = async () => import("../scripts/b12-run.mjs");

    // A COHERENT artifact, because the validator RECOMPUTES instead of
    // trusting: the third adversarial round found the old shape — summary
    // fields read on faith — meant a committed JSON with a fabricated delta
    // calibrated every treatment observation. `pairs` is one
    // [treatmentPromptTokens, controlPromptTokens] per replicate; every
    // derived field (deltas, sustained, adapter, raw records) follows from it,
    // so a test that wants incoherence must INTRODUCE it, visibly.
    const rawFor = (sessionId: string, requestId: string, input: number, cacheCreation: number, cacheRead: number) =>
      JSON.stringify({
        type: "assistant",
        sessionId,
        requestId,
        uuid: `u-${requestId}`,
        message: {
          model: "test-model",
          usage: {
            input_tokens: input,
            cache_creation_input_tokens: cacheCreation,
            cache_read_input_tokens: cacheRead,
            output_tokens: 4,
          },
        },
      });
    const armRecord = (arm: string, n: number, promptTokens: number) => {
      const input = 2;
      const cacheCreation = 0;
      const cacheRead = promptTokens - input;
      const sessionId = `sess-${arm}-${n}`;
      const requestId = `req-${arm}-${n}`;
      return {
        arm,
        replicate: n,
        sessionId,
        first: { requestId, model: "test-model", input, cacheCreation, cacheRead },
        firstRecordRaw: rawFor(sessionId, requestId, input, cacheCreation, cacheRead),
        promptTokens,
      };
    };
    const probe = (pairs: Array<[number, number]> = [
      [22_099, 22_015],
      [22_099, 22_015],
      [22_099, 22_015],
    ]) => {
      const replicates = pairs.map(([t, c], i) => ({
        replicate: i + 1,
        treatment: armRecord("treatment", i + 1, t),
        control: armRecord("control", i + 1, c),
        deltaTokens: t - c,
      }));
      const deltas = pairs.map(([t, c]) => t - c);
      const sustained = deltas.every((d) => d === deltas[0]) && (deltas[0] as number) >= 0;
      return {
        runId: "probe-run-id",
        sustained,
        deltasTokens: deltas,
        deltaTokens: deltas[0],
        installedCharsAdapter: Math.round((deltas[0] as number) * 3.7 * 10) / 10,
        preDeclaration: "PREMISES.md § B12 — test fixture",
        proofSession: {
          sessionId: "sess-proof",
          toolsCalled: ["ToolSearch", "mcp__local-coder__status"],
        },
        context: {
          commit: "fixture-commit",
          claudeBinarySha256: "bin-sha",
          mcpConfigSha256: "mcp-sha",
          // DUAL — both arms deliver their own blob, so both are key components.
          policyBlobSha256s: {
            treatment: null as string | null,
            control: null as string | null,
          },
          prompt: "Reply with exactly: ok. Do not use any tools.",
          argvShape: {
            treatment: "claude --print --session-id <id> --strict-mcp-config --mcp-config <cfg> --output-format json -- <prompt>",
            control: "claude --print --session-id <id> --strict-mcp-config --output-format json -- <prompt>",
          },
        },
        replicates,
      };
    };
    const live = () => ({
      binarySha256: "bin-sha",
      mcpConfigSha256: "mcp-sha" as string | null,
      policyBlobSha256s: {
        treatment: null as string | null,
        control: null as string | null,
      },
      extraArgs: [] as string[],
    });

    it("accepts a matching key and returns the provenance-carrying record", async () => {
      const { validateInstalledCharsProbe } = await load();
      const rec = validateInstalledCharsProbe(probe(), live());
      expect(rec.value).toBe(310.8);
      expect(rec.deltaTokens).toBe(84);
      expect(rec.probeRunId).toBe("probe-run-id");
      expect(rec.calibrationKey.policyBlobSha256s).toEqual({ treatment: null, control: null });
      // The protocol is the artifact's own registered reference, never a
      // fallback — the old default labelled missing provenance as valid.
      expect(rec.calibrationKey.protocol).toBe("PREMISES.md § B12 — test fixture");
    });

    it("accepts a sustained ZERO delta — zero-measured is not zero-defaulted", async () => {
      // The domain guard refuses ABSENCE, not smallness. A probe that measured
      // nothing resident is a measurement, carries provenance, and must pass —
      // this is the positive control proving the guard tells the two zeros apart.
      const { validateInstalledCharsProbe } = await load();
      const p = probe([
        [22_099, 22_099],
        [22_099, 22_099],
        [22_099, 22_099],
      ]);
      expect(validateInstalledCharsProbe(p, live()).value).toBe(0);
    });

    it("fires on a negative recomputed delta — reversed arms cannot calibrate", async () => {
      const { validateInstalledCharsProbe } = await load();
      const p = probe([
        [22_015, 22_099],
        [22_015, 22_099],
        [22_015, 22_099],
      ]);
      expect(() => validateInstalledCharsProbe(p, live())).toThrow(/negative/);
    });

    it("fires when the summary delta is fabricated over honest records", async () => {
      // THE THIRD ROUND'S CENTRAL CASE: records saying 84 with a summary saying
      // anything else. The old validator read only the summary.
      const { validateInstalledCharsProbe } = await load();
      const p = probe() as Record<string, unknown>;
      p.deltaTokens = 100;
      p.installedCharsAdapter = 370;
      expect(() => validateInstalledCharsProbe(p, live())).toThrow(/recomputed replicate delta/);
      const p2 = probe() as Record<string, unknown>;
      p2.deltasTokens = [100, 100, 100];
      expect(() => validateInstalledCharsProbe(p2, live())).toThrow(/summary and the records disagree/);
      const p3 = probe([
        [22_099, 22_015],
        [22_100, 22_015],
        [22_099, 22_015],
      ]) as Record<string, unknown>;
      p3.sustained = true; // claimed over 84/85/84
      expect(() => validateInstalledCharsProbe(p3, live())).toThrow(/claim is not the measurement/);
    });

    it("fires on a non-finite or absent summary delta", async () => {
      const { validateInstalledCharsProbe } = await load();
      const withNaN = probe() as Record<string, unknown>;
      withNaN.deltaTokens = Number.NaN;
      expect(() => validateInstalledCharsProbe(withNaN, live())).toThrow(/non-finite/);
      const absent = probe() as Record<string, unknown>;
      delete absent.deltaTokens;
      expect(() => validateInstalledCharsProbe(absent, live())).toThrow(/absent or non-finite/);
    });

    it("fires on an unsustained probe — the pre-declared branch is retract, not reuse", async () => {
      const { validateInstalledCharsProbe } = await load();
      const p = probe([
        [22_099, 22_015],
        [22_100, 22_015],
        [22_099, 22_015],
      ]);
      expect(p.sustained).toBe(false); // the fixture computed it honestly
      expect(() => validateInstalledCharsProbe(p, live())).toThrow(/did not sustain/);
    });

    it("fires on every incoherence between the records and their copies", async () => {
      const { validateInstalledCharsProbe } = await load();
      // No replicates at all — the summary has nothing to be re-verified against.
      const bare = probe() as Record<string, unknown>;
      delete bare.replicates;
      expect(() => validateInstalledCharsProbe(bare, live())).toThrow(/no replicate records/);
      // k is a CHOSEN constant: 3, exactly.
      expect(() =>
        validateInstalledCharsProbe(
          probe([
            [22_099, 22_015],
            [22_099, 22_015],
          ]),
          live()
        )
      ).toThrow(/k is 3/);
      // A promptTokens copy that disagrees with its own components.
      const badCopy = probe();
      badCopy.replicates[0]!.control.promptTokens = 22_016;
      expect(() => validateInstalledCharsProbe(badCopy, live())).toThrow(/own copies disagree/);
      // Raw evidence disagreeing with the extraction (components kept
      // internally consistent so the raw check is what fires).
      const badRaw = probe();
      badRaw.replicates[0]!.treatment.first.cacheRead += 1;
      badRaw.replicates[0]!.treatment.promptTokens += 1;
      expect(() => validateInstalledCharsProbe(badRaw, live())).toThrow(/firstRecordRaw usage/);
      // A reused session id — a resumed session is not a fresh one.
      const reused = probe();
      reused.replicates[1]!.control = armRecord("control", 1, 22_015);
      expect(() => validateInstalledCharsProbe(reused, live())).toThrow(/distinct session ids/);
      // Arms of one replicate on different models.
      const mixed = probe();
      mixed.replicates[2]!.control.first.model = "other-model";
      expect(() => validateInstalledCharsProbe(mixed, live())).toThrow(/different models/);
    });

    it("fires on protocol metadata that is missing or wrong-shaped", async () => {
      const { validateInstalledCharsProbe } = await load();
      // Missing preDeclaration: the old fallback labelled this VALID.
      const noProto = probe() as Record<string, unknown>;
      delete noProto.preDeclaration;
      expect(() => validateInstalledCharsProbe(noProto, live())).toThrow(/names no registered protocol/);
      // A control arm whose argv carries the server config is two treatments.
      const badShape = probe();
      badShape.context.argvShape.control = badShape.context.argvShape.treatment;
      expect(() => validateInstalledCharsProbe(badShape, live())).toThrow(/control argv shape/);
    });

    it("requires the proof session and the producing commit — the registered method's own pieces", async () => {
      // The sixth round asked the validator to seal the protocol harder. The
      // pieces the REGISTERED method actually names are checked: the committed
      // MEASUREMENTS row says "proof session showed mcp__local-coder__status
      // callable", and names the producing script at its commit. The wider
      // demands — exact prompt text, byte-exact argv — were DECLINED as
      // minting: the pre-declaration fixes "identical but for the arm", not a
      // prompt string.
      const { validateInstalledCharsProbe } = await load();
      const noProof = probe() as Record<string, unknown>;
      delete noProof.proofSession;
      expect(() => validateInstalledCharsProbe(noProof, live())).toThrow(/no proofSession/);
      const noStatus = probe();
      noStatus.proofSession.toolsCalled = ["ToolSearch"];
      expect(() => validateInstalledCharsProbe(noStatus, live())).toThrow(/installation was never proven/);
      // The proof is a SEPARATE session — an id shared with a replicate says
      // the proof rode inside an arm.
      const shared = probe();
      shared.proofSession.sessionId = shared.replicates[0]!.treatment.sessionId;
      expect(() => validateInstalledCharsProbe(shared, live())).toThrow(/SEPARATE session/);
      const noCommit = probe() as { context: Record<string, unknown> };
      delete noCommit.context.commit;
      expect(() => validateInstalledCharsProbe(noCommit, live())).toThrow(/no producing commit/);
    });

    it("refuses ids that are not safe path segments — the recursive delete's first wall", async () => {
      // The sixth round's traversal finding: task.id is interpolated into the
      // worktree path that gets rmSync'd recursively, and runId names
      // evidence/<runId>/… — an id of `../../target` escaped `.b12/`.
      const { manifestDeclarationGaps } = await load();
      const traversal = completeManifest();
      (traversal.tasks[0] as Record<string, unknown>).id = "../../target";
      expect(manifestDeclarationGaps(traversal).some((g) => /not a safe path segment/.test(g))).toBe(true);
      const badRun = completeManifest() as Record<string, unknown>;
      badRun.runId = "../evil";
      expect(manifestDeclarationGaps(badRun).some((g) => /runId.*safe path segment/.test(g))).toBe(true);
      const noRun = completeManifest() as Record<string, unknown>;
      delete noRun.runId;
      expect(manifestDeclarationGaps(noRun).some((g) => /runId/.test(g))).toBe(true);
    });

    it("fires when the binary moved under the calibration key", async () => {
      const { validateInstalledCharsProbe } = await load();
      expect(() => validateInstalledCharsProbe(probe(), { ...live(), binarySha256: "other-bin" })).toThrow(
        /binary sha256/
      );
    });

    it("fires when the manifest seals a TREATMENT blob the probe never saw", async () => {
      // The committed probe pre-dates any sealed blob, so the first manifest
      // that carries blobs MUST refuse until a re-probe exists — this refusal
      // is the mechanism that keeps the re-take rule from being forgotten.
      // SEPARATE controls per arm: one arm's blob moving shifts the measured
      // delta without touching the other's, so each mismatch is its own guard.
      const { validateInstalledCharsProbe } = await load();
      const moved = { ...live(), policyBlobSha256s: { treatment: "sealed-blob-sha", control: null } };
      expect(() => validateInstalledCharsProbe(probe(), moved)).toThrow(/treatment policy-blob .* re-probe/);
    });

    it("fires when the manifest seals a CONTROL blob the probe never saw", async () => {
      const { validateInstalledCharsProbe } = await load();
      const moved = { ...live(), policyBlobSha256s: { treatment: null, control: "sealed-blob-sha" } };
      expect(() => validateInstalledCharsProbe(probe(), moved)).toThrow(/control policy-blob .* re-probe/);
    });

    it("fires on a probe still carrying the SINGULAR pre-dual key — the schema names the re-probe", async () => {
      // The committed 2026-08-08 evidence artifact has `policyBlobSha256: null`
      // and no per-arm component; every registrable manifest now seals blobs,
      // so that artifact can never calibrate again and the validator says WHY.
      const { validateInstalledCharsProbe } = await load();
      const p = probe() as { context: Record<string, unknown> };
      delete p.context.policyBlobSha256s;
      p.context.policyBlobSha256 = null;
      expect(() => validateInstalledCharsProbe(p, live())).toThrow(/no per-arm policy-blob component .* re-probe/);
    });

    it("fires when the manifest pins extraArgs the probe ran without", async () => {
      const { validateInstalledCharsProbe } = await load();
      expect(() => validateInstalledCharsProbe(probe(), { ...live(), extraArgs: ["--model", "x"] })).toThrow(
        /extraArgs/
      );
    });

    it("fires when the recomputed adapter disagrees with the artifact's copy", async () => {
      const { validateInstalledCharsProbe } = await load();
      expect(() => validateInstalledCharsProbe({ ...probe(), installedCharsAdapter: 311 }, live())).toThrow(
        /adapter disagrees/
      );
    });

    // A manifest that satisfies the FULL design.artifacts 1 sweep. Kept in one
    // place so stripping a single field is provably the only difference.
    const completeManifest = () => ({
      runId: "run-01",
      abPairs: [
        { id: "p1", taskId: "t1", order: "treatment-first" },
        { id: "p2", taskId: "t1", order: "control-first" },
        { id: "p3", taskId: "t1", order: "treatment-first" },
      ],
      pinned: {
        claudeCodeVersion: "9.9.9",
        claudeBinarySha256: "bin-sha",
        ratesSha256: "rates-sha",
        clientTruncationCap: 30_000,
        pacingCacheWriteShareCeiling: 0.5,
        perTaskDenominatorShareCap: 0.25,
        scoringCommand: "node dist/cost/cli.js --score",
        b12RunSha256: "harness-sha",
        claudeMdSha256: "claudemd-sha",
        settingsSha256s: { settings: null, settingsLocal: null },
        installedCharsProbe: "evidence/probe.json",
        installedCharsProbeSha256: "probe-sha",
        policyBlobs: {
          treatment: { repo: "../b12-policy", commit: "a".repeat(40), path: "treatment.md", sha256: "b".repeat(64) },
          control: { repo: "../b12-policy", commit: "a".repeat(40), path: "control.md", sha256: "c".repeat(64) },
        },
      },
      tasks: [
        {
          id: "t1",
          prompt: "fix it",
          promptSha256: "abc",
          baseCommit: "deadbeef",
          verificationStratum: "test-red",
          expectedSubagentStratum: "solo",
          acceptance: ["npm test"],
          acceptanceExpectedExit: 0,
          verificationCommands: ["npx tsc --noEmit"],
          gateCategory: "all",
          repairMaxRounds: 3,
          fileScope: ["src/a.ts"],
        },
      ],
    });

    it("reports no gaps on the full artifact-1 inventory — the green path exists", async () => {
      const { manifestDeclarationGaps } = await load();
      expect(manifestDeclarationGaps(completeManifest())).toHaveLength(0);
    });

    it("a duplicated task id is a declaration gap — one id, one declaration", async () => {
      // The seventh adversarial round: the scorer's by-id joins collapse
      // duplicates by POSITION, so the duplication is refused here, in the
      // pre-registration window, before anything is spent under a contested id.
      const { manifestDeclarationGaps } = await load();
      const m = completeManifest();
      m.tasks.push({ ...m.tasks[0]! });
      const gaps = manifestDeclarationGaps(m);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatch(/task t1 is declared more than once.*one id, one declaration/);
    });

    it("fires one gap per stripped declaration, each citing the clause that requires it", async () => {
      // FIRST shipped checking three task fields; the adversarial review found
      // the omission decides real outcomes (a task with no acceptance predicate
      // archived accepted: null while remaining valid — unscorable under
      // admissionRule 3 after the session was spent). Every row here is a
      // guard shown FIRING; the justification classes stay SEPARATE — F25 for
      // verificationStratum, artifact-1 completeness for the rest.
      const { manifestDeclarationGaps } = await load();
      // Stripping the task id is tested apart: it also orphans the abPairs
      // task references, so ONE strip fires BOTH gap classes — which is the
      // guard working, not the test failing.
      const noId = completeManifest();
      delete (noId.tasks[0] as Record<string, unknown>).id;
      const idGaps = manifestDeclarationGaps(noId);
      expect(idGaps.some((g) => /carries no id/.test(g))).toBe(true);
      expect(idGaps.some((g) => /not in the manifest/.test(g))).toBe(true);
      const taskCases: Array<[string, RegExp]> = [
        ["prompt", /carries no prompt/],
        ["verificationStratum", /verificationStratum.*F25/],
        ["expectedSubagentStratum", /expectedSubagentStratum.*by analogy/],
        ["promptSha256", /promptSha256.*not compared-if-present/],
        ["acceptance", /acceptance predicate.*admissionRule 3/],
        ["acceptanceExpectedExit", /acceptanceExpectedExit.*expected exit code/],
        ["verificationCommands", /verificationCommands.*verification command string/],
        ["gateCategory", /gateCategory.*frozen gate/],
        ["repairMaxRounds", /repairMaxRounds.*max_rounds/],
        ["fileScope", /fileScope.*admissionRule 7/],
        ["baseCommit", /baseCommit.*base commit SHA/],
      ];
      for (const [field, expected] of taskCases) {
        const m = completeManifest();
        delete (m.tasks[0] as Record<string, unknown>)[field];
        const gaps = manifestDeclarationGaps(m);
        expect.soft(gaps, `stripping task.${field} fired no gap`).toHaveLength(1);
        expect.soft(gaps[0], `task.${field}'s gap cites the wrong clause`).toMatch(expected);
      }
      const pinnedCases: Array<[string, RegExp]> = [
        ["claudeCodeVersion", /claudeCodeVersion/],
        ["claudeBinarySha256", /claudeBinarySha256/],
        ["ratesSha256", /ratesSha256/],
        ["clientTruncationCap", /clientTruncationCap.*voidConditions 8/],
        ["pacingCacheWriteShareCeiling", /CHOSEN constants/],
        ["perTaskDenominatorShareCap", /CHOSEN constant/],
        ["scoringCommand", /scoringCommand.*voidConditions 19/],
        ["b12RunSha256", /b12RunSha256.*scripts\/b12-run\.mjs/],
        ["claudeMdSha256", /claudeMdSha256/],
        ["settingsSha256s", /settings and settingsLocal/],
        ["installedCharsProbe", /no provenance/],
        ["installedCharsProbeSha256", /not provenance/],
        ["policyBlobs", /policyBlobs.*per-arm policy blobs/],
      ];
      for (const [field, expected] of pinnedCases) {
        const m = completeManifest();
        delete (m.pinned as Record<string, unknown>)[field];
        const gaps = manifestDeclarationGaps(m);
        expect.soft(gaps, `stripping pinned.${field} fired no gap`).toHaveLength(1);
        expect.soft(gaps[0], `pinned.${field}'s gap cites the wrong clause`).toMatch(expected);
      }
      const noPairs = completeManifest() as Record<string, unknown>;
      delete noPairs.abPairs;
      expect(manifestDeclarationGaps(noPairs)[0]).toMatch(/abPairs.*ABBA/);
    });

    it("validates the A/B pair schema instead of accepting any array", async () => {
      // A fourth adversarial round found `Array.isArray` letting an empty or
      // malformed pair list through — sessions could be spent against a
      // manifest whose A/B can never validate (voidConditions 21 voids fewer
      // than 3 complete pairs). Each schema guard shown FIRING:
      const { manifestDeclarationGaps } = await load();
      const withPairs = (pairs: unknown) => {
        const m = completeManifest() as Record<string, unknown>;
        m.abPairs = pairs;
        return m;
      };
      expect(manifestDeclarationGaps(withPairs([]))[0]).toMatch(/at least 3 pairs/);
      const dup = manifestDeclarationGaps(
        withPairs([
          { id: "p1", taskId: "t1", order: "treatment-first" },
          { id: "p1", taskId: "t1", order: "control-first" },
          { id: "p3", taskId: "t1", order: "treatment-first" },
        ])
      );
      expect(dup.some((g) => /duplicates pair id p1/.test(g))).toBe(true);
      const ghost = manifestDeclarationGaps(
        withPairs([
          { id: "p1", taskId: "t1", order: "treatment-first" },
          { id: "p2", taskId: "t-ghost", order: "control-first" },
          { id: "p3", taskId: "t1", order: "treatment-first" },
        ])
      );
      expect(ghost.some((g) => /t-ghost.*not in the manifest/.test(g))).toBe(true);
      const orderless = manifestDeclarationGaps(
        withPairs([
          { id: "p1", taskId: "t1", order: "treatment-first" },
          { id: "p2", taskId: "t1", order: "control-first" },
          { id: "p3", taskId: "t1" },
        ])
      );
      expect(orderless.some((g) => /declares no arm order/.test(g))).toBe(true);
      // Both orders must occur — the necessary condition of ANY "ABBA" reading;
      // the exact sequence pattern stays with the A/B pass's adjudication.
      const oneSided = manifestDeclarationGaps(
        withPairs([
          { id: "p1", taskId: "t1", order: "treatment-first" },
          { id: "p2", taskId: "t1", order: "treatment-first" },
          { id: "p3", taskId: "t1", order: "treatment-first" },
        ])
      );
      expect(oneSided.some((g) => /only one arm order/.test(g))).toBe(true);
    });

    it("refuses a treatment invocation that breaks the committed order, from the persisted runlog", async () => {
      // voidConditions 3: "the manifest's committed order was not followed" —
      // checkable BEFORE the session is spent, because the runlog persists
      // progress. Control rows are ignored (the A/B runs post-verdict, its
      // sequencing blocked with VOID 21's adjudication), and a duplicate task
      // is NOT an order violation — admissionRule 12 adjudicates re-runs at
      // scoring.
      const { committedOrderViolation } = await load();
      const manifest = { tasks: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] };
      const row = (taskId: string, arm: string) => JSON.stringify({ taskId, arm }) + "\n";
      // In order: t1 ran, t2 next — fine; re-running t2 right after t2 — fine.
      expect(committedOrderViolation(manifest, "t2", row("t1", "treatment"))).toBeNull();
      expect(committedOrderViolation(manifest, "t2", row("t1", "treatment") + row("t2", "treatment"))).toBeNull();
      // THE FIFTH ROUND'S COUNTEREXAMPLES — skipping fired nothing, because the
      // monotonic half alone has no rows to compare against:
      // a FIRST run of t2 on an EMPTY log skips t1 — FIRES.
      expect(committedOrderViolation(manifest, "t2", "")).toMatch(/predecessor task\(s\) t1 have not run/);
      // t3 after only t1 skips t2 — FIRES, naming the missing predecessor.
      expect(committedOrderViolation(manifest, "t3", row("t1", "treatment"))).toMatch(/predecessor task\(s\) t2 have not run/);
      // The other half still fires: predecessors complete but a LATER task
      // already ran and t2 was never run — a first run out of sequence, only
      // reachable on a log an unguarded harness produced.
      expect(
        committedOrderViolation(manifest, "t2", row("t1", "treatment") + row("t3", "treatment"))
      ).toMatch(/would first-run after t3/);
      // And a LATE RE-RUN of an earlier task is NOT an order event — the first
      // shape of this guard refused it, an over-strictness corrected in the
      // same round: admissionRule 12 has no temporal clause, and the count is
      // adjudicated at scoring over this same runlog.
      expect(
        committedOrderViolation(manifest, "t2", row("t1", "treatment") + row("t2", "treatment") + row("t3", "treatment"))
      ).toBeNull();
      // A control row is not primary progress: t1 ran, t3's control ran (the
      // post-verdict A/B), t2 first-runs fine.
      expect(committedOrderViolation(manifest, "t2", row("t1", "treatment") + row("t3", "control"))).toBeNull();
      // Corrupt progress is a refusal, never a silent skip.
      expect(committedOrderViolation(manifest, "t2", "not json\n")).toMatch(/not JSON/);
      // An empty log constrains only the first task's first run.
      expect(committedOrderViolation(manifest, "t1", "")).toBeNull();
    });

    it("holds the next task at artifact 6's barrier until the predecessor's runlog row is COMMITTED", async () => {
      // A runlog row is appended BEFORE its evidence commit; between the two
      // it is an apparent predecessor with nothing durable behind it — and a
      // failed commit leaves it that way forever. The barrier: disk and HEAD
      // must carry the SAME runlog bytes before any observation spends
      // anything. Both directions refuse.
      const { runlogBarrierViolation } = await load();
      const committed = `{"taskId":"t1","arm":"treatment"}\n`;
      // The first observation: nothing anywhere — free.
      expect(runlogBarrierViolation(null, null)).toBeNull();
      // Between observations: disk equals HEAD — free.
      expect(runlogBarrierViolation(committed, committed)).toBeNull();
      // A row appended but never committed — FIRES, naming artifact 6.
      expect(runlogBarrierViolation(committed + `{"taskId":"t2","arm":"treatment"}\n`, committed)).toMatch(
        /did not complete/
      );
      // The very first row, uncommitted (HEAD has no runlog at all) — FIRES.
      expect(runlogBarrierViolation(committed, null)).toMatch(/HEAD carries no committed copy/);
      // A truncated disk copy — FIRES the other direction.
      expect(runlogBarrierViolation(null, committed)).toMatch(/truncated/);
    });

    // R18's second finding, and the reason R11's declined per-run lock came
    // back: the barrier above is checked when an observation STARTS, minutes
    // before its row exists, so two observations both pass it before either
    // appends. Then `git commit -- <dir> <runlog>` takes the runlog's WHOLE
    // content — one process's commit carries the other's ROW WITHOUT ITS
    // ARCHIVE. These three run the real function against a real repository.
    const runlogFixture = async () => {
      const sh = promisify(execFile);
      const git = async (cwd: string, ...args: string[]) => (await sh("git", args, { cwd })).stdout.trim();
      const root = tempRoot();
      await git(root, "init", "-q");
      await git(root, "config", "user.name", "runlog-oracle");
      await git(root, "config", "user.email", "runlog@example.invalid");
      await git(root, "config", "core.autocrlf", "false");
      await git(root, "config", "commit.gpgsign", "false");
      const runLogRel = "evidence/run-c.b12.runlog.jsonl";
      const relDir = "evidence/run-c/obs-t2-treatment";
      const committed = `{"ts":"2026-08-10T00:00:00Z","runId":"run-c","taskId":"t1","arm":"treatment","sessionId":"s-t1"}\n`;
      await fs.mkdir(path.join(root, relDir), { recursive: true });
      await fs.writeFile(path.join(root, runLogRel), committed, "utf8");
      await fs.writeFile(path.join(root, relDir, "observation.json"), `{"taskId":"t2"}\n`, "utf8");
      await git(root, "add", "--", runLogRel);
      await git(root, "commit", "-q", "-m", "t1's evidence");
      const branchRef = await git(root, "symbolic-ref", "--quiet", "HEAD");
      const call = async (over: Record<string, unknown> = {}) => {
        const { commitObservationRow } = await load();
        return commitObservationRow(root, {
          branchRef,
          evidenceDir: path.join(root, "evidence"),
          runId: "run-c",
          runLogRel,
          relDir,
          written: ["observation.json"],
          row: { runId: "run-c", taskId: "t2", arm: "treatment", sessionId: "s-t2" },
          sessionId: "s-t2",
          message: "evidence: run-c t2/treatment",
          runlogAtBarrier: committed,
          lockAttempts: 1,
          lockWaitMs: 1,
          ...over,
        });
      };
      return { root, git, runLogRel, relDir, committed, call, branchRef };
    };

    it("commits the row and its archive as ONE act, then releases the run's lock", async () => {
      const { root, git, runLogRel, relDir, committed, call } = await runlogFixture();
      const result = await call();
      expect(result.ok).toBe(true);
      // The row is in HEAD, after the predecessor's, and the archive with it.
      const head = await git(root, "show", `HEAD:${runLogRel}`);
      expect(head.startsWith(committed.trimEnd())).toBe(true);
      expect(head).toMatch(/"sessionId":"s-t2"/);
      expect(await git(root, "show", `HEAD:${relDir}/observation.json`)).toBe(`{"taskId":"t2"}`);
      // The `ts` is stamped at the write, not passed in.
      expect(JSON.parse(head.split("\n")[1]!).ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // The lock is a claim held across the act, not a file left behind.
      expect(existsSync(path.join(root, "evidence", ".runlog-lock-run-c"))).toBe(false);
    });

    it("refuses a FOREIGN uncommitted row instead of committing it without its evidence", async () => {
      // The exact interleave: the other observation appended and has not yet
      // committed. The old inline code appended ours and ran `git commit --
      // <our dir> <runlog>`, which carried THEIR row with only OUR archive —
      // and if they then died, HEAD held a row with nothing behind it forever.
      const { root, git, runLogRel, committed, call } = await runlogFixture();
      const head0 = await git(root, "rev-parse", "HEAD");
      const foreign = `{"ts":"2026-08-10T00:01:00Z","runId":"run-c","taskId":"t3","arm":"treatment","sessionId":"s-t3"}\n`;
      await fs.appendFile(path.join(root, runLogRel), foreign, "utf8");
      const result = await call();
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.why).toMatch(/re-checked under this run's commit lock/);
      // NOTHING moved: no commit, no row of ours, and their line untouched.
      expect(await git(root, "rev-parse", "HEAD")).toBe(head0);
      expect(await git(root, "show", `HEAD:${runLogRel}`)).toBe(committed.trimEnd());
      expect(await fs.readFile(path.join(root, runLogRel), "utf8")).toBe(committed + foreign);
      expect(existsSync(path.join(root, "evidence", ".runlog-lock-run-c"))).toBe(false);
    });

    it("refuses when another observation ran INSIDE this one — the window the barrier cannot see", async () => {
      // Disk and HEAD agree again, so the barrier is silent: the other
      // observation started AND committed while this one was in flight. That
      // is what artifact 6 forbids, and byte-equality with what the barrier
      // saw at the start is the only thing that can tell.
      const { root, git, runLogRel, call } = await runlogFixture();
      await fs.appendFile(
        path.join(root, runLogRel),
        `{"ts":"2026-08-10T00:02:00Z","runId":"run-c","taskId":"t4","arm":"treatment","sessionId":"s-t4"}\n`,
        "utf8"
      );
      await git(root, "add", "--", runLogRel);
      await git(root, "commit", "-q", "-m", "t4's evidence, committed inside ours");
      const head0 = await git(root, "rev-parse", "HEAD");
      const result = await call();
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.why).toMatch(/ran inside this one/);
      expect(await git(root, "rev-parse", "HEAD")).toBe(head0);
      expect(await fs.readFile(path.join(root, runLogRel), "utf8")).not.toMatch(/s-t2/);
    });

    it("writes NOTHING while another observation holds the run's commit lock", async () => {
      const { root, git, runLogRel, committed, call } = await runlogFixture();
      const { acquireRunlogLock } = await load();
      const held = acquireRunlogLock(path.join(root, "evidence"), "run-c");
      expect(held.ok).toBe(true);
      // The same claim, twice — `mkdir` is the mutual exclusion.
      expect(acquireRunlogLock(path.join(root, "evidence"), "run-c").ok).toBe(false);
      const head0 = await git(root, "rev-parse", "HEAD");
      const result = await call();
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.why).toMatch(/commit lock/);
      expect(result.ok === false && result.why).toMatch(/no live process/);
      expect(await git(root, "rev-parse", "HEAD")).toBe(head0);
      expect(await fs.readFile(path.join(root, runLogRel), "utf8")).toBe(committed);
      // The waiter did not steal it.
      expect(existsSync(held.lockDir)).toBe(true);
      held.release();
      expect(existsSync(held.lockDir)).toBe(false);
    });

    it("refuses when HEAD moved to another branch while the observation ran", async () => {
      // R26: `git commit` writes to whatever HEAD names NOW, and an
      // observation runs for minutes. A checkout in this repository — an
      // operator, another agent — retargets it. On a branch cut from the same
      // commit the barrier still passes and every HEAD-based check agrees, so
      // the act reported SUCCESS while the paid observation and its ordering
      // row lived on a branch the run is not on.
      const { root, git, runLogRel, committed, call } = await runlogFixture();
      const head0 = await git(root, "rev-parse", "HEAD");
      await git(root, "checkout", "-q", "-b", "someone-elses-work");
      const result = await call();
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.why).toMatch(/HEAD moved to refs\/heads\/someone-elses-work/);
      expect(result.ok === false && result.why).toMatch(/nothing was appended/);
      // NOTHING was written, on either branch.
      expect(await git(root, "rev-parse", "HEAD")).toBe(head0);
      expect(await fs.readFile(path.join(root, runLogRel), "utf8")).toBe(committed);
      expect(existsSync(path.join(root, "evidence", ".runlog-lock-run-c"))).toBe(false);
    });

    it("installs the evidence at the CAPTURED ref, and a branch that moved first gets NOTHING", async () => {
      // R27: R26's check is TOCTOU — `git commit` follows HEAD at ITS moment,
      // so a checkout landing after the check still moved the target, and the
      // commit was irreversible by the time the verification said so. The
      // install is now `commit-tree` onto the captured tip plus `update-ref
      // <ref> <new> <expectedTip>`: git compares and swaps, so either the
      // branch moves from exactly the commit this act read, or nothing
      // happens anywhere. Moving the branch BEFORE the install is how the
      // oracle reaches the window the check cannot see.
      const { root, git, runLogRel, relDir, committed, call, branchRef } = await runlogFixture();
      const foreign = `{"ts":"2026-08-10T00:04:00Z","runId":"run-c","taskId":"t8","arm":"treatment","sessionId":"s-t8"}\n`;
      const result = await call({
        // The seam fires between the append and the install — the exact gap.
        beforeInstall: async () => {
          await fs.writeFile(path.join(root, "unrelated.txt"), "someone else's commit\n", "utf8");
          await git(root, "add", "--", "unrelated.txt");
          await git(root, "commit", "-q", "-m", "the branch moved under the act");
        },
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.why).toMatch(/moved away from/);
      expect(result.ok === false && result.why).toMatch(/NOT installed anywhere/);
      // The branch carries the intruder's commit and NOT ours: no evidence
      // commit exists on any ref.
      expect(await git(root, "log", "--format=%s", "-1")).toBe("the branch moved under the act");
      expect(await git(root, "show", `${branchRef}:${runLogRel}`)).toBe(committed.trimEnd());
      expect(foreign).toMatch(/s-t8/); // (the row this act would have carried)
      expect(existsSync(path.join(root, "evidence", ".runlog-lock-run-c"))).toBe(false);
      // And the archive never reached any tree.
      const inTree = await git(root, "ls-tree", "-r", "--name-only", branchRef);
      expect(inTree).not.toMatch(new RegExp(relDir.replace(/[/\\]/g, "\\$&")));
    });

    it("leaves index, HEAD and working tree agreeing — the operator's NEXT commit undoes nothing", async () => {
      // The R16 lesson, applied to the observation: a CAS that installs a
      // commit the real index does not know about turns the operator's next
      // ordinary commit into a revert. Refreshing the same paths right AFTER
      // the install — once this worktree is proved to still hold the captured
      // ref at the new commit (R34) — keeps the three in agreement without a
      // single destructive write.
      const { root, git, runLogRel, relDir, call, branchRef } = await runlogFixture();
      expect((await call()).ok).toBe(true);
      // Nothing staged, nothing deleted, nothing untracked from the act.
      expect(await git(root, "status", "--porcelain")).toBe("");
      await fs.writeFile(path.join(root, "unrelated.txt"), "ordinary work\n", "utf8");
      await git(root, "add", "--", "unrelated.txt");
      await git(root, "commit", "-q", "-m", "the operator's next ordinary commit");
      // The evidence and the row are STILL there afterwards.
      expect(await git(root, "show", `${branchRef}:${relDir}/observation.json`)).toBe(`{"taskId":"t2"}`);
      expect(await git(root, "show", `${branchRef}:${runLogRel}`)).toMatch(/s-t2/);
    });

    it("a checkout DURING the act never stages evidence on the branch it lands in", async () => {
      // R34. The act opened by staging into the REAL index — which belongs to
      // whatever HEAD points at NOW — while `update-ref` installs on the ref
      // captured minutes ago. A checkout in between (the event R26 already
      // established as real) left the SIBLING branch's index holding this
      // observation's evidence, staged, while the commit landed correctly on
      // the captured ref and the act returned SUCCESS. The operator's next
      // ordinary commit over there duplicates paid evidence, silently.
      const { root, git, runLogRel, relDir, call, branchRef } = await runlogFixture();
      const result = await call({
        beforeInstall: async () => {
          await git(root, "checkout", "-q", "-b", "sibling");
        },
      });
      // The evidence still landed where it was captured…
      expect(result.ok).toBe(true);
      expect(await git(root, "show", `${branchRef}:${relDir}/observation.json`)).toBe(`{"taskId":"t2"}`);
      expect(await git(root, "show", `${branchRef}:${runLogRel}`)).toMatch(/s-t2/);
      // …and the branch we are standing in was NOT written to. Nothing staged
      // is the whole claim: an untracked file needs `git add -A` to escape,
      // a staged one rides out on the next ordinary `git commit`.
      expect(await git(root, "symbolic-ref", "--quiet", "HEAD")).toBe("refs/heads/sibling");
      expect(await git(root, "diff", "--cached", "--name-only")).toBe("");
      expect(await git(root, "ls-tree", "-r", "--name-only", "HEAD")).not.toMatch(/obs-t2-treatment/);
      // And the operator is TOLD, on a success — the act happened.
      expect(result.ok === true && result.note).toMatch(/index was left untouched/);
      expect(result.ok === true && result.note).toMatch(/sibling/);
      expect(result.ok === true && result.note).toMatch(/UNTRACKED where you now stand/);
    });

    it("the refresh is bound to the POSITION of HEAD, not to the branch's name", async () => {
      // The boundary in the other direction, and it is the reason the guard
      // asks `rev-parse HEAD` instead of `symbolic-ref`. Here the checkout
      // happens AFTER the install, so the new branch is created AT the
      // installed commit: every path the refresh would add is already in that
      // tree at that blob, so the add can only make the index agree with what
      // is checked out. Refusing here was the first spelling of this guard and
      // it left a STAGED DELETION behind — the operator's next commit would
      // have acted on it. Written down so nobody re-tightens it to the name.
      const { root, git, relDir, call, branchRef } = await runlogFixture();
      const result = await call({
        beforeIndexSync: async () => {
          await git(root, "checkout", "-q", "-b", "sibling-2");
        },
      });
      expect(result.ok).toBe(true);
      expect(await git(root, "symbolic-ref", "--quiet", "HEAD")).toBe("refs/heads/sibling-2");
      expect(await git(root, "rev-parse", "HEAD")).toBe(await git(root, "rev-parse", branchRef));
      expect(await git(root, "show", `${branchRef}:${relDir}/observation.json`)).toBe(`{"taskId":"t2"}`);
      // Refreshed, because it was a no-op: nothing staged, nothing pending.
      expect(await git(root, "status", "--porcelain")).toBe("");
      expect(result.ok === true && result.note).toBeNull();
    });

    it("installs from a LINKED WORKTREE, where `.git` is a file and not a directory", async () => {
      // R28: the CAS built its temporary index at `<root>/.git/...`, which in
      // a linked worktree is a FILE — so `read-tree` could not create it, and
      // the failure landed AFTER the row was appended: every observation in
      // that environment would leave an uncommitted row and hold the run at
      // the next barrier. This repository is worked from linked worktrees,
      // and the register had already discarded the same assumption.
      const { root, git } = await runlogFixture();
      const linked = path.join(root, "..", `wt-${path.basename(root)}`);
      await git(root, "worktree", "add", "-q", "-b", "observing", linked);
      try {
        // `.git` really is a file here — the whole point of the test.
        expect((await fs.stat(path.join(linked, ".git"))).isFile()).toBe(true);
        const relDir = "evidence/run-c/obs-t2-treatment";
        const runLogRel = "evidence/run-c.b12.runlog.jsonl";
        await fs.mkdir(path.join(linked, relDir), { recursive: true });
        await fs.writeFile(path.join(linked, relDir, "observation.json"), `{"taskId":"t2"}\n`, "utf8");
        const committed = await fs.readFile(path.join(linked, runLogRel), "utf8");
        const { commitObservationRow } = await load();
        const result = await commitObservationRow(linked, {
          evidenceDir: path.join(linked, "evidence"),
          runId: "run-c",
          runLogRel,
          relDir,
          written: ["observation.json"],
          row: { runId: "run-c", taskId: "t2", arm: "treatment", sessionId: "s-t2" },
          sessionId: "s-t2",
          message: "evidence: run-c t2/treatment",
          runlogAtBarrier: committed,
          branchRef: "refs/heads/observing",
          lockAttempts: 1,
          lockWaitMs: 1,
        });
        expect(result.ok).toBe(true);
        expect(await git(linked, "show", `refs/heads/observing:${relDir}/observation.json`)).toBe(`{"taskId":"t2"}`);
        expect(await git(linked, "show", `refs/heads/observing:${runLogRel}`)).toMatch(/s-t2/);
        // The other branch never moved, and the worktree is clean.
        expect(await git(linked, "status", "--porcelain")).toBe("");
      } finally {
        await git(root, "worktree", "remove", "--force", linked);
      }
    });

    it("refuses a DETACHED HEAD — evidence no branch holds is evidence the run cannot find", async () => {
      const { root, git, runLogRel, committed, call } = await runlogFixture();
      await git(root, "checkout", "-q", "--detach");
      const result = await call();
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.why).toMatch(/HEAD is detached now/);
      expect(await fs.readFile(path.join(root, runLogRel), "utf8")).toBe(committed);
    });

    // R25: the postcondition verified `written` — the per-observation
    // artifacts — and the runlog is the OTHER path the same commit names. The
    // threat model is the one the code already writes down for the archive: an
    // index-mutating `pre-commit` hook. Pointed at the row, it produced a
    // commit with every archive blob matching, a green result, a released
    // session lock — and HEAD holding an observation with no ordering row.
    const hookThatMutatesTheIndex = async (root: string, body: string) => {
      const hooks = path.join(root, ".git", "hooks");
      await fs.mkdir(hooks, { recursive: true });
      await fs.writeFile(path.join(hooks, "pre-commit"), `#!/bin/sh\n${body}\nexit 0\n`, { encoding: "utf8", mode: 0o755 });
    };

    it("is INERT to an index-mutating pre-commit hook — plumbing runs no hooks (R27)", async () => {
      // R25's threat closed by construction rather than by a check. The hook
      // below is the one that used to drop the row from the commit while
      // leaving the observation staged; the install no longer runs `git
      // commit`, so it never fires, and the row lands with its archive. The
      // postcondition stays — it is now about bytes moving under the act, not
      // about hooks — and the test below it is what proves the postcondition
      // still fires.
      const { root, git, runLogRel, relDir, call, branchRef } = await runlogFixture();
      await hookThatMutatesTheIndex(
        root,
        `blob=$(git rev-parse HEAD:${runLogRel})\ngit update-index --cacheinfo 100644,$blob,${runLogRel}\ngit update-index --force-remove ${relDir}/observation.json`
      );
      const result = await call();
      expect(result.ok).toBe(true);
      expect(await git(root, "show", `${branchRef}:${relDir}/observation.json`)).toBe(`{"taskId":"t2"}`);
      expect(await git(root, "show", `${branchRef}:${runLogRel}`)).toMatch(/s-t2/);
    });

    it("refuses when the runlog is not the bytes this observation appended", async () => {
      // R25's postcondition, reached through the seam now that no hook can
      // reach it: anything rewriting the runlog between the append and the
      // install means the row that lands cannot be attributed to this act.
      const { root, git, runLogRel, call, branchRef } = await runlogFixture();
      const foreign = `{"ts":"2026-08-10T00:03:00Z","runId":"run-c","taskId":"t9","arm":"treatment","sessionId":"s-t9"}\n`;
      const result = await call({
        beforeInstall: async () => {
          await fs.appendFile(path.join(root, runLogRel), foreign, "utf8");
        },
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.why).toMatch(/not the bytes this observation appended/);
      expect(result.ok === false && result.why).toMatch(/rewritten/);
      // Our row did land; the disk copy is no longer what we appended, which
      // is exactly the state the next observation's barrier must not inherit
      // as if this act had succeeded.
      expect(await git(root, "show", `${branchRef}:${runLogRel}`)).toMatch(/s-t2/);
      expect(await fs.readFile(path.join(root, runLogRel), "utf8")).toMatch(/s-t9/);
      expect(existsSync(path.join(root, "evidence", ".runlog-lock-run-c"))).toBe(false);
    });

    it("invalidates on drift in EVERY instruction component, with its citation", async () => {
      // The fourth round's second finding: settings/settings.local/MCP-config/
      // policy-blob drift was RECORDED but did not invalidate. An arm carrying
      // two values has no well-defined hash for voidConditions 12's pair
      // comparison — invalidating makes the frozen predicate evaluable.
      const { instructionDriftReasons } = await load();
      const base = {
        claudeMd: "a",
        settings: "b",
        settingsLocal: null as string | null,
        mcpConfigPassed: "d",
        policyBlob: "e",
        memory: "f",
      };
      expect(instructionDriftReasons(base, { ...base })).toHaveLength(0);
      const cases: Array<[string, RegExp]> = [
        ["claudeMd", /voidConditions 12: the in-repo CLAUDE\.md/],
        ["memory", /voidConditions 13/],
        ["settings", /two settings hashes/],
        ["settingsLocal", /two settings\.local hashes/],
        ["mcpConfigPassed", /moved mid-session/],
        ["policyBlob", /calibration key/],
      ];
      for (const [key, cite] of cases) {
        const post = { ...base, [key]: "moved" } as Record<string, string | null>;
        const reasons = instructionDriftReasons(base, post);
        expect.soft(reasons, `${key} drift fired no invalidity`).toHaveLength(1);
        expect.soft(reasons[0], `${key} drift cites the wrong clause`).toMatch(cite);
      }
      // A null-to-hash transition is drift like any other — settingsLocal
      // starts null in the base exactly to prove it.
      expect(instructionDriftReasons(base, { ...base, settingsLocal: "appeared" })).toHaveLength(1);
    });

    it("accepts only committed evidence as a probe source", async () => {
      // The review's high finding: with the path unconstrained and the sha
      // compared only if pinned, a fabricated working-tree JSON with
      // `sustained: true` could calibrate O_o for every treatment observation.
      // Three refusals and one pass, all deterministic against this repo:
      const { committedEvidenceCheck } = await load();
      // Absolute paths escape the inventory.
      expect(committedEvidenceCheck(path.join(os.homedir(), "probe.json")).why).toMatch(/repo-relative under evidence\//);
      // Paths outside evidence/ are not the append-only inventory.
      expect(committedEvidenceCheck("STATE.md").why).toMatch(/must live under evidence\//);
      // A file HEAD does not carry is a working-tree fabrication.
      expect(committedEvidenceCheck("evidence/does-not-exist.probe.json").why).toMatch(/does not exist on disk/);
      // The committed, sha-frozen pre-registration passes: in HEAD, bytes equal.
      const ok = committedEvidenceCheck("evidence/2026-08-05-b12-preregistration.json");
      expect(ok.ok).toBe(true);
      expect(ok.file).toContain("2026-08-05-b12-preregistration");
      // The disk-vs-HEAD blob comparison itself is the commit barrier's own
      // tested shape (hash-object vs rev-parse HEAD:<path>), reused verbatim.
    });

    it("hashes the memory directory so a restore is provable and a write is visible", async () => {
      const { hashMemoryDir } = await load();
      const root = tempRoot();
      const a = path.join(root, "mem-a");
      const b = path.join(root, "mem-b");
      for (const dir of [a, b]) {
        await fs.mkdir(path.join(dir, "sub"), { recursive: true });
        await fs.writeFile(path.join(dir, "MEMORY.md"), "index\n", "utf8");
        await fs.writeFile(path.join(dir, "sub", "note.md"), "fact\n", "utf8");
      }
      const ha = hashMemoryDir(a);
      expect(ha.files).toBe(2);
      // A faithful copy reproduces the hash — which is what lets the harness
      // assert the restore against the manifest's pin.
      expect(hashMemoryDir(b).sha256).toBe(ha.sha256);
      // One byte written by a session moves it — the VOID 13 fact.
      await fs.writeFile(path.join(b, "sub", "note.md"), "fact!\n", "utf8");
      expect(hashMemoryDir(b).sha256).not.toBe(ha.sha256);
      // Absent is a fact with a hash, not an error: the restore target does not
      // exist yet for a fresh worktree slug.
      expect(hashMemoryDir(path.join(root, "missing")).files).toBe(0);
    });
  });
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

describe("the four B12 scoring seams", () => {
  const at = (ms: number): string => new Date(1_700_000_000_000 + ms).toISOString();

  /**
   * A transcript shaped so a refusal has something to be priced against: one
   * request carrying the tool_use, the tool_result that echoes an invocation id,
   * and a LATER request for `requestAtOrAfter` to land on. The later request
   * carries a big `cacheRead` on purpose — it is what the deleted turn-collapse
   * term multiplied, so without it the old and new formulas agree by accident.
   */
  async function transcriptWithLaterRequest(echoedId: string): Promise<string> {
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
        timestamp: at(500),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
        toolUseResult: { content: [{ type: "text", text: JSON.stringify({ invocation_id: echoedId }) }] },
      }),
      assistantRecord("req-2", { write1h: 100, read: 50_000 }),
    ]);
  }

  it("prices a refused row by the SCORED rule, not by three adjustments the numerator does not make", async () => {
    // `wouldHaveAdded` fed the refusal magnitudes and therefore `R_hi+`, the
    // number on B12's FALL side -- and it computed a different quantity from the
    // crediting path in three ways at once: clamped where the numerator is
    // signed, uncapped where it is capped, and carrying a turn-collapse term the
    // frozen metric excludes BY NAME. A refused row was worth more than an
    // identical credited row, and part of the excess was set by a tool-call
    // argument: `turns_collapsed` is `rounds.length` whether or not `repair`
    // closed anything.
    //
    // DERIVED BY HAND, not read off the implementation. The row is refused as
    // ambiguous and matches `req-2`, which sits at t=1 of a 2-request 1h segment,
    // so the multiplier is `2.0 + 0.1 x max(0, 2-1-1) = 2.0`:
    //   scored : (min(50000, 30000) - 1000) / 3.7 x 2.0 = 29000/3.7 x 2.0
    const id = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa";
    const file = await transcriptWithLaterRequest(id);
    const transcript = await readTranscript(file);
    const result = buildCounterfactual(
      transcript,
      [{ ts: at(500), invocation_id: id, tool: "gate", bytes_raw: 50_000, bytes_returned: 1_000, turns_collapsed: 3, latency_ms: 1 }],
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES),
      new Set([id])
    );

    expect(result.ambiguous).toBe(1);
    expect(result.ambiguousUnits.unsized).toBe(0);
    expect(result.ambiguousUnits.units).toBeCloseTo(15675.675675675675, 6);
    // THE NEGATIVE CONTROL. The pre-repair formula was
    //   max(0, 50000-1000)/3.7 x 2.0  +  3 x 50000 x 0.1  =  41486.486...
    // 2.6x the honest figure, on the side that decides whether the project
    // stops. If this assertion ever passes, the alignment has been reverted.
    expect(result.ambiguousUnits.units).not.toBeCloseTo(41486.48648648649, 3);
  });

  it("gives excludedForeign a magnitude, because R_hi+ is defined over all FOUR classes", async () => {
    // This class shipped as a bare counter while the other three carried
    // magnitudes, so `R_hi+` -- which grants every refused row its would-have
    // magnitude across all four -- was not computable as the frozen design
    // defines it. The design's own Phase-0 repair list named `unmatched` and
    // missed this one.
    //
    // The transcript echoes id A; the telemetry row carries id B. So the row is
    // ours to see and not ours to claim, which is exactly `excludedForeign` --
    // and `provenanceUnavailable` stays false because A did arrive.
    const echoed = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb";
    const foreign = "cccccccc-0000-4000-8000-cccccccccccc";
    const file = await transcriptWithLaterRequest(echoed);
    const transcript = await readTranscript(file);
    const result = buildCounterfactual(
      transcript,
      [{ ts: at(500), invocation_id: foreign, tool: "gate", bytes_raw: 10_000, bytes_returned: 1_000, turns_collapsed: 0, latency_ms: 1 }],
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES)
    );

    expect(result.provenanceUnavailable).toBe(false);
    expect(result.excludedForeign).toBe(1);
    expect(result.excludedForeignUnits.unsized).toBe(0);
    // (10000 - 1000)/3.7 x 2.0, by the same hand derivation as above.
    expect(result.excludedForeignUnits.units).toBeCloseTo(4864.864864864865, 6);
    // A count with no magnitude is the silent exclusion the other three
    // counters exist to prevent, and a zero here would read as "nothing worth
    // having was refused".
    expect(result.excludedForeignUnits.units).not.toBe(0);
  });

  it("lists every row it saw, and the credited ones sum to the scored total", async () => {
    // B12's unit is a TASK WINDOW, not a session, and a window cannot be scored
    // by shortening the transcript -- `positionalMultiplier` reads t and T off
    // the full segment. So the scorer meters the whole lineage and selects ROWS,
    // which is only possible if the rows are returned.
    const echoed = "dddddddd-0000-4000-8000-dddddddddddd";
    const foreign = "eeeeeeee-0000-4000-8000-eeeeeeeeeeee";
    const file = await transcriptWithLaterRequest(echoed);
    const transcript = await readTranscript(file);
    const result = buildCounterfactual(
      transcript,
      [
        { ts: at(500), invocation_id: echoed, tool: "gate", bytes_raw: 10_000, bytes_returned: 1_000, turns_collapsed: 2, latency_ms: 1 },
        { ts: at(500), invocation_id: foreign, tool: "gate", bytes_raw: 8_000, bytes_returned: 500, turns_collapsed: 0, latency_ms: 1 },
        { ts: at(500), tool: "repair", bytes_raw: 400, bytes_returned: 900, turns_collapsed: 0, latency_ms: 1 },
      ],
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES)
    );

    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => r.disposition)).toEqual([
      "credited",
      "excludedForeign",
      "unverifiable",
    ]);

    // THE IDENTITY. Summing the ledger's credited rows must land on the
    // aggregate, or the artifact and the verdict are describing different runs.
    const creditedUnits = result.rows
      .filter((r) => r.disposition === "credited")
      .reduce((sum, r) => sum + (r.units ?? 0), 0);
    expect(creditedUnits).toBeCloseTo(result.unitsTotal, 9);

    // The credited row carries its position; a refused row cannot, because it
    // has no request to be positioned against -- usually the reason it was
    // refused. Null, never a stand-in zero.
    const credited = result.rows[0];
    expect(credited?.index).toBe(1);
    expect(credited?.segmentSize).toBe(2);
    expect(credited?.ttl).toBe("1h");
    expect(credited?.multiplier).toBeCloseTo(2.0, 9);
    expect(credited?.turnsCollapsed).toBe(2);
    expect(result.rows[1]?.multiplier).toBeNull();
    expect(result.rows[1]?.segmentSize).toBeNull();

    // `turns_collapsed: 2` is on the row and in NO scored number.
    expect(creditedUnits).toBeCloseTo((9_000 / 3.7) * 2.0, 6);
  });

  /**
   * The same shape over a LONGER segment: four requests, so the row matches at
   * `t = 1` of `T = 4` and the positional multiplier is 2.2 while the write
   * component alone is 2.0.
   *
   * `transcriptWithLaterRequest` cannot serve as the `unitsLo` control. It runs
   * to `T = 2` and matches at `t = 1`, so `T-1-t` is 0 and the two figures
   * coincide BY CONSTRUCTION — a wrong implementation that reused the positional
   * multiplier would pass on it.
   */
  async function transcriptWithLongSegment(echoedId: string): Promise<string> {
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
        timestamp: at(500),
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
        toolUseResult: { content: [{ type: "text", text: JSON.stringify({ invocation_id: echoedId }) }] },
      }),
      assistantRecord("req-2", { write1h: 100, read: 50_000 }),
      assistantRecord("req-3", { write1h: 100 }),
      assistantRecord("req-4", { write1h: 100 }),
    ]);
  }

  it("carries each row at BOTH horizons, because the low side has its own biggest row", async () => {
    // B12's `R_lo⁻ʳ` drops "its best row" -- the low figure's, not the high
    // figure's. `units` is the sHi contribution (`capped/3.7 x multiplier`), and
    // the scorer's `aggregate.ts` receives no `rates`, so without a second field
    // on the row the low-side jackknife had to be computed from the high side's
    // ranking. A guard about a different figure than the one it reports reads as
    // a passed guard.
    //
    // DERIVED BY HAND. The row matches `req-2` at t=1 of a 4-request 1h segment:
    //   multiplier = 2.0 + 0.1 x (4-1-1) = 2.2
    //   units   = (min(50000,30000) - 1000)/3.7 x 2.2 = 29000/3.7 x 2.2
    //   unitsLo = the write component alone, x 2.0
    const id = "cccccccc-0000-4000-8000-cccccccccccc";
    const file = await transcriptWithLongSegment(id);
    const transcript = await readTranscript(file);
    const result = buildCounterfactual(
      transcript,
      [{ ts: at(500), invocation_id: id, tool: "gate", bytes_raw: 50_000, bytes_returned: 1_000, turns_collapsed: 3, latency_ms: 1 }],
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES)
    );

    const row = result.rows[0];
    expect(row?.disposition).toBe("credited");
    expect(row?.multiplier).toBeCloseTo(2.2, 9);
    expect(row?.units).toBeCloseTo(17_243.243243243243, 6);
    expect(row?.unitsLo).toBeCloseTo(15_675.675675675675, 6);
    // THE NEGATIVE CONTROL. If these two are ever equal on this fixture, the low
    // horizon is being computed with the positional multiplier and `R_lo⁻ʳ` is
    // ranking rows by the wrong figure.
    expect(row?.unitsLo).not.toBeCloseTo(row?.units ?? 0, 3);

    // F23: the uncapped pair prices `signed` WHOLE on the same row —
    //   unitsUncapped   = 49000/3.7 x 2.2 = 29135.135135135135
    //   unitsLoUncapped = 49000/3.7 x 2.0 = 26486.486486486486
    // — and above the cap the two pairs SPLIT; equality here would mean the
    // cap was applied to both.
    const credited = row?.disposition === "credited" ? row : undefined;
    expect(credited?.unitsUncapped).toBeCloseTo(29_135.135135135135, 6);
    expect(credited?.unitsLoUncapped).toBeCloseTo(26_486.486486486486, 6);
    expect(credited?.unitsUncapped).not.toBeCloseTo(credited?.units ?? 0, 3);
  });

  it("prices the uncapped pair equal to the scored one under the cap — the metamorphic half of F23", async () => {
    // UNDER the cap `Math.min(bytes_raw, cap)` returns `bytes_raw`, so the two
    // pairs are the SAME floats through the SAME operations — asserted with
    // exact equality, not `closeTo`, because any drift means the uncapped path
    // grew its own arithmetic.
    const id = "dddddddd-0000-4000-8000-dddddddddddd";
    const file = await transcriptWithLongSegment(id);
    const transcript = await readTranscript(file);
    const result = buildCounterfactual(
      transcript,
      [{ ts: at(500), invocation_id: id, tool: "gate", bytes_raw: 10_000, bytes_returned: 1_000, turns_collapsed: 0, latency_ms: 1 }],
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES)
    );
    const row = result.rows[0];
    expect(row?.disposition).toBe("credited");
    const credited = row?.disposition === "credited" ? row : undefined;
    expect(credited?.unitsUncapped).toBe(credited?.units);
    expect(credited?.unitsLoUncapped).toBe(credited?.unitsLo);
  });

  it("narrows a credited row's magnitudes by its disposition, so `?? 0` is unwritable", async () => {
    // THE ENFORCEMENT, AND IT IS THE COMPILER'S. With `CreditedRow` flat and
    // every field nullable, `disposition === "credited"` narrowed NOTHING: the
    // sum below would have had to write `row.units ?? 0`, which compiles, passes
    // every oracle in this repository, and sums an unknown as zero -- the one
    // collapse this scorer forbids everywhere else. The invariant lived in a doc
    // comment, and a doc comment cannot stop an implementer.
    //
    // The two reads in the loop carry NO coalescing and NO assertion, and since
    // `tests/**` joined `tsconfig.json` on 2026-08-07 that IS enforced here:
    // flattening the union stops this file compiling. It did not when the union
    // landed — nothing in this tree was type-checked then — which is why the
    // primary control is still the pair of `Assert` aliases beside the union in
    // `report.ts`, where the type is. This test is the RUNTIME half: it proves
    // the two horizons come out of a real `buildCounterfactual` at the right
    // values, which no type can say.
    const sumCredited = (rows: readonly CreditedRow[]): { hi: number; lo: number } => {
      let hi = 0;
      let lo = 0;
      for (const row of rows) {
        if (row.disposition !== "credited") continue;
        hi += row.units;
        lo += row.unitsLo;
      }
      return { hi, lo };
    };

    const id = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb";
    const file = await transcriptWithLongSegment(id);
    const transcript = await readTranscript(file);
    const base = { ts: at(500), tool: "gate", bytes_raw: 50_000, bytes_returned: 1_000, turns_collapsed: 0, latency_ms: 1 };
    const result = buildCounterfactual(
      transcript,
      [{ ...base, invocation_id: id }, { ...base }],
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES)
    );

    expect(result.rows.map((r) => r.disposition)).toEqual(["credited", "unverifiable"]);
    // Only the credited row is in the sum, at both horizons, by the hand
    // derivation in the test above: t=1 of T=4, so 2.2 and 2.0.
    const { hi, lo } = sumCredited(result.rows);
    expect(hi).toBeCloseTo(17_243.243243243243, 6);
    expect(lo).toBeCloseTo(15_675.675675675675, 6);

    // And the refused arm KEEPS its nullability -- it is the arm where `null`
    // means something. Sized here, through the timestamp fallback, but the type
    // still admits `null` and a consumer still has to say what it does about it.
    const refused = result.rows[1];
    if (refused?.disposition === "credited") throw new Error("fixture changed");
    expect(refused?.units).toBeCloseTo(17_243.243243243243, 6);
  });

  it("says a row could not report whether it closed, rather than saying it did not", async () => {
    // `MIN_REPAIR_CLOSURES` needs a per-row `passed`, and `detail` is an
    // untyped optional bag. Two rows carry no `passed` for entirely different
    // reasons -- `repair`'s abort path writes a detail without it, and rows
    // written before the field exist on disk -- and NEITHER of them is a repair
    // that ran and failed to close. Reading absence as `false` would count both
    // as evidence against `R_repair` being exercised.
    const id = "ffffffff-0000-4000-8000-ffffffffffff";
    const file = await transcriptWithLaterRequest(id);
    const transcript = await readTranscript(file);
    const base = { ts: at(500), tool: "repair", bytes_raw: 5_000, bytes_returned: 500, turns_collapsed: 1, latency_ms: 1 };
    const result = buildCounterfactual(
      transcript,
      [
        { ...base, invocation_id: id, detail: { passed: true } },
        // The abort path (`repair.ts`) writes exactly this: a detail, no verdict.
        { ...base, detail: { aborted: true, stopped_because: "aborted" } },
        { ...base, detail: { passed: false } },
        // Rows this old predate `detail` entirely.
        { ...base },
        // Enumerate the good values and refuse the rest: a string is not a verdict.
        { ...base, detail: { passed: "true" } },
      ],
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES)
    );

    expect(result.rows.map((r) => r.passed)).toEqual([true, null, false, null, null]);
    // Stated separately because it is the whole point: `false` and `null` are
    // different answers, and the ledger that counts closures must not merge them.
    expect(result.rows[1]?.passed).not.toBe(false);
    expect(result.rows[2]?.passed).not.toBeNull();
  });

  it("returns exactly one row per telemetry entry, in the entries' own order", async () => {
    // THE INVARIANT B12'S RUN-LEVEL LEDGER PAIRS ON, and until now it was half
    // stated: `report.ts` claimed the ORDER and never the CARDINALITY. A
    // telemetry row carries no identity that survives a null `invocation_id` --
    // legacy rows have no id at all -- so the only key the coverage ledger can
    // use is (artifact, ordinal), stamped at read time and zipped back onto the
    // priced rows by INDEX. If `buildCounterfactual` ever pushed zero or two rows
    // for one entry, or reordered them, every key past that point would name the
    // wrong row and the exactly-once invariant would report itself satisfied
    // while attributing magnitudes to the wrong observations.
    //
    // ALL FIVE DISPOSITIONS, deliberately interleaved so the assertion is about
    // the pairing and not about a coincidence of a sorted list.
    clock = 0;
    const credited = "aaaa1111-0000-4000-8000-aaaa11110000";
    const unmatchedId = "bbbb2222-0000-4000-8000-bbbb22220000";
    const foreign = "cccc3333-0000-4000-8000-cccc33330000";
    const ambiguous = "dddd4444-0000-4000-8000-dddd44440000";
    const echo = (toolUseId: string, invocationId: string, ms: number): string =>
      JSON.stringify({
        type: "user",
        uuid: `res-${toolUseId}`,
        parentUuid: null,
        sessionId: "sess-1",
        timestamp: at(ms),
        message: { content: [{ type: "tool_result", tool_use_id: toolUseId }] },
        toolUseResult: { content: [{ type: "text", text: JSON.stringify({ invocation_id: invocationId }) }] },
      });
    const file = await writeTranscript(tempRoot(), [
      assistantRecord("req-1", { write1h: 100 }, {
        message: {
          model: "test-model",
          content: [
            { type: "tool_use", id: "tu-1", name: "mcp__local-coder__gate" },
            { type: "tool_use", id: "tu-2", name: "mcp__local-coder__gate" },
          ],
          usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 },
        },
      }),
      echo("tu-1", credited, 500),
      assistantRecord("req-2", { write1h: 100, read: 50_000 }),
      // AFTER the last billed request, so nothing can be priced against it: this
      // is what makes the first telemetry row below `unmatched` rather than
      // credited, and `unmatched` is the one class that never reaches
      // `wouldHaveAdded` at all.
      echo("tu-2", unmatchedId, 9_000),
    ]);
    const transcript = await readTranscript(file);

    const base = { tool: "gate", bytes_raw: 5_000, bytes_returned: 500, turns_collapsed: 0, latency_ms: 1 };
    const telemetry = [
      { ...base, ts: at(10), invocation_id: unmatchedId },
      { ...base, ts: at(20) },
      { ...base, ts: at(30), invocation_id: foreign },
      { ...base, ts: at(40), invocation_id: ambiguous },
      { ...base, ts: at(50), invocation_id: credited },
    ];
    const result = buildCounterfactual(
      transcript,
      telemetry,
      DEFAULT_RATES,
      buildSessionReport(transcript, DEFAULT_RATES),
      new Set([ambiguous])
    );

    expect(result.rows).toHaveLength(telemetry.length);
    expect(result.rows.map((r) => r.disposition)).toEqual([
      "unmatched",
      "unverifiable",
      "excludedForeign",
      "ambiguous",
      "credited",
    ]);
    // THE PAIRING ITSELF. Each entry's `ts` is distinct and is copied onto its
    // row verbatim, so this is the index-for-index correspondence the ledger
    // relies on, asserted rather than assumed.
    expect(result.rows.map((r) => r.ts)).toEqual(telemetry.map((e) => e.ts));
  });

  it("restricts breakdownOfRequests to the requestIds it was handed", async () => {
    // FOUND BY RUNNING THE CONTROLS, NOT BY READING. Deleting this filter left
    // the whole 93-test suite green -- and it is the seam `A_o` is computed
    // from, so a subset silently returning the WHOLE session's cost would put
    // every observation's denominator wrong with nothing to catch it. The
    // function has carried the parameter and a paragraph of documentation about
    // why it matters since it was written; what it had not carried is a test.
    clock = 0;
    const file = await writeTranscript(tempRoot(), [
      assistantRecord("req-1", { write1h: 100 }),
      assistantRecord("req-2", { write1h: 300 }),
    ]);
    const transcript = await readTranscript(file);

    // 1h cache writes at 2.0x: (100 + 300) x 2.0 = 800 for the pair.
    expect(breakdownOfRequests(transcript.requests, DEFAULT_RATES).units.total).toBeCloseTo(800, 9);
    // The window's own cost is its own requests', and nothing else's.
    expect(
      breakdownOfRequests(transcript.requests, DEFAULT_RATES, new Set(["req-1"])).units.total
    ).toBeCloseTo(200, 9);
    expect(
      breakdownOfRequests(transcript.requests, DEFAULT_RATES, new Set(["req-2"])).units.total
    ).toBeCloseTo(600, 9);
    // An empty set is zero, not everything. The failure mode this guards is a
    // filter that no-ops, and a no-op filter returns 800 for all four of these.
    expect(breakdownOfRequests(transcript.requests, DEFAULT_RATES, new Set()).units.total).toBe(0);
  });

  it("charges the installation term only to the segments a window actually originated", async () => {
    // The whole-transcript form prices every `thread#segment` in the file. B12
    // scores a task window inside a lineage that is usually much longer, so
    // without a subset seam an observation is charged for segments another task
    // originated -- while `holdsIf` 6 requires this term for EVERY observation.
    //
    // Two threads, one request each, both 1h, so each segment's entry multiplier
    // is `2.0 + 0.1 x max(0, 1-1-0) = 2.0`. installedChars 3700 is 1000 tokens.
    clock = 0;
    const file = await writeTranscript(tempRoot(), [
      assistantRecord("req-main", { write1h: 100 }),
      JSON.stringify({
        type: "assistant",
        requestId: "req-sub",
        sessionId: "sess-1",
        uuid: "s1",
        parentUuid: null,
        isSidechain: true,
        timestamp: at(1_000),
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
      }),
    ]);
    const transcript = await readTranscript(file);

    // Both segments: 1000 tokens x (2.0 + 2.0).
    expect(unitsAddedByInstallation(transcript, DEFAULT_RATES, 3_700)).toBeCloseTo(4_000, 9);
    // The main thread's window alone: 1000 x 2.0. Half, because it owns one of
    // the two segments -- not because the segment got shorter.
    expect(
      unitsAddedByInstallation(transcript, DEFAULT_RATES, 3_700, new Set(["req-main"]))
    ).toBeCloseTo(2_000, 9);
    // A window that originated nothing is charged nothing, and that is a real
    // answer rather than a missing one.
    expect(unitsAddedByInstallation(transcript, DEFAULT_RATES, 3_700, new Set())).toBe(0);
  });
});
