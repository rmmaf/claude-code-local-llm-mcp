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
import { runCoverage } from "../src/cost/b12/coverage.js";
import type { ObservationTerms } from "../src/cost/b12/types.js";
import {
  aggregateInput,
  coverageOf,
  keyed,
  ledger,
  refused,
  terms,
  twenty,
  universeOf,
} from "./b12-fixtures.js";

/** `rHiPlus` over a set, with the coverage the set itself implies. */
const fallSide = (all: readonly ObservationTerms[]) => rHiPlus(all, coverageOf(all));

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
    const result = fallSide([withUnsized]);
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
    const result = fallSide([sized]);
    expect(result.evaluable).toBe(true);
    if (result.evaluable) {
      expect(result.value).toBeCloseTo(200 / 1_200, 12);
      expect(result.value).not.toBeCloseTo(160 / 1_160, 6);
    }
  });

  it("credits the classes NO window can own, which is where two of the four live", () => {
    // PROVED CONTROL, 2026-08-07. Written against a stub, where it failed on
    // `not implemented` whether it was right or wrong; re-checked the day
    // `aggregate.ts` got a body by summing only the owned ledger, which brings
    // it back as 110/1110 = 0.0991 against 160/1160 = 0.1379. It fires for its
    // own reason and for no other.
    //
    // An `unverifiable` row has no `invocation_id` and an `excludedForeign` row's
    // id is absent from the transcript, so neither can ever be in a window's
    // owned set. A ledger built only from owned rows holds two classes, and
    // `R_hi+` is defined over four -- the fall-side figure was short by
    // construction, in the direction that stops the project.
    //
    // By hand: sHi 100 on aO 1000. Owned `ambiguous` 10; UNOWNED `unverifiable`
    // 20 and `excludedForeign` 30, reaching the figure through the run ledger.
    // refused = 60, so (100+60)/(1000+100+60) = 160/1160.
    const both = terms({
      aO: 1_000,
      sHi: 100,
      refusals: ledger({ ambiguous: { count: 1, units: 10, unsized: 0 } }),
      unattributed: [refused("u1", "unverifiable", 20), refused("u2", "excludedForeign", 30)],
    });
    const result = fallSide([both]);
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

  it("refuses an unsized UNOWNED magnitude, not just an unsized owned one", () => {
    // PROVED CONTROL -- see the note in the first rHiPlus block above. Rewritten
    // 2026-08-07: the unowned side now arrives as ROWS through `runCoverage`
    // rather than as a second per-observation ledger, because summing that
    // ledger across observations counted every shared row twice (F12).
    //
    // `unmatched` is unsized BY CONSTRUCTION: the request that is missing is the
    // one a magnitude would have been priced against. If the refusal check reads
    // only the owned ledger, `R_hi+` returns a confident number built on an
    // unknown summed as zero.
    const unsizedElsewhere = terms({
      aO: 1_000,
      sHi: 100,
      unattributed: [refused("u1", "unmatched", null)],
    });
    const result = fallSide([unsizedElsewhere]);
    expect(result.evaluable).toBe(false);
    if (!result.evaluable) expect(result.reason.length).toBeGreaterThan(0);
  });

  it("counts a row two observations both hold ONCE, which is the whole of F12", () => {
    // THE FIX ITSELF, and it replaces the guard that used to stand here. That
    // guard refused on a NEGATIVE unattributed class sum and was declared
    // incomplete in writing the day it landed -- a class sum of zero hides a +100
    // and a -100. It is gone with the sum it guarded.
    //
    // `scopeTelemetry` admits a row on a ±60,000 ms window as well as on an exact
    // id match, so one physical row sits in BOTH observations' slices whenever
    // two arms ran within a minute. `admissionRule` 5 names that window by hand.
    // Here both hold the same key `u1` at -400.
    //
    // By hand: A = 2000, S_hi = 200, refused = -400 counted once.
    //   (200 - 400) / (2000 + 200 - 400) = -200/1800 = -0.1111...
    // Counted twice it is (200 - 800) / (2000 + 200 - 800) = -600/1400 = -0.4286,
    // which is 3.9x further below the 15% fall line -- a fall manufactured out of
    // one row being read twice.
    const shared = refused("u1", "excludedForeign", -400);
    const two = [
      terms({ taskId: "a", aO: 1_000, sHi: 100, unattributed: [shared] }),
      terms({ taskId: "b", aO: 1_000, sHi: 100, unattributed: [shared] }),
    ];
    const result = fallSide(two);
    expect(result.evaluable).toBe(true);
    if (result.evaluable) {
      expect(result.value).toBeCloseTo(-200 / 1_800, 12);
      expect(result.value).not.toBeCloseTo(-600 / 1_400, 3);
    }

    // AND THE ANTI-VACUITY ARM: two DIFFERENT rows are still two rows. The
    // assertion above already catches an implementation that dropped the unowned
    // side entirely -- that returns 200/2200, not -200/1800 -- but not one that
    // deduplicates too hard, by disposition or by tool instead of by row
    // identity. Distinct keys at -400 each give
    // (200 - 800)/(2000 + 200 - 800) = -600/1400, the twice-counted number the
    // first arm refuses.
    const distinct = [
      terms({ taskId: "a", aO: 1_000, sHi: 100, unattributed: [refused("u1", "excludedForeign", -400)] }),
      terms({ taskId: "b", aO: 1_000, sHi: 100, unattributed: [refused("u2", "excludedForeign", -400)] }),
    ];
    const spread = fallSide(distinct);
    expect(spread.evaluable).toBe(true);
    if (spread.evaluable) expect(spread.value).toBeCloseTo(-600 / 1_400, 12);
  });

  it("refuses when a CREDITED row belongs to no window, which is the whole of F9", () => {
    // The row is real, its magnitude is known, and it is in no `S_o` and in none
    // of the four refusal classes -- so it was summed ZERO times and no void
    // condition saw it. `design.metric` defines `S_o` over "o's credited rows"
    // and limits `R_hi+`'s additions to the four classes, so crediting it here
    // would amend the estimand. The figure refuses instead.
    const orphan = terms({
      aO: 1_000,
      sHi: 100,
      unattributed: [keyed("c1", { units: 500, unitsLo: 300 })],
    });
    const result = fallSide([orphan]);
    expect(result.evaluable).toBe(false);
    // Reported with its size, so the artifact says how much was omitted rather
    // than only that something was.
    const coverage = coverageOf([orphan]);
    expect(coverage.unattributedCredited.count).toBe(1);
    expect(coverage.unattributedCredited.units).toBe(500);

    // THE ANTI-VACUITY ARM. The same shape with a REFUSED unowned row is
    // evaluable -- otherwise this would be satisfied by an implementation that
    // refuses on any unowned row at all, which would make `R_hi+` unevaluable on
    // nearly every real run and quietly kill the fall side.
    const refusedInstead = terms({
      aO: 1_000,
      sHi: 100,
      unattributed: [refused("r1", "excludedForeign", 500)],
    });
    expect(fallSide([refusedInstead]).evaluable).toBe(true);
  });

  it("refuses a row two observations both CLAIM, rather than picking one", () => {
    // An `invocation_id` is CALL identity, and `windowInvocationIds` maps tool-use
    // ids onto it with no one-to-one guarantee, so two windows can both own a
    // key. Assigning it to either would credit one task with another's saving;
    // assigning it to neither would drop it. It is refused and named.
    const shared = keyed("c1", { units: 500, unitsLo: 300 });
    const two = [
      terms({ taskId: "a", aO: 1_000, sHi: 100, rows: [shared] }),
      terms({ taskId: "b", aO: 1_000, sHi: 100, rows: [shared] }),
    ];
    expect(fallSide(two).evaluable).toBe(false);
    expect(coverageOf(two).contested).toHaveLength(1);
  });

  it("refuses a row of the run that fell into no observation's slice at all", () => {
    // THE ARGUMENT THAT MAKES `runCoverage` TAKE A UNIVERSE. `computeTerms` is
    // handed a slice `scopeTelemetry` has already narrowed, so a row outside
    // every window is absent from every `ObservationTerms` -- a coverage built
    // from the observations alone cannot see that it exists, and it has neither a
    // disposition nor a magnitude.
    const one = terms({ aO: 1_000, sHi: 100 });
    const coverage = runCoverage(universeOf("orphan-key"), [one]);
    expect(coverage.unsliced).toEqual(["orphan-key"]);
    expect(rHiPlus([one], coverage).evaluable).toBe(false);

    // ANTI-VACUITY: the same call with an empty universe is evaluable.
    expect(rHiPlus([one], runCoverage([], [one])).evaluable).toBe(true);
  });

  it("refuses an unowned row two slices priced differently, and does not average them", () => {
    // The two slices are two different transcripts. `wouldHaveAdded` prices
    // against the next billed request IN THAT TRANSCRIPT, so one physical row can
    // be worth 400 in one session's arithmetic and 900 in another's, and nothing
    // in the data says which transcript pays. Averaging, or taking either, would
    // publish a guess as a measurement.
    const two = [
      terms({ taskId: "a", aO: 1_000, sHi: 100, unattributed: [refused("u1", "excludedForeign", 400)] }),
      terms({ taskId: "b", aO: 1_000, sHi: 100, unattributed: [refused("u1", "excludedForeign", 900)] }),
    ];
    expect(fallSide(two).evaluable).toBe(false);
    const row = coverageOf(two).unownedRows[0];
    expect(row?.units).toBeNull();
    expect(row?.conflict).toContain("priced it differently");
  });
});

describe("recompute — the row guard ranks per horizon, because the two disagree", () => {
  it("drops the LOW figure's biggest row from the low figure, not the high one's", () => {
    // PROVED CONTROL -- see the note in the first rHiPlus block above.
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
        rows: [keyed("hi-row", { units: 100, unitsLo: 60 })],
      }),
      terms({
        taskId: "lo-heavy",
        aO: 100,
        sHi: 80,
        sLo: 70,
        rows: [keyed("lo-row", { units: 80, unitsLo: 70 })],
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
    // PROVED CONTROL -- see the note in the first rHiPlus block above.
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
    const cells = strataCells({ floor: set, ratio: set });
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
    const score = deliveryScore({ exercise: four, arithmetic: four }, ["gate"], "lo");
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
    const gate = deliveryScore({ exercise: five, arithmetic: five }, ["gate"], "lo");
    const repair = deliveryScore({ exercise: five, arithmetic: five }, ["repair"], "lo", 0);
    expect(gate.scored).toBe(true);
    expect(repair.scored).toBe(true);
    if (gate.scored && repair.scored) {
      expect(gate.r).toBeCloseTo(150 / 750, 12);
      expect(repair.r).toBeCloseTo(100 / 750, 12);
      expect(gate.r + repair.r).toBeCloseTo(poolRatio(five, "lo"), 12);
    }
  });

  it("counts CLOSURES per observation before scoring repair, and an unknown is not one", () => {
    // PROVED CONTROL -- see the note in the first rHiPlus block above.
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
    const short = deliveryScore({ exercise: one, arithmetic: one }, ["repair"], "lo", 2);
    expect(short.scored).toBe(false);
    if (!short.scored) expect(short.reason).toBe("unexercised");
    expect((short as { r?: number }).r).toBeUndefined();

    // Two closures in two observations: scored.
    const two = [withClosures(0, 1, 0), withClosures(1, 1, 0), ...[2, 3, 4].map((n) => withClosures(n, 0, 0))];
    expect(deliveryScore({ exercise: two, arithmetic: two }, ["repair"], "lo", 2).scored).toBe(true);

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
    expect(deliveryScore({ exercise: twiceInOne, arithmetic: twiceInOne }, ["repair"], "lo", 2).scored).toBe(false);

    // THE NEGATIVE CONTROL. Four observations whose rows could not say whether
    // they closed are NOT four closures. An implementation counting any repair
    // row, or reading `closureUnknown` as a closure, scores this set -- and
    // `unexercised` is the safe answer because it is neither a hold nor a fall,
    // while a scored R_repair built on unreadable rows is a number nobody can
    // defend.
    const unknowns = [withClosures(0, 1, 0), ...[1, 2, 3, 4].map((n) => withClosures(n, 0, 1))];
    expect(deliveryScore({ exercise: unknowns, arithmetic: unknowns }, ["repair"], "lo", 2).scored).toBe(false);
  });
});

describe("aggregate — the artifact publishes the banned form and decides on the other one", () => {
  it("reports the mean beside the pooled figure, and the two disagree by design", () => {
    const set = [terms({ taskId: "a", aO: 100, sLo: 50, sHi: 50 }), terms({ taskId: "b", aO: 900 })];
    const result = aggregate(aggregateInput(set));
    expect(result.rLo).toBeCloseTo(0.047619047619047616, 12);
    expect(result.meanOfPerObservationRatios).toBeCloseTo(0.16666666666666666, 12);
    // If these two are ever equal on this fixture, something started reading the
    // wrong one.
    expect(result.rLo).not.toBeCloseTo(result.meanOfPerObservationRatios, 3);
    expect(result.thresholds).toEqual({ hold: 0.3, fall: 0.15 });
    expect(result.admitted).toBe(2);
  });

  it("reports identityHolds FALSE once the installation term is non-zero", () => {
    // PROVED CONTROL -- see the note in the first rHiPlus block above.
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
    const result = aggregate(aggregateInput(withInstall));
    expect(result.identityHolds).toBe(false);
    // And the pooled figure is the one with O subtracted, so a reader can see
    // WHICH of the two the artifact decided on.
    expect(result.rLo).toBeCloseTo(200 / 750, 12);
  });

  it("leaves a stratum below the floor unevaluable rather than scoring it", () => {
    // `holdsIf` 3 wants four evaluable cells. Two observations is not a cell.
    const set = [terms({ taskId: "a", aO: 100, sLo: 50 }), terms({ taskId: "b", aO: 900 })];
    const result = aggregate(aggregateInput(set));
    expect(result.strata.testRed.evaluable).toBe(false);
    expect(result.strata.solo.evaluable).toBe(false);
  });

  it("publishes the coverage on the artifact's face even when it is what refused", () => {
    // `design.artifacts` owes a result file "whether it scores or voids", and the
    // reason a run returned `open` is the most useful thing on it. Carrying the
    // ledger rather than a boolean also lets a reader check the exactly-once
    // claim against `unownedRows` instead of taking the totals on trust.
    // The set is deliberately one that WOULD hold: `A = 100, S = 50` per
    // observation with `gate` carrying all of it. An empty fixture would return
    // `open` whether or not the orphan was noticed, which is the kind of
    // assertion that passes for the wrong reason -- and planting the defect is
    // how that was found.
    const set = twenty((n) => ({
      aO: 100,
      sLo: 50,
      sHi: 50,
      perDelivery: { gate: { sLo: 50, sHi: 50, rowCount: 1, closures: 1, closureUnknown: 0 } },
      ...(n === 0 ? { unattributed: [keyed("c1", { units: 500 })] } : {}),
    }));
    const result = aggregate(aggregateInput(set));
    expect(result.rHiPlus.evaluable).toBe(false);
    expect(result.coverage.exactlyOnce).toBe(false);
    expect(result.coverage.unownedRows).toHaveLength(1);
    expect(result.coverage.reasons[0]).toBe(
      result.rHiPlus.evaluable ? undefined : result.rHiPlus.reason
    );
    // `open`, not `void`. `design.metric` says it in words -- "If any refused
    // magnitude is `null`, `R_hi⁺` is NOT EVALUABLE and the run returns `open`" --
    // and `voidConditions` 15 says both "VOID" and "the run returns `open`" in one
    // sentence. Two of the three formulations name `open`, and it is also the only
    // one that does not spend an irreplaceable attempt on an ambiguity.
    expect(result.verdict).toBe("open");
    expect(result.voidClause).toBeNull();
  });
});

describe("the verdict — six states, and five of them were unreachable", () => {
  /** Twenty clean observations, every cell at the same figure. */
  const clean = (over: (n: number) => Partial<ObservationTerms> = () => ({})) =>
    twenty((n) => ({ aO: 100, sLo: 50, sHi: 50, ...over(n) }));

  it("VOIDS on the observation count, naming the clause", () => {
    // `voidConditions` 3 and `admissionRule` 2. Nothing checked this at all until
    // 2026-08-07: a three-observation run could return `fallen` on three
    // observations' arithmetic, which is the shape B1 died of.
    const short = aggregate(aggregateInput(clean().slice(0, 19)));
    expect(short.verdict).toBe("void");
    expect(short.voidClause).toContain("voidConditions 3");

    // AND THE OTHER SIDE. 30 tasks are HEADROOM: "the first 20 that admit, in that
    // committed order, are scored". This function cannot see the committed order,
    // so a caller handing it 21 has made a selection the manifest reserves.
    const long = clean();
    const over = aggregate(aggregateInput([...long, terms({ taskId: "extra", aO: 100 })]));
    expect(over.verdict).toBe("void");
  });

  it("VOIDS on a mixed rate basis, and on no rate basis at all", () => {
    // `admissionRule` 9: "The admitted set spans EXACTLY one rate key." G1's ratio
    // argument survives an unknown pricing basis only if the basis is CONSTANT.
    const mixed = aggregate(
      aggregateInput(clean((n) => (n === 3 ? { rateKeys: ["other-model"] } : {})))
    );
    expect(mixed.verdict).toBe("void");
    expect(mixed.voidClause).toContain("voidConditions 10");

    // ZERO IS AS WRONG AS TWO, and a `> 1` check would pass it: no observation
    // carrying a rate key means the instrument recorded no pricing basis.
    const none = aggregate(aggregateInput(clean(() => ({ rateKeys: [] }))));
    expect(none.verdict).toBe("void");
  });

  it("VOIDS when the excluded observations outweigh the admitted ones", () => {
    // `voidConditions` 16, both halves: "the pool was then selected on the
    // treatment's own attributability". Excluded rows are counted over `rows`,
    // credited AND refused -- the question is calls MADE, not calls scored, and
    // `perDelivery.rowCount` counts only the credited ones.
    const dropped = [
      terms({
        taskId: "x",
        disposition: "void(task_failed)",
        refusals: ledger({ ambiguous: { count: 1, units: 9_999, unsized: 0 } }),
      }),
    ];
    const heavy = aggregate(aggregateInput(clean(), { dropped, coverage: coverageOf([...clean(), ...dropped]) }));
    expect(heavy.verdict).toBe("void");
    expect(heavy.voidClause).toContain("voidConditions 16");
  });

  it("VOIDS when the two subagent strata disagree on a clean ledger, and NOT otherwise", () => {
    // `voidConditions` 17: "That is a coverage-bug signature, not a cost result."
    // `solo` observations are pushed above 30% while `multi` stays under 15%.
    const split = clean((n) => (n % 4 < 2 ? { sLo: 900, sHi: 900 } : { sLo: 5, sHi: 5 }));
    const bug = aggregate(aggregateInput(split));
    expect(bug.verdict).toBe("void");
    expect(bug.voidClause).toContain("voidConditions 17");

    // THE ANTI-VACUITY ARM, and it is the whole condition rather than half of it:
    // the SAME split with one refusal on the books is NOT this signature, because
    // a run with refusals has an ordinary explanation for the two strata parting.
    const explained = split.map((t, n) =>
      n === 0 ? terms({ ...t, refusals: ledger({ unmatched: { count: 1, units: 5, unsized: 0 } }) }) : t
    );
    expect(aggregate(aggregateInput(explained)).verdict).not.toBe("void");
  });

  it("VOIDS when a recomputation crosses the 15% line, and only that line", () => {
    // `voidConditions` 18. ONLY the fall line voids: across 30% the run "returns
    // `open` with both figures recorded and does NOT consume the attempt cap --
    // a run producing two defensible numbers straddling the hold line has measured
    // something".
    //
    // TWO big rows, one in a `solo` window and one in a `multi` one, and that is
    // not decoration: concentrating the whole numerator into ONE observation puts
    // its subagent stratum in a different band from the other's and trips clause
    // 17 first. The first draft of this fixture did exactly that and fired the
    // wrong clause -- a test that voids for a reason it was not written about
    // reads as a passing test.
    //
    // By hand, 20 observations at A = 100: two carry S = 300, eighteen carry 0.
    //   solo and multi:  300/(1000+300) = 23.08% each -- the SAME band
    //   R_lo:            600/(2000+600) = 23.08%      -- above the fall line
    //   drop the best row (300):  300/(2000+300) = 13.04%  -- below it
    const concentrated = clean((n) =>
      n === 0 || n === 2
        ? { sLo: 300, sHi: 300, rows: [keyed(`big-${n}`, { units: 300, unitsLo: 300 })] }
        : { sLo: 0, sHi: 0 }
    );
    const jackknifed = aggregate(aggregateInput(concentrated));
    expect(jackknifed.rLo).toBeCloseTo(600 / 2_600, 12);
    expect(jackknifed.recomputations.rLoMinusRow).toBeCloseTo(300 / 2_300, 12);
    expect(jackknifed.verdict).toBe("void");
    expect(jackknifed.voidClause).toContain("voidConditions 18");
  });

  it("VOIDS while a previously registered run carries no committed result", () => {
    // `voidConditions` 1: "B12 may not be scored while any registered run has no
    // result." The register is a REQUIRED argument for the same reason -- an
    // omitted field would be indistinguishable from a first run.
    const withGhost = aggregate(
      aggregateInput(clean(), {
        priorRuns: [{ runId: "run-0", result: null, attempt: { consumed: true } }],
      })
    );
    expect(withGhost.verdict).toBe("void");
    expect(withGhost.voidClause).toContain("voidConditions 1");
    expect(withGhost.abandonedRuns).toBe(1);

    // The same register with the result committed does not void, and the counts
    // come off the one field rather than off two that can disagree.
    const resolved = aggregate(
      aggregateInput(clean(), {
        priorRuns: [
          {
            runId: "run-0",
            result: { scored: false, voidClause: "voidConditions 7", bracket: { rLo: 0.1, rHi: 0.2 } },
            attempt: { consumed: true },
          },
        ],
      })
    );
    expect(resolved.verdict).not.toBe("void");
    expect(resolved.voidedRuns).toBe(1);
    expect(resolved.abandonedRuns).toBe(0);
  });

  it("demotes a fall to `open — provisional` when the strata are not both below 15%", () => {
    // F14, and the case the member exists for. `strataCells` pools at the LO
    // horizon while `R_hi⁺` is a doubt-credited HI figure, so the two can sit on
    // opposite sides of the fall line on one set.
    //
    // By hand, 20 observations at A=100, O=5, S_lo=30, S_hi=15 (reachable with
    // signed rows, e.g. 50/100 and -20/-85):
    //   each cell of 10:  (300 - 50) / (1000 + 300)  = 19.23%   -- at or above 15%
    //   R_hi+ over 20:    (300 - 100) / (2000 + 300) =  8.70%   -- below it
    // Both subagent strata sit in the SAME 15-30% band, so `voidConditions` 17
    // does not fire, and `fallsIf` demotes rather than falls.
    const set = twenty(() => ({ aO: 100, oO: 5, sLo: 30, sHi: 15 }));
    const result = aggregate(aggregateInput(set));
    expect(result.rHiPlus.evaluable).toBe(true);
    if (result.rHiPlus.evaluable) expect(result.rHiPlus.value).toBeCloseTo(200 / 2_300, 12);
    if (result.strata.solo.evaluable) expect(result.strata.solo.value).toBeCloseTo(250 / 1_300, 12);
    expect(result.verdict).toBe("open — provisional");
    expect(result.voidClause).toBeNull();
  });

  it("falls only when the subagent strata fall with it", () => {
    // The same shape with the strata dragged under 15% too. Without this arm the
    // test above is satisfied by an implementation that never returns `fallen` at
    // all, which would make the stopping criterion unreachable.
    const set = twenty(() => ({ aO: 100, oO: 40, sLo: 30, sHi: 15 }));
    const result = aggregate(aggregateInput(set));
    if (result.strata.solo.evaluable) expect(result.strata.solo.value).toBeLessThan(0.15);
    expect(result.verdict).toBe("fallen");
  });

  it("returns `holding (unvalidated)` rather than `open`, because a never-run A/B is a STATE", () => {
    // `holdsIf` 7 names it: "A never-run A/B leaves `holding (unvalidated)`, which
    // is a real recorded state and MAY NOT BE CITED AS AN INPUT TO OPENING OR
    // CLOSING ANY GATE." This function returned `open` there, on the argument that
    // a hold needs an A/B -- which collapsed a state the design provides into one
    // it distinguishes from it.
    //
    // Every one of `holdsIf` 1-6 has to hold: A=100, S=50 gives R_lo = 1/3 pooled
    // and in every cell, gate carries 40 of the 50, and nothing is refused.
    const set = twenty(() => ({
      aO: 100,
      sLo: 50,
      sHi: 50,
      perDelivery: { gate: { sLo: 50, sHi: 50, rowCount: 1, closures: 1, closureUnknown: 0 } },
    }));
    const result = aggregate(aggregateInput(set));
    expect(result.rLo).toBeCloseTo(1 / 3, 12);
    expect(result.verdict).toBe("holding (unvalidated)");
    // NEVER the bare `holding`, which needs an A/B that does not exist.
    expect(result.verdict).not.toBe("holding");
  });

  it("refuses that hold while a credited row belongs to no window", () => {
    // THE F9 GUARD, AND IT TURNED OUT TO BE SUBSUMED RATHER THAN OWED. "Omission
    // deflates the hold, which is the safe direction" was written during the F9
    // fix and is FALSE -- magnitudes are signed, so an omitted NEGATIVE credited
    // row RAISES `R_lo`, toward a hold -- so a guard was registered as owed to
    // whoever wrote a hold branch. Writing it as a conjunct of the hold produced
    // one that can never decide anything: `rHiPlus` refuses on exactly that fact,
    // so the run returns `open` before the hold is ever considered. Deleting the
    // conjunct changed no test, which is how that was established.
    //
    // So what this pins is the ORDER, not a conjunct: an otherwise-holding set
    // with one unowned credited row must not hold. The early return on an
    // unevaluable fall side is the thing doing the work.
    const set = twenty((n) => ({
      aO: 100,
      sLo: 50,
      sHi: 50,
      perDelivery: { gate: { sLo: 50, sHi: 50, rowCount: 1, closures: 1, closureUnknown: 0 } },
      ...(n === 0 ? { unattributed: [keyed("orphan", { units: -500, unitsLo: -500 })] } : {}),
    }));
    expect(aggregate(aggregateInput(set)).verdict).not.toBe("holding (unvalidated)");
  });
});

describe("the hold arithmetic — admissionRule 6 gives the run two domains", () => {
  /**
   * Twenty observations that HOLD, with observation 0 carrying an ambiguous
   * refusal and a saving four and a half times its neighbours'.
   *
   * DERIVED BY HAND. Nineteen at `A = 100, S = 44`; observation 0 at
   * `A = 100, S = 200`; every row's saving is `gate`'s.
   *
   *   published `R_lo`   (20 obs)  1036 / (2000 + 1036) = 34.12%  — clears 30%
   *   hold `R_lo`        (19 obs)   836 / (1900 +  836) = 30.56%  — clears it too
   *   hold `R_all`  (19 + obs 0 reinstated at S = 0)
   *                                 836 / (2000 +  836) = 29.48%  — DOES NOT
   *
   * So the published side holds, the hold pool holds, and the DILUTION guard is
   * the single thing that refuses. That is deliberate: a fixture blocked by three
   * conditions at once cannot say which one it was written about.
   */
  const twoDomains = () =>
    twenty((n) => ({
      aO: 100,
      sLo: n === 0 ? 200 : 44,
      sHi: n === 0 ? 200 : 44,
      perDelivery: {
        gate: { sLo: n === 0 ? 200 : 44, sHi: n === 0 ? 200 : 44, rowCount: 1, closures: 1, closureUnknown: 0 },
      },
      ...(n === 0
        ? { refusals: ledger({ ambiguous: { count: 1, units: 10, unsized: 0 } }) }
        : {}),
    }));

  it("refuses a hold the published bracket would have granted, and names the domain", () => {
    const result = aggregate(aggregateInput(twoDomains()));

    // The published bracket is over the FULL admitted set, ambiguous observation
    // included -- `conflictsResolved` 5 resolves the fork as "admitted to the FALL
    // arithmetic at both bounds", and `fallsIf` reads `R_lo` by that name.
    expect(result.rLo).toBeCloseTo(1_036 / 3_036, 12);
    expect(result.admitted).toBe(20);

    // The hold domain is one observation smaller, and says so on the face.
    expect(result.hold.basis).toBe("hold-eligible");
    expect(result.hold.eligible).toBe(19);
    expect(result.hold.excludedForAmbiguity).toBe(1);
    expect(result.hold.rLo).toBeCloseTo(836 / 2_736, 12);

    // AND THE SINGLE REFUSING CONDITION, ASSERTED SO THE TEST CANNOT PASS FOR
    // ANOTHER REASON. Every other hold conjunct clears 30%; `R_all` does not.
    expect(result.hold.rLo).toBeGreaterThanOrEqual(0.3);
    expect(result.hold.recomputations.rLoMinusTask).toBeGreaterThanOrEqual(0.3);
    expect(result.hold.recomputations.rLoMinusRow).toBeGreaterThanOrEqual(0.3);
    expect(result.hold.recomputations.rAll).toBeCloseTo(836 / 2_836, 12);
    expect(result.hold.recomputations.rAll).toBeLessThan(0.3);
    expect(result.hold.gate.scored && result.hold.gate.r >= 0.3).toBe(true);

    expect(result.verdict).toBe("open");
    expect(result.voidClause).toBeNull();
  });

  it("reads an UNOWNED ambiguous row, which the finding's own predicate would have missed", () => {
    // `FINDINGS.md` F19 proposed `t.refusals.ambiguous.count === 0`. `refusals`
    // holds only rows this window OWNS, and `report.ts` counts `ambiguous` over
    // the whole telemetry slice with no ownership filter -- `admissionRule` 5 pins
    // the meaning to that counter by name. So an observation whose ambiguous rows
    // are all unowned still withheld its `savedFraction` and is still the
    // observation clause 6 keeps out of the hold.
    //
    // THE SAME FIXTURE WITH THE REFUSAL MOVED TO THE OTHER LEDGER. Nothing else
    // changes, so any difference in verdict is the predicate and nothing else.
    const set = twoDomains().map((t, n) =>
      n === 0
        ? terms({
            ...t,
            refusals: ledger(),
            unattributed: [refused("unowned-ambiguous", "ambiguous", 10)],
            unattributedRefusals: ledger({ ambiguous: { count: 1, units: 10, unsized: 0 } }),
          })
        : t
    );
    const result = aggregate(aggregateInput(set));

    expect(result.hold.excludedForAmbiguity).toBe(1);
    expect(result.hold.recomputations.rAll).toBeLessThan(0.3);
    expect(result.verdict).toBe("open");
  });

  it("leaves the published face alone, cell for cell, while the hold domain moves", () => {
    // THE ASSEMBLY HAZARD, AND IT IS THE ONE PLACE BOTH DOMAINS ARE IN SCOPE.
    // `decideHold` cannot see the published figures at all, but `aggregate` builds
    // both and fills one `B12Result`, and `StrataCells` is `StrataCells` -- putting
    // the hold cells on the face is an assignment away and no type would object.
    const set = twoDomains();
    const result = aggregate(aggregateInput(set));

    // Computed independently here rather than read back off the result, so this
    // compares the artifact against the rule instead of against itself.
    const face = strataCells({ floor: set, ratio: set });
    expect(result.strata).toEqual(face);

    // And the two genuinely differ, so the assertion above is not vacuous: the
    // `test-red` and `solo` cells both contain observation 0.
    if (result.strata.solo.evaluable && result.hold.strata.solo.evaluable) {
      expect(result.strata.solo.value).toBeCloseTo(596 / 1_596, 12);
      expect(result.hold.strata.solo.value).toBeCloseTo(396 / 1_296, 12);
      expect(result.strata.solo.value).not.toBeCloseTo(result.hold.strata.solo.value, 6);
    }
    expect(result.strata.solo.evaluable).toBe(true);
  });

  it("counts the delivery's EXERCISE floor on the admitted set and its ratio on the hold one", () => {
    // `design.metric`: "A delivery with fewer than 5 ADMITTED observations carrying
    // its rows is `unexercised`". Clause 6 leaves such an observation admitted, so
    // a window whose telemetry carries a `gate` row exercised `gate` whatever its
    // refusals say about who owns the saving.
    //
    // EXACTLY FIVE CARRY, AND ONE OF THEM IS AMBIGUOUS-BEARING. Collapsing the two
    // populations onto the hold-eligible set -- the obvious implementation --
    // leaves four and turns a delivery that ran into one that was never asked.
    const set = twenty((n) => ({
      aO: 100,
      sLo: 44,
      sHi: 44,
      ...(n < 5
        ? {
            perDelivery: {
              gate: { sLo: 44, sHi: 44, rowCount: 1, closures: 1, closureUnknown: 0 },
            },
          }
        : {}),
      ...(n === 0
        ? { refusals: ledger({ ambiguous: { count: 1, units: 10, unsized: 0 } }) }
        : {}),
    }));
    const result = aggregate(aggregateInput(set));

    expect(result.hold.excludedForAmbiguity).toBe(1);
    expect(result.hold.gate.scored).toBe(true);
    expect(result.hold.gate.observations).toBe(5);
    // The ratio is the hold domain's: four carrying observations' rows over the
    // 19-observation denominator.
    if (result.hold.gate.scored) expect(result.hold.gate.r).toBeCloseTo(176 / 2_736, 12);
  });

  it("catches a HIGH-side recomputation across 30%, which no hold condition reads", () => {
    // `voidConditions` 18 names five recomputations — "R_lo-t, R_lo-r, R_hi-t,
    // R_hi-r, R_all" — and gives them two readings, 15% and 30%. The first fix
    // mirrored only the three LOW ones at 30%, which silently narrowed the clause
    // to its low-side half.
    //
    // **NOTHING ELSE IN THE VERDICT CAN CATCH THIS.** Every `holdsIf` condition is
    // a low-side figure, so a high-side straddle is invisible to `decideHold`;
    // only this check sees it. No ambiguous refusal is needed either, which is why
    // the fixture carries none: the defect is on the published side alone.
    //
    // BY HAND, twenty observations at `A = 100, S_lo = 50`, and observation 0
    // carrying `S_hi = 700` against the others' 20:
    //
    //   R_lo, R_lo⁻ᵗ, R_lo⁻ʳ, R_all   all 33.33% — no low-side straddle at all
    //   R_hi                          1080 / (2000 + 1080) = 35.06%  — above 30%
    //   R_hi⁻ᵗ  (obs 0 deleted)         380 / (1900 +  380) = 16.67%  — BELOW
    //
    // 16.67% is still above 15%, so `voidConditions` 18's other reading does not
    // fire and the run must return `open` rather than void.
    const set = twenty((n) => ({
      aO: 100,
      sLo: 50,
      sHi: n === 0 ? 700 : 20,
      perDelivery: { gate: { sLo: 50, sHi: 50, rowCount: 1, closures: 1, closureUnknown: 0 } },
    }));
    const result = aggregate(aggregateInput(set));

    expect(result.rHi).toBeCloseTo(1_080 / 3_080, 12);
    expect(result.recomputations.rHiMinusTask).toBeCloseTo(380 / 2_280, 12);
    // ABOVE THE FALL LINE, so this is the 30% reading and not the void.
    expect(result.recomputations.rHiMinusTask).toBeGreaterThan(0.15);

    // The whole low side is clean, so nothing the hold reads objects.
    expect(result.rLo).toBeCloseTo(1 / 3, 12);
    expect(result.hold.rLo).toBeCloseTo(1 / 3, 12);
    expect(result.hold.recomputations.rLoMinusTask).toBeCloseTo(1 / 3, 12);
    expect(result.hold.recomputations.rAll).toBeCloseTo(1 / 3, 12);
    expect(result.hold.excludedForAmbiguity).toBe(0);

    expect(result.verdict).toBe("open");
    expect(result.voidClause).toBeNull();
  });

  it("keeps a stratum cell EVALUABLE on its admitted count while pricing it on fewer", () => {
    // `holdsIf` 3 asks for "All four declared strata evaluable (≥ 5 ADMITTED
    // observations each) and all four on the same side of 30%", and
    // `admissionRule` 8 repeats the floor in the same words. Clause 6 moves only
    // the arithmetic, so evaluability is an admitted-set property.
    //
    // SIX OF THE TEN `test-red` OBSERVATIONS CARRY AN AMBIGUOUS REFUSAL, leaving
    // four to price the cell — so what this proves is "evaluable on TEN, priced on
    // four", and the title said five and four until Codex checked the fixture
    // against `twenty()`, which puts ten observations in each cell. The point
    // stands and the arithmetic did not change; the claim did.
    //
    // Reading the floor off the hold domain would call the cell unevaluable and
    // return `open` for a reason the design does not give. That the cell then
    // blocks the hold on its RATIO is a different fact, and `FINDINGS.md` F21
    // records the gap the literal reading leaves open.
    const set = twenty((n) => ({
      aO: 100,
      sLo: 44,
      sHi: 44,
      ...(n % 2 === 0 && n <= 10
        ? { refusals: ledger({ ambiguous: { count: 1, units: 1, unsized: 0 } }) }
        : {}),
    }));
    const result = aggregate(aggregateInput(set));

    expect(result.hold.excludedForAmbiguity).toBe(6);
    expect(result.hold.strata.testRed.evaluable).toBe(true);
    expect(result.strata.testRed.evaluable).toBe(true);
    if (result.hold.strata.testRed.evaluable) {
      // Four observations, not ten: the floor came from the admitted set and the
      // ratio did not.
      expect(result.hold.strata.testRed.value).toBeCloseTo(176 / 576, 12);
    }

    // **AND THE CELL SAYS SO ON THE ARTIFACT.** Until F21 a cell was an
    // `Evaluable<number>` and nothing more, so a bracket resting on four
    // observations was indistinguishable from one resting on ten. Reported,
    // compared with nothing: the floor still reads `counted`, and adding a second
    // floor on `priced` was adjudicated and refused.
    expect(result.hold.strata.testRed.counted).toBe(10);
    expect(result.hold.strata.testRed.priced).toBe(4);

    // The published face is one population, so the pair coincides there — which is
    // what makes the divergence above legible rather than ambient.
    for (const cell of [
      result.strata.testRed,
      result.strata.typesOnly,
      result.strata.solo,
      result.strata.multi,
    ]) {
      expect(cell.counted).toBe(cell.priced);
    }
  });

  it("carries both counts on BOTH unevaluable branches, which is where they matter most", () => {
    // A cell reports its populations whether or not it has a bracket, and there
    // are TWO ways to have no bracket. Called directly rather than through
    // `aggregate`, because a 20-observation fixture cannot put a cell under the
    // 5-observation floor and `twenty()` fills every cell with ten.
    //
    // THE FLOOR BRANCH. Four `test-red` against five `types-only`, and the ratio
    // population is smaller still — so the unevaluable cell reports 4 and 2, and a
    // reader can see both that it was short and that it would have been priced on
    // fewer again.
    const cells = (n: number, stratum: "test-red" | "types-only") =>
      Array.from({ length: n }, () => terms({ aO: 100, sLo: 44, sHi: 44, verificationStratum: stratum }));
    const floor = [...cells(4, "test-red"), ...cells(5, "types-only")];
    const byFloor = strataCells({ floor, ratio: floor.slice(0, 2) });
    expect(byFloor.testRed.evaluable).toBe(false);
    expect(byFloor.testRed.counted).toBe(4);
    expect(byFloor.testRed.priced).toBe(2);
    expect(byFloor.typesOnly.evaluable).toBe(true);
    expect(byFloor.typesOnly.counted).toBe(5);
    expect(byFloor.typesOnly.priced).toBe(0);

    // THE CORRUPTED BRANCH, over populations that DIFFER — which the published-face
    // fixture below cannot test, because there floor and ratio are the same set and
    // a defect confined to this branch would report the right numbers by accident.
    const corruptedFloor = [
      ...cells(5, "test-red"),
      ...cells(5, "types-only"),
      terms({ aO: 100, verificationStratum: "test_red" as unknown as "test-red" }),
    ];
    const split = strataCells({ floor: corruptedFloor, ratio: corruptedFloor.slice(0, 3) });
    expect(split.testRed.evaluable).toBe(false);
    expect(split.typesOnly.evaluable).toBe(false);
    expect(split.testRed.counted).toBe(5);
    expect(split.testRed.priced).toBe(3);
    // The two declared cells report DIFFERENT numbers, which one shared object
    // could not have done.
    expect(split.typesOnly.counted).toBe(5);
    expect(split.typesOnly.priced).toBe(0);

    const short = aggregate(
      aggregateInput(
        twenty((n) => ({
          aO: 100,
          sLo: 44,
          sHi: 44,
          // Every `types-only` observation but one carries an ambiguous refusal:
          // ten admitted, one priced.
          ...(n % 2 === 1 && n !== 1
            ? { refusals: ledger({ ambiguous: { count: 1, units: 1, unsized: 0 } }) }
            : {}),
        }))
      )
    );
    expect(short.hold.strata.typesOnly.counted).toBe(10);
    expect(short.hold.strata.typesOnly.priced).toBe(1);
    // Ten admitted clears the frozen floor, so the cell is evaluable on a bracket
    // pooled from ONE observation. That is `FINDINGS.md` F21 stated as a number
    // rather than as a paragraph.
    expect(short.hold.strata.typesOnly.evaluable).toBe(true);

    // AND THE CORRUPTED BRANCH. `strata.ts` sends an unrecognised declaration to
    // `unknownStratum`, which makes both declared cells unevaluable — and each
    // still carries its OWN two counts, not a shared pair.
    const corrupted = aggregate(
      aggregateInput(
        twenty((n) => ({
          aO: 100,
          sLo: 44,
          sHi: 44,
          ...(n === 0 ? { verificationStratum: "test_red" as unknown as "test-red" } : {}),
        }))
      )
    );
    expect(corrupted.strata.testRed.evaluable).toBe(false);
    expect(corrupted.strata.typesOnly.evaluable).toBe(false);
    // Nine, not ten: observation 0's declaration was not recognised, so it is in
    // neither declared cell. The two cells differ, which a shared object could not
    // have shown.
    expect(corrupted.strata.testRed.counted).toBe(9);
    expect(corrupted.strata.typesOnly.counted).toBe(10);
  });

  it("names the basis its selection figures were built under", () => {
    // `voidConditions` 16 and `holdsIf` 5 compare "the EXCLUDED observations"
    // against "the ADMITTED set", and since `admissionRule` 6 an observation can be
    // both admission-admitted and hold-excluded. The frozen text picks neither
    // extension (`FINDINGS.md` F20), so the artifact says which one produced its
    // numbers instead of leaving a reader to assume the design chose.
    //
    // **A LABEL, NOT A CONTROL, AND WHAT IT CANNOT DO IS THE PART WORTH WRITING.**
    // It pins the emitted literal against being dropped, and nothing more. It is
    // blind to the thing a reader would most want caught: change `selectionOf` to
    // the hold-arithmetic reading and leave the label alone, and this assertion
    // still passes. No test can close that — a label is only as true as the person
    // who last edited the function beside it, which is why F20 stays OPEN and why
    // this is not counted among the proved controls in `FINDINGS.md`.
    //
    // An earlier version of this comment claimed the opposite, that the assertion
    // "breaks a test if the convention changes without the label". It does not.
    const result = aggregate(aggregateInput(twoDomains()));
    expect(result.selection.basis).toBe("disposition");
  });

  it("returns `open` when a PUBLISHED recomputation straddles 30% and the hold domain does not", () => {
    // `voidConditions` 18's other half: "Across 30% it returns `open` with both
    // figures recorded and does NOT consume the attempt cap." Not a void.
    //
    // **THIS CHECK WAS THE LAST CONJUNCT OF THE HOLD AND COULD NOT FIRE THERE.**
    // The conjuncts above it already required `R_lo` and all three low
    // recomputations at or above 30%, so every operand was on the same side by the
    // time it was read (`FINDINGS.md` F22). It can only decide anything over the
    // PUBLISHED figures, which the hold conjuncts do not constrain — and only when
    // the two domains differ, since they are the same numbers otherwise.
    //
    // BY HAND, with `O_o = 0` throughout. Observation 0 is a large, high-ratio task
    // (`A = 300, S = 300`); observation 1 carries the ambiguous refusal and no
    // saving at all (`A = 100, S = 0`); the other eighteen are `A = 100, S = 44`.
    //
    //   published `R_lo`          1092 / (2200 + 1092) = 33.17%  — above 30%
    //   published `R_lo⁻ᵗ`  (obs 0, the largest `A_o`, deleted)
    //                              792 / (1900 +  792) = 29.42%  — BELOW: straddle
    //   hold `R_lo`         (obs 1 excluded)
    //                             1092 / (2100 + 1092) = 34.21%  — above
    //   hold `R_lo⁻ᵗ`              792 / (1800 +  792) = 30.56%  — above
    //   hold `R_all`   (obs 1 back at S = 0)
    //                             1092 / (2200 + 1092) = 33.17%  — above
    //
    // So every hold condition passes and the run still returns `open`, on a figure
    // the hold arithmetic never sees.
    const set = twenty((n) => {
      const aO = n === 0 ? 300 : 100;
      const s = n === 0 ? 300 : n === 1 ? 0 : 44;
      return {
        aO,
        sLo: s,
        sHi: s,
        perDelivery: { gate: { sLo: s, sHi: s, rowCount: 1, closures: 1, closureUnknown: 0 } },
        ...(n === 1
          ? { refusals: ledger({ ambiguous: { count: 1, units: 10, unsized: 0 } }) }
          : {}),
      };
    });
    const result = aggregate(aggregateInput(set));

    expect(result.rLo).toBeCloseTo(1_092 / 3_292, 12);
    expect(result.recomputations.rLoMinusTask).toBeCloseTo(792 / 2_692, 12);
    expect(result.recomputations.rLoMinusTask).toBeLessThan(0.3);

    // EVERY HOLD CONDITION CLEARS, which is what makes this test about the straddle
    // and not about the hold domain. Without those assertions it would pass for
    // whichever conjunct happened to fail first.
    expect(result.hold.rLo).toBeGreaterThanOrEqual(0.3);
    expect(result.hold.recomputations.rLoMinusTask).toBeCloseTo(792 / 2_592, 12);
    expect(result.hold.recomputations.rLoMinusTask).toBeGreaterThanOrEqual(0.3);
    expect(result.hold.recomputations.rLoMinusRow).toBeGreaterThanOrEqual(0.3);
    expect(result.hold.recomputations.rAll).toBeGreaterThanOrEqual(0.3);
    expect(result.hold.gate.scored && result.hold.gate.r >= 0.3).toBe(true);
    for (const cell of [
      result.hold.strata.testRed,
      result.hold.strata.typesOnly,
      result.hold.strata.solo,
      result.hold.strata.multi,
    ]) {
      expect(cell.evaluable && cell.value >= 0.3).toBe(true);
    }

    // A VOID WOULD BE WRONG HERE: only the 15% line voids, and nothing crosses it.
    expect(result.verdict).toBe("open");
    expect(result.voidClause).toBeNull();
  });

  it("is IDENTICAL to the published domain on a run with no ambiguous refusal", () => {
    // The other half of the pair, and the reason the divergence needs controls at
    // all: on every clean run the two domains are the same set, every figure
    // coincides, and a defect in the partition is invisible. The frozen preflight
    // asserts `ambiguous === 0`, so a clean run is the expected case.
    const clean = twenty(() => ({
      aO: 100,
      sLo: 50,
      sHi: 50,
      perDelivery: { gate: { sLo: 50, sHi: 50, rowCount: 1, closures: 1, closureUnknown: 0 } },
    }));
    const result = aggregate(aggregateInput(clean));

    expect(result.hold.excludedForAmbiguity).toBe(0);
    expect(result.hold.eligible).toBe(20);
    expect(result.hold.rLo).toBe(result.rLo);
    expect(result.hold.strata).toEqual(result.strata);
    expect(result.hold.gate).toEqual(result.gate);
    expect(result.hold.recomputations.rLoMinusTask).toBe(result.recomputations.rLoMinusTask);
    expect(result.hold.recomputations.rAll).toBe(result.recomputations.rAll);
    expect(result.verdict).toBe("holding (unvalidated)");
  });
});
