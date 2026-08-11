/**
 * The mutation harness's RUNNER — the IO half. `b12-firing.mjs` is the verdict.
 *
 * Closes the half of R23 still open: clause 6 requires six negative controls
 * SHOWN FIRING, and all six have been shown firing BY HAND. Thirty such
 * demonstrations are recorded in `FINDINGS.md`. None of them is a mechanism.
 *
 * NOT a vitest test, deliberately. A test would mutate trees on every ordinary
 * gate run. This is a script, invoked on purpose, whose output is an artifact.
 * Its EVALUATOR is unit-tested (`tests/b12-firing.test.ts`); its execution is
 * not, which is why every step below either proves its precondition or refuses.
 *
 * Nothing here decides a verdict. It produces evidence for a requirement clause
 * 6 already states; the audit computer reads it as a failure of the existing
 * "shown FIRING" phrase, never as a seventh condition.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { evaluateMatrix } from "./b12-firing.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * THE CLAUSE-6 SET — six pairs, one per control.
 *
 * FIVE replay the historical bug their control was written against; ONE (m5) is
 * an invariant violation in the same class, and says so. Every entry carries a
 * `kind`, because R40#2 caught two entries claiming to be historical replays
 * that were not: one clamped a display aggregate while the scored figure stayed
 * negative, and one produced count-both under a "first-wins" label. The harness
 * would have certified a replay that never restored the defect. The first was
 * fixed; the second was relabelled, which is the honest repair when the code is
 * reachable and real but is not the thing the entry named.
 *
 * No mutation is an invented edit. A mutation drawn from the fixture would
 * satisfy every firing predicate while proving nothing (R38#1); one that shipped
 * in this repository, or that violates the subject's stated invariant, is
 * production-reachable by construction and mentions no test-only identifier.
 *
 * The registry does NOT restate the controls: `runHarness` reads `CONTROL_TESTS`
 * out of the built tree under test and the evaluator refuses unless the two
 * cover each other exactly. What is pinned here is the control's fullName, so a
 * pair can be matched to its mutation, and the evaluator checks that pinning
 * against the clause's own list.
 *
 * R38#4, declined in part: replaying the historical bug proves the control is a
 * regression test for the defect it was born from and says nothing about the
 * defect space around it. True, and REPORTED rather than fixed by requiring more
 * kills — a new pass/fail requirement is exactly the condition this harness
 * refuses to mint.
 */
export const REGISTRY = [
  {
    id: "m1-failed-repair",
    control: {
      file: "tests/cost-meter.test.ts",
      fullName:
        "telemetry and the counterfactual credits a failed repair row at zero units — clause 6's failed-repair control",
    },
    kind: "historical",
    why: "an aborted repair writes bytes_raw:0/bytes_returned:0 and the meter must CREDIT it at exactly zero, never drop it",
    subject: {
      path: "src/cost/report.ts",
      find: "    const signed = entry.bytes_raw - entry.bytes_returned;",
      replace:
        "    if (entry.bytes_raw === 0 && entry.bytes_returned === 0) continue;\n    const signed = entry.bytes_raw - entry.bytes_returned;",
      occurrences: 1,
    },
  },
  {
    id: "m2-clamp-restored",
    control: {
      file: "tests/cost-meter.test.ts",
      fullName: "telemetry and the counterfactual keeps a call that ADDED bytes as the negative it is",
    },
    kind: "historical",
    why: "THE SHIPPED DEFECT, restored at its source: max(0, raw - returned) turns a call that COST bytes into one that saved nothing",
    subject: {
      path: "src/cost/report.ts",
      // R40#2: this clamped `saving.bytes.signedUncapped` — a DISPLAY aggregate.
      // The control still went red, but on its display assertion, while the
      // scored figure stayed negative: the harness would have certified a
      // historical replay that never restored the historical defect. Clamping
      // `signed` itself is where the shipped clamp actually lived, and it moves
      // rowsNetNegative, signedUncapped and unitsTotal together.
      find: "    const signed = entry.bytes_raw - entry.bytes_returned;",
      replace: "    const signed = Math.max(0, entry.bytes_raw - entry.bytes_returned);",
      occurrences: 1,
    },
  },
  {
    id: "m3-unsized-as-zero",
    control: {
      file: "tests/cost-meter.test.ts",
      fullName:
        "telemetry and the counterfactual counts a refusal it cannot size instead of summing the unknown as zero",
    },
    kind: "historical",
    why: "folding an unsizeable refusal in as 0 reads as 'we refused nothing worth having'",
    subject: {
      path: "src/cost/report.ts",
      find: "    if (magnitude === null) into.unsized++;",
      replace: "    if (magnitude === null) into.units += 0;",
      occurrences: 1,
    },
  },
  {
    id: "m4-sibling-inheritance",
    control: {
      file: "tests/cost-meter.test.ts",
      fullName:
        "the B12 harness rejects a resumed session whose ids came from a sibling worktree — clause 6's two-worktree control",
    },
    kind: "historical",
    why: "dropping the inherited>0 rejection lets a resumed session claim ids a sibling worktree already held",
    subject: {
      path: "src/cost/b12/assemble.ts",
      find: "  if (inherited.length > 0) {",
      replace: "  if (false) {",
      occurrences: 1,
    },
  },
  {
    id: "m5-count-both-ownership",
    control: {
      file: "tests/cost-meter.test.ts",
      fullName:
        "telemetry and the counterfactual refuses a call whose invocation id two sessions both carry, on both sides",
    },
    // NOT labelled historical, and the label is the correction. This was
    // published as "first-wins"; raising the threshold makes NO id ambiguous, so
    // BOTH sessions credit it — count-both, a different defect in the same
    // class (R40#2). Count-both is production-reachable and the control catches
    // it, so the mutation stands; the CLAIM was what had to change. Implementing
    // genuine first-wins needs a restructure, not a one-line literal, and this
    // registry admits no mutation it cannot anchor exactly.
    kind: "invariant",
    why: "count-both for a doubly-owned invocation id: no id is ambiguous, so two sessions each credit the same call instead of both refusing",
    subject: {
      path: "src/cost/report.ts",
      find: "  for (const [id, groups] of owners) if (groups.size > 1) ambiguous.add(id);",
      replace: "  for (const [id, groups] of owners) if (groups.size > 99) ambiguous.add(id);",
      occurrences: 1,
    },
  },
  {
    id: "m6-counts-not-populations",
    control: {
      file: "tests/cost-meter.test.ts",
      fullName:
        "the B12 harness rejects a run whose snapshot covered fewer slugs than it wrote to — clause 6's slug-coverage control",
    },
    kind: "historical",
    why: "counts instead of populations — the control's own comment says the slug COUNT grows 1→2 here, so a count reads nothing",
    subject: {
      path: "scripts/b12-run.mjs",
      find: "    const outside = writtenSlugs.filter((s) => !covered.has(s));",
      replace: "    const outside = writtenSlugs.length < coveredSlugs.length ? writtenSlugs : [];",
      occurrences: 1,
    },
  },
];

// ---------------------------------------------------------------------------
// The tree: created once, PROVED pristine between pairs
// ---------------------------------------------------------------------------

function git(repoRoot, args) {
  const r = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trimEnd(), err: (r.stderr ?? "").trimEnd(), status: r.status };
}

function npm(treeDir, args) {
  return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: treeDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
}

/**
 * Return the tree to a state PROVED pristine, then rebuild `dist/` from scratch.
 *
 * R38#3, both halves. Restoring the subject's BYTES does not restore the TREE:
 * `tsc` does not delete obsolete output, so a restored source with a stale
 * `dist/` still runs the mutant, and a later pair failing on an earlier pair's
 * residue would be recorded as a firing. `git clean -xfd` removes `dist/` (it is
 * ignored, so `checkout` alone would leave it), `node_modules` is excluded
 * because the lockfile never changes, and `status --porcelain` must come back
 * EMPTY — the proof, not the hope.
 */
export function makePristine(treeDir) {
  const co = git(treeDir, ["checkout", "--", "."]);
  if (!co.ok) return { ok: false, why: `git checkout refused: ${co.err}` };
  const clean = git(treeDir, ["clean", "-xfd", "-e", "node_modules"]);
  if (!clean.ok) return { ok: false, why: `git clean refused: ${clean.err}` };
  const status = git(treeDir, ["status", "--porcelain"]);
  if (!status.ok) return { ok: false, why: `git status refused: ${status.err}` };
  if (status.out !== "") return { ok: false, why: `the tree is not pristine after cleaning:\n${status.out}` };
  const built = npm(treeDir, ["run", "build"]);
  if (built.status !== 0) {
    return { ok: false, why: `the pristine tree does not build (exit ${String(built.status)})` };
  }
  return { ok: true, why: null };
}

/**
 * An EXACT literal replacement with a required occurrence count. Never a regex.
 *
 * R35 shipped a mutant whose regex matched nothing, and "the control held" is
 * indistinguishable from "the mutation was never there" unless the count is
 * checked and reported. `applied: false` travels into the artifact rather than
 * being swallowed, and the evaluator refuses the pair on it.
 */
export function applyMutation(treeDir, subject) {
  const file = path.join(treeDir, subject.path);
  if (!existsSync(file)) return { applied: false, notApplied: `${subject.path} does not exist in the tree` };
  const before = readFileSync(file, "utf8");
  const count = before.split(subject.find).length - 1;
  if (count !== subject.occurrences) {
    return { applied: false, notApplied: `${count} occurrence(s) of the anchor, wanted ${subject.occurrences}` };
  }
  writeFileSync(file, before.split(subject.find).join(subject.replace), "utf8");
  return { applied: true, notApplied: null, beforeSha256: sha256(before) };
}

/**
 * One conformance run. `expectFailures` says whether a non-zero exit is the
 * point: a baseline that exits non-zero is a refusal, a mutant that exits ZERO
 * has already told us the control did not fire and is passed through so the
 * evaluator can say so by name.
 */
export function runConformance(treeDir, controlFile, { expectFailures }) {
  const run = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["vitest", "run", "--root", treeDir, controlFile, "--reporter=json"],
    { cwd: treeDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: process.platform === "win32" }
  );
  if (run.error !== undefined && run.error !== null) {
    return { ok: false, why: `vitest did not answer: ${String(run.error)}`, report: null };
  }
  if (run.signal !== null && run.signal !== undefined) {
    return { ok: false, why: `vitest was killed by ${run.signal} — a signalled run measures nothing`, report: null };
  }
  if (!expectFailures && run.status !== 0) {
    return { ok: false, why: `the unmutated suite exited ${String(run.status)} — the baseline must be green`, report: null };
  }
  // R40#1: `expectFailures` was licence for ANY non-zero exit, so a worker
  // crash, an OOM or a bail still handed a parseable report to the evaluator as
  // valid mutant evidence. Vitest exits 1 for ordinary test failures; 0 means
  // the control did not fire and is PASSED THROUGH so the evaluator can say so
  // by name. Anything else is the process failing, not a control judging.
  if (expectFailures && run.status !== 0 && run.status !== 1) {
    return { ok: false, why: `vitest exited ${String(run.status)} — an abnormal exit is not a control's judgement`, report: null };
  }
  const line = (run.stdout ?? "").split("\n").find((l) => l.trimStart().startsWith("{"));
  if (line === undefined) return { ok: false, why: "vitest produced no JSON payload", report: null };
  try {
    return { ok: true, why: null, report: JSON.parse(line) };
  } catch (e) {
    return { ok: false, why: `vitest's JSON payload did not parse: ${String(e)}`, report: null };
  }
}

/**
 * The whole matrix. 1 + 2N runs: one baseline, then per pair a pristine bookend
 * and a mutant. Revision 1 of the plan promised per-pair bookends and budgeted
 * seven runs total; the two cannot both be true, and R38#3 caught the
 * arithmetic. Thirteen for the six, stated rather than truncated silently.
 */
export async function runHarness({ repoRoot, commit, runId, generatedAt, registry = REGISTRY, keepTree = false }) {
  const head = git(repoRoot, ["rev-parse", commit ?? "HEAD"]);
  if (!head.ok) throw new Error(`cannot resolve ${commit ?? "HEAD"}: ${head.err}`);
  const baseCommit = head.out;

  const treeDir = mkdtempSync(path.join(os.tmpdir(), "b12-mutate-"));
  rmSync(treeDir, { recursive: true, force: true });
  const added = git(repoRoot, ["worktree", "add", "--detach", treeDir, baseCommit]);
  if (!added.ok) throw new Error(`git worktree add refused: ${added.err}`);

  try {
    const installed = npm(treeDir, ["ci"]);
    if (installed.status !== 0) throw new Error(`the tree does not install (exit ${String(installed.status)})`);

    const first = makePristine(treeDir);
    if (!first.ok) throw new Error(first.why);

    // The clause's own list, read out of the TREE UNDER TEST — never restated
    // here, so a control the clause adds cannot be silently untested.
    const audit = await import(pathToFileURL(path.join(treeDir, "dist/cost/b12/audit.js")).href);
    const controls = audit.CONTROL_TESTS.map((c) => ({ file: c.file, fullName: c.fullName }));
    const files = [...new Set(controls.map((c) => c.file))];
    if (files.length !== 1) throw new Error(`the six controls span ${files.length} files; this runner assumes one`);
    const controlFile = files[0];

    const sources = { [controlFile]: readFileSync(path.join(treeDir, controlFile), "utf8") };

    // Captured while the tree is PROVED pristine and before any mutation. The
    // loop leaves the last mutant in place, so reading these at return time
    // would hash a mutated subject and call it the base.
    const pristineSubjectShas = {};
    for (const e of registry) {
      if (pristineSubjectShas[e.subject.path] === undefined) {
        pristineSubjectShas[e.subject.path] = worktreeSha(treeDir, e.subject.path);
      }
    }
    const conformanceInTree = worktreeSha(treeDir, controlFile);

    const baseline = runConformance(treeDir, controlFile, { expectFailures: false });
    if (!baseline.ok) throw new Error(`baseline: ${baseline.why}`);

    const mutants = {};
    const bookends = [];
    for (const entry of registry) {
      const pristine = makePristine(treeDir);
      if (!pristine.ok) throw new Error(`before ${entry.id}: ${pristine.why}`);
      const bookend = runConformance(treeDir, controlFile, { expectFailures: false });
      bookends.push({ id: entry.id, green: bookend.ok, why: bookend.why });
      if (!bookend.ok) {
        mutants[entry.id] = { applied: false, notApplied: `the pristine bookend was not green: ${bookend.why}`, report: null };
        continue;
      }

      const mutation = applyMutation(treeDir, entry.subject);
      if (!mutation.applied) {
        mutants[entry.id] = { applied: false, notApplied: mutation.notApplied, report: null };
        continue;
      }
      const built = npm(treeDir, ["run", "build"]);
      if (built.status !== 0) {
        // A mutant that does not COMPILE is a refused pair, not a firing: the
        // control would go red for a reason that is not the defect.
        mutants[entry.id] = { applied: false, notApplied: `the mutated tree does not build (exit ${String(built.status)})`, report: null };
        continue;
      }
      const run = runConformance(treeDir, controlFile, { expectFailures: true });
      mutants[entry.id] = run.ok
        ? { applied: true, notApplied: null, report: run.report }
        : { applied: false, notApplied: `the mutant run refused: ${run.why}`, report: null };
    }

    const artifact = evaluateMatrix({
      registry,
      controls,
      baseline: baseline.report,
      mutants,
      sources,
      baseCommit,
      generatedAt,
      repoRoot: treeDir,
    });
    return {
      ...artifact,
      runId,
      /**
       * The pairing §1 relies on: which bytes this matrix actually ran against.
       *
       * BOTH digests, because R40#3 showed they can disagree: `sha256AtBase` is
       * the committed blob's raw bytes, `sha256InTree` is what tsc and vitest
       * actually read after checkout — and on a Windows checkout with CRLF
       * conversion those differ legitimately. Publishing one and calling it the
       * other is the claim that could not be kept; publishing both lets a reader
       * see the conversion instead of being told it did not happen.
       */
      subjects: registry.map((e) => ({
        id: e.id,
        kind: e.kind,
        path: e.subject.path,
        sha256AtBase: blobSha(repoRoot, baseCommit, e.subject.path),
        sha256InTree: pristineSubjectShas[e.subject.path] ?? null,
        why: e.why,
      })),
      conformance: [
        {
          file: controlFile,
          sha256AtBase: blobSha(repoRoot, baseCommit, controlFile),
          sha256InTree: conformanceInTree,
        },
      ],
      bookends,
      runsSpent: 1 + 2 * registry.length,
    };
  } finally {
    if (!keepTree) releaseTree(repoRoot, treeDir);
  }
}

/**
 * Give the worktree back, and PRUNE whatever happens.
 *
 * R40#4. This was `rmSync` then `prune`, with no nested recovery: on Windows a
 * lingering npm/vitest child, an antivirus scan or a read-only `.git` entry can
 * make the recursive removal throw, so `prune` never ran, the original error was
 * masked, and the registration leaked — permanently, because the next run mints
 * a fresh `mkdtemp` path and never repairs the old one. Now git is asked first
 * (it knows about its own locks), removal retries, and prune runs in its own
 * `finally` regardless. What could not be released is REPORTED, not swallowed.
 */
export function releaseTree(repoRoot, treeDir) {
  const problems = [];
  try {
    const removed = git(repoRoot, ["worktree", "remove", "--force", treeDir]);
    if (!removed.ok && existsSync(treeDir)) {
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          rmSync(treeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
        }
      }
      if (lastError !== null) problems.push(`${treeDir} could not be removed: ${String(lastError)}`);
    }
  } finally {
    const pruned = git(repoRoot, ["worktree", "prune"]);
    if (!pruned.ok) problems.push(`git worktree prune refused: ${pruned.err}`);
  }
  for (const p of problems) console.error(`WARNING: ${p}`);
  return problems;
}

/**
 * The committed blob's RAW BYTES, hashed.
 *
 * R40#3. This read `sha256(show.out)` through the shared `git()` helper, whose
 * `.trimEnd()` strips the trailing newline every one of these files ends with —
 * so the recorded digest already disagreed with the blob it claimed to name,
 * before line endings were even considered. `encoding: "buffer"` and no trimming
 * is the only form that can carry the artifact's byte-level claim.
 */
export function blobSha(repoRoot, commit, rel) {
  const r = spawnSync("git", ["-C", repoRoot, "show", `${commit}:${rel}`], { maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 && r.stdout !== null ? createHash("sha256").update(r.stdout).digest("hex") : null;
}

/** The bytes actually on disk in the tree — what tsc and vitest really read. */
export function worktreeSha(treeDir, rel) {
  try {
    return createHash("sha256").update(readFileSync(path.join(treeDir, rel))).digest("hex");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI: node scripts/b12-mutate.mjs <runId> --at <iso8601> [--commit <sha>]
// ---------------------------------------------------------------------------

const isMain = (() => {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const runId = argv.find((a) => !a.startsWith("--"));
  const at = argv[argv.indexOf("--at") + 1];
  const commit = argv.includes("--commit") ? argv[argv.indexOf("--commit") + 1] : undefined;
  if (runId === undefined || !argv.includes("--at") || at === undefined) {
    console.error("usage: node scripts/b12-mutate.mjs <runId> --at <iso8601> [--commit <sha>]");
    console.error("  --at is REQUIRED and is not defaulted to the clock: the artifact must be byte-stable.");
    process.exit(2);
  }
  const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]).out;
  runHarness({ repoRoot, commit, runId, generatedAt: at })
    .then((artifact) => {
      const dir = path.join(repoRoot, "evidence");
      mkdirSync(dir, { recursive: true });
      const out = path.join(dir, `${runId}.b12.firing.json`);
      writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      for (const p of artifact.pairs) {
        console.log(`${p.fired ? "FIRED  " : "REFUSED"} ${p.id} — ${p.detail}`);
      }
      console.log(
        artifact.allFired
          ? `\nALL ${artifact.registeredCount} CONTROLS FIRED over ${artifact.runsSpent} runs → ${out}`
          : `\nNOT ALL FIRED (${artifact.firedCount}/${artifact.registeredCount}) → ${out}`
      );
      if (artifact.problems.length > 0) for (const p of artifact.problems) console.log(`  problem: ${p}`);
      process.exit(artifact.allFired ? 0 : 1);
    })
    .catch((e) => {
      console.error(`REFUSED: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(3);
    });
}
