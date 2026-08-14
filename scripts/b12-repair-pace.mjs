#!/usr/bin/env node
/**
 * DOES `repair` REACH ITS BUDGET, AND THEREFORE THE PACING BAR?
 *
 * `scripts/b12-gate-pace.mjs` closed the gate route: on the run machine a single
 * gate call is 33-58 s against a 300,000 ms bar. This is the route it did NOT
 * close. `repair`'s 300,000 ms is a BUDGET, not a duration — it loops the gate
 * until the checks pass or the deadline expires (`DEFAULT_BUDGET_SECONDS = 300`,
 * `repairMaxRounds` 3 in every spec) — and that budget IS the five-minute bar.
 * One tool call that spends it produces one inter-request gap at the bar, and
 * `voidConditions` 20 turns that into a void of every session in the run.
 *
 * `repair` is TREATMENT-ONLY, so whatever this measures is an exposure only one
 * arm carries. That is the shape of a confound, not merely of a hazard.
 *
 * WHAT IT DECOMPOSES, which is the point. `RoundTrace` carries `model_latency_ms`
 * and `gate_ms` per round, so the answer says WHICH term drives the total. The
 * gate half is already measured; if the model half dominates, `budget_seconds` is
 * a decision about the local model and not about the checks.
 *
 * COSTS NO PAID SESSION. `repair` is ordinary code. It DOES spend local-model
 * time, and local tokens are outside B12's denominator by construction.
 *
 * REAL INPUTS, NOT INVENTED ONES. The task's own `spec.json` gives `fileScope`
 * and `prompt.md` is the brief a session receives; both are read from the
 * SCRIPT's checkout, because a corpus base predates `b12-corpus/`.
 *
 *   # from a worktree at the task's base:
 *   git worktree add /tmp/b12-base b12/corpus/selmatchfuzzy
 *   cd /tmp/b12-base && npm ci
 *   node <main-checkout>/scripts/b12-repair-pace.mjs --task selmatchfuzzy --runs 3
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BAR_MS = 300_000;
/**
 * THE ID LM STUDIO SERVES, not the one the catalogue spells. Measured on mac-01
 * 2026-08-14: the catalogue's `mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2`
 * draws `selection: model … is not in the catalog; sending it to LM Studio
 * anyway`, and the server answers to `qwen3-coder-30b-a3b-instruct-dwq-v2`.
 * That divergence is worth more than this script: the treatment arm SELECTS from
 * the catalogue, so a catalogue id the server does not serve degrades one arm
 * silently for a whole run.
 */
const DEFAULT_MODEL = "qwen3-coder-30b-a3b-instruct-dwq-v2";

const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const TASK = flag("task", "selmatchfuzzy");
const RUNS = Math.max(1, Number(flag("runs", 3)));
const MODEL = flag("model", DEFAULT_MODEL);

const sh = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: "utf8" });
const die = (why) => {
  process.stderr.write(`b12-repair-pace: ${why}\n`);
  process.exit(2);
};

async function main() {
  const distRepair = path.join(REPO, "dist", "tools", "repair.js");
  if (!existsSync(distRepair)) die(`${path.relative(REPO, distRepair)} does not exist — run \`npm run build\` in the main checkout.`);

  const specPath = path.join(REPO, "b12-corpus", TASK, "spec.json");
  const promptPath = path.join(REPO, "b12-corpus", TASK, "prompt.md");
  if (!existsSync(specPath) || !existsSync(promptPath)) die(`no spec for task ${JSON.stringify(TASK)} under b12-corpus/`);
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const prompt = readFileSync(promptPath, "utf8");
  const files = spec.fileScope ?? [];
  if (files.length === 0) die(`${TASK}'s spec declares no fileScope`);

  const { runRepair } = await import(pathToFileURL(distRepair).href);
  const { loadConfig } = await import(pathToFileURL(path.join(REPO, "dist", "config.js")).href);
  const config = loadConfig();

  // The tree must be the task's BASE, and it must start red. A green tree makes
  // `repair` return "already green; nothing to do" and measures nothing.
  const head = (sh(config.root, "git", ["rev-parse", "HEAD"]).stdout ?? "").trim();
  const describe = (sh(config.root, "git", ["describe", "--tags", "--always"]).stdout ?? "").trim();
  if (!describe.includes(TASK)) {
    process.stdout.write(
      `  WARNING: the measured tree is ${describe || head}, which does not name ${TASK}.\n` +
        `  This is only faithful from a worktree at b12/corpus/${TASK}.\n\n`
    );
  }
  for (const rel of files) {
    if (!existsSync(path.join(config.root, rel))) die(`${rel} is not in the measured tree — wrong worktree?`);
  }

  // LM STUDIO UP, AND SERVING THE MODEL BY THE NAME WE WILL ASK FOR. Both, in
  // one probe, before anything expensive: the first attempt at this measurement
  // spent a 31 s gate round and then sent an id the server does not have, and
  // `selection` only WARNS about that ("not in the catalog; sending it to LM
  // Studio anyway") rather than refusing. Two seconds here beats a minute there.
  let served = null;
  try {
    const base = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
    const r = await fetch(new URL("models", base), { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const body = await r.json();
      served = (body?.data ?? []).map((m) => m.id).filter((id) => typeof id === "string");
    }
  } catch {
    served = null;
  }
  if (served === null) {
    die(`${config.baseUrl} is not answering — start LM Studio's server (\`lms server start\`) and load ${MODEL}.`);
  }
  if (!served.includes(MODEL)) {
    die(
      `${config.baseUrl} does not serve ${JSON.stringify(MODEL)}.\n` +
        `  it serves: ${served.length === 0 ? "(nothing loaded)" : served.map((s) => `\n    ${s}`).join("")}\n` +
        `  pass --model with one of those. NOTE that a catalogue id the server does not serve is a\n` +
        `  finding in its own right: the treatment arm selects from the catalogue.`
    );
  }

  process.stdout.write(`b12-repair-pace — task ${TASK}, ${RUNS} run(s)\n`);
  process.stdout.write(`  platform      ${process.platform} ${process.arch}, node ${process.versions.node}, ${os.cpus().length} cpu\n`);
  process.stdout.write(`  measured tree ${config.root}\n`);
  process.stdout.write(`  commit        ${head}  (${describe})\n`);
  process.stdout.write(`  model         ${MODEL}\n`);
  process.stdout.write(`  files         ${files.join(", ")}\n`);
  process.stdout.write(`  budget        default (${BAR_MS} ms) — the number under test\n\n`);

  const totals = [];
  const modelMs = [];
  const gateMs = [];

  for (let i = 1; i <= RUNS; i++) {
    // FRESH TREE EVERY RUN. `repair` edits it, so run 2 onward would otherwise
    // start green and measure nothing. `clean -fd` without -x leaves
    // node_modules and .local-coder alone, both being gitignored.
    sh(config.root, "git", ["reset", "--hard", "HEAD"]);
    sh(config.root, "git", ["clean", "-fd"]);

    const t0 = process.hrtime.bigint();
    let result;
    try {
      result = await runRepair({ files, spec: prompt, checks: "test", model: MODEL }, config);
    } catch (error) {
      process.stdout.write(`  run ${String(i).padStart(2)}  THREW after ${((Number(process.hrtime.bigint() - t0) / 1e6) / 1000).toFixed(1)}s: ${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    totals.push(ms);
    for (const r of result.rounds ?? []) {
      modelMs.push(r.model_latency_ms);
      gateMs.push(r.gate_ms);
    }
    const per = (result.rounds ?? [])
      .map((r) => `r${r.round}: model ${(r.model_latency_ms / 1000).toFixed(1)}s + gate ${(r.gate_ms / 1000).toFixed(1)}s${r.error ? ` (${r.error})` : ""}`)
      .join(" | ");
    process.stdout.write(
      `  run ${String(i).padStart(2)}  ${(ms / 1000).toFixed(1).padStart(7)}s  ` +
        `${result.passed ? "FIXED" : "not fixed"}  rounds ${result.rounds_used}  stopped=${result.stopped_because}\n` +
        `           ${per}\n`
    );
  }

  if (totals.length === 0) die("every run failed — nothing to report.");

  sh(config.root, "git", ["reset", "--hard", "HEAD"]);
  sh(config.root, "git", ["clean", "-fd"]);

  const max = Math.max(...totals);
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const over = totals.filter((t) => t > BAR_MS).length;
  const medModel = med(modelMs);
  const medGate = med(gateMs);
  const roundsThatFit = medModel + medGate > 0 ? Math.floor(BAR_MS / (medModel + medGate)) : Infinity;

  process.stdout.write(`\n  MAX total ${(max / 1000).toFixed(1)}s   over the ${BAR_MS / 1000}s bar: ${over} of ${totals.length}\n`);
  process.stdout.write(`  per round, median: model ${(medModel / 1000).toFixed(1)}s, gate ${(medGate / 1000).toFixed(1)}s`);
  process.stdout.write(`  -> ${roundsThatFit === Infinity ? "n/a" : roundsThatFit} round(s) fit inside the bar\n`);
  process.stdout.write(
    over > 0
      ? `  READ: repair reaches the bar on this machine. Since repair is treatment-only, that is an\n  ARM-DEPENDENT route to voiding every session, and budget_seconds is now a live decision.\n`
      : `  READ: repair stays inside the bar here, at ${((max / BAR_MS) * 100).toFixed(0)}% of it, with ${medModel > medGate ? "the MODEL" : "the GATE"} the larger term.\n`
  );

  const row = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    machine: `${process.platform}-${os.cpus().length}cpu`,
    premise: "B12",
    run_id: `repair-pace-${TASK}-${head.slice(0, 7)}`,
    metric: "repair_call_wall_clock_vs_pacing_bar_ms",
    value: Math.round(max),
    unit: "milliseconds",
    method:
      `${totals.length} runRepair calls through the compiled dist path from ${config.root} at ${head} ` +
      `(${describe}), files ${files.join(",")}, spec = b12-corpus/${TASK}/prompt.md verbatim, checks="test", ` +
      `model ${MODEL}, budget and max_rounds left at their defaults. The tree was git reset --hard and ` +
      `clean -fd before EACH run, because repair edits it and a green tree measures nothing. ` +
      `Totals (ms): ${totals.map((t) => Math.round(t)).join(", ")}. Per-round medians: model ${Math.round(medModel)}, gate ${Math.round(medGate)}.`,
    note:
      `The bar is ${BAR_MS} ms and repair's default budget is the same number, so this asks whether a ` +
      `single treatment-only tool call can produce an over-bar inter-request gap. Over the bar: ${over} of ${totals.length}. ` +
      `NOT ESTABLISHED: that a session's own repair calls carry this file set and this spec — a session chooses both, ` +
      `and a larger scope means a slower round. Also a LOWER bound on the gap, which is the tool duration plus the ` +
      `harness's own overhead.`,
  };
  process.stdout.write(`\n  paste this into MEASUREMENTS.jsonl on the machine that can push:\n\n`);
  process.stdout.write(JSON.stringify(row) + "\n");
}

main().catch((error) => {
  process.stderr.write(`b12-repair-pace: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
