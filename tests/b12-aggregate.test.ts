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

import { aggregate, deliveryScore, poolRatio, recompute, rHiPlus, strataCells } from "../src/cost/b12/aggregate.js";
import type { ObservationTerms } from "../src/cost/b12/types.js";
import { creditedRow, ledger, terms } from "./b12-fixtures.js";

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

  it("credits the classes NO window can own, which is where two of the four live", () => {
    // UNPROVED CONTROL. `aggregate.ts` is a stub, so this fails on `not
    // implemented` whether it is right or wrong -- it has NEVER been executed
    // against any implementation. Its constants were derived by hand, and THAT
    // IS ALL that has been checked: `tsconfig.json` includes `src/**` alone, so
    // no file under `tests/` is type-checked by anything and vitest transpiles
    // without checking. Not even the API shape here is pinned. RE-CHECK IT AS A
    // CONTROL, by breaking the body deliberately, the day one lands. An oracle
    // nobody has watched fail is not yet evidence of anything.
    //
    // An `unverifiable` row has no `invocation_id` and an `excludedForeign` row's
    // id is absent from the transcript, so neither can ever be in a window's
    // owned set. A ledger built only from owned rows holds two classes, and
    // `R_hi+` is defined over four -- the fall-side figure was short by
    // construction, in the direction that stops the project.
    //
    // By hand: sHi 100 on aO 1000. Owned `ambiguous` 10; unattributed
    // `unverifiable` 20 and `excludedForeign` 30. refused = 60, so
    // (100+60)/(1000+100+60) = 160/1160.
    const both = terms({
      aO: 1_000,
      sHi: 100,
      refusals: ledger({ ambiguous: { count: 1, units: 10, unsized: 0 } }),
      unattributedRefusals: ledger({
        unverifiable: { count: 1, units: 20, unsized: 0 },
        excludedForeign: { count: 1, units: 30, unsized: 0 },
      }),
    });
    const result = rHiPlus([both]);
    expect(result.evaluable).toBe(true);
    if (result.evaluable) {
      expect(result.value).toBeCloseTo(160 / 1_160, 12);
      // THE NEGATIVE CONTROL, and it points DOWNWARD. Summing only the owned
      // ledger gives 110/1110 = 0.0991 against 0.1379 -- both under the 15% fall
      // line here, but the defective one is 28% lower, and this figure exists
      // precisely to decide whether a fall survives the most generous arithmetic
      // the data admits.
      expect(result.value).not.toBeCloseTo(110 / 1_110, 3);
    }
  });

  it("refuses on an unsized magnitude in EITHER ledger, not just the owned one", () => {
    // NEVER SEEN FAILING FOR ITS OWN REASON -- see the note above.
    //
    // `unmatched` is unsized BY CONSTRUCTION: the request that is missing is the
    // one a magnitude would have been priced against. If that arrives through
    // the unattributed ledger and the refusal check only reads the owned one,
    // `R_hi+` returns a confident number built on an unknown summed as zero.
    const unsizedElsewhere = terms({
      aO: 1_000,
      sHi: 100,
      unattributedRefusals: ledger({ unmatched: { count: 1, units: 0, unsized: 1 } }),
    });
    const result = rHiPlus([unsizedElsewhere]);
    expect(result.evaluable).toBe(false);
    if (!result.evaluable) expect(result.reason.length).toBeGreaterThan(0);
  });

  it("refuses a NEGATIVE unattributed magnitude, which duplication turns into a fall", () => {
    // UNPROVED CONTROL -- see the note in the first rHiPlus block above.
    //
    // An unattributed row may be counted twice: `scopeTelemetry` admits anything
    // within 60 s, so one row can sit in two observations' slices and nothing in
    // the declared types can tell. Duplication moves this figure in the
    // direction of the duplicated magnitude's SIGN, and `wouldHaveAdded` is
    // signed -- a row whose returned bytes exceed its capped raw bytes has a
    // negative magnitude, and this project has measured whole tools net negative.
    // A duplicated positive is safe (it can only prevent a fall); a duplicated
    // NEGATIVE manufactures one.
    const negative = terms({
      aO: 1_000,
      sHi: 100,
      unattributedRefusals: ledger({ excludedForeign: { count: 1, units: -400, unsized: 0 } }),
    });
    expect(rHiPlus([negative]).evaluable).toBe(false);

    // THE ANTI-VACUITY ARM. The same shape with the sign flipped is evaluable --
    // otherwise this test would be satisfied by an implementation that refuses
    // every non-empty unattributed ledger, which would make `R_hi+` unevaluable
    // on nearly every real run and quietly kill the fall side.
    const positive = terms({
      aO: 1_000,
      sHi: 100,
      unattributedRefusals: ledger({ excludedForeign: { count: 1, units: 400, unsized: 0 } }),
    });
    expect(rHiPlus([positive]).evaluable).toBe(true);
  });
});

describe("recompute — the row guard ranks per horizon, because the two disagree", () => {
  it("drops the LOW figure's biggest row from the low figure, not the high one's", () => {
    // UNPROVED CONTROL -- see the note in the first rHiPlus block above.
    //
    // `holdsIf` 2: a hold must survive deleting "its best task, its best row".
    // *Its* -- per figure. `units` is the high horizon's contribution and
    // `unitsLo` the low one's, so the rankings part company whenever rows sit at
    // different segment positions.
    //
    // Built so they disagree: obs `hi-heavy` owns the biggest `units` (100 vs
    // 80), obs `lo-heavy` the biggest `unitsLo` (70 vs 60).
    //   A = 200. S_hi = 180, S_lo = 130.
    //   rHiMinusRow drops 100 from `hi-heavy`:  80/(200+80)  = 0.285714...
    //   rLoMinusRow drops  70 from `lo-heavy`:  60/(200+60)  = 0.230769...
    const admitted = [
      terms({
        taskId: "hi-heavy",
        aO: 100,
        sHi: 100,
        sLo: 60,
        rows: [creditedRow({ units: 100, unitsLo: 60 })],
      }),
      terms({
        taskId: "lo-heavy",
        aO: 100,
        sHi: 80,
        sLo: 70,
        rows: [creditedRow({ units: 80, unitsLo: 70 })],
      }),
    ];
    const r = recompute(admitted, []);
    expect(r.rHiMinusRow).toBeCloseTo(80 / 280, 12);
    expect(r.rLoMinusRow).toBeCloseTo(60 / 260, 12);
    // THE NEGATIVE CONTROL. Ranking the low side by `units` drops `hi-heavy`'s
    // row from `sLo` instead, giving 70/270 = 0.2593 -- a number, which is why
    // the defect reads as a passed guard rather than as a missing one.
    expect(r.rLoMinusRow).not.toBeCloseTo(70 / 270, 3);
  });
});

describe("strataCells — a corrupted declaration is not a measured absence", () => {
  const soloTerms = (taskId: string, stratum: ObservationTerms["verificationStratum"]) =>
    terms({ taskId, aO: 100, sLo: 50, sHi: 50, verificationStratum: stratum });

  it("refuses BOTH declared cells while any observation's stratum is unrecognised", () => {
    // UNPROVED CONTROL -- see the note in the first rHiPlus block above.
    //
    // BOTH declared cells are stocked to five, which is the only way this test
    // says anything about `typesOnly`. With that cell left empty it would be
    // unevaluable on the 5-observation floor alone, and the assertion below
    // would pass just as well against the defect it exists to catch — a check
    // that cannot fail, inside the test written to catch checks that cannot
    // fail. The eleventh observation is the manifest typo: it belongs to one of
    // the two cells and nobody can say which, so BOTH are deflated by an unknown
    // amount. `holdsIf` 3 asks whether four cells are evaluable; it cannot ask
    // whether they hold what they claim to.
    const typo = "test_red" as ObservationTerms["verificationStratum"];
    const set = [
      ...[0, 1, 2, 3, 4].map((n) => soloTerms(`t${n}`, "test-red")),
      ...[0, 1, 2, 3, 4].map((n) => soloTerms(`y${n}`, "types-only")),
      soloTerms("typo", typo),
    ];
    const cells = strataCells(set);
    expect(cells.testRed.evaluable).toBe(false);
    expect(cells.typesOnly.evaluable).toBe(false);
    // AND THE RULE IS TARGETED, not a blanket refusal. All eleven windows have
    // an evaluable share, so `solo` holds eleven and stays scored -- an
    // implementation that voided every cell on any anomaly would pass the two
    // assertions above and be wrong about what was actually damaged.
    expect(cells.solo.evaluable).toBe(true);
  });
});

describe("deliveryScore — unexercised is a third state, never a low number", () => {
  const withGate = (n: number): ReturnType<typeof terms> =>
    terms({
      taskId: `t${n}`,
      aO: 100,
      sLo: 50,
      sHi: 50,
      perDelivery: {
        gate: { sLo: 30, sHi: 30, rowCount: 1, closures: 1, closureUnknown: 0 },
        repair: { sLo: 20, sHi: 20, rowCount: 1, closures: 1, closureUnknown: 0 },
      },
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

  it("counts CLOSURES per observation before scoring repair, and an unknown is not one", () => {
    // UNPROVED CONTROL -- see the note in the first rHiPlus block above.
    //
    // `holdsIf`: R_repair is scored only if ">= 5 admitted observations carry a
    // `repair` row AND at least two of THOSE carry `passed: true`". Observations,
    // not rows. `turns_collapsed` is `rounds.length` whether or not the failure
    // closed, so an unconditioned R_repair is maximised by `repair` flailing for
    // its full budget and returning red -- which is close to what B12's own
    // Phase-3 exposures actually measured.
    const withClosures = (n: number, closures: number, closureUnknown: number) =>
      terms({
        taskId: `c${n}`,
        aO: 100,
        sLo: 50,
        sHi: 50,
        perDelivery: {
          repair: {
            sLo: 50,
            sHi: 50,
            rowCount: Math.max(1, closures + closureUnknown),
            closures,
            closureUnknown,
          },
        },
      });

    // Five carrying observations, ONE of which closed. Over the observation
    // floor, under the closure floor.
    const one = [withClosures(0, 1, 0), ...[1, 2, 3, 4].map((n) => withClosures(n, 0, 0))];
    const short = deliveryScore(one, ["repair"], "lo", 2);
    expect(short.scored).toBe(false);
    if (!short.scored) expect(short.reason).toBe("unexercised");
    expect((short as { r?: number }).r).toBeUndefined();

    // Two closures in two observations: scored.
    const two = [withClosures(0, 1, 0), withClosures(1, 1, 0), ...[2, 3, 4].map((n) => withClosures(n, 0, 0))];
    expect(deliveryScore(two, ["repair"], "lo", 2).scored).toBe(true);

    // THE CONTROL FOR "OBSERVATIONS, NOT ROWS", and without it nothing here
    // distinguishes the two readings: every fixture above has `closures` of 0 or
    // 1, so summing rows and counting observations agree on 1, 2 and 1. Here ONE
    // observation closed twice. Summing gives 2 and scores it; counting
    // observations gives 1 and refuses. `holdsIf` says "at least two of THOSE" —
    // of the observations — so one task that closed twice is one closure, and a
    // delivery cannot clear its floor on a single window's repetitions.
    const twiceInOne = [
      withClosures(0, 2, 0),
      ...[1, 2, 3, 4].map((n) => withClosures(n, 0, 0)),
    ];
    expect(deliveryScore(twiceInOne, ["repair"], "lo", 2).scored).toBe(false);

    // THE NEGATIVE CONTROL. Four observations whose rows could not say whether
    // they closed are NOT four closures. An implementation counting any repair
    // row, or reading `closureUnknown` as a closure, scores this set -- and
    // `unexercised` is the safe answer because it is neither a hold nor a fall,
    // while a scored R_repair built on unreadable rows is a number nobody can
    // defend.
    const unknowns = [withClosures(0, 1, 0), ...[1, 2, 3, 4].map((n) => withClosures(n, 0, 1))];
    expect(deliveryScore(unknowns, ["repair"], "lo", 2).scored).toBe(false);
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

  it("reports identityHolds FALSE once the installation term is non-zero", () => {
    // UNPROVED CONTROL -- see the note in the first rHiPlus block above.
    //
    // The frozen design asserts `Σ_d R_d + R_other = R` and `identityHolds` says
    // "compute it; do not assume it". Computing it gives false:
    //   Σ_d numerator_d = S = 250      pooled numerator = S - O = 250 - 50 = 200
    // They differ by O on every run whose installation term is non-zero, and
    // `holdsIf` 6 requires O computed for EVERY observation. FINDINGS F11.
    //
    // The existing identity fixture in this file cannot see it: every `terms()`
    // in it leaves `oO` at 0, where the two expressions coincide. That is the
    // whole reason this assertion exists beside it.
    const withInstall = [0, 1, 2, 3, 4].map((n) =>
      terms({
        taskId: `i${n}`,
        aO: 100,
        sLo: 50,
        sHi: 50,
        oO: 10,
        perDelivery: {
          gate: { sLo: 30, sHi: 30, rowCount: 1, closures: 1, closureUnknown: 0 },
          repair: { sLo: 20, sHi: 20, rowCount: 1, closures: 1, closureUnknown: 0 },
        },
      })
    );
    const result = aggregate({ runId: "run-1", admitted: withInstall, dropped: [] });
    expect(result.identityHolds).toBe(false);
    // And the pooled figure is the one with O subtracted, so a reader can see
    // WHICH of the two the artifact decided on.
    expect(result.rLo).toBeCloseTo(200 / 750, 12);
  });

  it("leaves a stratum below the floor unevaluable rather than scoring it", () => {
    // `holdsIf` 3 wants four evaluable cells. Two observations is not a cell.
    const set = [terms({ taskId: "a", aO: 100, sLo: 50 }), terms({ taskId: "b", aO: 900 })];
    const result = aggregate({ runId: "run-1", admitted: set, dropped: [] });
    expect(result.strata.testRed.evaluable).toBe(false);
    expect(result.strata.solo.evaluable).toBe(false);
  });
});
