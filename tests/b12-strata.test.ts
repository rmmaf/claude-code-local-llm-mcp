/**
 * ORACLE FOR UNIT 1 — `src/cost/b12/strata.ts`.
 *
 * First in the chain because it depends on nothing: `terms.ts` imports
 * `subagentShare` from it and `aggregate.ts` imports `partitionByStrata`, so it
 * has to close before either of them can.
 *
 * Every expected value is derived by hand from the frozen design. A constant
 * copied out of a passing run would make this file a transcript of whatever the
 * implementation happens to do, which is the one thing an oracle must not be.
 */

import { afterEach, describe, expect, it } from "vitest";

import { partitionByStrata, subagentShare } from "../src/cost/b12/strata.js";
import type { ObservationTerms } from "../src/cost/b12/types.js";
import { readTranscript } from "../src/cost/transcript.js";
import { makeScratch, observation, req, subRequest, terms, writeSession } from "./b12-fixtures.js";

const scratch = makeScratch();
afterEach(async () => scratch.cleanup());

describe("subagentShare — covariate 1, the only one the design says gates both verdicts", () => {
  async function mainAndSub(): Promise<string> {
    return writeSession(scratch.tempRoot(), [
      req("req-main", 0, { write1h: 100 }),
      subRequest("req-sub", 1_000, "s1"),
    ]);
  }

  it("is UNEVALUABLE for a window with no billed request of its own, not a share of zero", async () => {
    // Zero is what a genuinely single-threaded session measures. Reporting it
    // for a window that measured nothing files an empty observation into the
    // `solo` stratum and lets it vote on a cell it never contributed to -- the
    // same distinction the refusal ledger makes between a magnitude of zero and
    // one nobody could size.
    const transcript = await readTranscript(await mainAndSub());
    const share = subagentShare(observation({ originatedRequestIds: [] }), transcript);
    expect(share.evaluable).toBe(false);
    if (!share.evaluable) expect(share.reason.length).toBeGreaterThan(0);
  });

  it("puts ANY subagent request in `multi` — the threshold is zero, not a fraction", async () => {
    // `admissionRule` 8: `solo` is ZERO subagent-originated records. It is not a
    // percentage and must not be turned into one.
    const transcript = await readTranscript(await mainAndSub());

    const solo = subagentShare(observation({ originatedRequestIds: ["req-main"] }), transcript);
    expect(solo.evaluable).toBe(true);
    if (solo.evaluable) {
      expect(solo.value.own).toBe(1);
      expect(solo.value.sidechain).toBe(0);
      expect(solo.value.share).toBe(0);
      expect(solo.value.stratum).toBe("solo");
    }

    const both = subagentShare(
      observation({ originatedRequestIds: ["req-main", "req-sub"] }),
      transcript
    );
    expect(both.evaluable).toBe(true);
    if (both.evaluable) {
      expect(both.value.own).toBe(2);
      expect(both.value.sidechain).toBe(1);
      expect(both.value.share).toBeCloseTo(0.5, 12);
      expect(both.value.stratum).toBe("multi");
    }
  });

  it("counts only the window's OWN requests, not every request in the transcript", async () => {
    // The transcript holds both; the window holds one. An implementation that
    // read `transcript.requests` without filtering returns own=2 here, and every
    // observation in a run would inherit its neighbours' session shape.
    const transcript = await readTranscript(await mainAndSub());
    const only = subagentShare(observation({ originatedRequestIds: ["req-sub"] }), transcript);
    expect(only.evaluable).toBe(true);
    if (only.evaluable) {
      expect(only.value.own).toBe(1);
      expect(only.value.share).toBe(1);
      expect(only.value.stratum).toBe("multi");
    }
  });
});

describe("partitionByStrata — five buckets, and the fifth is why there are five", () => {
  it("splits the verification stratum off the DECLARED field, never off the result", () => {
    const set = [
      terms({ taskId: "a", verificationStratum: "test-red" }),
      terms({ taskId: "b", verificationStratum: "types-only" }),
      terms({ taskId: "c", verificationStratum: "test-red" }),
    ];
    const p = partitionByStrata(set);
    expect(p.testRed.map((t) => t.taskId)).toEqual(["a", "c"]);
    expect(p.typesOnly.map((t) => t.taskId)).toEqual(["b"]);
  });

  it("files an unrecognised stratum in its OWN bucket rather than dropping it", () => {
    // `verificationStratum` is typed as a two-value union, but it is READ from
    // `evidence/<runId>/obs-<taskId>-<arm>/observation.json` and no validator for
    // it exists anywhere in this repository. The union is a claim about the
    // manifest, not a guarantee from the compiler, and the cast below is what a
    // manifest typo actually delivers at runtime.
    //
    // The `if` / `else if` with no `else` that stood here dropped such an
    // observation from BOTH declared cells, silently, while it went on counting
    // in `solo` -- so `holdsIf` 3, which requires four evaluable cells, would
    // have read a deflated count with nothing recording that anything went
    // missing. Enumerate the good values; refuse the ones the rule does not name.
    const typo = "test_red" as ObservationTerms["verificationStratum"];
    const set = [
      terms({ taskId: "a", verificationStratum: "test-red" }),
      terms({ taskId: "typo", verificationStratum: typo }),
      terms({ taskId: "b", verificationStratum: "types-only" }),
    ];
    const p = partitionByStrata(set);
    expect(p.unknownStratum.map((t) => t.taskId)).toEqual(["typo"]);
    expect(p.testRed.map((t) => t.taskId)).toEqual(["a"]);
    expect(p.typesOnly.map((t) => t.taskId)).toEqual(["b"]);
    // The two axes are independent -- a corrupt stratum says nothing about the
    // subagent share -- so the observation still belongs to `solo`. That
    // independence is exactly what made the drop invisible: every count that DID
    // move looked healthy.
    expect(p.solo.map((t) => t.taskId)).toContain("typo");
  });

  it("puts an unevaluable share in NEITHER solo nor multi", () => {
    // A bucket that absorbed them would make the two cells look complete while
    // one of them silently carried the unknowns -- and `holdsIf` 3 requires all
    // four cells evaluable and on one side of 30%, which is a claim about cells
    // that actually hold what they say they hold.
    const set = [
      terms({
        taskId: "solo-1",
        subagentShare: { evaluable: true, value: { own: 2, sidechain: 0, share: 0, stratum: "solo" } },
      }),
      terms({
        taskId: "multi-1",
        subagentShare: { evaluable: true, value: { own: 2, sidechain: 1, share: 0.5, stratum: "multi" } },
      }),
      terms({ taskId: "unknown-1", subagentShare: { evaluable: false, reason: "no own requests" } }),
    ];
    const p = partitionByStrata(set);
    expect(p.solo.map((t) => t.taskId)).toEqual(["solo-1"]);
    expect(p.multi.map((t) => t.taskId)).toEqual(["multi-1"]);
    expect(p.unevaluableShare.map((t) => t.taskId)).toEqual(["unknown-1"]);
    // The count that matters: solo + multi is NOT the whole admitted set.
    expect(p.solo.length + p.multi.length).toBe(2);
  });
});
