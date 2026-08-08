#!/usr/bin/env node
/**
 * B12's harness. Runs observations; decides nothing.
 *
 *   node scripts/b12-run.mjs preflight [--manifest evidence/<run>.b12.tasks.json] [--session <id>]
 *   node scripts/b12-run.mjs observe   --manifest <m> --task <id> [--arm treatment|control]
 *   node scripts/b12-run.mjs snapshot  --out <file>
 *
 * `preflight`'s `--manifest` is OPTIONAL — without one it skips every
 * manifest-dependent check rather than refusing. `--session <id>` is what
 * decides its exit code in practice: without it the fresh-call assertions FAIL,
 * because a preflight that only proves files exist cannot say the join works.
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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  // PER-FILE sha256, because `design.artifacts` 5 asks for it by name: "the
  // requestId set of EVERY transcript file under EVERY project slug ... with the
  // directory count, the file count, the id count and per-file sha256". The
  // snapshot reported the first three and a file COUNT with no list, so a
  // transcript rewritten between the pre- and post-snapshot was invisible —
  // and the frozen text says the vendor rewrites them.
  //
  // Hashed here rather than in a second pass over the same files: the bytes are
  // already in hand, and two loops over one corpus is how a file count and a
  // hash list come to disagree about which files there were.
  const fileHashes = [];
  let records = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    fileHashes.push({ path: file, sha256: sha256Text(text) });
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
  return { ids, records, fileHashes };
}

export function takeSnapshot(rootOverride) {
  const dirs = projectSlugDirs(rootOverride);
  const files = dirs.flatMap((d) => jsonlUnder(d));
  const { ids, records, fileHashes } = admittedRequestIds(files);
  if (dirs.length === 0 || ids.size === 0) {
    refuse(`snapshot covered ${dirs.length} slug(s) and collected ${ids.size} ids — a zero here is a scoping error, not an empty machine`);
  }
  return {
    ts: stamp(),
    slugsWalked: dirs.length,
    slugs: dirs.map((d) => path.basename(d)),
    files: files.length,
    billableRecords: records,
    // Sorted by path so two snapshots of one machine are diffable line for line.
    // `files` above stays the COUNT it always was: it is asserted non-zero, and
    // a length that could silently become the length of a different list is the
    // shape this file already refuses elsewhere.
    fileHashes: fileHashes.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
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

/**
 * The treatment arm's MCP config, or a refusal. NEVER a path that is not there.
 *
 * This defaulted to `path.join(REPO, ".mcp.json")` and **there is no such file
 * in this repository**. `claude --mcp-config <missing>` starts no server, so the
 * treatment arm calls no local tool, writes no telemetry row, and exits nonzero
 * — which `classifyRun` reads as `exited_nonzero`, INVALID. The failure is
 * therefore not silent, but it is misnamed: the arm looks like a broken run
 * rather than like a treatment that was never installed, and "the treatment was
 * on" would be a claim nothing checked.
 *
 * `design.artifacts` 1 makes the manifest carry and hash the MCP configs, so the
 * hash is compared when it is pinned. An unpinned config is allowed to exist —
 * requiring the pin here would refuse manifests the frozen text permits.
 */
function findMcpConfig(manifest) {
  const declared = manifest.pinned?.mcpConfig;
  if (!declared) {
    return {
      mcp: null,
      why:
        "the treatment arm needs manifest.pinned.mcpConfig and none is declared — " +
        "the old default was a repository .mcp.json that does not exist, which starts no server",
    };
  }
  const file = path.isAbsolute(declared) ? declared : path.join(REPO, declared);
  if (!existsSync(file)) return { mcp: null, why: `manifest.pinned.mcpConfig points at ${file}, which does not exist` };
  const got = sha256File(file);
  const want = manifest.pinned?.mcpConfigSha256;
  // REQUIRED, NOT COMPARED-IF-PRESENT. `design.artifacts` 1 makes the manifest
  // carry "the sha256 of ... the MCP configs", so a manifest without one is
  // non-compliant rather than permissive, and comparing only when present makes
  // the check disappear on exactly the manifest that most needs it.
  if (!want) return { mcp: null, why: "manifest.pinned.mcpConfigSha256 is absent — `design.artifacts` 1 requires the manifest to carry it" };
  if (want !== got) return { mcp: null, why: `mcpConfig sha256 ${got} != pinned ${want} — the treatment moved under the run` };
  return { mcp: { path: file, sha256: got }, why: null };
}

// Split like `findClaudeBinary`: `observe` refuses, `preflight` reports, and the
// two callers cannot drift on what "found" means.
function resolveMcpConfig(manifest) {
  const { mcp, why } = findMcpConfig(manifest);
  if (mcp === null) refuse(why);
  return mcp;
}

// ---------------------------------------------------------------------------
// The F24 pass: manifest completeness, the per-arm policy blob, the memory
// snapshot, and the calibrated installation term. Each resolution follows the
// `findClaudeBinary` split — `find*` REPORTS for the preflight, `resolve*`
// REFUSES for `observe` — and the pure parts are exported, the `classifyRun`
// precedent: testable without spending a session.
// ---------------------------------------------------------------------------

/**
 * Every declaration `design.artifacts` 1 requires of the manifest that is
 * missing. FIRST shipped checking only three task fields; the adversarial
 * review of this pass found the omission decides real outcomes — a task
 * without an acceptance predicate proceeded and archived `accepted: null`
 * while remaining `valid`, unscorable under `admissionRule` 3 after the
 * session was already spent. So this is the FULL sweep of the clause's
 * inventory now, one flat list, each gap citing the frozen text that requires
 * it. Fields other guards already own (mcpConfig, policy blobs, memory
 * snapshot) are left to their resolvers, whose messages are richer.
 *
 * Two justification classes, never fused:
 * - `verificationStratum` — F25's route, verbatim: "the harness's preflight can
 *   refuse a manifest in which any task declares no `verificationStratum`".
 * - Everything else — `design.artifacts` 1 completeness, the same refusal
 *   shape extended BY ANALOGY, and not claimed as F25's.
 * The property names are this harness's schema; the CONTENT requirements are
 * the frozen inventory's.
 *
 * TIMING IS SUBSTANTIVE. The no-minted-disposition argument for a hard exit
 * holds only BEFORE registration: `admissionRule` 1 attaches "from registration
 * onward", after which the run owes a committed result artifact naming its
 * disposition. These refusals are designed for the pre-registration window (the
 * preflight, and the first `observe` of a manifest that was never registered);
 * hitting one on an already-registered run stops the harness but does NOT erase
 * the owed `result.json` — that debt is the operator's, not this exit code's.
 */
export function manifestDeclarationGaps(manifest) {
  const gaps = [];
  const str = (v) => typeof v === "string" && v.length > 0;
  const need = (cond, msg) => {
    if (!cond) gaps.push(msg);
  };
  const pinned = manifest?.pinned ?? {};

  // Run-level, artifact 1: "the pinned Claude Code version and binary sha256;
  // the measured clientTruncationCap for that version; ... the pacing ceiling
  // and the per-task denominator share cap; the scoring command string; and the
  // sha256 of scripts/b12-run.mjs, rates.json, the in-repo CLAUDE.md, ... the
  // settings files ..." — plus "the named A/B pairs".
  need(str(pinned.claudeCodeVersion), 'pinned.claudeCodeVersion is absent (artifact 1: "the pinned Claude Code version"; voidConditions 7)');
  need(str(pinned.claudeBinarySha256), 'pinned.claudeBinarySha256 is absent (artifact 1: "binary sha256"; voidConditions 7)');
  need(str(pinned.ratesSha256), 'pinned.ratesSha256 is absent (artifact 1; voidConditions 4 asserts rates.json byte-identical to 3541625)');
  need(
    Number.isFinite(pinned.clientTruncationCap) && pinned.clientTruncationCap > 0,
    "pinned.clientTruncationCap is absent or not a positive number (voidConditions 8: VOID if no cap was measured for the version that ran)"
  );
  need(
    Number.isFinite(pinned.pacingCacheWriteShareCeiling),
    "pinned.pacingCacheWriteShareCeiling is absent (voidConditions 20; thresholdArgument names it one of the two CHOSEN constants, committed before any observation)"
  );
  need(
    Number.isFinite(pinned.perTaskDenominatorShareCap),
    "pinned.perTaskDenominatorShareCap is absent (thresholdArgument: the other CHOSEN constant, committed before any observation)"
  );
  need(str(pinned.scoringCommand), 'pinned.scoringCommand is absent (voidConditions 19: "the one string committed at pre-registration")');
  need(str(pinned.b12RunSha256), 'pinned.b12RunSha256 is absent (artifact 1: "the sha256 of scripts/b12-run.mjs")');
  need(str(pinned.claudeMdSha256), 'pinned.claudeMdSha256 is absent (artifact 1: the in-repo CLAUDE.md is hashed with the manifest)');
  need(
    pinned.settingsSha256s !== null &&
      typeof pinned.settingsSha256s === "object" &&
      "settings" in (pinned.settingsSha256s ?? {}) &&
      "settingsLocal" in (pinned.settingsSha256s ?? {}),
    'pinned.settingsSha256s must declare both keys, settings and settingsLocal (artifact 1: "the settings files"; null values declare an absence, omission declares nothing)'
  );
  need(str(pinned.installedCharsProbe), "pinned.installedCharsProbe is absent (PREMISES.md § B12: a value with no provenance is refused)");
  need(
    str(pinned.installedCharsProbeSha256),
    "pinned.installedCharsProbeSha256 is absent — required, not compared-if-present: a self-asserted probe file is not provenance"
  );
  // The pair list is VALIDATED, not merely present — a fourth adversarial
  // round found `Array.isArray` letting an empty or malformed list through.
  // Fewer than 3 pairs can never validate (`voidConditions` 21: "fewer than 3
  // complete pairs remain" is a VOID), so a shorter declaration is refused at
  // the manifest. The pair SCHEMA (id, taskId, order) is this harness's; the
  // required content is artifact 1's "the named A/B pairs and their exact
  // count with ABBA order". Both arm orders must occur — the necessary
  // condition of ANY reading of "ABBA" — while the exact sequence pattern is
  // left to the A/B pass, whose sequencing is blocked with `voidConditions`
  // 21's instruction-set-hash adjudication (FINDINGS.md F24).
  const pairs = manifest?.abPairs;
  if (!Array.isArray(pairs) || pairs.length < 3) {
    need(
      false,
      'manifest.abPairs must name at least 3 pairs (artifact 1: "the named A/B pairs and their exact count with ABBA order"; voidConditions 21 voids an A/B with fewer than 3 complete pairs, so a shorter list can never validate)'
    );
  } else {
    const pairIds = new Set();
    const orders = new Set();
    const taskIds = new Set((manifest?.tasks ?? []).map((t) => t?.id));
    pairs.forEach((p, i) => {
      if (!str(p?.id)) need(false, `abPairs[${i}] carries no id`);
      else if (pairIds.has(p.id)) need(false, `abPairs[${i}] duplicates pair id ${p.id}`);
      else pairIds.add(p.id);
      if (!taskIds.has(p?.taskId)) need(false, `abPairs[${i}] names task ${String(p?.taskId)}, which is not in the manifest`);
      if (p?.order !== "treatment-first" && p?.order !== "control-first") {
        need(false, `abPairs[${i}] declares no arm order (order: treatment-first | control-first is the schema for artifact 1's "ABBA order")`);
      } else {
        orders.add(p.order);
      }
    });
    if (orders.size === 1) {
      need(
        false,
        'abPairs declares only one arm order — any reading of "ABBA order" is counterbalanced, so both orders must occur; the exact sequence is the A/B pass\'s adjudication'
      );
    }
  }

  for (const t of manifest?.tasks ?? []) {
    const id = t?.id ?? "(unnamed task)";
    const tneed = (cond, msg) => {
      if (!cond) gaps.push(`task ${id} ${msg}`);
    };
    tneed(str(t?.id), "carries no id");
    tneed(str(t?.prompt), 'carries no prompt (artifact 1: "the prompt text")');
    tneed(str(t?.promptSha256), 'carries no promptSha256 (design.artifacts 1: "the prompt text and its sha256"; required, not compared-if-present)');
    tneed(str(t?.baseCommit), 'declares no baseCommit (artifact 1: "the base commit SHA"; voidConditions 11)');
    tneed(str(t?.verificationStratum), "declares no verificationStratum (F25's pre-registration refusal route)");
    tneed(str(t?.expectedSubagentStratum), "declares no expectedSubagentStratum (design.artifacts 1 completeness, by analogy with F25's shape)");
    tneed(
      Array.isArray(t?.acceptance) && t.acceptance.length > 0,
      "declares no acceptance predicate (admissionRule 3: the predicate is what separates a TASK from an ATTEMPT; archived with accepted: null it cannot be scored, after the session was already spent)"
    );
    tneed(
      Number.isInteger(t?.acceptanceExpectedExit),
      'declares no acceptanceExpectedExit (artifact 1: "the acceptance predicate and expected exit code")'
    );
    tneed(
      Array.isArray(t?.verificationCommands) && t.verificationCommands.length > 0,
      'declares no verificationCommands (artifact 1: "the exact verification command string(s)"; voidConditions 4 freezes them)'
    );
    tneed(str(t?.gateCategory), 'declares no gateCategory (artifact 1: "the frozen gate `category`"; voidConditions 4)');
    tneed(Number.isFinite(t?.repairMaxRounds), "declares no repairMaxRounds (artifact 1: \"repair's frozen max_rounds\"; voidConditions 4)");
    tneed(
      Array.isArray(t?.fileScope),
      'declares no fileScope (artifact 1: "the file scope"; admissionRule 7\'s intersection check is vacuous over an undeclared scope)'
    );
  }
  return gaps;
}

/**
 * Whether running `taskId`'s TREATMENT arm now would break the manifest's
 * committed order, judged against the persisted runlog. `voidConditions` 3
 * voids a run whose "committed order was not followed", and `admissionRule` 2
 * fixes "the first 20 that admit, IN THAT COMMITTED ORDER" — the runlog is the
 * progress record that makes the condition checkable BEFORE a session is
 * spent rather than only at scoring. TREATMENT ONLY: the primary instrument
 * runs in committed order, while control arms belong to the post-verdict A/B
 * (`admissionRule` 13, `runPlan` PHASE 7), whose pair sequencing is blocked
 * with `voidConditions` 21's adjudication. A DUPLICATE task is not refused
 * here — `admissionRule` 12 allows one discretionary re-run plus
 * version-drift re-runs, adjudicated at scoring over this same runlog.
 */
export function committedOrderViolation(manifest, taskId, runlogText) {
  const tasks = manifest?.tasks ?? [];
  const currentIndex = tasks.findIndex((t) => t?.id === taskId);
  for (const line of (runlogText ?? "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return `the runlog carries a line that is not JSON — the persisted progress is corrupt: ${line.slice(0, 80)}`;
    }
    if (row.arm !== "treatment") continue;
    const idx = tasks.findIndex((t) => t?.id === row.taskId);
    if (idx > currentIndex) {
      return `task ${taskId} (index ${currentIndex}) would run after ${row.taskId} (index ${idx}) already ran — the manifest's committed order was not followed (voidConditions 3)`;
    }
  }
  return null;
}

/**
 * Every pre/post instruction component compared, not only the two with their
 * own named VOIDs — a fourth adversarial round found the drift RECORDED but
 * not invalidating. CLAUDE.md movement is `voidConditions` 12's first clause
 * and memory is 13. Settings, settings.local and the passed MCP config are
 * what clause 12 compares ACROSS A PAIR — and an arm that carries two
 * different values for one of them has no well-defined hash for that
 * comparison, so invalidating makes the frozen predicate EVALUABLE (the
 * end-commit fix's own argument, not a new rule). A policy blob that moved
 * mid-arm breaks clause 12's one-hash-per-record requirement and the
 * `installedChars` calibration key with it. Null-to-hash transitions compare
 * like any other difference.
 */
export function instructionDriftReasons(pre, post) {
  const cites = {
    claudeMd: "voidConditions 12: the in-repo CLAUDE.md blob hash moved between arm start and end",
    memory: "voidConditions 13: the session wrote to the memory directory",
    settings: "voidConditions 12's pair comparison is ill-defined over an arm carrying two settings hashes",
    settingsLocal: "voidConditions 12's pair comparison is ill-defined over an arm carrying two settings.local hashes",
    mcpConfigPassed: "voidConditions 12's pair comparison is ill-defined over an arm whose passed MCP config moved mid-session",
    policyBlob: "voidConditions 12 requires ONE per-arm policy blob hash on the record — a blob that moved mid-arm breaks it and the installedChars calibration key",
  };
  const reasons = [];
  for (const key of Object.keys(cites)) {
    if ((pre?.[key] ?? null) !== (post?.[key] ?? null)) {
      reasons.push(`instruction drift: ${key} ${String(pre?.[key] ?? null)} -> ${String(post?.[key] ?? null)} — ${cites[key]}`);
    }
  }
  return reasons;
}

/**
 * The probe artifact must be COMMITTED EVIDENCE, not a working-tree file. The
 * adversarial review of this pass found the boundary open: with the path
 * unconstrained and the sha compared only if pinned, a fabricated local JSON
 * with `sustained: true` and copied hashes could reach `observation.json` as a
 * legitimate-looking calibration record. Closing it mints nothing — the
 * pre-declaration's "a value with no provenance is refused" is the licence, and
 * committedness IS the provenance model this repository already uses
 * (`git log` proving order, the commit barrier comparing blobs against HEAD).
 * Fabrication now requires committing the fabrication, which the append-only
 * history records.
 */
export function committedEvidenceCheck(declaredPath) {
  if (typeof declaredPath !== "string" || declaredPath.length === 0) {
    return { ok: false, file: null, why: "no probe path declared" };
  }
  if (path.isAbsolute(declaredPath)) {
    return { ok: false, file: null, why: `the probe path must be repo-relative under evidence/, got the absolute path ${declaredPath}` };
  }
  const norm = declaredPath.split(path.sep).join("/");
  if (!norm.startsWith("evidence/")) {
    return { ok: false, file: null, why: `the probe must live under evidence/ — the append-only inventory — got ${norm}` };
  }
  const file = path.join(REPO, norm);
  if (!existsSync(file)) return { ok: false, file: null, why: `${norm} does not exist on disk` };
  const inHead = run("git", ["-C", REPO, "rev-parse", `HEAD:${norm}`]);
  if (inHead.code !== 0) {
    return { ok: false, file: null, why: `HEAD does not carry ${norm} — the probe must be committed evidence, not a working-tree file` };
  }
  const onDisk = run("git", ["-C", REPO, "hash-object", "--", file]);
  if (onDisk.code !== 0) return { ok: false, file: null, why: `git hash-object failed on ${norm}: ${onDisk.err.trim()}` };
  if (inHead.out.trim() !== onDisk.out.trim()) {
    return {
      ok: false,
      file: null,
      why: `${norm} on disk differs from HEAD's blob (${onDisk.out.trim().slice(0, 12)} != ${inHead.out.trim().slice(0, 12)}) — a calibration value may not come from locally edited evidence`,
    };
  }
  return { ok: true, file, why: null };
}

/**
 * The per-arm policy blob, or why not. `operatorConfound` CHANNEL 5's resolution:
 * "the policy is delivered per arm through `--append-system-prompt` from a
 * committed out-of-repo blob whose sha256 is recorded per arm" — and
 * `voidConditions` 12 makes that hash's ABSENCE from any observation record a
 * VOID, so a manifest with no blobs cannot produce a compliant observation and
 * is refused before anything is spent. BOTH arms must be declared even though
 * one is resolved: a pair whose other arm cannot run was never a pair.
 *
 * The property names (`policyBlobs`, `policyBlobSha256s`) are THIS HARNESS'S
 * schema, not frozen text. What the frozen text fixes is the content: the
 * manifest carries "the sha256 of ... the out-of-repo per-arm policy blobs"
 * (`design.artifacts` 1), so the hashes are REQUIRED, not compared-if-present —
 * the `mcpConfigSha256` shape.
 */
function findPolicyBlob(manifest, arm) {
  const blobs = manifest.pinned?.policyBlobs;
  if (!blobs || typeof blobs.treatment !== "string" || typeof blobs.control !== "string") {
    return {
      blob: null,
      why:
        "manifest.pinned.policyBlobs must declare BOTH arms' out-of-repo policy blobs — " +
        "voidConditions 12 voids any observation record without its arm's blob hash, " +
        "so a manifest without blobs cannot produce a compliant observation",
    };
  }
  const shas = manifest.pinned?.policyBlobSha256s;
  if (!shas || typeof shas.treatment !== "string" || typeof shas.control !== "string") {
    return {
      blob: null,
      why:
        "manifest.pinned.policyBlobSha256s must carry BOTH arms' hashes — " +
        'design.artifacts 1: "the sha256 of ... the out-of-repo per-arm policy blobs"; required, not compared-if-present',
    };
  }
  const declared = blobs[arm];
  const file = path.isAbsolute(declared) ? declared : path.join(REPO, declared);
  if (!existsSync(file)) return { blob: null, why: `policy blob for ${arm} points at ${file}, which does not exist` };
  const content = readFileSync(file, "utf8");
  const got = sha256File(file);
  if (got !== shas[arm]) {
    return { blob: null, why: `policy blob (${arm}) sha256 ${got} != pinned ${shas[arm]} — the policy moved under the run` };
  }
  return { blob: { path: file, declaredPath: declared, sha256: got, content }, why: null };
}

function resolvePolicyBlob(manifest, arm) {
  const { blob, why } = findPolicyBlob(manifest, arm);
  if (blob === null) refuse(why);
  return blob;
}

/**
 * Directory hash for the memory snapshot: sha256 over sorted
 * (relative path, content sha256) pairs, separators normalised to "/" so the
 * machine that sealed the snapshot and the machine that restores it compute the
 * same hash. A missing or empty directory hashes as the empty list with
 * `files: 0` — absent is a fact, not an error, because the restore target does
 * not exist yet for a fresh worktree slug.
 */
export function hashMemoryDir(dir) {
  const entries = [];
  const walk = (d) => {
    let names;
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else entries.push({ rel: path.relative(dir, p).split(path.sep).join("/"), sha256: sha256File(p) });
    }
  };
  walk(dir);
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = createHash("sha256");
  for (const e of entries) h.update(`${e.rel}\n${e.sha256}\n`);
  return { sha256: h.digest("hex"), files: entries.length };
}

/**
 * The committed memory snapshot, or why not. `design.artifacts` 10 says the
 * harness "restores the memory snapshot" and `voidConditions` 13 voids a session
 * whose directory "was not restored from the committed snapshot before a
 * session" — so a manifest without one cannot produce a compliant observation.
 * `design.artifacts` 1 lists "the memory snapshot" in the manifest's hashed
 * inventory, so the hash is REQUIRED; the property names are harness schema.
 */
function findMemorySnapshot(manifest) {
  const declared = manifest.pinned?.memorySnapshot;
  if (!declared) {
    return {
      snapshot: null,
      why:
        "manifest.pinned.memorySnapshot is required — voidConditions 13 voids a session whose memory " +
        "directory was not restored from the committed snapshot, so a manifest without one cannot " +
        "produce a compliant observation",
    };
  }
  const dir = path.isAbsolute(declared) ? declared : path.join(REPO, declared);
  if (!existsSync(dir)) return { snapshot: null, why: `manifest.pinned.memorySnapshot points at ${dir}, which does not exist` };
  const want = manifest.pinned?.memorySnapshotSha256;
  if (!want) {
    return {
      snapshot: null,
      why: 'manifest.pinned.memorySnapshotSha256 is absent — design.artifacts 1 lists "the memory snapshot" in the hashed inventory; required, not compared-if-present',
    };
  }
  const got = hashMemoryDir(dir);
  if (got.sha256 !== want) {
    return { snapshot: null, why: `memory snapshot hash ${got.sha256} != pinned ${want} — the committed snapshot moved` };
  }
  return { snapshot: { dir, declaredPath: declared, sha256: want, files: got.files }, why: null };
}

function resolveMemorySnapshot(manifest) {
  const { snapshot, why } = findMemorySnapshot(manifest);
  if (snapshot === null) refuse(why);
  return snapshot;
}

/**
 * `~/.claude/projects/<slug>` for a working directory, by the observed rule:
 * every byte that is not [A-Za-z0-9] becomes "-". The same rule the probe's
 * environment hash used, checked against what Claude Code writes on this
 * machine.
 */
function projectSlugDirFor(cwd) {
  return path.join(os.homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

/**
 * Restore is DESTRUCTIVE on the target by design: the slug belongs to the
 * observation's own throwaway worktree, and `voidConditions` 13 wants the
 * directory to BE the committed snapshot, not to contain it plus leftovers.
 * Returns the post-restore hash; the caller asserts it equals the pin.
 */
function restoreMemory(snapshotDir, memoryDir) {
  rmSync(memoryDir, { recursive: true, force: true });
  mkdirSync(memoryDir, { recursive: true });
  cpSync(snapshotDir, memoryDir, { recursive: true });
  return hashMemoryDir(memoryDir);
}

/**
 * The calibrated installation term, validated against the LIVE observation.
 * PURE, throws with the failing component named; exported so the negative
 * controls can fire without a session.
 *
 * `PREMISES.md § B12` fixed all of this BEFORE the probe ran: ONE `O_o`; the
 * statistic is the paired first-request TOTAL prompt-token delta on the pinned
 * binary; `installedChars := tokens × 3.7`, an adapter, so the frozen divisor
 * cancels; the calibration key is binary sha256 × arm × MCP-config hash ×
 * policy-blob hash × protocol; "Any component moves, the value is re-taken";
 * "a value with no provenance is refused". So a mismatch on ANY component
 * throws rather than degrades — including the null-blob case: the committed
 * probe ran before any policy blob was sealed (`policyBlobSha256: null`), so a
 * manifest that declares blobs is refused until a re-probe under those blobs
 * exists. The refusal is what keeps the re-take rule from being forgotten.
 *
 * ONLY THE TREATMENT ARM CARRIES A VALUE. The probe measured ONE delta
 * (treatment − control); the control arm is the baseline INSIDE that
 * subtraction, not the owner of a second value. Writing a control
 * `installedChars` — even 0 — would be the two-valued `O` the ONE-`O_o`
 * boundary refuses, and "the control arm never enters the primary verdict"
 * (`admissionRule` 13).
 */
export function validateInstalledCharsProbe(probe, live) {
  const fail = (why) => {
    throw new Error(why);
  };
  if (probe === null || typeof probe !== "object") fail("the probe artifact is not an object");
  if (typeof probe.runId !== "string" || probe.runId.length === 0) fail("the probe artifact carries no runId — a value with no provenance is refused");

  // THE SUMMARY IS NOT TRUSTED — IT IS RECOMPUTED. A third adversarial round
  // found the validator reading only the artifact's own claims (`sustained`,
  // `deltaTokens`), which made "committed" carry the whole burden: a committed
  // JSON with matching hashes and a fabricated delta would have calibrated
  // every treatment observation. Committing proves storage provenance, not
  // that the registered protocol produced the value. So every derived number
  // is recomputed here from the replicate records the artifact carries, and
  // any disagreement between a copy and its recomputation refuses — the same
  // doctrine as the adapter check below, applied to the whole chain.
  //
  // The honest boundary, stated rather than papered over: the artifact cannot
  // prove the sessions RAN — the transcripts do not travel in it. That burden
  // stays with committedness plus the VERBATIM raw first records archived per
  // arm, which a reader holding the transcripts can re-verify. What the
  // artifact does carry, this function refuses to take on faith.

  // The protocol component of the calibration key: named, never defaulted.
  // The old fallback labelled MISSING provenance as the registered protocol.
  if (typeof probe.preDeclaration !== "string" || !probe.preDeclaration.includes("PREMISES.md § B12")) {
    fail(
      `the probe names no registered protocol (preDeclaration: ${JSON.stringify(probe.preDeclaration ?? null)}) — ` +
        "it must reference PREMISES.md § B12; a fallback label would mark missing provenance as valid"
    );
  }
  const ctx = probe.context ?? {};
  if (typeof ctx.prompt !== "string" || ctx.prompt.length === 0) {
    fail("the probe records no session prompt — the protocol fixes one prompt, identical across arms");
  }
  const shape = ctx.argvShape ?? {};
  // "--strict-mcp-config" does not contain the substring "--mcp-config", so
  // these three includes-checks pin the registered shape: both arms strict,
  // the server config on the treatment arm only.
  if (typeof shape.treatment !== "string" || !shape.treatment.includes("--strict-mcp-config") || !shape.treatment.includes("--mcp-config")) {
    fail("the probe's treatment argv shape does not match the registered protocol (both arms strict; --mcp-config on treatment)");
  }
  if (typeof shape.control !== "string" || !shape.control.includes("--strict-mcp-config") || shape.control.includes("--mcp-config")) {
    fail("the probe's control argv shape does not match the registered protocol (strict, and NO --mcp-config)");
  }

  // k = 3 is the pre-declared CHOSEN constant; the tolerance-zero rule is the
  // sustained recomputation below.
  const reps = probe.replicates;
  if (!Array.isArray(reps)) fail("the probe carries no replicate records — the summary cannot be re-verified against nothing");
  if (reps.length !== 3) fail(`the registered protocol's k is 3 (a CHOSEN constant, labelled in the pre-declaration); the artifact carries ${reps.length} replicate(s)`);
  const sessionIds = [];
  const deltas = [];
  reps.forEach((rep, i) => {
    const n = i + 1;
    for (const armName of ["treatment", "control"]) {
      const a = rep?.[armName];
      if (!a || typeof a !== "object") fail(`replicate ${n} lacks a ${armName} record`);
      const f = a.first ?? {};
      for (const k of ["input", "cacheCreation", "cacheRead"]) {
        if (!Number.isFinite(f[k])) fail(`replicate ${n} ${armName} first.${k} is ${String(f[k])} — not a finite number`);
      }
      // The cache-invariant total the second postscript registered: every
      // prompt token lands in exactly one of the three classes.
      const recomputedPrompt = f.input + f.cacheCreation + f.cacheRead;
      if (recomputedPrompt !== a.promptTokens) {
        fail(`replicate ${n} ${armName} promptTokens ${String(a.promptTokens)} != recomputed input+cacheCreation+cacheRead ${recomputedPrompt} — the artifact's own copies disagree`);
      }
      if (typeof a.sessionId !== "string" || a.sessionId.length === 0) fail(`replicate ${n} ${armName} carries no sessionId`);
      sessionIds.push(a.sessionId);
      // The verbatim raw record is the artifact's own evidence for the
      // extraction — so the extraction is checked against it.
      let raw = null;
      try {
        raw = JSON.parse(a.firstRecordRaw);
      } catch {
        fail(`replicate ${n} ${armName} firstRecordRaw is not JSON — the raw evidence is unreadable`);
      }
      if (raw.type !== "assistant" || raw.isApiErrorMessage === true) {
        fail(`replicate ${n} ${armName} firstRecordRaw is not an admissible assistant record`);
      }
      if (raw.requestId !== f.requestId) fail(`replicate ${n} ${armName} firstRecordRaw requestId ${String(raw.requestId)} != first.requestId ${String(f.requestId)}`);
      if (raw.sessionId !== a.sessionId) fail(`replicate ${n} ${armName} firstRecordRaw sessionId ${String(raw.sessionId)} != the record's ${a.sessionId}`);
      const u = raw.message?.usage ?? {};
      if ((u.input_tokens ?? 0) !== f.input || (u.cache_creation_input_tokens ?? 0) !== f.cacheCreation || (u.cache_read_input_tokens ?? 0) !== f.cacheRead) {
        fail(
          `replicate ${n} ${armName} firstRecordRaw usage (${u.input_tokens}/${u.cache_creation_input_tokens}/${u.cache_read_input_tokens}) ` +
            `disagrees with the extracted first (${f.input}/${f.cacheCreation}/${f.cacheRead})`
        );
      }
    }
    if (rep.treatment.first?.model !== rep.control.first?.model) {
      fail(`replicate ${n} arms ran different models (${String(rep.treatment.first?.model)} vs ${String(rep.control.first?.model)}) — the pairing is the protocol`);
    }
    const d = rep.treatment.promptTokens - rep.control.promptTokens;
    if (rep.deltaTokens !== d) fail(`replicate ${n} deltaTokens ${String(rep.deltaTokens)} != recomputed treatment−control ${d}`);
    deltas.push(d);
  });
  if (new Set(sessionIds).size !== 6) {
    fail("the six replicate sessions do not carry six distinct session ids — fresh sessions are the protocol, and a reused id is a resumed session");
  }
  if (deltas.some((d) => d < 0)) {
    fail(`recomputed deltas ${JSON.stringify(deltas)} include a negative — outside the pre-declared domain (treatment minus control; a negative says the arms are reversed or the measurement is wrong)`);
  }
  if (!Array.isArray(probe.deltasTokens) || probe.deltasTokens.length !== 3 || probe.deltasTokens.some((v, i) => v !== deltas[i])) {
    fail(`deltasTokens ${JSON.stringify(probe.deltasTokens ?? null)} != recomputed ${JSON.stringify(deltas)} — the summary and the records disagree`);
  }
  const recomputedSustained = deltas.every((d) => Number.isFinite(d) && d === deltas[0]) && deltas[0] >= 0;
  if (probe.sustained !== recomputedSustained) {
    fail(`sustained is claimed ${String(probe.sustained)} but the replicate records recompute ${recomputedSustained} — the claim is not the measurement`);
  }
  if (probe.sustained !== true) fail(`the probe did not sustain (sustained: ${String(probe.sustained)}) — the pre-declared branch for an unsustained probe is retract-and-re-register, not reuse`);
  const delta = probe.deltaTokens;
  if (typeof delta !== "number" || !Number.isFinite(delta)) fail(`deltaTokens is ${String(delta)} — absent or non-finite`);
  if (delta !== deltas[0]) fail(`deltaTokens ${delta} != the recomputed replicate delta ${deltas[0]}`);
  // Two copies that are never compared is how the meter and the oracle drifted
  // apart four times, so the adapter is recomputed and must agree byte for byte.
  const recomputed = Math.round(delta * 3.7 * 10) / 10;
  if (recomputed !== probe.installedCharsAdapter) {
    fail(`adapter disagrees: recomputed ${recomputed} != artifact's installedCharsAdapter ${String(probe.installedCharsAdapter)}`);
  }
  if (ctx.claudeBinarySha256 !== live.binarySha256) {
    fail(`calibration key moved: probe binary sha256 ${String(ctx.claudeBinarySha256)} != live ${live.binarySha256} — the value is re-taken, never reused across binaries`);
  }
  if ((ctx.mcpConfigSha256 ?? null) !== (live.mcpConfigSha256 ?? null)) {
    fail(`calibration key moved: probe MCP-config sha256 ${String(ctx.mcpConfigSha256 ?? null)} != live ${String(live.mcpConfigSha256 ?? null)}`);
  }
  if ((ctx.policyBlobSha256 ?? null) !== (live.policyBlobSha256 ?? null)) {
    fail(
      `calibration key moved: probe policy-blob sha256 ${String(ctx.policyBlobSha256 ?? null)} != live ${String(live.policyBlobSha256 ?? null)} — ` +
        "the committed probe pre-dates any sealed blob, so sealed blobs demand a re-probe"
    );
  }
  const probeExtra = JSON.stringify(ctx.extraArgs ?? []);
  const liveExtra = JSON.stringify(live.extraArgs ?? []);
  if (probeExtra !== liveExtra) {
    fail(`calibration key moved: probe extraArgs ${probeExtra} != manifest's ${liveExtra} — the artifact's own note names pinned extraArgs as a re-take trigger`);
  }
  return {
    value: recomputed,
    unit: "chars",
    adapter: "tokens × 3.7 — an adapter, so the frozen divisor cancels; not a re-derivation of charsPerToken",
    deltaTokens: delta,
    probeRunId: probe.runId,
    calibrationKey: {
      binarySha256: ctx.claudeBinarySha256,
      mcpConfigSha256: ctx.mcpConfigSha256 ?? null,
      policyBlobSha256: ctx.policyBlobSha256 ?? null,
      extraArgs: ctx.extraArgs ?? [],
      // Never defaulted — validated above; a fallback here would label missing
      // provenance as the registered protocol.
      protocol: probe.preDeclaration,
    },
  };
}

function findInstalledChars(manifest, binary, mcp, treatmentBlob) {
  const declared = manifest.pinned?.installedCharsProbe;
  if (!declared) {
    return {
      record: null,
      why:
        "manifest.pinned.installedCharsProbe is required for the treatment arm — " +
        'PREMISES.md § B12: "a value with no provenance is refused", and holdsIf 6 wants the term computed for every observation',
    };
  }
  // Committed evidence or nothing — see `committedEvidenceCheck`. This closed
  // the review's finding that a fabricated working-tree JSON could calibrate
  // O_o for every treatment observation.
  const committed = committedEvidenceCheck(declared);
  if (!committed.ok) return { record: null, why: committed.why };
  const file = committed.file;
  const sha = sha256File(file);
  // REQUIRED, NOT COMPARED-IF-PRESENT — flipped by the same review, the
  // `mcpConfigSha256` shape: a probe the manifest does not hash is a probe the
  // manifest does not seal.
  const want = manifest.pinned?.installedCharsProbeSha256;
  if (!want) return { record: null, why: "manifest.pinned.installedCharsProbeSha256 is absent — required, not compared-if-present" };
  if (want !== sha) return { record: null, why: `probe artifact sha256 ${sha} != pinned ${want}` };
  if (mcp === null) return { record: null, why: "cannot validate the probe's calibration key without a resolved treatment MCP config" };
  if (treatmentBlob === null) return { record: null, why: "cannot validate the probe's calibration key without a resolved treatment policy blob" };
  let probe;
  try {
    probe = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { record: null, why: `installedCharsProbe at ${file} is not JSON` };
  }
  try {
    const record = validateInstalledCharsProbe(probe, {
      binarySha256: binary.sha256,
      mcpConfigSha256: mcp.sha256,
      policyBlobSha256: treatmentBlob.sha256,
      extraArgs: manifest.pinned?.extraArgs ?? [],
    });
    return { record: { ...record, probeArtifact: declared, probeArtifactSha256: sha }, why: null };
  } catch (error) {
    return { record: null, why: `installedChars is not usable: ${error.message}` };
  }
}

function resolveInstalledChars(manifest, binary, mcp, treatmentBlob) {
  const { record, why } = findInstalledChars(manifest, binary, mcp, treatmentBlob);
  if (record === null) refuse(why);
  return record;
}

/**
 * The compiled capture, or a refusal. `src/cost/b12/capture.js` under `dist/`.
 *
 * IMPORTING `dist/` IS A REVERSAL AND THE REASON IS WRITTEN HERE. This file
 * carries its own copy of B20's admission rule on the stated premise that it
 * "must run before `dist/` exists" — true of `snapshot`, and false of `observe`:
 * the preflight already fails without `dist/cost/cli.js`, and the treatment
 * arm's MCP server IS `dist/`, so an observation cannot run without a build. A
 * third implementation of the lineage rule to avoid an import that is already
 * mandatory would be the drift this file spends a paragraph warning about.
 */
async function loadCapture(manifest) {
  const file = path.join(REPO, "dist", "cost", "b12", "capture.js");
  const source = path.join(REPO, "src", "cost", "b12", "capture.ts");
  if (!existsSync(file)) refuse(`the capture is not built: ${file} — run \`npm run build\` before observing`);
  const sha256 = sha256File(file);
  const want = manifest.pinned?.captureSha256;
  if (want && want !== sha256) refuse(`dist capture sha256 ${sha256} != pinned ${want}`);
  // **A HOLE THE FROZEN TEXT DOES NOT CLOSE, RECORDED RATHER THAN PAPERED OVER.**
  // `voidConditions` 5 freezes `src/cost/**` and `scripts/b12-run.mjs`. It does
  // NOT name `dist/**`, and `design.artifacts` 1's manifest inventory does not
  // list it either — so a HAND-EDITED `dist/cost/b12/capture.js` could fabricate
  // or omit archive evidence while every frozen source stayed byte-identical.
  // That defeats the reason the capture was put under `src/cost/b12/`.
  //
  // Requiring the pin would MINT: artifact 1 enumerates what the manifest
  // carries and this is not among them. So both hashes are RECORDED on every
  // observation and the pin is compared when a manifest chooses to carry one —
  // the same shape `assertRatesFrozen` already uses. A reader can then check the
  // compiled file against the source it claims to be; nothing here can.
  return { module: await import(pathToFileURL(file).href), sha256, sourceSha256: sha256File(source) };
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

    // THE F24 PASS'S PRE-REGISTRATION CHECKS, reported rather than refused —
    // this is the window in which F25's route is licensed: "before any run is
    // registered, before clause 1 binds, and while nothing has been spent."
    const gaps = manifestDeclarationGaps(manifest);
    check(
      "manifest declarations are complete (design.artifacts 1 inventory)",
      gaps.length === 0,
      gaps.length === 0 ? `${manifest.tasks.length} task(s)` : `${gaps.length} gap(s); first: ${gaps[0]}`
    );

    const selfSha = sha256File(fileURLToPath(import.meta.url));
    check(
      "this harness is the one the manifest sealed",
      manifest.pinned?.b12RunSha256 === selfSha,
      manifest.pinned?.b12RunSha256 === selfSha ? selfSha.slice(0, 12) : `running ${selfSha.slice(0, 12)}, pinned ${String(manifest.pinned?.b12RunSha256).slice(0, 12)}`
    );

    const { mcp, why: mcpWhy } = findMcpConfig(manifest);
    check("treatment MCP config resolves against its pin", mcp !== null, mcp !== null ? mcp.sha256.slice(0, 12) : mcpWhy);

    const blobs = { treatment: null, control: null };
    for (const arm of ["treatment", "control"]) {
      const { blob, why } = findPolicyBlob(manifest, arm);
      blobs[arm] = blob;
      check(`policy blob resolves against its pin (${arm})`, blob !== null, blob !== null ? blob.sha256.slice(0, 12) : why);
    }

    const { snapshot: memSnap, why: memWhy } = findMemorySnapshot(manifest);
    check(
      "memory snapshot resolves against its pin",
      memSnap !== null,
      memSnap !== null ? `${memSnap.files} file(s) ${memSnap.sha256.slice(0, 12)}` : memWhy
    );

    if (binary === null) {
      check("installedChars probe calibrates to this machine", false, "no claude binary to compare the calibration key against");
    } else {
      const { record, why } = findInstalledChars(manifest, binary, mcp, blobs.treatment);
      check(
        "installedChars probe calibrates to this machine",
        record !== null,
        record !== null ? `${record.value} chars (${record.deltaTokens} tokens) from ${record.probeRunId}` : why
      );
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
async function observe(args) {
  const { manifest, sha256: manifestSha } = loadManifest(args.manifest);
  // FIRST, before anything spends: the declaration gaps. See
  // `manifestDeclarationGaps` for the three classes and the timing constraint —
  // this refusal is designed for the pre-registration window, and hitting it on
  // a registered run does not erase the owed result artifact.
  const gaps = manifestDeclarationGaps(manifest);
  if (gaps.length > 0) refuse(`the manifest's declarations are incomplete:\n  ${gaps.join("\n  ")}`);
  // Artifact 1 seals "the sha256 of scripts/b12-run.mjs" — so the running
  // script asserts it IS the sealed one. An edited harness driving a sealed
  // manifest is instrument drift wearing the manifest's name.
  {
    const selfSha = sha256File(fileURLToPath(import.meta.url));
    if (manifest.pinned?.b12RunSha256 !== selfSha) {
      refuse(`this harness's sha256 ${selfSha} != pinned.b12RunSha256 ${manifest.pinned?.b12RunSha256} — the running script is not the one the manifest sealed`);
    }
  }
  if (!args.task) refuse("--task is required");
  const task = manifest.tasks.find((t) => t.id === args.task);
  if (!task) refuse(`task ${args.task} is not in the manifest`);
  const arm = args.arm ?? "treatment";
  if (arm !== "treatment" && arm !== "control") refuse(`--arm must be treatment or control, got ${arm}`);

  // The committed order, enforced against the persisted runlog BEFORE the
  // session is spent — see `committedOrderViolation` for the treatment-only
  // scoping and the duplicate-task adjudication it deliberately leaves to
  // scoring.
  if (arm === "treatment") {
    const runLogPath = path.join(REPO, "evidence", `${manifest.runId ?? "b12-unnamed"}.b12.runlog.jsonl`);
    const violation = committedOrderViolation(
      manifest,
      args.task,
      existsSync(runLogPath) ? readFileSync(runLogPath, "utf8") : ""
    );
    if (violation) refuse(violation);
  }

  const binary = claudeBinary();
  assertPinned(manifest, binary);
  // Every refusal BEFORE the worktree and before the session id, so a manifest
  // that cannot produce a compliant observation costs nothing to discover.
  const mcp = arm === "treatment" ? resolveMcpConfig(manifest) : null;
  const policyBlob = resolvePolicyBlob(manifest, arm);
  // The other arm's blob is not carried further, but a pair whose other arm
  // cannot run was never a pair — so it must resolve too.
  resolvePolicyBlob(manifest, arm === "treatment" ? "control" : "treatment");
  const memorySnapshot = resolveMemorySnapshot(manifest);
  // ONE `O_o`, treatment only. The control arm records a named absence, not a
  // second value — see `validateInstalledCharsProbe`'s header for why 0 would
  // be the two-valued `O` the boundary refuses.
  const installedChars =
    arm === "treatment"
      ? resolveInstalledChars(manifest, binary, mcp, policyBlob)
      : {
          value: null,
          reason:
            "control arm — O_o belongs to the primary (treated) arithmetic; the probe measured ONE " +
            "delta and the control is the baseline inside that subtraction, so a control value " +
            "(even 0) would be a second O",
        };
  const capture = await loadCapture(manifest);

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

  // "The delegation policy leaves the repository under test entirely" (CHANNEL
  // 5). The repository under test is THIS worktree at the task's base commit —
  // a blob physically inside it, or committed at the same relative path in the
  // base tree, is in-repo policy wearing an out-of-repo name.
  {
    const rel = path.relative(treeDir, policyBlob.path);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      refuse(`the ${arm} policy blob resolves INSIDE the arm's worktree (${policyBlob.path}) — the policy must leave the repository under test entirely`);
    }
    const inBaseTree = path.join(treeDir, policyBlob.declaredPath);
    if (!path.isAbsolute(policyBlob.declaredPath) && existsSync(inBaseTree)) {
      refuse(`the base commit carries ${policyBlob.declaredPath} inside the worktree — the policy must not exist in the tree the arms run in`);
    }
  }

  // `design.artifacts` 10: the memory snapshot is RESTORED before the session,
  // and `voidConditions` 13 hashes the directory pre and post. The restore is
  // asserted against the pin — a copy that did not reproduce the snapshot is a
  // failed precondition, not a lesser restore.
  const memoryDir = path.join(projectSlugDirFor(treeDir), "memory");
  const memoryRestored = restoreMemory(memorySnapshot.dir, memoryDir);
  if (memoryRestored.sha256 !== memorySnapshot.sha256) {
    refuse(`memory restore did not reproduce the snapshot: ${memoryRestored.sha256} != ${memorySnapshot.sha256}`);
  }

  // The seven instruction-set covariates, hashed PRE here and POST right after
  // the arm exits. COMPONENTS ONLY — no aggregate "instruction-set hash" is
  // minted: `voidConditions` 21 voids A/B pairs on "different instruction-set
  // hashes" while the policy blob varies per arm BY DESIGN, and the frozen text
  // does not say whether that hash includes the intentionally arm-varying blob.
  // Collapsing the components here would decide that silently; the ambiguity is
  // registered in FINDINGS.md instead. Likewise `mcpConfigPinned` (the
  // manifest's, identical across a pair) and `mcpConfigPassed` (what this arm
  // actually received, null on control as a named fact) are BOTH recorded,
  // because `voidConditions` 12 compares "MCP-config hashes" across a pair and
  // `design.artifacts` 10 gives the two arms different argv — which of the two
  // facts the clause compares is not defined by the frozen text.
  const shaOrNull = (p) => (existsSync(p) ? sha256File(p) : null);
  const instructionHashesAt = (memorySha) => ({
    claudeMd: shaOrNull(path.join(treeDir, "CLAUDE.md")),
    settings: shaOrNull(path.join(treeDir, ".claude", "settings.json")),
    settingsLocal: shaOrNull(path.join(treeDir, ".claude", "settings.local.json")),
    mcpConfigPassed: mcp ? shaOrNull(mcp.path) : null,
    policyBlob: shaOrNull(policyBlob.path),
    memory: memorySha,
    // The seventh is not measurable from outside the session — a registered
    // limit (FINDINGS.md F24), recorded as a named fact instead of a hash that
    // would dress an assumption as a measurement.
    allowlistVisibleInSystemPrompt: "unmeasurable-from-outside-the-session (registered limit, FINDINGS.md F24)",
  });
  const instructionPre = instructionHashesAt(memoryRestored.sha256);

  const before = takeSnapshot();

  // BOTH arms are strict, and that is a measured correction (2026-08-08), not
  // a style choice. The first probe run on the Mac found ~30 claude.ai ACCOUNT
  // connectors on the machine (`claude mcp list` — TELUS/Adobe/Salesforce…),
  // which `claude mcp remove` cannot remove and a work machine cannot drop.
  // Without `--strict-mcp-config` on the treatment arm they merge into it and
  // not into the control, so the arms would differ by the account's connector
  // roster as well as by this server — two treatments. Strict on both makes
  // the account state arm-invariant: either strict excludes it (clean) or it
  // lands identically in both arms and cancels in every paired comparison.
  const mcpArgs =
    arm === "treatment" ? ["--strict-mcp-config", "--mcp-config", mcp.path] : ["--strict-mcp-config"];
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
    // The per-arm policy, delivered exactly as CHANNEL 5 resolves it: from the
    // committed out-of-repo blob, never from the tree the arms run in. A
    // single-argument option, so the variadic guards below are untouched.
    "--append-system-prompt",
    policyBlob.content,
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

  // POST, immediately after the arm and before the end-state commit or the
  // acceptance command touch anything: `voidConditions` 12 and 13 are about
  // what moved "between any arm's start and end", not about what acceptance
  // wrote afterwards.
  const instructionPost = instructionHashesAt(hashMemoryDir(memoryDir).sha256);

  const after = takeSnapshot();
  const originated = after.requestIds.filter((id) => !before.requestIds.includes(id));

  // THE END COMMIT IS MADE HERE, BEFORE ACCEPTANCE, AND THAT IS THE FROZEN RULE
  // RATHER THAN A CONVENIENCE.
  //
  // `admissionRule` 3: "An observation whose acceptance predicate does not exit 0
  // AT ITS END COMMIT is `void(task_failed)`." This ran acceptance against the
  // working tree and separately recorded `endCommit` as `git rev-parse HEAD`, so
  // on the ORDINARY outcome — `claude --print` edits files and does not commit —
  // the exit code was earned on a state no recorded commit contained, and
  // `accepted` is exactly what separates a TASK from an ATTEMPT.
  //
  // Reporting a `dirtyAtAcceptance` flag was the first fix and it was the wrong
  // one: it published the discrepancy instead of removing it, and a hash
  // inventory does not make an uncommitted tree into the named end commit.
  // Refusing on a dirty tree would have been worse — it invalidates the ordinary
  // case, which is not a rule the frozen text has.
  //
  // So the harness commits what the arm left, in the arm's own throwaway
  // worktree, and `endCommit` names it. This adds no rule: it makes the frozen
  // predicate EVALUABLE, and acceptance then runs on a tree that IS its end
  // commit by construction. Whether the arm committed its own work is still a
  // fact about the arm, so it is recorded rather than erased.
  const leftUncommitted = run("git", ["-C", treeDir, "status", "--porcelain"]).out.trim().length > 0;
  if (leftUncommitted) {
    git(["add", "-A"], treeDir);
    git(["commit", "-m", `b12 end state: ${task.id}/${arm}`], treeDir);
  }
  // Read HERE — after the arm's work is committed and BEFORE acceptance runs —
  // so "acceptance exited 0 at its end commit" is true by construction rather
  // than by hope. Read after acceptance it would name a commit the command may
  // never have seen.
  const endCommit = git(["rev-parse", "HEAD"], treeDir);
  const stillDirty = run("git", ["-C", treeDir, "status", "--porcelain"]).out.trim();
  if (stillDirty) refuse(`worktree still dirty after the end-state commit: ${stillDirty.slice(0, 200)}`);

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

  // Taken AFTER acceptance, so it answers a different question from the one
  // above: not "did the arm commit its work" but "did the acceptance command
  // itself write into the tree" — coverage output, a build directory, a lock
  // file. Reported, deciding nothing; the frozen text has no rule about it, and
  // `sourceFiles` hashes whatever it left.
  const endPorcelain = run("git", ["-C", treeDir, "status", "--porcelain"]).out;

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

  // Facts the run-level VOIDs are adjudicated on at scoring time, recorded here
  // as invalidity because a driver must stop rather than keep spending on a run
  // that already voided. Same shape as the empty-lineage contradiction below:
  // the artifact is still written; what is refused is calling it valid. EVERY
  // component compares, not only the two with named VOIDs — see
  // `instructionDriftReasons` for the per-component citations.
  invalid.push(...instructionDriftReasons(instructionPre, instructionPost));

  const runId = manifest.runId ?? "b12-unnamed";
  const dir = path.join(REPO, "evidence", runId, `obs-${task.id}-${arm}`);
  mkdirSync(dir, { recursive: true });

  // `design.artifacts` 6, TAKEN WHILE THE WORKTREE STILL EXISTS. This is the
  // only window in which the tree and its `.local-coder/telemetry.jsonl` are
  // both on disk: the log is gitignored as per-machine, and the removal below
  // deletes it. Without this the run "cannot be corrected, only discarded".
  //
  // BEFORE the observation literal, not after, because the lineage is one of the
  // things that can make the observation invalid.
  const archive = await capture.module.captureObservation({
    taskId: task.id,
    arm,
    sessionId,
    treeDir,
    slugDirs: projectSlugDirs(),
    porcelain: endPorcelain,
    declaredFileScope: task.fileScope ?? null,
  });

  // AN EMPTY LINEAGE BESIDE ORIGINATED IDS IS A CONTRADICTION, AND IT IS THE
  // HARNESS'S OWN TWO MEASUREMENTS DISAGREEING.
  //
  // If ids were originated, a transcript carrying them exists; if the lineage
  // search found none, the search was scoped wrong. `classifyRun` already
  // refuses the mirror image — `originatedCount === 0` is "the arm produced no
  // billed request, or its slug was outside the snapshot". This is the same
  // fact seen from the other side, and catching it mints nothing: it adds no
  // disposition and no threshold, it compares two numbers the harness already
  // has. Without it `archive.lineage: []` is schema-complete, commits cleanly,
  // and reads as an observation whose session simply had no records.
  if (originated.length > 0 && archive.lineage.length === 0) {
    invalid.push(
      `${originated.length} requestId(s) were originated and the lineage search found no transcript carrying them — ` +
        `the search covered ${archive.slugsSearched.length} slug(s) and ${archive.transcriptsSearched} file(s)`
    );
  }

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
    mcpConfig: mcp,
    /** The manifest's pin — identical across a pair by construction — beside
     * what this arm was actually handed. Both, because `voidConditions` 12
     * compares a pair's "MCP-config hashes" and the frozen text does not say
     * which of the two facts it means; see the note at `instructionHashesAt`. */
    mcpConfigPinned: manifest.pinned?.mcpConfigSha256 ?? null,
    policyBlob: { path: policyBlob.declaredPath, sha256: policyBlob.sha256 },
    /** ONE `O_o` with provenance on the treatment arm; a NAMED absence on the
     * control arm. Never a defaulted number — see PREMISES.md § B12. */
    installedChars,
    memorySnapshot: { source: memorySnapshot.declaredPath, sha256: memorySnapshot.sha256, files: memorySnapshot.files },
    instructionHashes: { pre: instructionPre, post: instructionPost },
    capture: { sha256: capture.sha256, sourceSha256: capture.sourceSha256 },
    /** Whether the ARM committed its own work, or the harness had to. */
    armLeftUncommitted: leftUncommitted,
    /** Whether the ACCEPTANCE COMMAND wrote into the tree. Deciding nothing. */
    acceptanceDirtiedTree: endPorcelain.trim().length > 0,
    ratesSha256: ratesSha,
    baseCommit: task.baseCommit,
    treeHashAtStart: treeHash,
    endCommit,
    promptSha256: promptSha,
    command: [path.basename(binary.path), ...cliArgs.slice(0, -1), "<prompt from manifest>"]
      .map((a) => (a === policyBlob.content ? "<policy blob from manifest>" : a))
      .join(" "),
    snapshotBefore: { ts: before.ts, slugsWalked: before.slugsWalked, files: before.files, ids: before.requestIds.length },
    snapshotAfter: { ts: after.ts, slugsWalked: after.slugsWalked, files: after.files, ids: after.requestIds.length },
    // The unit of observation, established by DIFFERENCE rather than by any
    // inference about which session originated what — no such inference is
    // sound, because inherited records are rewritten to claim the session they
    // sit in.
    originatedRequestIds: originated,
    acceptance,
    // Against the DECLARED expected exit code, not a hardcoded 0 — artifact 1:
    // "the acceptance predicate and expected exit code". Presence is enforced
    // by the declaration gaps above; the fallback exists only for the
    // artifact's own robustness, never for a compliant manifest.
    acceptanceExpectedExit: Number.isInteger(task.acceptanceExpectedExit) ? task.acceptanceExpectedExit : 0,
    accepted:
      acceptance === null
        ? null
        : acceptance.every((a) => a.exitCode === (Number.isInteger(task.acceptanceExpectedExit) ? task.acceptanceExpectedExit : 0)),
    stderrTail: result.err.slice(-2000),
  };

  // THE WRITE-TIME DOMAIN GUARD the pre-declaration owes to this pass:
  // `holdsIf` 6's finiteness check cannot catch a fabricated finite sentinel,
  // so provenance is checked HERE, at the moment of writing, on the arm that
  // carries the term. The value above flowed through the probe validation, so
  // this firing means the harness itself is broken — which is exactly when a
  // refusal is worth the most.
  if (arm === "treatment") {
    const v = observation.installedChars?.value;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      refuse(
        `refusing to WRITE a treatment observation whose installedChars is ${String(v)} — absent, non-finite or negative (PREMISES.md § B12 domain validation)`
      );
    }
  }

  // NAMED AS THEY ARE WRITTEN, because the commit barrier below verifies THIS
  // list against `HEAD` blob by blob. A hand-maintained second list is how a new
  // artifact comes to be written and never checked.
  const written = [];
  const emit = (name, body) => {
    writeFileSync(path.join(dir, name), body, "utf8");
    written.push(name);
  };
  emit("observation.json", JSON.stringify(observation, null, 2) + "\n");
  emit("snapshot-before.json", JSON.stringify(before, null, 2) + "\n");
  emit("snapshot-after.json", JSON.stringify(after, null, 2) + "\n");
  emit("cli-stdout.json", result.out);
  emit("archive.json", JSON.stringify(archive, null, 2) + "\n");
  // The telemetry rows go out AGAIN on their own, verbatim and one per line,
  // because this file is the IDENTITY SOURCE for UNIT 5: `identify` keys a row
  // `[source, ordinal]`, and an ordinal has to be a position in a file a reader
  // can point at. There is no run-level log to key against — every observation
  // writes into its own worktree — so the archive path IS the source, and
  // ordinals restarting per file stay unique because paths differ.
  emit(
    "telemetry.jsonl",
    archive.telemetry.map((row) => JSON.stringify(row)).join("\n") + (archive.telemetry.length > 0 ? "\n" : "")
  );

  // A machine-written row per observation, `design.artifacts` 10: "whose `ts` is
  // read from the system clock in the same command that writes it".
  const runLog = path.join(REPO, "evidence", `${runId}.b12.runlog.jsonl`);
  writeFileSync(
    runLog,
    (existsSync(runLog) ? readFileSync(runLog, "utf8") : "") +
      JSON.stringify({
        ts: stamp(),
        runId,
        taskId: task.id,
        arm,
        sessionId,
        outcome: verdict.outcome,
        valid: observation.valid,
        accepted: observation.accepted,
        originated: originated.length,
      }) +
      "\n",
    "utf8"
  );

  // THE COMMIT BARRIER. `design.artifacts` 6 says "committed at each task's END,
  // BEFORE THE NEXT TASK STARTS", and the same inventory keys a VOID to a commit
  // DATE on artifact 1 — a word that is unintelligible about a mere file write.
  //
  // Enforced HERE rather than left to a driver. A driver could lawfully commit
  // between calls, but then the timing obligation is checked by nothing, which
  // is the shape of every guard this project has had to delete. The verify step
  // after it is the same rule: a `git commit` that silently committed nothing
  // (an empty diff, a path outside the repo, a gitignore rule nobody expected)
  // would leave the archive uncommitted and the run looking clean.
  const relDir = path.relative(REPO, dir).split(path.sep).join("/");
  const relLog = path.relative(REPO, runLog).split(path.sep).join("/");
  git(["add", "--", relDir, relLog]);
  const staged = git(["diff", "--cached", "--name-only", "--", relDir]);
  if (staged.trim() === "") refuse(`nothing staged under ${relDir} — the archive did not reach the index`);
  git(["commit", "-m", `evidence: ${runId} ${task.id}/${arm}`, "--", relDir, relLog]);

  // EXISTENCE PROVED NOTHING, AND THAT WAS THE FIRST VERSION OF THIS CHECK.
  //
  // It asked `git ls-tree` whether ANYTHING sat under the directory. An
  // index-mutating `pre-commit` hook can drop `archive.json` while leaving
  // `observation.json` staged: the add succeeds, the staged check succeeds
  // because files are staged, the commit succeeds with what is left, and
  // `ls-tree` succeeds because something is there. The archive is not committed
  // and every guard is green. A `post-commit` hook that moves `HEAD` back to an
  // older commit containing an older copy of the directory passes it too.
  //
  // So each file is compared BY BLOB HASH against what `HEAD` now carries.
  // `git hash-object` on the file and `git rev-parse HEAD:<path>` on the tree
  // are the same function of the same bytes, so equality is exact rather than
  // circumstantial, and a stale `HEAD` fails on content instead of on presence.
  for (const name of written) {
    const rel = `${relDir}/${name}`;
    const onDisk = git(["hash-object", "--", path.join(dir, name)]);
    const inHead = run("git", ["-C", REPO, "rev-parse", `HEAD:${rel}`]);
    if (inHead.code !== 0) refuse(`HEAD does not carry ${rel} after the commit`);
    if (inHead.out.trim() !== onDisk) {
      refuse(`HEAD carries a different ${rel}: ${inHead.out.trim().slice(0, 12)} != ${onDisk.slice(0, 12)}`);
    }
  }

  process.stdout.write(
    `  ${observation.valid ? "ok  " : "INVALID"}  ${task.id}/${arm}  session ${sessionId.slice(0, 8)}  ` +
      `originated ${originated.length} request(s)  accepted ${observation.accepted}  ` +
      `${censored ? "CENSORED  " : ""}${wallMs}ms\n` +
      `  archived ${archive.lineage.length} lineage file(s), ${archive.telemetry.length} telemetry row(s), ` +
      `${archive.invocationIds.length} invocation id(s), ${archive.sourceFiles.length} source file(s)\n` +
      `  committed ${relDir}\n`
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
    // AWAITED, not fired and forgotten. `observe` became async when the capture
    // moved into `dist/`, and a floating promise would let the process exit 0
    // while the archive was still being written — a run that looks clean and
    // committed nothing.
    await observe(args);
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
      "usage: b12-run.mjs <preflight|observe|snapshot> [--manifest f] [--session id] [--task id] [--arm treatment|control] [--out f] [--root d] [--keep]\n"
    );
    process.exit(2);
}
