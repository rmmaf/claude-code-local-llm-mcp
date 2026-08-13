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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildPlan, planDrift, planText } from "../scripts/b12-plan.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = (): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(REPO, "b12-corpus", "manifest-config.json"), "utf8"));
/** sha256 of a blob AT A COMMIT — never the working tree, which a dirty file would move. */
const shaAt = (rev: string, rel: string): string =>
  createHash("sha256")
    .update(execFileSync("git", ["show", `${rev}:${rel}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }))
    .digest("hex");

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

/**
 * THE THIRD LEVEL OF THE SAME BINDING. The plan is pinned to its generator; the 60 specs are
 * pinned to the plan; and `b12-corpus/manifest-config.json` restates BOTH 30-id manifests,
 * `specRoot` and `ratesSha256` with nothing comparing them to anything.
 *
 * That is the identical duplication class that produced a real defect two commits ago, and it
 * would be worse here: `deriveTask` reads the SPEC dir, so a reordered or substituted id in the
 * config seals a manifest whose committed order differs from the one every stratum argument was
 * made against — and admissionRule 2 scores that order. Every downstream check stays green.
 *
 * Nothing in this file needs git tags, a network, or a filled pin, so it costs a few
 * milliseconds and runs on every `npm test`.
 */
describe("manifest-config.json agrees with the plan it declares", () => {
  it("restates both manifests, specRoot and ratesSha256 exactly", () => {
    const plan = buildPlan();
    const cfg = config();
    expect(cfg.manifestA).toEqual(plan.manifestA);
    expect(cfg.manifestB).toEqual(plan.manifestB);
    expect(cfg.specRoot).toBe(plan.specRoot);
    expect((cfg.pinned as { ratesSha256: string }).ratesSha256).toBe(plan.ratesSha256);
  });

  it("keeps the three KNOWN-HERE pins equal to the bytes they name", () => {
    // The config's own note warns these "go stale the moment that file changes", and NOTHING in
    // the toolchain compares them to reality — b12-run.mjs:1066-1067 check presence only, and the
    // harness seal freezes b12RunSha256 permanently. Going red here is the alarm working.
    const plan = buildPlan();
    const pinned = config().pinned as Record<string, string>;
    expect(pinned.b12RunSha256).toBe(shaAt("HEAD", "scripts/b12-run.mjs"));
    expect(pinned.claudeMdSha256).toBe(shaAt("HEAD", "CLAUDE.md"));
    expect(pinned.ratesSha256).toBe(shaAt(plan.parent, ".local-coder/rates.json"));
  });

  it("declares scoringCommand as a TEMPLATE pinning the --audit form", () => {
    // TWO DECISIONS, BOUND SO THAT REVERTING EITHER IS LOUD.
    //
    // The placeholder: clause 19 compares exact equality against an invocation
    // rebuilt from the whole argv (assemble.ts:1172, emit.ts:316), so a literal
    // id here is right for at most one of the seven manifests. The assembler
    // refuses a template without it; this asserts the config never stops being
    // one, which the assembler cannot say about a value it never sees.
    //
    // The `--audit` form: the prescribed loop emits twice (audit.ts:15) and one
    // of the two must diverge from the pin. Pinning the bare form voids the
    // FINAL scored artifact; pinning this one voids the first, provisional
    // emission instead — already final:false with clauses 4-6 UNCHECKED. The
    // path is the only one committedAuditCheck accepts (emit.ts:57).
    const command = (config().pinned as { scoringCommand: string }).scoringCommand;
    expect(command).toBe("node dist/cost/b12/emit.js <runId> --audit evidence/<runId>.b12.audit.json");
  });
});

/**
 * THE A/B PAIRS, DERIVED RATHER THAN DESCRIBED — and the difference is the whole point of this
 * block. An earlier version asserted the pairs' PROPERTIES: six of them, 3/3 strata, 3/3 arm
 * orders, inside the first 20. Adversarial review noted that a different six-task set holding
 * all those properties would still pass, so the test could not tell the declared selection from
 * a quietly substituted one — which is exactly the failure it exists to prevent, since the
 * selection rule is the only defence against choosing pairs that flatter the result.
 *
 * So the rule is implemented here and its output compared. The rule, in full: THE FIRST SIX IDS
 * OF THE COMMITTED ORDER, with arm order alternating within stratum, test-red opening
 * treatment-first and types-only opening control-first.
 *
 * None of this is enforced by the toolchain. `parseManifestConfig`, `manifestDeclarationGaps`
 * and `checkCore` between them require six in A, membership, unique ids and both orders present
 * — and nothing else. They also only run when the assembler is invoked by hand, so a typo would
 * otherwise surface on the run machine, where a paid session pays for it.
 */
describe("the declared A/B pairs are exactly what the stated rule produces", () => {
  /** The rule, implemented once. If this and the config disagree, one of them moved. */
  const expectedPairs = (
    plan: ReturnType<typeof buildPlan>,
    which: "manifestA" | "manifestB"
  ): Array<{ id: string; taskId: string; order: string }> => {
    const letter = which === "manifestA" ? "a" : "b";
    const nth: Record<string, number> = { "test-red": 0, "types-only": 0 };
    const opening: Record<string, string> = { "test-red": "treatment-first", "types-only": "control-first" };
    const flip = (o: string): string => (o === "treatment-first" ? "control-first" : "treatment-first");
    return plan[which].slice(0, 6).map((taskId) => {
      const stratum = plan.tasks.find((t) => t.id === taskId)?.verificationStratum ?? "";
      nth[stratum] = (nth[stratum] ?? 0) + 1;
      return {
        id: `ab-${letter}-${taskId}`,
        taskId,
        order: (nth[stratum] ?? 0) % 2 === 1 ? (opening[stratum] ?? "") : flip(opening[stratum] ?? ""),
      };
    });
  };

  it("both pair sets equal the rule's output, element for element", () => {
    const plan = buildPlan();
    const cfg = config();
    expect(cfg.abPairsA).toEqual(expectedPairs(plan, "manifestA"));
    expect(cfg.abPairsB).toEqual(expectedPairs(plan, "manifestB"));
  });

  it("and the rule's output still satisfies what the toolchain will demand of it", () => {
    // Not a restatement of the test above: this is what would REFUSE at assembly, so it holds
    // even if someone changes the rule deliberately. Six in A is frozen at b12-register.mjs:95;
    // B is only required to reach three, and six there is a choice argued in the config's note.
    const plan = buildPlan();
    const cfg = config();
    for (const [name, owner] of [
      ["abPairsA", plan.manifestA],
      ["abPairsB", plan.manifestB],
    ] as const) {
      const pairs = cfg[name] as Array<{ id: string; taskId: string; order: string }>;
      expect(pairs.length, `${name} count`).toBe(6);
      expect(new Set(pairs.map((p) => p.id)).size, `${name} duplicate pair id`).toBe(pairs.length);
      expect(new Set(pairs.map((p) => p.order)).size, `${name} needs both arm orders`).toBe(2);
      for (const p of pairs) {
        expect(p.id.length, `${name} empty pair id`).toBeGreaterThan(0);
        expect(owner, `${name}: ${p.taskId} is not in that manifest`).toContain(p.taskId);
        expect(["treatment-first", "control-first"]).toContain(p.order);
      }
      // The confound a position-alternating order would have introduced: the committed order
      // alternates strata, so alternating by POSITION makes every test-red pair treatment-first.
      const testRed = pairs
        .filter((p) => plan.tasks.find((t) => t.id === p.taskId)?.verificationStratum === "test-red")
        .map((p) => p.order);
      expect(new Set(testRed).size, `${name}: arm order is confounded with stratum`).toBe(2);
    }
    // A n B is refused by the assembler; the pair sets inherit that and are checked here too.
    const a = (cfg.abPairsA as Array<{ taskId: string }>).map((p) => p.taskId);
    const b = (cfg.abPairsB as Array<{ taskId: string }>).map((p) => p.taskId);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
  });
});
