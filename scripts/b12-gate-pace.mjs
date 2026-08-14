#!/usr/bin/env node
/**
 * HOW LONG IS ONE `gate` CALL ON THIS MACHINE, AND DOES IT CROSS THE PACING BAR?
 *
 * `admissionRule` 11 voids an observation whose max inter-request gap exceeds the
 * shortest cache TTL in play, and `voidConditions` 20 lifts that to the WHOLE
 * run: one exceeding observation voids every session. A B12 observation has no
 * human in it, so its gaps are TOOL-EXECUTION TIMES — and `gate` is the longest
 * tool this repository ships. If a single gate call exceeds the bar, the run dies
 * at `emit`, after every session is paid for.
 *
 * The bar is 300,000 ms whenever ANY owned request wrote to the 5-minute cache
 * class, and 3,600,000 otherwise (`src/cost/b12/assemble.ts`). Two measured
 * routes set the 5m class and neither is under the operator's control — a
 * subagent, and a 0.18% inconsistent TTL split — so the five-minute number is the
 * one to plan against, not the hour.
 *
 * MEASURED ON win-01 2026-08-13, six runs: 348, 377, 547, 554, 576, 673 s. Every
 * one of those is over the five-minute bar. The identical suite is 20.3 s on an
 * ubuntu-latest runner, so that is Windows process-spawn cost rather than the
 * suite — which is exactly why the RUN MACHINE has to answer for itself.
 *
 * COSTS NOTHING. `gate` is ordinary code; this calls it directly and never opens
 * a Claude Code session.
 *
 * WHY NO NO-OP WRITERS. `repair` silences the gate's telemetry and corpus writers
 * when it loops; this deliberately does not. Removing work the real call does
 * would bias the duration DOWN, and the duration is the measurement.
 *
 *   node scripts/b12-gate-pace.mjs [--runs N] [--json]
 *
 * Run it from the repository root — `loadConfig` takes `process.cwd()` as the
 * root, and that is the tree whose checks get run.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The two bars `pacingFacts` chooses between, in ms. */
const BAR_5M = 300_000;
const BAR_1H = 3_600_000;

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const runsArg = argv.indexOf("--runs");
const RUNS = runsArg === -1 ? 3 : Math.max(1, Number(argv[runsArg + 1] ?? 3));

/**
 * AGAINST THE MEASURED TREE, NOT THIS FILE'S. The intended second run is from a
 * worktree at a corpus tag — the tree an observation actually sees — with the
 * script invoked by absolute path out of the main checkout, because the corpus
 * bases predate this script and do not contain it. `loadConfig` takes
 * `process.cwd()` as the root, so the git facts have to come from there too or
 * the report names the wrong commit for the right measurement.
 */
const gitIn = (cwd, args) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() : null;
};

const say = (line) => {
  if (!asJson) process.stdout.write(line + "\n");
};

async function main() {
  const distGate = path.join(REPO, "dist", "tools", "gate.js");
  if (!existsSync(distGate)) {
    process.stderr.write(
      `b12-gate-pace: ${path.relative(REPO, distGate)} does not exist — run \`npm run build\` first.\n` +
        `The gate is measured through its COMPILED path because that is the one a session calls.\n`
    );
    process.exit(2);
  }

  const { runGate } = await import(pathToFileURL(distGate).href);
  const { loadConfig } = await import(pathToFileURL(path.join(REPO, "dist", "config.js")).href);
  const config = loadConfig();

  // A hand-written checks file REPLACES autodetection, so a tree carrying one is
  // not measuring what a fresh checkout would do. win-01 has one; it is
  // gitignored and per-machine, and it must not silently colour this number.
  // AGAINST `config.root`, because that is the path `loadChecks` reads — not
  // this script's own directory, which is a different tree in the corpus-base run.
  const explicitChecks = existsSync(path.join(config.root, ".local-coder", "checks.json"));

  const head = gitIn(config.root, ["rev-parse", "HEAD"]);
  const describe = gitIn(config.root, ["describe", "--tags", "--always"]);
  const gateFrom = gitIn(REPO, ["rev-parse", "--short", "HEAD"]);

  say(`b12-gate-pace — ${RUNS} run(s)`);
  say(`  platform      ${process.platform} ${process.arch}, node ${process.versions.node}, ${os.cpus().length} cpu`);
  say(`  measured tree ${config.root}`);
  say(`  commit        ${head ?? "(unknown)"}${describe ? `  (${describe})` : ""}`);
  say(`  gate binary   ${path.relative(config.root, distGate) || distGate}${gateFrom ? `  (built from ${gateFrom})` : ""}`);
  say(`  checks.json   ${explicitChecks ? "PRESENT — autodetection is REPLACED, this is not a fresh-checkout number" : "absent (autodetection)"}`);
  say("");

  const durations = [];
  for (let i = 1; i <= RUNS; i++) {
    const t0 = process.hrtime.bigint();
    const result = await runGate({ checks: "all" }, config);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    durations.push(ms);
    const per = result.checks
      .map((c) => `${c.name} ${(c.duration_ms / 1000).toFixed(1)}s${c.timed_out ? " TIMED-OUT" : ""}`)
      .join(", ");
    say(
      `  run ${String(i).padStart(2)}  ${(ms / 1000).toFixed(1).padStart(7)}s  ` +
        `${result.passed ? "passed" : "FAILED"}  [${per}]`
    );
  }

  const max = Math.max(...durations);
  const min = Math.min(...durations);
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const over5m = durations.filter((d) => d > BAR_5M).length;
  const over1h = durations.filter((d) => d > BAR_1H).length;

  say("");
  say(`  min ${(min / 1000).toFixed(1)}s   median ${(median / 1000).toFixed(1)}s   MAX ${(max / 1000).toFixed(1)}s`);
  say(`  over the 5-minute bar: ${over5m} of ${RUNS}${over5m > 0 ? "  <-- one such gap inside an observation voids the WHOLE run (voidConditions 20)" : ""}`);
  say(`  over the 1-hour bar:   ${over1h} of ${RUNS}`);
  say("");
  say(
    over5m > 0
      ? "  READ: on this machine a single gate call can exceed the five-minute bar. The bar is\n" +
          "  five minutes whenever any owned request wrote to the 5m cache class, and a subagent\n" +
          "  does that. This is a live threat to the paid run, not a curiosity."
      : max > BAR_5M * 0.6
        ? "  READ: no run crossed the bar, but the margin is under 40%. The bar is a hard edge with\n" +
          "  a strict >, and nothing here measured a machine under load."
        : "  READ: comfortably inside the five-minute bar on this machine, under these conditions."
  );

  // The Mac fetches and never pushes, so the number comes back by hand.
  const row = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    machine: `${process.platform}-${os.cpus().length}cpu`,
    premise: "B12",
    run_id: `gate-pace-${head ? head.slice(0, 7) : "unknown"}`,
    metric: "gate_call_wall_clock_vs_pacing_bar_ms",
    value: Math.round(max),
    unit: "milliseconds",
    method:
      `${RUNS} consecutive runGate({checks:"all"}) calls through the compiled dist path, timed with ` +
      `hrtime, from ${config.root} at ${head ?? "unknown"}. Durations (ms): ${durations.map((d) => Math.round(d)).join(", ")}. ` +
      `Telemetry and corpus writers left ON, because silencing them removes work the real call does. ` +
      `checks.json ${explicitChecks ? "PRESENT (autodetection replaced)" : "absent (autodetection)"}.`,
    note:
      `The value is the MAX, because a ceiling is judged against the worst case and voidConditions 20 ` +
      `fires on ANY exceeding observation. Over the 5-minute bar: ${over5m} of ${RUNS}. ` +
      `NOT ESTABLISHED: that a gate call under B12's own load behaves like these, or that the gap ` +
      `between two API requests equals the tool duration exactly — it is the tool duration plus the ` +
      `harness's own overhead, so this is a LOWER bound on the gap.`,
  };

  say("  paste this into MEASUREMENTS.jsonl on the machine that can push:");
  say("");
  process.stdout.write(JSON.stringify(row) + "\n");
}

main().catch((error) => {
  process.stderr.write(`b12-gate-pace: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
