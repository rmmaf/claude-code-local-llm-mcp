/**
 * THE EMISSION CONFORMITY MATRIX — every lifecycle cell of `gate`'s and
 * `repair`'s telemetry emission, pinned against the behavior that shipped
 * BEFORE the wrapper extraction (`src/cost/emission.ts`) and held across it.
 *
 * WHY A MATRIX AND NOT A COMMENT. B12's `voidConditions` 5 voids a run when
 * "gate's or repair's telemetry emission" changes after the first scored
 * observation, and the clause-5 audit pins a PATH SET — so the emission
 * lifecycle has to live in a module that set can name, extracted from two tool
 * files that must stay editable. The extraction is lawful only if it is
 * BEHAVIOR-PRESERVING, and these cells are the proof: each one pins a
 * lifecycle path's return/throw, its telemetry row down to the field ORDER the
 * writer serializes, the corpus capture beside it, and the final tree. If any
 * cell diverges after the extraction, the pass STOPS and reports — it never
 * degrades to pinning whole tool files.
 *
 * THE STATE MACHINE THE CELLS PIN. `not-started` covers ALL of preflight and
 * emits NOTHING — a refused preflight gets no abort row, on either tool.
 * `active` begins when the preflight is ACCEPTED — before the check loop,
 * because a gate whose budget is already exhausted still emits a row with zero
 * checks executed — and emits EXACTLY ONE row, normal or abort.
 */

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProcessResult, ProcessRunner } from "../src/exec.js";
import { ToolError } from "../src/fs-safety.js";
import { readTelemetry, TELEMETRY_REL_PATH } from "../src/telemetry.js";
import type { CaptureInput } from "../src/corpus.js";
import { runGate } from "../src/tools/gate.js";
import { runRepair } from "../src/tools/repair.js";
import {
  chatBody,
  fileBlock,
  makeTempRoot,
  noLmsRunner,
  queuedFetch,
  testConfig,
  writeFileTree,
} from "./helpers.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = makeTempRoot("emission-matrix-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
  }
});

/** The exact serialization order `createTelemetryWriter` produces: `ts` is
 * spread first, then the caller's own field order — identical at all three
 * emission sites. A wrapper that reordered fields would still parse, still
 * pass every structural test in this repository, and still change the bytes
 * clause 5 pins; this is the assertion that notices. */
const ROW_KEYS = ["ts", "tool", "invocation_id", "bytes_raw", "bytes_returned", "turns_collapsed", "latency_ms", "detail"];

async function rawLines(root: string): Promise<string[]> {
  try {
    const text = await fs.readFile(path.join(root, TELEMETRY_REL_PATH), "utf8");
    return text.split("\n").filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

/** A recording corpus writer: the matrix pins WHEN capture happens and with
 * WHAT payload; the real writer's own file behavior is pinned by the gate
 * suite, which also runs before and after the extraction. */
function recordingCorpus(): { calls: CaptureInput[]; capture: (input: CaptureInput) => Promise<string | null> } {
  const calls: CaptureInput[] = [];
  return {
    calls,
    capture: async (input: CaptureInput) => {
      calls.push(input);
      return null;
    },
  };
}

/** A ProcessRunner that walks a queue, one result per gate run. */
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

const NOT_A_REPO: ProcessRunner = async () => ({
  stdout: "",
  stderr: "fatal: not a git repository (or any of the parent directories): .git",
  code: 128,
  timedOut: false,
});

const BROKEN = "export function add(a: number, b: number): number {\n  return a - b;\n}\n";
const FIXED = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const STILL_BROKEN = "export function add(a: number, b: number): number {\n  return a * b;\n}\n";

const CHECKS_JSON = JSON.stringify({
  checks: [{ name: "tsc", category: "types", kind: "tsc", command: "npx", args: ["tsc", "--noEmit"] }],
});

function tscErrors(count: number): string {
  return Array.from(
    { length: count },
    (_unused, i) => `src/math.ts(${i + 2},10): error TS2345: wrong operand ${i}.`
  ).join("\n");
}

async function setup(root: string): Promise<void> {
  await writeFileTree(root, {
    "src/math.ts": BROKEN,
    ".local-coder/checks.json": CHECKS_JSON,
  });
}

const baseArgs = { files: ["src/math.ts"], spec: "add() must return the sum, not the difference" };

describe("the emission matrix — gate", () => {
  it("cell: preflight refused — NOTHING is emitted, not even the telemetry file", async () => {
    // `not-started` covers the whole preflight. No checks configured, none
    // detectable: the refusal throws before any write, and the log file itself
    // must not exist — a writer that eagerly touched disk on selection would
    // put an empty log where the meter expects absence.
    const root = tempRoot();
    const corpus = recordingCorpus();
    await expect(
      runGate({}, testConfig(root), { processRunner: sequencedProcess([]), corpus })
    ).rejects.toThrow(ToolError);
    expect(await rawLines(root)).toEqual([]);
    expect(existsSync(path.join(root, TELEMETRY_REL_PATH))).toBe(false);
    expect(corpus.calls).toEqual([]);
  });

  it("cell: green — exactly one row, the pinned field order, and no corpus capture", async () => {
    const root = tempRoot();
    await writeFileTree(root, { ".local-coder/checks.json": CHECKS_JSON });
    const corpus = recordingCorpus();
    const result = await runGate({}, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: "", code: 0 }]),
      corpus,
    });

    expect(result.passed).toBe(true);
    const lines = await rawLines(root);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(ROW_KEYS);
    expect(row.tool).toBe("gate");
    expect(row.invocation_id).toBe(result.invocation_id);
    // 20 raw bytes on an empty stdout is the CURRENT accounting (the parser's
    // own wrapper counts), and the row must say what the result says — the
    // literal pins the value, the equality pins the relation.
    expect(row.bytes_raw).toBe(20);
    expect(row.bytes_raw).toBe(result.bytes_raw);
    expect(row.bytes_returned).toBe(result.bytes_returned);
    expect(row.turns_collapsed).toBe(0); // one check: every check beyond the first
    expect(row.detail).toEqual({ checks: ["tsc"], passed: true });
    expect(corpus.calls).toEqual([]);
  });

  it("cell: red — one row, and one capture carrying the row's own invocation id", async () => {
    const root = tempRoot();
    await writeFileTree(root, { ".local-coder/checks.json": CHECKS_JSON });
    const corpus = recordingCorpus();
    const result = await runGate({}, testConfig(root), {
      processRunner: sequencedProcess([{ stdout: tscErrors(2), code: 2 }]),
      corpus,
    });

    expect(result.passed).toBe(false);
    const lines = await rawLines(root);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(ROW_KEYS);
    expect(row.detail).toEqual({ checks: ["tsc"], passed: false });
    expect(corpus.calls).toHaveLength(1);
    expect(corpus.calls[0]!.invocationId).toBe(result.invocation_id);
    expect(corpus.calls[0]!.checks).toEqual([
      {
        name: "tsc",
        category: "types",
        failure_count: 2,
        failures: result.checks[0]!.failures,
      },
    ]);
  });

  it("cell: non-empty selection, zero checks executed by budget — the row is STILL emitted", async () => {
    // The cell R7#2 added: after the preflight accepts, an exhausted budget
    // marks every check not-run and the tool still returns a result AND still
    // emits its row — so `active` cannot begin at "the first check side
    // effect"; on this path that moment never comes.
    const root = tempRoot();
    await writeFileTree(root, { ".local-coder/checks.json": CHECKS_JSON });
    const corpus = recordingCorpus();
    const result = await runGate({}, testConfig(root), {
      processRunner: sequencedProcess([]),
      corpus,
      budgetMs: 0,
      now: () => 1_000,
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.executed).toBe(false);
    expect(result.checks[0]!.timed_out).toBe(true);
    const lines = await rawLines(root);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(ROW_KEYS);
    expect(row.bytes_raw).toBe(0);
    expect(row.latency_ms).toBe(0); // the frozen clock pins it
    // Red with nothing parsed still captures — with an empty failure list.
    expect(corpus.calls).toHaveLength(1);
    expect(corpus.calls[0]!.checks[0]!.failure_count).toBe(0);
  });
});

describe("the emission matrix — repair", () => {
  it("cell: preflight refused — a typed error, no round, and NO abort row", async () => {
    // The behavior repair.test.ts:1509 pinned first, restated here as the
    // matrix's own cell: `not-started` emits nothing, and a preflight refusal
    // is `not-started` by definition.
    const root = tempRoot();
    await setup(root);
    await writeFileTree(root, { "src/wide.ts": "x".repeat(40 * 1024) });
    const { fetchImpl, calls } = queuedFetch([]);

    await expect(
      runRepair({ ...baseArgs, files: ["src/wide.ts"] }, testConfig(root), {
        processRunner: sequencedProcess([{ stdout: tscErrors(2), code: 2 }]),
        fetchImpl,
        runner: noLmsRunner(),
        vcsRunner: NOT_A_REPO,
      })
    ).rejects.toThrow(ToolError);
    expect(calls).toHaveLength(0);
    expect(await rawLines(root)).toEqual([]);
  });

  it("cell: pass — exactly one row, the pinned field order, applied tree kept", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", FIXED))]);
    const result = await runRepair({ ...baseArgs, max_rounds: 1 }, testConfig(root), {
      processRunner: sequencedProcess([
        { stdout: tscErrors(1), code: 2 },
        { stdout: "", code: 0 },
      ]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
    });

    expect(result.passed).toBe(true);
    expect(result.applied).toBe(true);
    expect(await fs.readFile(path.join(root, "src/math.ts"), "utf8")).toBe(FIXED);
    const lines = await rawLines(root);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(ROW_KEYS);
    expect(row.tool).toBe("repair");
    expect(row.turns_collapsed).toBe(1); // one round
    expect(row.bytes_returned).toBe(result.bytes_returned);
    expect((row.detail as { stopped_because?: string }).stopped_because).toBe("passed");
  });

  it("cell: fail — one row, and the rollback leaves the tree exactly as found", async () => {
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/math.ts", STILL_BROKEN))]);
    const result = await runRepair({ ...baseArgs, max_rounds: 1 }, testConfig(root), {
      processRunner: sequencedProcess([
        { stdout: tscErrors(1), code: 2 },
        { stdout: tscErrors(1), code: 2 },
      ]),
      fetchImpl,
      runner: noLmsRunner(),
      vcsRunner: NOT_A_REPO,
    });

    expect(result.passed).toBe(false);
    expect(result.applied).toBe(false);
    expect(await fs.readFile(path.join(root, "src/math.ts"), "utf8")).toBe(BROKEN);
    const lines = await rawLines(root);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(ROW_KEYS);
    expect((row.detail as { stopped_because?: string }).stopped_because).toBe(result.stopped_because);
  });

  it("cell: abort in `active` — exactly ONE abort row, and the tree is rolled back", async () => {
    // The write-once invariant on its hardest path: the loop throws AFTER a
    // response arrived (the model invalidated the check config, so the
    // post-generation gate throws), the catch writes the abort row, the
    // rollback restores BOTH files — and nothing writes a second row.
    const root = tempRoot();
    await setup(root);
    const { fetchImpl } = queuedFetch([
      chatBody(fileBlock("src/math.ts", FIXED) + "\n" + fileBlock(".local-coder/checks.json", `{"checks":[]}\n`)),
    ]);

    await expect(
      runRepair(
        { ...baseArgs, files: ["src/math.ts", ".local-coder/checks.json"], max_rounds: 1 },
        testConfig(root),
        {
          processRunner: sequencedProcess([{ stdout: tscErrors(1), code: 2 }]),
          fetchImpl,
          runner: noLmsRunner(),
          vcsRunner: NOT_A_REPO,
        }
      )
    ).rejects.toThrow();

    const lines = await rawLines(root);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(ROW_KEYS);
    expect(row.tool).toBe("repair");
    expect(row.bytes_raw).toBe(0);
    expect(row.bytes_returned).toBe(0);
    expect(row.turns_collapsed).toBe(0);
    expect((row.detail as { aborted?: boolean }).aborted).toBe(true);
    expect(await fs.readFile(path.join(root, "src/math.ts"), "utf8")).toBe(BROKEN);
    expect(await fs.readFile(path.join(root, ".local-coder/checks.json"), "utf8")).toBe(CHECKS_JSON);
    // And the parsed view agrees with the raw one: one row, not one valid row
    // among several.
    expect(await readTelemetry(root)).toHaveLength(1);
  });
});
