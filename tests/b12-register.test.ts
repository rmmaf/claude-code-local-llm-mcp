/**
 * ORACLE FOR THE OPERATOR'S REGISTER — `scripts/b12-register.mjs`.
 *
 * `checkCore` is pure and every red reason fires and not-fires over generated
 * manifests; `casCommit` runs over deterministic scratch repositories and its
 * success is tied END-TO-END to the observe guard: a registration the CAS
 * installs must be one `registrationGuard` then accepts, because the same-act
 * proof holds BY CONSTRUCTION when manifests and row land in one commit.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRoot } from "./helpers.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = makeTempRoot("b12-register-test-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
  }
});

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Narrow a result to its success arm, loudly — never a cast at the call site. */
function okOf<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got refusal: ${String((r as { why?: string }).why)}`);
  return r as Extract<T, { ok: true }>;
}

/** Narrow a result to its refusal arm, loudly. */
function whyOf<T extends { ok: boolean }>(r: T): string {
  if (r.ok) throw new Error("expected a refusal; the call succeeded");
  return (r as unknown as { why: string }).why;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr ?? ""}`);
  return (r.stdout ?? "").trim();
}

function initRepo(root: string): void {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "register-oracle"]);
  git(root, ["config", "user.email", "register@example.invalid"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "commit.gpgsign", "false"]);
}

function commitAll(root: string, message: string): string {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

// ---------------------------------------------------------------------------
// A GREEN pair of manifests plus a pilot, generated — thirty tasks with every
// artifact-1 declaration, six counterbalanced pairs, five disjoint pilot ids.
// ---------------------------------------------------------------------------

function taskOf(id: string): Record<string, unknown> {
  const prompt = `Fix the failing check in ${id}.`;
  return {
    id,
    prompt,
    promptSha256: sha(prompt),
    baseCommit: "0".repeat(40),
    verificationStratum: "types-only",
    expectedSubagentStratum: "solo",
    acceptance: ['node -e "process.exit(0)"'],
    acceptanceExpectedExit: 0,
    verificationCommands: ["npx tsc --noEmit"],
    gateCategory: "types",
    repairMaxRounds: 3,
    fileScope: ["src/tools/"],
  };
}

function manifestOf(runId: string, prefix: string): Record<string, unknown> {
  const ids = Array.from({ length: 30 }, (_unused, i) => `${prefix}${i + 1}`);
  return {
    runId,
    pinned: {
      claudeCodeVersion: "2.1.221",
      claudeBinarySha256: "b".repeat(64),
      ratesSha256: "a".repeat(64),
      clientTruncationCap: 30_000,
      pacingCacheWriteShareCeiling: 0.9,
      perTaskDenominatorShareCap: 0.25,
      scoringCommand: `node dist/cost/b12/emit.js ${runId}`,
      b12RunSha256: "c".repeat(64),
      claudeMdSha256: "d".repeat(64),
      settingsSha256s: { settings: null, settingsLocal: null },
      installedCharsProbe: "evidence/probe.json",
      installedCharsProbeSha256: "e".repeat(64),
      perArmTimeoutMs: 2_700_000,
      extraArgs: [],
    },
    abPairs: ids.slice(0, 6).map((taskId, i) => ({
      id: `pair-${prefix}${i}`,
      taskId,
      order: i % 2 === 0 ? "treatment-first" : "control-first",
    })),
    tasks: ids.map(taskOf),
  };
}

const pilotOf = (): Record<string, unknown> => ({
  schema: "b12-pilot/1",
  runId: "run-r1",
  observations: Array.from({ length: 5 }, (_unused, i) => ({ taskId: `pilot-${i + 1}` })),
});

describe("checkCore — the pure red reasons, firing and not firing", () => {
  it("is GREEN on the generated pair with a disjoint five-task pilot", async () => {
    const { checkCore } = await import("../scripts/b12-register.mjs");
    const red = checkCore(manifestOf("run-r1", "a"), manifestOf("run-r2", "b"), pilotOf());
    expect(red).toEqual([]);
  });

  it("fires on every frozen cardinality and cross invariant, one mutation at a time", async () => {
    const { checkCore } = await import("../scripts/b12-register.mjs");
    const a = () => manifestOf("run-r1", "a") as { tasks: unknown[]; abPairs: unknown[]; runId: string; pinned: Record<string, unknown> };
    const b = manifestOf("run-r2", "b");

    const short = a();
    short.tasks = short.tasks.slice(0, 29);
    expect(checkCore(short, b, pilotOf()).join(" ")).toMatch(/29 task\(s\) against the frozen ordered 30/);

    const fivePairs = a();
    fivePairs.abPairs = fivePairs.abPairs.slice(0, 5);
    expect(checkCore(fivePairs, b, pilotOf()).join(" ")).toMatch(/5 A\/B pair\(s\) against the frozen 6/);

    expect(checkCore(a(), b, null).join(" ")).toMatch(/no pilot file/);

    const overlappingPilot = pilotOf() as { observations: Array<{ taskId: string }> };
    overlappingPilot.observations[0]!.taskId = "a1";
    expect(checkCore(a(), b, overlappingPilot).join(" ")).toMatch(/appear in manifest A/);

    expect(checkCore(a(), manifestOf("run-r1", "b"), pilotOf()).join(" ")).toMatch(/SAME runId/);

    const badPrompt = a();
    (badPrompt.tasks[0] as { promptSha256: string }).promptSha256 = "f".repeat(64);
    expect(checkCore(badPrompt, b, pilotOf()).join(" ")).toMatch(/promptSha256 does not match/);

    const badScope = a();
    (badScope.tasks[0] as { fileScope: string[] }).fileScope = ["src/"];
    expect(checkCore(badScope, b, pilotOf()).join(" ")).toMatch(/intersects the instrument set/);

    const noBudget = a();
    delete noBudget.pinned.perArmTimeoutMs;
    expect(checkCore(noBudget, b, pilotOf()).join(" ")).toMatch(/45-minute fallback never decides a run/);

    const noExtraArgs = a();
    delete noExtraArgs.pinned.extraArgs;
    expect(checkCore(noExtraArgs, b, pilotOf()).join(" ")).toMatch(/pins no extraArgs/);
  });
});

describe("casCommit — the act, atomic at the ref", () => {
  it("installs manifests and row in ONE commit that the observe guard then accepts", async () => {
    const { casCommit } = await import("../scripts/b12-register.mjs");
    const { registrationGuard } = await import("../scripts/b12-run.mjs");
    const root = tempRoot();
    initRepo(root);
    await fs.writeFile(path.join(root, "MEASUREMENTS.jsonl"), `{"metric":"prior"}\n`, "utf8");
    commitAll(root, "the pre-existing register");

    const aBytes = `{"runId":"run-cas","tasks":[{"id":"t1"}]}\n`;
    const bBytes = `{"runId":"run-cas-b","tasks":[{"id":"u1"}]}\n`;
    const old = git(root, ["show", "HEAD:MEASUREMENTS.jsonl"]);
    const row = `{"ts":"2026-08-09T00:00:00Z","b12_registration":true,"run_id":"run-cas"}\n`;
    const result = casCommit(root, {
      message: "b12 registration: run-cas",
      candidates: [
        { path: "evidence/run-cas.b12.tasks.json", bytes: aBytes },
        { path: "evidence/run-cas.b12.manifest-B.tasks.json", bytes: bBytes },
        { path: "MEASUREMENTS.jsonl", bytes: `${old}\n${row}`.replace(/\n\n/, "\n") },
      ],
    });
    expect(result.ok).toBe(true);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(okOf(result).commit);
    // ONE commit introduced manifest and row alike — so the guard's same-act
    // proof, the byte identity, and the prefix rule all hold BY CONSTRUCTION.
    expect(registrationGuard(root, "run-cas", aBytes)).toEqual([]);
    // And the sync left the working tree AT the new commit for the act's paths.
    expect(await fs.readFile(path.join(root, "evidence", "run-cas.b12.tasks.json"), "utf8")).toBe(aBytes);
  });

  it("REFUSES when the branch moved past expectedHead — nothing registered, head untouched", async () => {
    const { casCommit } = await import("../scripts/b12-register.mjs");
    const root = tempRoot();
    initRepo(root);
    await fs.writeFile(path.join(root, "MEASUREMENTS.jsonl"), `{"metric":"prior"}\n`, "utf8");
    const captured = commitAll(root, "the head the act was built against");
    await fs.writeFile(path.join(root, "unrelated.txt"), "someone else committed\n", "utf8");
    const moved = commitAll(root, "a concurrent commit");

    const result = casCommit(root, {
      expectedHeadOverride: captured,
      message: "b12 registration: run-toctou",
      candidates: [{ path: "evidence/run-toctou.b12.tasks.json", bytes: "{}\n" }],
    });
    expect(result.ok).toBe(false);
    expect(whyOf(result)).toMatch(/CAS failed/);
    expect(whyOf(result)).toMatch(/NOTHING was registered/);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(moved);
    const probe = spawnSync("git", ["-C", root, "cat-file", "-e", "HEAD:evidence/run-toctou.b12.tasks.json"], {
      encoding: "utf8",
    });
    expect(probe.status).not.toBe(0);
  });
});

describe("seal-harness — create-only, explicit budgets, committed bytes", () => {
  async function sealFixture(): Promise<{ root: string; manifestPath: string }> {
    const root = tempRoot();
    initRepo(root);
    await fs.mkdir(path.join(root, "scripts"), { recursive: true });
    await fs.mkdir(path.join(root, "evidence"), { recursive: true });
    await fs.writeFile(path.join(root, "scripts", "b12-run.mjs"), "export const HARNESS = 1;\n", "utf8");
    const manifestPath = path.join(root, "evidence", "run-s.b12.tasks.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ runId: "run-s", pinned: { perArmTimeoutMs: 2_700_000, extraArgs: [] }, tasks: [{ id: "t1" }] }) + "\n",
      "utf8"
    );
    commitAll(root, "harness + manifest");
    return { root, manifestPath };
  }

  it("seals HEAD's harness bytes once, and only once", async () => {
    const { sealHarness } = await import("../scripts/b12-register.mjs");
    const { root, manifestPath } = await sealFixture();
    const first = sealHarness(root, manifestPath);
    expect(first.ok).toBe(true);
    expect(okOf(first).seal.b12RunSha256).toBe(sha("export const HARNESS = 1;\n"));
    // CREATE-ONLY: the second invocation refuses while the file exists…
    expect(whyOf(sealHarness(root, manifestPath))).toMatch(/create-only/);
    // …and STILL refuses after a delete, because history remembers the birth.
    commitAll(root, "the seal");
    await fs.rm(path.join(root, "evidence", "b12-harness-seal.json"));
    expect(whyOf(sealHarness(root, manifestPath))).toMatch(/exists in history/);
  });

  it("refuses a manifest with no explicit budget declarations, and uncommitted harness bytes", async () => {
    const { sealHarness } = await import("../scripts/b12-register.mjs");
    const { root, manifestPath } = await sealFixture();
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ runId: "run-s", pinned: { extraArgs: [] }, tasks: [{ id: "t1" }] }) + "\n",
      "utf8"
    );
    expect(whyOf(sealHarness(root, manifestPath))).toMatch(/45-minute fallback/);
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ runId: "run-s", pinned: { perArmTimeoutMs: 1 }, tasks: [{ id: "t1" }] }) + "\n",
      "utf8"
    );
    expect(whyOf(sealHarness(root, manifestPath))).toMatch(/pins no extraArgs/);
    // Drift between disk and HEAD refuses — seal committed bytes only.
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ runId: "run-s", pinned: { perArmTimeoutMs: 1, extraArgs: [] }, tasks: [{ id: "t1" }] }) + "\n",
      "utf8"
    );
    await fs.appendFile(path.join(root, "scripts", "b12-run.mjs"), "// drifted\n", "utf8");
    expect(whyOf(sealHarness(root, manifestPath))).toMatch(/differs between disk and HEAD/);
  });
});

describe("freshBuild — the anti-stale-dist gate", () => {
  it("throws when the build command fails, naming the refusal", async () => {
    const { freshBuild } = await import("../scripts/b12-register.mjs");
    const root = tempRoot();
    expect(() => freshBuild(root, "definitely-not-a-command")).toThrow(/fresh build failed/);
  });
});
