/**
 * THE PRE-COMMIT HALF OF THE KNOWN-HERE PIN CHECK — reads a WRITTEN TREE.
 *
 * `tests/b12-plan.test.ts:131` already compares the KNOWN-HERE pins against the
 * bytes they name, and it is the alarm that matters: it is what CI runs. But it
 * hashes `git show HEAD:<path>`, and during a pre-commit hook `HEAD` is still the
 * PREVIOUS commit. MEASURED 2026-08-14, both directions: with the harness edited
 * and correctly re-pinned but not yet committed, that test goes RED (it compares
 * the new pin against HEAD's old bytes) and goes green the instant the commit
 * exists, with no other change. So locally the alarm is INVERTED — red when the
 * re-pin is right, green when it is stale — and only after the commit is it the
 * guard it was built to be. That is not a defect in the test; reading committed
 * bytes is what makes it trustworthy afterwards. It is a blind spot in TIME, and
 * this script covers exactly that window.
 *
 * It already cost a red CI once: `8fedebc` and `4f0e0de` changed
 * `scripts/b12-run.mjs`, `pinned.b12RunSha256` went stale, and no local gate
 * could see it (`manifest-config.json`, THE_PIN_THAT_CAUGHT_IT_2026_08_14).
 *
 * EVERYTHING IS READ FROM ONE `git write-tree`, NOT FROM THE LIVE INDEX. Reading
 * subjects and config through separate live-index calls and printing a tree id
 * afterwards would let the index move between them: the check could go green and
 * print a tree it never examined, and comparing that tree at commit time would
 * not detect the earlier race. Named 2026-08-14 by adversarial review. The tree
 * is written first and every read is addressed to it, so the verdict is about
 * one immutable snapshot by construction.
 *
 * BOTH SIDES COME FROM THAT TREE, and that is the whole point. Reading the pin
 * out of the working tree would pass a partial staging — the config edited and
 * unstaged, the harness staged — which is the same stale commit wearing a clean
 * working tree.
 *
 * `ratesSha256` IS DELIBERATELY NOT HERE. `tests/b12-plan.test.ts:139` compares
 * it at `plan.parent`, a fixed commit read off the pilot specs
 * (`b12-plan.mjs:214-223`), not at HEAD — so no commit made here can move it, and
 * checking it would only add a way to be wrong.
 *
 * AND IT COMPARES BYTES IN THE GIT-BLOB DOMAIN, WHICH IS NOT THE DOMAIN THE SEAL
 * IS ENFORCED IN. `b12-register.mjs:573` seals from HEAD's bytes while
 * `b12-run.mjs:2672` hashes the bytes ON DISK, so a checkout filter, a symlink or
 * a hand-made CRLF edit can make the two disagree. `.gitattributes:20-31` pins
 * `.mjs`/`.json`/`.md` to `text eol=lf`, which mitigates the ordinary case, and
 * the disagreement fails CLOSED — a false refusal at observe time, never a silent
 * acceptance. Registered here rather than repaired: this script cannot fix a
 * domain mismatch it did not create.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The KNOWN-HERE pins whose subject is compared against HEAD by the CI alarm. */
export const INDEX_PINS = [
  { pin: "b12RunSha256", subject: "scripts/b12-run.mjs" },
  { pin: "claudeMdSha256", subject: "CLAUDE.md" },
];

/** The only entry shapes a content pin can describe. */
const HASHABLE_MODES = new Set(["100644", "100755"]);

/**
 * An unaskable git, as distinct from an answer. Thrown, never returned, so it
 * cannot be mistaken for a verdict about a pin.
 *
 * The distinction is the whole point of the two exit codes, and the first draft
 * destroyed it: every `git show` failure was caught per-path and folded into
 * "the index carries no such path", so a subject over `maxBuffer`, a corrupt
 * object or an unmerged entry came back as a STALE PIN. Named 2026-08-14 by
 * review.
 */
export class GitUnaskable extends Error {}

/** sha256 of a byte buffer, hex — the same digest `b12-plan.test.ts` takes. */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(repo, args, opts = {}) {
  try {
    return execFileSync("git", args, { cwd: repo, maxBuffer: 256 * 1024 * 1024, ...opts });
  } catch (err) {
    throw new GitUnaskable(`git ${args.join(" ")} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * PURE — no git, no clock, no IO. Takes what the tree says and what the config
 * declares, returns one entry per pin that disagrees.
 *
 * Separated from the runner for the R38#5 reason `b12-firing.mjs` states: a
 * verdict that can only be exercised by running the real thing cannot be tested
 * for an INVERTED verdict, and an inverted pin check certifies a stale pin.
 *
 * A pin the config does not carry is a MISMATCH, not a skip. `b12-run.mjs:1066`
 * checks presence only, so an absent pin already passes everything else.
 */
export function pinMismatches(measured, declared) {
  const out = [];
  const decl = declared && typeof declared === "object" ? declared : {};
  for (const { pin, subject } of INDEX_PINS) {
    const found = measured[subject];
    const got = decl[pin];
    const shown = typeof got === "string" ? got : got === undefined ? null : JSON.stringify(got);
    if (found === undefined) {
      out.push({ pin, subject, declared: shown, measured: null, why: "the tree carries no such path" });
    } else if (typeof found !== "string") {
      // A symlink or a gitlink. Not a byte comparison this pin can describe, and
      // silently hashing the link target would compare the wrong object.
      out.push({ pin, subject, declared: shown, measured: null, why: `the tree entry is not a regular file (${found.mode} ${found.type})` });
    } else if (typeof got !== "string") {
      out.push({ pin, subject, declared: shown, measured: found, why: "the config declares no such pin" });
    } else if (got !== found) {
      out.push({ pin, subject, declared: shown, measured: found, why: "the pin does not name the staged bytes" });
    }
  }
  return out;
}

/** Stage everything currently staged into an immutable tree, and name it. */
export function writeTree(repo) {
  return git(repo, ["write-tree"], { encoding: "utf8" }).trim();
}

/**
 * sha256 of every subject AS IT STANDS IN `tree`. A path absent from the tree is
 * left absent; a path present but not a regular file is returned as its raw
 * entry so `pinMismatches` can refuse it by name. Anything else throws.
 */
export function readTreeSubjects(repo, tree, pins = INDEX_PINS) {
  const measured = {};
  for (const { subject } of pins) {
    const line = git(repo, ["ls-tree", "-r", "--full-tree", tree, "--", subject], { encoding: "utf8" }).trim();
    if (line === "") continue; // absent from the tree: a verdict, not a failure
    const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t/.exec(line);
    if (m === null) throw new GitUnaskable(`ls-tree returned an unparseable entry for ${subject}: ${line}`);
    const [, mode, type, oid] = m;
    if (type !== "blob" || !HASHABLE_MODES.has(mode)) {
      measured[subject] = { mode, type };
      continue;
    }
    measured[subject] = sha256(git(repo, ["cat-file", "blob", oid]));
  }
  return measured;
}

/** The config AS IT STANDS IN `tree`, so a partial staging cannot pass. */
export function readTreeConfig(repo, tree, rel = "b12-corpus/manifest-config.json") {
  const parsed = JSON.parse(git(repo, ["cat-file", "blob", `${tree}:${rel}`]).toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GitUnaskable(`${rel} in the tree is not a JSON object`);
  }
  return parsed;
}

/**
 * `repo` is an argument ONLY so the exit codes can be tested against fixture
 * repositories. Without it `main` could only ever be exercised against this
 * repository in whatever state it happened to be in, which is the shape R38#5
 * refuses: a verdict that cannot be tested for being backwards.
 */
function main(repo = REPO) {
  let tree;
  let measured;
  let config;
  try {
    // TREE FIRST. Every read below is addressed to this snapshot, so nothing
    // that stages afterwards can change what this verdict was about.
    tree = writeTree(repo);
    measured = readTreeSubjects(repo, tree);
    config = readTreeConfig(repo, tree);
  } catch (err) {
    // OPERATIONAL, NOT A VERDICT: an unaskable tree is not a clean one, and it
    // is not a stale pin either. Exit 2 so a caller can tell the two apart.
    console.error(`b12-pins-check: the staged tree could not be read — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const bad = pinMismatches(measured, config.pinned);
  if (bad.length > 0) {
    console.error("b12-pins-check: REFUSING — the staged pins do not name the staged bytes.\n");
    for (const m of bad) {
      console.error(`  pinned.${m.pin} (${m.subject}) — ${m.why}`);
      console.error(`    declared: ${m.declared ?? "(absent)"}`);
      console.error(`    staged:   ${m.measured ?? "(absent)"}\n`);
    }
    console.error(`staged tree: ${tree}`);
    console.error("Re-pin IN THIS COMMIT. tests/b12-plan.test.ts compares against HEAD, so it is");
    console.error("INVERTED before the commit exists: red on a correct re-pin, green on a stale one.");
    process.exit(1);
  }

  console.log(`b12-pins-check: ${INDEX_PINS.length} KNOWN-HERE pin(s) name the staged bytes.`);
  console.log(`staged tree: ${tree}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2] ? path.resolve(process.argv[2]) : REPO);
}
