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
