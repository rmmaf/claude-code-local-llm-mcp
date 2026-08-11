/**
 * THE CORPUS AUTHOR — `author <specDir>`, `verify-family <commit>...`.
 * NEVER FROZEN: tooling the operator drives while BUILDING the corpus, before
 * anything is registered. What it enforces is what the frozen clauses will
 * later hold the corpus to — so every check here is a cheaper copy of a
 * refusal the register or the scorer would issue anyway, moved to the moment
 * the defect commit is born.
 *
 * ONE SPEC DIRECTORY → ONE SIBLING COMMIT. A task's `baseCommit` is a commit
 * that CONTAINS the single verified defect; its parent is the shared green
 * base every sibling hangs off. The authoring act is held to five checks, in
 * order, each a named refusal (the seventh adversarial round: the manifest
 * validator proves nothing about the authoring tool, so the tool carries its
 * own oracle — `tests/b12-author.test.ts`):
 *
 *   1. TOPOLOGY — the new commit's ONE parent is exactly the declared parent;
 *      `verify-family` re-checks that a set of base commits are true siblings
 *      (same single parent, all of them).
 *   2. GREEN PARENT — the acceptance predicate PASSES at the parent: the
 *      parent IS the fixed state, or the task's "fix it" has no referent.
 *   3. DEFECT PRESENT — the predicate FAILS at the patched tree: a base the
 *      predicate already accepts carries no defect, and a session spent on it
 *      measures nothing (`admissionRule` 3's task/attempt distinction).
 *   4. SCOPE CONFINEMENT — every path the patch touches intersects the task's
 *      declared fileScope, under the SAME grammar `admissionRule` 7 uses
 *      (imported from the harness, never re-implemented) — and the scope
 *      itself must already pass the rule-7 sweep, so the author cannot mint a
 *      task the register would refuse.
 *   5. TREE HASHES — the committed tree must equal the tree recomputed by an
 *      INDEPENDENT route (the patch applied to a temporary index over the
 *      parent's tree, no working tree involved). Two implementations that are
 *      never compared is this project's signature defect; here the comparison
 *      catches, among other things, a checkout filter (autocrlf) silently
 *      rewriting the bytes the spec declared.
 *
 * The commit is created DETACHED in a scratch worktree; the branch never
 * moves. A refusal after the commit object exists leaves it dangling and
 * unreported-as-success — nothing references it, and `git gc` owns its fate.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseScopeEntry, scopesIntersect, fileScopeViolations } from "./b12-run.mjs";

function fail(why) {
  process.stderr.write(`b12-author: REFUSED — ${why}\n`);
  process.exit(1);
}

function sh(cwd, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    timeout: opts.timeoutMs,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", errorCode: r.error?.code ?? null };
}

const git = (cwd, args, opts) => sh(cwd, "git", args, opts);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The spec, validated SHAPE-FIRST — every reason a spec cannot author, before
 * any git object is touched. Returns { ok: true, spec } | { ok: false, why }.
 */
export function parseAuthorSpec(specDir) {
  const bad = (why) => ({ ok: false, why });
  const specPath = path.join(specDir, "spec.json");
  if (!existsSync(specPath)) return bad(`${specPath} does not exist — a spec directory carries spec.json`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (error) {
    return bad(`${specPath} is not JSON: ${error.message}`);
  }
  if (typeof raw.taskId !== "string" || !SAFE_ID.test(raw.taskId)) {
    return bad("spec.taskId is absent or not a safe path segment ([A-Za-z0-9][A-Za-z0-9_-]{0,63}) — it will name worktrees and evidence directories");
  }
  if (typeof raw.parent !== "string" || !/^[0-9a-f]{40}$/.test(raw.parent)) {
    return bad(`spec.parent must be the full 40-hex green parent commit (got ${JSON.stringify(raw.parent ?? null)})`);
  }
  if (typeof raw.message !== "string" || raw.message.length === 0) {
    return bad("spec.message is absent — the defect commit's message is part of the corpus record");
  }
  if (!Array.isArray(raw.fileScope) || raw.fileScope.length === 0) {
    return bad("spec.fileScope is absent or empty — admissionRule 7's intersection check is vacuous over an undeclared scope");
  }
  for (const entry of raw.fileScope) {
    const parsed = parseScopeEntry(entry);
    if (!parsed.ok) return bad(`spec.fileScope entry ${JSON.stringify(entry)}: ${parsed.error}`);
  }
  // The rule-7 sweep ITSELF, at authoring time: a task whose scope intersects
  // the instrument set will be refused by the register and by the scorer's
  // replay — minting the commit first would only spend the discovery later.
  const violations = fileScopeViolations([{ id: raw.taskId, fileScope: raw.fileScope }]);
  if (violations.length > 0) return bad(violations.join("; "));
  if (typeof raw.patch !== "string" || raw.patch.length === 0) return bad("spec.patch is absent — the defect patch's filename inside the spec directory");
  const patchPath = path.join(specDir, raw.patch);
  if (!existsSync(patchPath)) return bad(`the declared patch ${patchPath} does not exist`);
  if (readFileSync(patchPath, "utf8").trim().length === 0) return bad(`the declared patch ${patchPath} is empty — an empty patch authors the parent again, not a defect`);
  const pred = raw.predicate;
  if (!pred || typeof pred !== "object" || !Array.isArray(pred.argv) || pred.argv.length === 0 || pred.argv.some((a) => typeof a !== "string")) {
    return bad("spec.predicate.argv must be a non-empty argv ARRAY of strings — an argv, not a shell string, so both machines parse it identically");
  }
  if (!Number.isInteger(pred.expectedExit)) return bad("spec.predicate.expectedExit must be an integer — the exit code that means FIXED");
  const timeoutMs = pred.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return bad("spec.predicate.timeoutMs must be a positive number when declared");
  return {
    ok: true,
    spec: {
      taskId: raw.taskId,
      parent: raw.parent,
      message: raw.message,
      fileScope: raw.fileScope,
      patchPath,
      predicate: { argv: pred.argv, expectedExit: pred.expectedExit, timeoutMs },
    },
  };
}

/** Every path the working tree reports changed, rename halves included. */
function changedPaths(worktree) {
  const r = git(worktree, ["status", "--porcelain"]);
  if (r.code !== 0) return null;
  const paths = [];
  for (const line of r.out.split("\n")) {
    if (!line.trim()) continue;
    const body = line.slice(3);
    const arrow = body.indexOf(" -> ");
    if (arrow >= 0) {
      paths.push(body.slice(0, arrow), body.slice(arrow + 4));
    } else {
      paths.push(body);
    }
  }
  return paths.map((p) => p.replace(/^"|"$/g, ""));
}

/** True iff the path lies inside at least one declared scope entry. */
function confined(relPath, scopeEntries) {
  const asFile = parseScopeEntry(relPath.split("\\").join("/"));
  if (!asFile.ok) return false;
  return scopeEntries.some((s) => {
    const parsed = parseScopeEntry(s);
    return parsed.ok && scopesIntersect(asFile, parsed);
  });
}

/**
 * The independent tree: the patch applied to a TEMPORARY index laid over the
 * parent's tree — no working tree, so no checkout filter can rewrite what the
 * patch declares. Returns the tree sha, or null with the reason.
 */
function treeViaIndex(repoRoot, parent, patchPath) {
  const tmpIndex = path.join(mkdtempSync(path.join(os.tmpdir(), "b12-author-idx-")), "index");
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    const read = git(repoRoot, ["read-tree", `${parent}^{tree}`], { env });
    if (read.code !== 0) return { tree: null, why: `read-tree failed: ${read.err.trim()}` };
    const apply = git(repoRoot, ["apply", "--cached", "--", patchPath], { env });
    if (apply.code !== 0) return { tree: null, why: `the patch does not apply to the parent's tree in the index route: ${apply.err.trim()}` };
    const write = git(repoRoot, ["write-tree"], { env });
    if (write.code !== 0) return { tree: null, why: `write-tree failed: ${write.err.trim()}` };
    return { tree: write.out.trim(), why: null };
  } finally {
    rmSync(path.dirname(tmpIndex), { recursive: true, force: true });
  }
}

/**
 * The authoring act. Returns
 *   { ok: true, commit, tree, parent, changed } |
 *   { ok: false, why }
 * and never moves any ref: the commit is born detached in a scratch worktree.
 */
export function authorSibling(repoRoot, specDir) {
  const parsed = parseAuthorSpec(specDir);
  if (!parsed.ok) return parsed;
  const { spec } = parsed;

  const exists = git(repoRoot, ["cat-file", "-e", `${spec.parent}^{commit}`]);
  if (exists.code !== 0) return { ok: false, why: `declared parent ${spec.parent} is not a commit in ${repoRoot}` };

  // mkdtemp RESERVES a unique name; the directory itself is handed to git,
  // because `worktree add` over a pre-existing directory varies by version.
  const wt = mkdtempSync(path.join(os.tmpdir(), "b12-author-wt-"));
  rmSync(wt, { recursive: true, force: true });
  let worktreeAdded = false;
  try {
    const add = git(repoRoot, ["worktree", "add", "--detach", wt, spec.parent]);
    if (add.code !== 0) return { ok: false, why: `could not create the scratch worktree: ${(add.err || add.out).trim()}` };
    worktreeAdded = true;

    // 2. GREEN PARENT — the predicate passes at the parent, or "fix it" has
    // no referent. Run BEFORE the patch so the two predicate runs differ by
    // exactly the defect.
    const atParent = sh(wt, spec.predicate.argv[0], spec.predicate.argv.slice(1), { timeoutMs: spec.predicate.timeoutMs });
    if (atParent.errorCode !== null) {
      return { ok: false, why: `the predicate could not run at the parent (${atParent.errorCode}) — an unrunnable predicate proves nothing about greenness` };
    }
    if (atParent.code !== spec.predicate.expectedExit) {
      return {
        ok: false,
        why: `the parent is not green: predicate exited ${atParent.code}, expected ${spec.predicate.expectedExit} — a defect authored onto a red parent is two defects, one of them unowned`,
      };
    }

    const apply = git(wt, ["apply", "--", spec.patchPath]);
    if (apply.code !== 0) return { ok: false, why: `the defect patch does not apply at the parent: ${apply.err.trim()}` };

    // 4. SCOPE CONFINEMENT — on what the patch ACTUALLY touched, under the
    // harness's own grammar.
    const changed = changedPaths(wt);
    if (changed === null) return { ok: false, why: "git status failed after the patch — an uninspected tree must not read as a confined one" };
    if (changed.length === 0) return { ok: false, why: "the patch changed nothing — an empty defect authors the parent again" };
    const escaped = changed.filter((p) => !confined(p, spec.fileScope));
    if (escaped.length > 0) {
      return { ok: false, why: `the patch escapes the declared fileScope: ${escaped.join(", ")} outside ${JSON.stringify(spec.fileScope)}` };
    }

    // 3. DEFECT PRESENT — the predicate fails at the patched tree.
    const atBase = sh(wt, spec.predicate.argv[0], spec.predicate.argv.slice(1), { timeoutMs: spec.predicate.timeoutMs });
    if (atBase.errorCode !== null) {
      return { ok: false, why: `the predicate could not run at the patched tree (${atBase.errorCode})` };
    }
    if (atBase.code === spec.predicate.expectedExit) {
      return {
        ok: false,
        why: `the predicate is ALREADY green at the patched tree (exit ${atBase.code}) — the base carries no defect, and a session spent on it measures nothing`,
      };
    }

    const stage = git(wt, ["add", "-A"]);
    if (stage.code !== 0) return { ok: false, why: `git add failed in the scratch worktree: ${stage.err.trim()}` };
    const commit = git(wt, ["commit", "-q", "-m", spec.message]);
    if (commit.code !== 0) return { ok: false, why: `git commit failed in the scratch worktree: ${(commit.err || commit.out).trim()}` };
    const revParse = git(wt, ["rev-parse", "HEAD"]);
    if (revParse.code !== 0) return { ok: false, why: `could not read the authored commit back: ${revParse.err.trim()}` };
    const newCommit = revParse.out.trim();

    // 1. TOPOLOGY — one parent, and it is the declared one. Asserted on the
    // OBJECT, not assumed from the worktree's construction.
    const parents = git(repoRoot, ["rev-list", "--parents", "-n", "1", newCommit]).out.trim().split(/\s+/).slice(1);
    if (parents.length !== 1 || parents[0] !== spec.parent) {
      return { ok: false, why: `the authored commit's parents are [${parents.join(", ")}], not exactly the declared ${spec.parent}` };
    }

    // 4 again, ON THE COMMIT — the working tree was checked, but the commit
    // is what ships, and `add -A` could have picked up something status
    // rendered differently.
    const committedFiles = git(repoRoot, ["diff", "--name-only", `${spec.parent}..${newCommit}`]).out.trim().split("\n").filter(Boolean);
    const escapedCommitted = committedFiles.filter((p) => !confined(p, spec.fileScope));
    if (escapedCommitted.length > 0) {
      return { ok: false, why: `the COMMIT escapes the declared fileScope: ${escapedCommitted.join(", ")}` };
    }

    // 5. TREE HASHES — the committed tree against the index-route recompute.
    const committedTree = git(repoRoot, ["rev-parse", `${newCommit}^{tree}`]).out.trim();
    const independent = treeViaIndex(repoRoot, spec.parent, spec.patchPath);
    if (independent.tree === null) return { ok: false, why: independent.why };
    if (independent.tree !== committedTree) {
      return {
        ok: false,
        why:
          `the two application routes disagree: committed tree ${committedTree} != index-route tree ${independent.tree} — ` +
          "a checkout filter (autocrlf, clean/smudge) rewrote bytes between the spec and the commit; author with filters off, or the corpus is not byte-stable",
      };
    }

    return { ok: true, commit: newCommit, tree: committedTree, parent: spec.parent, changed: committedFiles };
  } finally {
    if (worktreeAdded) git(repoRoot, ["worktree", "remove", "--force", wt]);
    rmSync(wt, { recursive: true, force: true });
  }
}

/**
 * TRUE SIBLINGS — every commit has exactly one parent and all parents are the
 * same commit. Returns [] or the reasons. The same-parent topology is what
 * makes the corpus comparable: each base differs from ONE green tree by
 * exactly its own defect.
 */
export function verifySiblings(repoRoot, commits) {
  const reasons = [];
  if (!Array.isArray(commits) || commits.length < 2) {
    return ["verify-family needs at least 2 commits — one commit is trivially its own family"];
  }
  const parentsOf = [];
  for (const c of commits) {
    const r = git(repoRoot, ["rev-list", "--parents", "-n", "1", c]);
    if (r.code !== 0) {
      reasons.push(`${c} is not a commit in ${repoRoot}`);
      continue;
    }
    const parents = r.out.trim().split(/\s+/).slice(1);
    if (parents.length !== 1) {
      reasons.push(`${c} has ${parents.length} parents — a sibling has exactly one`);
      continue;
    }
    parentsOf.push({ commit: c, parent: parents[0] });
  }
  const distinct = [...new Set(parentsOf.map((p) => p.parent))];
  if (distinct.length > 1) {
    reasons.push(
      `the commits are not siblings — ${distinct.length} distinct parents: ${parentsOf.map((p) => `${p.commit.slice(0, 12)}→${p.parent.slice(0, 12)}`).join(", ")}`
    );
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const repoRoot = process.cwd();
  if (cmd === "author") {
    const [specDir] = rest;
    if (!specDir) fail("usage: node scripts/b12-author.mjs author <specDir>");
    const result = authorSibling(repoRoot, path.resolve(specDir));
    if (!result.ok) fail(result.why);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (cmd === "verify-family") {
    if (rest.length < 2) fail("usage: node scripts/b12-author.mjs verify-family <commit> <commit> [...]");
    const reasons = verifySiblings(repoRoot, rest);
    if (reasons.length > 0) fail(reasons.join("\n  "));
    process.stdout.write(`siblings verified: ${rest.length} commit(s), one shared parent\n`);
    return;
  }
  fail(`unknown subcommand ${JSON.stringify(cmd ?? null)} — author | verify-family`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
