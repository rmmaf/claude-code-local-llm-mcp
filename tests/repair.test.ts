import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProcessResult, ProcessRunner } from "../src/exec.js";
import type { ToolError } from "../src/fs-safety.js";
import { readTelemetry } from "../src/telemetry.js";
import { runRepair } from "../src/tools/repair.js";
import { chatBody, fileBlock, makeTempRoot, noLmsRunner, queuedFetch, testConfig, writeFileTree } from "./helpers.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = makeTempRoot("repair-test-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
  }
});

const BROKEN = "export function add(a: number, b: number): number {\n  return a - b;\n}\n";
const FIXED = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const WORSE = "export function add(a: number, b: number) {\n  return nope;\n}\n";

/** tsc-shaped output with N distinct errors. */
function tscErrors(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `src/math.ts(${i + 2},10): error TS2345: wrong operand ${i}.`
  ).join("\n");
}

/** A ProcessRunner that walks a queue, so each gate run can differ. */
function sequencedProcess(results: Array<Partial<ProcessResult>>): ProcessRunner {
  const queue = [...results];
  return async () => {
    const next = queue.shift() ?? { stdout: "", code: 0 };
    return {
      stdout: next.stdout ?? "",
      stderr: next.stderr ?? "",
      code: next.code ?? 0,
      timedOut: next.timedOut ?? false,
    };
  };
}

async function setup(root: string): Promise<void> {
  await writeFileTree(root, {
    "src/math.ts": BROKEN,
    ".local-coder/checks.json": JSON.stringify({
      checks: [{ name: "tsc", category: "types", kind: "tsc", command: "npx", args: ["tsc", "--noEmit"] }],
    }),
  });
}

const baseArgs = { files: ["src/math.ts"], spec: "add() must return the sum, not the difference" };

describe("repair loop", () => {
  it("does nothing when the checks are already green", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl, calls } = queuedFetch([]);

    const result = await runRepair(baseArgs, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: "", code: 0 }]),
      fetchImpl,
      runner: noLmsRunner(),
    });

    expect(result.passed).toBe(true);
    expect(result.rounds_used).toBe(0);
    expect(result.stopped_because).toBe("passed");
    expect(calls).toHaveLength(0); // the local model was never asked
    expect(await fs.readFile(path.join(root, "src/math.ts"), "utf8")).toBe(BROKEN);
  });

  it("fixes in one round, applies the change, and returns one cumulative diff", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);

    const result = await runRepair(baseArgs, testConfig(root), {
      // gate: red, then green
      processRunner: sequencedProcess([{ stdout: tscErrors(1), code: 2 }, { stdout: "", code: 0 }]),
      fetchImpl,
      runner: noLmsRunner(),
    });

    expect(result.passed).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.rounds_used).toBe(1);
    expect(result.files_changed).toEqual(["src/math.ts"]);
    expect(result.diff).toContain("-  return a - b;");
    expect(result.diff).toContain("+  return a + b;");
    expect(await fs.readFile(path.join(root, "src/math.ts"), "utf8")).toBe(FIXED);
  });

  it("restores the original bytes when it cannot reach green", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([
      chatBody(fileBlock("src/math.ts", WORSE)),
      chatBody(fileBlock("src/math.ts", WORSE)),
    ]);

    const result = await runRepair({ ...baseArgs, max_rounds: 2 }, testConfig(root), {
      processRunner: sequencedProcess([
        { stdout: tscErrors(3), code: 2 },
        { stdout: tscErrors(3), code: 2 },
        { stdout: tscErrors(3), code: 2 },
      ]),
      fetchImpl,
      runner: noLmsRunner(),
    });

    expect(result.passed).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.stopped_because).toBe("max_rounds");
    expect(result.remaining_failures.length).toBeGreaterThan(0);
    // The invariant that makes writing to the real tree safe.
    expect(await fs.readFile(path.join(root, "src/math.ts"), "utf8")).toBe(BROKEN);
  });

  it("keeps the best attempt when a later round makes things worse", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([
      chatBody(fileBlock("src/math.ts", FIXED)), // round 1: 3 failures -> 1
      chatBody(fileBlock("src/math.ts", WORSE)), // round 2: 1 -> 5
    ]);

    const result = await runRepair({ ...baseArgs, max_rounds: 2 }, testConfig(root), {
      processRunner: sequencedProcess([
        { stdout: tscErrors(3), code: 2 },
        { stdout: tscErrors(1), code: 2 },
        { stdout: tscErrors(5), code: 2 },
      ]),
      fetchImpl,
      runner: noLmsRunner(),
    });

    expect(result.passed).toBe(false);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]).toMatchObject({ failures_before: 3, failures_after: 1 });
    expect(result.rounds[1]).toMatchObject({ failures_before: 1, failures_after: 5 });
    // The returned diff is round 1's improvement, not round 2's regression.
    expect(result.diff).toContain("+  return a + b;");
    expect(result.diff).not.toContain("return nope;");
    // ...and disk is still pristine, because it never reached green.
    expect(await fs.readFile(path.join(root, "src/math.ts"), "utf8")).toBe(BROKEN);
  });

  it("stops and restores when the local model fails outright", async () => {
    const root = tempRoot();
    await setup(root);
    // A response with no <file> blocks fails both the attempt and the retry.
    const { fetchImpl } = queuedFetch([chatBody("I cannot help with that."), chatBody("Still no.")]);

    const result = await runRepair(baseArgs, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: tscErrors(2), code: 2 }]),
      fetchImpl,
      runner: noLmsRunner(),
    });

    expect(result.stopped_because).toBe("model_failed");
    expect(result.applied).toBe(false);
    expect(result.rounds[0]?.error).toBeTruthy();
    expect(await fs.readFile(path.join(root, "src/math.ts"), "utf8")).toBe(BROKEN);
  });

  it("honours the wall-clock budget", async () => {
    const root = tempRoot();
    await setup(root);
    // Plenty of rounds available, so only the budget can stop the loop.
    const { fetchImpl } = queuedFetch(
      Array.from({ length: 5 }, () => chatBody(fileBlock("src/math.ts", WORSE)))
    );

    // A clock that only ever moves forward, so elapsed time grows as the loop
    // works. How many ticks a round costs is an implementation detail — the
    // contract is that the budget stops it early, not exactly when.
    let clock = 0;
    const result = await runRepair({ ...baseArgs, max_rounds: 5, budget_seconds: 8 }, testConfig(root), {
      processRunner: sequencedProcess(Array.from({ length: 6 }, () => ({ stdout: tscErrors(2), code: 2 }))),
      fetchImpl,
      runner: noLmsRunner(),
      now: () => (clock += 1000),
    });

    expect(result.stopped_because).toBe("budget");
    expect(result.rounds_used).toBeLessThan(5);
    // ...and the tree is still restored on the budget path, like every other
    // path that does not reach green.
    expect(await fs.readFile(path.join(root, "src/math.ts"), "utf8")).toBe(BROKEN);
  });

  it("records one telemetry row per repair, counting the rounds as collapsed turns", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([
      chatBody(fileBlock("src/math.ts", WORSE)),
      chatBody(fileBlock("src/math.ts", FIXED)),
    ]);

    await runRepair({ ...baseArgs, max_rounds: 2 }, testConfig(root), {
      processRunner: sequencedProcess([
        { stdout: tscErrors(4), code: 2 },
        { stdout: tscErrors(2), code: 2 },
        { stdout: "", code: 0 },
      ]),
      fetchImpl,
      runner: noLmsRunner(),
    });

    const entries = await readTelemetry(root);
    // The inner gate runs must NOT each add a row — that would double-count.
    expect(entries.filter((e) => e.tool === "gate")).toHaveLength(0);
    expect(entries.filter((e) => e.tool === "repair")).toHaveLength(1);
    expect(entries[0]?.turns_collapsed).toBe(2);
    expect(entries[0]?.bytes_raw).toBeGreaterThan(0);
  });

  it("writes the per-round timings to telemetry, not just the call total", async () => {
    // B7 is the median of model_latency_ms + gate_ms per ROUND. The row used to
    // carry only the call total and the round count, so the log could not
    // answer it on any run — dividing one by the other bills the first gate and
    // the rollback to the rounds. See run 2026-08-03-mac-06.
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([
      chatBody(fileBlock("src/math.ts", WORSE)),
      chatBody(fileBlock("src/math.ts", FIXED)),
    ]);

    await runRepair({ ...baseArgs, max_rounds: 2 }, testConfig(root), {
      processRunner: sequencedProcess([
        { stdout: tscErrors(4), code: 2 },
        { stdout: tscErrors(2), code: 2 },
        { stdout: "", code: 0 },
      ]),
      fetchImpl,
      runner: noLmsRunner(),
    });

    const detail = (await readTelemetry(root))[0]?.detail as {
      rounds?: Array<Record<string, unknown>>;
    };
    expect(detail.rounds).toHaveLength(2);
    expect(detail.rounds?.[0]).toMatchObject({ round: 1, failures_before: 4, failures_after: 2 });
    expect(detail.rounds?.[1]).toMatchObject({ round: 2, failures_before: 2, failures_after: 0 });
    expect(typeof detail.rounds?.[0]?.model_ms).toBe("number");
    expect(typeof detail.rounds?.[0]?.gate_ms).toBe("number");
    // No error on a round that produced usable output — the field is what tells
    // a truncated response (B0) apart from a round that simply did not fix it.
    expect(detail.rounds?.[0]).not.toHaveProperty("error");
  });

  it("calls a generation the deadline cut off `budget`, not the model's fault", async () => {
    const root = tempRoot();
    await setup(root);
    // A request that never comes back, honouring the abort signal exactly as
    // fetch does — so the timeout is raised where the real one is, by the
    // controller in llm-client, and not simulated by a thrown string.
    // config.timeoutMs defaults to exactly DEFAULT_BUDGET_SECONDS, so this is
    // the ordinary case rather than a corner: 3 of 4 `model_failed` rows in run
    // 2026-08-03-mac-06 sat at 300-326 s against a 300 s budget.
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("The operation was aborted."));
        });
      })) as unknown as Parameters<typeof runRepair>[2]["fetchImpl"];

    const result = await runRepair({ ...baseArgs, budget_seconds: 1, max_rounds: 1 }, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: tscErrors(2), code: 2 }]),
      fetchImpl,
      runner: noLmsRunner(),
    });

    expect(result.stopped_because).toBe("budget");
    // ...and the reason survives the relabelling, which is the only thing that
    // makes relabelling safe.
    expect(result.rounds[0]?.error).toMatch(/timed out/i);
    expect(await fs.readFile(path.join(root, "src/math.ts"), "utf8")).toBe(BROKEN);
  });

  it("feeds the gate's structured failures to the model, not raw build output", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl, calls } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);

    await runRepair(baseArgs, testConfig(root), {
      processRunner: sequencedProcess([
        { stdout: `${"noise line\n".repeat(500)}${tscErrors(1)}`, code: 2 },
        { stdout: "", code: 0 },
      ]),
      fetchImpl,
      runner: noLmsRunner(),
    });

    const body = calls[0]?.body as { messages: Array<{ role: string; content: string }> };
    const user = body.messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("src/math.ts:2 [TS2345]");
    expect(user).not.toContain("noise line");
  });

  it("leaves a file edited outside the loop alone and names it in restore_conflicts", async () => {
    const root = tempRoot();
    await setup(root);
    const target = path.join(root, "src/math.ts");
    const OUTSIDE = "// an editor, a formatter, or the user got here first\n";
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", WORSE))]);

    let gateRuns = 0;
    const processRunner: ProcessRunner = async () => {
      gateRuns++;
      // Round 1's gate has just run; something else writes the file before the
      // loop gives up and tries to roll back.
      if (gateRuns === 2) await fs.writeFile(target, OUTSIDE, "utf8");
      return { stdout: tscErrors(2), stderr: "", code: 2, timedOut: false };
    };

    const result = await runRepair({ ...baseArgs, max_rounds: 1 }, testConfig(root), {
      processRunner,
      fetchImpl,
      runner: noLmsRunner(),
    });

    expect(result.passed).toBe(false);
    expect(result.restore_conflicts).toEqual(["src/math.ts"]);
    // The rollback must not be allowed to destroy work it did not write.
    expect(await fs.readFile(target, "utf8")).toBe(OUTSIDE);
  });

  it("does not adopt a file written by someone else while the model was generating", async () => {
    const root = tempRoot();
    await setup(root);
    const target = path.join(root, "src/math.ts");
    const OUTSIDE = "// a formatter got here during generation\n";

    // The model returns the file unchanged, so the loop writes nothing at all —
    // every byte on disk afterwards belongs to the other writer.
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", BROKEN))]);
    const racingFetch: typeof fetchImpl = async (...args) => {
      await fs.writeFile(target, OUTSIDE, "utf8");
      return fetchImpl(...args);
    };

    const result = await runRepair({ ...baseArgs, max_rounds: 1 }, testConfig(root), {
      processRunner: sequencedProcess([
        { stdout: tscErrors(2), code: 2 },
        { stdout: tscErrors(2), code: 2 },
      ]),
      fetchImpl: racingFetch,
      runner: noLmsRunner(),
    });

    // Generation is the longest part of a round, so this is the window that
    // matters. Reading the file back to decide what "we" wrote would have
    // claimed OUTSIDE as ours and rolled it away.
    expect(result.restore_conflicts).toEqual(["src/math.ts"]);
    expect(await fs.readFile(target, "utf8")).toBe(OUTSIDE);
  });

  it("reports what is actually on disk when it applies the change", async () => {
    const root = tempRoot();
    await setup(root);
    const target = path.join(root, "src/math.ts");
    const FORMATTED = "export function add(a: number, b: number): number {\n  return a + b; // formatted\n}\n";

    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);

    let gateRuns = 0;
    const processRunner: ProcessRunner = async () => {
      gateRuns++;
      if (gateRuns === 1) return { stdout: tscErrors(1), stderr: "", code: 2, timedOut: false };
      // A check that rewrites files: `eslint --fix`, a formatter, a codegen step.
      await fs.writeFile(target, FORMATTED, "utf8");
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };

    const result = await runRepair(baseArgs, testConfig(root), {
      processRunner,
      fetchImpl,
      runner: noLmsRunner(),
    });

    expect(result.passed).toBe(true);
    expect(result.applied).toBe(true);
    // `applied: true` is a claim about the working tree, so the diff has to
    // describe the tree — not the bytes the model happened to hand us.
    expect(result.diff).toContain("// formatted");
    expect(await fs.readFile(target, "utf8")).toBe(FORMATTED);
  });

  it("does not claim a file is unchanged when it cannot read it back", async () => {
    const root = tempRoot();
    await setup(root);
    const target = path.join(root, "src/math.ts");
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);

    let gateRuns = 0;
    const processRunner: ProcessRunner = async () => {
      gateRuns++;
      if (gateRuns === 1) return { stdout: tscErrors(1), stderr: "", code: 2, timedOut: false };
      // A check that removes the file: a cleanup step, codegen, a stray rm.
      await fs.rm(target);
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };

    const result = await runRepair(baseArgs, testConfig(root), {
      processRunner,
      fetchImpl,
      runner: noLmsRunner(),
    });

    expect(result.passed).toBe(true);
    expect(result.unverified).toEqual(["src/math.ts"]);
    // Falling back to the original bytes would render as "changed nothing",
    // which is a false negative about work the loop actually did.
    expect(result.files_changed).toEqual(["src/math.ts"]);
    expect(result.diff).toContain("return a + b;");
  });

  it("flags a file it could not read during rollback instead of skipping it", async () => {
    const root = tempRoot();
    await setup(root);
    const target = path.join(root, "src/math.ts");
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", WORSE))]);

    let gateRuns = 0;
    const processRunner: ProcessRunner = async () => {
      gateRuns++;
      if (gateRuns === 2) await fs.rm(target); // gone before the rollback runs
      return { stdout: tscErrors(2), stderr: "", code: 2, timedOut: false };
    };

    const result = await runRepair({ ...baseArgs, max_rounds: 1 }, testConfig(root), {
      processRunner,
      fetchImpl,
      runner: noLmsRunner(),
    });

    expect(result.passed).toBe(false);
    // Silently skipping it would report a rollback that never happened.
    expect(result.restore_conflicts).toEqual(["src/math.ts"]);
  });

  it("reports files the checks rewrote, which it neither diffs nor rolls back", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);

    let statusCalls = 0;
    const vcsRunner: ProcessRunner = async (_command, args) => {
      if (args[0] === "status") {
        statusCalls++;
        return {
          stdout: statusCalls === 1 ? " M src/math.ts\n" : " M src/math.ts\n M src/formatted.ts\n",
          stderr: "",
          code: 0,
          timedOut: false,
        };
      }
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };

    const result = await runRepair(baseArgs, testConfig(root), {
      processRunner: sequencedProcess([
        { stdout: tscErrors(1), code: 2 },
        { stdout: "", code: 0 },
      ]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner,
    });

    expect(result.passed).toBe(true);
    // src/math.ts is the loop's own edit. src/formatted.ts is a check's doing —
    // absent from the diff and never rolled back, so it has to be named.
    expect(result.check_side_effects).toEqual(["src/formatted.ts"]);
  });

  it("reports null side effects when it cannot inventory the tree", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([]);

    const result = await runRepair(baseArgs, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: "", code: 0 }]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: async () => ({ stdout: "", stderr: "not a git repository", code: 128, timedOut: false }),
    });

    // "We could not look" must never render as "nothing changed".
    expect(result.check_side_effects).toBeNull();
  });

  it("keeps rolling back the other files when one of them cannot be restored", async () => {
    const root = tempRoot();
    const OTHER = "export const n = 1;\n";
    await writeFileTree(root, {
      "src/math.ts": BROKEN,
      "src/other.ts": OTHER,
      ".local-coder/checks.json": JSON.stringify({
        checks: [{ name: "tsc", category: "types", kind: "tsc", command: "npx", args: ["tsc", "--noEmit"] }],
      }),
    });

    const { fetchImpl } = queuedFetch([
      chatBody(`${fileBlock("src/math.ts", WORSE)}\n${fileBlock("src/other.ts", "export const n = 2;\n")}`),
    ]);

    let gateRuns = 0;
    const processRunner: ProcessRunner = async () => {
      gateRuns++;
      // Both files were just written; now the first one vanishes.
      if (gateRuns === 2) await fs.rm(path.join(root, "src/math.ts"));
      return { stdout: tscErrors(2), stderr: "", code: 2, timedOut: false };
    };

    const result = await runRepair(
      { files: ["src/math.ts", "src/other.ts"], spec: "add() must return the sum", max_rounds: 1 },
      testConfig(root),
      { processRunner, fetchImpl, runner: noLmsRunner() }
    );

    expect(result.restore_conflicts).toEqual(["src/math.ts"]);
    // Letting the first file abort the loop left every later file holding model
    // output, with no record of it.
    expect(await fs.readFile(path.join(root, "src/other.ts"), "utf8")).toBe(OTHER);
  });

  it("names the checks' side effects in the error when the loop throws", async () => {
    const root = tempRoot();
    await setup(root);
    const checksFile = path.join(root, ".local-coder", "checks.json");
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", WORSE))]);

    let statusCalls = 0;
    const vcsRunner: ProcessRunner = async (_command, args) => {
      if (args[0] === "status") {
        statusCalls++;
        return {
          stdout: statusCalls === 1 ? " M src/math.ts\n" : " M src/math.ts\n M src/generated.ts\n",
          stderr: "",
          code: 0,
          timedOut: false,
        };
      }
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };

    let gateRuns = 0;
    const processRunner: ProcessRunner = async () => {
      gateRuns++;
      // Break the config the next gate re-reads, so round 1's gate throws.
      if (gateRuns === 1) await fs.writeFile(checksFile, "{ not json", "utf8");
      return { stdout: tscErrors(2), stderr: "", code: 2, timedOut: false };
    };

    // The error is ALL the caller gets on this path, so a file the checks
    // rewrote — which is on disk and is never rolled back — has to be named in it.
    await expect(
      runRepair({ ...baseArgs, max_rounds: 2 }, testConfig(root), {
        processRunner,
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner,
      })
    ).rejects.toThrow(/src\/generated\.ts/);
  });

  it("says so in the error when it could not inventory the tree at all", async () => {
    const root = tempRoot();
    await setup(root);
    const checksFile = path.join(root, ".local-coder", "checks.json");
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", WORSE))]);

    let gateRuns = 0;
    const processRunner: ProcessRunner = async () => {
      gateRuns++;
      if (gateRuns === 1) await fs.writeFile(checksFile, "{ not json", "utf8");
      return { stdout: tscErrors(2), stderr: "", code: 2, timedOut: false };
    };

    // A gate ran before the throw, so the checks may have changed files. An
    // unknown inventory exiting quietly would read as "nothing changed".
    await expect(
      runRepair({ ...baseArgs, max_rounds: 2 }, testConfig(root), {
        processRunner,
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner: async () => ({ stdout: "", stderr: "not a git repository", code: 128, timedOut: false }),
      })
    ).rejects.toThrow(/UNKNOWN/);
  });

  it("stays quiet about the tree when it failed before any check ran", async () => {
    const root = tempRoot();
    await setup(root);
    await fs.writeFile(path.join(root, ".local-coder", "checks.json"), "{ not json", "utf8");
    const { fetchImpl } = queuedFetch([]);

    const error = await runRepair(baseArgs, testConfig(root), {
      processRunner: sequencedProcess([]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: async () => ({ stdout: "", stderr: "not a git repository", code: 128, timedOut: false }),
    }).catch((e: unknown) => e as ToolError);

    // The first gate threw while reading its config, so nothing executed and
    // nothing can have touched the tree. Warning here would be a false alarm,
    // and wrapping would bury the precise code the caller branches on.
    expect(error.message).toMatch(/not valid JSON/);
    expect(error.message).not.toMatch(/UNKNOWN/);
    expect(error.code).toBe("checks_config_invalid");
  });

  it("treats a gate that executed nothing as no check having run", async () => {
    const root = tempRoot();
    await setup(root);
    const checksFile = path.join(root, ".local-coder", "checks.json");
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", WORSE))]);

    // The only configured check cannot be spawned, so the gate comes back with a
    // report carrying `error` — it returned, but nothing executed. It also
    // breaks the config so round 1's gate throws.
    const processRunner: ProcessRunner = async () => {
      await fs.writeFile(checksFile, "{ not json", "utf8");
      throw new Error("command not found: npx");
    };

    const error = await runRepair({ ...baseArgs, max_rounds: 2 }, testConfig(root), {
      processRunner,
      fetchImpl,
      runner: noLmsRunner(),
    }).catch((e: unknown) => e as ToolError);

    // Setting the flag on the gate merely RETURNING would have claimed the tree
    // state was unknown after checks that never started.
    expect(error.message).not.toMatch(/UNKNOWN/);
    expect(error.code).toBe("checks_config_invalid");
  });

  it("does not blame the checks for a change when no check ran", async () => {
    const root = tempRoot();
    await setup(root);
    await fs.writeFile(path.join(root, ".local-coder", "checks.json"), "{ not json", "utf8");
    const { fetchImpl } = queuedFetch([]);

    let statusCalls = 0;
    const vcsRunner: ProcessRunner = async (_command, args) => {
      if (args[0] === "status") {
        statusCalls++;
        return {
          stdout: statusCalls === 1 ? "" : " M src/somebody-else.ts\n",
          stderr: "",
          code: 0,
          timedOut: false,
        };
      }
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };

    const error = await runRepair(baseArgs, testConfig(root), {
      processRunner: sequencedProcess([]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner,
    }).catch((e: unknown) => e as ToolError);

    // A real difference, but no check ever executed — so it cannot have been
    // caused by one, and saying "your checks changed this" would be a lie.
    expect(error.message).not.toMatch(/somebody-else/);
    expect(error.code).toBe("checks_config_invalid");
  });

  it("refuses to write over a file that changed while the model was generating", async () => {
    const root = tempRoot();
    await setup(root);
    const target = path.join(root, "src/math.ts");
    const OUTSIDE = "// a human is editing this right now\n";

    // Unlike the unchanged-echo case, here the model DOES return a change for
    // the same file, so without a check its output would land on top.
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);
    const racingFetch: typeof fetchImpl = async (...args) => {
      await fs.writeFile(target, OUTSIDE, "utf8");
      return fetchImpl(...args);
    };

    const result = await runRepair({ ...baseArgs, max_rounds: 2 }, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: tscErrors(1), code: 2 }]),
      fetchImpl: racingFetch,
      runner: noLmsRunner(),
    });

    expect(result.stopped_because).toBe("concurrent_edit");
    expect(result.applied).toBe(false);
    expect(result.restore_conflicts).toEqual(["src/math.ts"]);
    expect(await fs.readFile(target, "utf8")).toBe(OUTSIDE);
  });

  it("does not grant the corrective retry a fresh timeout", async () => {
    const root = tempRoot();
    await setup(root);
    // A malformed first response normally buys exactly one corrective retry.
    const { fetchImpl, calls } = queuedFetch([
      chatBody("sorry, no file blocks here"),
      chatBody(fileBlock("src/math.ts", FIXED)),
    ]);

    let clock = 0;
    const slowFetch: typeof fetchImpl = async (...args) => {
      clock += 70_000; // the first request alone outlives the budget
      return fetchImpl(...args);
    };

    const result = await runRepair({ ...baseArgs, budget_seconds: 60, max_rounds: 1 }, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: tscErrors(1), code: 2 }]),
      fetchImpl: slowFetch,
      runner: noLmsRunner(),
      now: () => clock,
    });

    // One model request, not two. Reusing the first attempt's timeout for the
    // retry is how a hard deadline silently becomes two deadlines.
    expect(calls).toHaveLength(1);
    expect(result.stopped_because).toBe("model_failed");
  });

  it("rejects an oversized file before reading it into memory", async () => {
    const root = tempRoot();
    await setup(root);
    await fs.writeFile(path.join(root, "src/math.ts"), "x".repeat(4 * 1024), "utf8");
    const { fetchImpl, calls } = queuedFetch([]);

    await expect(
      runRepair(baseArgs, { ...testConfig(root), maxFileKb: 1, maxContextKb: 1 }, {
        processRunner: sequencedProcess([{ stdout: "", code: 0 }]),
        fetchImpl,
        runner: noLmsRunner(),
      })
    ).rejects.toThrow(/per-file limit/);

    expect(calls).toHaveLength(0);
  });

  it("never writes to the tree just to report the best attempt", async () => {
    const root = tempRoot();
    await setup(root);
    const target = path.join(root, "src/math.ts");
    const OUTSIDE = "// landed after the loop's last write\n";
    const BETTER = "export function add(a: number, b: number): number {\n  return a + 0 + b;\n}\n";

    const { fetchImpl } = queuedFetch([
      chatBody(fileBlock("src/math.ts", BETTER)), // round 1 improves: 4 -> 2
      chatBody(fileBlock("src/math.ts", WORSE)), // round 2 regresses: 2 -> 3
    ]);

    let gateRuns = 0;
    const processRunner: ProcessRunner = async () => {
      gateRuns++;
      const stdout = gateRuns === 1 ? tscErrors(4) : gateRuns === 2 ? tscErrors(2) : tscErrors(3);
      // Round 2's gate has run, so the loop is finished writing. Everything that
      // happens to the file from here is someone else's.
      if (gateRuns === 3) await fs.writeFile(target, OUTSIDE, "utf8");
      return { stdout, stderr: "", code: 2, timedOut: false };
    };

    const result = await runRepair({ ...baseArgs, max_rounds: 2 }, testConfig(root), {
      processRunner,
      fetchImpl,
      runner: noLmsRunner(),
    });

    // Round 1's attempt is still reported as an unapplied diff...
    expect(result.passed).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.diff).toContain("return a + 0 + b;");
    // ...and producing that report touched nothing. The old version briefly
    // wrote the best attempt to disk so it could read it back, which overwrote
    // this file blind.
    expect(result.restore_conflicts).toEqual(["src/math.ts"]);
    expect(await fs.readFile(target, "utf8")).toBe(OUTSIDE);
  });

  it("rolls the tree back when the loop throws after the model has written", async () => {
    const root = tempRoot();
    await setup(root);
    const target = path.join(root, "src/math.ts");
    const checksFile = path.join(root, ".local-coder", "checks.json");
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", WORSE))]);

    let gateRuns = 0;
    const processRunner: ProcessRunner = async () => {
      gateRuns++;
      // Break the check config the loop re-reads each round, so round 1's gate
      // throws — after the model has already written to disk.
      if (gateRuns === 1) await fs.writeFile(checksFile, "{ not json", "utf8");
      return { stdout: tscErrors(2), stderr: "", code: 2, timedOut: false };
    };

    await expect(
      runRepair({ ...baseArgs, max_rounds: 2 }, testConfig(root), {
        processRunner,
        fetchImpl,
        runner: noLmsRunner(),
      })
    ).rejects.toThrow(/not valid JSON/);

    // "the working tree is never left broken" has to hold on the error path too.
    expect(await fs.readFile(target, "utf8")).toBe(BROKEN);
  });

  it("counts the first gate run against the budget and caps the check timeout with it", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl, calls } = queuedFetch([]);

    const timeouts: number[] = [];
    let clock = 0;
    const processRunner: ProcessRunner = async (_command, _args, options) => {
      timeouts.push(options.timeoutMs);
      clock += 90_000;
      return { stdout: tscErrors(1), stderr: "", code: 2, timedOut: false };
    };

    const result = await runRepair({ ...baseArgs, budget_seconds: 60 }, testConfig(root), {
      processRunner,
      fetchImpl,
      runner: noLmsRunner(),
      now: () => clock,
    });

    // The check inherited the 60 s budget, not its own 300 s default...
    expect(timeouts).toEqual([60_000]);
    // ...and the budget was already spent by the time round 1 could start, so
    // the local model was never called.
    expect(result.stopped_because).toBe("budget");
    expect(result.rounds_used).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
