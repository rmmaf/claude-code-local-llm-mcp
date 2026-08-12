/**
 * ORACLE FOR THE CORPUS'S REFS — the publish/retire/verify/transport half of
 * `scripts/b12-author.mjs`.
 *
 * The authoring half already carries its own wave (`b12-author.test.ts`); this
 * one exists because publication is a SECOND act with its own refusals, and
 * because the whole point of it — that a base commit can be found again on
 * another machine — is a claim about git's DEFAULT behaviour that no amount of
 * reading settles. So the transport block below does not assert a belief: it
 * pushes into a scratch bare remote and then asks a fresh clone and an
 * already-existing clone what they can resolve. That experiment refuted the
 * first draft of this design's central claim (see `TRANSPORT` below), which is
 * the reason it is a test and not a comment.
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  authorSibling,
  corpusTagFor,
  corpusVerification,
  publishSibling,
  readCorpusTag,
  retireCorpusTag,
  transportLines,
} from "../scripts/b12-author.mjs";
import { makeTempRoot } from "./helpers.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = makeTempRoot("b12-corpus-refs-test-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr ?? ""}`);
  return (r.stdout ?? "").trim();
}
/** The same call, allowed to fail — resolvability is a QUESTION here, not a precondition. */
function gitCode(cwd: string, args: string[]): number {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).status ?? 1;
}
const resolves = (cwd: string, commit: string): boolean => gitCode(cwd, ["cat-file", "-e", `${commit}^{commit}`]) === 0;

function initRepo(root: string, config: Record<string, string> = {}): void {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "corpus-oracle"]);
  git(root, ["config", "user.email", "corpus@example.invalid"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "tag.gpgSign", "false"]);
  for (const [k, v] of Object.entries(config)) git(root, ["config", k, v]);
}

const EXAMPLE = "exports.answer = () => 42;\n";
const RATES = '{"multipliers":"pinned"}\n';
const PREDICATE = {
  argv: ["node", "-e", "const a = require('./src/example.js').answer(); process.exit(a === 42 ? 0 : 1);"],
  expectedExit: 0,
  timeoutMs: 60_000,
};
const DEFECT_PATCH = [
  "--- a/src/example.js",
  "+++ b/src/example.js",
  "@@ -1 +1 @@",
  "-exports.answer = () => 42;",
  "+exports.answer = () => 41;",
  "",
].join("\n");

/** The shared green base every sibling hangs off, carrying the rates file the harness reads. */
async function greenBase(root: string): Promise<string> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, ".local-coder"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "example.js"), EXAMPLE, "utf8");
  await fs.writeFile(path.join(root, ".local-coder", "rates.json"), RATES, "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "green base"]);
  return git(root, ["rev-parse", "HEAD"]);
}

async function specDirOf(
  parent: string,
  taskId = "t1",
  over: Record<string, unknown> = {},
  patch: string = DEFECT_PATCH
): Promise<string> {
  const dir = path.join(tempRoot(), "spec");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "defect.patch"), patch, "utf8");
  await fs.writeFile(
    path.join(dir, "spec.json"),
    JSON.stringify({
      taskId,
      parent,
      message: `task ${taskId}: the answer drifts to 41`,
      fileScope: ["src/example.js"],
      patch: "defect.patch",
      predicate: PREDICATE,
      ...over,
    }),
    "utf8"
  );
  return dir;
}

function okOf<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got refusal: ${String((r as { why?: string }).why)}`);
  return r as Extract<T, { ok: true }>;
}
function whyOf<T extends { ok: boolean }>(r: T): string {
  if (r.ok) throw new Error("expected a refusal; the call succeeded");
  return (r as unknown as { why: string }).why;
}

/**
 * The CLI as an operator runs it. `main` reads `process.cwd()` for the repo, so
 * the cwd IS the argument that matters and it cannot be passed any other way.
 */
const CLI = fileURLToPath(new URL("../scripts/b12-author.mjs", import.meta.url));
function runCli(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Author and publish in one step — the CLI's own order, used where the tag is the subject. */
async function authorAndPublish(root: string, parent: string, taskId: string): Promise<string> {
  const authored = okOf(authorSibling(root, await specDirOf(parent, taskId)));
  okOf(publishSibling(root, taskId, authored.commit, `base for ${taskId}`));
  return authored.commit;
}

describe("b12 corpus refs — publication is a second act, with its own refusals", () => {
  it("the CLI composes the two acts, and a refusal BEFORE the commit prints no sha", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    const specDir = await specDirOf(parent, "t1");

    // THE COMPOSITION ITSELF, which every other test here skips by calling the
    // two functions directly. An adversarial round found the defect that makes
    // this worth covering: the CLI used to RE-PARSE the spec directory between
    // authoring and publishing, so a spec edited in that seam could publish a
    // commit under another task's tag, or exit without the sha of a commit that
    // already existed. The id now travels on the authoring result.
    const first = runCli(root, ["author", specDir]);
    expect(first.status).toBe(0);
    const reported = JSON.parse(first.stdout) as { commit: string; tag: string; taskId: string };
    expect(reported.tag).toBe("b12/corpus/t1");
    expect(reported.taskId).toBe("t1");
    expect(okOf(readCorpusTag(root, "t1")).commit).toBe(reported.commit);

    // CONTROL, and it pins the asymmetry rather than assuming it: the id is
    // taken now, so the courtesy read refuses BEFORE any object exists. There
    // is nothing unreferenced, so nothing may claim there is — that warning
    // belongs to publication failures alone, where the commit is real and
    // verified.
    const second = runCli(root, ["author", specDir]);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/already names/);
    expect(second.stderr).not.toMatch(/UNREFERENCED/);
    expect(git(root, ["tag", "-l", "b12/corpus/*"]).split("\n").filter(Boolean)).toHaveLength(1);
  }, 45_000);


  it("publishes exactly one tag at the authored commit, and authoring alone still moves nothing", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    const headBefore = git(root, ["rev-parse", "HEAD"]);

    const authored = okOf(authorSibling(root, await specDirOf(parent, "t1")));
    // THE PRE-EXISTING INVARIANT, restated here because this suite is what
    // would break it: `authorSibling` gained a READ, not a write.
    expect(git(root, ["tag", "-l"])).toBe("");

    const published = okOf(publishSibling(root, "t1", authored.commit, "base for t1"));
    expect(published.tag).toBe("b12/corpus/t1");
    expect(git(root, ["tag", "-l"]).split("\n").filter(Boolean)).toEqual(["b12/corpus/t1"]);
    expect(git(root, ["rev-parse", "b12/corpus/t1^{commit}"])).toBe(authored.commit);
    // An ANNOTATED tag: a record with a message, not a bare pointer.
    expect(git(root, ["cat-file", "-t", "refs/tags/b12/corpus/t1"])).toBe("tag");
    expect(git(root, ["rev-parse", "HEAD"])).toBe(headBefore);
  }, 30_000);

  it("refuses a SECOND publication under one id, and the refusal carries the sha", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    const commit = await authorAndPublish(root, parent, "t1");

    const second = publishSibling(root, "t1", commit, "again");
    expect(whyOf(second)).toMatch(/already names/);
    // THE SHA IS NEVER DROPPED. This runs after a real object exists; a refusal
    // that lost it would strand the commit where only `git fsck` finds it.
    expect((second as unknown as { commit: string }).commit).toBe(commit);
    // Control: a fresh id publishes the same commit without complaint.
    expect(okOf(publishSibling(root, "t2", commit, "other id")).tag).toBe("b12/corpus/t2");
  }, 30_000);

  it("refuses a taken id BEFORE the worktree — no checkout, no commit, no ref", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    await authorAndPublish(root, parent, "t1");

    const commitsBefore = git(root, ["rev-list", "--all", "--count"]);
    const worktreesBefore = git(root, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).length;
    expect(whyOf(authorSibling(root, await specDirOf(parent, "t1")))).toMatch(/already names/);
    // The courtesy's whole value: nothing was spent finding out.
    expect(git(root, ["rev-list", "--all", "--count"])).toBe(commitsBefore);
    expect(git(root, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).length).toBe(worktreesBefore);
    // Control: the same spec under an untaken id authors.
    expect(okOf(authorSibling(root, await specDirOf(parent, "t2"))).parent).toBe(parent);
  }, 45_000);

  it("leaves NOTHING referenced when a check refuses — the dangling-on-refusal invariant", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    // A red parent: check 2 refuses before any object is committed.
    const dir = await specDirOf(parent, "t1", { predicate: { ...PREDICATE, argv: ["node", "-e", "process.exit(1);"] } });
    expect(whyOf(authorSibling(root, dir))).toMatch(/parent is not green/);
    expect(git(root, ["tag", "-l", "b12/corpus/*"])).toBe("");
    // Control: the happy path leaves exactly one.
    await authorAndPublish(root, parent, "t1");
    expect(git(root, ["tag", "-l", "b12/corpus/*"]).split("\n").filter(Boolean)).toHaveLength(1);
  }, 45_000);

  it("retires without ever leaving the base unreferenced, and frees the id", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    const first = await authorAndPublish(root, parent, "t1");

    const retired = okOf(retireCorpusTag(root, "t1"));
    expect(retired.retired).toBe(`b12/retired/t1-${first.slice(0, 12)}`);
    // THE OLD BASE STAYS REACHABLE. A spent pilot session may already name it.
    expect(resolves(root, first)).toBe(true);
    expect(git(root, ["rev-parse", `refs/tags/${retired.retired}^{commit}`])).toBe(first);
    expect(okOf(readCorpusTag(root, "t1")).commit).toBeNull();

    // The id is genuinely free: a second authoring publishes under it, the tag
    // now names the new base, and the old one is still reachable.
    //
    // WHAT THIS DELIBERATELY DOES NOT ASSERT IS `second !== first`, and the
    // reason is measured. Both authorings share parent, tree, message and
    // identity, so only the committer timestamp separates them — and git
    // records that at ONE-SECOND resolution. Two `commit-tree` calls with
    // identical inputs pinned to the same second produce a byte-identical sha
    // (probed directly). `authorSibling` currently takes 1155–1232 ms per call
    // on this machine, so the two calls straddle a second boundary and the
    // shas differ; that is a property of the clock, not of retirement. A
    // faster machine — or making the authoring faster, which is a WIN —
    // would drop it under a second and turn the assertion red. A test whose
    // greenness depends on the code staying slow is not a test.
    const second = await authorAndPublish(root, parent, "t1");
    expect(okOf(readCorpusTag(root, "t1")).commit).toBe(second);
    expect(resolves(root, first)).toBe(true);
    // Control: retiring an id that carries no tag refuses.
    expect(whyOf(retireCorpusTag(root, "t9"))).toMatch(/nothing to retire/);
  }, 45_000);

  it("refuses a tag that exists but does not peel to a commit — corrupt, never 'absent'", async () => {
    const root = tempRoot();
    initRepo(root);
    await greenBase(root);
    const blob = git(root, ["rev-parse", "HEAD:src/example.js"]);
    git(root, ["tag", "-a", "-m", "a blob, not a base", "b12/corpus/t1", blob]);
    expect(whyOf(readCorpusTag(root, "t1"))).toMatch(/does not peel to a commit/);
    // Control: an id with no tag at all reads ok with commit null.
    expect(okOf(readCorpusTag(root, "t2")).commit).toBeNull();
  }, 30_000);

  it("holds the task id to the ref grammar before it becomes a ref component", () => {
    expect(corpusTagFor("t1")).toEqual({ ok: true, tag: "b12/corpus/t1", ref: "refs/tags/b12/corpus/t1" });
    for (const bad of ["../evil", "a/b", "-leading", "with space", "", "x".repeat(65)]) {
      expect(whyOf(corpusTagFor(bad))).toMatch(/not a safe path segment/);
    }
  });
});

describe("corpusVerification — every reason, firing, with its control", () => {
  it("is empty on a good corpus", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    await authorAndPublish(root, parent, "t1");
    await authorAndPublish(root, parent, "t2");
    const plan = { tasks: [{ id: "t1", specDir: await specDirOf(parent, "t1") }, { id: "t2", specDir: await specDirOf(parent, "t2") }] };
    expect(corpusVerification(root, plan)).toEqual([]);
  }, 45_000);

  it("names a missing base AND the command that fetches it — a printed refspec is not a check", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    await authorAndPublish(root, parent, "t1");
    const reasons = corpusVerification(root, {
      tasks: [{ id: "t1", specDir: await specDirOf(parent, "t1") }, { id: "t9", specDir: await specDirOf(parent, "t9") }],
    });
    expect(reasons.join(" ")).toMatch(/task t9: no corpus tag/);
    // THE REFUSAL IS THE GUARANTEE, so it has to carry the repair.
    expect(reasons.join(" ")).toContain(transportLines("origin").fetch);
  }, 45_000);

  it("fires on a rates.json that does not match the manifest's pin", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    await authorAndPublish(root, parent, "t1");
    const plan = { tasks: [{ id: "t1", specDir: await specDirOf(parent, "t1") }] };
    expect(corpusVerification(root, { ...plan, ratesSha256: "0".repeat(64) }).join(" ")).toMatch(/rates\.json at the base hashes/);
    // Control: the real hash of the committed blob passes.
    const real = spawnSync("git", ["-C", root, "cat-file", "blob", "HEAD:.local-coder/rates.json"], { encoding: "buffer" });
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(real.stdout).digest("hex");
    expect(corpusVerification(root, { ...plan, ratesSha256: sha })).toEqual([]);
  }, 45_000);

  it("fires when the green parent CONTAINS the spec root — the session would be handed its own answer", async () => {
    const root = tempRoot();
    initRepo(root);
    await greenBase(root);
    await fs.mkdir(path.join(root, "b12-corpus", "t1"), { recursive: true });
    await fs.writeFile(path.join(root, "b12-corpus", "t1", "defect.patch"), DEFECT_PATCH, "utf8");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "specs committed BEFORE the parent — the hazard"]);
    const leaky = git(root, ["rev-parse", "HEAD"]);
    await authorAndPublish(root, leaky, "t1");
    expect(corpusVerification(root, { tasks: [{ id: "t1", specDir: await specDirOf(leaky, "t1") }] }).join(" ")).toMatch(
      /CONTAINS b12-corpus\/ /
    );
  }, 45_000);

  it("fires when the bases are not siblings, and when a tag points somewhere its spec did not say", async () => {
    const root = tempRoot();
    initRepo(root);
    const parentA = await greenBase(root);
    await authorAndPublish(root, parentA, "t1");
    // A SECOND parent: commit on top, then author t2 off it. Same repo, two families.
    await fs.writeFile(path.join(root, "src", "other.js"), "module.exports = 1;\n", "utf8");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "a second parent"]);
    const parentB = git(root, ["rev-parse", "HEAD"]);
    await authorAndPublish(root, parentB, "t2");
    const reasons = corpusVerification(root, {
      tasks: [{ id: "t1", specDir: await specDirOf(parentA, "t1") }, { id: "t2", specDir: await specDirOf(parentB, "t2") }],
    });
    expect(reasons.join(" ")).toMatch(/not siblings/);
  }, 45_000);

  it("--deep catches a base whose defect is GONE, which the shallow pass cannot", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    await authorAndPublish(root, parent, "t1");
    const specDir = await specDirOf(parent, "t1");
    const plan = { tasks: [{ id: "t1", specDir }] };
    // Shallow: clean. Deep: also clean, because the defect really is there.
    expect(corpusVerification(root, plan)).toEqual([]);
    expect(corpusVerification(root, { ...plan, deep: true })).toEqual([]);

    // Now neutralise the defect by pointing the id at a base that does NOT
    // carry it — the parent itself, where the predicate is green by definition.
    okOf(retireCorpusTag(root, "t1"));
    okOf(publishSibling(root, "t1", parent, "a base with no defect"));
    const shallow = corpusVerification(root, plan);
    const deep = corpusVerification(root, { ...plan, deep: true });
    expect(deep.join(" ")).toMatch(/predicate is GREEN at the published base/);
    // THE POINT OF `--deep`, stated as a comparison rather than asserted: the
    // shallow pass never says the defect is gone.
    expect(shallow.join(" ")).not.toMatch(/predicate is GREEN/);
  }, 60_000);
});

describe("TRANSPORT — decided by experiment, because the default is not what it looks like", () => {
  it("a fresh clone resolves every base; an EXISTING clone gets nothing from a plain fetch", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);

    const bare = tempRoot();
    git(bare, ["init", "-q", "--bare"]);
    git(root, ["remote", "add", "origin", bare]);
    git(root, ["push", "-q", "origin", "HEAD:refs/heads/main"]);

    // The run machine's clone, taken BEFORE the corpus exists — which is the
    // real situation, and the one the first draft of this design got wrong.
    const existing = tempRoot();
    git(existing, ["clone", "-q", bare, "."]);

    const base = await authorAndPublish(root, parent, "t1");
    const lines = transportLines("origin");
    const pushSpec = lines.push.replace(/^git push origin "/, "").replace(/"$/, "");
    git(root, ["push", "-q", "origin", pushSpec]);

    // CONTROL, and the finding: a plain fetch SUCCEEDS and brings no base.
    // Default tag auto-following only takes tags pointing into the history it
    // fetched, and these bases are detached and on no branch.
    git(existing, ["fetch", "-q", "origin"]);
    expect(resolves(existing, base)).toBe(false);

    // The exported fetch line is therefore load-bearing, not a courtesy.
    const fetchSpec = lines.fetch.replace(/^git fetch origin "/, "").replace(/"$/, "");
    git(existing, ["fetch", "-q", "origin", fetchSpec]);
    expect(resolves(existing, base)).toBe(true);

    // A FRESH clone needs neither line — clone takes refs/tags/* itself.
    const fresh = tempRoot();
    git(fresh, ["clone", "-q", bare, "."]);
    expect(resolves(fresh, base)).toBe(true);
    expect(git(fresh, ["tag", "-l", "b12/corpus/*"]).split("\n").filter(Boolean)).toEqual(["b12/corpus/t1"]);
  }, 60_000);

  it("pins the exact transport strings, so a silent edit breaks a test", () => {
    expect(transportLines("origin")).toEqual({
      push: 'git push origin "refs/tags/b12/corpus/*:refs/tags/b12/corpus/*"',
      fetch: 'git fetch origin "refs/tags/b12/corpus/*:refs/tags/b12/corpus/*"',
    });
    expect(transportLines("upstream").push).toContain("upstream");
  });
});
