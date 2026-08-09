import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { loadChecks, type CheckCategory, type CheckSpec } from "../checks/config.js";
import { dedupe, parseFailures, type Failure } from "../checks/parsers.js";
import type { Config } from "../config.js";
import type { CorpusWriter } from "../corpus.js";
import { selectCorpusWriter, selectTelemetryWriter, startEmission } from "../cost/emission.js";
import { defaultProcessRunner, runGit, type ProcessRunner } from "../exec.js";
import { ToolError } from "../fs-safety.js";
import { log } from "../logger.js";
import type { TelemetryWriter } from "../telemetry.js";

export const gateToolName = "gate";

export const gateToolDescription = `Run this project's configured checks — whichever of lint, type-check and test it has — and return ONLY the structured failures.

Prefer this over running the commands through Bash. It executes every configured check in one call and returns deduplicated failures with path, line and code — instead of thousands of lines of build and test output, all of which would stay in context and be re-read on every later turn.

Raw output goes to disk when there was any and the write succeeded; \`spill\` has the path, or null. Read it when you need an exact line.

\`passed\` means every SELECTED check exited 0 — not that the tree is correct. \`coverage\` returns the commands that ran and the files changed since HEAD: a changed path no command examines is one this result is SILENT about, not one it verified.

Returns { passed, invocation_id, checks_autodetected, bytes_raw, bytes_returned, coverage: {autodetected,commands,changed_files}, checks: [{ name, category, passed, exit_code, timed_out, duration_ms, failures: [{path,line,column,code,message,count}], failure_count, truncated, spill, executed, error }] }.`;

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
   * Whether to ask git which files changed, for `coverage.changed_files`.
   * Defaults to true; `repair` turns it OFF, for the same reason it silences the
   * inner telemetry and passes a no-op corpus. Its loop runs the gate once per
   * round against a tree only it is editing, so the probe would spend a
   * subprocess per round to re-answer a question the caller already has — and
   * it spends it out of the caller's own time budget.
   *
   * Off means `changed_files: null`, which is the field's existing "git could
   * not say" value. `commands` is unaffected: it costs nothing.
   */
  probeChangedFiles?: boolean;
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
  /**
   * Repo-relative path to the full raw output, or null.
   *
   * Null does NOT mean "the output was empty" on its own — it is also null when
   * the check never launched (the time-budget skip), when `runOne` threw, and
   * when the spill file itself could not be written (logged as a warning and
   * surfaced nowhere else in this payload). Read `executed` and `error` before
   * concluding anything from a null spill.
   */
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

/**
 * What this run can and cannot speak for.
 *
 * `run 2026-08-04-mac-10` is why this exists. Eight hours of delegated work
 * landed in `tetris/*.js`, which is on the path of neither configured check, so
 * `gate` returned GREEN on a program that did not run — and the caller had no
 * field to notice with. `passed` answers "did the selected checks exit 0", and
 * that had been silently read as "is the tree correct" because nothing in the
 * payload distinguished them.
 *
 * Note what is deliberately absent: any CLAIM about which paths a check covers.
 * `npx tsc -p tsconfig.json` is knowable; what `npm test` examines is not,
 * cheaply, and a guess here would re-create the same overstatement one layer
 * down. So this reports inputs — what ran, what changed — and stops.
 */
export interface GateCoverage {
  /** True when no config file existed and the checks were inferred from disk. */
  autodetected: boolean;
  /**
   * The exact command line of each SELECTED check — what this gate set out to
   * examine, verbatim.
   *
   * Selected, not launched: a check skipped because the time budget ran out is
   * still listed here, with `executed: false` on its report. Join against
   * `checks[].executed` before reading this as "what ran".
   */
  commands: string[];
  /**
   * Files changed since HEAD, or null when git could not answer. A path here
   * that none of `commands` examines is a path this result is SILENT about.
   */
  changed_files: string[] | null;
}

export interface GateResult {
  passed: boolean;
  /** Unique id for this call, echoed in telemetry so the cost meter joins exactly. */
  invocation_id: string;
  checks: CheckReport[];
  /** True when no config file existed and the checks were inferred from disk. */
  checks_autodetected: boolean;
  /** The scope of the answer above. See `GateCoverage`. */
  coverage: GateCoverage;
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
 * Files git reports as changed, tracked or not, or null when git could not say.
 *
 * `--porcelain` rather than `diff HEAD` because untracked files are exactly the
 * case that matters here: a freshly scaffolded directory nobody checks is the
 * shape of `run 2026-08-04-mac-10`, and `diff` cannot see it.
 *
 * Null is a real answer — no git, no repo, an injected runner that refuses the
 * command — and never an error. `runGit` swallows; this only parses.
 */
async function changedFiles(
  runner: ProcessRunner,
  root: string,
  timeoutMs: number
): Promise<string[] | null> {
  const out = await runGit(runner, root, ["status", "--porcelain"], timeoutMs);
  if (out === null) return null;
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    // "XY path", and for a rename "XY old -> new" — the new name is the one a
    // check would look at, so the arrow is resolved rather than reported raw.
    .map((line) => {
      const entry = line.slice(3).trim();
      const arrow = entry.lastIndexOf(" -> ");
      return arrow === -1 ? entry : entry.slice(arrow + 4);
    })
    .filter((entry) => entry !== "");
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
  // Selection through the pinned emission wrapper — same fallback, same order;
  // the module is what B12's clause-5 audit pins, so the lifecycle has ONE home.
  const telemetry = selectTelemetryWriter(config.root, deps.telemetry);
  const corpus = selectCorpusWriter(config.root, { runner }, deps.corpus);
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

  // The preflight ACCEPTED — `active` begins HERE, before the check/budget
  // loop, because an exhausted budget below still emits a row with zero checks
  // executed. Everything above this line is `not-started` and emits nothing.
  const emission = startEmission(telemetry);

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

  // The probe is bookkeeping, and bookkeeping yields to the work: with the
  // budget spent it is skipped outright — the same rule the checks above follow
  // — and otherwise it is capped by what is left, so nothing inside a `gate`
  // call can outlive the deadline its caller set.
  const coverageRemaining = deadline - now();
  const changed =
    deps.probeChangedFiles === false || coverageRemaining <= 0
      ? null
      : await changedFiles(runner, config.root, coverageRemaining);

  const invocationId = randomUUID();
  const result: GateResult = {
    passed: reports.every((r) => r.passed),
    invocation_id: invocationId,
    checks: reports,
    checks_autodetected: detected,
    coverage: {
      autodetected: detected,
      commands: selected.map((s) => [s.command, ...s.args].join(" ")),
      changed_files: changed,
    },
    bytes_raw: rawBytes,
    bytes_returned: 0,
  };
  result.bytes_returned = JSON.stringify(result).length;

  await emission.emit({
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
