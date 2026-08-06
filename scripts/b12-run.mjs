#!/usr/bin/env node
/**
 * B12's harness. Runs observations; decides nothing.
 *
 *   node scripts/b12-run.mjs preflight --manifest evidence/<run>.b12.tasks.json
 *   node scripts/b12-run.mjs observe   --manifest <m> --task <id> [--arm treatment|control]
 *   node scripts/b12-run.mjs snapshot  --out <file>
 *
 * WHY THIS FILE EXISTS. `B1` did not fall on its merits — it died because its
 * numbers were hand-typed and its comparator was ephemeral, so nobody could
 * re-adjudicate it. B12's pre-registration answers that on the OUTPUT side with
 * machine-produced artifacts. Without a harness the same failure just moves to
 * the INPUT side: "the instructions were used verbatim", "the tree was clean",
 * "the binary was the pinned one" become claims a reader has to take on trust.
 * Every one of those is asserted here, by a program, and recorded per
 * observation.
 *
 * It refuses rather than improvises. A precondition that cannot be checked is a
 * hard exit, never a warning — a run that continued past a failed assertion
 * would produce artifacts that look identical to a clean one.
 *
 * Frozen with the rest of the instrument at the first scored observation; see
 * `PREMISES.md` B12 and `evidence/2026-08-05-b12-preregistration.json`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";

const REPO = process.cwd();

/** Exit with a reason. Never a warning: a run that continues past a failed precondition looks clean. */
function refuse(why) {
  process.stderr.write(`b12-run: REFUSED — ${why}\n`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });
  // `errorCode` and `signal` are carried SEPARATELY and never collapsed into a
  // boolean. `spawnSync` reports a timeout as status null / SIGTERM / ETIMEDOUT
  // and a missing binary as status null / no signal / ENOENT — the first is an
  // anticipated outcome the design requires kept as data, the second is a broken
  // run. A single `failed` flag made them the same thing.
  return {
    code: r.status,
    signal: r.signal ?? null,
    errorCode: r.error?.code ?? null,
    out: r.stdout ?? "",
    err: r.stderr ?? "",
  };
}

function git(args, cwd = REPO) {
  const r = run("git", ["-C", cwd, ...args]);
  if (r.code !== 0) refuse(`git ${args.join(" ")} failed: ${r.err.trim() || r.out.trim()}`);
  return r.out.trim();
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** ISO seconds, read from the clock in the same command that writes the row. */
function stamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// The snapshot. THIS is what makes inheritance impossible by construction.
// ---------------------------------------------------------------------------

/**
 * Every project slug this machine's Claude Code writes to — not one.
 *
 * A worktree gets its own slug, and this repository owns four right now. A
 * snapshot of a single slug returns `inherited = 0` for an arm that wrote to
 * another, which is a check that cannot fail — the shape of the vacuous
 * disjointness invariant and of the field comparison that reported "identical"
 * for two absent regexes. So the artifact records how many directories were
 * walked, and a run whose snapshot covered fewer slugs than it wrote to is VOID.
 */
function projectSlugDirs(rootOverride) {
  // `--root` exists so the SAME code that snapshots the machine can be pointed
  // at a fixture and compared against `src/cost/transcript.ts`. This file
  // re-implements B20's admission rule because it must run before `dist/`
  // exists, and two implementations that are never compared is precisely how
  // the meter and the oracle drifted apart four separate times.
  const root = rootOverride ?? path.join(os.homedir(), ".claude", "projects");
  if (!existsSync(root)) refuse(`no transcript root at ${root}`);
  return readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((p) => statSync(p).isDirectory());
}

function jsonlUnder(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * The admitted `requestId` set, by B20's rule and no other.
 *
 * The rule is stated in `PREMISES.md` B20 and implemented in `src/cost/`. It is
 * repeated here because this script must run before the build exists and cannot
 * import from `dist/` — and BECAUSE it is a second implementation, the emitter
 * asserts the two agree on every observation. Two copies that are never compared
 * is how the meter and the oracle drifted apart four times.
 */
function admittedRequestIds(files) {
  const ids = new Set();
  const seenUuid = new Set();
  let records = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (r.type !== "assistant") continue;
      if (r.message?.usage === undefined) continue;
      if (r.isApiErrorMessage === true || r.message?.model === "<synthetic>") continue;
      if (typeof r.uuid === "string") {
        if (seenUuid.has(r.uuid)) continue;
        seenUuid.add(r.uuid);
      }
      records++;
      if (typeof r.requestId === "string") ids.add(r.requestId);
    }
  }
  return { ids, records };
}

function takeSnapshot(rootOverride) {
  const dirs = projectSlugDirs(rootOverride);
  const files = dirs.flatMap((d) => jsonlUnder(d));
  const { ids, records } = admittedRequestIds(files);
  if (dirs.length === 0 || ids.size === 0) {
    refuse(`snapshot covered ${dirs.length} slug(s) and collected ${ids.size} ids — a zero here is a scoping error, not an empty machine`);
  }
  return {
    ts: stamp(),
    slugsWalked: dirs.length,
    slugs: dirs.map((d) => path.basename(d)),
    files: files.length,
    billableRecords: records,
    requestIds: [...ids].sort(),
  };
}

/**
 * Whether an arm's exit is an OUTCOME or a broken run — one rule, one place,
 * exported so it can be tested without spending a session.
 *
 * The distinction is not cosmetic and it has a direction. `spawnSync` reports a
 * budget timeout as `ETIMEDOUT` and a missing binary as `ENOENT`, both with a
 * null exit status. Collapsing them marks a timed-out arm INVALID — and the
 * design says exactly why that is the wrong way to be wrong: "dropping
 * budget-exhausted control arms removes exactly the evidence that favours the
 * tools." Control arms are the long ones; they have no gate to answer in a
 * single call. Invalidating them biases toward a hold.
 *
 * A censored arm is kept, marked, and carries the budget as a LOWER BOUND. It is
 * also excused from having originated anything: killed before its first billed
 * request, it still measures "this task did not finish inside the budget".
 */
export function classifyRun({
  exitCode,
  signal,
  errorCode,
  budgetMs,
  budgetEnforced = true,
  originatedCount,
  slugsBefore,
  slugsAfter,
}) {
  // AN ENUMERATION, NOT A CHAIN OF CONDITIONS.
  //
  // Six defects landed in this rule while it was written as `&&`-ed predicates,
  // and they came in two families. Three were fields it was never handed -- the
  // exit code, the signal, whether the budget was even enforced. Two were fields
  // it should never have used: `wallMs` standing in as evidence of who ended the
  // process, twice, in consecutive repairs. The sixth was `exitCode !== 0` where
  // the intent was `exitCode === null`, which is the same slip as the first five
  // wearing different clothes -- a condition that happens to be true of the case
  // in mind and also of a case not in mind.
  //
  // So the outcome is now DECIDED BY CASE over the triple `spawnSync` actually
  // returns, with no fall-through and every branch named. An unhandled
  // combination becomes a named outcome a reader can see rather than a default
  // nobody chose. `wallMs` is not a parameter at all any more: nothing here is
  // entitled to reason from duration.
  const outcome = (() => {
    // The spawn itself failed: ENOENT, EACCES. No child ever ran.
    if (errorCode !== null && errorCode !== undefined && errorCode !== "ETIMEDOUT") return "spawn_failed";
    // WE stopped it at the budget. `ETIMEDOUT` says the timeout fired, and a
    // null status says the child never got to exit on its own -- both are
    // required. `spawnSync` times the WHOLE call, so a child that finished can
    // still carry `ETIMEDOUT`: measured, a 330ms child under a 400ms timeout
    // returns `status: 0` AND `ETIMEDOUT` at 405ms because node's startup and
    // teardown count toward the timer.
    if (errorCode === "ETIMEDOUT" && exitCode === null) return "censored";
    // Killed, but not by us.
    if (exitCode === null) return "killed_by_signal";
    // The CLI failed. NOT the same as the agent failing the task: `claude
    // --print` exits 0 either way, and a genuine failure to solve it is caught
    // by the acceptance predicate as `accepted: false`, which is data and is
    // kept. This covers a bad flag, an expired credential, a context overflow,
    // and a crash partway through -- including one that carries `ETIMEDOUT`
    // because it died as the timer crossed.
    if (exitCode !== 0) return "exited_nonzero";
    return "completed";
  })();

  const censored = outcome === "censored";
  const reasons = [];

  if (outcome === "spawn_failed") reasons.push(`the CLI could not be run: ${errorCode}`);
  if (outcome === "killed_by_signal") {
    reasons.push(`the CLI was killed on signal ${signal ?? "(unknown)"} by something other than its budget`);
  }
  if (outcome === "exited_nonzero") reasons.push(`the CLI exited ${exitCode} without finishing`);

  // A censored arm is excused: killed before its first billed request, it still
  // measures "this task did not finish inside the budget", and dropping
  // budget-exhausted CONTROL arms removes exactly the evidence that favours the
  // tools.
  if (originatedCount === 0 && !censored) {
    reasons.push("no requestId was originated: the arm produced no billed request, or its slug was outside the snapshot");
  }
  if (slugsAfter < slugsBefore) {
    reasons.push(`snapshot scope shrank mid-observation, ${slugsBefore} slugs to ${slugsAfter}`);
  }
  // A fact the harness holds, never inferred from the clock.
  if (budgetEnforced === false) {
    reasons.push(`no timeout was passed to the child, so the ${budgetMs}ms budget was never enforced`);
  }

  return { outcome, censored, valid: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Preconditions. Each is asserted per observation and recorded.
// ---------------------------------------------------------------------------

/**
 * Locate the binary, or say why not. ONE lookup rule with TWO callers that need
 * different things from it.
 *
 * `observe()` cannot run an arm without `claude` and must refuse. `preflight()`
 * must REPORT: every other precondition it has is a `check()` that can come back
 * red, and the binary was the single one that called `process.exit` — so on a
 * machine without `claude` the preflight produced no checks, no artifact and an
 * empty stdout, withholding the one fact it existed to state. CI found it: a
 * runner has no `claude`, and the run that should have said `FAIL  claude on
 * PATH` said nothing at all.
 *
 * Split rather than duplicated: `claudeBinary()` is this function plus a refusal,
 * so the two callers cannot drift on what "found" means.
 */
function findClaudeBinary() {
  const which = run(process.platform === "win32" ? "where" : "which", ["claude"]);
  if (which.code !== 0) return { binary: null, why: "`claude` is not on PATH" };
  const bin = which.out.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
  if (!bin || !existsSync(bin)) return { binary: null, why: `resolved claude to ${bin ?? "(nothing)"}, which does not exist` };
  const v = run(bin, ["--version"]);
  if (v.code !== 0) return { binary: null, why: `claude --version failed: ${v.err.trim()}` };
  return { binary: { path: bin, version: v.out.trim(), sha256: sha256File(bin) }, why: null };
}

function claudeBinary() {
  const { binary, why } = findClaudeBinary();
  if (binary === null) refuse(why);
  return binary;
}

function assertPinned(manifest, binary) {
  const pin = manifest.pinned ?? {};
  if (pin.claudeCodeVersion && !binary.version.includes(pin.claudeCodeVersion)) {
    refuse(`binary is ${binary.version}, manifest pins ${pin.claudeCodeVersion} — an arm-to-arm version mismatch is a VOID condition`);
  }
  if (pin.claudeBinarySha256 && pin.claudeBinarySha256 !== binary.sha256) {
    refuse(`binary sha256 ${binary.sha256} != pinned ${pin.claudeBinarySha256}`);
  }
  if (process.env.DISABLE_AUTOUPDATER !== "1") {
    refuse("DISABLE_AUTOUPDATER is not 1 — an update mid-run splits the observation set across layouts");
  }
}

function assertRatesFrozen(manifest, cwd) {
  const want = manifest.pinned?.ratesSha256;
  if (!want) return null;
  const file = path.join(cwd, ".local-coder", "rates.json");
  if (!existsSync(file)) refuse(`rates.json missing at ${file} while the manifest pins its hash`);
  const got = sha256File(file);
  if (got !== want) refuse(`rates.json sha256 ${got} != pinned ${want} — the multipliers moved under the run`);
  return got;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function loadManifest(file) {
  if (!file) refuse("--manifest is required");
  if (!existsSync(file)) refuse(`manifest not found: ${file}`);
  const text = readFileSync(file, "utf8");
  const manifest = JSON.parse(text);
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) refuse("manifest carries no tasks");
  return { manifest, sha256: sha256Text(text), path: file };
}

/**
 * PHASE 1. Ten minutes against forty-five sessions and one of two attempts.
 *
 * The specific error it catches: four worktrees exist, so four slugs exist, and
 * the main checkout has no transcripts and no telemetry file at all. A run
 * scored against the wrong tree returns a confident `0.0000` on every
 * observation — which is a FALL, on the primary instrument, firing `G-stop`.
 * This project has already shipped one confident zero.
 */
function preflight(args) {
  const out = { ts: stamp(), checks: [] };
  let refusals = 0;
  const check = (name, ok, detail) => {
    out.checks.push({ name, ok, detail });
    if (!ok) refusals++;
    process.stdout.write(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}\n`);
  };

  // REPORTED, NOT REFUSED. See `findClaudeBinary`. `check(..., true, ...)` here
  // was a check that could not come back red: the only path to a false answer
  // exited before this line ran.
  const { binary, why: binaryWhy } = findClaudeBinary();
  check(
    "claude on PATH",
    binary !== null,
    binary === null ? binaryWhy : `${binary.version} ${binary.sha256.slice(0, 12)}`
  );
  if (binary !== null) out.binary = binary;

  // RUN-LEVEL, NOT MANIFEST-CONDITIONAL. This first shipped inside the
  // `if (args.manifest)` branch, so a preflight without one never checked it and
  // reported PASSED while an auto-update could land mid-run and split the
  // observation set across two transcript layouts.
  check(
    "DISABLE_AUTOUPDATER=1",
    process.env.DISABLE_AUTOUPDATER === "1",
    process.env.DISABLE_AUTOUPDATER ?? "(unset)"
  );

  if (args.manifest) {
    const { manifest, sha256 } = loadManifest(args.manifest);
    out.manifestSha256 = sha256;
    // NOTHING TO COMPARE IS NOT A MATCH. With no binary, `assertPinned` would
    // read `.version` off null; asserting the pin against nothing and calling it
    // green would be worse.
    if (binary === null) {
      check("binary matches the manifest pin", false, "no claude binary to compare against the pin");
    } else {
      assertPinned(manifest, binary);
      check("binary matches the manifest pin", true, manifest.pinned?.claudeCodeVersion ?? "(unpinned)");
    }
  }

  const snap = takeSnapshot(args.root);
  out.snapshot = { slugsWalked: snap.slugsWalked, files: snap.files, ids: snap.requestIds.length };
  check(
    "snapshot covers every project slug",
    snap.slugsWalked > 0 && snap.requestIds.length > 0,
    `${snap.slugsWalked} slugs, ${snap.files} files, ${snap.requestIds.length} ids`
  );

  const dist = path.join(REPO, "dist", "cost", "cli.js");
  check("cost meter is built", existsSync(dist), dist);

  // THE FIVE ASSERTIONS, ON A FRESH CALL, WHICH IS THE ONLY PLACE THEY MEAN
  // ANYTHING.
  //
  // This first shipped asserting none of them, and reported PASSED on a machine
  // where the design's own list fails outright: 12 ambiguous rows, 4 foreign, 6
  // sessions withholding. Those come from continuation lineages accumulated over
  // days -- facts about the corpus, not about whether the join works now. A
  // preflight scoped to history therefore either always fails or means nothing.
  //
  // So it is scoped to ONE SCRATCH SESSION that calls `gate` and `repair` and is
  // then read back by id. If the echo of `invocation_id` into `toolUseResult`
  // ever stops surviving a Claude Code release, this is where it surfaces -- for
  // the price of ten minutes instead of forty-five sessions and an attempt.
  if (!args.session) {
    check(
      "fresh-call assertions ran",
      false,
      "pass --session <id> from a scratch run that called gate and repair once each; " +
        "without it this preflight cannot say the join works, only that files exist"
    );
  } else if (!existsSync(dist)) {
    check("fresh-call assertions ran", false, "cost meter is not built");
  } else {
    const r = run(process.execPath, [dist, "--session", args.session, "--json"], { cwd: REPO });
    let payload = null;
    try {
      payload = JSON.parse(r.out);
    } catch {
      /* reported below */
    }
    if (payload === null || payload.length === 0) {
      check("scratch session is readable by the meter", false, r.err.slice(0, 200) || "no payload");
    } else {
      const c = payload[0].counterfactual;
      const tools = c.byTool.map((t) => t.tool);
      out.scratch = { sessionId: args.session, counterfactual: c };
      check("provenanceUnavailable === false", c.provenanceUnavailable === false, String(c.provenanceUnavailable));
      check("ambiguous === 0", c.ambiguous === 0, String(c.ambiguous));
      check("unmatched === 0", c.unmatched === 0, String(c.unmatched));
      check("excludedForeign === 0", c.excludedForeign === 0, String(c.excludedForeign));
      check("savedFraction !== null", c.savedFraction !== null, String(c.savedFraction));
      // Without both tools exercised, the five above can pass on a session that
      // called nothing -- the vacuous-check shape this project keeps hitting.
      // A ROW IS NOT EXERCISE -- and the reason I first gave for this was WRONG,
      // so it is written down instead of quietly replaced.
      //
      // I claimed an aborted `repair` would satisfy `tools.includes("repair")`,
      // because it writes a zeroed telemetry row and `buildCounterfactual`
      // creates the `byTool` entry before examining anything. Measured on a
      // fixture: it does not. An abort returns an ERROR payload, `errorResult`
      // carries no `invocation_id`, so the row finds no matching tool result,
      // lands in `excludedForeign`, and never reaches `byTool`. The original
      // check would have failed correctly.
      //
      // This stronger form is kept because it can only tighten, but NO live path
      // to it is known: a `repair` that succeeds reports its last gate's raw
      // bytes, which are non-zero. It guards a shape, not an observed defect.
      const exercised = (name) => {
        const t = c.byTool.find((x) => x.tool === name);
        if (t === undefined) return { ok: false, detail: "no row" };
        const did = t.bytes.signedUncapped !== 0 || t.turnsCollapsed > 0;
        return { ok: did, detail: did ? `${t.calls} call(s)` : "a row that did no work (abort?)" };
      };
      for (const name of ["gate", "repair"]) {
        const e = exercised(name);
        check(`${name} produced a row that did work`, e.ok, e.detail);
      }
    }
  }

  out.passed = refusals === 0;
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(out, null, 2) + "\n", "utf8");
    process.stdout.write(`  wrote ${args.out}\n`);
  }
  process.stdout.write(`\n  preflight ${out.passed ? "PASSED" : "FAILED"} (${refusals} failing check(s))\n`);
  process.exit(out.passed ? 0 : 1);
}

/**
 * One observation: one task, one arm, one fresh session, in its own worktree.
 *
 * The arm is the ONLY thing that differs. `--mcp-config` gives the treatment the
 * server; `--strict-mcp-config` gives the control a shell that IGNORES rather
 * than merges any other MCP configuration, so "server off" is a fact rather than
 * an intention.
 */
function observe(args) {
  const { manifest, sha256: manifestSha } = loadManifest(args.manifest);
  if (!args.task) refuse("--task is required");
  const task = manifest.tasks.find((t) => t.id === args.task);
  if (!task) refuse(`task ${args.task} is not in the manifest`);
  const arm = args.arm ?? "treatment";
  if (arm !== "treatment" && arm !== "control") refuse(`--arm must be treatment or control, got ${arm}`);

  const binary = claudeBinary();
  assertPinned(manifest, binary);

  // Its own worktree, from the base commit the manifest declares. Without this,
  // task 12 runs against a tree tasks 1-11 already changed, `gate` comes back
  // green where it would have returned 40 KB, and reversing the manifest's order
  // moves the result by more than the gap between the fall line and the hold.
  if (!task.baseCommit) refuse(`task ${task.id} declares no baseCommit`);
  const treeDir = path.join(REPO, ".b12", `${task.id}-${arm}`);
  if (existsSync(treeDir)) rmSync(treeDir, { recursive: true, force: true });
  mkdirSync(path.dirname(treeDir), { recursive: true });
  git(["worktree", "add", "--detach", treeDir, task.baseCommit]);
  const treeHash = git(["rev-parse", "HEAD"], treeDir);
  const dirty = run("git", ["-C", treeDir, "status", "--porcelain"]).out.trim();
  if (dirty) refuse(`fresh worktree is not clean: ${dirty.slice(0, 200)}`);
  const ratesSha = assertRatesFrozen(manifest, treeDir);

  // The instruction is READ, never retyped. This is the whole reason the file
  // exists: "the prompt was used verbatim" is otherwise unfalsifiable.
  if (typeof task.prompt !== "string" || task.prompt.length === 0) refuse(`task ${task.id} carries no prompt`);
  const promptSha = sha256Text(task.prompt);
  if (task.promptSha256 && task.promptSha256 !== promptSha) {
    refuse(`task ${task.id} prompt sha256 ${promptSha} != manifest ${task.promptSha256} — the text moved after sealing`);
  }

  const sessionId = createHash("sha256")
    .update(`${manifestSha}:${task.id}:${arm}:${stamp()}`)
    .digest("hex")
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");

  const before = takeSnapshot();

  const mcpArgs =
    arm === "treatment"
      ? ["--mcp-config", manifest.pinned?.mcpConfig ?? path.join(REPO, ".mcp.json")]
      : ["--strict-mcp-config"];
  // THE PROMPT MUST NOT FOLLOW A VARIADIC OPTION, AND IT DID -- IN THE TREATMENT
  // ARM ONLY.
  //
  // `claude --help` declares `--mcp-config <configs...>` and
  // `--allowedTools, --allowed-tools <tools...>`: variadic, consuming every
  // following argument until one starts with `-`. Treatment ended in
  // `--mcp-config <path>` and then the prompt, so the prompt was swallowed as a
  // second config path and claude ran with none: "Input must be provided either
  // through stdin or as a prompt argument when using --print", exit 1, no
  // transcript. Control ends in `--strict-mcp-config`, a boolean, so control was
  // never affected. The arms would have differed by whether they ran at all.
  //
  // Measured on the same machine that found it, and it is the same defect that
  // made the Mac pre-flight exit 1 with no session.
  //
  // Two independent guards: a NON-VARIADIC option immediately before the prompt,
  // and `--` to end option parsing. `extraArgs` keeps its place ahead of both so
  // a pinned argument can still override `--output-format`.
  const cliArgs = [
    "--print",
    "--session-id",
    sessionId,
    ...mcpArgs,
    ...(manifest.pinned?.extraArgs ?? []),
    "--output-format",
    "json",
    "--",
    task.prompt,
  ];

  // ONE budget, used both to ENFORCE and to JUDGE. Computed twice, the two could
  // drift, and every arm between them would be misclassified in silence.
  const budgetMs = manifest.pinned?.perArmTimeoutMs ?? 45 * 60 * 1000;
  const started = stamp();
  const startedMs = Date.now();
  const result = run(binary.path, cliArgs, { cwd: treeDir, timeout: budgetMs });
  const wallMs = Date.now() - startedMs;
  // A budget overrun is a CENSORED observation carrying the budget as a lower
  // bound, never a silent drop: dropping budget-exhausted control arms removes
  // exactly the evidence that favours the tools.
  // CENSORED IS AN OUTCOME, NOT A FAILURE. The design is explicit: exceeding the
  // budget is a censored observation carrying the budget as a LOWER BOUND, never
  // a silent drop, "because dropping budget-exhausted control arms removes
  // exactly the evidence that favours the tools". Control arms are the ones that
  // run long — no tools, more turns — so invalidating them biases toward a hold.
  //
  // This first shipped treating any null exit as censored AND any spawn error as
  // invalid, which caught the timeout twice and named it "could not be spawned
  // at all". ETIMEDOUT is the budget; ENOENT is a broken run.

  const after = takeSnapshot();
  const originated = after.requestIds.filter((id) => !before.requestIds.includes(id));

  // The acceptance predicate decides whether this is a TASK or an ATTEMPT.
  // Without it the numerator is earned at a verification step and the
  // denominator is croppable by quitting, so every fraction rises by giving up.
  let acceptance = null;
  if (Array.isArray(task.acceptance) && task.acceptance.length > 0) {
    acceptance = task.acceptance.map((cmd) => {
      const parts = Array.isArray(cmd) ? cmd : String(cmd).split(" ");
      const r = run(parts[0], parts.slice(1), { cwd: treeDir, shell: process.platform === "win32" });
      return { command: Array.isArray(cmd) ? cmd.join(" ") : String(cmd), exitCode: r.code };
    });
  }

  const endCommit = git(["rev-parse", "HEAD"], treeDir);

  // AN OBSERVATION THAT RECORDED NOTHING IS NOT AN OBSERVATION, and archiving it
  // as if it were is how a run ends up with a denominator that is not its own.
  // `originated` is the whole unit: no ids means the arm never reached the API,
  // or the snapshot did not cover the slug it wrote to -- and the second is
  // indistinguishable from the first at this layer, which is exactly why both
  // have to be refused rather than one of them assumed.
  //
  // The artifact is still written. Refusing to write would hide the failure from
  // the very record that is supposed to make a run re-adjudicable; what is
  // refused is calling it valid, and the exit code stops a driver.
  const verdict = classifyRun({
    // A fact, not an inference: this is the same `budgetMs` handed to spawnSync.
    budgetEnforced: Number.isFinite(budgetMs) && budgetMs > 0,
    exitCode: result.code,
    signal: result.signal,
    errorCode: result.errorCode,
    budgetMs,
    originatedCount: originated.length,
    slugsBefore: before.slugsWalked,
    slugsAfter: after.slugsWalked,
  });
  const censored = verdict.censored;
  const invalid = verdict.reasons;

  const observation = {
    valid: invalid.length === 0,
    // Which case the run fell into, named. A boolean records that something was
    // wrong; this records what, and it is what a re-adjudication reads.
    outcome: verdict.outcome,
    invalidReasons: invalid,
    ts: stamp(),
    runId: manifest.runId ?? null,
    manifestSha256: manifestSha,
    taskId: task.id,
    arm,
    sessionId,
    started,
    wallClockMs: wallMs,
    censored,
    // What the scorer needs to treat a censored arm as a bound rather than a
    // point: the budget it hit, and the fact that its cost is a floor.
    budgetMs,
    costIsLowerBound: censored,
    cliExitCode: result.code,
    cliSignal: result.signal,
    cliErrorCode: result.errorCode,
    binary,
    ratesSha256: ratesSha,
    baseCommit: task.baseCommit,
    treeHashAtStart: treeHash,
    endCommit,
    promptSha256: promptSha,
    command: [path.basename(binary.path), ...cliArgs.slice(0, -1), "<prompt from manifest>"].join(" "),
    snapshotBefore: { ts: before.ts, slugsWalked: before.slugsWalked, files: before.files, ids: before.requestIds.length },
    snapshotAfter: { ts: after.ts, slugsWalked: after.slugsWalked, files: after.files, ids: after.requestIds.length },
    // The unit of observation, established by DIFFERENCE rather than by any
    // inference about which session originated what — no such inference is
    // sound, because inherited records are rewritten to claim the session they
    // sit in.
    originatedRequestIds: originated,
    acceptance,
    accepted: acceptance === null ? null : acceptance.every((a) => a.exitCode === 0),
    stderrTail: result.err.slice(-2000),
  };

  const dir = path.join(REPO, "evidence", manifest.runId ?? "b12-unnamed", `obs-${task.id}-${arm}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "observation.json"), JSON.stringify(observation, null, 2) + "\n", "utf8");
  writeFileSync(path.join(dir, "snapshot-before.json"), JSON.stringify(before, null, 2) + "\n", "utf8");
  writeFileSync(path.join(dir, "snapshot-after.json"), JSON.stringify(after, null, 2) + "\n", "utf8");
  writeFileSync(path.join(dir, "cli-stdout.json"), result.out, "utf8");

  process.stdout.write(
    `  ${observation.valid ? "ok  " : "INVALID"}  ${task.id}/${arm}  session ${sessionId.slice(0, 8)}  ` +
      `originated ${originated.length} request(s)  accepted ${observation.accepted}  ` +
      `${censored ? "CENSORED  " : ""}${wallMs}ms\n  wrote ${dir}\n`
  );
  if (!args.keep) git(["worktree", "remove", "--force", treeDir]);
  if (!observation.valid) {
    for (const reason of invalid) process.stderr.write(`  INVALID: ${reason}` + String.fromCharCode(10));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "keep") args.keep = true;
      else args[key] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

// Imported by tests for `classifyRun`; only the direct invocation runs a command.
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

const argv = process.argv.slice(2);
const command = argv[0];
const args = parseArgs(argv.slice(1));

if (!invokedDirectly) {
  // nothing to do: this file was imported
} else switch (command) {
  case "preflight":
    preflight(args);
    break;
  case "observe":
    observe(args);
    break;
  case "snapshot": {
    const snap = takeSnapshot(args.root);
    const text = JSON.stringify(snap, null, 2) + "\n";
    if (args.out) writeFileSync(args.out, text, "utf8");
    else process.stdout.write(text);
    process.stdout.write(
      `  ${snap.slugsWalked} slug(s), ${snap.files} file(s), ${snap.requestIds.length} admitted requestId(s)\n`
    );
    break;
  }
  default:
    process.stderr.write(
      "usage: b12-run.mjs <preflight|observe|snapshot> [--manifest f] [--task id] [--arm treatment|control] [--out f] [--root d] [--keep]\n"
    );
    process.exit(2);
}
