#!/usr/bin/env node
/**
 * THE SPEC WRITER — turns a defect SITE into the three files `b12-author.mjs` consumes.
 *
 *   node scripts/b12-spec.mjs write            # every site with no spec dir yet
 *   node scripts/b12-spec.mjs write <taskId>…  # only these
 *
 * Sites live in `b12-corpus/defect-sites.json` as `{ id: { find, replace, symptom } }`;
 * everything else — the parent, the fileScope, the predicate, the stratum — is read from
 * `b12-corpus/corpus-plan.json`, which is the artifact those constraints were checked
 * against. Nothing about a task is stated twice.
 *
 * THE PATCH IS CAPTURED FROM A REAL EDIT, NEVER TYPED. The script applies the site to the
 * working tree, asks git for the diff, and puts the file back. A unified diff written by
 * hand gets its line numbers wrong, and the way you find out is `b12-author.mjs` refusing
 * at apply time, one task at a time, after the prose is already written.
 *
 * IT REFUSES rather than guesses: an unknown id, an anchor that is absent, an anchor that
 * appears more than once (the replacement would land in two places and the fileScope would
 * still claim one edit), a file that does not revert, an empty diff, and a target file that
 * was already dirty before it started — that last one because the captured diff would carry
 * somebody else's edit into a sealed base.
 *
 * A spec dir that already exists is SKIPPED, not overwritten. Two of these are authored and
 * published as annotated tags; rewriting their spec would silently detach the tag from the
 * bytes that produced it.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_PATH = path.join(REPO, "b12-corpus", "corpus-plan.json");
const SITES_PATH = path.join(REPO, "b12-corpus", "defect-sites.json");

const git = (args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
const refuse = (why) => {
  process.stderr.write(`b12-spec: REFUSED — ${why}\n`);
  process.exit(1);
};

function readJson(file, what) {
  if (!fs.existsSync(file)) refuse(`${what} does not exist at ${path.relative(REPO, file)}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    refuse(`${what} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Paths under `src/` with any working-tree or index change, which a capture may not touch. */
function dirtySources() {
  return git(["status", "--porcelain"])
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter((p) => p.startsWith("src/"));
}

export function writeSpec({ plan, sites, taskId, dirty }) {
  const task = plan.tasks.find((t) => t.id === taskId);
  if (task === undefined) refuse(`${taskId} is not in corpus-plan.json — the plan is what its constraints were checked against`);
  const site = sites[taskId];
  if (site === undefined) refuse(`${taskId} has no entry in defect-sites.json`);
  for (const key of ["find", "replace", "symptom"]) {
    if (typeof site[key] !== "string" || site[key].length === 0) refuse(`${taskId}: site.${key} is missing or empty`);
  }
  if (site.find === site.replace) refuse(`${taskId}: find and replace are identical, so there is no defect`);

  const file = task.fileScope[0];
  if (dirty.includes(file)) refuse(`${taskId}: ${file} is already modified — the captured diff would carry that edit into a sealed base`);

  const abs = path.join(REPO, file);
  const before = fs.readFileSync(abs, "utf8");
  const parts = before.split(site.find);
  if (parts.length === 1) refuse(`${taskId}: the anchor is not in ${file}`);
  if (parts.length > 2) refuse(`${taskId}: the anchor appears ${parts.length - 1} times in ${file} — the edit would land in all of them`);

  let patch;
  try {
    fs.writeFileSync(abs, parts.join(site.replace), "utf8");
    patch = git(["diff", "--", file]);
  } finally {
    git(["checkout", "--", file]);
  }
  if (fs.readFileSync(abs, "utf8") !== before) refuse(`${taskId}: ${file} did not revert — stopping before another capture lands on top of this one`);
  if (!patch.includes("diff --git")) refuse(`${taskId}: git produced no diff for ${file}`);

  const dir = path.join(REPO, "b12-corpus", taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "defect.patch"), patch, "utf8");
  fs.writeFileSync(
    path.join(dir, "spec.json"),
    JSON.stringify(
      {
        taskId,
        parent: plan.parent,
        message: `b12 base: ${taskId}`,
        fileScope: task.fileScope,
        patch: "defect.patch",
        predicate: { argv: task.predicateArgv, expectedExit: 0, timeoutMs: 600_000 },
        manifest: {
          verificationStratum: task.verificationStratum,
          expectedSubagentStratum: task.expectedSubagentStratum,
          verificationCommands: task.verificationCommands,
          gateCategory: task.gateCategory,
          repairMaxRounds: 3,
        },
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  // The prompt names the SYMPTOM and never the fix: a prompt that says which line to change
  // measures typing speed, and B12 is measuring whether delegation pays for the finding.
  fs.writeFileSync(
    path.join(dir, "prompt.md"),
    `${site.symptom}\n\nFind the cause and fix it. Stay inside \`${file}\`. The tests are correct as written —\ndo not change them.\n`,
    "utf8"
  );
  return { taskId, file, patchLines: patch.split("\n").length, stratum: task.verificationStratum };
}

function main(argv) {
  if (argv[0] !== "write") refuse(`unknown subcommand ${JSON.stringify(argv[0] ?? null)} — write`);
  const plan = readJson(PLAN_PATH, "corpus-plan.json");
  const sites = readJson(SITES_PATH, "defect-sites.json");
  if (typeof plan.parent !== "string" || plan.parent.length !== 40) {
    refuse("corpus-plan.json carries no 40-character parent — every base must differ from ONE shared tree");
  }

  // Keys beginning with `_` are notes, the same convention manifest-config.json uses.
  // Without this the readme block reads as a task id and the run refuses on its first line.
  const asked = argv.slice(1);
  const ids = asked.length > 0 ? asked : Object.keys(sites).filter((k) => !k.startsWith("_"));
  const dirty = dirtySources();

  const wrote = [];
  const skipped = [];
  for (const id of ids) {
    if (fs.existsSync(path.join(REPO, "b12-corpus", id, "spec.json"))) {
      skipped.push(id);
      continue;
    }
    wrote.push(writeSpec({ plan, sites, taskId: id, dirty }));
  }

  for (const w of wrote) {
    process.stdout.write(`  wrote b12-corpus/${w.taskId}/  ${w.stratum}  ${w.file}  (${w.patchLines} patch lines)\n`);
  }
  if (skipped.length > 0) process.stdout.write(`  skipped ${skipped.length} with a spec already on disk: ${skipped.join(", ")}\n`);
  const missing = plan.tasks.filter((t) => sites[t.id] === undefined).length;
  process.stdout.write(
    `b12-spec: ${wrote.length} written, ${skipped.length} skipped, ${missing} of ${plan.tasks.length} plan tasks still have no site\n`
  );
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
