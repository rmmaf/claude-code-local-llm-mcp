/**
 * THE OPERATOR'S REGISTER — `check`, `register`, `open-b`, `seal-harness`.
 * NEVER FROZEN: this file is tooling the operator drives, and freezing it
 * would freeze the ability to refuse. What it CALLS is frozen — the manifest
 * sweep and the scope grammar come from `scripts/b12-run.mjs`, the prior-runs
 * register from the built scorer — and what it WRITES is what the frozen
 * clauses then hold everyone to.
 *
 * THE ACT IS A COMPARE-AND-SWAP, never a working-tree commit. `register`
 * captures the branch ref, `expectedHead`, and the candidate bytes ONCE and
 * BEFORE VALIDATION — what is validated is exactly what registers; every OLD
 * input is read from `<expectedHead>:<path>`; every NEW candidate (the
 * manifests, the registration row's MEASUREMENTS) is generated or read ONCE,
 * written into the object store, laid into a TEMPORARY index over
 * `expectedHead`'s tree, committed with `git commit-tree <tree> -p
 * <expectedHead>`, and installed with `git update-ref <ref> <new>
 * <expectedHead>` — so a concurrent commit makes the act FAIL WITHOUT
 * REGISTERING instead of registering against a head nobody checked. After a
 * successful `update-ref` the registration EXISTS: any later failure is
 * reported as "registered; a later step failed", never as "not registered".
 *
 * ANTI-STALE-DIST: the prior-runs gate imports the BUILT scorer, and a stale
 * `dist/` is the registered F24 hole — so the build runs fresh, and a build
 * that fails refuses the whole act.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fileScopeViolations, manifestDeclarationGaps } from "./b12-run.mjs";

const sha256Text = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** ISO seconds, read from the clock in the same command that writes the row. */
const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function fail(why) {
  process.stderr.write(`b12-register: REFUSED — ${why}\n`);
  process.exit(1);
}

function sh(cwd, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28, shell: opts.shell ?? false });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", errorCode: r.error?.code ?? null };
}

const git = (cwd, args) => sh(cwd, "git", args);

/**
 * The build, FRESH, before any import from `dist/` — a register that trusted
 * yesterday's build would gate prior runs on yesterday's rules.
 */
export function freshBuild(repoRoot, command = null) {
  const cmd = command ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  const r = sh(repoRoot, cmd, ["run", "build"], { shell: process.platform === "win32" });
  if (r.code !== 0) {
    throw new Error(`the fresh build failed (exit ${r.code}) — a stale dist/ may not gate a registration:\n${(r.err || r.out).slice(0, 2000)}`);
  }
}

/**
 * The PURE half of `check`: every red reason derivable from the two loaded
 * manifests and the pilot file, no git and no subprocess — so the oracle can
 * fire and not-fire each one. The git-coupled steps (prior runs, the seal,
 * the cert and probe artifacts, the red-at-base verification) live in the CLI
 * orchestration and refuse in their own words.
 */
export function checkCore(manifestA, manifestB, pilot) {
  const red = [];
  for (const [name, m] of [["manifest A", manifestA], ["manifest B", manifestB]]) {
    for (const gap of manifestDeclarationGaps(m)) red.push(`${name}: ${gap}`);
  }
  // The frozen CARDINALITIES — `gaps === 0` does not cover them: an ordered
  // manifest of 30 (design.artifacts 1), exactly 6 A/B pairs (runPlan PHASE
  // 7: "12 sessions (6 pairs)"), a pilot of exactly 5 pre-declared tasks
  // excluded from BOTH sealed manifests (design.artifacts 4).
  for (const [name, m] of [["manifest A", manifestA], ["manifest B", manifestB]]) {
    const n = Array.isArray(m?.tasks) ? m.tasks.length : 0;
    if (n !== 30) red.push(`${name}: ${n} task(s) against the frozen ordered 30 (design.artifacts 1)`);
  }
  const pairs = Array.isArray(manifestA?.abPairs) ? manifestA.abPairs.length : 0;
  if (pairs !== 6) red.push(`manifest A: ${pairs} A/B pair(s) against the frozen 6 (runPlan PHASE 7)`);
  if (pilot === null) {
    red.push("no pilot file — PHASE 2 precedes PHASE 4, and a register with no pilot is a phase skipped in silence");
  } else {
    const pilotIds = [...new Set((pilot.observations ?? []).map((o) => o.taskId))];
    if (pilotIds.length !== 5) {
      red.push(`the pilot covers ${pilotIds.length} distinct task(s) against the frozen 5 (design.artifacts 4)`);
    }
    for (const [name, m] of [["manifest A", manifestA], ["manifest B", manifestB]]) {
      const ids = new Set((m?.tasks ?? []).map((t) => t?.id));
      const overlap = pilotIds.filter((id) => ids.has(id));
      if (overlap.length > 0) {
        red.push(`pilot task(s) ${overlap.join(", ")} appear in ${name} — artifact 4 excludes the pilot from both sealed manifests`);
      }
    }
  }
  // Cross invariants and the per-task hashes.
  if (manifestA?.runId !== undefined && manifestB?.runId !== undefined && manifestA.runId === manifestB.runId) {
    red.push("manifests A and B carry the SAME runId — run 2 is a distinct registered run, not a relabel");
  }
  for (const [name, m] of [["manifest A", manifestA], ["manifest B", manifestB]]) {
    for (const t of m?.tasks ?? []) {
      if (typeof t?.prompt === "string" && typeof t?.promptSha256 === "string" && sha256Text(t.prompt) !== t.promptSha256) {
        red.push(`${name}: task ${t.id} promptSha256 does not match its prompt — the text moved after writing`);
      }
    }
    // admissionRule 7 over EVERY task, via the frozen predicate.
    for (const v of fileScopeViolations((m?.tasks ?? []).map((t) => ({ id: t?.id ?? "(unnamed)", fileScope: Array.isArray(t?.fileScope) ? t.fileScope : null })))) {
      red.push(`${name}: ${v}`);
    }
    // The two CHOSEN constants, both, and the explicit budget declarations the
    // seal refuses to live without.
    const pinned = m?.pinned ?? {};
    if (typeof pinned.pacingCacheWriteShareCeiling !== "number") red.push(`${name}: pins no pacingCacheWriteShareCeiling (artifact 1)`);
    if (typeof pinned.perTaskDenominatorShareCap !== "number") red.push(`${name}: pins no perTaskDenominatorShareCap (artifact 1)`);
    if (!Number.isFinite(pinned.perArmTimeoutMs)) red.push(`${name}: pins no perArmTimeoutMs — the silent 45-minute fallback never decides a run`);
    if (!Array.isArray(pinned.extraArgs)) red.push(`${name}: pins no extraArgs — what the probe ran with is what the run must run with, declared`);
  }
  return red;
}

/**
 * THE CAS COMMIT. `candidates` are the NEW bytes, each read or generated
 * exactly once by the caller; everything else in the tree rides through from
 * `expectedHead` untouched. Returns without side effects on ANY failure
 * before `update-ref`; after `update-ref` the act is DONE and the caller must
 * report later failures as post-registration.
 *
 * THE SYNC IS CONDITIONAL. A candidate may carry `diskBefore` — the disk
 * bytes (or null for absent) at the CALLER'S capture instant; without it the
 * snapshot is taken here, at entry. After the swap, a path whose disk bytes
 * moved past that snapshot is NEVER checked out: the ref only guards against
 * concurrent COMMITS, and an unconditional checkout would silently destroy
 * bytes nobody validated — a concurrent append to the append-only register
 * most of all. Drifted paths are preserved and reported as a
 * post-registration conflict.
 */
export function casCommit(repoRoot, { candidates, message, expectedHeadOverride = null }) {
  const refProbe = git(repoRoot, ["symbolic-ref", "--quiet", "HEAD"]);
  if (refProbe.code !== 0) return { ok: false, why: "HEAD is detached — a registration needs a branch to install on" };
  const ref = refProbe.out.trim();
  const headProbe = git(repoRoot, ["rev-parse", "HEAD"]);
  if (headProbe.code !== 0) return { ok: false, why: "HEAD does not resolve" };
  const expectedHead = expectedHeadOverride ?? headProbe.out.trim();

  // The disk snapshot each candidate is judged against at sync time — the
  // caller's capture instant when given, entry here otherwise.
  const readDisk = (rel) => {
    try {
      return readFileSync(path.join(repoRoot, rel), "utf8");
    } catch {
      return null;
    }
  };
  // The blobs, into the object store — content-addressed, so a candidate
  // mutated between validation and here would land as DIFFERENT bytes and the
  // caller's recorded sha would disagree with the commit's.
  const entries = [];
  for (const c of candidates) {
    const w = spawnSync("git", ["-C", repoRoot, "hash-object", "-w", "--stdin"], {
      input: c.bytes,
      encoding: "utf8",
    });
    if (w.status !== 0) return { ok: false, why: `hash-object failed for ${c.path}` };
    entries.push({
      path: c.path,
      blob: (w.stdout ?? "").trim(),
      bytes: c.bytes,
      diskBefore: c.diskBefore === undefined ? readDisk(c.path) : c.diskBefore,
    });
  }

  // A TEMPORARY index over expectedHead's tree — the real index and the
  // working tree are not consulted and not touched. The location comes from
  // git itself: in a LINKED WORKTREE `.git` is a FILE pointing at the real
  // per-worktree git dir, so `path.join(repoRoot, ".git", ...)` would be a
  // path under a file and every read-tree would fail.
  const gitDirProbe = git(repoRoot, ["rev-parse", "--absolute-git-dir"]);
  if (gitDirProbe.code !== 0) return { ok: false, why: "the git dir does not resolve" };
  const tmpIndex = path.join(gitDirProbe.out.trim(), `b12-register-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  const withIndex = (args, input) => {
    const r = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", env, input });
    return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
  };
  try {
    if (withIndex(["read-tree", expectedHead]).code !== 0) return { ok: false, why: "read-tree over expectedHead failed" };
    for (const e of entries) {
      const upd = withIndex(["update-index", "--add", "--cacheinfo", `100644,${e.blob},${e.path}`]);
      if (upd.code !== 0) return { ok: false, why: `update-index failed for ${e.path}` };
    }
    const tree = withIndex(["write-tree"]);
    if (tree.code !== 0) return { ok: false, why: "write-tree failed" };
    const commit = withIndex(["commit-tree", tree.out.trim(), "-p", expectedHead, "-m", message]);
    if (commit.code !== 0) return { ok: false, why: "commit-tree failed" };
    const newCommit = commit.out.trim();
    // THE SWAP: installs only if the branch still points at expectedHead.
    const swap = git(repoRoot, ["update-ref", ref, newCommit, expectedHead]);
    if (swap.code !== 0) {
      return { ok: false, why: `the CAS failed — ${ref} moved past ${expectedHead.slice(0, 12)} while the act was being built; NOTHING was registered` };
    }
    // REGISTERED. Sync the real index and working tree to the new commit —
    // but ONLY for paths whose disk bytes still match the snapshot (or
    // already match the registered bytes). A drifted path holds bytes the
    // act never validated; destroying them would be the one irreversible
    // step in a tool built to refuse. Failures here are post-registration.
    const conflicted = [];
    const toSync = [];
    for (const e of entries) {
      const now = readDisk(e.path);
      if (now === e.diskBefore || now === e.bytes) toSync.push(e.path);
      else conflicted.push(e.path);
    }
    const post = [];
    if (toSync.length > 0) {
      const sync = git(repoRoot, ["checkout", newCommit, "--", ...toSync]);
      if (sync.code !== 0) {
        post.push(`the working-tree sync failed — run: git checkout ${newCommit.slice(0, 12)} -- ${toSync.join(" ")}`);
      }
    }
    if (conflicted.length > 0) {
      post.push(
        `NOT synced (disk moved during the act): ${conflicted.join(", ")} — the registered bytes live in ${newCommit.slice(0, 12)}; reconcile the disk copies by hand`
      );
    }
    if (post.length > 0) {
      return { ok: true, commit: newCommit, postFailure: `registered as ${newCommit.slice(0, 12)}, but ${post.join("; ")}` };
    }
    return { ok: true, commit: newCommit };
  } finally {
    try {
      rmSync(tmpIndex, { force: true });
    } catch {
      // Best effort — a leftover pid-suffixed temp index binds nothing.
    }
  }
}

/**
 * THE SEAL — `evidence/b12-harness-seal.json`, CREATE-ONLY: evidence is
 * frozen by sha, so a seal that could be re-run over its own path would be a
 * pin that moves. A new seal means abandoning the prior registration or a new
 * content-addressed artifact; this command refuses the overwrite either way.
 */
export function sealHarness(repoRoot, manifestPath) {
  const sealRel = "evidence/b12-harness-seal.json";
  const sealAbs = path.join(repoRoot, sealRel);
  if (existsSync(sealAbs)) return { ok: false, why: `${sealRel} already exists on disk — the seal is create-only` };
  const born = git(repoRoot, ["log", "--diff-filter=A", "--format=%H", "--", sealRel]);
  if (born.code === 0 && born.out.trim() !== "") {
    return { ok: false, why: `${sealRel} exists in history — a re-seal abandons the prior registration explicitly or names a new artifact` };
  }
  if (!existsSync(manifestPath)) return { ok: false, why: `manifest not found: ${manifestPath}` };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, why: "the manifest does not parse" };
  }
  const pinned = manifest?.pinned ?? {};
  if (!Number.isFinite(pinned.perArmTimeoutMs)) {
    return { ok: false, why: "the manifest pins no perArmTimeoutMs — the silent 45-minute fallback never decides a run; declare the budget and re-run" };
  }
  if (!Array.isArray(pinned.extraArgs)) {
    return { ok: false, why: "the manifest pins no extraArgs — declare (possibly empty) what every session runs with" };
  }
  const runBytesProbe = git(repoRoot, ["show", "HEAD:scripts/b12-run.mjs"]);
  if (runBytesProbe.code !== 0) return { ok: false, why: "HEAD does not carry scripts/b12-run.mjs — seal COMMITTED bytes, not a working copy" };
  const onDisk = readFileSync(path.join(repoRoot, "scripts", "b12-run.mjs"), "utf8");
  if (onDisk !== runBytesProbe.out) {
    return { ok: false, why: "scripts/b12-run.mjs differs between disk and HEAD — commit the harness before sealing it" };
  }
  const seal = {
    schema: "b12-harness-seal/1",
    sealedAt: stamp(),
    b12RunSha256: sha256Text(runBytesProbe.out),
    perArmTimeoutMs: pinned.perArmTimeoutMs,
    extraArgs: pinned.extraArgs,
  };
  writeFileSync(sealAbs, JSON.stringify(seal, null, 2) + "\n", "utf8");
  return { ok: true, path: sealRel, seal };
}

// ---------------------------------------------------------------------------
// CLI orchestration.
// ---------------------------------------------------------------------------

function loadJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

async function priorRunsGate(repoRoot, runId) {
  freshBuild(repoRoot);
  const mod = await import(pathToFileURL(path.join(repoRoot, "dist", "cost", "b12", "archive.js")).href);
  const register = mod.collectRegister(repoRoot, runId);
  const abandoned = register.priorRuns.filter((r) => r.result === null);
  const reasons = [...register.discrepancies];
  for (const r of abandoned) {
    reasons.push(`prior run ${r.runId} carries no committed result — clause 1 refuses a new registration over an abandoned one`);
  }
  return reasons;
}

/**
 * The operator's PREVIEW — `check` reads the DISK, because the candidates it
 * previews are not committed yet and iterating on them is the point. The ACT
 * never calls this: `registerRun` validates the CAPTURED state only.
 */
async function runCheck(repoRoot, runId) {
  const manifestA = loadJson(path.join(repoRoot, "evidence", `${runId}.b12.tasks.json`));
  const manifestB = loadJson(path.join(repoRoot, "evidence", `${runId}.b12.manifest-B.tasks.json`));
  const pilotId = manifestA?.pilotRunId ?? runId;
  const pilot = loadJson(path.join(repoRoot, "evidence", `${pilotId}.b12.pilot.json`));
  const red = [];
  if (manifestA === null) red.push("manifest A is missing or does not parse");
  if (manifestB === null) red.push("manifest B is missing or does not parse — sealed in the SAME act (design.artifacts 2)");
  if (manifestA !== null && manifestB !== null) red.push(...checkCore(manifestA, manifestB, pilot));
  // The seal, present and naming HEAD's harness bytes.
  const seal = loadJson(path.join(repoRoot, "evidence", "b12-harness-seal.json"));
  const headRun = git(repoRoot, ["show", "HEAD:scripts/b12-run.mjs"]);
  if (seal === null) red.push("no evidence/b12-harness-seal.json — seal-harness is the barrier before any registration");
  else if (headRun.code !== 0 || seal.b12RunSha256 !== sha256Text(headRun.out)) {
    red.push("the harness seal does not name HEAD's scripts/b12-run.mjs — the harness moved after sealing");
  }
  red.push(...(await priorRunsGate(repoRoot, runId)));
  return red;
}

/**
 * THE ACT. CAPTURE PRECEDES VALIDATION: `expectedHead` and the candidate
 * bytes are taken FIRST; the check then runs over exactly those — the parsed
 * candidate buffers, every OLD input from `<expectedHead>:<path>` — and the
 * SAME buffers go to the CAS. A disk edit after the capture cannot change
 * what registers (the validated bytes are what lands); a commit after the
 * capture fails `update-ref` instead of becoming a baseline nobody checked.
 * The prior-runs gate reads the live repo, but any head movement between the
 * capture and the swap fails the CAS, so a gate that saw a different head
 * refuses rather than registers.
 *
 * `opts.gate` and `opts.afterCapture` are the ORACLE'S seams — the CLI passes
 * neither. `afterCapture` runs between validation and the CAS, the exact
 * window the capture discipline closes.
 */
export async function registerRun(repoRoot, runId, opts = {}) {
  const gate = opts.gate ?? priorRunsGate;
  // CAPTURE — before any validation.
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  if (head.code !== 0) return { ok: false, red: ["HEAD does not resolve"] };
  const expectedHead = head.out.trim();
  // THE VALIDATOR'S OWN BYTES must be expectedHead's. The prior-runs gate
  // builds and imports the WORKING TREE's scorer, and `checkCore`'s frozen
  // predicates were imported from the working tree's `b12-run.mjs` — so a
  // dirty validator input would judge the act with code the act does not
  // register. Candidates live under `evidence/` and stay writable.
  const validatorPathspecs = ["src", "scripts", "package.json", "package-lock.json", "tsconfig.json"];
  const dirt = git(repoRoot, ["status", "--porcelain", "--", ...validatorPathspecs]);
  if (dirt.code !== 0) return { ok: false, red: ["git status over the validator inputs failed — their cleanliness cannot be inspected"] };
  const dirtEntries = dirt.out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (dirtEntries.length > 0) {
    return {
      ok: false,
      red: [
        `validator input(s) dirty against expectedHead (${dirtEntries.slice(0, 5).join(", ")}${dirtEntries.length > 5 ? ", …" : ""}) — the gate would judge with code the act does not register; commit or revert them`,
      ],
    };
  }
  const aRel = `evidence/${runId}.b12.tasks.json`;
  const bRel = `evidence/${runId}.b12.manifest-B.tasks.json`;
  let aBytes = null;
  let bBytes = null;
  try {
    aBytes = readFileSync(path.join(repoRoot, aRel), "utf8");
  } catch {
    // Red below — the missing candidate is a check failure, not a crash.
  }
  try {
    bBytes = readFileSync(path.join(repoRoot, bRel), "utf8");
  } catch {
    // Red below.
  }
  // The MEASUREMENTS disk snapshot, at the SAME instant — the sync judges
  // drift against this, and uncommitted rows already on disk are refused
  // below (the registered blob is built from expectedHead's bytes, so an
  // uncommitted suffix would be orphaned by the very act that succeeds).
  let measurementsDisk = null;
  try {
    measurementsDisk = readFileSync(path.join(repoRoot, "MEASUREMENTS.jsonl"), "utf8");
  } catch {
    // Red below via the expectedHead probe.
  }
  // VALIDATE the captured state, nothing else.
  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const red = [];
  const manifestA = aBytes === null ? null : parse(aBytes);
  const manifestB = bBytes === null ? null : parse(bBytes);
  if (manifestA === null) red.push("manifest A is missing or does not parse");
  if (manifestB === null) red.push("manifest B is missing or does not parse — sealed in the SAME act (design.artifacts 2)");
  if (manifestA !== null && manifestB !== null) {
    const pilotId = manifestA?.pilotRunId ?? runId;
    const pilotRel = `evidence/${pilotId}.b12.pilot.json`;
    const pilotProbe = git(repoRoot, ["show", `${expectedHead}:${pilotRel}`]);
    const pilot = pilotProbe.code === 0 ? parse(pilotProbe.out) : null;
    if (pilotProbe.code !== 0 && existsSync(path.join(repoRoot, pilotRel))) {
      red.push("the pilot exists on disk but not at expectedHead — commit it; the act reads OLD inputs from the captured head only");
    }
    red.push(...checkCore(manifestA, manifestB, pilot));
  }
  const sealProbe = git(repoRoot, ["show", `${expectedHead}:evidence/b12-harness-seal.json`]);
  const seal = sealProbe.code === 0 ? parse(sealProbe.out) : null;
  const harness = git(repoRoot, ["show", `${expectedHead}:scripts/b12-run.mjs`]);
  if (seal === null) red.push("no evidence/b12-harness-seal.json at expectedHead — seal-harness is the barrier before any registration");
  else if (harness.code !== 0 || seal.b12RunSha256 !== sha256Text(harness.out)) {
    red.push("the harness seal does not name expectedHead's scripts/b12-run.mjs — the harness moved after sealing");
  }
  const oldMeasurementsProbe = git(repoRoot, ["show", `${expectedHead}:MEASUREMENTS.jsonl`]);
  if (oldMeasurementsProbe.code !== 0) {
    red.push("expectedHead carries no MEASUREMENTS.jsonl — the append-only register must exist before an append");
  } else if (measurementsDisk !== oldMeasurementsProbe.out) {
    red.push(
      "MEASUREMENTS.jsonl on disk differs from expectedHead's — commit the append-only register before the act; an uncommitted suffix would be orphaned by the registration's own sync"
    );
  }
  red.push(...(await gate(repoRoot, runId)));
  if (red.length > 0) return { ok: false, red };
  if (opts.afterCapture) await opts.afterCapture();
  const row =
    JSON.stringify({
      ts: stamp(),
      b12_registration: true,
      run_id: runId,
      manifestSha256: sha256Text(aBytes),
      manifestBSha256: sha256Text(bBytes),
    }) + "\n";
  return casCommit(repoRoot, {
    expectedHeadOverride: expectedHead,
    message: `b12 registration: ${runId}`,
    candidates: [
      { path: aRel, bytes: aBytes, diskBefore: aBytes },
      { path: bRel, bytes: bBytes, diskBefore: bBytes },
      { path: "MEASUREMENTS.jsonl", bytes: oldMeasurementsProbe.out + row, diskBefore: measurementsDisk },
    ],
  });
}

const isMain = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const [cmd, runId] = process.argv.slice(2);
  const repoRoot = process.cwd();
  if (cmd === "seal-harness") {
    const manifestPath = process.argv[4] === undefined ? path.join(repoRoot, "evidence", `${runId}.b12.tasks.json`) : process.argv[4];
    if (!runId) fail("usage: node scripts/b12-register.mjs seal-harness <runId> [manifestPath]");
    const r = sealHarness(repoRoot, manifestPath);
    if (!r.ok) fail(r.why);
    process.stdout.write(`${r.path}\n(commit it; register compares it against expectedHead's harness)\n`);
  } else if (cmd === "check") {
    if (!runId) fail("usage: node scripts/b12-register.mjs check <runId>");
    const red = await runCheck(repoRoot, runId);
    for (const r of red) process.stdout.write(`  RED  ${r}\n`);
    if (red.length > 0) fail(`${red.length} red item(s) — nothing may register`);
    process.stdout.write("check: GREEN\n");
  } else if (cmd === "register") {
    if (!runId) fail("usage: node scripts/b12-register.mjs register <runId>");
    const result = await registerRun(repoRoot, runId);
    if (!result.ok) {
      if (result.red !== undefined) {
        for (const r of result.red) process.stdout.write(`  RED  ${r}\n`);
        fail(`${result.red.length} red item(s) — nothing may register`);
      }
      fail(result.why);
    }
    if (result.postFailure) process.stderr.write(`b12-register: WARNING — ${result.postFailure}\n`);
    process.stdout.write(`registered: ${result.commit}\n(push is the operator's act; the debt is the run itself)\n`);
  } else if (cmd === "open-b") {
    if (!runId) fail("usage: node scripts/b12-register.mjs open-b <runId>");
    // CAPTURE FIRST — every input below is read at `expectedHead`, and a
    // commit landing after this line fails the CAS instead of becoming a
    // baseline whose committed verdict nobody re-read.
    const head = git(repoRoot, ["rev-parse", "HEAD"]);
    if (head.code !== 0) fail("HEAD does not resolve");
    const expectedHead = head.out.trim();
    // Lawful ONLY on a committed `open` — design.artifacts 2: "opened only if
    // run 1 returns `open`".
    const resultProbe = git(repoRoot, ["show", `${expectedHead}:evidence/${runId}.b12.result.json`]);
    if (resultProbe.code !== 0) fail(`expectedHead carries no evidence/${runId}.b12.result.json — run 1 has no committed result`);
    let run1;
    try {
      run1 = JSON.parse(resultProbe.out);
    } catch {
      fail("run 1's committed result does not parse");
    }
    if (run1.verdict !== "open") fail(`run 1's committed verdict is ${JSON.stringify(run1.verdict)} — manifest B opens only on 'open'`);
    // The SEALED B blob, byte-identical from the registration commit.
    const bRel = `evidence/${runId}.b12.manifest-B.tasks.json`;
    const born = git(repoRoot, ["log", expectedHead, "--diff-filter=A", "--format=%H", "--", bRel]);
    const regCommit = born.code === 0 ? born.out.trim().split("\n").filter(Boolean).pop() : undefined;
    if (regCommit === undefined) fail(`${bRel} has no introducing commit at expectedHead`);
    const sealed = git(repoRoot, ["show", `${regCommit}:${bRel}`]);
    const atHead = git(repoRoot, ["show", `${expectedHead}:${bRel}`]);
    if (sealed.code !== 0 || atHead.code !== 0 || sealed.out !== atHead.out) {
      fail("manifest B at expectedHead is not byte-identical to the sealed blob — the replication drifted");
    }
    let manifestB;
    try {
      manifestB = JSON.parse(sealed.out);
    } catch {
      fail("the sealed manifest B does not parse");
    }
    const run2Id = manifestB.runId;
    if (typeof run2Id !== "string" || run2Id === runId) fail("manifest B names no distinct runId for run 2");
    const oldMeasurements = git(repoRoot, ["show", `${expectedHead}:MEASUREMENTS.jsonl`]);
    if (oldMeasurements.code !== 0) fail("expectedHead carries no MEASUREMENTS.jsonl");
    let measurementsDisk = null;
    try {
      measurementsDisk = readFileSync(path.join(repoRoot, "MEASUREMENTS.jsonl"), "utf8");
    } catch {
      // Compared below — an unreadable register is a mismatch by definition.
    }
    if (measurementsDisk !== oldMeasurements.out) {
      fail("MEASUREMENTS.jsonl on disk differs from expectedHead's — commit the append-only register before open-b; an uncommitted suffix would be orphaned by the sync");
    }
    const row =
      JSON.stringify({
        ts: stamp(),
        b12_registration: true,
        run_id: run2Id,
        manifestSha256: sha256Text(sealed.out),
        openedFrom: runId,
      }) + "\n";
    const result = casCommit(repoRoot, {
      expectedHeadOverride: expectedHead,
      message: `b12 registration: ${run2Id} (manifest B of ${runId}, opened on 'open')`,
      candidates: [
        { path: `evidence/${run2Id}.b12.tasks.json`, bytes: sealed.out },
        { path: "MEASUREMENTS.jsonl", bytes: oldMeasurements.out + row, diskBefore: measurementsDisk },
      ],
    });
    if (!result.ok) fail(result.why);
    if (result.postFailure) process.stderr.write(`b12-register: WARNING — ${result.postFailure}\n`);
    process.stdout.write(`run 2 registered: ${result.commit}\n`);
  } else {
    fail("usage: node scripts/b12-register.mjs <check|register|open-b|seal-harness> <runId>");
  }
}
