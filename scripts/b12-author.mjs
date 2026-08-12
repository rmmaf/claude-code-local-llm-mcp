/**
 * THE CORPUS AUTHOR — `author <specDir>`, `publish <taskId> <commit>`,
 * `retire <taskId>`, `verify-corpus <planPath> [--deep]`, `transport [remote]`,
 * `verify-family <commit>...`.
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
 *
 * PUBLISHING IS A SECOND ACT, and `authorSibling` still performs none of it.
 * That separation is the point: the return type has no way to say "authored
 * but unpublished", so fusing the two would make a `{ok: false}` swallow a sha
 * that exists and an `{ok: true}` claim a publication that did not happen. The
 * five checks say the defect is real; `publishSibling` says it can be found
 * again. What `authorSibling` gained is a COURTESY read — see below — which
 * writes nothing and leaves the invariant above true word for word.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

  // THE COURTESY, NOT THE GUARANTEE — `sealHarness`'s doctrine, borrowed
  // whole: "The early read is a COURTESY — it names the refusal before the
  // work. The guarantee is the exclusive create at the end." The create-only
  // guarantee here is `git tag`'s own refusal inside `publishSibling`; this
  // read exists so an operator whose id is already taken is told so BEFORE a
  // checkout, two predicate runs and five checks, not after.
  //
  // IT WRITES NOTHING. That is what keeps this function's stated invariant —
  // no ref moves — literally true rather than nearly true.
  const taken = readCorpusTag(repoRoot, spec.taskId);
  if (!taken.ok) return { ok: false, why: taken.why };
  if (taken.commit !== null) {
    return {
      ok: false,
      why:
        `${taken.tag} already names ${taken.commit.slice(0, 12)} — one task id is ONE base commit, because the id is a path ` +
        `segment in evidence/<runId>/obs-<taskId>-<arm>/ and two base commits under one id make two runs' evidence ` +
        `indistinguishable; retire the tag (retire ${spec.taskId}) or author under a new id`,
    };
  }

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

    // taskId AND message TRAVEL WITH THE RESULT so the caller never re-reads the
    // spec to learn them. The CLI used to parse the directory a second time
    // between authoring and publishing, which opened two windows on a commit
    // that already existed: an edit that broke the spec exited WITHOUT the sha,
    // and an edit that merely changed the taskId would have published this
    // commit under another task's tag. One read, one truth.
    return {
      ok: true,
      commit: newCommit,
      tree: committedTree,
      parent: spec.parent,
      changed: committedFiles,
      taskId: spec.taskId,
      message: spec.message,
    };
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
// THE CORPUS'S REFS — publish, retire, verify, transport.
// ---------------------------------------------------------------------------

/**
 * WHY ANY REF EXISTS, given the header's "the branch never moves".
 *
 * A dangling commit is not a corpus. It cannot be pushed, it is not carried by
 * a clone, and `git gc` is entitled to it — and B12's 26 sessions run on a
 * SECOND MACHINE that fetches and never pushes. `git worktree add --detach
 * <baseCommit>` (`b12-run.mjs`) is what a session does first, so a base commit
 * that did not travel is 30 refusals, discovered one paid session at a time.
 *
 * ANNOTATED TAGS, and the reason is measured rather than assumed — an earlier
 * draft of this comment claimed a default `git fetch` carries them, and that
 * is FALSE. Measured, on a scratch remote:
 *
 *   - a FRESH `git clone` resolves every base with no operator step;
 *   - a plain `git fetch origin` into an ALREADY-EXISTING clone brings NOTHING,
 *     because default tag auto-following only takes tags pointing INTO the
 *     history it fetched, and these bases are detached and on no branch;
 *   - `git fetch origin --tags`, or `transportLines`' explicit refspec, brings
 *     them.
 *
 * The run machine HAS a clone already, so the second line is the one that
 * governs and the fetch command is load-bearing, not a courtesy. Tags are still
 * the right namespace — a private `refs/b12/*` is carried by clone and fetch
 * ALIKE not at all, and whether a given server even accepts a push there is an
 * unverified premise discovered after 65 commits exist — but the argument for
 * them is "cheaper to retrieve", never "automatic". The tag OBJECT also carries
 * a message and a tagger, which makes publication a record, not a pointer.
 *
 * A PRINTED COMMAND IS NOT A CHECK. `transportLines` exists for the operator's
 * hands, but the guarantee is `corpusVerification` REFUSING on the run machine
 * when a base is absent — and saying, in the refusal, how to fetch it.
 */
export const CORPUS_TAG_PREFIX = "b12/corpus";
export const RETIRED_TAG_PREFIX = "b12/retired";
export const DEFAULT_SPEC_ROOT = "b12-corpus";

/**
 * The tag name for a task, PURE. The id is already held to `SAFE_ID` as a path
 * segment; it is re-checked here because this is a different consumer — a ref
 * component — and a check passed elsewhere is not a reason to skip the one
 * where the string is interpolated. `git check-ref-format` is the second wall
 * and lives in `publishSibling`, which has a repo to ask.
 */
export function corpusTagFor(taskId) {
  if (typeof taskId !== "string" || !SAFE_ID.test(taskId)) {
    return {
      ok: false,
      why: `taskId ${JSON.stringify(taskId ?? null)} is not a safe path segment ([A-Za-z0-9][A-Za-z0-9_-]{0,63}) — it becomes a component of refs/tags/${CORPUS_TAG_PREFIX}/<taskId>`,
    };
  }
  const tag = `${CORPUS_TAG_PREFIX}/${taskId}`;
  return { ok: true, tag, ref: `refs/tags/${tag}` };
}

/**
 * What the corpus tag names, or `null` when it does not exist. Existence and
 * resolvability are asked SEPARATELY: a tag that exists but does not peel to a
 * commit is a corrupt publication, and reporting it as "absent" would invite
 * `publish` to be run over it and refused for the wrong reason.
 */
export function readCorpusTag(repoRoot, taskId) {
  const named = corpusTagFor(taskId);
  if (!named.ok) return named;
  const exists = git(repoRoot, ["show-ref", "--verify", "--quiet", named.ref]);
  if (exists.code !== 0) return { ok: true, tag: named.tag, ref: named.ref, commit: null };
  const peeled = git(repoRoot, ["rev-parse", "--verify", `${named.ref}^{commit}`]);
  if (peeled.code !== 0 || peeled.out.trim() === "") {
    return { ok: false, why: `${named.ref} exists but does not peel to a commit — the publication is corrupt, and retiring it is the only lawful exit` };
  }
  return { ok: true, tag: named.tag, ref: named.ref, commit: peeled.out.trim() };
}

/**
 * PUBLISH — create-only, by `git tag`'s OWN refusal rather than by a check
 * this file performs and then races. A second publication under one id is
 * refused by git before any ref moves.
 *
 * THE FAILURE ARM ALWAYS CARRIES THE COMMIT. This runs after five checks and a
 * paid checkout have already produced a real object; a `{ok: false, why}` that
 * dropped the sha would strand it where only `git fsck` could find it. The
 * caller's contract is to print it and name the repair, never to re-author —
 * `git commit` embeds committer time, so re-authoring the same spec mints a
 * SECOND dangling commit for one defect.
 */
export function publishSibling(repoRoot, taskId, commit, message) {
  const named = corpusTagFor(taskId);
  if (!named.ok) return { ok: false, why: named.why, commit };
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    return { ok: false, why: `publish needs the full 40-hex commit, got ${JSON.stringify(commit ?? null)}`, commit };
  }
  const format = git(repoRoot, ["check-ref-format", named.ref]);
  if (format.code !== 0) return { ok: false, why: `git rejects ${named.ref} as a ref name`, commit };
  const isCommit = git(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]);
  if (isCommit.code !== 0) return { ok: false, why: `${commit} is not a commit in ${repoRoot} — nothing to publish`, commit };
  const already = readCorpusTag(repoRoot, taskId);
  if (!already.ok) return { ok: false, why: already.why, commit };
  if (already.commit !== null) {
    return { ok: false, why: `${named.tag} already names ${already.commit.slice(0, 12)} — publication is create-only; retire it first`, commit };
  }
  const text = typeof message === "string" && message.length > 0 ? message : `b12 corpus base for ${taskId}`;
  // Signing is NOT disabled here. If this repository or user signs tags, a
  // failure to sign is a real failure and belongs in the refusal, not in a
  // flag that quietly opts out of the operator's own policy.
  const made = git(repoRoot, ["tag", "-a", "-m", text, named.tag, commit]);
  if (made.code !== 0) {
    return { ok: false, why: `git tag refused: ${(made.err || made.out).trim()}`, commit };
  }
  // WROTE IS NOT READS-BACK-AS. The whole purpose of the tag is retrieval, so
  // retrieval is what is asserted — not the exit code of the command that
  // claimed to create it.
  const back = readCorpusTag(repoRoot, taskId);
  if (!back.ok) return { ok: false, why: back.why, commit };
  if (back.commit !== commit) {
    return { ok: false, why: `${named.tag} was created but resolves to ${String(back.commit)}, not ${commit}`, commit };
  }
  return { ok: true, tag: named.tag, ref: named.ref, commit };
}

/**
 * RETIRE — the only lawful way to free a task id, and NEVER a bare delete.
 *
 * The old base commit may already be named by a spent pilot session or by a
 * manifest on disk, so it has to stay reachable and auditable. The retired tag
 * is therefore created FIRST and read back BEFORE the corpus tag is removed:
 * at no instant between the two is the commit unreferenced. If the removal
 * fails, both tags exist — reported, and strictly safer than the reverse.
 *
 * THAT ORDERING IS A GUARANTEE AGAINST FAILURE, NOT AGAINST A CONCURRENT
 * MUTATOR, and an earlier draft of this comment claimed more than it holds.
 * These are three separate git invocations and git offers no transaction
 * spanning a tag create and a tag delete, so a second process deleting the
 * retired tag between the readback and the removal defeats it. What IS closed
 * is the other half: the removal is a COMPARE-AND-DELETE against the ref value
 * read at the top, so a corpus tag some other process replaced in the seam is
 * refused rather than dropped. Single-operator use is the assumption; the
 * corpus is authored by one person on one machine.
 *
 * `<taskId>-<shortSha>` rather than `<taskId>/<sha>` deliberately: a tag named
 * `b12/retired/t17` and one named `b12/retired/t17/abc` cannot coexist in a
 * loose ref store, and nothing here should depend on which one was written
 * first.
 */
export function retireCorpusTag(repoRoot, taskId) {
  const current = readCorpusTag(repoRoot, taskId);
  if (!current.ok) return current;
  if (current.commit === null) return { ok: false, why: `${current.tag} does not exist — there is nothing to retire` };
  // The UNPEELED ref value, read at the same moment as the decision to retire.
  // `readCorpusTag` peels to a commit; the delete below has to compare against
  // what the REF holds, which for an annotated tag is the tag object.
  const oldRef = git(repoRoot, ["rev-parse", "--verify", `refs/tags/${current.tag}`]);
  if (oldRef.code !== 0) {
    return { ok: false, why: `${current.tag} peels to a commit but its ref could not be read — refusing to retire` };
  }
  const oldValue = oldRef.out.trim();
  const retired = `${RETIRED_TAG_PREFIX}/${taskId}-${current.commit.slice(0, 12)}`;
  const already = git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/tags/${retired}`]);
  if (already.code === 0) {
    return { ok: false, why: `${retired} already exists — this exact base was retired before, so the corpus tag is a re-publication nobody recorded` };
  }
  const made = git(repoRoot, ["tag", "-a", "-m", `retired from ${current.tag}`, retired, current.commit]);
  if (made.code !== 0) return { ok: false, why: `could not create ${retired}: ${(made.err || made.out).trim()} — the corpus tag was NOT removed` };
  const back = git(repoRoot, ["rev-parse", "--verify", `refs/tags/${retired}^{commit}`]);
  if (back.code !== 0 || back.out.trim() !== current.commit) {
    return { ok: false, why: `${retired} does not resolve to ${current.commit} — the corpus tag was NOT removed, and both tags now exist` };
  }
  const removed = git(repoRoot, ["update-ref", "-d", `refs/tags/${current.tag}`, oldValue]);
  if (removed.code !== 0) {
    return { ok: false, why: `${retired} was created but ${current.tag} could not be removed: ${(removed.err || removed.out).trim()} — the base is safe; free the id by hand` };
  }
  return { ok: true, retired, freed: current.tag, commit: current.commit };
}

/**
 * The exact commands, EXPORTED so the oracle pins them rather than trusting a
 * string in a doc comment. A fresh `git clone` needs neither (measured); a
 * clone that already exists needs the FETCH line and will not be told so by
 * git — a plain `git fetch` succeeds and brings no base at all.
 */
export function transportLines(remote = "origin") {
  const spec = `refs/tags/${CORPUS_TAG_PREFIX}/*:refs/tags/${CORPUS_TAG_PREFIX}/*`;
  return {
    push: `git push ${remote} "${spec}"`,
    fetch: `git fetch ${remote} "${spec}"`,
  };
}

/** A blob's sha256 at a commit, over RAW BYTES — `{ok, sha256}` or a reason. */
function blobSha256(repoRoot, commit, relPath) {
  const r = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", `${commit}:${relPath}`], {
    encoding: "buffer",
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0) return { ok: false, why: `${relPath} is not readable at ${commit.slice(0, 12)}` };
  return { ok: true, sha256: createHash("sha256").update(r.stdout).digest("hex") };
}

/**
 * THE CORPUS, VERIFIED AS A WHOLE — every reason a set of published bases
 * would fail somewhere it costs money to fail. Returns `[]` or the reasons.
 *
 * `plan` is `{ tasks: [{ id, specDir }], ratesSha256, specRoot, deep }`. Each
 * task's `fileScope`, `parent` and `predicate` are read from its spec through
 * `parseAuthorSpec`, never re-declared here: one source of truth, and the same
 * parser that authored the commit.
 *
 * WHAT `--deep` BUYS, and why it is not the default: the shallow pass proves
 * the corpus is SHAPED right, and the deep pass proves each defect is STILL A
 * DEFECT by re-running the predicate at the base. Only the second catches a
 * defect neutralised by a later edit to the parent's history or by a predicate
 * whose meaning drifted. It costs 65 checkouts and 65 predicate runs, zero
 * API, and it belongs on the RUN MACHINE — that machine's checkout filters and
 * node version are the ones the sessions will meet.
 */
export function corpusVerification(repoRoot, plan) {
  const reasons = [];
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  if (tasks.length === 0) return ["the verification plan names no tasks — an empty corpus verifies nothing"];
  const specRoot = typeof plan?.specRoot === "string" && plan.specRoot.length > 0 ? plan.specRoot : DEFAULT_SPEC_ROOT;
  const transport = transportLines("origin");

  const resolved = [];
  for (const t of tasks) {
    const id = t?.id ?? "(unnamed)";
    const parsed = parseAuthorSpec(path.resolve(repoRoot, String(t?.specDir ?? "")));
    if (!parsed.ok) {
      reasons.push(`task ${id}: ${parsed.why}`);
      continue;
    }
    const spec = parsed.spec;
    if (spec.taskId !== id) {
      reasons.push(`task ${id}: its spec declares taskId ${spec.taskId} — the plan and the spec name different tasks`);
      continue;
    }
    const tag = readCorpusTag(repoRoot, id);
    if (!tag.ok) {
      reasons.push(`task ${id}: ${tag.why}`);
      continue;
    }
    if (tag.commit === null) {
      reasons.push(
        `task ${id}: no corpus tag ${tag.tag} — the base commit is not in this repository. If this is the run machine, fetch it: ${transport.fetch}`
      );
      continue;
    }
    resolved.push({ id, spec, commit: tag.commit });
  }

  for (const r of resolved) {
    // TOPOLOGY, per commit: the tag must name a child of the spec's declared
    // parent. `verifySiblings` below proves the set shares ONE parent; this
    // proves each tag points where its own spec says.
    const parents = git(repoRoot, ["rev-list", "--parents", "-n", "1", r.commit]);
    if (parents.code !== 0) {
      reasons.push(`task ${r.id}: ${r.commit.slice(0, 12)} is not a commit in ${repoRoot}`);
      continue;
    }
    const ps = parents.out.trim().split(/\s+/).slice(1);
    if (ps.length !== 1 || ps[0] !== r.spec.parent) {
      reasons.push(`task ${r.id}: the tagged base's parents are [${ps.join(", ")}], not exactly the spec's declared ${r.spec.parent}`);
    }
    // SCOPE, ON THE COMMIT rather than on the spec. `parseAuthorSpec` already
    // swept the DECLARED scope; the spec directory can be edited after the
    // commit was minted, so what ships is what is judged.
    const changed = git(repoRoot, ["diff", "--name-only", `${r.spec.parent}..${r.commit}`]);
    if (changed.code !== 0) {
      reasons.push(`task ${r.id}: could not diff ${r.spec.parent.slice(0, 12)}..${r.commit.slice(0, 12)}`);
    } else {
      const escaped = changed.out.trim().split("\n").filter(Boolean).filter((p) => !confined(p, r.spec.fileScope));
      if (escaped.length > 0) {
        reasons.push(`task ${r.id}: the PUBLISHED base changes ${escaped.join(", ")}, outside its declared fileScope ${JSON.stringify(r.spec.fileScope)}`);
      }
    }
    // THE RATES FILE, INSIDE THE BASE'S OWN TREE. `b12-run.mjs`'s
    // `assertRatesFrozen` reads `<worktree>/.local-coder/rates.json` — the
    // TASK'S tree, not the repository's — and refuses on a mismatch after the
    // worktree is built. Asked here against the BLOB, which equals the
    // checkout while `.gitattributes` pins `*.json eol=lf`; `--deep` asks the
    // checkout itself, by the harness's own route.
    if (typeof plan?.ratesSha256 === "string" && plan.ratesSha256.length > 0) {
      const blob = blobSha256(repoRoot, r.commit, ".local-coder/rates.json");
      if (!blob.ok) reasons.push(`task ${r.id}: ${blob.why} — every base must carry the rates file the manifest pins`);
      else if (blob.sha256 !== plan.ratesSha256) {
        reasons.push(`task ${r.id}: .local-coder/rates.json at the base hashes ${blob.sha256.slice(0, 12)}…, manifest pins ${plan.ratesSha256.slice(0, 12)}…`);
      }
    }
  }

  // ONE SHARED PARENT over the whole set — what makes the corpus comparable.
  if (resolved.length >= 2) {
    reasons.push(...verifySiblings(repoRoot, resolved.map((r) => r.commit)));
  }

  // THE SPEC ROOT MUST NOT BE IN THE PARENT'S TREE. Every arm runs in a
  // worktree at a base, and a base's tree is the parent's plus one patch — so
  // a parent carrying the spec directories would hand each session the defect
  // patch it is being asked to repair, and the predicate that judges it.
  const parentSet = [...new Set(resolved.map((r) => r.spec.parent))];
  for (const parent of parentSet) {
    const leak = git(repoRoot, ["cat-file", "-e", `${parent}:${specRoot}`]);
    if (leak.code === 0) {
      reasons.push(
        `the green parent ${parent.slice(0, 12)} CONTAINS ${specRoot}/ — every arm worktree would ship the session its own defect patch and predicate; the spec root must be committed only after the parent`
      );
    }
  }

  if (plan?.deep === true) reasons.push(...deepPredicateReasons(repoRoot, resolved, plan?.ratesSha256));
  return reasons;
}

/**
 * `--deep`'s half: the predicate re-run at each base, in a scratch worktree,
 * asserting the defect is STILL a defect. Separated so the shallow pass stays
 * a pure-ish sweep of git metadata and this one owns the checkouts.
 */
function deepPredicateReasons(repoRoot, resolved, ratesSha256) {
  const reasons = [];
  for (const r of resolved) {
    const wt = mkdtempSync(path.join(os.tmpdir(), "b12-verify-wt-"));
    rmSync(wt, { recursive: true, force: true });
    let added = false;
    try {
      const add = git(repoRoot, ["worktree", "add", "--detach", wt, r.commit]);
      if (add.code !== 0) {
        reasons.push(`task ${r.id}: could not check out the base: ${(add.err || add.out).trim()}`);
        continue;
      }
      added = true;
      // A FRESH WORKTREE THAT IS NOT CLEAN IS A REFUSAL IN `observe`
      // ("fresh worktree is not clean"), and the usual cause is a checkout
      // filter — a smudge that rewrites bytes on the way out, so the tree git
      // just wrote disagrees with the tree git just read. That is a property
      // of THIS MACHINE, which is why `--deep` belongs on the run machine and
      // why re-running the predicate alone would not have found it.
      const porcelain = git(wt, ["status", "--porcelain"]);
      if (porcelain.code !== 0) {
        reasons.push(`task ${r.id}: git status failed in the base's checkout — an uninspected worktree must not read as a clean one`);
      } else if (porcelain.out.trim() !== "") {
        reasons.push(
          `task ${r.id}: the base's FRESH checkout is not clean (${porcelain.out.trim().split("\n").slice(0, 3).join("; ")}) — ` +
            "observe refuses on exactly this, and a checkout filter on this machine is the usual cause"
        );
      }
      // The harness's own route to the rates file: the CHECKED-OUT bytes, not
      // the blob — this is the one place the two can be compared, and the
      // shallow pass's blob answer is only equal to it while `.gitattributes`
      // keeps `*.json` at eol=lf.
      const ratesFile = path.join(wt, ".local-coder", "rates.json");
      if (!existsSync(ratesFile)) {
        reasons.push(`task ${r.id}: .local-coder/rates.json is absent from the base's CHECKOUT — assertRatesFrozen refuses on it`);
      } else if (typeof ratesSha256 === "string" && ratesSha256.length > 0) {
        const got = createHash("sha256").update(readFileSync(ratesFile)).digest("hex");
        if (got !== ratesSha256) {
          reasons.push(
            `task ${r.id}: the CHECKED-OUT .local-coder/rates.json hashes ${got.slice(0, 12)}…, manifest pins ${ratesSha256.slice(0, 12)}… — ` +
              "this is the harness's own route (sha256 of the file, not the blob), so it is the answer that decides a session"
          );
        }
      }
      const ran = sh(wt, r.spec.predicate.argv[0], r.spec.predicate.argv.slice(1), { timeoutMs: r.spec.predicate.timeoutMs });
      if (ran.errorCode !== null) {
        reasons.push(`task ${r.id}: the predicate could not run at the base (${ran.errorCode}) — an unrunnable predicate scores nothing`);
      } else if (ran.code === r.spec.predicate.expectedExit) {
        reasons.push(
          `task ${r.id}: the predicate is GREEN at the published base (exit ${ran.code}) — the defect is gone, and a session spent here would measure nothing`
        );
      }
    } finally {
      if (added) git(repoRoot, ["worktree", "remove", "--force", wt]);
      rmSync(wt, { recursive: true, force: true });
    }
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
    // A REFUSAL HERE PRINTS NO SHA, AND THE ASYMMETRY IS DELIBERATE. Authoring
    // either produced no commit at all, or produced one that failed its own
    // verification — a commit carrying an unverified defect, which must never
    // be published and is exactly what `git gc` should take. Naming its sha
    // here would invite an operator to `publish` by hand the one object the
    // five checks exist to stop.
    if (!result.ok) fail(result.why);
    // THE TWO ACTS, IN ORDER, AND THE SEAM BETWEEN THEM IS NAMED. Everything
    // after this line runs with a real VERIFIED commit in the store, so a
    // failure here is not "the authoring failed" — it is "the authoring
    // succeeded and the publication did not", and the sha is the only thing
    // that can repair it. Re-authoring is NOT the repair: `git commit` embeds
    // committer time, so it would mint a second dangling commit for one defect.
    //
    // The id and message come from the RESULT, never from a second read of the
    // spec directory. Re-reading it here was a real defect: a spec edited in
    // the seam could exit without the sha, or retarget this commit at another
    // task's tag.
    const published = publishSibling(repoRoot, result.taskId, result.commit, result.message);
    if (!published.ok) {
      process.stderr.write(`b12-author: UNREFERENCED ${result.commit}\n`);
      process.stderr.write(`b12-author: repair with — node scripts/b12-author.mjs publish ${result.taskId} ${result.commit}\n`);
      fail(published.why);
    }
    process.stdout.write(JSON.stringify({ ...result, tag: published.tag, ref: published.ref }, null, 2) + "\n");
    return;
  }
  if (cmd === "publish") {
    const [taskId, commit, ...messageWords] = rest;
    if (!taskId || !commit) fail("usage: node scripts/b12-author.mjs publish <taskId> <commit> [message...]");
    const result = publishSibling(repoRoot, taskId, commit, messageWords.join(" "));
    if (!result.ok) fail(result.why);
    process.stdout.write(`published: ${result.ref} -> ${result.commit}\n(${transportLines().push})\n`);
    return;
  }
  if (cmd === "retire") {
    const [taskId] = rest;
    if (!taskId) fail("usage: node scripts/b12-author.mjs retire <taskId>");
    const result = retireCorpusTag(repoRoot, taskId);
    if (!result.ok) fail(result.why);
    process.stdout.write(`retired: ${result.freed} -> refs/tags/${result.retired} (${result.commit.slice(0, 12)} stays reachable)\n`);
    return;
  }
  if (cmd === "verify-corpus") {
    const [planPath] = rest;
    if (!planPath) fail("usage: node scripts/b12-author.mjs verify-corpus <planPath> [--deep]");
    let plan;
    try {
      plan = JSON.parse(readFileSync(path.resolve(planPath), "utf8"));
    } catch (error) {
      fail(`${planPath} is not readable JSON: ${error.message}`);
    }
    const deep = rest.includes("--deep");
    const reasons = corpusVerification(repoRoot, { ...plan, deep });
    if (reasons.length > 0) fail(`${reasons.length} reason(s):\n  ${reasons.join("\n  ")}`);
    process.stdout.write(`corpus verified: ${plan.tasks.length} task(s)${deep ? ", predicates re-run at every base" : " (shallow — add --deep on the run machine)"}\n`);
    return;
  }
  if (cmd === "transport") {
    const lines = transportLines(rest[0] ?? "origin");
    process.stdout.write(`# a fresh clone needs NEITHER line; these are for a clone that already exists.\n${lines.push}\n${lines.fetch}\n`);
    return;
  }
  if (cmd === "verify-family") {
    if (rest.length < 2) fail("usage: node scripts/b12-author.mjs verify-family <commit> <commit> [...]");
    const reasons = verifySiblings(repoRoot, rest);
    if (reasons.length > 0) fail(reasons.join("\n  "));
    process.stdout.write(`siblings verified: ${rest.length} commit(s), one shared parent\n`);
    return;
  }
  fail(
    `unknown subcommand ${JSON.stringify(cmd ?? null)} — author | publish | retire | verify-corpus | transport | verify-family`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
