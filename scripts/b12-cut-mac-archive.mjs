/**
 * b12-cut-mac-archive.mjs — cut the archive the Mac round runs from.
 *
 *   node scripts/b12-cut-mac-archive.mjs [--out <dir>]
 *
 * WHY THIS EXISTS. Cutting the archive was a convention that lived in one
 * head, and it went wrong three separate ways, each costing a weekend session
 * on a machine that cannot talk to git:
 *
 *   1. `Compress-Archive` silently drops dot-directories, so the first archive
 *      arrived with no `.git` and the round could not identify its own tree.
 *   2. A plain clone under `core.autocrlf=true` wrote CRLF into ~100 tracked
 *      files, and the Mac pre-flight correctly refused the whole round. Note
 *      that `.gitattributes` does NOT cover `*.ts`, so the eol settings below
 *      are load-bearing and not belt-and-braces.
 *   3. `.b12-round-pin` — the file that tells the round which commit it is
 *      supposed to be — was written by hand, or forgotten. Forgotten means the
 *      gate refuses; written wrong means the round measures a tree while
 *      believing it is another.
 *
 * Each was found by a Mac session ending in a refusal. This makes all three
 * mechanical, so the next one is spent measuring.
 *
 * IT REFUSES ON A DIRTY TREE. The pin names a COMMIT. If the working tree
 * carries changes the commit does not, the archive's contents and its pin
 * describe different things, and every downstream check would compare the pin
 * against a HEAD that agrees with it while the FILES do not.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

const run = (cwd, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: false });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};
const git = (cwd, args) => run(cwd, "git", args);
const refuse = (msg) => {
  console.error(`REFUSED: ${msg}`);
  process.exit(2);
};

const argv = process.argv.slice(2);
const outDir = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : path.join(homedir(), "Desktop");

const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]).out;
if (!repoRoot) refuse("not inside a git work tree");

const head = git(repoRoot, ["rev-parse", "HEAD"]).out;
if (!/^[0-9a-f]{40}$/.test(head)) refuse(`could not read HEAD (got "${head}")`);
const short = head.slice(0, 7);

const branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
if (!branch || branch === "HEAD") refuse("HEAD is detached; cut from a named branch so the clone can track it");

const dirty = git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]).out;
if (dirty) {
  console.error(dirty.split("\n").slice(0, 20).map((l) => `    ${l}`).join("\n"));
  refuse(
    "the working tree has tracked changes. The pin names a commit, so an archive cut from a " +
      "dirty tree would carry files that its own pin disagrees with — and every check downstream " +
      "compares the pin to HEAD, which would agree. Commit or stash first."
  );
}

// CLONED, NOT COPIED. A copy carries the ignored working state — node_modules,
// dist, .local-coder spill — and, worse, whatever the machine's autocrlf did to
// the files on checkout. A clone with these two settings writes LF, which is
// what the Mac's `git status` will expect to find.
const staging = mkdtempSync(path.join(tmpdir(), "b12-cut-"));
const treeName = `b12-mac-${short}`;
const tree = path.join(staging, treeName);

const clone = run(staging, "git", [
  "-c", "core.autocrlf=false",
  "-c", "core.eol=lf",
  "clone", "--quiet", "--no-hardlinks",
  "--branch", branch,
  repoRoot, tree,
]);
if (!clone.ok) refuse(`git clone failed: ${clone.err || clone.out}`);

// THE CLONE MUST BE THE COMMIT WE PINNED. Cloning a branch takes its tip, and
// the tip is HEAD only because the check above proved the tree clean. Verified
// rather than assumed: this is the one fact the whole round rests on.
const cloneHead = git(tree, ["rev-parse", "HEAD"]).out;
if (cloneHead !== head) {
  rmSync(staging, { recursive: true, force: true });
  refuse(`the clone is at ${cloneHead} but this tree is at ${head}`);
}

const cloneDirty = git(tree, ["status", "--porcelain", "--untracked-files=no"]).out;
if (cloneDirty) {
  console.error(cloneDirty.split("\n").slice(0, 20).map((l) => `    ${l}`).join("\n"));
  rmSync(staging, { recursive: true, force: true });
  refuse(
    "the fresh clone already reports tracked changes, which means the line-ending settings did " +
      "not take. The Mac pre-flight would refuse this archive on arrival."
  );
}

writeFileSync(path.join(tree, ".b12-round-pin"), `${head}\n`, { encoding: "utf8" });

// `tar` and not PowerShell's Compress-Archive: the latter skips dot-entries,
// which is how an archive once arrived without its own `.git`.
const archive = path.join(outDir, `${treeName}.zip`);
if (existsSync(archive)) rmSync(archive, { force: true });
const packed = run(staging, "tar", ["-a", "-c", "-f", archive, "-C", tree, "."]);
if (!packed.ok) {
  rmSync(staging, { recursive: true, force: true });
  refuse(`tar failed: ${packed.err || packed.out}`);
}

rmSync(staging, { recursive: true, force: true });

console.log(`cut  ${archive}`);
console.log(`pin  ${head}`);
console.log(`from ${branch}`);
console.log("");
console.log("On the Mac:");
console.log(`  mkdir -p ~/Downloads/${treeName} && unzip -q ~/Downloads/${treeName}.zip -d ~/Downloads/${treeName}`);
console.log(`  cd ~/Downloads/${treeName} && bash scripts/b12-mac-round.sh`);
