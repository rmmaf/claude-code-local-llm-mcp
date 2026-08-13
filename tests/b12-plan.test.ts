/**
 * THE ARTIFACT AND ITS GENERATOR, BOUND TOGETHER.
 *
 * `b12-corpus/corpus-plan.json` opens by claiming it is "generated and
 * constraint-checked, not hand-listed". For four commits nothing could check
 * that: the generator lived in a session's temp scratchpad, so the claim was
 * true on the day it was written and unfalsifiable ever after — and `reaches()`,
 * the constraint that catches a suite paired with a file it cannot see, would
 * have gone with it.
 *
 * The plan is upstream of 60 sealed corpus bases and of both manifests' committed
 * order, which `admissionRule` 2 scores. A hand-edit that nothing notices is
 * therefore not a documentation problem.
 */

import { describe, expect, it } from "vitest";

import { buildPlan, planDrift, planText } from "../scripts/b12-plan.mjs";

describe("the corpus plan is generator output, not a hand-edited artifact", () => {
  it("b12-corpus/corpus-plan.json is exactly what scripts/b12-plan.mjs emits", () => {
    // A failure here means one of two things and the message says which: the plan
    // was edited by hand, or the generator was changed without regenerating.
    // Either way the fix is `node scripts/b12-plan.mjs write`, after reading the
    // diff — not editing the JSON until this passes.
    expect(planDrift()).toBeNull();
  });

  it("emits the same bytes twice, so the check above cannot pass by luck", () => {
    expect(planText()).toBe(planText());
  });

  it("carries the shape the rest of the toolchain reads off it", () => {
    // Not a restatement of the generator's own constraints — those throw inside
    // buildPlan and are covered by the first test. These are the fields OTHER
    // scripts index into, where a rename would fail somewhere far away:
    // b12-spec.mjs:101 reads predicateArgv, b12-author.mjs reads {id, specDir}.
    const plan = buildPlan();
    expect(plan.tasks).toHaveLength(60);
    expect(plan.parent).toHaveLength(40);
    for (const task of plan.tasks) {
      expect(task.specDir).toBe(`b12-corpus/${task.id}`);
      expect(task.predicateArgv.length).toBeGreaterThan(0);
      expect(task.verificationCommands).toEqual([task.predicateArgv.join(" ")]);
    }
  });
});
