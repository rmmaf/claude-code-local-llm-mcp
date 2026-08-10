/**
 * ORACLE FOR THE CORPUS AUTHOR — `scripts/b12-author.mjs`.
 *
 * The seventh adversarial round's point, verbatim: the manifest validator
 * proves nothing about the authoring tool. So the tool carries its own wave,
 * over deterministic scratch repositories: the happy path, and every one of
 * the five hardened checks shown FIRING — topology (verify-family over
 * different parents), green parent, defect-present, scope confinement, and
 * the two-route tree comparison (forced deterministically via a file-mode
 * patch under `core.fileMode false`, the one divergence every platform can
 * reproduce on demand).
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { authorSibling, parseAuthorSpec, verifySiblings } from "../scripts/b12-author.mjs";
import { makeTempRoot } from "./helpers.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = makeTempRoot("b12-author-test-");
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

/** Untrimmed blob bytes — trailing newlines are part of the corpus. */
function blobBytes(cwd: string, spec: string): string {
  const r = spawnSync("git", ["cat-file", "blob", spec], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git cat-file ${spec} failed: ${r.stderr ?? ""}`);
  return r.stdout ?? "";
}

function initRepo(root: string, config: Record<string, string> = {}): void {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "author-oracle"]);
  git(root, ["config", "user.email", "author@example.invalid"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  for (const [k, v] of Object.entries(config)) git(root, ["config", k, v]);
}

const EXAMPLE = "exports.answer = () => 42;\n";
const PREDICATE = {
  argv: ["node", "-e", "const a = require('./src/example.js').answer(); process.exit(a === 42 ? 0 : 1);"],
  expectedExit: 0,
};

/** A green base: src/example.js answering 42, the predicate passing. */
async function greenBase(root: string): Promise<string> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "example.js"), EXAMPLE, "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "green base"]);
  return git(root, ["rev-parse", "HEAD"]);
}

const DEFECT_PATCH = [
  "--- a/src/example.js",
  "+++ b/src/example.js",
  "@@ -1 +1 @@",
  "-exports.answer = () => 42;",
  "+exports.answer = () => 41;",
  "",
].join("\n");

async function specDirOf(
  root: string,
  parent: string,
  over: Record<string, unknown> = {},
  patch: string = DEFECT_PATCH
): Promise<string> {
  const dir = path.join(tempRoot(), "spec");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "defect.patch"), patch, "utf8");
  await fs.writeFile(
    path.join(dir, "spec.json"),
    JSON.stringify({
      taskId: "t1",
      parent,
      message: "task t1: the answer drifts to 41",
      fileScope: ["src/example.js"],
      patch: "defect.patch",
      predicate: PREDICATE,
      ...over,
    }),
    "utf8"
  );
  return dir;
}

/** Narrow to the success arm, loudly. */
function okOf<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got refusal: ${String((r as { why?: string }).why)}`);
  return r as Extract<T, { ok: true }>;
}
function whyOf<T extends { ok: boolean }>(r: T): string {
  if (r.ok) throw new Error("expected a refusal; the call succeeded");
  return (r as unknown as { why: string }).why;
}

describe("b12-author — one spec, one sibling, five checks", () => {
  it("authors the sibling on the happy path — detached, confined, both trees equal", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    const headBefore = git(root, ["rev-parse", "HEAD"]);

    const result = okOf(authorSibling(root, await specDirOf(root, parent)));
    expect(result.parent).toBe(parent);
    expect(result.changed).toEqual(["src/example.js"]);
    // The object is real, its ONE parent is the declared one, and its tree is
    // the one the result reports.
    expect(git(root, ["rev-list", "--parents", "-n", "1", result.commit]).split(/\s+/).slice(1)).toEqual([parent]);
    expect(git(root, ["rev-parse", `${result.commit}^{tree}`])).toBe(result.tree);
    // The defect is IN the commit, byte-exactly.
    expect(blobBytes(root, `${result.commit}:src/example.js`)).toBe("exports.answer = () => 41;\n");
    // No ref moved, and no scratch worktree lingers.
    expect(git(root, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(root, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  }, 30_000);

  it("refuses a red parent — a defect on a red parent is two defects, one unowned", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    const dir = await specDirOf(root, parent, {
      predicate: { ...PREDICATE, argv: ["node", "-e", "process.exit(1);"] },
    });
    expect(whyOf(authorSibling(root, dir))).toMatch(/parent is not green/);
  }, 30_000);

  it("refuses a patch the predicate already accepts — no defect, no task", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    const cosmetic = [
      "--- a/src/example.js",
      "+++ b/src/example.js",
      "@@ -1 +1,2 @@",
      "+// a note, not a defect",
      " exports.answer = () => 42;",
      "",
    ].join("\n");
    expect(whyOf(authorSibling(root, await specDirOf(root, parent, {}, cosmetic)))).toMatch(/ALREADY green/);
  }, 30_000);

  it("refuses a patch escaping the declared fileScope", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    const escaping = [
      "--- a/src/example.js",
      "+++ b/src/example.js",
      "@@ -1 +1 @@",
      "-exports.answer = () => 42;",
      "+exports.answer = () => 41;",
      "--- /dev/null",
      "+++ b/src/evil.js",
      "@@ -0,0 +1 @@",
      "+exports.zzz = 1;",
      "",
    ].join("\n");
    expect(whyOf(authorSibling(root, await specDirOf(root, parent, {}, escaping)))).toMatch(
      /escapes the declared fileScope: src\/evil\.js/
    );
  }, 30_000);

  it("refuses when the two application routes disagree on the tree — forced via file mode", async () => {
    // The deterministic divergence every platform can reproduce: with
    // `core.fileMode false` the worktree route records 100644 for a new file
    // whatever the patch declares, while the index route (`apply --cached`)
    // records the declared 100755 — two trees, one patch. This is the guard's
    // firing control; its LIMIT is stated here too: it catches DISAGREEMENT
    // between the routes, not a normalization both routes agree on — which is
    // why the real corpus is authored with filters off.
    const root = tempRoot();
    initRepo(root, { "core.fileMode": "false" });
    const parent = await greenBase(root);
    const modePatch = [
      "diff --git a/src/tool.sh b/src/tool.sh",
      "new file mode 100755",
      "--- /dev/null",
      "+++ b/src/tool.sh",
      "@@ -0,0 +1 @@",
      "+echo hi",
      "",
    ].join("\n");
    const dir = await specDirOf(
      root,
      parent,
      {
        fileScope: ["src/tool.sh"],
        // The new file does not touch the predicate's module, so the
        // defect-present check needs a predicate that FAILS once the file
        // exists — presence of the file IS the "defect" here.
        predicate: {
          argv: ["node", "-e", "process.exit(require('node:fs').existsSync('./src/tool.sh') ? 1 : 0);"],
          expectedExit: 0,
        },
      },
      modePatch
    );
    expect(whyOf(authorSibling(root, dir))).toMatch(/two application routes disagree/);
  }, 30_000);

  it("keeps declared bytes intact under autocrlf=true when the routes agree", async () => {
    // The autocrlf case from the review: an LF-only patch authored under
    // `core.autocrlf true` must come out byte-identical — the clean filter
    // has nothing to convert, both routes agree, and the corpus stays stable.
    const root = tempRoot();
    initRepo(root, { "core.autocrlf": "true" });
    const parent = await greenBase(root);
    const result = okOf(authorSibling(root, await specDirOf(root, parent)));
    const bytes = blobBytes(root, `${result.commit}:src/example.js`);
    expect(bytes).toBe("exports.answer = () => 41;\n");
    expect(bytes).not.toMatch(/\r/);
  }, 30_000);

  it("verify-family: same parent passes, different parents are named", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    const sib1 = okOf(authorSibling(root, await specDirOf(root, parent))).commit;
    const sib2 = okOf(
      authorSibling(root, await specDirOf(root, parent, { taskId: "t2", message: "task t2: same drift, second sibling" }))
    ).commit;
    expect(verifySiblings(root, [sib1, sib2])).toEqual([]);

    // A commit built on ANOTHER parent is not a sibling, and the reason names
    // the two parents.
    await fs.writeFile(path.join(root, "src", "extra.js"), "exports.extra = 1;\n", "utf8");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "the branch moves on"]);
    const newParent = git(root, ["rev-parse", "HEAD"]);
    const stranger = okOf(
      authorSibling(root, await specDirOf(root, newParent, { taskId: "t3", message: "task t3: authored off the moved head" }))
    ).commit;
    const reasons = verifySiblings(root, [sib1, stranger]);
    expect(reasons.join(" ")).toMatch(/distinct parents/);

    // Fewer than two commits is not a family question.
    expect(verifySiblings(root, [sib1]).join(" ")).toMatch(/at least 2/);
  }, 45_000);

  it("refuses spec shapes before touching git — grammar, rule 7, the patch, the predicate", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);

    // A scope inside the instrument set is refused at authoring time, with
    // the SAME predicate the register and the scorer run.
    const protectedScope = await specDirOf(root, parent, { fileScope: ["src/cost/"] });
    expect(whyOf(parseAuthorSpec(protectedScope))).toMatch(/intersects/);

    const abbreviated = await specDirOf(root, parent.slice(0, 12));
    expect(whyOf(parseAuthorSpec(abbreviated))).toMatch(/40-hex/);

    const shellString = await specDirOf(root, parent, { predicate: { argv: "npm test", expectedExit: 0 } });
    expect(whyOf(parseAuthorSpec(shellString))).toMatch(/argv ARRAY/);

    const emptyPatch = await specDirOf(root, parent, {}, "\n");
    expect(whyOf(parseAuthorSpec(emptyPatch))).toMatch(/empty/);

    const ghostParent = await specDirOf(root, "f".repeat(40));
    expect(whyOf(authorSibling(root, ghostParent))).toMatch(/not a commit/);
  }, 30_000);
});
