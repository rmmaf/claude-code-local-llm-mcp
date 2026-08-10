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
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * The shared-index half of the concurrency story (the sixth diff round's
 * first finding): each observation runs in its own worktree, but the evidence
 * commit runs in THIS repository, and two concurrent observations contend on
 * `.git/index.lock`. Git's own lock already prevents corruption; what it
 * hands the loser is a visible failure — so the loser RETRIES, bounded,
 * instead of refusing an observation that already paid for its session. Any
 * failure that is not lock contention gives up immediately, and the
 * staged-emptiness wall inside the loop is the same wall as before.
 *
 * It RETURNS the reason (null = committed) rather than calling `refuse`,
 * because it now runs inside the run's commit lock and `process.exit` would
 * strand that lock (R18). The caller refuses.
 */
async function gitCommitEvidenceRetrying(repoRoot, relDir, relLog, message) {
  const LOCKED = /index\.lock|Another git process|could not lock/i;
  for (let attempt = 1; ; attempt++) {
    const add = run("git", ["-C", repoRoot, "add", "--", relDir, relLog]);
    if (add.code === 0) {
      const staged = run("git", ["-C", repoRoot, "diff", "--cached", "--name-only", "--", relDir]);
      if (staged.code !== 0) return `git diff --cached failed: ${(staged.err.trim() || staged.out.trim()).slice(0, 300)}`;
      if (staged.out.trim() === "") return `nothing staged under ${relDir} — the archive did not reach the index`;
      const commit = run("git", ["-C", repoRoot, "commit", "-m", message, "--", relDir, relLog]);
      if (commit.code === 0) return null;
      if (!LOCKED.test(`${commit.err}\n${commit.out}`) || attempt >= 5) {
        return `git commit failed after ${attempt} attempt(s): ${(commit.err.trim() || commit.out.trim()).slice(0, 300)}`;
      }
    } else if (!LOCKED.test(`${add.err}\n${add.out}`) || attempt >= 5) {
      return `git add failed after ${attempt} attempt(s): ${(add.err.trim() || add.out.trim()).slice(0, 300)}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
  }
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

/**
 * The session id, UNIQUE PER ATTEMPT BY CONSTRUCTION. `stamp()` has ONE-SECOND
 * resolution, so the old `manifestSha:task:arm:stamp` input minted the SAME id
 * for two attempts of one task/arm inside a second — and for two processes
 * racing the same task. The nonce ends the collision; `acquireSessionLock`
 * below makes the race itself a refusal instead of an interleaving. The audit
 * computer's clause-5 anchor joins runlog rows by sessionId + (runId, taskId,
 * arm) and REQUIRES that join bijective, so uniqueness here is load-bearing,
 * not hygiene.
 */
export function mintSessionId(manifestSha, runId, taskId, arm) {
  return createHash("sha256")
    .update(`${manifestSha}:${runId}:${taskId}:${arm}:${stamp()}:${randomUUID()}`)
    .digest("hex")
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
}

/**
 * One (runId, taskId, arm) in flight at a time, CROSS-PROCESS: `mkdir` is the
 * OS's own atomic claim, the same primitive `claimObsDir` stands on. A crash
 * or a mid-observation refusal leaves the lock behind ON PURPOSE — the next
 * invocation refuses with the path in hand, and the operator removes it only
 * after confirming no live process. Stealing a lock silently is how two
 * observations end up interleaved in one runlog.
 */
export function acquireSessionLock(evidenceDir, runId, taskId, arm) {
  const lockDir = path.join(evidenceDir, `.session-lock-${runId}-${taskId}-${arm}`);
  try {
    mkdirSync(lockDir);
  } catch (error) {
    if (error?.code === "EEXIST") return { ok: false, lockDir, release: () => {} };
    throw error;
  }
  return {
    ok: true,
    lockDir,
    release: () => {
      try {
        rmdirSync(lockDir);
      } catch {
        // Released is released; a second release or an already-removed lock
        // must not fail the observation that finished its work.
      }
    },
  };
}

/**
 * ONE RUN-WIDE claim, held only across [re-check, append, commit, verify] —
 * `mkdir` again, the same atomic primitive as the session lock and the obs
 * dir. The session lock cannot do this job: it is keyed by (runId, taskId,
 * arm), so two observations of DIFFERENT tasks hold different locks and
 * interleave freely, which is exactly the case R18 found.
 */
export function acquireRunlogLock(evidenceDir, runId) {
  const lockDir = path.join(evidenceDir, `.runlog-lock-${runId}`);
  try {
    mkdirSync(lockDir);
  } catch (error) {
    if (error?.code === "EEXIST") return { ok: false, lockDir, release: () => {} };
    throw error;
  }
  return {
    ok: true,
    lockDir,
    release: () => {
      try {
        rmdirSync(lockDir);
      } catch {
        // Same doctrine as the session lock: released is released.
      }
    },
  };
}

/**
 * THE ROW AND ITS EVIDENCE, AS ONE ACT (R18's second finding).
 *
 * The row is appended to a SHARED file and the commit that carries it names
 * that file, so `git commit -- <dir> <runlog>` takes the runlog's WHOLE
 * current content. Two observations in flight together therefore had this
 * shape: A appends, B appends, A commits — and A's commit carries B's ROW
 * WITHOUT B'S ARCHIVE. If B then dies, HEAD holds a row with nothing durable
 * behind it forever, which is the runlog↔evidence bijection the audit's
 * clause-5 anchor joins on.
 *
 * R11 declined exactly this lock, reasoning that the barrier's equality gives
 * the same guarantee "refusal-shaped". That premise was false and R18 named
 * it: the barrier is checked at the START of an observation, minutes before
 * the row exists, so BOTH processes pass it before EITHER appends. Equality
 * serializes only a process that starts after another has appended. The
 * liveness objection survives and is answered by the shape rather than the
 * decision — the lock spans seconds (a bounded, retrying commit), never the
 * session, and waiting for it is bounded too, with the path named on refusal.
 *
 * Everything fallible inside RETURNS its reason: a `process.exit` in here
 * would strand the lock for the whole run.
 */
export async function commitObservationRow(
  repoRoot,
  { evidenceDir, runId, runLogRel, relDir, written, row, sessionId, message, runlogAtBarrier, branchRef, lockAttempts = 20, lockWaitMs = 250 }
) {
  const runLogPath = path.join(repoRoot, runLogRel);
  const readRunlog = () => (existsSync(runLogPath) ? readFileSync(runLogPath, "utf8") : null);
  // THE BRANCH IS PART OF THE ACT (R26). `git commit` writes to whatever HEAD
  // names NOW, and an observation runs for minutes: a checkout in this
  // repository — an operator, another agent — moves that target. On a branch
  // cut from the same commit the runlog barrier still passes, the commit
  // succeeds, and every HEAD-based verification agrees, so the act reports
  // success while the paid observation and its ordering row live on a branch
  // the run is not on. The register's CAS captured its ref for exactly this
  // reason; the observation captured nothing.
  const refNow = () => {
    const r = run("git", ["-C", repoRoot, "symbolic-ref", "--quiet", "HEAD"]);
    return r.code === 0 ? r.out.trim() : null;
  };
  let lock = acquireRunlogLock(evidenceDir, runId);
  for (let attempt = 1; !lock.ok && attempt < lockAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, lockWaitMs));
    lock = acquireRunlogLock(evidenceDir, runId);
  }
  if (!lock.ok) {
    return {
      ok: false,
      why:
        `another observation holds this run's commit lock (${lock.lockDir}) and did not release it — its row and evidence ` +
        `commit as one act; remove the lock only after confirming no live process`,
    };
  }
  try {
    // BEFORE ANYTHING IS WRITTEN: the branch this observation started on must
    // still be the one a commit would land on. Refusing here costs the
    // session and nothing else; discovering it afterwards costs the run.
    if (typeof branchRef === "string" && branchRef !== "") {
      const here = refNow();
      if (here === null) {
        return {
          ok: false,
          why: `HEAD is detached now and this observation started on ${branchRef} — its evidence commit would belong to no branch; nothing was appended`,
        };
      }
      if (here !== branchRef) {
        return {
          ok: false,
          why: `HEAD moved to ${here} while this observation ran on ${branchRef} — the evidence commit would land on another branch and the run would silently lose it; nothing was appended`,
        };
      }
    }
    const headProbe = run("git", ["-C", repoRoot, "show", `HEAD:${runLogRel}`]);
    const headText = headProbe.code === 0 ? headProbe.out : null;
    const diskText = readRunlog();
    // THE BARRIER AGAIN, now inside the mutex: an uncommitted row belonging to
    // another observation would be swept into OUR commit without its archive.
    const barrier = runlogBarrierViolation(diskText, headText);
    if (barrier) return { ok: false, why: `${barrier} — re-checked under this run's commit lock, before any row was appended` };
    // AND STRICTER THAN THE BARRIER: byte-equality with what the barrier saw
    // when this observation STARTED. Disk and HEAD agreeing again would also
    // describe another observation that began and finished inside this one —
    // legal-looking bytes, and precisely what artifact 6 ("committed at each
    // task's END, BEFORE THE NEXT TASK STARTS") forbids. Nothing else writes
    // this file, so a difference has exactly one cause.
    if (diskText !== runlogAtBarrier) {
      return {
        ok: false,
        why:
          `the runlog changed while this observation was in flight — another observation ran inside this one, which ` +
          `design.artifacts 6 forbids (committed at each task's END, BEFORE the next task starts); nothing was appended`,
      };
    }
    // THE BIJECTION HALF: a sessionId may appear in the runlog ONCE. The nonce
    // makes a collision astronomically unlikely; asserting it makes a collision
    // — or a copied row — a refusal instead of a silently ambiguous join in the
    // audit's clause-5 anchor.
    for (const line of (diskText ?? "").split("\n")) {
      if (!line.trim()) continue;
      try {
        if (JSON.parse(line).sessionId === sessionId) {
          return { ok: false, why: `sessionId ${sessionId} already appears in the runlog — the (runId, taskId, arm, attempt) ↔ sessionId bijection would break` };
        }
      } catch {
        // A corrupt line is the scorer's finding, not this guard's.
      }
    }
    // APPEND, never read-concat-write: the old shape lost rows under two
    // concurrent observes (both read, both write, one row gone) — and a missing
    // row is what the scorer's replay now refuses the whole order over. A
    // single-line O_APPEND write is the atomic unit the log was designed around.
    // `design.artifacts` 10: the `ts` is read from the clock in the same
    // command that writes the row — and read HERE, not before the wait for
    // the lock, so it stamps the write rather than the intention.
    const appended = JSON.stringify({ ts: stamp(), ...row }) + "\n";
    appendFileSync(runLogPath, appended, "utf8");
    // What the runlog MUST read afterwards, on disk and in HEAD alike: the
    // bytes the barrier accepted, plus this one row. Held here so the
    // postcondition below compares against a value fixed BEFORE the commit
    // rather than against whatever the commit left behind.
    const expectedRunlog = (runlogAtBarrier ?? "") + appended;
    const failure = await gitCommitEvidenceRetrying(repoRoot, relDir, runLogRel, message);
    if (failure) {
      return {
        ok: false,
        why: `${failure} — the row is on disk UNCOMMITTED and the archive is not in HEAD; the next observation's barrier will refuse until an operator reconciles both`,
      };
    }
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
    // VERIFIED AGAINST THE BRANCH, NOT AGAINST `HEAD` (R26). They are the same
    // thing only while nothing moved — and if something did move after the
    // commit, the branch is still where the evidence has to be, so the branch
    // is what the claim is about.
    const verifyRef = typeof branchRef === "string" && branchRef !== "" ? branchRef : "HEAD";
    for (const name of written) {
      const rel = `${relDir}/${name}`;
      const onDisk = run("git", ["-C", repoRoot, "hash-object", "--", path.join(repoRoot, relDir, name)]);
      if (onDisk.code !== 0) return { ok: false, why: `hash-object failed for ${rel}` };
      const inHead = run("git", ["-C", repoRoot, "rev-parse", `${verifyRef}:${rel}`]);
      if (inHead.code !== 0) return { ok: false, why: `${verifyRef} does not carry ${rel} after the commit` };
      if (inHead.out.trim() !== onDisk.out.trim()) {
        return { ok: false, why: `${verifyRef} carries a different ${rel}: ${inHead.out.trim().slice(0, 12)} != ${onDisk.out.trim().slice(0, 12)}` };
      }
    }
    // AND THE ROW ITSELF, WHICH THE LOOP ABOVE COULD NOT REACH (R25).
    //
    // `written` holds the per-observation artifacts; the runlog is the OTHER
    // path this commit names, and nothing verified it. The very hook the
    // comment above accounts for can drop or rewrite the runlog entry in the
    // index while leaving `observation.json` staged: the add succeeds, the
    // staged wall passes (it looks under `relDir`), the commit succeeds, every
    // blob above matches — and HEAD holds an observation with NO ORDERING ROW,
    // while the disk copy carries one. The caller would then release the
    // session lock and report success, and the next observation's barrier
    // would refuse a run that believes it is fine. "The row and its evidence
    // as ONE act" has to be provable of the row too, or it is a claim about
    // half the act.
    //
    // Two comparisons, because they fail differently: disk against the bytes
    // the barrier accepted PLUS this one row (a hook that rewrote the working
    // copy), and HEAD's blob against disk (a hook that rewrote only the
    // index). Together they say HEAD carries exactly the predecessor bytes and
    // exactly this session's row — stronger than counting the sessionId, and
    // the same function of the same bytes on both sides.
    const diskAfter = readRunlog();
    if (diskAfter !== expectedRunlog) {
      return {
        ok: false,
        why:
          `the runlog on disk is not the bytes this observation appended — ${diskAfter === null ? "the file is gone" : "it was rewritten"} ` +
          `between the append and the commit's verification, so the committed row cannot be attributed to this act`,
      };
    }
    const runlogOnDisk = run("git", ["-C", repoRoot, "hash-object", "--", runLogPath]);
    if (runlogOnDisk.code !== 0) return { ok: false, why: `hash-object failed for ${runLogRel}` };
    const runlogInHead = run("git", ["-C", repoRoot, "rev-parse", `${verifyRef}:${runLogRel}`]);
    if (runlogInHead.code !== 0) {
      return {
        ok: false,
        why: `${verifyRef} does not carry ${runLogRel} after the commit — the evidence committed WITHOUT its ordering row (design.artifacts 6)`,
      };
    }
    if (runlogInHead.out.trim() !== runlogOnDisk.out.trim()) {
      return {
        ok: false,
        why:
          `${verifyRef} carries a different ${runLogRel}: ${runlogInHead.out.trim().slice(0, 12)} != ${runlogOnDisk.out.trim().slice(0, 12)} — ` +
          `the evidence committed without this observation's row, or with a rewritten one (design.artifacts 6)`,
      };
    }
    return { ok: true };
  } finally {
    lock.release();
  }
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
  // Per-file id PRESENCE, for the slug-coverage predicate. Collected in the
  // same loop, BEFORE the uuid dedup: a resumed session's copy in a second
  // file carries the same uuid and the same requestId, and the dedup exists to
  // count billable records once — the id is still PRESENT in that file, and
  // presence in a slug is exactly what "the run wrote to it" means.
  const perFileIds = new Map();
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
    const fileIds = new Set();
    perFileIds.set(file, fileIds);
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
      if (typeof r.requestId === "string") fileIds.add(r.requestId);
      if (typeof r.uuid === "string") {
        if (seenUuid.has(r.uuid)) continue;
        seenUuid.add(r.uuid);
      }
      records++;
      if (typeof r.requestId === "string") ids.add(r.requestId);
    }
  }
  return { ids, records, fileHashes, perFileIds };
}

export function takeSnapshot(rootOverride, identity = null) {
  const dirs = projectSlugDirs(rootOverride);
  // ONE walk per directory, reused for the flat file list AND the slug
  // attribution below — two walks over one corpus is how two quantities come
  // to describe different sets of files.
  const dirFiles = dirs.map((d) => ({ slug: path.basename(d), files: jsonlUnder(d) }));
  const files = dirFiles.flatMap((s) => s.files);
  const { ids, records, fileHashes, perFileIds } = admittedRequestIds(files);
  if (dirs.length === 0 || ids.size === 0) {
    refuse(`snapshot covered ${dirs.length} slug(s) and collected ${ids.size} ids — a zero here is a scoping error, not an empty machine`);
  }
  // WHICH slugs carry WHICH ids — the populations of `voidConditions` 6/14's
  // "covered fewer slugs than it wrote to". A count cannot express it: a write
  // into a NEW slug while another slug vanished leaves the count level.
  const slugRequestIds = {};
  for (const { slug, files: slugFiles } of dirFiles) {
    const set = new Set();
    for (const f of slugFiles) for (const id of perFileIds.get(f) ?? []) set.add(id);
    slugRequestIds[slug] = [...set].sort();
  }
  return {
    ts: stamp(),
    // WHOSE snapshot this is (R7: written stamps that nothing parses detect
    // nothing — the scorer CHECKS these against directory, runlog and record,
    // so a snapshot swapped between attempts is a firing, not a guess).
    ...(identity === null ? {} : { identity }),
    slugsWalked: dirs.length,
    slugs: dirFiles.map((s) => s.slug),
    slugRequestIds,
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
  coveredSlugs,
  writtenSlugs,
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
  // `voidConditions` 6/14's OWN predicate: "a run whose snapshot covered fewer
  // slugs than it wrote to". The populations are SETS, not counts — a write
  // into a new slug while another vanished leaves the count level, and the
  // shrink check above is a different fact. Handed, never inferred; a rule not
  // handed its populations REFUSES rather than assumes them disjoint — fields
  // this rule was never handed are the first defect family named at the top.
  if (!Array.isArray(coveredSlugs) || !Array.isArray(writtenSlugs)) {
    reasons.push(
      "the covered/written slug populations were not handed to the rule — refused rather than assumed covered"
    );
  } else {
    const covered = new Set(coveredSlugs);
    const outside = writtenSlugs.filter((s) => !covered.has(s));
    if (outside.length > 0) {
      reasons.push(
        `snapshot covered fewer slugs than the run wrote to: ${outside.join(", ")} carr${outside.length === 1 ? "ies" : "y"} originated ids outside the pre-snapshot's coverage`
      );
    }
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
/**
 * The observation directory's name, attempt N. `admissionRule` 12 archives BOTH
 * attempts of a re-run, and one name per task/arm cannot hold two — so a first
 * attempt is `obs-<taskId>-<arm>` (every existing archive keeps its name) and a
 * re-run is `obs-<taskId>-<arm>-r<N>`. The scorer's `parseObsDirName`
 * (`src/cost/b12/archive.ts`) reads this grammar back; the round trip is the
 * negative control in `tests/cost-meter.test.ts`.
 */
export function obsDirName(taskId, arm, attempt) {
  return `obs-${taskId}-${arm}${attempt === 1 ? "" : `-r${attempt}`}`;
}

/**
 * Claim the observation directory ATOMICALLY. The exists-then-create shape had
 * a race: two `observe` processes for one task/arm could both see attempt N
 * free, then overwrite each other's six files — destroying exactly what
 * `admissionRule` 12 preserves (the third adversarial round on the UNIT-5
 * diff). A NON-recursive `mkdirSync` is the claim: the filesystem hands the
 * directory to exactly one caller, the loser gets `EEXIST` and tries N+1.
 */
export function claimObsDir(runEvidenceDir, taskId, arm) {
  mkdirSync(runEvidenceDir, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const dir = path.join(runEvidenceDir, obsDirName(taskId, arm, attempt));
    try {
      mkdirSync(dir);
      return { dir, attempt };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

export function manifestDeclarationGaps(manifest) {
  const gaps = [];
  const str = (v) => typeof v === "string" && v.length > 0;
  const need = (cond, msg) => {
    if (!cond) gaps.push(msg);
  };
  const pinned = manifest?.pinned ?? {};

  // IDS ARE PATH SEGMENTS, SO THEY GET A GRAMMAR. A sixth adversarial round
  // found `task.id` interpolated into the worktree path and handed to a
  // recursive delete — an id of `../../target` escaped `.b12/` and erased an
  // unrelated directory before git ever ran. `runId` has the same job in
  // `evidence/<runId>/…`, so both are held to one safe-filename grammar; the
  // containment assert in `observe` is the second wall, not the only one.
  const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  need(
    str(manifest?.runId) && SAFE_ID.test(manifest.runId),
    "manifest.runId is absent or not a safe path segment ([A-Za-z0-9][A-Za-z0-9_-]{0,63}) — it names evidence/<runId>/… on disk, and artifact 1's whole naming scheme hangs off it"
  );

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
  // Artifact 1: "the sha256 of ... the out-of-repo per-arm policy blobs" —
  // sealed as git provenance, `{repo, commit, path, sha256}` per arm (the
  // tuple schema is this harness's; the required content is the frozen
  // text's). SHAPE only here — this sweep is pure, so reachability of the
  // sealed object belongs to `findPolicyBlob`, which may run git.
  if (pinned.policyBlobs === null || typeof pinned.policyBlobs !== "object") {
    need(
      false,
      'pinned.policyBlobs is absent — artifact 1: "the sha256 of ... the out-of-repo per-arm policy blobs"; voidConditions 12 voids any record without its arm\'s blob hash'
    );
  } else {
    for (const armName of ["treatment", "control"]) {
      const parsed = parsePolicyBlobSpec(pinned.policyBlobs[armName], armName);
      if (!parsed.ok) need(false, parsed.why);
    }
  }
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

  // ONE ID, ONE DECLARATION — a duplicated task id would hand the scorer's
  // by-id joins to POSITION (the last declaration silently wins) and its
  // entry-walking selection the same observation once per entry (the seventh
  // adversarial round). Refused here, in the pre-registration window, before
  // anything is spent under an id two declarations claim.
  const seenTaskIds = new Set();
  for (const t of manifest?.tasks ?? []) {
    const id = t?.id ?? "(unnamed task)";
    const tneed = (cond, msg) => {
      if (!cond) gaps.push(`task ${id} ${msg}`);
    };
    tneed(
      !seenTaskIds.has(t?.id),
      "is declared more than once — one id, one declaration; the scorer's by-id joins cannot decide which declaration governs a duplicated id (design.artifacts 1)"
    );
    if (str(t?.id)) seenTaskIds.add(t.id);
    tneed(
      str(t?.id) && SAFE_ID.test(t.id),
      "carries no id, or an id that is not a safe path segment ([A-Za-z0-9][A-Za-z0-9_-]{0,63}) — the id names the worktree directory a recursive delete targets"
    );
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
  // admissionRule 7's OWN predicate, over EVERY declared scope — "no manifest
  // task's file scope may intersect" the instrument set, and "no manifest
  // task's" is the whole pre-registered list, not the admitted twenty. The
  // scorer carries the TypeScript twin (`src/cost/b12/filescope.ts`); the
  // conformance suite compares the two case-for-case.
  for (const violation of fileScopeViolations(
    (Array.isArray(manifest?.tasks) ? manifest.tasks : []).map((t) => ({
      id: str(t?.id) ? t.id : "(unnamed)",
      fileScope: Array.isArray(t?.fileScope) ? t.fileScope : null,
    }))
  )) {
    gaps.push(violation);
  }
  return gaps;
}

/** The instrument set admissionRule 7 protects, spelled once. */
export const PROTECTED_SCOPES = [
  "src/cost/**",
  "scripts/session-token-walk.mjs",
  "evidence/**",
  "PREMISES.md",
  "ROADMAP.md",
  "DECISIONS.md",
  "STATE.md",
];

/**
 * admissionRule 7's grammar and intersection, the harness's copy. Exactly
 * three accepted forms — literal file, directory prefix ending `/`, recursive
 * suffix `/**` — with the prohibited shapes (drive, UNC, absolute) rejected
 * BEFORE `\` normalizes to `/` and the terminal marker detached BEFORE the
 * core segments are judged, so the lawful trailing `/` never reads as the
 * empty segment the grammar forbids. `dir/` and `dir/**` cover alike ON
 * PURPOSE. The scorer's TypeScript twin lives in `src/cost/b12/filescope.ts`;
 * two copies exist because this file must run before `dist/` does, and the
 * conformance suite is what keeps them from drifting.
 */
export function parseScopeEntry(raw) {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, error: "not a non-empty string" };
  if (/^[A-Za-z]:/.test(raw)) return { ok: false, error: `drive-qualified path: ${raw}` };
  if (raw.startsWith("\\\\") || raw.startsWith("//")) return { ok: false, error: `UNC path: ${raw}` };
  if (raw.startsWith("/") || raw.startsWith("\\")) return { ok: false, error: `absolute path: ${raw}` };
  let s = raw.split("\\").join("/");
  let kind = "file";
  if (s.endsWith("/**")) {
    kind = "recursive";
    s = s.slice(0, -3);
  } else if (s.endsWith("/")) {
    kind = "dir";
    s = s.slice(0, -1);
  }
  if (s === "") return { ok: false, error: `no core segments: ${raw}` };
  const segments = s.split("/");
  for (const seg of segments) {
    if (seg === "") return { ok: false, error: `empty segment: ${raw}` };
    if (seg === "." || seg === "..") return { ok: false, error: `dot segment: ${raw}` };
    // WINDOWS ALIASES — REFUSED, not folded. Win32 strips TRAILING dots and
    // spaces from a component, so `src/cost./**` opens `src/cost` while
    // comparing unequal to it; `:` names an NTFS stream or a drive-relative
    // path; `NAME~1.EXT` is the 8.3 short name of a long one. Case is folded
    // because a case-shifted path is lawful; these are degenerate spellings.
    if (/[. ]$/.test(seg)) return { ok: false, error: `segment ends in a dot or space, which Windows strips: ${raw}` };
    if (seg.includes(":")) return { ok: false, error: `colon in a segment (NTFS stream or drive-relative): ${raw}` };
    if (/~[0-9]/.test(seg)) return { ok: false, error: `8.3 short-name alias shape: ${raw}` };
    if (/[*?[\]{}]/.test(seg)) return { ok: false, error: `glob outside a trailing /**: ${raw}` };
  }
  return { ok: true, kind, segments };
}

export function scopesIntersect(a, b) {
  // CASE-FOLDED comparison (ASCII): Windows and default macOS filesystems
  // alias case, so `SRC/COST/` is `src/cost/**`'s tree wearing different
  // bytes. The declared form is preserved; only the comparison folds.
  const isPrefix = (x, y) => x.length <= y.length && x.every((seg, i) => seg.toLowerCase() === y[i].toLowerCase());
  const covers = (x, y) => x.kind !== "file" && isPrefix(x.segments, y.segments);
  if (covers(a, b) || covers(b, a)) return true;
  return a.kind === "file" && b.kind === "file" && a.segments.length === b.segments.length && isPrefix(a.segments, b.segments);
}

export function fileScopeViolations(tasks) {
  const out = [];
  const protectedParsed = PROTECTED_SCOPES.map((p) => ({ raw: p, parsed: parseScopeEntry(p) }));
  for (const task of tasks) {
    if (task.fileScope === null || task.fileScope === undefined) continue;
    for (const raw of task.fileScope) {
      const parsed = parseScopeEntry(raw);
      if (!parsed.ok) {
        out.push(`task ${task.id}: file scope entry rejected by the grammar — ${parsed.error} (admissionRule 7)`);
        continue;
      }
      for (const p of protectedParsed) {
        if (p.parsed.ok && scopesIntersect(parsed, p.parsed)) {
          out.push(`task ${task.id}: file scope ${String(raw)} intersects the instrument set at ${p.raw} (admissionRule 7)`);
        }
      }
    }
  }
  return out;
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
  const ranBefore = new Set();
  for (const line of (runlogText ?? "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return `the runlog carries a line that is not JSON — the persisted progress is corrupt: ${line.slice(0, 80)}`;
    }
    if (row.arm === "treatment") ranBefore.add(row.taskId);
  }
  // A RE-RUN IS NOT AN ORDER EVENT. The committed order fixes the sequence of
  // FIRST executions; `admissionRule` 12 governs re-runs (their count, their
  // base commit) and carries no temporal clause, so a late re-run of an
  // earlier task is permitted here and adjudicated at scoring over this same
  // runlog. The first shape of this guard refused it — an over-strictness
  // corrected in the same round that fixed the hole below.
  if (ranBefore.has(taskId)) return null;
  // A FIRST run needs EVERY predecessor already executed — a fifth adversarial
  // round found the monotonic half alone let task 2 start on an empty runlog:
  // nothing had run "after" it, so nothing fired, and the session was spent on
  // a run already void under `voidConditions` 3.
  const missing = tasks.filter((t, i) => i < currentIndex && !ranBefore.has(t?.id)).map((t) => t?.id);
  if (missing.length > 0) {
    return (
      `task ${taskId} (index ${currentIndex}) cannot run first: predecessor task(s) ${missing.join(", ")} ` +
      "have not run — the manifest's committed order was not followed (voidConditions 3)"
    );
  }
  for (const ranId of ranBefore) {
    const idx = tasks.findIndex((t) => t?.id === ranId);
    if (idx > currentIndex) {
      return `task ${taskId} (index ${currentIndex}) would first-run after ${ranId} (index ${idx}) already ran — the manifest's committed order was not followed (voidConditions 3)`;
    }
  }
  return null;
}

/**
 * ARTIFACT 6'S BARRIER, checked where the NEXT task starts: the runlog on
 * disk must be byte-identical to HEAD's committed copy before any new
 * observation spends anything. A runlog row is appended BEFORE its evidence
 * commit (the commit includes the row), so between append and commit the row
 * exists on disk as an apparent predecessor with nothing durable behind it —
 * and a FAILED commit leaves it that way forever. Equality makes a row
 * visible as an ordering predecessor only once it is committed; both
 * directions refuse (an uncommitted suffix AND a truncated disk copy), and
 * the refusal is the cross-process serialization — the second process stops
 * instead of ordering itself against evidence that may never exist.
 */
export function runlogBarrierViolation(diskText, headText) {
  if (diskText === null && headText === null) return null; // the first observation
  if (diskText === headText) return null;
  if (headText === null) {
    return (
      "the runlog exists on disk but HEAD carries no committed copy — a previous observation's evidence commit " +
      "did not complete (design.artifacts 6: committed at each task's end, BEFORE the next task starts)"
    );
  }
  if (diskText === null) {
    return "HEAD carries a committed runlog but the disk copy is missing — the persisted progress record was truncated";
  }
  return (
    "the runlog on disk differs from HEAD's committed copy — a previous observation's evidence commit did not " +
    "complete or failed (design.artifacts 6's barrier holds every next task until the predecessor is committed)"
  );
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
 * One arm's policy-blob declaration parsed against the seal grammar, PURE — no
 * git, no disk — so `manifestDeclarationGaps` can hold the shape in the
 * pre-registration window while `findPolicyBlob` holds the object store.
 */
function parsePolicyBlobSpec(raw, arm) {
  const bad = (why) => ({ ok: false, why: `pinned.policyBlobs.${arm} ${why}` });
  if (raw === null || typeof raw !== "object") {
    return bad(
      'must be a {repo, commit, path, sha256} provenance tuple — artifact 1: "the sha256 of ... the out-of-repo per-arm policy blobs", and a bare path seals no history for that hash to live in'
    );
  }
  const { repo, commit, path: blobPath, sha256 } = raw;
  if (typeof repo !== "string" || repo.length === 0) return bad("declares no repo — the policy repository's locator");
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    return bad(
      `must pin a FULL 40-hex commit (got ${JSON.stringify(commit ?? null)}) — an abbreviation can become ambiguous as the policy repo grows`
    );
  }
  if (typeof blobPath !== "string" || blobPath.length === 0) return bad("declares no path inside the policy repo");
  if (
    blobPath.includes("\\") ||
    blobPath.startsWith("/") ||
    /^[A-Za-z]:/.test(blobPath) ||
    blobPath.split("/").some((s) => s === "" || s === "." || s === "..")
  ) {
    return bad(
      `path ${JSON.stringify(blobPath)} is not a plain forward-slash path relative to the policy repo root — git object paths have one spelling`
    );
  }
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    return bad("must carry the blob's 64-hex sha256 — required, not compared-if-present (design.artifacts 1)");
  }
  return { ok: true, spec: { repo, commit, path: blobPath, sha256 } };
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
 * "COMMITTED out-of-repo blob" is taken at its word: the policy lives in its
 * OWN git repository and the manifest seals `{repo, commit, path, sha256}` per
 * arm — the provenance model `committedEvidenceCheck` applies to the probe,
 * pointed at a foreign object store. The previous schema (a live file path
 * plus a separate hash) was committed NOWHERE: the seal could be satisfied by
 * editing file and hash together, and nothing tied the bytes an arm received
 * to bytes anyone reviewed. Delivery now reads the object store directly
 * (`git -C <repo> cat-file blob <commit>:<path>`), so no working-tree file
 * exists to move mid-arm at all; the sha256 stays REQUIRED and is re-verified
 * against the delivered bytes (`design.artifacts` 1).
 *
 * Transport is part of the check: pushing the repository under test does NOT
 * carry `../b12-policy`, so the run machine receives the policy repo as a
 * hashed git bundle (or its own remote) BEFORE the probes and clones it to
 * the manifest's locator. A missing repo names that step; a SHALLOW clone is
 * refused because an object store that cannot prove its history cannot prove
 * the sealed commit either.
 */
export function findPolicyBlob(manifest, arm) {
  const blobs = manifest.pinned?.policyBlobs;
  if (!blobs || typeof blobs !== "object") {
    return {
      blob: null,
      why:
        "manifest.pinned.policyBlobs must declare BOTH arms' out-of-repo policy blobs — " +
        "voidConditions 12 voids any observation record without its arm's blob hash, " +
        "so a manifest without blobs cannot produce a compliant observation",
    };
  }
  // BOTH arms parse before EITHER resolves: a pair whose other arm cannot run
  // was never a pair.
  const specs = {};
  for (const armName of ["treatment", "control"]) {
    const parsed = parsePolicyBlobSpec(blobs[armName], armName);
    if (!parsed.ok) return { blob: null, why: parsed.why };
    specs[armName] = parsed.spec;
  }
  const spec = specs[arm];
  const repoDir = path.resolve(REPO, spec.repo);
  // "The delegation policy leaves the repository under test entirely" (CHANNEL
  // 5). A policy repo resolving INSIDE this repository — which contains every
  // `.b12/` arm worktree — is in-repo policy wearing an out-of-repo name.
  const relToRepo = path.relative(REPO, repoDir);
  if (!relToRepo.startsWith("..") && !path.isAbsolute(relToRepo)) {
    return {
      blob: null,
      why: `the ${arm} policy repo resolves to ${repoDir}, inside the repository under test — the policy must leave it entirely (CHANNEL 5)`,
    };
  }
  if (!existsSync(repoDir)) {
    return {
      blob: null,
      why:
        `the ${arm} policy repo ${spec.repo} resolves to ${repoDir}, which does not exist — ` +
        "transport the hashed policy bundle and clone it there BEFORE the probes; pushing the repository under test does not carry it",
    };
  }
  const shallow = run("git", ["-C", repoDir, "rev-parse", "--is-shallow-repository"]);
  if (shallow.code !== 0) {
    return {
      blob: null,
      why: `the ${arm} policy repo at ${repoDir} is not a git repository (${(shallow.err.trim() || shallow.out.trim()).slice(0, 200)}) — the seal is git provenance, so delivery must read a git object store`,
    };
  }
  if (shallow.out.trim() === "true") {
    return {
      blob: null,
      why: `the ${arm} policy repo at ${repoDir} is a SHALLOW clone — an object store that cannot prove its history cannot prove the sealed commit; clone the full bundle`,
    };
  }
  const commitExists = run("git", ["-C", repoDir, "cat-file", "-e", `${spec.commit}^{commit}`]);
  if (commitExists.code !== 0) {
    return {
      blob: null,
      why: `sealed commit ${spec.commit} is not reachable in the ${arm} policy repo at ${repoDir} — the transported clone does not carry the sealed history`,
    };
  }
  // RAW BYTES, not the utf8-decoding `run` helper: the sealed sha256 is over
  // the blob's bytes, and hashing a re-encoding would let a byte the decoder
  // repaired slip between the seal and the hash.
  const shown = spawnSync("git", ["-C", repoDir, "cat-file", "blob", `${spec.commit}:${spec.path}`], { maxBuffer: 1 << 28 });
  if (shown.status !== 0) {
    const detail = (shown.stderr ? shown.stderr.toString("utf8").trim() : "") || String(shown.error?.code ?? "unknown error");
    return {
      blob: null,
      why: `${spec.commit.slice(0, 12)}:${spec.path} is not readable in the ${arm} policy repo (${detail.slice(0, 200)})`,
    };
  }
  const bytes = shown.stdout ?? Buffer.alloc(0);
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    return {
      blob: null,
      why: `the ${arm} policy blob at ${spec.commit.slice(0, 12)}:${spec.path} is not valid UTF-8 text — delivery is an argv string (--append-system-prompt), which cannot carry these bytes exactly`,
    };
  }
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== spec.sha256) {
    return { blob: null, why: `policy blob (${arm}) sha256 ${got} != sealed ${spec.sha256} — the policy moved under the seal` };
  }
  return {
    blob: {
      repo: spec.repo,
      repoDir,
      commit: spec.commit,
      path: spec.path,
      sha256: got,
      content,
      declaredPath: `${spec.repo}@${spec.commit}:${spec.path}`,
    },
    why: null,
  };
}

function resolvePolicyBlob(manifest, arm) {
  const { blob, why } = findPolicyBlob(manifest, arm);
  if (blob === null) refuse(why);
  return blob;
}

/**
 * The live re-read for the pre/post instruction-hash pair: the same object,
 * fetched again, hashed again. Git objects are immutable, so a drift here does
 * not mean a FILE moved — none exists — it means the OBJECT STORE did (repo
 * deleted, replaced, or pruned mid-arm), which breaks `voidConditions` 12's
 * one-hash-per-record requirement exactly the way a moved file did.
 */
function policyBlobLiveSha256(blob) {
  const shown = spawnSync("git", ["-C", blob.repoDir, "cat-file", "blob", `${blob.commit}:${blob.path}`], { maxBuffer: 1 << 28 });
  if (shown.status !== 0 || shown.stdout == null) return null;
  return createHash("sha256").update(shown.stdout).digest("hex");
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
 * the DUAL per-arm policy-blob hashes × protocol; "Any component moves, the
 * value is re-taken"; "a value with no provenance is refused". So a mismatch
 * on ANY component throws rather than degrades — including the pre-blob case:
 * the committed 2026-08-08 probe ran before any policy blob was sealed and
 * carries the SINGULAR pre-dual key, so a manifest that seals blobs (every
 * registrable manifest now does) is refused until a re-probe under those
 * blobs exists. The refusal is what keeps the re-take rule from being
 * forgotten.
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
  // Which script produced this is provenance too: the committed measurement
  // row names "scripts/b12-installedchars-probe-mac.sh at <commit>", and the
  // commit is the field that makes that claim checkable against git history.
  if (typeof ctx.commit !== "string" || ctx.commit.length === 0) {
    fail("the probe records no producing commit (context.commit) — provenance for WHICH script ran is part of the record");
  }
  // The proof session is part of the registered METHOD (the committed
  // MEASUREMENTS row: "proof session showed mcp__local-coder__status
  // callable") — it is what proves the treatment config actually installs the
  // server, so its absence or a proof that called no local tool refuses. A
  // sixth adversarial round asked for more — the exact registered prompt and
  // a byte-exact argv template — and those are DECLINED as minting: the
  // pre-declaration fixes "identical but for the arm", not a prompt string,
  // and the artifact's own note says the argv is NOT byte-for-byte before a
  // manifest exists. The REGISTERED components are what this function pins.
  const proof = probe.proofSession ?? null;
  if (!proof || typeof proof !== "object") fail("the probe carries no proofSession — the registered method's proof that the treatment config installs the server");
  if (!Array.isArray(proof.toolsCalled) || !proof.toolsCalled.includes("mcp__local-coder__status")) {
    fail(`the proof session did not call mcp__local-coder__status (toolsCalled: ${JSON.stringify(proof.toolsCalled ?? null)}) — installation was never proven`);
  }
  if (typeof proof.sessionId !== "string" || proof.sessionId.length === 0) fail("the proof session carries no sessionId");
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
  if (sessionIds.includes(proof.sessionId)) {
    fail(`the proof session's id ${proof.sessionId} is also a replicate session — the proof is a SEPARATE session by the registered method`);
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
  // THE POLICY-BLOB COMPONENT IS DUAL — {treatment, control} — because BOTH
  // arms deliver their own blob via `--append-system-prompt`, so both blobs
  // sit INSIDE the delta the probe measured: treatment − control includes
  // (treatment blob − control blob) alongside the MCP installation. One arm's
  // blob moving shifts the delta without touching the other's, so each arm is
  // compared separately and each mismatch is named separately.
  if (ctx.policyBlobSha256s === undefined) {
    fail(
      "the probe's calibration key carries no per-arm policy-blob component (policyBlobSha256s) — " +
        "it pre-dates the dual {treatment, control} key, and every registrable manifest now seals blobs, " +
        "so a re-probe under the sealed blobs is required (the re-take rule, not a schema nicety)"
    );
  }
  for (const armName of ["treatment", "control"]) {
    const probeSha = ctx.policyBlobSha256s?.[armName] ?? null;
    const liveSha = live.policyBlobSha256s?.[armName] ?? null;
    if (probeSha !== liveSha) {
      fail(
        `calibration key moved: probe ${armName} policy-blob sha256 ${String(probeSha)} != live ${String(liveSha)} — ` +
          "the blob sits inside the measured delta, so a moved blob demands a re-probe"
      );
    }
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
      policyBlobSha256s: {
        treatment: ctx.policyBlobSha256s?.treatment ?? null,
        control: ctx.policyBlobSha256s?.control ?? null,
      },
      extraArgs: ctx.extraArgs ?? [],
      // Never defaulted — validated above; a fallback here would label missing
      // provenance as the registered protocol.
      protocol: probe.preDeclaration,
    },
  };
}

function findInstalledChars(manifest, binary, mcp, policyBlobs) {
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
  // BOTH arms' blobs, because the calibration key is dual: each arm's argv
  // carries its own blob, so each blob sits inside the measured delta.
  for (const armName of ["treatment", "control"]) {
    if ((policyBlobs?.[armName] ?? null) === null) {
      return { record: null, why: `cannot validate the probe's calibration key without a resolved ${armName} policy blob` };
    }
  }
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
      policyBlobSha256s: {
        treatment: policyBlobs.treatment.sha256,
        control: policyBlobs.control.sha256,
      },
      extraArgs: manifest.pinned?.extraArgs ?? [],
    });
    return { record: { ...record, probeArtifact: declared, probeArtifactSha256: sha }, why: null };
  } catch (error) {
    return { record: null, why: `installedChars is not usable: ${error.message}` };
  }
}

function resolveInstalledChars(manifest, binary, mcp, policyBlobs) {
  const { record, why } = findInstalledChars(manifest, binary, mcp, policyBlobs);
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
  return { manifest, sha256: sha256Text(text), path: file, text };
}

/**
 * THE REGISTRATION GUARD — every reason `observe` may not spend a session,
 * enumerated rather than the first one found. `voidConditions` 1 registers a
 * run as "evidence/<run_id>.b12.tasks.json committed AND its run_id written to
 * MEASUREMENTS.jsonl BY THE SAME COMMAND", so the guard demands:
 *
 * (a) the manifest at its canonical path, byte-identical on disk, in HEAD, and
 *     in the REGISTRATION commit's blob — the bytes about to drive a session
 *     are the registered bytes, not a working-copy cousin;
 * (b) "the same command", PROVEN: the commit that introduced the manifest IS
 *     the commit that introduced the exact registration row — two separate
 *     commits are two separate acts, whatever their author intended;
 * (c) MEASUREMENTS.jsonl by PREFIX PRESERVATION, never whole-file identity —
 *     appends after registration are lawful (`.gitattributes` pins the file
 *     LF for exactly this reason): the registration commit's content must be
 *     a BYTE prefix of HEAD's, HEAD's a byte prefix of the disk's, and the
 *     disk's suffix beyond HEAD must be newline-terminated JSONL. Raw bytes,
 *     no textual normalization — LF is already fixed by attribute.
 *
 * Returns every violated condition; empty means registered and coherent.
 */
export function registrationGuard(repoRoot, runId, manifestBytesOnDisk) {
  const reasons = [];
  const probe = (args) => run("git", ["-C", repoRoot, ...args]);
  const manifestRel = `evidence/${runId}.b12.tasks.json`;

  const headMeasurements = probe(["show", "HEAD:MEASUREMENTS.jsonl"]);
  if (headMeasurements.code !== 0) {
    reasons.push("HEAD carries no MEASUREMENTS.jsonl — nothing is registered");
    return reasons;
  }
  const regLines = headMeasurements.out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .filter((l) => {
      try {
        const r = JSON.parse(l);
        return r.b12_registration === true && r.run_id === runId;
      } catch {
        return false;
      }
    });
  if (regLines.length !== 1) {
    reasons.push(
      `${regLines.length} registration row(s) for ${runId} in HEAD's MEASUREMENTS.jsonl — exactly one row with b12_registration:true registers a run`
    );
    return reasons;
  }
  const regRow = regLines[0];

  // Introducing commits: `--diff-filter=A` newest-first, so the LAST line is
  // the birth. `-S` over the exact row text finds the commit that added it.
  const introducing = (logArgs) => {
    const r = probe(["log", "--diff-filter=A", "--format=%H", ...logArgs]);
    if (r.code !== 0) return null;
    const lines = r.out.trim().split("\n").filter(Boolean);
    return lines.length === 0 ? null : lines[lines.length - 1];
  };
  const manifestIntro = introducing(["--", manifestRel]);
  if (manifestIntro === null) {
    reasons.push(`${manifestRel} has no introducing commit — the manifest was never committed`);
  }
  const rowLog = probe(["log", "-S", regRow, "--format=%H", "--", "MEASUREMENTS.jsonl"]);
  const rowCommits = rowLog.code === 0 ? rowLog.out.trim().split("\n").filter(Boolean) : [];
  const rowIntro = rowCommits.length === 0 ? null : rowCommits[rowCommits.length - 1];
  if (rowIntro === null) {
    reasons.push("the registration row's introducing commit cannot be found — a row HEAD carries must have been added somewhere");
  }
  if (manifestIntro !== null && rowIntro !== null && manifestIntro !== rowIntro) {
    reasons.push(
      `the manifest was introduced by ${manifestIntro} and the registration row by ${rowIntro} — two commits are two acts, not "the same command" (voidConditions 1)`
    );
  }

  // (a) byte identity across the three copies of the manifest.
  const headManifest = probe(["show", `HEAD:${manifestRel}`]);
  if (headManifest.code !== 0) {
    reasons.push(`HEAD does not carry ${manifestRel}`);
  } else {
    if (headManifest.out !== manifestBytesOnDisk) {
      reasons.push(`the on-disk manifest differs from HEAD's blob — the bytes about to run are not the registered bytes`);
    }
    if (manifestIntro !== null) {
      const regManifest = probe(["show", `${manifestIntro}:${manifestRel}`]);
      if (regManifest.code !== 0 || regManifest.out !== headManifest.out) {
        reasons.push(`HEAD's manifest differs from the registration commit's blob — the manifest moved after the act`);
      }
    }
  }

  // (c) prefix preservation, in raw bytes.
  if (rowIntro !== null) {
    const regMeasurements = probe(["show", `${rowIntro}:MEASUREMENTS.jsonl`]);
    if (regMeasurements.code !== 0) {
      reasons.push(`the registration commit does not carry MEASUREMENTS.jsonl — the act cannot be replayed`);
    } else if (!headMeasurements.out.startsWith(regMeasurements.out)) {
      reasons.push(
        "HEAD's MEASUREMENTS.jsonl does not preserve the registration commit's content as a byte prefix — the append-only register was rewritten"
      );
    }
  }
  const diskPath = path.join(repoRoot, "MEASUREMENTS.jsonl");
  const disk = existsSync(diskPath) ? readFileSync(diskPath, "utf8") : null;
  if (disk === null) {
    reasons.push("MEASUREMENTS.jsonl is missing from the working tree");
  } else if (!disk.startsWith(headMeasurements.out)) {
    reasons.push("the working tree's MEASUREMENTS.jsonl does not preserve HEAD's content as a byte prefix");
  } else {
    const suffix = disk.slice(headMeasurements.out.length);
    if (suffix !== "") {
      if (!suffix.endsWith("\n")) {
        reasons.push("the uncommitted MEASUREMENTS.jsonl suffix is not newline-terminated");
      }
      for (const line of suffix.split("\n")) {
        if (line.trim() === "") continue;
        try {
          JSON.parse(line);
        } catch {
          reasons.push(`the uncommitted MEASUREMENTS.jsonl suffix carries a non-JSON line: ${line.slice(0, 60)}`);
          break;
        }
      }
    }
  }
  return reasons;
}

/**
 * ARTIFACT 4 — the pilot's field→source→applicability table, covering the
 * FULL frozen covariate list (`design.metric.covariates`, preregistration
 * lines 44–59; line 57's two halves split here because one is per-arm and the
 * other is A/B-only). `not-applicable` appears ONLY on the 2×2/ABBA/partner
 * -arm entries — the pilot has no pair, and everything else is either carried
 * on the record or re-derivable from the RAW meter inputs it embeds.
 *
 * THE REGISTERED READING OF "No units, no bracket" (the pre-pilot
 * adjudication, FINDINGS.md): artifact 4 forbids AGGREGATES — A/S/R sums,
 * any bracket, any verdict — not per-observation unit-VALUED covariates,
 * which the frozen covariate list itself demands (per-row bytes, an excluded
 * observation's A_o). `assertPilotShape` enforces exactly that boundary.
 */
export const PILOT_COVARIATE_TABLE = [
  { covariate: "subagent share, continuous and solo/multi", source: "derived at reading from record.lineage (sidechain flags), published raw", applicability: "recorded" },
  { covariate: "per credited row: id, tool, ts, thread, t, T, ttl, multiplier, bytes, capped/uncapped, signed", source: "record.telemetry verbatim + record.lineage — the meter's own inputs, re-derivable", applicability: "recorded" },
  { covariate: "turns_collapsed per call, gate category, repair max_rounds and passed", source: "record.telemetry rows (turns_collapsed, detail)", applicability: "recorded" },
  { covariate: "refusal ledger; per-excluded A_o, billed count, gate/repair calls", source: "derived at reading from record.telemetry + record.lineage", applicability: "recorded" },
  { covariate: "unitsAddedByInstallation and the per-arm system-prompt delta", source: "record.observation.installedChars (provenance-carrying)", applicability: "recorded" },
  { covariate: "requests-per-segment and segment count", source: "derived at reading from record.lineage", applicability: "recorded" },
  { covariate: "max inter-request gap and cacheWrite share", source: "derived at reading from record.lineage", applicability: "recorded" },
  { covariate: "Claude Code version, binary sha256, DISABLE_AUTOUPDATER", source: "record.observation.binary", applicability: "recorded" },
  { covariate: "rate keys, model id, speed, /model and /fast toggles", source: "derived at reading from record.lineage usage", applicability: "recorded" },
  { covariate: "base commit, worktree, tree hash, porcelain at start, end commit", source: "record.observation.{baseCommit,treeHashAtStart,endCommit,armLeftUncommitted}", applicability: "recorded" },
  { covariate: "instruction-component hashes, pre and post", source: "record.observation.instructionHashes", applicability: "recorded" },
  { covariate: "slug list walked, directory count, id count", source: "record.observation.snapshotBefore/After (stamped)", applicability: "recorded" },
  { covariate: "governance_bytes_read", source: "derived at reading from record.lineage tool results", applicability: "recorded" },
  { covariate: "acceptance predicate exit code per arm", source: "record.observation.acceptance", applicability: "recorded" },
  { covariate: "the A/B acceptance 2x2 (concordant/discordant)", source: "no pair exists in the pilot", applicability: "not-applicable (A/B)" },
  { covariate: "per A/B arm: turns, wall-clock, files read, tool bytes, billed count, ABBA position", source: "no pair exists in the pilot", applicability: "not-applicable (A/B)" },
  { covariate: "wall-clock per task/arm and local-model token counts", source: "record.observation.wallClockMs + record.telemetry details", applicability: "recorded" },
];

/** The aggregate/bracket spellings artifact 4 forbids, at ANY depth. */
export const PILOT_FORBIDDEN_KEYS = [
  "rLo",
  "rHi",
  "rHiPlus",
  "uncappedBracket",
  "bracket",
  "verdict",
  "admitted",
  "recomputations",
  "strata",
  "hold",
];

/** Refuse any pilot value carrying a forbidden key — the write-time teeth. */
export function assertPilotShape(value) {
  const walk = (v, trail) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, trail);
      return;
    }
    if (v === null || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v)) {
      if (PILOT_FORBIDDEN_KEYS.includes(k)) {
        throw new Error(
          `the pilot artifact may carry NO aggregate and NO bracket — forbidden key "${k}" under ${trail.join(".")} (design.artifacts 4)`
        );
      }
      walk(val, [...trail, k]);
    }
  };
  walk(value, ["pilot"]);
}

/** One pilot observation: the disposition, the covariates, the raw inputs. */
export function buildPilotRecord(observation, archiveData) {
  const record = {
    taskId: observation.taskId,
    arm: observation.arm,
    sessionId: observation.sessionId,
    disposition: {
      outcome: observation.outcome,
      valid: observation.valid,
      censored: observation.censored,
      accepted: observation.accepted,
      invalidReasons: observation.invalidReasons,
    },
    observation,
    telemetry: archiveData.telemetry,
    lineage: archiveData.lineage,
  };
  assertPilotShape(record);
  return record;
}

/** Read-modify-write of the ONE pilot file, shape-checked before every write. */
export function appendPilotRecord(repoRoot, runId, record) {
  const file = path.join(repoRoot, "evidence", `${runId}.b12.pilot.json`);
  const current = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { schema: "b12-pilot/1", runId, covariateTable: PILOT_COVARIATE_TABLE, observations: [] };
  current.observations.push(record);
  assertPilotShape(current);
  writeFileSync(file, JSON.stringify(current, null, 2) + "\n", "utf8");
  return file;
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
      check(
        `policy blob resolves against its seal (${arm})`,
        blob !== null,
        blob !== null ? `${blob.sha256.slice(0, 12)} @ ${blob.declaredPath}` : why
      );
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
      const { record, why } = findInstalledChars(manifest, binary, mcp, blobs);
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
async function observe(args, pilotMode = false) {
  const { manifest, sha256: manifestSha, text: manifestText } = loadManifest(args.manifest);
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

  // ARTIFACT 6'S BARRIER, both arms, BEFORE the order check reads the disk
  // runlog as progress: disk and HEAD must carry the same runlog bytes, or a
  // predecessor's evidence commit is still pending (or failed) and its row is
  // not yet a predecessor anyone may order themselves against.
  const runLogRel = `evidence/${manifest.runId ?? "b12-unnamed"}.b12.runlog.jsonl`;
  const runLogPath = path.join(REPO, runLogRel);
  // KEPT, not just checked: the bytes the barrier accepted here are compared
  // again under the run's commit lock at the end. Anything else having written
  // this file in between is another observation that ran INSIDE this one.
  const runlogAtBarrier = existsSync(runLogPath) ? readFileSync(runLogPath, "utf8") : null;
  // THE BRANCH, CAPTURED WITH THE BYTES (R26). Everything this observation
  // commits must land where it started; `git commit` obeys HEAD at commit
  // time, which is minutes from now. A detached HEAD is refused outright —
  // evidence that no branch holds is evidence the run cannot find.
  const branchRef = (() => {
    const r = run("git", ["-C", REPO, "symbolic-ref", "--quiet", "HEAD"]);
    if (r.code !== 0 || r.out.trim() === "") {
      refuse("HEAD is detached — an observation's evidence commit would belong to no branch; check out the run's branch first");
    }
    return r.out.trim();
  })();
  {
    const headProbe = run("git", ["-C", REPO, "show", `${branchRef}:${runLogRel}`]);
    const barrier = runlogBarrierViolation(runlogAtBarrier, headProbe.code === 0 ? headProbe.out : null);
    if (barrier) refuse(barrier);
  }
  // The committed order, enforced against the persisted runlog BEFORE the
  // session is spent — see `committedOrderViolation` for the treatment-only
  // scoping and the duplicate-task adjudication it deliberately leaves to
  // scoring.
  if (arm === "treatment") {
    const violation = committedOrderViolation(
      manifest,
      args.task,
      existsSync(runLogPath) ? readFileSync(runLogPath, "utf8") : ""
    );
    if (violation) refuse(violation);
  }

  // THE INSTRUCTION IS READ, NEVER RETYPED, and the check costs nothing —
  // so it happens before anything is created. (It used to sit after the
  // worktree, which is how a bad prompt hash left a full checkout behind.)
  if (typeof task.prompt !== "string" || task.prompt.length === 0) refuse(`task ${task.id} carries no prompt`);
  const promptSha = sha256Text(task.prompt);
  if (task.promptSha256 && task.promptSha256 !== promptSha) {
    refuse(`task ${task.id} prompt sha256 ${promptSha} != manifest ${task.promptSha256} — the text moved after sealing`);
  }

  const runId = manifest.runId ?? "b12-unnamed";
  // THE REGISTRATION GUARD: a session may only be spent on a REGISTERED run
  // whose registration is still coherent — the canonical path, the same-act
  // proof, the append-only register's byte prefix. Before the lock, before
  // the session id, and — since R14 — genuinely BEFORE ANY WORKTREE, which
  // is what this comment always claimed while the creation sat above it.
  // The PILOT is the one lawful exception — it runs BEFORE registration by
  // design (artifact 4: declared not to consume the attempt cap, its tasks
  // excluded from both sealed manifests), and writes none of the registered
  // artifacts the guard protects.
  if (!pilotMode) {
    const canonicalManifest = path.join(REPO, "evidence", `${runId}.b12.tasks.json`);
    if (path.resolve(args.manifest) !== path.resolve(canonicalManifest)) {
      refuse(
        `observe runs the CANONICAL manifest evidence/${runId}.b12.tasks.json, not ${args.manifest} — a session may not be spent on an unregistered copy`
      );
    }
    const guardReasons = registrationGuard(REPO, runId, manifestText);
    if (guardReasons.length > 0) refuse(`registration guard: ${guardReasons.join("; ")}`);
  }

  const binary = claudeBinary();
  assertPinned(manifest, binary);
  // Every refusal BEFORE the worktree and before the session id, so a manifest
  // that cannot produce a compliant observation costs nothing to discover.
  const mcp = arm === "treatment" ? resolveMcpConfig(manifest) : null;
  const policyBlob = resolvePolicyBlob(manifest, arm);
  // The other arm's blob resolves too — a pair whose other arm cannot run was
  // never a pair, and the calibration key is DUAL, so the other arm's blob
  // participates in probe validation even on the arm that never delivers it.
  const otherBlob = resolvePolicyBlob(manifest, arm === "treatment" ? "control" : "treatment");
  const policyBlobs =
    arm === "treatment" ? { treatment: policyBlob, control: otherBlob } : { treatment: otherBlob, control: policyBlob };
  const memorySnapshot = resolveMemorySnapshot(manifest);
  // ONE `O_o`, treatment only. The control arm records a named absence, not a
  // second value — see `validateInstalledCharsProbe`'s header for why 0 would
  // be the two-valued `O` the boundary refuses.
  const installedChars =
    arm === "treatment"
      ? resolveInstalledChars(manifest, binary, mcp, policyBlobs)
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
  const b12Root = path.join(REPO, ".b12");
  // PROCESS-UNIQUE, not per-task/arm (the sixth diff round's first finding):
  // a fixed `.b12/<task>-<arm>` path plus the recursive delete below meant a
  // concurrent invocation of the same task/arm deleted THIS process's LIVE
  // worktree mid-observation — destroying exactly the in-flight evidence the
  // atomic `claimObsDir` was built to preserve at archive time. The token
  // keeps the path one safe segment below `.b12/` (the containment wall
  // holds unchanged); the lineage capture, the snapshots and the memory
  // restore all derive the slug FROM the path, so a fresh path is only a
  // fresh slug. The evidence claim stays at the END on purpose: claiming
  // before the session would leave an empty claimed directory in append-only
  // `evidence/` on every mid-flight refusal, converting "a refusal costs
  // nothing to discover" into a permanent void at scoring time.
  const processToken = createHash("sha256")
    .update(`${process.pid}:${stamp()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 12);
  const treeDir = path.join(b12Root, `${task.id}-${arm}-${processToken}`);
  // THE SECOND WALL before the recursive delete: the id grammar above already
  // refuses traversal, but a path that is about to be `rmSync`'d recursively
  // earns its own containment proof — exactly one segment below `.b12/`,
  // never outside it.
  {
    const rel = path.relative(b12Root, treeDir);
    if (rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep) || rel.length === 0) {
      refuse(`worktree path ${treeDir} is not a direct child of ${b12Root} — refusing to delete or create it`);
    }
  }
  if (existsSync(treeDir)) rmSync(treeDir, { recursive: true, force: true });
  mkdirSync(path.dirname(treeDir), { recursive: true });
  git(["worktree", "add", "--detach", treeDir, task.baseCommit]);
  // THE TREE IS OWNED FROM ITS FIRST BYTE. `refuse()` calls `process.exit`,
  // so no `try/finally` can reach a cleanup — an exit hook is the only shape
  // that covers EVERY refusal below (and every crash). A leaked `.b12`
  // checkout is a full repository copy plus a live worktree registration, and
  // a retried task would leak another; the operator would find the disk full
  // before finding the cause. `--keep` still keeps, and a COMPLETED
  // observation removes the tree in its own line below rather than here.
  let observationCompleted = false;
  // Set the moment the evidence directory is CLAIMED, far below — the hook
  // removes it on any non-completion, but ONLY while it is uncommitted: the
  // append-only rule governs the committed record, and an empty or partial
  // attempt that was never committed is a claim nobody made good on, not
  // evidence. A committed one is never touched.
  let claimedDir = null;
  process.on("exit", () => {
    if (observationCompleted || args.keep) return;
    try {
      rmSync(treeDir, { recursive: true, force: true });
    } catch {
      // Best effort — the prune below still unregisters it.
    }
    spawnSync("git", ["-C", REPO, "worktree", "prune"], { encoding: "utf8" });
    if (claimedDir === null) return;
    const rel = path.relative(REPO, claimedDir).split(path.sep).join("/");
    const committed = spawnSync("git", ["-C", REPO, "cat-file", "-e", `HEAD:${rel}`], { encoding: "utf8" });
    if (committed.status === 0) return; // committed evidence is never removed
    try {
      rmSync(claimedDir, { recursive: true, force: true });
      process.stderr.write(`  (removed the uncommitted claim ${rel} — the attempt was never completed)\n`);
    } catch {
      // Best effort; a leftover empty dir is reported by the scorer's sweep.
    }
  });
  const treeHash = git(["rev-parse", "HEAD"], treeDir);
  const dirty = run("git", ["-C", treeDir, "status", "--porcelain"]).out.trim();
  if (dirty) refuse(`fresh worktree is not clean: ${dirty.slice(0, 200)}`);
  const ratesSha = assertRatesFrozen(manifest, treeDir);

  // The prompt hash and the registration guard ran BEFORE the worktree — a
  // refusal there costs nothing, which is what those checks are for.
  //
  // The lock is taken HERE — after every cheap refusal above, and
  // immediately before the session id exists, so no two processes can hold
  // the same (runId, taskId, arm). A refusal PAST this point leaves the lock
  // deliberately: something died mid-observation and the operator should
  // look before anything re-runs. (The WORKTREE is not left behind — the
  // exit hook above owns it — but the lock is a different claim: it says a
  // session may have been spent, and only a human can say it was not.)
  const sessionLock = acquireSessionLock(path.join(REPO, "evidence"), runId, task.id, arm);
  if (!sessionLock.ok) {
    refuse(
      `another observe holds ${task.id}/${arm} (lock ${sessionLock.lockDir}) — one (runId, taskId, arm) may be in flight at a time; remove the lock only after confirming no live process`
    );
  }
  const sessionId = mintSessionId(manifestSha, runId, task.id, arm);

  // "The delegation policy leaves the repository under test entirely" (CHANNEL
  // 5). `findPolicyBlob` already refused a policy repo resolving inside the
  // repository under test — which contains every `.b12/` arm worktree — so
  // this re-asserts the same wall against THIS arm's just-created tree, the
  // first moment the tree exists to compare against. The previous schema also
  // checked the base tree for a file at the blob's relative path; with
  // delivery reading a foreign object store there is no path in the worktree
  // for the base commit to shadow, so that check has nothing left to guard.
  {
    const rel = path.relative(treeDir, policyBlob.repoDir);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      refuse(`the ${arm} policy repo resolves INSIDE the arm's worktree (${policyBlob.repoDir}) — the policy must leave the repository under test entirely`);
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
    policyBlob: policyBlobLiveSha256(policyBlob),
    memory: memorySha,
    // The seventh is not measurable from outside the session — a registered
    // limit (FINDINGS.md F24), recorded as a named fact instead of a hash that
    // would dress an assumption as a measurement.
    allowlistVisibleInSystemPrompt: "unmeasurable-from-outside-the-session (registered limit, FINDINGS.md F24)",
  });
  const instructionPre = instructionHashesAt(memoryRestored.sha256);

  const before = takeSnapshot(undefined, {
    runId,
    taskId: task.id,
    arm,
    sessionId,
    phase: "before",
  });

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

  const after = takeSnapshot(undefined, {
    runId,
    taskId: task.id,
    arm,
    sessionId,
    phase: "after",
  });
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
  // The slugs the arm WROTE to: those whose transcripts carry an originated
  // id. Derived from the post-snapshot's own attribution, so the rule below
  // compares the pre-snapshot's coverage against writes the same walk saw.
  const originatedSet = new Set(originated);
  const writtenSlugs = Object.entries(after.slugRequestIds)
    .filter(([, slugIds]) => slugIds.some((id) => originatedSet.has(id)))
    .map(([slug]) => slug);
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
    coveredSlugs: before.slugs,
    writtenSlugs,
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

  // A RE-RUN GETS ITS OWN DIRECTORY, `obs-<taskId>-<arm>-r<N>`. `admissionRule`
  // 12 says "Both attempts are archived and both fractions published", and one
  // directory per task/arm cannot hold two attempts — the second write would
  // overwrite the first's evidence or trip the commit barrier against HEAD's
  // blobs, both of which destroy exactly what the clause preserves. Found by
  // the UNIT-5 plan gate (FINDINGS.md); the scorer's `parseObsDirName` reads
  // the same grammar back — the round trip is pinned in `cost-meter.test.ts`.
  // Which attempt SCORES is the scorer's registered convention, not decided
  // here. The claim is ATOMIC — see `claimObsDir`.
  // The pilot claims NO evidence directory — artifact 4's only output is the
  // pilot file, and an empty claimed dir in append-only evidence/ would be a
  // permanent void at scoring time.
  //
  // THE CLAIM ITSELF MOVED (R16). It used to happen HERE, before the capture
  // below — and the capture is fallible: an unreadable transcript, a missing
  // telemetry file, a dependency that throws. A failure then left an EMPTY
  // claimed attempt in append-only `evidence/`, which the scorer reads as an
  // observation with no identity: integrity failure, run void, after the
  // session was already paid for. The claim now happens immediately before
  // the writes, once everything fallible has succeeded.

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
    policyBlob: { repo: policyBlob.repo, commit: policyBlob.commit, path: policyBlob.path, sha256: policyBlob.sha256 },
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

  // ARTIFACT 4 — THE PILOT PATH. The pilot's ONLY output is its one file: the
  // disposition and the covariate vector with the RAW meter inputs embedded
  // (telemetry verbatim, reduced lineage), so every scoring-time covariate is
  // re-derivable — and NO aggregate, NO bracket, enforced by shape at every
  // write. No obs-dir, no runlog row, no MEASUREMENTS line, no commit:
  // committing is the session's act, and registration has not happened.
  if (pilotMode) {
    const pilotFile = appendPilotRecord(REPO, runId, buildPilotRecord(observation, archive));
    sessionLock.release();
    process.stdout.write(
      `  pilot  ${task.id}/${arm}  session ${sessionId.slice(0, 8)}  outcome ${verdict.outcome}  ` +
        `accepted ${observation.accepted}  → ${path.relative(REPO, pilotFile).split(path.sep).join("/")}\n`
    );
    if (!args.keep) git(["worktree", "remove", "--force", treeDir]);
    observationCompleted = true; // the tree is gone (or kept on purpose)
    if (!observation.valid) {
      for (const reason of invalid) process.stderr.write(`  INVALID: ${reason}\n`);
      process.exit(1);
    }
    return;
  }

  // THE ATOMIC CLAIM, now that nothing fallible remains between it and the
  // bytes. `claimedDir` is also handed to the exit hook: a partial write —
  // a full disk, a killed process — would otherwise leave a half-populated
  // attempt behind, and removing an UNCOMMITTED directory violates nothing,
  // because append-only is a property of the committed record.
  const { dir } = claimObsDir(path.join(REPO, "evidence", runId), task.id, arm);
  claimedDir = dir;

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

  // THE ROW AND ITS COMMIT, AS ONE ACT — `design.artifacts` 10 ("whose `ts` is
  // read from the system clock in the same command that writes it") and
  // artifact 6's barrier ("committed at each task's END, BEFORE THE NEXT TASK
  // STARTS") are one critical section, held under this run's commit lock. It
  // is enforced HERE rather than left to a driver: a driver could lawfully
  // commit between calls, but then the timing obligation is checked by
  // nothing, which is the shape of every guard this project has had to delete.
  //
  // Everything the old inline code refused on now comes back as a reason, so
  // the lock is released before this process exits.
  const relDir = path.relative(REPO, dir).split(path.sep).join("/");
  const rowCommit = await commitObservationRow(REPO, {
    evidenceDir: path.join(REPO, "evidence"),
    runId,
    runLogRel,
    relDir,
    written,
    sessionId,
    runlogAtBarrier,
    branchRef,
    message: `evidence: ${runId} ${task.id}/${arm}`,
    row: {
      runId,
      taskId: task.id,
      arm,
      sessionId,
      outcome: verdict.outcome,
      valid: observation.valid,
      accepted: observation.accepted,
      originated: originated.length,
    },
  });
  if (!rowCommit.ok) refuse(rowCommit.why);
  // The row and its evidence are in HEAD; only now has the in-flight claim
  // done its work. (It used to be released right after the append — which
  // handed the next attempt a window where the commit had not happened yet.)
  sessionLock.release();

  process.stdout.write(
    `  ${observation.valid ? "ok  " : "INVALID"}  ${task.id}/${arm}  session ${sessionId.slice(0, 8)}  ` +
      `originated ${originated.length} request(s)  accepted ${observation.accepted}  ` +
      `${censored ? "CENSORED  " : ""}${wallMs}ms\n` +
      `  archived ${archive.lineage.length} lineage file(s), ${archive.telemetry.length} telemetry row(s), ` +
      `${archive.invocationIds.length} invocation id(s), ${archive.sourceFiles.length} source file(s)\n` +
      `  committed ${relDir}\n`
  );
  if (!args.keep) git(["worktree", "remove", "--force", treeDir]);
  observationCompleted = true; // the tree is gone (or kept on purpose)
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
  case "pilot":
    // The same session machinery as `observe`, with artifact 4's outputs and
    // exemptions — see the pilot branch inside `observe` and the covariate
    // table beside `appendPilotRecord`.
    await observe(args, true);
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
