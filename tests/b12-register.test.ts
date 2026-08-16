/**
 * ORACLE FOR THE OPERATOR'S REGISTER — `scripts/b12-register.mjs`.
 *
 * `checkCore` is pure and every red reason fires and not-fires over generated
 * manifests; `casCommit` runs over deterministic scratch repositories and its
 * success is tied END-TO-END to the observe guard: a registration the CAS
 * installs must be one `registrationGuard` then accepts, because the same-act
 * proof holds BY CONSTRUCTION when manifests and row land in one commit.
 *
 * EVERY GIT-COUPLED TEST HERE CARRIES AN EXPLICIT BUDGET, and the numbers are
 * measured rather than chosen. This file used to pass none, so all 29 ran under
 * vitest's 5 000 ms default while shelling out to git 25–40 times each — and it
 * was the only git-coupled oracle in the repository with no budgets at all.
 *
 * What was measured, over ten runs in three conditions (this file alone; with
 * `b12-author.test.ts`; with that and `b12-corpus-refs.test.ts`): alone it is
 * green every time, and three of the ten runs lost exactly one test. Every one
 * of those failures was `Test timed out in 5000ms` — never an assertion, never a
 * hook. The slowest any test ever ran was 6 771 ms, against typical maxima of
 * 1–4 s, so 30 000 is roughly 4.4x the worst observation and not a round number
 * picked to make a problem go away.
 *
 * WHAT THIS DOES NOT ESTABLISH, because a run says WHICH tests failed and never
 * WHY: that file-level parallelism is the mechanism, or that this is the suite
 * flake `PREMISES.md` records as mitigated-but-undiagnosed. The association is
 * n=1 in each direction and is not a diagnosis.
 *
 * FOUR TESTS KEEP THE 5 s DEFAULT ON PURPOSE — the three pure predicates over
 * literals, and the `freshBuild` one, which hands it a command that cannot spawn
 * so `npm run build` never runs (measured: 257 / 14 / 35 / 76 ms). A pure
 * predicate that hangs should still fail fast; giving it thirty seconds would
 * buy nothing and hide a real hang.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, promises as fs, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRoot, removeTempRoot } from "./helpers.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = makeTempRoot("b12-register-test-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    await removeTempRoot(root);
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

/** Narrow a `registerRun` result to its VALIDATION-red arm, loudly. */
function redOf<T extends { ok: boolean }>(r: T): string[] {
  if (r.ok) throw new Error("expected a red refusal; the call succeeded");
  const red = (r as unknown as { red?: string[] }).red;
  if (red === undefined) {
    throw new Error(`expected red[], got why: ${String((r as unknown as { why?: string }).why)}`);
  }
  return red;
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
      policyBlobs: {
        treatment: { repo: "../b12-policy", commit: "f".repeat(40), path: "treatment.md", sha256: "1".repeat(64) },
        control: { repo: "../b12-policy", commit: "f".repeat(40), path: "control.md", sha256: "2".repeat(64) },
      },
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

describe("runIdMismatch — one identity in three places", () => {
  it("fires only on DISAGREEMENT, and leaves absence to the gaps predicate", async () => {
    // R20. The CLI argument names the path and fills the row; `observe` looks
    // a run up by the manifest's OWN runId. Agreement is the whole rule.
    const { runIdMismatch } = await import("../scripts/b12-register.mjs");
    expect(runIdMismatch("run-r1", manifestOf("run-r1", "a"))).toBeNull();
    const disagreeing = runIdMismatch("run-r1", manifestOf("run-r9", "a"));
    expect(disagreeing).toMatch(/ONE identity/);
    expect(disagreeing).toMatch(/run-r9/);
    expect(disagreeing).toMatch(/run-r1/);
    // Absence is `manifestDeclarationGaps`' finding — saying it twice, in two
    // voices, is how a reader learns to skim reds.
    expect(runIdMismatch("run-r1", {})).toBeNull();
    expect(runIdMismatch("run-r1", { runId: "" })).toBeNull();
    expect(runIdMismatch("run-r1", null)).toBeNull();
  });
});

describe("openBRefusals — run 2 is a registration, and owes the act's preconditions", () => {
  it("refuses a colliding manifest path, an id already registered, and an unsafe segment", async () => {
    // R23#1: `open-b` derived `evidence/<run2Id>.b12.tasks.json` from the
    // sealed blob and handed it straight to the CAS — and `casCommit` stages
    // with `update-index --add`, which REPLACES the blob at an existing path.
    // A colliding id would overwrite another run's committed manifest and
    // append a SECOND registration row for that id.
    const { openBRefusals } = await import("../scripts/b12-register.mjs");
    const root = tempRoot();
    initRepo(root);
    await fs.mkdir(path.join(root, "evidence"), { recursive: true });
    await fs.writeFile(path.join(root, "evidence", "run-old.b12.tasks.json"), `{"runId":"run-old"}\n`, "utf8");
    await fs.writeFile(
      path.join(root, "MEASUREMENTS.jsonl"),
      `{"metric":"prior"}\n{"b12_registration":true,"run_id":"run-old"}\n`,
      "utf8"
    );
    const head = commitAll(root, "an earlier run, registered");

    const collision = openBRefusals(root, head, "run-old");
    expect(collision.join(" ")).toMatch(/was already introduced by/);
    expect(collision.join(" ")).toMatch(/already carries a registration row/);
    // The id is interpolated into a PATH here, so the grammar applies at the
    // point of use, not only at seal time.
    expect(openBRefusals(root, head, "../../escape").join(" ")).toMatch(/not a safe path segment/);
    expect(openBRefusals(root, head, 7).join(" ")).toMatch(/not a safe path segment/);
    // …and a genuinely fresh run 2 passes, so the guard is not a wall.
    expect(openBRefusals(root, head, "run-r2")).toEqual([]);
  }, 30_000);
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
  }, 30_000);

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
  }, 30_000);

  it("registers from a LINKED WORKTREE, where `.git` is a file, not a directory", async () => {
    const { casCommit } = await import("../scripts/b12-register.mjs");
    const root = tempRoot();
    initRepo(root);
    await fs.writeFile(path.join(root, "MEASUREMENTS.jsonl"), `{"metric":"prior"}\n`, "utf8");
    const mainHead = commitAll(root, "the pre-existing register");
    const wtParent = tempRoot();
    const wt = path.join(wtParent, "wt");
    git(root, ["worktree", "add", "-q", "-b", "register-side", wt]);
    // The premise of the failure mode, asserted: a temp index built under
    // `repoRoot/.git/...` would be a path under this FILE.
    expect((await fs.stat(path.join(wt, ".git"))).isFile()).toBe(true);

    const result = casCommit(wt, {
      message: "b12 registration: run-wt",
      candidates: [{ path: "evidence/run-wt.b12.tasks.json", bytes: `{"runId":"run-wt"}\n` }],
    });
    expect(result.ok).toBe(true);
    expect(git(wt, ["rev-parse", "HEAD"])).toBe(okOf(result).commit);
    expect(git(wt, ["show", "HEAD:evidence/run-wt.b12.tasks.json"])).toBe(`{"runId":"run-wt"}`);
    // The act landed on the worktree's OWN branch; the main checkout's did not move.
    expect(git(root, ["rev-parse", "HEAD"])).toBe(mainHead);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// registerRun — CAPTURE PRECEDES VALIDATION. The `afterCapture` seam sits in
// the exact window the discipline closes: between the check over the captured
// state and the CAS. A disk mutation there must register NOTHING it wasn't;
// a concurrent commit there must fail the swap.
// ---------------------------------------------------------------------------

describe("registerRun — the act validates the captured state, and only that", () => {
  const HARNESS = "export const HARNESS = 1;\n";

  async function registerFixture(opts: { commitPilot?: boolean; withSeal?: boolean } = {}): Promise<{
    root: string;
    aPath: string;
    aBytes: string;
    bBytes: string;
  }> {
    const { commitPilot = true, withSeal = true } = opts;
    const root = tempRoot();
    initRepo(root);
    await fs.mkdir(path.join(root, "scripts"), { recursive: true });
    await fs.mkdir(path.join(root, "evidence"), { recursive: true });
    await fs.writeFile(path.join(root, "MEASUREMENTS.jsonl"), `{"metric":"prior"}\n`, "utf8");
    await fs.writeFile(path.join(root, "scripts", "b12-run.mjs"), HARNESS, "utf8");
    if (commitPilot) {
      await fs.writeFile(path.join(root, "evidence", "run-r1.b12.pilot.json"), JSON.stringify(pilotOf()) + "\n", "utf8");
    }
    if (withSeal) {
      await fs.writeFile(
        path.join(root, "evidence", "b12-harness-seal.json"),
        JSON.stringify({
          schema: "b12-harness-seal/1",
          sealedAt: "2026-08-10T00:00:00Z",
          b12RunSha256: sha(HARNESS),
          perArmTimeoutMs: 2_700_000,
          extraArgs: [],
        }) + "\n",
        "utf8"
      );
    }
    commitAll(root, "register + pilot + seal + harness");
    if (!commitPilot) {
      // The pilot exists on DISK only — the anchored check must refuse it.
      await fs.writeFile(path.join(root, "evidence", "run-r1.b12.pilot.json"), JSON.stringify(pilotOf()) + "\n", "utf8");
    }
    const aBytes = JSON.stringify(manifestOf("run-r1", "a")) + "\n";
    const bBytes = JSON.stringify(manifestOf("run-r2", "b")) + "\n";
    const aPath = path.join(root, "evidence", "run-r1.b12.tasks.json");
    await fs.writeFile(aPath, aBytes, "utf8");
    await fs.writeFile(path.join(root, "evidence", "run-r1.b12.manifest-B.tasks.json"), bBytes, "utf8");
    return { root, aPath, aBytes, bBytes };
  }

  const greenGate = async (): Promise<string[]> => [];

  it("registers the green pair in one commit the observe guard then accepts", async () => {
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { registrationGuard } = await import("../scripts/b12-run.mjs");
    const { root, aBytes, bBytes } = await registerFixture();
    const result = await registerRun(root, "run-r1", { gate: greenGate });
    expect(result.ok).toBe(true);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(okOf(result).commit);
    expect(git(root, ["show", "HEAD:evidence/run-r1.b12.tasks.json"])).toBe(aBytes.trimEnd());
    expect(git(root, ["show", "HEAD:evidence/run-r1.b12.manifest-B.tasks.json"])).toBe(bBytes.trimEnd());
    expect(registrationGuard(root, "run-r1", aBytes)).toEqual([]);
  }, 30_000);

  it("REFUSES a manifest whose OWN runId is not the one being registered — and moves nothing", async () => {
    // R20: the act writes `evidence/<runId>.b12.tasks.json` and a row saying
    // `run_id: <runId>`, both from the CLI argument, while `observe` derives
    // its canonical path and its registration lookup from the manifest's
    // INTERNAL id. A typo would commit a row no session can use and no result
    // can close — and the prior-runs gate then refuses every later
    // registration as abandoned, forever, since the register is append-only.
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { root, aPath } = await registerFixture();
    await fs.writeFile(aPath, JSON.stringify(manifestOf("run-r9", "a")) + "\n", "utf8");
    const headBefore = git(root, ["rev-parse", "HEAD"]);
    const measBefore = await fs.readFile(path.join(root, "MEASUREMENTS.jsonl"), "utf8");
    const result = await registerRun(root, "run-r1", { gate: greenGate });
    expect(result.ok).toBe(false);
    // ONE red, and it is this one — the fixture is otherwise green.
    expect(redOf(result)).toHaveLength(1);
    expect(redOf(result)[0]).toMatch(/ONE identity/);
    // HEAD, the register and the working tree are exactly as they were.
    expect(git(root, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await fs.readFile(path.join(root, "MEASUREMENTS.jsonl"), "utf8")).toBe(measBefore);
    expect(git(root, ["show", "HEAD:MEASUREMENTS.jsonl"])).not.toMatch(/b12_registration/);
    expect(git(root, ["status", "--porcelain", "--", "MEASUREMENTS.jsonl"])).toBe("");
    expect(existsSync(path.join(root, "evidence", "run-r9.b12.tasks.json"))).toBe(false);
  }, 30_000);

  it("REFUSES a manifest already introduced by an earlier commit — the same act is no longer possible", async () => {
    // R22#1: voidConditions 1 seals the manifest and its row in ONE commit,
    // and `registrationGuard` proves it by comparing the two INTRODUCING
    // commits. A manifest already in history can never satisfy that — so an
    // act that proceeded would append the irreversible row to a run every
    // observation refuses, and the prior-runs gate would then block the next
    // registration over the abandoned one. Asked before anything is built.
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { root } = await registerFixture();
    git(root, ["add", "evidence/run-r1.b12.tasks.json"]);
    git(root, ["commit", "-q", "-m", "the manifest, committed by hand first"]);
    const headBefore = git(root, ["rev-parse", "HEAD"]);
    const result = await registerRun(root, "run-r1", { gate: greenGate });
    expect(result.ok).toBe(false);
    expect(redOf(result).join(" ")).toMatch(/was already introduced by/);
    expect(redOf(result).join(" ")).toMatch(/run-r1\.b12\.tasks\.json/);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(root, ["show", "HEAD:MEASUREMENTS.jsonl"])).not.toMatch(/b12_registration/);

    // AND THE SNEAKY SHAPE: committed, deleted, recreated on disk. The path
    // looks unborn to anyone who only asks `git cat-file -e HEAD:<path>`.
    await fs.rm(path.join(root, "evidence", "run-r1.b12.tasks.json"));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "and deleted again"]);
    await fs.writeFile(
      path.join(root, "evidence", "run-r1.b12.tasks.json"),
      JSON.stringify(manifestOf("run-r1", "a")) + "\n",
      "utf8"
    );
    const reborn = await registerRun(root, "run-r1", { gate: greenGate });
    expect(reborn.ok).toBe(false);
    expect(redOf(reborn).join(" ")).toMatch(/was already introduced by/);
  }, 30_000);

  it("registers the CAPTURED bytes — a disk mutation between validation and the act changes NOTHING", async () => {
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { root, aPath, aBytes } = await registerFixture();
    const result = await registerRun(root, "run-r1", {
      gate: greenGate,
      afterCapture: async () => {
        await fs.writeFile(aPath, "NOT JSON — mutated in the window the capture closes\n", "utf8");
      },
    });
    expect(result.ok).toBe(true);
    // The committed blob is the VALIDATED buffer, not the disk's garbage.
    expect(git(root, ["show", "HEAD:evidence/run-r1.b12.tasks.json"])).toBe(aBytes.trimEnd());
    // And the sync did NOT overwrite the drifted disk copy — the mutation is
    // preserved for reconciliation and reported, never destroyed.
    expect(await fs.readFile(aPath, "utf8")).toMatch(/NOT JSON/);
    expect(okOf(result).postFailure).toMatch(/NOT synced/);
  }, 30_000);

  it("survives the operator's NEXT ordinary commit — the index follows the branch it indexes", async () => {
    // R16, reproduced before it was believed: the act builds its tree in a
    // temporary index and moves the branch, leaving the REAL index on
    // expectedHead. Against the new HEAD that reads as staged deletions of
    // the manifests and a staged reversion of the register — so
    // `git add <result>; git commit` carried them and UNDID the registration.
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { root, aBytes } = await registerFixture();
    const result = await registerRun(root, "run-r1", { gate: greenGate });
    expect(result.ok).toBe(true);
    // Nothing staged against the new HEAD, and nothing dirty either.
    expect(git(root, ["status", "--porcelain"])).toBe("");

    // The operator's next act: an unrelated artifact, added and committed.
    await fs.writeFile(path.join(root, "evidence", "run-r1.b12.result.json"), `{"verdict":"void"}\n`, "utf8");
    git(root, ["add", "evidence/run-r1.b12.result.json"]);
    git(root, ["commit", "-q", "-m", "the result"]);

    // THE REGISTRATION SURVIVES IT.
    expect(git(root, ["show", "HEAD:evidence/run-r1.b12.tasks.json"])).toBe(aBytes.trimEnd());
    expect(git(root, ["show", "HEAD:evidence/run-r1.b12.manifest-B.tasks.json"])).not.toBe("");
    expect(git(root, ["show", "HEAD:MEASUREMENTS.jsonl"])).toMatch(/b12_registration/);
  }, 30_000);

  it("writes NO index while another git process holds the lock — and says how to repair it", async () => {
    // R17: R16's check-then-read-tree was a TOCTOU. The index is now
    // installed under git's OWN mutex, `.git/index.lock`, taken with O_EXCL —
    // so a held lock means no write at all, not a racing one.
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { root } = await registerFixture();
    const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
    const lockPath = path.join(gitDir, "index.lock");
    const indexBefore = await fs.readFile(path.join(gitDir, "index"));
    await fs.writeFile(lockPath, "another git process\n", "utf8");
    try {
      const result = await registerRun(root, "run-r1", { gate: greenGate });
      expect(result.ok).toBe(true);
      expect(okOf(result).postFailure).toMatch(/index\.lock/);
      expect(okOf(result).postFailure).toMatch(/git reset --mixed/);
      // The index is byte-identical, and the foreign lock is still theirs.
      expect(await fs.readFile(path.join(gitDir, "index"))).toEqual(indexBefore);
      expect(await fs.readFile(lockPath, "utf8")).toBe("another git process\n");
      // R19: the FILES are not written either. Whoever holds this lock may be
      // a `git checkout` moving this working tree, and the sync now lives
      // inside the lock precisely so it cannot land in someone else's branch.
      expect(await fs.readFile(path.join(root, "MEASUREMENTS.jsonl"), "utf8")).not.toMatch(/b12_registration/);
      expect(git(root, ["show", "HEAD:MEASUREMENTS.jsonl"])).toMatch(/b12_registration/);
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  }, 30_000);

  it("syncs NOTHING when the branch is moved by a command the index lock cannot exclude", async () => {
    // R19. `.git/index.lock` blocks everything that would move the branch AND
    // touch this working tree — commit, checkout, merge, reset --mixed/--hard.
    // It does NOT block `git update-ref`, which writes a ref and nothing else.
    // Checking the symbolic ref's NAME under the lock said nothing about where
    // it pointed, so the act would install an index describing a commit the
    // branch no longer carried. The target is now read too.
    const { casCommit } = await import("../scripts/b12-register.mjs");
    const root = tempRoot();
    initRepo(root);
    const measPath = path.join(root, "MEASUREMENTS.jsonl");
    const old = `{"metric":"prior"}\n`;
    await fs.writeFile(measPath, old, "utf8");
    commitAll(root, "the pre-existing register");
    const ref = git(root, ["symbolic-ref", "--quiet", "HEAD"]);
    const before = git(root, ["rev-parse", "HEAD"]);
    const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
    const indexBefore = await fs.readFile(path.join(gitDir, "index"));
    const result = casCommit(root, {
      message: "b12 registration: run-u",
      candidates: [{ path: "MEASUREMENTS.jsonl", bytes: old + `{"b12_registration":true}\n`, diskBefore: old }],
      // The concurrent plumbing command, in its own window: the branch keeps
      // its NAME and loses the registration.
      afterSwap: () => {
        git(root, ["update-ref", ref, before]);
      },
    });
    // The registration EXISTS — the commit was made and the swap succeeded.
    expect(result.ok).toBe(true);
    expect(git(root, ["cat-file", "-t", okOf(result).commit])).toBe("commit");
    expect(okOf(result).postFailure).toMatch(/no longer carries the registration/);
    // …and nothing was written into a working tree that is no longer its own.
    expect(await fs.readFile(measPath, "utf8")).toBe(old);
    expect(await fs.readFile(path.join(gitDir, "index"))).toEqual(indexBefore);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(before);
  }, 30_000);

  it("leaves a STAGED index alone and says the registration would be reverted", async () => {
    // The other half: an index carrying someone's staged work may not be
    // retargeted — that would destroy bytes the act never validated (R15).
    // So it is left, and the hazard is named instead of hidden.
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { root } = await registerFixture();
    await fs.writeFile(path.join(root, "scratch.txt"), "someone's staged work\n", "utf8");
    git(root, ["add", "scratch.txt"]);
    const stagedBlob = git(root, ["rev-parse", ":scratch.txt"]);
    const result = await registerRun(root, "run-r1", { gate: greenGate });
    expect(result.ok).toBe(true);
    expect(okOf(result).postFailure).toMatch(/would REVERT this registration/);
    // The staged work is untouched.
    expect(git(root, ["rev-parse", ":scratch.txt"])).toBe(stagedBlob);
  }, 30_000);

  it("never touches the INDEX — the sync is an append, so staged work is not its business", async () => {
    // R10 conditioned the sync on disk bytes; R14 added the index; R15 found
    // the residual TOCTOU and the operation changed instead of the checking.
    // `git checkout` is gone: nothing here can overwrite, so bytes someone
    // staged mid-act simply survive, with no precondition to get right.
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { root, aPath, aBytes } = await registerFixture();
    let stagedBlob = "";
    const result = await registerRun(root, "run-r1", {
      gate: greenGate,
      afterCapture: async () => {
        await fs.writeFile(aPath, `{"staged":"someone else's work"}\n`, "utf8");
        git(root, ["add", "evidence/run-r1.b12.tasks.json"]);
        stagedBlob = git(root, ["rev-parse", ":evidence/run-r1.b12.tasks.json"]);
        // …and the disk is put back, so a disk-only test would have synced.
        await fs.writeFile(aPath, aBytes, "utf8");
      },
    });
    expect(result.ok).toBe(true);
    expect(git(root, ["show", "HEAD:evidence/run-r1.b12.tasks.json"])).toBe(aBytes.trimEnd());
    // The staged blob is STILL the index's — the act never wrote there.
    expect(git(root, ["rev-parse", ":evidence/run-r1.b12.tasks.json"])).toBe(stagedBlob);
  }, 30_000);

  it("syncs the register by APPENDING — a concurrent append is joined, never overwritten", async () => {
    // The one candidate that needs syncing is the append-only register, and
    // the sync writes it with O_APPEND: the concurrent line stays, ours goes
    // after it, and nobody's bytes are lost. Compare R10, where a `checkout`
    // erased the concurrent append and merely reported it.
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { root } = await registerFixture();
    const measPath = path.join(root, "MEASUREMENTS.jsonl");
    const result = await registerRun(root, "run-r1", {
      gate: greenGate,
      afterCapture: async () => {
        await fs.appendFile(measPath, `{"metric":"concurrent-append"}\n`, "utf8");
      },
    });
    expect(result.ok).toBe(true);
    expect(git(root, ["show", "HEAD:MEASUREMENTS.jsonl"])).toMatch(/b12_registration/);
    const onDisk = await fs.readFile(measPath, "utf8");
    // BOTH survive — the concurrent line was never at risk.
    expect(onDisk).toMatch(/concurrent-append/);
    // The drifted register is reported rather than rewritten.
    expect(okOf(result).postFailure).toMatch(/MEASUREMENTS\.jsonl/);
    expect(onDisk.endsWith(`{"metric":"concurrent-append"}\n`)).toBe(true);
  }, 30_000);

  it("RE-READS after the append — a write that lands inside the read→write window is reported, not called clean", async () => {
    // R18#1. The append itself cannot overwrite, but the check that licenses
    // it ("the disk still holds what I captured") and the write are two
    // operations. A writer that lands between them puts its bytes FIRST, so
    // the file becomes old + theirs + ours while the commit carries
    // old + ours: nothing is lost, and yet the working copy no longer
    // preserves the COMMITTED register as a prefix — which is exactly what
    // every later `observe` refuses. Only a re-read can see it.
    const { casCommit } = await import("../scripts/b12-register.mjs");
    const root = tempRoot();
    initRepo(root);
    const measPath = path.join(root, "MEASUREMENTS.jsonl");
    const old = `{"metric":"prior"}\n`;
    await fs.writeFile(measPath, old, "utf8");
    commitAll(root, "the pre-existing register");
    const row = `{"b12_registration":true,"run_id":"run-w"}\n`;
    const foreign = `{"metric":"landed-mid-window"}\n`;
    const result = casCommit(root, {
      message: "b12 registration: run-w",
      candidates: [{ path: "MEASUREMENTS.jsonl", bytes: old + row, diskBefore: old }],
      // The seam fires AFTER the entry's disk copy is read and BEFORE the
      // append — the window the old code had no way to observe.
      onSyncEntry: (entry) => {
        if (entry.path === "MEASUREMENTS.jsonl") appendFileSync(measPath, foreign, "utf8");
      },
    });
    expect(result.ok).toBe(true);
    // The registration is exact: HEAD carries the captured bytes, not the interleave.
    expect(git(root, ["show", "HEAD:MEASUREMENTS.jsonl"])).toBe((old + row).trimEnd());
    const onDisk = await fs.readFile(measPath, "utf8");
    // NO BYTES WERE LOST — both lines are there, ours last.
    expect(onDisk).toBe(old + foreign + row);
    // But the committed bytes are no longer a PREFIX of the disk copy…
    expect(onDisk.startsWith(old + row)).toBe(false);
    // …and that is reported, with the repair named and nothing rewritten.
    expect(okOf(result).postFailure).toMatch(/PREFIX/);
    expect(okOf(result).postFailure).toMatch(/MEASUREMENTS\.jsonl/);
    expect(okOf(result).postFailure).toMatch(/BY HAND/);
  }, 30_000);

  it("syncs NOTHING when HEAD switched branches after the swap — another checkout is not this act's to write", async () => {
    const { casCommit } = await import("../scripts/b12-register.mjs");
    const root = tempRoot();
    initRepo(root);
    await fs.writeFile(path.join(root, "MEASUREMENTS.jsonl"), `{"metric":"prior"}\n`, "utf8");
    commitAll(root, "the pre-existing register");
    const captured = git(root, ["symbolic-ref", "--quiet", "HEAD"]);
    // A sibling branch on the SAME commit, checked out — the ref the act
    // captured is no longer the one this working tree belongs to.
    git(root, ["checkout", "-q", "-b", "elsewhere"]);
    const result = casCommit(root, {
      refOverride: captured,
      message: "b12 registration: run-sync",
      candidates: [{ path: "evidence/run-sync.b12.tasks.json", bytes: `{"runId":"run-sync"}\n` }],
    });
    // The ref guard fires BEFORE the swap here — nothing registered, nothing synced.
    expect(result.ok).toBe(false);
    expect(whyOf(result)).toMatch(/HEAD moved from/);
    expect(existsSync(path.join(root, "evidence", "run-sync.b12.tasks.json"))).toBe(false);
  }, 30_000);

  it("refuses UNCOMMITTED measurements rows at capture — the register is committed before the act", async () => {
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { root } = await registerFixture();
    await fs.appendFile(path.join(root, "MEASUREMENTS.jsonl"), `{"metric":"uncommitted-suffix"}\n`, "utf8");
    const result = await registerRun(root, "run-r1", { gate: greenGate });
    expect(redOf(result).join(" ")).toMatch(/on disk differs from expectedHead/);
  }, 30_000);

  it("REFUSES when a commit lands between validation and the act — the CAS fails, nothing registered", async () => {
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { root } = await registerFixture();
    let concurrent = "";
    const result = await registerRun(root, "run-r1", {
      gate: greenGate,
      afterCapture: async () => {
        // A SURGICAL concurrent commit — `add -A` would sweep the candidate
        // manifests off the disk into the concurrent commit and blur the probe.
        await fs.writeFile(path.join(root, "unrelated.txt"), "someone else committed\n", "utf8");
        git(root, ["add", "unrelated.txt"]);
        git(root, ["commit", "-q", "-m", "a concurrent commit — its prior-run state was never checked"]);
        concurrent = git(root, ["rev-parse", "HEAD"]);
      },
    });
    expect(result.ok).toBe(false);
    expect(whyOf(result)).toMatch(/CAS failed/);
    // HEAD is exactly the concurrent commit; the act installed nothing.
    expect(git(root, ["rev-parse", "HEAD"])).toBe(concurrent);
    const probe = spawnSync("git", ["-C", root, "cat-file", "-e", "HEAD:evidence/run-r1.b12.tasks.json"], {
      encoding: "utf8",
    });
    expect(probe.status).not.toBe(0);
    expect(git(root, ["show", "HEAD:MEASUREMENTS.jsonl"])).not.toMatch(/b12_registration/);
  }, 30_000);

  it("refuses a pilot that exists on disk but was never committed — old inputs come from the captured head", async () => {
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { root } = await registerFixture({ commitPilot: false });
    const result = await registerRun(root, "run-r1", { gate: greenGate });
    expect(redOf(result).join(" ")).toMatch(/on disk but not at expectedHead/);
  }, 30_000);

  it("refuses with no seal at expectedHead — seal-harness is the barrier", async () => {
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { root } = await registerFixture({ withSeal: false });
    const result = await registerRun(root, "run-r1", { gate: greenGate });
    expect(redOf(result).join(" ")).toMatch(/seal-harness is the barrier/);
  }, 30_000);

  it("REFUSES when HEAD switches to a DIFFERENT branch on the same commit — the swap lands only where it was validated", async () => {
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { root } = await registerFixture();
    const originalBranch = git(root, ["symbolic-ref", "--short", "HEAD"]);
    const result = await registerRun(root, "run-r1", {
      gate: greenGate,
      afterCapture: async () => {
        // The SAME commit under a different name — the SHA-guarded swap alone
        // would succeed and install on the wrong branch.
        git(root, ["checkout", "-q", "-b", "impostor-branch"]);
      },
    });
    expect(result.ok).toBe(false);
    expect(whyOf(result)).toMatch(/moved from .* during the act/);
    // Neither branch received the registration.
    for (const branch of [originalBranch, "impostor-branch"]) {
      const probe = spawnSync(
        "git",
        ["-C", root, "cat-file", "-e", `${branch}:evidence/run-r1.b12.tasks.json`],
        { encoding: "utf8" }
      );
      expect(probe.status).not.toBe(0);
    }
  }, 30_000);

  it("refuses DIRTY validator inputs — the gate may not judge with code the act does not register", async () => {
    const { registerRun } = await import("../scripts/b12-register.mjs");
    const { root } = await registerFixture();
    await fs.appendFile(path.join(root, "scripts", "b12-run.mjs"), "// drifted validator\n", "utf8");
    const result = await registerRun(root, "run-r1", { gate: greenGate });
    expect(redOf(result).join(" ")).toMatch(/validator input\(s\) dirty against expectedHead/);
    // Nothing registered.
    const probe = spawnSync("git", ["-C", root, "cat-file", "-e", "HEAD:evidence/run-r1.b12.tasks.json"], {
      encoding: "utf8",
    });
    expect(probe.status).not.toBe(0);
  }, 30_000);
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
  }, 30_000);

  it("never OVERWRITES a seal that appeared while this one was being built", async () => {
    // R21#2: the existence check and the write sat either side of a git call,
    // a parse and four validations. Two invocations crossing that gap both
    // saw an absent path and both reported success — the later one silently
    // replacing a seal an operator believed was frozen, and with it the
    // timeout and extraArgs the registration would be checked against.
    // Create-only is now the WRITE's own property: `wx` is O_EXCL.
    const { sealHarness } = await import("../scripts/b12-register.mjs");
    const { root, manifestPath } = await sealFixture();
    const sealAbs = path.join(root, "evidence", "b12-harness-seal.json");
    const theirs = `{"schema":"b12-harness-seal/1","sealedAt":"2026-08-10T00:00:00Z","b12RunSha256":"the other invocation's"}\n`;
    const result = sealHarness(root, manifestPath, {
      // The other invocation, landing in the window this one used to own.
      onBeforeWrite: () => {
        writeFileSync(sealAbs, theirs, "utf8");
      },
    });
    expect(result.ok).toBe(false);
    expect(whyOf(result)).toMatch(/appeared while this seal was being built/);
    expect(whyOf(result)).toMatch(/create-only/);
    // The winner's bytes are exactly as the winner left them.
    expect(await fs.readFile(sealAbs, "utf8")).toBe(theirs);
  }, 30_000);

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
  }, 30_000);
});

describe("freshBuild — the anti-stale-dist gate", () => {
  it("throws when the build command fails, naming the refusal", async () => {
    const { freshBuild } = await import("../scripts/b12-register.mjs");
    const root = tempRoot();
    expect(() => freshBuild(root, "definitely-not-a-command")).toThrow(/fresh build failed/);
  });
});
