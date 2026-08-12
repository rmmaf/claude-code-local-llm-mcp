import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { contextExhausted } from "../src/contract-probe.js";
import type { ProcessResult, ProcessRunner } from "../src/exec.js";
import { ToolError } from "../src/fs-safety.js";
import { readTelemetry } from "../src/telemetry.js";
import { runRepair } from "../src/tools/repair.js";
import { chatBody, fileBlock, makeTempRoot, noLmsRunner, queuedFetch, removeTempRoot, testConfig, writeFileTree } from "./helpers.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = makeTempRoot("repair-test-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    await removeTempRoot(root);
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

/**
 * The VCS inventory, answering what a fresh temp directory really answers.
 *
 * **`vcsRunner` IS SEPARATE FROM `processRunner` AND HAS TO BE INJECTED TOO.**
 * `runRepair` falls back to `defaultProcessRunner` for it (`repair.ts:407`), so a
 * test that stubs only the check runner still shells out to REAL `git` —
 * `status --porcelain` and `diff --numstat`, twice each, four subprocesses per
 * call. Measured on this machine: an already-green call, zero rounds and zero
 * model calls, cost **179 ms** with the fallback and **12 ms** with this stub.
 * That was most of the runtime of this file, and it is why one test could blow
 * vitest's 5 s default under load and fail with a bare runner error naming no
 * assertion.
 *
 * Speed is the smaller half. The fallback made every such test depend on git
 * being installed and on where the OS puts temp directories: `git status` walks
 * UPWARD looking for a repository, so if `%TEMP%` ever sat inside one, these
 * tests would read that repository's working tree. A unit test that consults the
 * developer's VCS is not isolated, however fast it runs.
 *
 * Exit 128 is what real git returns outside a repository, so the behaviour under
 * test is unchanged: `treeFingerprint` sees a non-zero code and returns null,
 * exactly as it did before.
 */
const NOT_A_REPO: ProcessRunner = async () => ({
  stdout: "",
  stderr: "fatal: not a git repository (or any of the parent directories): .git",
  code: 128,
  timedOut: false,
});

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

/**
 * The rejection, narrowed to what the assertions below actually read.
 *
 * `.catch((e: unknown) => e as ToolError)` types the result as
 * `RepairResult | ToolError`, so every `error.message` and `error.code` after it
 * was an unchecked property access — invisible for as long as nothing
 * type-checked this tree, and silently `undefined` on the day the call stopped
 * rejecting. `not.toMatch(...)` against `undefined` throws with a message about
 * the matcher rather than about the call, which is the wrong thing to read at
 * 2am. This says what went wrong instead.
 */
async function rejectionOf(call: Promise<unknown>): Promise<ToolError> {
  // TAGGED, because collapsing both paths into one value cannot tell them
  // apart. The first draft was `call.then(v => v, e => e)` followed by an
  // `instanceof ToolError` — which accepts a call that RESOLVES with a
  // ToolError, i.e. exactly the "it returned the error instead of throwing it"
  // regression this helper is here to catch. A control that passes on the
  // failure it was written for is the defect, not the guard.
  const settled = await call.then(
    (value) => ({ rejected: false as const, value }),
    (reason: unknown) => ({ rejected: true as const, reason })
  );
  if (!settled.rejected) {
    throw new Error(`expected the call to REJECT; it resolved with ${String(settled.value)}`);
  }
  if (!(settled.reason instanceof ToolError)) {
    throw new Error(`expected a ToolError; it rejected with ${String(settled.reason)}`);
  }
  return settled.reason;
}

describe("repair loop", () => {
  it("does nothing when the checks are already green", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl, calls } = queuedFetch([]);

    const result = await runRepair(baseArgs, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: "", code: 0 }]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
    });

    expect(result.passed).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.stopped_because).toBe("max_rounds");
    expect(result.remaining_failures.length).toBeGreaterThan(0);
    // The invariant that makes writing to the real tree safe.
    expect(await fs.readFile(path.join(root, "src/math.ts"), "utf8")).toBe(BROKEN);
  });

  it("restores the tree even when the abort telemetry row cannot be written", async () => {
    // R30: the abort row was awaited BARE, ahead of the rollback, so a
    // rejecting telemetry writer exited the catch before `restore` ran.
    //
    // HONEST SCOPE, because this test cannot show otherwise: every path that
    // reaches that catch TODAY has already restored on its way out — the loop
    // restores whenever it does not apply, and the gate turns a runner error
    // into a failed check rather than a throw. So the fix makes the stated
    // contract true independently of which path arrives, and this test proves
    // the end-to-end invariant (tree restored, error surfaced) rather than
    // pre-fix damage. Suppressing the fix leaves it GREEN, and that is
    // recorded rather than dressed up as a firing control.
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", WORSE))]);

    // The checks go away AFTER the model has written — the only shape in
    // which the tree is left dirty when the catch block is entered. (A loop
    // that merely fails to reach green restores on its own way out, so it
    // cannot show this.)
    let calls = 0;
    const gateThenVanish: ProcessRunner = async () => {
      calls += 1;
      if (calls === 1) return { stdout: tscErrors(3), stderr: "", code: 2, timedOut: false };
      throw new Error("the checks went away mid-repair");
    };

    await expect(
      runRepair({ ...baseArgs, max_rounds: 1 }, testConfig(root), {
        processRunner: gateThenVanish,
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner: NOT_A_REPO,
        // Down for the whole call: the normal row's failure is what aborts
        // the loop, and the abort row's failure is what used to swallow the
        // rollback with it.
        telemetry: {
          record: async () => {
            throw new Error("telemetry is down");
          },
        },
      })
    ).rejects.toThrow(/telemetry is down/);
    // THE INVARIANT: the tree is as it was found, whatever telemetry did.
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
      vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
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

  /**
   * B16 asks whether a request the context pre-flight ADMITTED came back with
   * content missing, and `finish_reason` cannot answer it: `length` means the
   * output cap was hit, while a request that fills the window reports `stop` and
   * returns a well-formed short answer. Only prompt + completion against the
   * window sees that, so the row has to carry all three.
   *
   * PER ROUND, because each round prepends that round's gate failures and the
   * prompt grows — the round most likely to fill the window is the last one,
   * whose output is the one that gets applied.
   */
  it("writes each round's token counts and the window they were judged against", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([
      chatBody(fileBlock("src/math.ts", WORSE), { promptTokens: 4_000, completionTokens: 1_000 }),
      chatBody(fileBlock("src/math.ts", FIXED), { promptTokens: 7_100, completionTokens: 1_000 }),
    ]);

    await runRepair({ ...baseArgs, max_rounds: 2 }, testConfig(root), {
      processRunner: sequencedProcess([
        { stdout: tscErrors(4), code: 2 },
        { stdout: tscErrors(2), code: 2 },
        { stdout: "", code: 0 },
      ]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
      contextTokens: 8_192,
    });

    const detail = (await readTelemetry(root))[0]?.detail as {
      rounds?: Array<{ attempts?: Array<Record<string, unknown>> }>;
    };
    expect(detail.rounds?.[0]?.attempts).toHaveLength(1);
    expect(detail.rounds?.[0]?.attempts?.[0]).toMatchObject({
      attempt: 1,
      prompt_tokens: 4_000,
      completion_tokens: 1_000,
      context_tokens: 8_192,
      envelope: "complete",
    });
    // Round 2's prompt grew, which is the point: 7,100 + 1,000 reaches the
    // 8,192 window while round 1's 5,000 did not. The row records the raw
    // numbers and leaves the verdict to `contextExhausted`, so the rule can be
    // corrected later without invalidating rows already written.
    expect(detail.rounds?.[1]?.attempts?.[0]).toMatchObject({
      attempt: 1,
      prompt_tokens: 7_100,
      completion_tokens: 1_000,
      context_tokens: 8_192,
    });
  });

  /**
   * THE FALSE POSITIVE. `GenerationResult.usage` is the SUM of both requests,
   * and a context window is a per-request ceiling — so a corrective retry, whose
   * prompt carries the whole bad response plus the correction, pushes the total
   * past a window neither request came near. Summed here: 4,000 + 7,000 prompt
   * and 1,000 + 1,000 completion = 13,000 against 8,192. Per attempt: 5,000 and
   * 8,000, and only the second one genuinely reaches it.
   */
  it("keeps each attempt separate, so a retry cannot fake context exhaustion", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([
      // Attempt 1: no <file> block at all, so the corrective retry fires.
      chatBody("I cannot do that.", { promptTokens: 4_000, completionTokens: 1_000 }),
      chatBody(fileBlock("src/math.ts", FIXED), { promptTokens: 7_000, completionTokens: 1_000 }),
    ]);

    await runRepair({ ...baseArgs, max_rounds: 1 }, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: tscErrors(4), code: 2 }, { stdout: "", code: 0 }]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
      contextTokens: 8_192,
    });

    const attempts = ((await readTelemetry(root))[0]?.detail as {
      rounds?: Array<{ attempts?: Array<Record<string, unknown>> }>;
    }).rounds?.[0]?.attempts;

    expect(attempts).toHaveLength(2);
    expect(attempts?.[0]).toMatchObject({
      attempt: 1,
      prompt_tokens: 4_000,
      completion_tokens: 1_000,
      envelope: "no_blocks",
    });
    expect(attempts?.[1]).toMatchObject({ attempt: 2, prompt_tokens: 7_000, envelope: "complete" });
    // Neither attempt is the sum, which is the whole point of recording them
    // apart: 13,000 against a 8,192 window would have read as exhausted.
    for (const a of attempts ?? []) {
      expect(a.prompt_tokens).not.toBe(11_000);
    }
  });

  /**
   * THE FALSE NEGATIVE, and the more damaging one. `model_output_malformed` is
   * thrown after TWO responses were received and measured — the case most likely
   * to be context exhaustion. Recording only on the success path would drop
   * B16's positives while keeping every negative.
   */
  it("records the responses a malformed-output throw discards", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([
      chatBody("nothing usable", { promptTokens: 4_000, completionTokens: 4_000 }),
      chatBody("still nothing", { promptTokens: 6_000, completionTokens: 2_200 }),
    ]);

    await runRepair({ ...baseArgs, max_rounds: 1 }, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: tscErrors(4), code: 2 }]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
      contextTokens: 8_192,
    });

    const round = ((await readTelemetry(root))[0]?.detail as {
      rounds?: Array<{ error?: string; attempts?: Array<Record<string, unknown>> }>;
    }).rounds?.[0];

    expect(round?.error).toContain("corrective retry");
    expect(round?.attempts).toHaveLength(2);
    expect(round?.attempts?.[0]).toMatchObject({
      attempt: 1,
      prompt_tokens: 4_000,
      completion_tokens: 4_000,
      context_tokens: 8_192,
      envelope: "no_blocks",
    });
    // 6,000 + 2,200 = 8,200 against 8,192: the second attempt did fill the
    // window, and before this the round reported no tokens at all.
    expect(round?.attempts?.[1]).toMatchObject({ attempt: 2, prompt_tokens: 6_000 });
  });

  /**
   * THE CORRECTIVE RETRY IS ITS OWN REQUEST AND MUST CLEAR ITS OWN PRE-FLIGHT.
   * The check above the attempt loop cleared attempt 1; attempt 2 carries that
   * whole response plus the correction, so it is strictly larger and used to go
   * out unchecked — which is not only a hole in B16's denominator but the live
   * failure the pre-flight exists to stop, since an overflowing request comes
   * back as a closed, well-formed, SHORTER file that `repair` then writes.
   */
  it("does not send a corrective retry that would overflow the window", async () => {
    const root = tempRoot();
    await setup(root);
    // ~30 KB of unusable output: no <file> block, so a retry would normally
    // fire, and big enough that appending it blows the 8,192-token window.
    const { fetchImpl, calls } = queuedFetch([chatBody("x".repeat(30 * 1024))]);

    await runRepair({ ...baseArgs, max_rounds: 1 }, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: tscErrors(4), code: 2 }]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
      contextTokens: 8_192,
    });

    // One model call, not two. The queue would have thrown on a second.
    expect(calls).toHaveLength(1);
    const round = ((await readTelemetry(root))[0]?.detail as {
      rounds?: Array<{ error?: string; attempts?: Array<Record<string, unknown>> }>;
    }).rounds?.[0];
    expect(round?.attempts).toHaveLength(1);
    expect(round?.error).toContain("corrective retry was NOT sent");
  });

  /**
   * `envelope` says whether every declared block arrived and closed, and it is
   * derived from the parsed blocks and NOTHING else. A response can reach
   * `max_tokens` right after closing its last block: the envelope is complete
   * even though the stop reason says `length`. Folding the signal into the
   * outcome is the exact error B16 was written to correct, and over a
   * 20-request denominator at a 10% bar a few such rows would fail it on an
   * artefact of the label.
   *
   * The pipeline still retries — being conservative about applying a
   * length-capped response is a separate, deliberate choice from how the
   * response is MEASURED.
   */
  it("calls a length-capped response complete when every block did close", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([
      chatBody(fileBlock("src/math.ts", WORSE), { finishReason: "length" }),
      chatBody(fileBlock("src/math.ts", FIXED)),
    ]);

    await runRepair({ ...baseArgs, max_rounds: 1 }, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: tscErrors(4), code: 2 }, { stdout: "", code: 0 }]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
      contextTokens: 32_768,
    });

    const attempts = ((await readTelemetry(root))[0]?.detail as {
      rounds?: Array<{ attempts?: Array<Record<string, unknown>> }>;
    }).rounds?.[0]?.attempts;
    expect(attempts?.[0]).toMatchObject({ finish_reason: "length", envelope: "complete" });
    expect(attempts?.[0]).not.toHaveProperty("missing_files");
  });

  /**
   * A server that omits `usage` — an older build, a proxy, a version skew —
   * must produce null, not zero. Zeroes would make `contextExhausted` answer
   * "fits" for every request and let B16 appear to hold on no token data at all.
   * End to end, because the zero-filling lives in `chatCompletion`, three layers
   * below the assertion.
   */
  it("records unknown token usage as null rather than zero", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([
      chatBody(fileBlock("src/math.ts", FIXED), { omitUsage: true }),
    ]);

    await runRepair({ ...baseArgs, max_rounds: 1 }, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: tscErrors(4), code: 2 }, { stdout: "", code: 0 }]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
      contextTokens: 8_192,
    });

    const attempt = ((await readTelemetry(root))[0]?.detail as {
      rounds?: Array<{ attempts?: Array<Record<string, unknown>> }>;
    }).rounds?.[0]?.attempts?.[0];
    expect(attempt).toMatchObject({ prompt_tokens: null, completion_tokens: null });
    expect(contextExhausted(attempt?.prompt_tokens as null, attempt?.completion_tokens as null, 8_192)).toBeNull();
  });

  /**
   * THE ABORT PATH. A response that arrived and was measured must not vanish
   * because something AFTER it threw — the post-generation gate, a locked file,
   * a check config the repair itself invalidated. `runRepair`'s outer catch
   * rolls back and rethrows, so a buffer living inside the loop went with it,
   * and those are exactly the partial-failure paths where an admitted response
   * did arrive. Dropping them biases B16 away from what it exists to expose.
   */
  it("keeps the attempts when the whole repair aborts", async () => {
    const root = tempRoot();
    await setup(root);
    // The exact scenario the outer catch names: a check config the repair
    // itself invalidated. The model rewrites `checks.json` to declare nothing,
    // so the gate AFTER the generation throws instead of returning failures.
    const { fetchImpl } = queuedFetch([
      chatBody(
        fileBlock("src/math.ts", FIXED) +
          "\n" +
          fileBlock(".local-coder/checks.json", `{"checks":[]}\n`),
        { promptTokens: 4_100, completionTokens: 4_100 }
      ),
    ]);

    await expect(
      runRepair(
        { ...baseArgs, files: ["src/math.ts", ".local-coder/checks.json"], max_rounds: 1 },
        testConfig(root),
        {
          processRunner: sequencedProcess([{ stdout: tscErrors(4), code: 2 }]),
          fetchImpl,
          runner: noLmsRunner(),
          vcsRunner: NOT_A_REPO,
          contextTokens: 8_192,
        }
      )
    ).rejects.toThrow();

    const rows = await readTelemetry(root);
    expect(rows).toHaveLength(1);
    const detail = rows[0]?.detail as { aborted?: boolean; attempts?: Array<Record<string, unknown>> };
    expect(detail.aborted).toBe(true);
    // 4,100 + 4,100 = 8,200 against 8,192: a response that DID fill the window,
    // on the very path where it used to be discarded.
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts?.[0]).toMatchObject({
      round: 1,
      prompt_tokens: 4_100,
      completion_tokens: 4_100,
      context_tokens: 8_192,
    });
  });

  /**
   * A round that produced no usable response contributes nothing. Writing zeroes
   * would read as a request that cost nothing rather than one that yielded
   * nothing, and B16 counts requests the pre-flight ADMITTED and that came back.
   *
   * WHAT THIS FIXTURE ACTUALLY EXERCISES, stated because the title used to
   * overstate it. `queuedFetch` hardcodes `status: 200` and treats each queued
   * object as the response BODY, so `{ status: 500, body: "boom" }` arrives as a
   * 200 carrying that object as JSON — a payload with no `choices`, which fails
   * to parse. So this pins the UNPARSEABLE-RESPONSE path, not a transport
   * failure and not a request that never returned. Those two ARE covered
   * elsewhere in this file, by inline `fetchImpl`s that never resolve and reject
   * on abort, and by `unreachableFetch` in `tests/helpers.ts`. What no test pins
   * is whether THOSE rounds also omit `attempts` — `queuedFetch` cannot express
   * a rejection or a non-2xx, so this assertion cannot be reused for them.
   */
  it("omits attempts for a round whose response could not be parsed", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([{ status: 500, body: "boom" }]);

    await runRepair({ ...baseArgs, max_rounds: 1 }, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: tscErrors(4), code: 2 }]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
      contextTokens: 8_192,
    });

    const round = ((await readTelemetry(root))[0]?.detail as {
      rounds?: Array<Record<string, unknown>>;
    }).rounds?.[0];
    expect(round).toHaveProperty("error");
    expect(round).not.toHaveProperty("attempts");
  });

  it("writes the model to telemetry, so a latency read from the log has a subject", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);

    await runRepair({ ...baseArgs, max_rounds: 1 }, testConfig(root), {
      processRunner: sequencedProcess([
        { stdout: tscErrors(2), code: 2 },
        { stdout: "", code: 0 },
      ]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
    });

    const detail = (await readTelemetry(root))[0]?.detail as { model?: unknown };
    expect(detail.model).toBe("test-solo-model");
  });

  it("records the model of a round that threw, which the result payload lost", async () => {
    // The defect this pins, from run 2026-08-04-mac-07: `model` used to be
    // assigned from the generation's RETURN value, so a round that threw jumped
    // over the assignment and reported `model: null` about a request that had
    // been made with a model all along. 3 of that run's 4 rows were null, and
    // they were exactly the failures — which is what B6 counts and B7 times.
    const root = tempRoot();
    await setup(root);
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("The operation was aborted."));
        });
      })) as unknown as NonNullable<Parameters<typeof runRepair>[2]>["fetchImpl"];

    const result = await runRepair(
      { ...baseArgs, budget_seconds: 300, max_rounds: 1 },
      testConfig(root, { timeoutMs: 50 }),
      {
        processRunner: sequencedProcess([{ stdout: tscErrors(2), code: 2 }]),
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner: NOT_A_REPO,
      }
    );

    expect(result.stopped_because).toBe("model_failed");
    expect(result.model).toBe("test-solo-model");
    const detail = (await readTelemetry(root))[0]?.detail as { model?: unknown };
    expect(detail.model).toBe("test-solo-model");
  });

  it("reports a null model when the call ended before any generation started", async () => {
    // The remaining null has to keep meaning something specific: nothing was
    // ever resolved. A green gate returns before the loop, so no request is
    // made and there is no model to name — distinct from losing one that was.
    const root = tempRoot();
    await setup(root);

    const result = await runRepair(baseArgs, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: "", code: 0 }]),
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
    });

    expect(result.stopped_because).toBe("passed");
    expect(result.model).toBeNull();
    const detail = (await readTelemetry(root))[0]?.detail as { model?: unknown };
    expect(detail.model).toBeNull();
  });

  it("records the resolved limits when the caller named them", async () => {
    // Both are optional with defaults, so a caller that omits one is measured
    // under a condition it did not register — and no row could say which
    // afterwards. B12's Phase-3 prompt asks a session to pass these through;
    // if the session drops one, this is the only thing that will ever notice.
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);

    await runRepair({ ...baseArgs, max_rounds: 1, budget_seconds: 600 }, testConfig(root), {
      processRunner: sequencedProcess([
        { stdout: tscErrors(2), code: 2 },
        { stdout: "", code: 0 },
      ]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
    });

    const detail = (await readTelemetry(root))[0]?.detail as Record<string, unknown>;
    expect(detail.budget_seconds).toBe(600);
    expect(detail.max_rounds).toBe(1);
  });

  it("records the DEFAULTS when the caller omitted them, never absent", async () => {
    // The case that matters, and the one an argument-echo would get wrong: a
    // caller that passed nothing still ran under a specific budget, and the row
    // has to name it. Absent would read as "unknown" when the answer is 300.
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);

    await runRepair(baseArgs, testConfig(root), {
      processRunner: sequencedProcess([
        { stdout: tscErrors(2), code: 2 },
        { stdout: "", code: 0 },
      ]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
    });

    const detail = (await readTelemetry(root))[0]?.detail as Record<string, unknown>;
    expect(detail.budget_seconds).toBe(300);
    expect(detail.max_rounds).toBe(3);
  });

  it("writes the context files to telemetry, which `files` cannot hold", async () => {
    // `detail.files` is the diff's changed list, so it is structurally editable
    // files only — a read-only reference file can never appear in it. B12's
    // PHASE-3 EXPOSURE B voids itself if `src/cost/report.ts` did not reach the
    // model, and it named `detail.files`/`context_files` as the evidence: one
    // could not answer and the other did not exist.
    const root = tempRoot();
    await setup(root);
    await writeFileTree(root, { "src/reference.ts": "export const K = 1;\n" });
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);

    await runRepair(
      { ...baseArgs, context_files: ["src/reference.ts"], max_rounds: 1 },
      testConfig(root),
      {
        processRunner: sequencedProcess([
          { stdout: tscErrors(2), code: 2 },
          { stdout: "", code: 0 },
        ]),
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner: NOT_A_REPO,
      }
    );

    const detail = (await readTelemetry(root))[0]?.detail as { context_files?: unknown };
    expect(detail.context_files).toEqual(["src/reference.ts"]);
  });

  it("records the context files SENT, not the ones asked for", async () => {
    // The control, and the only test that separates this field from a copy of
    // `args.context_files`: a path passed as both context and editable is
    // dropped from the context list by runGeneration and goes into the prompt
    // once, as editable. Recording the argument would name a file as context
    // that the model never saw as one — the same class of error as a run
    // reporting its DECLARED window instead of its loaded one.
    const root = tempRoot();
    await setup(root);
    await writeFileTree(root, { "src/reference.ts": "export const K = 1;\n" });
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);

    const result = await runRepair(
      // src/math.ts is in BOTH lists.
      { ...baseArgs, context_files: ["src/math.ts", "src/reference.ts"], max_rounds: 1 },
      testConfig(root),
      {
        processRunner: sequencedProcess([
          { stdout: tscErrors(2), code: 2 },
          { stdout: "", code: 0 },
        ]),
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner: NOT_A_REPO,
      }
    );

    expect(result.files_changed).toEqual(["src/math.ts"]);
    const detail = (await readTelemetry(root))[0]?.detail as {
      files?: unknown;
      context_files?: unknown;
    };
    expect(detail.files).toEqual(["src/math.ts"]);
    expect(detail.context_files).toEqual(["src/reference.ts"]);
  });

  it("records an empty context list rather than omitting the key", async () => {
    // `[]` and absent have to mean different things: `[]` is a prompt that
    // carried no context files, absent is a row written before this field
    // existed. A reader that cannot tell them apart cannot decide a VOID — it
    // would read "we never recorded this" as "none were sent".
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);

    await runRepair({ ...baseArgs, max_rounds: 1 }, testConfig(root), {
      processRunner: sequencedProcess([
        { stdout: tscErrors(2), code: 2 },
        { stdout: "", code: 0 },
      ]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
    });

    const detail = (await readTelemetry(root))[0]?.detail as { context_files?: unknown };
    expect(detail).toHaveProperty("context_files");
    expect(detail.context_files).toEqual([]);
  });

  it("leaves every byte figure B12 meters untouched by the new field", async () => {
    // `repair` is the tool under measurement, so a field added to observe it
    // must not move its numerator. `bytes_returned` is the size of the RESULT
    // payload (repair.ts), which is why this field goes in `detail` and nowhere
    // near `result` — two runs of one fixture, one with context files and one
    // without, have to agree on all three metered figures.
    //
    // THE CLOCK IS INJECTED, AND WITHOUT IT THIS TEST IS NOISE. `bytes_returned`
    // is `JSON.stringify(result).length`, and `result.rounds` carries
    // `model_ms`/`gate_ms` off the wall clock — so two runs differ by one byte
    // the moment a timing crosses a digit boundary, which is a real 656-vs-657
    // failure this file produced. A control that fires on the clock cannot say
    // anything about the field it exists to watch.
    const run = async (context: string[] | undefined) => {
      const target = tempRoot();
      await setup(target);
      await writeFileTree(target, { "src/reference.ts": "export const K = 1;\n" });
      const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);
      let tick = 0;
      const result = await runRepair(
        { ...baseArgs, ...(context === undefined ? {} : { context_files: context }), max_rounds: 1 },
        testConfig(target),
        {
          processRunner: sequencedProcess([
            { stdout: tscErrors(2), code: 2 },
            { stdout: "", code: 0 },
          ]),
          fetchImpl,
          runner: noLmsRunner(),
          vcsRunner: NOT_A_REPO,
          now: () => (tick += 1_000),
        }
      );
      const row = (await readTelemetry(target))[0];
      return { result, row };
    };

    const without = await run(undefined);
    const with_ = await run(["src/reference.ts"]);

    // The field reached telemetry — otherwise this test passes vacuously.
    expect((with_.row?.detail as { context_files?: unknown }).context_files).toEqual([
      "src/reference.ts",
    ]);
    // And changed nothing that B12 divides by.
    expect(with_.row?.bytes_raw).toBe(without.row?.bytes_raw);
    expect(with_.row?.bytes_returned).toBe(without.row?.bytes_returned);
    expect(with_.row?.turns_collapsed).toBe(without.row?.turns_collapsed);
    expect(with_.result.bytes_returned).toBe(without.result.bytes_returned);
    expect(with_.result).not.toHaveProperty("context_files");
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
      })) as unknown as NonNullable<Parameters<typeof runRepair>[2]>["fetchImpl"];

    const result = await runRepair({ ...baseArgs, budget_seconds: 1, max_rounds: 1 }, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: tscErrors(2), code: 2 }]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
    });

    expect(result.stopped_because).toBe("budget");
    // ...and the reason survives the relabelling, which is the only thing that
    // makes relabelling safe.
    expect(result.rounds[0]?.error).toMatch(/timed out/i);
    expect(await fs.readFile(path.join(root, "src/math.ts"), "utf8")).toBe(BROKEN);
  });

  it("does not call a per-request timeout `budget` while the budget still holds", async () => {
    const root = tempRoot();
    await setup(root);
    // The request's ceiling is min(config.timeoutMs, remaining), so a small
    // per-request limit under a generous budget raises the SAME llm_timeout
    // with the call's own deadline nowhere near. Reporting `budget` here would
    // claim an exhausted ceiling that was never reached — the mirror image of
    // the bug above, and just as corrupting to the stop-cause telemetry.
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("The operation was aborted."));
        });
      })) as unknown as NonNullable<Parameters<typeof runRepair>[2]>["fetchImpl"];

    const result = await runRepair(
      { ...baseArgs, budget_seconds: 300, max_rounds: 1 },
      testConfig(root, { timeoutMs: 50 }),
      {
        processRunner: sequencedProcess([{ stdout: tscErrors(2), code: 2 }]),
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner: NOT_A_REPO,
      }
    );

    expect(result.stopped_because).toBe("model_failed");
    expect(result.rounds[0]?.error).toMatch(/timed out/i);
  });

  it("reads which ceiling fired, not the clock, when the two disagree", async () => {
    const root = tempRoot();
    await setup(root);
    // The case that separates observing the cause from inferring it. The
    // request is issued with 60 ms of budget left and a 50 ms per-request limit,
    // so the PER-REQUEST limit is what binds and the model failed on its own
    // ceiling. The deadline then passes while the abort propagates — so a clock
    // read in the catch says "no budget left" and would report `budget`, which
    // is a stop cause that did not happen. After a real abort the deadline has
    // almost always passed, whichever limit fired, which is exactly why the
    // clock cannot be the test.
    let elapsed = 0;
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          elapsed = 5_000; // the deadline is now long past
          reject(new Error("The operation was aborted."));
        });
      })) as unknown as NonNullable<Parameters<typeof runRepair>[2]>["fetchImpl"];

    const result = await runRepair(
      { ...baseArgs, budget_seconds: 1, max_rounds: 1 },
      testConfig(root, { timeoutMs: 50 }),
      {
        processRunner: async () => {
          elapsed = 940; // the gate spends most of the budget
          return { stdout: tscErrors(2), stderr: "", code: 2, timedOut: false };
        },
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner: NOT_A_REPO,
        now: () => 1_000_000 + elapsed,
      }
    );

    expect(result.stopped_because).toBe("model_failed");
  });

  it("calls a dead heat between the two ceilings `budget`", async () => {
    const root = tempRoot();
    await setup(root);
    // remaining === config.timeoutMs exactly, so min() returns config.timeoutMs
    // and the applied value can no longer tell a tie from a comfortable budget.
    // Both ceilings bind at the same instant and the budget is spent either way
    // — one iteration later the between-rounds branch would call this `budget`,
    // so calling it anything else here contradicts the loop's own accounting.
    // Not a corner case: config.timeoutMs and DEFAULT_BUDGET_SECONDS share a
    // default, so round 1 lands on the tie whenever the first gate is free.
    let elapsed = 0;
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("The operation was aborted."));
        });
      })) as unknown as NonNullable<Parameters<typeof runRepair>[2]>["fetchImpl"];

    const result = await runRepair(
      { ...baseArgs, budget_seconds: 1, max_rounds: 1 },
      testConfig(root, { timeoutMs: 50 }),
      {
        processRunner: async () => {
          elapsed = 950; // leaves exactly 50 ms, the per-request limit to the ms
          return { stdout: tscErrors(2), stderr: "", code: 2, timedOut: false };
        },
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner: NOT_A_REPO,
        now: () => 1_000_000 + elapsed,
      }
    );

    expect(result.stopped_because).toBe("budget");
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
      vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
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
        vcsRunner: NOT_A_REPO,
      })
    ).rejects.toThrow(/UNKNOWN/);
  });

  it("stays quiet about the tree when it failed before any check ran", async () => {
    const root = tempRoot();
    await setup(root);
    await fs.writeFile(path.join(root, ".local-coder", "checks.json"), "{ not json", "utf8");
    const { fetchImpl } = queuedFetch([]);

    const error = await rejectionOf(
      runRepair(baseArgs, testConfig(root), {
        processRunner: sequencedProcess([]),
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner: NOT_A_REPO,
      })
    );

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

    const error = await rejectionOf(
      runRepair({ ...baseArgs, max_rounds: 2 }, testConfig(root), {
        processRunner,
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner: NOT_A_REPO,
      })
    );

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

    const error = await rejectionOf(
      runRepair(baseArgs, testConfig(root), {
        processRunner: sequencedProcess([]),
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner,
      })
    );

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
      vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
      now: () => clock,
    });

    // One model request, not two. Reusing the first attempt's timeout for the
    // retry is how a hard deadline silently becomes two deadlines.
    expect(calls).toHaveLength(1);
    expect(result.stopped_because).toBe("model_failed");
  });

  it("refuses a request whose answer would truncate, spending no round", async () => {
    // The point of putting the output cap in repair and not only in
    // runGeneration. Inside the loop a truncated response throws after the
    // corrective retry and is filed as `model_failed` — the same label a
    // genuine loop failure gets, which is the ambiguity that makes B6
    // unmeasurable (run 2026-08-03-mac-05). Refused here it is a typed error:
    // no gate run, no round, no telemetry row claiming a failure.
    const root = tempRoot();
    await setup(root);
    await writeFileTree(root, { "src/wide.ts": "x".repeat(40 * 1024) });
    const { fetchImpl, calls } = queuedFetch([]);

    let code = "";
    try {
      await runRepair({ ...baseArgs, files: ["src/wide.ts"] }, testConfig(root), {
        processRunner: sequencedProcess([{ stdout: tscErrors(2), code: 2 }]),
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner: NOT_A_REPO,
      });
      throw new Error("expected a ToolError");
    } catch (error) {
      code = (error as ToolError).code;
    }

    expect(code).toBe("output_would_truncate");
    expect(calls.length).toBe(0);
    // Nothing ran, so nothing may be recorded as having run.
    expect(await readTelemetry(root)).toHaveLength(0);
  });

  it("does not charge context files to the output budget", async () => {
    // context_files go INTO the prompt and are never echoed back, so they cost
    // input budget and no output budget at all. Charging them would refuse
    // exactly the calls the tool is best at: one small file to edit, with real
    // reference material alongside it.
    const root = tempRoot();
    await setup(root);
    await writeFileTree(root, { "src/reference.ts": "x".repeat(60 * 1024) });
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);

    const result = await runRepair(
      { ...baseArgs, context_files: ["src/reference.ts"], max_rounds: 1 },
      testConfig(root),
      {
        processRunner: sequencedProcess([
          { stdout: tscErrors(2), code: 2 },
          { stdout: "", code: 0 },
        ]),
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner: NOT_A_REPO,
      }
    );

    expect(result.stopped_because).toBe("passed");
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
        vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
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
        vcsRunner: NOT_A_REPO,
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
      vcsRunner: NOT_A_REPO,
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
