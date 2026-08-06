/**
 * ORACLE FOR UNIT 3 — `src/cost/b12/aggregate.ts`.
 *
 * Depends on `strata.ts` for `strataCells`. Independent of `terms.ts`: every
 * fixture here is an `ObservationTerms` literal, so the pooling arithmetic is
 * pinned without a transcript anywhere near it.
 *
 * Every expected value derived by hand from `design.metric`.
 */

import { describe, expect, it } from "vitest";

import { aggregate, deliveryScore, poolRatio, rHiPlus } from "../src/cost/b12/aggregate.js";
import { terms } from "./b12-fixtures.js";

describe("poolRatio — the one arithmetic every figure in the artifact goes through", () => {
  it("is a RATIO OF SUMS, which is not the mean of per-observation ratios", () => {
    // The design bans `saved_o / billed_o` per observation and the mean of those
    // ratios BY NAME as the deciding form: a small observation with a large
    // fraction and a large one with none are not two votes of equal weight.
    //
    // By hand: obs A saves 50 on 100 billed; obs B saves nothing on 900. Ratio
    // of sums is 50/(1000+50) = 0.047619...; the banned mean is (1/3 + 0)/2 =
    // 0.16666..., 3.5x larger. An implementation that averaged would pass a
    // tolerance test on one observation and fail here.
    const set = [terms({ taskId: "a", aO: 100, sLo: 50, sHi: 50 }), terms({ taskId: "b", aO: 900 })];
    expect(poolRatio(set, "lo")).toBeCloseTo(0.047619047619047616, 12);
    expect(poolRatio(set, "lo")).not.toBeCloseTo(0.16666666666666666, 3);
  });

  it("subtracts the installation term from the NUMERATOR and never from the denominator", () => {
    // `R = (sum S - sum O) / (sum A + sum S)`. `O_o` is what installing the
    // server costs whether or not a tool is called: a charge against the saving,
    // not an addition to the bill being compared.
    const one = [
      terms({ aO: 5_800, sLo: 15_675.675675675675, sHi: 17_243.243243243243, oO: 2_300 }),
    ];
    expect(poolRatio(one, "lo")).toBeCloseTo(0.6228290964007048, 12);
    expect(poolRatio(one, "hi")).toBeCloseTo(0.6484869809992962, 12);
  });

  it("carries a net-negative observation as the cost it is, with no clamp", () => {
    // `run 2026-08-04-mac-09` measured `repair` net negative on 12 of 12 calls
    // against a TypeScript gate, and the pre-flight put `gate` at -467.1 units.
    // A clamp here turns a tool that ADDED context into one that saved nothing.
    const set = [terms({ aO: 1_000, sLo: -500, sHi: -500 })];
    expect(poolRatio(set, "lo")).toBeCloseTo(-1, 12); // -500 / 500
  });

  it("returns 0 rather than NaN when there is nothing to divide", () => {
    expect(poolRatio([], "lo")).toBe(0);
  });
});

describe("rHiPlus — the fall-side figure, and the one thing that makes it refuse", () => {
  it("is NOT EVALUABLE when any refused magnitude could not be sized", () => {
    // "An unknown may not be summed as zero." A run that cannot size a refusal
    // returns `open` rather than falling: a fall on a deflated instrument stops
    // the project permanently, strictly the worse of the two errors, and the one
    // every source design left unguarded.
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
    if (!result.evaluable) expect(result.reason.length).toBeGreaterThan(0);
  });

  it("grants every refused row its magnitude across all FOUR classes", () => {
    // By hand: sHi 100, one refusal in each class at 10, 20, 30 and 40 units.
    // Numerator 100 + 100 = 200 over 1000 + 200 = 1200, so 1/6.
    // `excludedForeign` is in that sum and is the class that shipped as a bare
    // counter -- with three classes instead of four this returns 160/1160.
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
  const withGate = (n: number): ReturnType<typeof terms> =>
    terms({
      taskId: `t${n}`,
      aO: 100,
      sLo: 50,
      sHi: 50,
      perDelivery: { gate: { sLo: 30, sHi: 30, rowCount: 1 }, repair: { sLo: 20, sHi: 20, rowCount: 1 } },
    });

  it("refuses to score below the observation floor, and returns NO number at all", () => {
    // A delivery nobody exercised has not failed to pay for itself; it has not
    // been asked. A 0 would put it under 15% and fire the stopping criterion on
    // an absence.
    const four = [0, 1, 2, 3].map(withGate);
    const score = deliveryScore(four, ["gate"], "lo");
    expect(score.scored).toBe(false);
    if (!score.scored) {
      expect(score.reason).toBe("unexercised");
      expect(score.observations).toBe(4);
    }
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
    // 250/(500+250) = 1/3; gate 150/750 = 0.2; repair 100/750 = 0.13333.
    const five = [0, 1, 2, 3, 4].map(withGate);
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

describe("aggregate — the artifact publishes the banned form and decides on the other one", () => {
  it("reports the mean beside the pooled figure, and the two disagree by design", () => {
    const set = [terms({ taskId: "a", aO: 100, sLo: 50, sHi: 50 }), terms({ taskId: "b", aO: 900 })];
    const result = aggregate({ runId: "run-1", admitted: set, dropped: [] });
    expect(result.rLo).toBeCloseTo(0.047619047619047616, 12);
    expect(result.meanOfPerObservationRatios).toBeCloseTo(0.16666666666666666, 12);
    // If these two are ever equal on this fixture, something started reading the
    // wrong one.
    expect(result.rLo).not.toBeCloseTo(result.meanOfPerObservationRatios, 3);
    expect(result.thresholds).toEqual({ hold: 0.3, fall: 0.15 });
    expect(result.admitted).toBe(2);
  });

  it("leaves a stratum below the floor unevaluable rather than scoring it", () => {
    // `holdsIf` 3 wants four evaluable cells. Two observations is not a cell.
    const set = [terms({ taskId: "a", aO: 100, sLo: 50 }), terms({ taskId: "b", aO: 900 })];
    const result = aggregate({ runId: "run-1", admitted: set, dropped: [] });
    expect(result.strata.testRed.evaluable).toBe(false);
    expect(result.strata.solo.evaluable).toBe(false);
  });
});
