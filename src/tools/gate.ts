import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { loadChecks, type CheckCategory, type CheckSpec } from "../checks/config.js";
import { dedupe, parseFailures, type Failure } from "../checks/parsers.js";
import type { Config } from "../config.js";
import { createCorpusWriter, type CorpusWriter } from "../corpus.js";
import { defaultProcessRunner, type ProcessRunner } from "../exec.js";
import { ToolError } from "../fs-safety.js";
import { log } from "../logger.js";
import { createTelemetryWriter, type TelemetryWriter } from "../telemetry.js";

export const gateToolName = "gate";

export const gateToolDescription = `Run this project's lint / type-check / test commands and return ONLY the structured failures.

Prefer this over running the commands through Bash. It executes every configured check in one call and returns deduplicated failures with path, line and code — instead of thousands of lines of build and test output, all of which would stay in context and be re-read on every later turn.

Full raw output is always preserved on disk and its path is returned, so nothing is lost: read the spill file when you need an exact line.

Returns { passed, checks: [{ name, category, passed, exit_code, duration_ms, failures: [{path,line,column,code,message,count}], failure_count, truncated, spill }] }.`;

export const gateInputSchema = {
  checks: z
    .enum(["all", "lint", "types", "test"])
    .optional()
    .describe("Which category to run. Defaults to 'all'."),
  max_failures: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Cap on failures returned per check (default 25). The rest stay in the spill file."),
};

export interface GateArgs {
  checks?: "all" | "lint" | "types" | "test" | undefined;
  max_failures?: number | undefined;
}

export interface GateDeps {
  processRunner?: ProcessRunner;
  telemetry?: TelemetryWriter;
  now?: () => number;
  /**
   * Wall-clock ceiling for the WHOLE call, caller-supplied (`repair` passes what
   * is left of its own budget). Each check's own timeout is capped by whatever
   * remains, so a per-check timeout can no longer outlive the caller's deadline.
   */
  budgetMs?: number;
  /**
   * Where a red run's parsed failures are archived. Injected so tests can watch
   * it; `repair` passes a no-op, for the same reason it silences the inner
   * telemetry — its rounds run the gate repeatedly over one failure, and
   * capturing each pass would fill the corpus with duplicates of a single task.
   */
  corpus?: CorpusWriter;
}

export interface CheckReport {
  name: string;
  category: CheckCategory;
  passed: boolean;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  failures: Failure[];
  /** Total distinct failures found, before the cap. */
  failure_count: number;
  /** How many were withheld by the cap. */
  truncated: number;
  /** Repo-relative path to the full raw output, or null when it was empty. */
  spill: string | null;
  /**
   * Whether the command was actually launched.
   *
   * Distinct from `error` on purpose: `error` also covers a check that ran fine
   * and then blew up while its output was being parsed. Anyone asking "could
   * this check have touched the working tree?" needs *this* field — `error`
   * alone would answer no for a process that already did.
   */
  executed: boolean;
  /** Set when the check could not run, or ran and could not be interpreted. */
  error?: string;
}

export interface GateResult {
  passed: boolean;
  /** Unique id for this call, echoed in telemetry so the cost meter joins exactly. */
  invocation_id: string;
  checks: CheckReport[];
  /** True when no config file existed and the checks were inferred from disk. */
  checks_autodetected: boolean;
  bytes_raw: number;
  bytes_returned: number;
}

const DEFAULT_MAX_FAILURES = 25;
const SPILL_DIR = path.join(".local-coder", "spill");

async function spill(root: string, text: string): Promise<string | null> {
  if (text.trim() === "") return null;
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
  const rel = path.join(SPILL_DIR, `${digest}.txt`);
  const abs = path.join(root, rel);
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, "utf8");
  } catch (error) {
    log.warn(`could not write spill file: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  return rel.split(path.sep).join("/");
}

/**
 * Rank failures so the cap keeps the ones worth keeping: located failures
 * before unlocated ones, and more-frequent before less-frequent. A finding
 * with a path and a line is directly actionable; a bare message is not.
 */
function byUsefulness(a: Failure, b: Failure): number {
  const located = (f: Failure): number => (f.path !== null ? 2 : 0) + (f.line !== null ? 1 : 0);
  const delta = located(b) - located(a);
  return delta !== 0 ? delta : b.count - a.count;
}

async function runOne(
  spec: CheckSpec,
  root: string,
  maxFailures: number,
  runner: ProcessRunner,
  now: () => number,
  timeoutMs: number
): Promise<{ report: CheckReport; rawBytes: number }> {
  const started = now();
  // Flipped the instant the process comes back, BEFORE any parsing — everything
  // after this point can throw with the command already having run.
  let executed = false;
  try {
    const result = await runner(spec.command, spec.args, { cwd: root, timeoutMs });
    executed = true;
    const raw = `$ ${spec.command} ${spec.args.join(" ")}\n\n${result.stdout}${
      result.stderr.trim() === "" ? "" : `\n--- stderr ---\n${result.stderr}`
    }`;

    const all = dedupe(parseFailures(spec.kind, result.stdout, result.stderr, root)).sort(byUsefulness);
    // A non-zero exit with no parsed failure still means failure — surface the
    // tail of the output rather than reporting a green check.
    if (result.code !== 0 && all.length === 0) {
      const tail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-5).join("\n");
      all.push({
        path: null,
        line: null,
        column: null,
        code: `exit-${result.code ?? "signal"}`,
        message: tail === "" ? `${spec.name} exited with code ${result.code}` : tail,
        count: 1,
      });
    }

    return {
      rawBytes: raw.length,
      report: {
        name: spec.name,
        category: spec.category,
        passed: result.code === 0,
        exit_code: result.code,
        timed_out: result.timedOut,
        duration_ms: now() - started,
        failures: all.slice(0, maxFailures),
        failure_count: all.length,
        truncated: Math.max(0, all.length - maxFailures),
        spill: await spill(root, raw),
        executed: true,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      rawBytes: 0,
      report: {
        name: spec.name,
        category: spec.category,
        passed: false,
        exit_code: null,
        timed_out: false,
        duration_ms: now() - started,
        failures: [],
        failure_count: 0,
        truncated: 0,
        spill: null,
        executed,
        error: message,
      },
    };
  }
}

/**
 * Run the project's checks and return structured failures.
 *
 * The saving is twofold and both halves are recorded to telemetry: the bytes
 * that never enter the context, and the turns that do not happen because lint,
 * types and tests all ran in one call instead of three.
 */
export async function runGate(
  args: GateArgs,
  config: Config,
  deps: GateDeps = {}
): Promise<GateResult> {
  const runner = deps.processRunner ?? defaultProcessRunner;
  const now = deps.now ?? (() => Date.now());
  const telemetry = deps.telemetry ?? createTelemetryWriter(config.root);
  const corpus = deps.corpus ?? createCorpusWriter(config.root, { runner });
  const started = now();

  const category = args.checks ?? "all";
  const maxFailures = args.max_failures ?? DEFAULT_MAX_FAILURES;

  const { specs, detected } = await loadChecks(config.root);
  const selected = category === "all" ? specs : specs.filter((s) => s.category === category);

  if (selected.length === 0) {
    throw new ToolError(
      specs.length === 0
        ? `No checks configured or detected for this project. Create .local-coder/checks.json with ` +
          `{"checks":[{"name":"...","category":"types","kind":"tsc","command":"npx","args":["tsc","--noEmit"]}]}.`
        : `No checks in category ${JSON.stringify(category)}. Available: ` +
          `${[...new Set(specs.map((s) => s.category))].join(", ")}.`,
      "no_checks_configured",
      { requested: category, available: specs.map((s) => ({ name: s.name, category: s.category })) }
    );
  }

  // Sequential on purpose: checks share the CPU and, more importantly, the
  // build cache. Running tsc and vitest concurrently makes both slower.
  const deadline = deps.budgetMs === undefined ? Number.POSITIVE_INFINITY : started + deps.budgetMs;

  const reports: CheckReport[] = [];
  let rawBytes = 0;
  for (const spec of selected) {
    const remaining = deadline - now();
    // Out of time: report the check as not-run rather than pretending it passed.
    if (remaining <= 0) {
      reports.push({
        name: spec.name,
        category: spec.category,
        passed: false,
        exit_code: null,
        timed_out: true,
        duration_ms: 0,
        failures: [],
        failure_count: 0,
        truncated: 0,
        spill: null,
        executed: false,
        error: "not run: the caller's time budget was exhausted first",
      });
      log.warn(`gate: skipped ${spec.name} — time budget exhausted`);
      continue;
    }
    const { report, rawBytes: bytes } = await runOne(
      spec,
      config.root,
      maxFailures,
      runner,
      now,
      Math.min(spec.timeoutMs, remaining)
    );
    reports.push(report);
    rawBytes += bytes;
    log.info(
      `gate: ${report.name} ${report.passed ? "passed" : `failed (${report.failure_count} failure(s))`} ` +
        `in ${report.duration_ms}ms`
    );
  }

  const invocationId = randomUUID();
  const result: GateResult = {
    passed: reports.every((r) => r.passed),
    invocation_id: invocationId,
    checks: reports,
    checks_autodetected: detected,
    bytes_raw: rawBytes,
    bytes_returned: 0,
  };
  result.bytes_returned = JSON.stringify(result).length;

  await telemetry.record({
    tool: "gate",
    invocation_id: invocationId,
    bytes_raw: rawBytes,
    bytes_returned: result.bytes_returned,
    // One gate call replaces one Bash round-trip per check; the first is the
    // call itself, so every check beyond the first is a turn that did not happen.
    turns_collapsed: Math.max(0, selected.length - 1),
    latency_ms: now() - started,
    detail: { checks: selected.map((s) => s.name), passed: result.passed },
  });

  // Archive what a red run actually found. Gated on parsed failures rather than
  // on `passed`: a gate can be red because a check could not RUN — a missing
  // binary, an exhausted budget — and a run with nothing parsed has nothing a
  // corpus could use. `capture` swallows its own errors, so nothing below this
  // line can turn a gate run that worked into a failed tool call.
  if (!result.passed) {
    await corpus.capture({
      invocationId,
      checks: reports.map((r) => ({
        name: r.name,
        category: r.category,
        failure_count: r.failure_count,
        failures: r.failures,
      })),
    });
  }

  return result;
}
