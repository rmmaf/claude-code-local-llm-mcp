/**
 * THE ORACLE FOR THE B12 SCORER.
 *
 * The implementation bodies under `src/cost/b12/` are authored by a 30B local
 * model through `repair`; this file is authored here and is the only thing
 * standing between that and a wrong verdict. So every expected value is DERIVED
 * BY HAND from the frozen design's arithmetic and written as a literal with its
 * derivation beside it. A constant copied out of a passing run would make this
 * file a transcript of whatever the implementation happens to do, which is the
 * one thing it must not be.
 *
 * Frozen by value, quoted from `design.metric`: `charsPerToken = 3.7`, and the
 * multipliers `input 1.0 / cacheWrite5m 1.25 / cacheWrite1h 2.0 / cacheRead 0.1
 * / output 5.0`. `clientTruncationCap` is 30,000 (B2, `run 2026-08-02-win-03`:
 * 30,136 raw arrived as 30,000).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { aggregate, deliveryScore, poolRatio, rHiPlus } from "../src/cost/b12/aggregate.js";
import { subagentShare } from "../src/cost/b12/strata.js";
import { computeTerms, windowInvocationIds } from "../src/cost/b12/terms.js";
import type { B12Observation, ObservationTerms } from "../src/cost/b12/types.js";
import { DEFAULT_RATES } from "../src/cost/rates.js";
import { readTranscript } from "../src/cost/transcript.js";
import { makeTempRoot } from "./helpers.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = makeTempRoot("b12-scorer-test-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
  }
});

const at = (ms: number): string => new Date(1_700_000_000_000 + ms).toISOString();

/** A billed assistant record. `write1h` keeps every fixture on the 1h multiplier. */
function req(
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

/** The `tool_use` block that makes a request the CALLER of an invocation. */
function withToolUse(requestId: string, ms: number, usage: { write1h?: number }, toolUseId: string): string {
  return req(requestId, ms, usage, {
    message: {
      model: "test-model",
      content: [{ type: "tool_use", id: toolUseId, name: "mcp__local-coder__gate" }],
      usage: { cache_creation_input_tokens: usage.write1h ?? 0, cache_read_input_tokens: 0, output_tokens: 0 },
    },
  });
}

/** The result record that echoes our tool's `invocation_id` back into the transcript. */
function toolResult(toolUseId: string, invocationId: string, ms: number): string {
  return JSON.stringify({
    type: "user",
    uuid: `res-${toolUseId}`,
    parentUuid: null,
    sessionId: "sess-1",
    timestamp: at(ms),
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId }] },
    toolUseResult: { content: [{ type: "text", text: JSON.stringify({ invocation_id: invocationId }) }] },
  });
}

async function write(lines: string[]): Promise<string> {
  const file = path.join(tempRoot(), "session.jsonl");
  await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

function observation(over: Partial<B12Observation> = {}): B12Observation {
  return {
    taskId: "t-1",
    arm: "treatment",
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

function terms(over: Partial<ObservationTerms> = {}): ObservationTerms {
  return {
    taskId: "t-1",
    arm: "treatment",
    disposition: "scored",
    aO: 0,
    sLo: 0,
    sHi: 0,
    oO: 0,
    rows: [],
    refusals: {
      ambiguous: { count: 0, units: 0, unsized: 0 },
      unverifiable: { count: 0, units: 0, unsized: 0 },
      excludedForeign: { count: 0, units: 0, unsized: 0 },
      unmatched: { count: 0, units: 0, unsized: 0 },
    },
    subagentShare: { evaluable: true, value: { own: 1, sidechain: 0, share: 0, stratum: "solo" } },
    perDelivery: {},
    billedRequestCount: 1,
    rateKeys: ["test-model"],
    verificationStratum: "test-red",
    ...over,
  };
}

describe("poolRatio — the one arithmetic every figure in the artifact goes through", () => {
  it("is a RATIO OF SUMS, which is not the mean of per-observation ratios", () => {
    // The design bans `saved_o / billed_o` per observation and the mean of those
    // ratios BY NAME as the deciding form, because a small observation with a
    // large fraction and a large one with none are not two votes of equal weight.
    //
    // Derived by hand: obs A saves 50 on 100 billed (a third of its own total);
    // obs B saves nothing on 900. Ratio of sums is 50/(1000+50) = 0.047619...;
    // the banned mean is (1/3 + 0)/2 = 0.16666..., which is 3.5x larger. An
    // implementation that averaged would pass a tolerance test on one
    // observation and fail here.
    const set = [terms({ taskId: "a", aO: 100, sLo: 50, sHi: 50 }), terms({ taskId: "b", aO: 900 })];
    expect(poolRatio(set, "lo")).toBeCloseTo(0.047619047619047616, 12);
    expect(poolRatio(set, "lo")).not.toBeCloseTo(0.16666666666666666, 3);
  });

  it("subtracts the installation term from the NUMERATOR and never from the denominator", () => {
    // `R = (sum S - sum O) / (sum A + sum S)`. `O_o` is what installing the
    // server costs whether or not a tool is called, and it is a charge against
    // the saving -- not an addition to the bill being compared.
    //
    // By hand, with the golden observation below: (15675.675675675675 - 2300)
    // over (5800 + 15675.675675675675).
    const one = [terms({ aO: 5_800, sLo: 15_675.675675675675, sHi: 17_243.243243243243, oO: 2_300 })];
    expect(poolRatio(one, "lo")).toBeCloseTo(0.6228290964007048, 12);
    expect(poolRatio(one, "hi")).toBeCloseTo(0.6484869809992962, 12);
  });

  it("carries a net-negative observation as the cost it is, with no clamp", () => {
    // `run 2026-08-04-mac-09` measured `repair` net negative on 12 of 12 calls
    // against a TypeScript gate, and the pre-flight put `gate` at -467.1 units.
    // A clamp here would turn a tool that ADDED context into one that saved
    // nothing, which is the shipped bug this whole bracket was rebuilt to undo.
    const set = [terms({ aO: 1_000, sLo: -500, sHi: -500 })];
    expect(poolRatio(set, "lo")).toBeCloseTo(-1, 12); // -500 / 500
    expect(poolRatio(set, "lo")).toBeLessThan(0);
  });
});

describe("rHiPlus — the fall-side figure, and the one thing that makes it refuse", () => {
  it("is NOT EVALUABLE when any refused magnitude could not be sized", () => {
    // "An unknown may not be summed as zero." A run that cannot size a refusal
    // returns `open` rather than falling, because a fall on a deflated
    // instrument stops the project permanently -- strictly the worse of the two
    // errors, and the one every source design left unguarded.
    const withUnsized = terms({
      aO: 1_000,
      sHi: 100,
      refusals: {
        ambiguous: { count: 1, units: 0, unsized: 1 },
        unverifiable: { count: 0, units: 0, unsized: 0 },
        excludedForeign: { count: 0, units: 0, unsized: 0 },
        unmatched: { count: 0, units: 0, unsized: 0 },
      },
    });
    const result = rHiPlus([withUnsized]);
    expect(result.evaluable).toBe(false);
    // And the reason is carried, because "not evaluable" with no cause is a
    // verdict nobody can act on.
    if (!result.evaluable) expect(result.reason).toMatch(/unsized|null|size/i);
  });

  it("grants every refused row its magnitude across all FOUR classes when they are sized", () => {
    // Derived by hand: sHi 100, and one refusal in each of the four classes at
    // 10, 20, 30 and 40 units. The numerator is 100 + 100 = 200 against a
    // denominator of 1000 + 200 = 1200, so 1/6.
    //
    // `excludedForeign` is in that sum, and it is the class that shipped as a
    // bare counter -- with three classes instead of four this returns 160/1160.
    const sized = terms({
      aO: 1_000,
      sHi: 100,
      refusals: {
        ambiguous: { count: 1, units: 10, unsized: 0 },
        unverifiable: { count: 1, units: 20, unsized: 0 },
        excludedForeign: { count: 1, units: 30, unsized: 0 },
        unmatched: { count: 1, units: 40, unsized: 0 },
      },
    });
    const result = rHiPlus([sized]);
    expect(result.evaluable).toBe(true);
    if (result.evaluable) {
      expect(result.value).toBeCloseTo(200 / 1_200, 12);
      expect(result.value).not.toBeCloseTo(160 / 1_160, 6);
    }
  });
});

describe("deliveryScore — unexercised is a third state, never a low number", () => {
  it("refuses to score a delivery below the observation floor, and does NOT return 0", () => {
    // G-stop requires each delivery to individually pay for itself. A delivery
    // nobody exercised has not failed to pay; it has not been asked. Returning 0
    // would put it below 15% and fire the stopping criterion on an absence.
    const four = [0, 1, 2, 3].map((n) =>
      terms({ taskId: `t${n}`, aO: 100, sLo: 50, sHi: 50, perDelivery: { gate: { sLo: 50, sHi: 50, rowCount: 1 } } })
    );
    const score = deliveryScore(four, ["gate"], "lo");
    expect(score.scored).toBe(false);
    if (!score.scored) {
      expect(score.reason).toBe("unexercised");
      expect(score.observations).toBe(4);
    }
    // The assertion that matters: there is no `r` to read as a number at all.
    expect((score as { r?: number }).r).toBeUndefined();
  });

  it("scores over the COMMON denominator, so the per-delivery figures sum to the pooled one", () => {
    // The design asserts `sum_d R_d + R_other = R`, and ratios do not otherwise
    // sum. The only reading under which the identity holds is one denominator
    // with the numerator partitioned by the telemetry `tool` field -- fixed here
    // before any R exists, because the implementer's natural alternative
    // (bucketing another tool's rows under the nearest named delivery) would
    // decide `gate`'s survival on `scaffold`'s saving.
    //
    // Five observations, each A=100 and S=50, split 30 gate / 20 repair. Pooled
    // is 250/(500+250) = 1/3; gate is 150/750 = 0.2; repair is 100/750 = 0.1333.
    const five = [0, 1, 2, 3, 4].map((n) =>
      terms({
        taskId: `t${n}`,
        aO: 100,
        sLo: 50,
        sHi: 50,
        perDelivery: { gate: { sLo: 30, sHi: 30, rowCount: 1 }, repair: { sLo: 20, sHi: 20, rowCount: 1 } },
      })
    );
    const gate = deliveryScore(five, ["gate"], "lo");
    const repair = deliveryScore(five, ["repair"], "lo", 0);
    expect(gate.scored).toBe(true);
    expect(repair.scored).toBe(true);
    if (gate.scored && repair.scored) {
      expect(gate.r).toBeCloseTo(150 / 750, 12);
      expect(repair.r).toBeCloseTo(100 / 750, 12);
      expect(gate.r + repair.r).toBeCloseTo(poolRatio(five, "lo"), 12);
    }
  });
});

describe("subagentShare — covariate 1, the only one the design says gates both verdicts", () => {
  it("is UNEVALUABLE for a window with no billed request of its own, not a share of zero", async () => {
    // Zero is what a genuinely single-threaded session measures. Reporting it
    // for a window that measured nothing files an empty observation into the
    // `solo` stratum and lets it vote on a cell it never contributed to.
    const file = await write([req("req-1", 0, { write1h: 100 })]);
    const transcript = await readTranscript(file);
    const share = subagentShare(observation({ originatedRequestIds: [] }), transcript);
    expect(share.evaluable).toBe(false);
  });

  it("puts ANY subagent request in `multi` — the threshold is zero, not a fraction", async () => {
    // `admissionRule` 8: `solo` is ZERO subagent-originated records. It is not a
    // percentage and must not be turned into one.
    const file = await write([
      req("req-main", 0, { write1h: 100 }),
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

    const solo = subagentShare(observation({ originatedRequestIds: ["req-main"] }), transcript);
    expect(solo.evaluable).toBe(true);
    if (solo.evaluable) {
      expect(solo.value.stratum).toBe("solo");
      expect(solo.value.share).toBe(0);
    }

    const both = subagentShare(observation({ originatedRequestIds: ["req-main", "req-sub"] }), transcript);
    expect(both.evaluable).toBe(true);
    if (both.evaluable) {
      expect(both.value.own).toBe(2);
      expect(both.value.sidechain).toBe(1);
      expect(both.value.share).toBeCloseTo(0.5, 12);
      expect(both.value.stratum).toBe("multi");
    }
  });
});

describe("computeTerms — the window, joined end to end", () => {
  const INV = "11111111-1111-4111-8111-111111111111";

  /**
   * Four main-thread requests in one segment, so `T = 4`. The call is made by
   * `req-1`; its result lands at +500 and the next billed request is `req-2` at
   * index 1, which is what the row is priced against.
   */
  async function fixture(): Promise<string> {
    return write([
      withToolUse("req-1", 0, { write1h: 100 }, "tu-1"),
      toolResult("tu-1", INV, 500),
      req("req-2", 1_000, { write1h: 100, read: 50_000 }),
      req("req-3", 2_000, { write1h: 100 }),
      req("req-4", 3_000, { write1h: 100 }),
    ]);
  }

  const row = {
    ts: at(500),
    invocation_id: INV,
    tool: "gate",
    bytes_raw: 50_000,
    bytes_returned: 1_000,
    turns_collapsed: 3,
    latency_ms: 1,
  };

  it("resolves the invocation ids the window owns through the four-hop join", async () => {
    const transcript = await readTranscript(await fixture());
    // `req-1` made the call, so a window containing it owns the invocation.
    expect([...windowInvocationIds(observation({ originatedRequestIds: ["req-1"] }), transcript)]).toEqual([INV]);
    // A window that does NOT contain the calling request owns nothing, even
    // though the id is plainly present in the same transcript. This is the hop
    // that stops one task's saving being credited to another.
    expect([...windowInvocationIds(observation({ originatedRequestIds: ["req-3", "req-4"] }), transcript)]).toEqual([]);
  });

  it("computes A_o, both horizons of S_o, and O_o — every constant derived by hand", async () => {
    const transcript = await readTranscript(await fixture());
    const result = computeTerms({
      observation: observation({ originatedRequestIds: ["req-1", "req-2", "req-3", "req-4"] }),
      transcript,
      telemetry: [row],
      rates: DEFAULT_RATES,
      installedChars: 3_700,
      ambiguousIds: new Set(),
      disposition: "scored",
    });

    // A_o, by hand: req-1 100x2.0=200; req-2 100x2.0 + 50000x0.1=5200;
    // req-3 200; req-4 200. Total 5800.
    expect(result.aO).toBeCloseTo(5_800, 9);

    // The row is capped at 30,000 and signed: (30000-1000)/3.7 = 7837.837...
    // It matches req-2, at t=1 of a 4-request 1h segment.
    //   sHi: multiplier 2.0 + 0.1x(4-1-1) = 2.2  ->  17243.243243243243
    //   sLo: multiplier 2.0 (the write component alone) -> 15675.675675675675
    // turns_collapsed is 3 and contributes NOTHING to either.
    expect(result.sHi).toBeCloseTo(17_243.243243243243, 6);
    expect(result.sLo).toBeCloseTo(15_675.675675675675, 6);
    // Uncapped would be (50000-1000)/3.7 x 2.2 = 29135.13..., 1.7x too much.
    expect(result.sHi).not.toBeCloseTo(29_135.135135135137, 3);

    // O_o: 3700/3.7 = 1000 tokens, charged at entry position 0 of the one
    // segment this window originated: 2.0 + 0.1x(4-1-0) = 2.3.
    expect(result.oO).toBeCloseTo(2_300, 9);

    // Partitioned by the telemetry `tool` field, not by prose.
    expect(result.perDelivery.gate?.sHi).toBeCloseTo(17_243.243243243243, 6);
    expect(result.perDelivery.repair).toBeUndefined();

    // Four requests, all main thread: evaluable and solo.
    expect(result.subagentShare.evaluable).toBe(true);
    if (result.subagentShare.evaluable) expect(result.subagentShare.value.stratum).toBe("solo");
  });

  it("credits nothing to a window that did not make the call", async () => {
    // The same transcript and the same telemetry row, scored for a window that
    // owns only the later requests. A_o is still real; the saving is not this
    // window's. An implementation that skipped the join returns the full sHi
    // here and every observation in a run would double-count every other one's.
    const transcript = await readTranscript(await fixture());
    const result = computeTerms({
      observation: observation({ originatedRequestIds: ["req-3", "req-4"] }),
      transcript,
      telemetry: [row],
      rates: DEFAULT_RATES,
      installedChars: 3_700,
      ambiguousIds: new Set(),
      disposition: "scored",
    });
    expect(result.sHi).toBe(0);
    expect(result.sLo).toBe(0);
    expect(result.aO).toBeCloseTo(400, 9); // req-3 and req-4 only
  });
});

describe("aggregate — the artifact refuses rather than guessing", () => {
  it("reports the banned mean beside the pooled figure, and decides on the pooled one", async () => {
    const set = [terms({ taskId: "a", aO: 100, sLo: 50, sHi: 50 }), terms({ taskId: "b", aO: 900 })];
    const result = aggregate({ runId: "run-1", admitted: set, dropped: [] });
    expect(result.rLo).toBeCloseTo(0.047619047619047616, 12);
    expect(result.meanOfPerObservationRatios).toBeCloseTo(0.16666666666666666, 12);
    // Published, deciding nothing. If these two are ever equal on this fixture,
    // something has started reading the wrong one.
    expect(result.rLo).not.toBeCloseTo(result.meanOfPerObservationRatios, 3);
    expect(result.thresholds).toEqual({ hold: 0.3, fall: 0.15 });
  });
});
