import { promises as fs } from "node:fs";
import path from "node:path";

import { ToolError } from "../fs-safety.js";
import { CHECK_KINDS, type CheckKind } from "./parsers.js";

/** The three things a check can be, matching what a caller asks the gate to run. */
export type CheckCategory = "lint" | "types" | "test";

export const CHECK_CATEGORIES: readonly CheckCategory[] = ["lint", "types", "test"];

export interface CheckSpec {
  name: string;
  category: CheckCategory;
  /** Selects the output parser. */
  kind: CheckKind;
  command: string;
  args: string[];
  timeoutMs: number;
}

export const CHECKS_REL_PATH = path.join(".local-coder", "checks.json");

const DEFAULT_TIMEOUT_MS = 300_000;

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function isCategory(value: unknown): value is CheckCategory {
  return typeof value === "string" && (CHECK_CATEGORIES as readonly string[]).includes(value);
}

function isKind(value: unknown): value is CheckKind {
  return typeof value === "string" && (CHECK_KINDS as readonly string[]).includes(value);
}

function invalid(message: string, problems: string[]): ToolError {
  return new ToolError(
    `${CHECKS_REL_PATH} is invalid, so NO checks were run.\n${message}` +
      (problems.length === 0 ? "" : `\n${problems.map((p) => `  - ${p}`).join("\n")}`),
    "checks_config_invalid",
    { path: CHECKS_REL_PATH, problems }
  );
}

/**
 * Parse the explicit checks file, failing closed on anything malformed.
 *
 * Fail-closed is the whole point. An earlier version skipped unparseable
 * entries and kept the rest: a typo in one `category` then silently deleted
 * that check while the gate went on reporting `passed: true`. A verification
 * tool that quietly runs fewer checks than it was told to is worse than one
 * that refuses to run, because the caller has no way to notice.
 */
function parseSpecs(raw: unknown): CheckSpec[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid('Expected a JSON object with a "checks" array.', []);
  }
  const list = (raw as Record<string, unknown>).checks;
  if (!Array.isArray(list)) {
    throw invalid('Expected a "checks" array at the top level.', []);
  }

  const problems: string[] = [];
  const out: CheckSpec[] = [];

  list.forEach((item, index) => {
    const at = `checks[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const spec = item as Record<string, unknown>;
    const before = problems.length;

    if (typeof spec.name !== "string" || spec.name.trim() === "") {
      problems.push(`${at}.name must be a non-empty string`);
    }
    if (typeof spec.command !== "string" || spec.command.trim() === "") {
      problems.push(`${at}.command must be a non-empty string`);
    }
    if (!isCategory(spec.category)) {
      problems.push(
        `${at}.category must be one of ${CHECK_CATEGORIES.join(", ")} (got ${JSON.stringify(spec.category)})`
      );
    }
    if (spec.kind !== undefined && !isKind(spec.kind)) {
      problems.push(`${at}.kind must be one of ${CHECK_KINDS.join(", ")} (got ${JSON.stringify(spec.kind)})`);
    }
    if (
      spec.args !== undefined &&
      (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== "string"))
    ) {
      problems.push(`${at}.args must be an array of strings`);
    }
    if (
      spec.timeoutMs !== undefined &&
      !(typeof spec.timeoutMs === "number" && Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0)
    ) {
      problems.push(`${at}.timeoutMs must be a positive number of milliseconds`);
    }

    if (problems.length !== before) return;
    out.push({
      name: spec.name as string,
      category: spec.category as CheckCategory,
      kind: spec.kind === undefined ? "generic" : (spec.kind as CheckKind),
      command: spec.command as string,
      args: (spec.args as string[] | undefined) ?? [],
      timeoutMs: (spec.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT_MS,
    });
  });

  if (problems.length > 0) throw invalid("Fix every entry below and run again.", problems);
  if (out.length === 0) {
    throw invalid(
      "It defines no checks. Add at least one entry, or delete the file to fall back to autodetection.",
      []
    );
  }
  return out;
}

/**
 * Infer the project's checks from what is on disk.
 *
 * Deliberately conservative: only commands whose config file actually exists
 * are proposed. A check that fails because the tool is not configured is worse
 * than a missing check — it teaches the caller to ignore the gate.
 *
 * **ONE REGISTERED EXCEPTION, on the Python branch.** `hasPython` is true for
 * `pyproject.toml` OR `setup.cfg`, and both propose `ruff`. ruff reads
 * `pyproject.toml`, `ruff.toml` and `.ruff.toml` — never `setup.cfg` — so a
 * setup.cfg-only project gets `python -m ruff check .` proposed with no
 * ruff-readable config on disk. It is not caught by `exec.ts`'s
 * command-not-found guard either, because the command spawned is `python`, and
 * an absent module exits non-zero with a message the parser reads as no
 * findings. `pytest` is correct on both files (it reads `setup.cfg`'s
 * `[tool:pytest]`). Narrowing ruff to a config file ruff can actually read
 * would make the sentence above true without exception; that is a behaviour
 * change and has not been made.
 */
export async function detectChecks(root: string): Promise<CheckSpec[]> {
  const out: CheckSpec[] = [];
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";

  const pkg = (await readJson(path.join(root, "package.json"))) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  } | null;

  if (pkg !== null) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scripts = pkg.scripts ?? {};

    if (await exists(path.join(root, "tsconfig.json"))) {
      out.push({
        name: "tsc",
        category: "types",
        kind: "tsc",
        command: npx,
        args: ["tsc", "-p", "tsconfig.json", "--noEmit"],
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    }

    const hasEslintConfig = (
      await Promise.all(
        ["eslint.config.js", "eslint.config.mjs", ".eslintrc", ".eslintrc.json", ".eslintrc.cjs"].map((f) =>
          exists(path.join(root, f))
        )
      )
    ).some(Boolean);
    if (hasEslintConfig || deps.eslint !== undefined) {
      out.push({
        name: "eslint",
        category: "lint",
        kind: "eslint",
        command: npx,
        args: ["eslint", ".", "--format", "json"],
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    }

    // Run the project's OWN test script whenever it has one, so npm lifecycle
    // hooks run with it. Going straight to `npx vitest` skips `pretest`, and a
    // `pretest` that builds is exactly how a test suite ends up asserting
    // against a stale artifact: this repo's own stdio test runs `dist/server.js`
    // and passes on a stale `dist/` while `npm test` fails. A gate that can
    // report green where `npm test` is red is worse than no gate.
    const testScript = typeof scripts.test === "string" ? scripts.test.trim() : null;
    if (testScript !== null && testScript !== "") {
      const usesVitest = /(^|[^\w.-])vitest([^\w.-]|$)/.test(testScript);
      // `--` forwards to the underlying runner, so failures stay structured;
      // `run` is added when the script would otherwise start in watch mode.
      const forwarded = /(^|[^\w.-])run([^\w.-]|$)/.test(testScript)
        ? ["--reporter=json"]
        : ["run", "--reporter=json"];
      out.push({
        name: "npm-test",
        category: "test",
        kind: usesVitest ? "vitest" : "generic",
        command: process.platform === "win32" ? "npm.cmd" : "npm",
        args: usesVitest ? ["test", "--silent", "--", ...forwarded] : ["test", "--silent"],
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    } else if (deps.vitest !== undefined) {
      out.push({
        name: "vitest",
        category: "test",
        kind: "vitest",
        command: npx,
        args: ["vitest", "run", "--reporter=json"],
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    }
  }

  const hasPython =
    (await exists(path.join(root, "pyproject.toml"))) || (await exists(path.join(root, "setup.cfg")));
  if (hasPython) {
    out.push({
      name: "pytest",
      category: "test",
      kind: "pytest",
      command: "python",
      args: ["-m", "pytest", "-q", "--no-header"],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    out.push({
      name: "ruff",
      category: "lint",
      kind: "generic",
      command: "python",
      args: ["-m", "ruff", "check", "."],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }

  return out;
}

export interface LoadedChecks {
  specs: CheckSpec[];
  /** True when the specs came from autodetection rather than a config file. */
  detected: boolean;
}

/**
 * Config file if present, otherwise autodetection.
 *
 * An existing-but-invalid file is an error, never a silent fallback: falling
 * back would run a *different* set of checks than the one the project pinned,
 * which is the same failure as skipping one.
 */
export async function loadChecks(root: string): Promise<LoadedChecks> {
  const file = path.join(root, CHECKS_REL_PATH);
  if (!(await exists(file))) return { specs: await detectChecks(root), detected: true };

  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    throw invalid(`It could not be read: ${error instanceof Error ? error.message : String(error)}`, []);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalid(`It is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, []);
  }

  return { specs: parseSpecs(parsed), detected: false };
}

