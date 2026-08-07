/**
 * ORACLE FOR UNIT 2 — `src/cost/b12/terms.ts`.
 *
 * Depends on `strata.ts`, which `computeTerms` calls to fill
 * `ObservationTerms.subagentShare`. That is a real dependency in the design, not
 * an artefact of the harness, so unit 1 closes before this one is attempted.
 *
 * Every expected value derived by hand. `charsPerToken = 3.7`,
 * `cacheWrite1h = 2.0`, `cacheRead = 0.1`, `clientTruncationCap = 30_000`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { computeTerms, windowInvocationIds } from "../src/cost/b12/terms.js";
import { DEFAULT_RATES } from "../src/cost/rates.js";
import { readTranscript } from "../src/cost/transcript.js";
import { at, makeScratch, observation, req, toolResult, withToolUse, writeSession } from "./b12-fixtures.js";

const scratch = makeScratch();
afterEach(async () => scratch.cleanup());

const INV = "11111111-1111-4111-8111-111111111111";

/**
 * Four main-thread requests in one segment, so `T = 4`. The call is made by
 * `req-1`; its result lands at +500 and the next billed request is `req-2` at
 * index 1, which is what the row is priced against. `req-2` carries a large
 * `cacheRead` on purpose: it is what the deleted turn-collapse term multiplied,
 * so without it a wrong implementation and a right one agree by accident.
 */
async function fixture(): Promise<string> {
  return writeSession(scratch.tempRoot(), [
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

const ALL_FOUR = ["req-1", "req-2", "req-3", "req-4"];

describe("windowInvocationIds — the four-hop join", () => {
  it("resolves the ids the window owns, and only those", async () => {
    const transcript = await readTranscript(await fixture());
    // `req-1` made the call, so a window containing it owns the invocation.
    expect([
      ...windowInvocationIds(observation({ originatedRequestIds: ["req-1"] }), transcript),
    ]).toEqual([INV]);
    // A window that did NOT make the call owns nothing, even though the id is
    // plainly present in the same transcript. This is the hop that stops one
    // task's saving from being credited to another.
    expect([
      ...windowInvocationIds(observation({ originatedRequestIds: ["req-3", "req-4"] }), transcript),
    ]).toEqual([]);
  });
});

describe("computeTerms — every constant derived by hand", () => {
  it("computes A_o, both horizons of S_o, and O_o", async () => {
    const transcript = await readTranscript(await fixture());
    const result = computeTerms({
      observation: observation({ originatedRequestIds: ALL_FOUR }),
      transcript,
      telemetry: [row],
      rates: DEFAULT_RATES,
      installedChars: 3_700,
      ambiguousIds: new Set(),
      disposition: "scored",
    });

    // A_o by hand: req-1 100x2.0=200; req-2 100x2.0 + 50000x0.1=5200;
    // req-3 200; req-4 200. Total 5800.
    expect(result.aO).toBeCloseTo(5_800, 9);

    // The row is CAPPED at 30,000 and SIGNED: (30000-1000)/3.7 = 7837.837...
    // It matches req-2, at t=1 of a 4-request 1h segment.
    //   sHi: multiplier 2.0 + 0.1x(4-1-1) = 2.2  ->  17243.243243243243
    //   sLo: the write component alone, 2.0     ->  15675.675675675675
    // turns_collapsed is 3 and contributes NOTHING to either.
    expect(result.sHi).toBeCloseTo(17_243.243243243243, 6);
    expect(result.sLo).toBeCloseTo(15_675.675675675675, 6);
    // Uncapped would be (50000-1000)/3.7 x 2.2 = 29135.13..., 1.7x too much.
    expect(result.sHi).not.toBeCloseTo(29_135.135135135137, 3);

    // O_o: 3700/3.7 = 1000 tokens, charged at entry position 0 of the ONE
    // segment this window originated: 2.0 + 0.1x(4-1-0) = 2.3.
    expect(result.oO).toBeCloseTo(2_300, 9);

    // Partitioned by the telemetry `tool` field, never by prose.
    expect(result.perDelivery.gate?.sHi).toBeCloseTo(17_243.243243243243, 6);
    expect(result.perDelivery.repair).toBeUndefined();

    // Four requests, all main thread: evaluable and solo.
    expect(result.subagentShare.evaluable).toBe(true);
    if (result.subagentShare.evaluable) expect(result.subagentShare.value.stratum).toBe("solo");

    expect(result.billedRequestCount).toBe(4);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.disposition).toBe("credited");
  });

  it("credits nothing to a window that did not make the call", async () => {
    // Same transcript, same telemetry row, scored for a window owning only the
    // later requests. A_o is still real; the saving is not this window's. An
    // implementation that skipped the join returns the full sHi here, and every
    // observation in a run would double-count every other one's.
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
    expect(result.rows.length).toBe(0);
  });

  it("files the refusals no window can own in the SECOND ledger, not nowhere", async () => {
    // UNPROVED CONTROL. `terms.ts` is a stub, so this fails on `not implemented`
    // whether it is right or wrong -- it has NEVER been executed against any
    // implementation. Its constants were derived by hand, and THAT IS ALL that
    // has been checked: `tsconfig.json` includes `src/**` alone, so nothing here
    // is type-checked and vitest transpiles without checking. Not even the API
    // shape is pinned. RE-CHECK IT AS A CONTROL, by breaking the body
    // deliberately, the day one lands.
    //
    // A row with no `invocation_id` is `unverifiable`, and one whose id this
    // transcript never echoes is `excludedForeign`. Neither can be in `mine` --
    // that is what makes them what they are -- so a ledger built only from the
    // window's own rows holds two of the four classes and `R_hi+`, which the
    // frozen metric defines over all four, comes out short in the direction that
    // stops the project.
    const transcript = await readTranscript(await fixture());
    const result = computeTerms({
      observation: observation({ originatedRequestIds: ALL_FOUR }),
      transcript,
      telemetry: [
        row,
        { ...row, invocation_id: undefined },
        { ...row, invocation_id: "99999999-9999-4999-8999-999999999999" },
      ],
      rates: DEFAULT_RATES,
      installedChars: 3_700,
      ambiguousIds: new Set(),
      disposition: "scored",
    });

    // The owned ledger stays empty: neither refusal belongs to this window.
    expect(result.refusals.unverifiable.count).toBe(0);
    expect(result.refusals.excludedForeign.count).toBe(0);
    // And they are not lost.
    expect(result.unattributedRefusals.unverifiable.count).toBe(1);
    expect(result.unattributedRefusals.excludedForeign.count).toBe(1);
    // Sized, not merely counted -- a refusal reported without its magnitude is
    // the silent exclusion the counters exist to prevent.
    expect(result.unattributedRefusals.unverifiable.units).toBeGreaterThan(0);
    // The credited arithmetic is untouched by either of them.
    expect(result.sHi).toBeCloseTo(17_243.243243243243, 6);
  });

  it("counts a delivery's closures off the row's own verdict, and absence is not failure", async () => {
    // UNPROVED CONTROL -- see the note in the test above.
    //
    // `MIN_REPAIR_CLOSURES` needs this and nothing carried it. `false` is a
    // repair that ran and did not close; `null` is a row that could not say --
    // `repair`'s abort path writes a detail with no verdict, and rows predating
    // the field exist on disk. Merging them would count "we did not look" as
    // evidence against the delivery.
    const transcript = await readTranscript(await fixture());
    const closed = computeTerms({
      observation: observation({ originatedRequestIds: ALL_FOUR }),
      transcript,
      telemetry: [{ ...row, tool: "repair", detail: { passed: true } }],
      rates: DEFAULT_RATES,
      installedChars: 3_700,
      ambiguousIds: new Set(),
      disposition: "scored",
    });
    expect(closed.perDelivery.repair?.closures).toBe(1);
    expect(closed.perDelivery.repair?.closureUnknown).toBe(0);

    const silent = computeTerms({
      observation: observation({ originatedRequestIds: ALL_FOUR }),
      transcript,
      telemetry: [{ ...row, tool: "repair", detail: { aborted: true } }],
      rates: DEFAULT_RATES,
      installedChars: 3_700,
      ambiguousIds: new Set(),
      disposition: "scored",
    });
    expect(silent.perDelivery.repair?.closures).toBe(0);
    // THE NEGATIVE CONTROL. A row that could not answer is counted HERE and
    // nowhere else; an implementation that ignored `null` would leave this at 0
    // and the artifact could not tell an unexercised delivery from an unreadable
    // one.
    expect(silent.perDelivery.repair?.closureUnknown).toBe(1);

    // AND THE THIRD ARM, without which the two above do not pin the rule. With
    // only `true` and `null` in the fixture, `closureUnknown += passed !== true`
    // satisfies both and quietly counts a repair that RAN AND DID NOT CLOSE as a
    // row that could not say. `false` is a measurement; it increments neither.
    const red = computeTerms({
      observation: observation({ originatedRequestIds: ALL_FOUR }),
      transcript,
      telemetry: [{ ...row, tool: "repair", detail: { passed: false } }],
      rates: DEFAULT_RATES,
      installedChars: 3_700,
      ambiguousIds: new Set(),
      disposition: "scored",
    });
    expect(red.perDelivery.repair?.rowCount).toBe(1);
    expect(red.perDelivery.repair?.closures).toBe(0);
    expect(red.perDelivery.repair?.closureUnknown).toBe(0);
  });

  it("meters the WHOLE lineage — a shortened transcript would shorten T and deflate R", async () => {
    // The multiplier comes off the full segment. If an implementation filtered
    // `transcript.requests` down to the window before pricing, `segmentSize`
    // would fall from 4 to 1 and sHi would collapse to the write component --
    // the exact deflation the frozen design says moves the deciding number by
    // about an order of magnitude, in the direction that stops the project.
    const transcript = await readTranscript(await fixture());
    const windowed = computeTerms({
      observation: observation({ originatedRequestIds: ["req-1", "req-2"] }),
      transcript,
      telemetry: [row],
      rates: DEFAULT_RATES,
      installedChars: 3_700,
      ambiguousIds: new Set(),
      disposition: "scored",
    });
    // Two requests in the window, but T is still 4, so the multiplier is still
    // 2.2 and sHi is unchanged from the all-four case.
    expect(windowed.sHi).toBeCloseTo(17_243.243243243243, 6);
    expect(windowed.sHi).not.toBeCloseTo(15_675.675675675675, 3); // T=2 would give this
    expect(windowed.billedRequestCount).toBe(2);
  });
});
