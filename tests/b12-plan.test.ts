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

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildPlan, planDrift, planText } from "../scripts/b12-plan.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

/**
 * THE OTHER HALF OF THE SAME BINDING, and it was missing until adversarial review
 * asked for it by name. The test above pins the plan to its generator; nothing
 * pinned the SPECS to the plan.
 *
 * The hazard is specific, not theoretical. `b12-spec.mjs:142` SKIPS a task whose
 * spec dir already exists — deliberately, because rewriting a spec would detach a
 * published tag from the bytes that produced it. So editing a task's predicate in
 * the plan after its spec is written changes nothing on disk and reports nothing:
 * the plan says one thing, the sealed base carries another, and the manifest is
 * built from the spec. It is safe today only because the two tasks whose predicate
 * moved had no spec dir yet.
 */
describe("every written spec still agrees with the plan it was generated from", () => {
  it("no spec has drifted from its task", () => {
    const plan = buildPlan();
    const drifted: string[] = [];
    let compared = 0;
    for (const task of plan.tasks) {
      const file = path.join(REPO, task.specDir, "spec.json");
      // A task with no spec yet is not drift — it is unwritten. `b12-spec.mjs`
      // reports that count itself and it is not this test's question.
      if (!existsSync(file)) continue;
      compared += 1;
      const spec = JSON.parse(readFileSync(file, "utf8"));
      const mismatch = (what: string, have: unknown, want: unknown): void => {
        if (JSON.stringify(have) !== JSON.stringify(want)) {
          drifted.push(`${task.id}: ${what} is ${JSON.stringify(have)}, plan says ${JSON.stringify(want)}`);
        }
      };
      mismatch("predicate.argv", spec.predicate?.argv, task.predicateArgv);
      mismatch("fileScope", spec.fileScope, task.fileScope);
      mismatch("parent", spec.parent, plan.parent);
      mismatch("manifest.verificationCommands", spec.manifest?.verificationCommands, task.verificationCommands);
      mismatch("manifest.verificationStratum", spec.manifest?.verificationStratum, task.verificationStratum);
      mismatch("manifest.gateCategory", spec.manifest?.gateCategory, task.gateCategory);
    }
    // Asserted rather than assumed: a bug that made this loop compare nothing
    // would otherwise pass as loudly as a clean corpus.
    expect(compared).toBeGreaterThan(0);
    expect(drifted).toEqual([]);
  });
});
