/**
 * ORACLE FOR UNIT 4 — `src/cost/b12/coverage.ts`.
 *
 * Independent of transcripts and of `terms.ts`: every fixture is an
 * `ObservationTerms` literal, so what is pinned here is the resolution of one
 * physical row across several slices and nothing else.
 *
 * The consequences of each rule — what `rHiPlus` does with the result — live in
 * `b12-aggregate.test.ts`. This file pins the ledger; that one pins the figure.
 */

import { describe, expect, it } from "vitest";

import { identify, runCoverage } from "../src/cost/b12/coverage.js";
import { keyed, refused, terms, universeOf } from "./b12-fixtures.js";

const A = "telemetry.jsonl";
const k = (ordinal: number): string => JSON.stringify([A, ordinal]);

describe("identify — an identity that survives a row with no invocation id", () => {
  it("keys by artifact and ordinal, and encodes the pair rather than joining it", () => {
    const record = { ts: "t", tool: "gate", bytes_raw: 0, bytes_returned: 0, turns_collapsed: 0, latency_ms: 0 };
    expect(identify(A, [record, record]).map((r) => r.key)).toEqual([k(0), k(1)]);

    // THE CONTROL FOR THE ENCODING. Two rows may not share a key, and a path may
    // contain the separator: `a#b` ordinal 1 and `a` ordinal `b#1` would collide
    // under `${source}#${ordinal}`. Two byte-identical records in one file are
    // also the ordinary case, which is why the ordinal is in the key at all.
    const collidable = identify("a#b", [record]);
    expect(collidable[0]?.key).not.toBe("a#b#0");
    expect(new Set(identify(A, [record, record]).map((r) => r.key)).size).toBe(2);
  });
});

describe("runCoverage — every row of the run, exactly once", () => {
  it("resolves a clean run and says so", () => {
    const one = terms({ taskId: "a", rows: [keyed(k(0))], unattributed: [refused(k(1), "unverifiable", 20)] });
    const coverage = runCoverage(universeOf(k(0), k(1)), [one]);
    expect(coverage.exactlyOnce).toBe(true);
    expect(coverage.reasons).toEqual([]);
    expect(coverage.ownedBy.get(k(0))).toBe("a/treatment");
    expect(coverage.unowned.unverifiable).toEqual({ count: 1, units: 20, unsized: 0 });
  });

  it("keeps a row ONE observation owns out of the run ledger, however many slices saw it", () => {
    // THE RULE THAT KEEPS ORDINARY RUNS SCORABLE. Two arms a minute apart put the
    // same rows in both slices — `scopeTelemetry` admits on a ±60,000 ms window —
    // so the owning observation's price is taken and every other slice's copy is
    // discarded. Without this, every single-owner row on such a run would go
    // through the conflict rules below and `R_hi+` would be unevaluable on runs
    // the design intends to score.
    const shared = keyed(k(0), { units: 500 });
    const two = [
      terms({ taskId: "a", rows: [shared] }),
      // `b` saw the same physical row and does not own it. Its own copy is priced
      // differently, which is what two transcripts do, and it is ignored.
      terms({ taskId: "b", unattributed: [keyed(k(0), { units: 900 })] }),
    ];
    const coverage = runCoverage(universeOf(k(0)), two);
    expect(coverage.exactlyOnce).toBe(true);
    expect(coverage.ownedBy.get(k(0))).toBe("a/treatment");
    expect(coverage.unownedRows).toEqual([]);
    expect(coverage.unattributedCredited.count).toBe(0);
  });

  it("enters a row NO observation owns once, however many slices held it", () => {
    // THE F12 FIX. The same physical row in two slices is one row: the ledger is
    // keyed, so it is entered once at its agreed magnitude rather than summed per
    // observation.
    const both = [
      terms({ taskId: "a", unattributed: [refused(k(0), "excludedForeign", -400)] }),
      terms({ taskId: "b", unattributed: [refused(k(0), "excludedForeign", -400)] }),
    ];
    const coverage = runCoverage(universeOf(k(0)), both);
    expect(coverage.exactlyOnce).toBe(true);
    expect(coverage.unownedRows).toHaveLength(1);
    expect(coverage.unowned.excludedForeign).toEqual({ count: 1, units: -400, unsized: 0 });
    // Both slices are named, so a reader can see the duplication was seen and
    // resolved rather than silently collapsed.
    expect(coverage.unownedRows[0]?.slices).toEqual(["a/treatment", "b/treatment"]);
  });

  it("refuses a row two slices priced differently, and does not pick or average", () => {
    // The two slices are two transcripts, and `wouldHaveAdded` prices against the
    // next billed request IN THAT transcript. Nothing in the data says which one
    // pays, so the magnitude is unknown — and an unknown may not be summed as
    // zero, or as either candidate.
    const disagree = [
      terms({ taskId: "a", unattributed: [refused(k(0), "excludedForeign", 400)] }),
      terms({ taskId: "b", unattributed: [refused(k(0), "excludedForeign", 900)] }),
    ];
    const coverage = runCoverage(universeOf(k(0)), disagree);
    expect(coverage.unownedRows[0]?.units).toBeNull();
    expect(coverage.unowned.excludedForeign).toEqual({ count: 1, units: 0, unsized: 1 });
    expect(coverage.exactlyOnce).toBe(false);
  });

  it("treats a number beside a null as a CONFLICT, not as one distinct value", () => {
    // THE NEGATIVE CONTROL FOR THE SIZING RULE, and the one an earlier draft got
    // wrong. "Exactly one distinct non-null value" reads this as agreement at
    // 400 and discards the slice that could not size the row — the
    // unknown-summed-as-zero collapse under another name. Every occurrence must
    // be sized AND equal.
    const mixed = [
      terms({ taskId: "a", unattributed: [refused(k(0), "excludedForeign", 400)] }),
      terms({ taskId: "b", unattributed: [refused(k(0), "excludedForeign", null)] }),
    ];
    const coverage = runCoverage(universeOf(k(0)), mixed);
    expect(coverage.unownedRows[0]?.units).toBeNull();
    expect(coverage.unowned.excludedForeign.units).toBe(0);
    expect(coverage.unowned.excludedForeign.unsized).toBe(1);
  });

  it("refuses a row whose slices disagree about what it IS", () => {
    // Reachable, and only for three of the five dispositions. `unverifiable` is
    // decided by `entry.invocation_id === undefined` and `ambiguous` by the
    // run-level id set, so neither can vary between slices; `credited`,
    // `excludedForeign` and `unmatched` are each decided against the transcript
    // doing the pricing. None of the four frozen classes means "the transcripts
    // disagree about what this row is", so it is unsized and named.
    const disagree = [
      terms({ taskId: "a", unattributed: [refused(k(0), "excludedForeign", 400)] }),
      terms({ taskId: "b", unattributed: [refused(k(0), "unmatched", 400)] }),
    ];
    const coverage = runCoverage(universeOf(k(0)), disagree);
    const row = coverage.unownedRows[0];
    expect(row?.units).toBeNull();
    expect(row?.conflict).toContain("disagree on disposition");
    // Filed under the first class in sorted slice order, which decides NOTHING:
    // the row is unsized either way and `rHiPlus` refuses.
    expect(row?.disposition).toBe("excludedForeign");
  });

  it("counts a credited row no window owns separately, with its size", () => {
    // F9. It is in no `S_o` and in none of the four refusal classes, so before
    // this counter existed it was summed zero times and nothing saw it.
    const orphan = terms({ taskId: "a", unattributed: [keyed(k(0), { units: 500 })] });
    const coverage = runCoverage(universeOf(k(0)), [orphan]);
    expect(coverage.unattributedCredited).toEqual({ count: 1, units: 500, unsized: 0 });
    // NOT in any refusal class, which is the point: the four are frozen and a
    // credited row is in none of them.
    expect(coverage.unowned.excludedForeign.count).toBe(0);
    expect(coverage.exactlyOnce).toBe(false);
  });

  it("refuses a key two observations both CLAIM rather than assigning it", () => {
    const shared = keyed(k(0), { units: 500 });
    const two = [
      terms({ taskId: "a", rows: [shared] }),
      terms({ taskId: "b", rows: [shared] }),
    ];
    const coverage = runCoverage(universeOf(k(0)), two);
    expect(coverage.contested).toEqual([{ key: k(0), claimants: ["a/treatment", "b/treatment"] }]);
    // In NEITHER the owned map nor the unowned ledger. Assigning it to a claimant
    // credits one task with another's saving; dropping it silently is F9 again.
    expect(coverage.ownedBy.has(k(0))).toBe(false);
    expect(coverage.unownedRows).toEqual([]);
    expect(coverage.exactlyOnce).toBe(false);
  });

  it("finds a row of the run that no observation's slice ever saw", () => {
    // THE ARGUMENT THAT MAKES THE UNIVERSE A PARAMETER. `computeTerms` receives a
    // slice `scopeTelemetry` has already narrowed, so a row outside every window
    // is absent from every `ObservationTerms` — a coverage built from those alone
    // cannot see that it exists at all.
    const one = terms({ taskId: "a", rows: [keyed(k(0))] });
    const coverage = runCoverage(universeOf(k(0), k(7)), [one]);
    expect(coverage.unsliced).toEqual([k(7)]);
    expect(coverage.exactlyOnce).toBe(false);

    // ANTI-VACUITY: the rows that WERE sliced do not report themselves missing.
    expect(coverage.unsliced).not.toContain(k(0));
  });

  it("does not depend on the order the caller passes its observations in", () => {
    // Every tie is broken in sorted label order, so two callers reading the same
    // run cannot publish two different ledgers — the failure mode `invocationOwners`
    // already carries a VOID condition for (`voidConditions` 19).
    const build = (order: readonly string[]) =>
      runCoverage(
        universeOf(k(0)),
        order.map((taskId) => terms({ taskId, unattributed: [refused(k(0), "excludedForeign", 400)] }))
      );
    expect(build(["a", "b"])).toEqual(build(["b", "a"]));
  });
});
