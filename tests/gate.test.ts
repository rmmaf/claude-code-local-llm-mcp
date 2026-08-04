import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectChecks, loadChecks } from "../src/checks/config.js";
import { dedupe, extractJson, parseFailures } from "../src/checks/parsers.js";
import type { ProcessResult, ProcessRunner } from "../src/exec.js";
import { ToolError } from "../src/fs-safety.js";
import { runGate } from "../src/tools/gate.js";
import { readTelemetry } from "../src/telemetry.js";
import { makeTempRoot, testConfig, writeFileTree } from "./helpers.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = makeTempRoot("gate-test-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
  }
});

/** A ProcessRunner driven by a map of command name → result. */
function fakeProcess(handlers: Record<string, Partial<ProcessResult>>): ProcessRunner {
  return async (command, args) => {
    const key = Object.keys(handlers).find((k) => command.includes(k) || args.includes(k));
    if (key === undefined) throw new Error(`command not found: ${command}`);
    const handler = handlers[key] as Partial<ProcessResult>;
    return {
      stdout: handler.stdout ?? "",
      stderr: handler.stderr ?? "",
      code: handler.code ?? 0,
      timedOut: handler.timedOut ?? false,
    };
  };
}

async function withChecks(root: string, checks: unknown): Promise<void> {
  await fs.mkdir(path.join(root, ".local-coder"), { recursive: true });
  await fs.writeFile(path.join(root, ".local-coder", "checks.json"), JSON.stringify({ checks }), "utf8");
}

/** [] when the directory was never created, which is itself an assertion. */
async function corpusFiles(root: string): Promise<string[]> {
  try {
    return await fs.readdir(path.join(root, ".local-coder", "corpus"));
  } catch {
    return [];
  }
}

async function readCorpus(root: string, name: string): Promise<Record<string, never>> {
  return JSON.parse(await fs.readFile(path.join(root, ".local-coder", "corpus", name), "utf8"));
}

const TSC_CHECK = [
  { name: "tsc", category: "types", kind: "tsc", command: "npx", args: ["tsc", "--noEmit"] },
];

describe("failure parsers", () => {
  it("parses tsc diagnostics into path/line/column/code", () => {
    const out = parseFailures(
      "tsc",
      "src/a.ts(42,18): error TS2345: Argument of type 'string' is not assignable.\n" +
        "src/b.ts(7,3): error TS2304: Cannot find name 'foo'.\n" +
        "Found 2 errors.",
      "",
      "/repo"
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ path: "src/a.ts", line: 42, column: 18, code: "TS2345" });
    expect(out[1]?.code).toBe("TS2304");
  });

  it("relativizes absolute paths reported by tools", () => {
    const out = parseFailures("tsc", "/repo/src/a.ts(1,1): error TS1005: ';' expected.", "", "/repo");
    expect(out[0]?.path).toBe("src/a.ts");
  });

  it("keeps only eslint errors, not warnings", () => {
    const json = JSON.stringify([
      {
        filePath: "/repo/src/a.ts",
        messages: [
          { ruleId: "no-unused-vars", severity: 2, line: 3, column: 7, message: "'x' is defined but never used." },
          { ruleId: "prefer-const", severity: 1, line: 9, column: 1, message: "use const" },
        ],
      },
    ]);
    const out = parseFailures("eslint", json, "", "/repo");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: "src/a.ts", line: 3, code: "no-unused-vars" });
  });

  it("parses vitest json, locating the failure inside the test file", () => {
    const json = JSON.stringify({
      testResults: [
        {
          name: "/repo/tests/auth.test.ts",
          assertionResults: [
            { status: "passed", fullName: "ok" },
            {
              status: "failed",
              fullName: "auth > rejects an expired token",
              failureMessages: [
                "AssertionError: expected false to be true\n    at /repo/tests/auth.test.ts:31:15",
              ],
            },
          ],
        },
      ],
    });
    const out = parseFailures("vitest", json, "", "/repo");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: "tests/auth.test.ts",
      line: 31,
      code: "auth > rejects an expired token",
    });
    expect(out[0]?.message).toContain("expected false to be true");
  });

  it("reports a vitest suite that failed to load", () => {
    const json = JSON.stringify({
      testResults: [{ name: "/repo/tests/x.test.ts", assertionResults: [], message: "Cannot find module './missing'" }],
    });
    const out = parseFailures("vitest", json, "", "/repo");
    expect(out[0]).toMatchObject({ path: "tests/x.test.ts", code: "suite-error" });
  });

  it("parses pytest summary and location lines", () => {
    const out = parseFailures(
      "pytest",
      "FAILED tests/test_auth.py::test_expired - AssertionError: token still valid\n" +
        "tests/test_auth.py:31: AssertionError",
      "",
      "/repo"
    );
    expect(out[0]).toMatchObject({ path: "tests/test_auth.py", code: "test_expired" });
    expect(out[1]).toMatchObject({ path: "tests/test_auth.py", line: 31 });
  });

  it("extracts json even when the reporter interleaves other output", () => {
    expect(extractJson('warning: something\n{"testResults":[]}\ndone')).toEqual({ testResults: [] });
    expect(extractJson("not json at all")).toBeNull();
  });

  it("falls back to failure-looking lines for an unknown tool", () => {
    const out = parseFailures(
      "generic",
      "building...\nsrc/main.rs:12:5: error: cannot borrow `x` as mutable\nok",
      "",
      "/repo"
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: "src/main.rs", line: 12, column: 5 });
  });

  it("collapses identical findings into a count", () => {
    const one = { path: "a.ts", line: 1, column: 1, code: "TS1", message: "boom", count: 1 };
    expect(dedupe([one, { ...one }, { ...one, line: 2 }])).toEqual([
      { ...one, count: 2 },
      { ...one, line: 2, count: 1 },
    ]);
  });
});

describe("check configuration", () => {
  it("detects tsc, and runs tests through the project's own npm script", async () => {
    const root = tempRoot();
    await writeFileTree(root, {
      "package.json": JSON.stringify({ devDependencies: { vitest: "^4" }, scripts: { test: "vitest run" } }),
      "tsconfig.json": "{}",
    });
    const specs = await detectChecks(root);
    expect(specs.map((s) => s.name)).toEqual(["tsc", "npm-test"]);
    expect(specs.find((s) => s.name === "tsc")?.category).toBe("types");

    // `npm test` and not `npx vitest`, so lifecycle hooks (pretest) run — the
    // whole point: a pretest that builds is how a suite ends up green against a
    // stale artifact. The JSON reporter is forwarded so failures stay structured.
    const test = specs.find((s) => s.name === "npm-test");
    expect(test?.command).toMatch(/^npm(\.cmd)?$/);
    expect(test?.args).toEqual(["test", "--silent", "--", "--reporter=json"]);
    expect(test?.kind).toBe("vitest");
  });

  it("forwards `run` when the test script would start vitest in watch mode", async () => {
    const root = tempRoot();
    await writeFileTree(root, {
      "package.json": JSON.stringify({ devDependencies: { vitest: "^4" }, scripts: { test: "vitest" } }),
    });
    const specs = await detectChecks(root);
    expect(specs.find((s) => s.name === "npm-test")?.args).toEqual([
      "test",
      "--silent",
      "--",
      "run",
      "--reporter=json",
    ]);
  });

  it("falls back to npx vitest only when the project defines no test script", async () => {
    const root = tempRoot();
    await writeFileTree(root, { "package.json": JSON.stringify({ devDependencies: { vitest: "^4" } }) });
    const specs = await detectChecks(root);
    expect(specs.map((s) => s.name)).toEqual(["vitest"]);
  });

  it("does not propose eslint without a config file on disk", async () => {
    const root = tempRoot();
    await writeFileTree(root, { "package.json": JSON.stringify({ devDependencies: { eslint: "^9" } }) });
    expect((await detectChecks(root)).some((s) => s.name === "eslint")).toBe(false);
  });

  it("detects pytest and ruff from pyproject.toml", async () => {
    const root = tempRoot();
    await writeFileTree(root, { "pyproject.toml": "[project]\nname='x'\n" });
    expect((await detectChecks(root)).map((s) => s.name)).toEqual(["pytest", "ruff"]);
  });

  it("prefers an explicit config file over detection", async () => {
    const root = tempRoot();
    await writeFileTree(root, { "tsconfig.json": "{}", "package.json": "{}" });
    await withChecks(root, [{ name: "mine", category: "lint", kind: "generic", command: "true", args: [] }]);
    const loaded = await loadChecks(root);
    expect(loaded.detected).toBe(false);
    expect(loaded.specs.map((s) => s.name)).toEqual(["mine"]);
  });

  it("fails closed on a malformed entry instead of silently running the rest", async () => {
    const root = tempRoot();
    await writeFileTree(root, { "tsconfig.json": "{}", "package.json": "{}" });
    await withChecks(root, [
      { name: "tsc", category: "types", kind: "tsc", command: "npx", args: ["tsc"] },
      { name: "tests", category: "tests", kind: "vitest", command: "npx", args: ["vitest"] },
    ]);

    await expect(loadChecks(root)).rejects.toThrow(ToolError);
    await expect(loadChecks(root)).rejects.toThrow(/checks\[1\]\.category/);

    // The point of failing closed: the gate must not run the one valid check and
    // report green while the check the project actually cared about is missing.
    await expect(
      runGate({}, testConfig(root), { processRunner: fakeProcess({ tsc: { code: 0 } }) })
    ).rejects.toThrow(/NO checks were run/);
  });

  it("rejects an unparseable checks file rather than falling back to detection", async () => {
    const root = tempRoot();
    await writeFileTree(root, {
      "tsconfig.json": "{}",
      "package.json": "{}",
      ".local-coder/checks.json": "{ not json",
    });
    await expect(loadChecks(root)).rejects.toThrow(/not valid JSON/);
  });

  it("treats an explicitly empty checks list as an error, not as detection", async () => {
    const root = tempRoot();
    await writeFileTree(root, { "tsconfig.json": "{}", "package.json": "{}" });
    await withChecks(root, []);
    await expect(loadChecks(root)).rejects.toThrow(/defines no checks/);
  });
});

describe("gate tool", () => {
  it("caps each check by the caller's remaining budget and reports the rest as not-run", async () => {
    const root = tempRoot();
    await withChecks(root, [
      { name: "tsc", category: "types", kind: "tsc", command: "npx", args: ["tsc"] },
      { name: "vitest", category: "test", kind: "vitest", command: "npx", args: ["vitest"] },
    ]);

    const timeouts: number[] = [];
    let clock = 0;
    const processRunner: ProcessRunner = async (_command, _args, options) => {
      timeouts.push(options.timeoutMs);
      clock += 5_000;
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };

    const result = await runGate({}, testConfig(root), {
      processRunner,
      now: () => clock,
      budgetMs: 1_000,
    });

    // The check's own 300 s timeout must not outlive a 1 s caller budget.
    expect(timeouts).toEqual([1_000]);
    expect(result.checks[0]?.passed).toBe(true);
    expect(result.checks[1]?.error).toMatch(/time budget was exhausted/);
    expect(result.checks[0]?.executed).toBe(true);
    expect(result.checks[1]?.executed).toBe(false);
    // A check that never ran cannot count as green.
    expect(result.passed).toBe(false);
  });

  it("records whether each check started, separately from whether it errored", async () => {
    const root = tempRoot();
    await withChecks(root, [
      { name: "tsc", category: "types", kind: "tsc", command: "npx", args: ["tsc"] },
      { name: "ghost", category: "lint", kind: "generic", command: "nope", args: [] },
    ]);

    const result = await runGate({}, testConfig(root), {
      processRunner: async (command) => {
        if (command === "nope") throw new Error("command not found: nope");
        return { stdout: "", stderr: "", code: 0, timedOut: false };
      },
    });

    const byName = new Map(result.checks.map((c) => [c.name, c]));
    expect(byName.get("tsc")?.executed).toBe(true);
    expect(byName.get("ghost")?.executed).toBe(false);
    // `error` alone cannot answer "did a process run?" — it also covers a check
    // that ran and then failed while its output was being parsed.
    expect(byName.get("ghost")?.error).toBeTruthy();
  });

  it("returns structured failures and spills the raw output", async () => {
    const root = tempRoot();
    await withChecks(root, [
      { name: "tsc", category: "types", kind: "tsc", command: "npx", args: ["tsc", "--noEmit"] },
    ]);
    const noisy = [
      ...Array.from({ length: 300 }, (_, i) => `compiling module-${i}`),
      "src/a.ts(42,18): error TS2345: Argument of type 'string' is not assignable.",
    ].join("\n");

    const result = await runGate({}, testConfig(root), {
      processRunner: fakeProcess({ tsc: { stdout: noisy, code: 2 } }),
    });

    expect(result.passed).toBe(false);
    const check = result.checks[0];
    expect(check?.failures).toHaveLength(1);
    expect(check?.failures[0]).toMatchObject({ path: "src/a.ts", line: 42, code: "TS2345" });
    expect(check?.spill).toBeTruthy();

    const spilled = await fs.readFile(path.join(root, check?.spill as string), "utf8");
    expect(spilled).toContain("compiling module-299");
    // The whole point: the returned payload is far smaller than the raw output.
    expect(result.bytes_returned).toBeLessThan(result.bytes_raw / 4);
  });

  it("caps failures but reports how many were withheld", async () => {
    const root = tempRoot();
    await withChecks(root, [
      { name: "tsc", category: "types", kind: "tsc", command: "npx", args: ["tsc"] },
    ]);
    const many = Array.from(
      { length: 60 },
      (_, i) => `src/f${i}.ts(${i + 1},1): error TS2304: Cannot find name 'foo'.`
    ).join("\n");

    const result = await runGate({ max_failures: 10 }, testConfig(root), {
      processRunner: fakeProcess({ tsc: { stdout: many, code: 2 } }),
    });

    expect(result.checks[0]?.failures).toHaveLength(10);
    expect(result.checks[0]?.failure_count).toBe(60);
    expect(result.checks[0]?.truncated).toBe(50);
  });

  it("never reports a green check for a non-zero exit it could not parse", async () => {
    const root = tempRoot();
    await withChecks(root, [
      { name: "build", category: "lint", kind: "generic", command: "make", args: [] },
    ]);
    const result = await runGate({}, testConfig(root), {
      processRunner: fakeProcess({ make: { stdout: "quiet\n", code: 3 } }),
    });

    expect(result.passed).toBe(false);
    expect(result.checks[0]?.failures[0]?.code).toBe("exit-3");
  });

  it("runs only the requested category", async () => {
    const root = tempRoot();
    await withChecks(root, [
      { name: "tsc", category: "types", kind: "tsc", command: "npx", args: ["tsc"] },
      { name: "vitest", category: "test", kind: "vitest", command: "npx", args: ["vitest"] },
    ]);
    const result = await runGate({ checks: "types" }, testConfig(root), {
      processRunner: fakeProcess({ tsc: { stdout: "", code: 0 } }),
    });
    expect(result.checks.map((c) => c.name)).toEqual(["tsc"]);
    expect(result.passed).toBe(true);
  });

  it("keeps going when one check's tool is missing, and says which", async () => {
    const root = tempRoot();
    await withChecks(root, [
      { name: "ghost", category: "lint", kind: "generic", command: "not-installed", args: [] },
      { name: "tsc", category: "types", kind: "tsc", command: "npx", args: ["tsc"] },
    ]);
    const result = await runGate({}, testConfig(root), {
      processRunner: fakeProcess({ tsc: { stdout: "", code: 0 } }),
    });

    expect(result.checks).toHaveLength(2);
    expect(result.checks[0]?.error).toContain("not-installed");
    expect(result.checks[0]?.passed).toBe(false);
    expect(result.checks[1]?.passed).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("errors clearly when nothing is configured or detectable", async () => {
    const root = tempRoot();
    await expect(runGate({}, testConfig(root), { processRunner: fakeProcess({}) })).rejects.toBeInstanceOf(
      ToolError
    );
  });

  it("records the bytes it withheld and the turns it collapsed", async () => {
    const root = tempRoot();
    await withChecks(root, [
      { name: "tsc", category: "types", kind: "tsc", command: "npx", args: ["tsc"] },
      { name: "lint", category: "lint", kind: "generic", command: "lint", args: [] },
      { name: "vitest", category: "test", kind: "vitest", command: "npx", args: ["vitest"] },
    ]);
    await runGate({}, testConfig(root), {
      processRunner: fakeProcess({
        tsc: { stdout: "x".repeat(5000), code: 0 },
        lint: { stdout: "y".repeat(5000), code: 0 },
        vitest: { stdout: JSON.stringify({ testResults: [] }), code: 0 },
      }),
    });

    const entries = await readTelemetry(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tool).toBe("gate");
    // Three checks in one call means two Bash round-trips that never happened.
    expect(entries[0]?.turns_collapsed).toBe(2);
    expect(entries[0]?.bytes_returned).toBeLessThan(entries[0]?.bytes_raw ?? 0);
  });

  it("ranks located failures above bare ones so the cap keeps what is actionable", async () => {
    const root = tempRoot();
    await withChecks(root, [
      { name: "build", category: "lint", kind: "generic", command: "make", args: [] },
    ]);
    const mixed = [
      "error: something went wrong somewhere",
      "src/real.ts:10:2: error: concrete and fixable",
    ].join("\n");

    const result = await runGate({ max_failures: 1 }, testConfig(root), {
      processRunner: fakeProcess({ make: { stdout: mixed, code: 1 } }),
    });
    expect(result.checks[0]?.failures[0]?.path).toBe("src/real.ts");
  });
});

/**
 * `run 2026-08-04-mac-10` returned green on a program that did not run, because
 * the delegated work sat outside every configured check and no field said so.
 * These pin the field that makes that visible — and pin what it refuses to
 * claim, which is the half that keeps it honest.
 */
describe("coverage", () => {
  it("reports the exact command line of every check that ran", async () => {
    const root = tempRoot();
    await withChecks(root, [
      { name: "tsc", category: "types", kind: "tsc", command: "npx", args: ["tsc", "--noEmit"] },
      { name: "vitest", category: "test", kind: "vitest", command: "npm", args: ["test", "--silent"] },
    ]);
    const result = await runGate({}, testConfig(root), {
      processRunner: fakeProcess({ tsc: { code: 0 }, test: { code: 0 }, git: { stdout: "" } }),
    });

    expect(result.coverage.commands).toEqual(["npx tsc --noEmit", "npm test --silent"]);
    expect(result.coverage.autodetected).toBe(false);
  });

  it("narrows commands to the selected category, so it never overstates the run", async () => {
    const root = tempRoot();
    await withChecks(root, [
      { name: "tsc", category: "types", kind: "tsc", command: "npx", args: ["tsc"] },
      { name: "vitest", category: "test", kind: "vitest", command: "npx", args: ["vitest"] },
    ]);
    const result = await runGate({ checks: "types" }, testConfig(root), {
      processRunner: fakeProcess({ tsc: { code: 0 }, git: { stdout: "" } }),
    });

    // The test check never ran, so it must not appear as something examined.
    expect(result.coverage.commands).toEqual(["npx tsc"]);
  });

  it("lists changed files, tracked and untracked, resolving renames to the new name", async () => {
    const root = tempRoot();
    await withChecks(root, TSC_CHECK);
    const result = await runGate({}, testConfig(root), {
      processRunner: fakeProcess({
        tsc: { code: 0 },
        git: {
          stdout: " M src/a.ts\n?? tetris/game.js\nR  src/old.ts -> src/new.ts\nA  src/b.ts\n",
        },
      }),
    });

    // The untracked entry is the point: `git diff HEAD` cannot see a freshly
    // scaffolded directory, which is exactly the shape mac-10 failed on.
    expect(result.coverage.changed_files).toEqual([
      "src/a.ts",
      "tetris/game.js",
      "src/new.ts",
      "src/b.ts",
    ]);
  });

  it("degrades to null when git cannot answer, rather than failing the run", async () => {
    const root = tempRoot();
    await withChecks(root, TSC_CHECK);
    // No `git` handler: this runner THROWS on it, standing in for no git, no
    // repository, or a git too old. Reporting coverage may never turn a gate
    // run that worked into a failed tool call.
    const result = await runGate({}, testConfig(root), {
      processRunner: fakeProcess({ tsc: { code: 0 } }),
    });

    expect(result.coverage.changed_files).toBeNull();
    expect(result.passed).toBe(true);
    expect(result.coverage.commands).toEqual(["npx tsc --noEmit"]);
  });

  it("says so when the checks were guessed from disk rather than configured", async () => {
    const root = tempRoot();
    // No .local-coder/checks.json — detectChecks infers from package.json.
    await writeFileTree(root, { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
    const result = await runGate({}, testConfig(root), {
      processRunner: fakeProcess({ test: { code: 0 }, git: { stdout: "" } }),
    });

    expect(result.coverage.autodetected).toBe(true);
    expect(result.checks_autodetected).toBe(true);
  });

  /**
   * The probe is bookkeeping and must never outlive the deadline its caller
   * set. `repair` hands `gate` what is left of its own budget precisely so that
   * nothing inside can overrun it; a fixed-timeout git call would have been a
   * hole in that contract on every round.
   */
  it("skips the probe rather than overrunning an exhausted budget", async () => {
    const root = tempRoot();
    await withChecks(root, TSC_CHECK);

    const timeouts: number[] = [];
    let clock = 0;
    const processRunner: ProcessRunner = async (_command, _args, options) => {
      timeouts.push(options.timeoutMs);
      clock += 5_000;
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };

    const result = await runGate({}, testConfig(root), {
      processRunner,
      now: () => clock,
      budgetMs: 1_000,
    });

    // One entry: the check. The probe saw no time left and did not run.
    expect(timeouts).toEqual([1_000]);
    expect(result.coverage.changed_files).toBeNull();
  });

  it("caps the probe by what is left of the budget when there is some", async () => {
    const root = tempRoot();
    await withChecks(root, TSC_CHECK);

    const timeouts: number[] = [];
    const processRunner: ProcessRunner = async (_command, _args, options) => {
      timeouts.push(options.timeoutMs);
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };

    await runGate({}, testConfig(root), { processRunner, now: () => 0, budgetMs: 2_000 });

    // The check took its 2 s cap, and the probe was held to the same remainder
    // rather than to git's own 15 s ceiling.
    expect(timeouts).toEqual([2_000, 2_000]);
  });

  it("does not probe at all for repair's inner runs", async () => {
    const root = tempRoot();
    await withChecks(root, TSC_CHECK);

    const commands: string[] = [];
    const processRunner: ProcessRunner = async (command) => {
      commands.push(command);
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };

    const result = await runGate({}, testConfig(root), {
      processRunner,
      probeChangedFiles: false,
    });

    expect(commands).not.toContain("git");
    expect(result.coverage.changed_files).toBeNull();
    // Commands stay populated: they cost nothing and are what the caller needs.
    expect(result.coverage.commands).toEqual(["npx tsc --noEmit"]);
  });

  it("counts itself: the coverage field is inside the bytes the call reports", async () => {
    const root = tempRoot();
    await withChecks(root, TSC_CHECK);
    const result = await runGate({}, testConfig(root), {
      processRunner: fakeProcess({ tsc: { code: 0 }, git: { stdout: " M src/a.ts\n" } }),
    });

    // bytes_returned is measured with the field populated, so a caller reading
    // it is not told a smaller number than the payload it actually received.
    expect(result.bytes_returned).toBeGreaterThan(JSON.stringify(result.coverage).length);
    expect(result.coverage.changed_files).toEqual(["src/a.ts"]);
  });
});

describe("corpus capture", () => {
  const RED = "src/a.ts(3,10): error TS2345: wrong operand.\nsrc/b.ts(9,2): error TS2304: Cannot find name 'x'.";

  it("archives the failures a red gate parsed, joinable to its telemetry row", async () => {
    // B6 and B7 both ask for 20 real mechanical failures. gate parses a typed
    // Failure[] on every red run and its telemetry row kept only
    // {checks, passed}, so the failures were computed and dropped — an
    // instrument gap, not a shortage of failures.
    const root = tempRoot();
    await withChecks(root, TSC_CHECK);

    const result = await runGate({}, testConfig(root), {
      processRunner: fakeProcess({ tsc: { stdout: RED, code: 2 } }),
    });
    expect(result.passed).toBe(false);

    const files = await corpusFiles(root);
    expect(files).toHaveLength(1);
    const entry = await readCorpus(root, files[0] as string) as unknown as {
      invocation_id: string;
      checks: Array<{ name: string; failure_count: number; failures: Array<{ code: string }> }>;
    };

    expect(entry.checks[0]?.name).toBe("tsc");
    expect(entry.checks[0]?.failures.map((f) => f.code)).toEqual(["TS2345", "TS2304"]);
    // The join is the point: without it the archive is a pile of failures that
    // cannot be tied back to the run, its timings, or its cost.
    expect(entry.invocation_id).toBe(result.invocation_id);
    expect((await readTelemetry(root))[0]?.invocation_id).toBe(entry.invocation_id);
  });

  it("archives nothing when the gate is green", async () => {
    const root = tempRoot();
    await withChecks(root, TSC_CHECK);
    const result = await runGate({}, testConfig(root), {
      processRunner: fakeProcess({ tsc: { stdout: "", code: 0 } }),
    });
    expect(result.passed).toBe(true);
    expect(await corpusFiles(root)).toHaveLength(0);
  });

  it("archives nothing when a red gate parsed no failures", async () => {
    // Red because the check could never be LAUNCHED — runOne's catch branch,
    // where `executed` is false and there is nothing parsed. Keying the capture
    // on `passed` alone would file this as a failure to repair, and a corpus
    // counting it would be counting its own broken setup.
    //
    // Note where the line actually falls: a check that DID run and exited
    // non-zero with unparseable output gets a synthetic `exit-N` failure
    // (gate.ts), and that one IS archived. It should be — deciding whether a
    // captured failure is mechanical is the labeller's job, not the hook's.
    const root = tempRoot();
    await withChecks(root, TSC_CHECK);
    const result = await runGate({}, testConfig(root), {
      // Nothing matches, so the runner throws before the process ever starts.
      processRunner: fakeProcess({}),
    });
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.executed).toBe(false);
    expect(result.checks[0]?.failure_count).toBe(0);
    expect(await corpusFiles(root)).toHaveLength(0);
  });

  it("drops an oversized patch instead of truncating it, and lists untracked files", async () => {
    // A truncated patch applies cleanly for a while and then stops mid-hunk, so
    // it reads as a reproducible capture right up until someone depends on it.
    // Untracked paths are listed rather than captured because the only way to
    // diff them is `git add -N`, and a capture hook that writes to the index of
    // the repository it observes is not a capture hook.
    const root = tempRoot();
    await withChecks(root, TSC_CHECK);

    await runGate({}, testConfig(root), {
      processRunner: fakeProcess({
        tsc: { stdout: RED, code: 2 },
        "rev-parse": { stdout: "abc1234\n" },
        diff: { stdout: "x".repeat(300 * 1024) },
        "ls-files": { stdout: "src/new.ts\nsrc/other.ts\n" },
      }),
    });

    const files = await corpusFiles(root);
    const entry = await readCorpus(root, files[0] as string) as unknown as {
      tree: {
        head: string | null;
        patch: string | null;
        patch_bytes: number;
        patch_omitted: boolean;
        untracked: string[];
      };
    };

    expect(entry.tree.head).toBe("abc1234");
    expect(entry.tree.patch).toBeNull();
    expect(entry.tree.patch_omitted).toBe(true);
    expect(entry.tree.patch_bytes).toBeGreaterThan(256 * 1024);
    expect(entry.tree.untracked).toEqual(["src/new.ts", "src/other.ts"]);
  });

  it("still archives the failures when git is unavailable", async () => {
    // The tree state is a convenience; the failures are the point. A capture
    // that gave up because `git` was missing would lose the only part of the
    // record that B6 actually counts.
    const root = tempRoot();
    await withChecks(root, TSC_CHECK);
    await runGate({}, testConfig(root), {
      processRunner: fakeProcess({ tsc: { stdout: RED, code: 2 } }),
    });

    const files = await corpusFiles(root);
    expect(files).toHaveLength(1);
    const entry = await readCorpus(root, files[0] as string) as unknown as {
      checks: Array<{ failure_count: number }>;
      tree: { head: string | null; patch: string | null };
    };
    expect(entry.checks[0]?.failure_count).toBe(2);
    expect(entry.tree.head).toBeNull();
    expect(entry.tree.patch).toBeNull();
  });
});
