/**
 * THE PRE-COMMIT HALF OF THE KNOWN-HERE PIN CHECK — reads the INDEX, never HEAD.
 *
 * `tests/b12-plan.test.ts:131` already compares the KNOWN-HERE pins against the
 * bytes they name, and it is the alarm that matters: it is what CI runs. But it
 * hashes `git show HEAD:<path>`, and during a pre-commit hook `HEAD` is still the
 * PREVIOUS commit — so the stale pin it exists to catch is invisible to it until
 * the commit already exists. That is not a defect in the test; reading HEAD is
 * what makes it trustworthy after the fact. It is a blind spot in TIME, and this
 * script covers exactly that window and nothing else.
 *
 * It already cost a red CI once: `8fedebc` and `4f0e0de` changed
 * `scripts/b12-run.mjs`, `pinned.b12RunSha256` went stale, and no local gate
 * could see it (`manifest-config.json`, THE_PIN_THAT_CAUGHT_IT_2026_08_14).
 *
 * BOTH SIDES COME FROM THE INDEX, and that is the whole point. Reading the pin
 * out of the working tree would pass a partial staging — the config edited and
 * unstaged, the harness staged — which is the one shape a pre-commit guard is
 * there to refuse. `git show :<path>` is the prospective commit's content.
 *
 * `ratesSha256` IS DELIBERATELY NOT HERE. `tests/b12-plan.test.ts:139` compares
 * it at `plan.parent`, a fixed commit read off the pilot specs
 * (`b12-plan.mjs:214-223`), not at HEAD — so no commit made here can move it, and
 * checking it would only add a way to be wrong.
 *
 * THE INSTANT-OF-CHECK CAVEAT, REPORTED RATHER THAN SOLVED. The index equals the
 * prospective commit only at the moment it is read; a later hook or a concurrent
 * process can still mutate it. This prints `git write-tree` so the caller can
 * assert the tree id is unchanged when the commit lands. It does not take that
 * assertion itself, because a guard that blocks the index against its own caller
 * would be refusing the ordinary case.
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

/** sha256 of a byte buffer, hex — the same digest `b12-plan.test.ts` takes. */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * PURE — no git, no clock, no IO. Takes what the index says and what the config
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
  for (const { pin, subject } of INDEX_PINS) {
    const want = measured[subject];
    const got = declared[pin];
    if (typeof want !== "string") {
      out.push({ pin, subject, declared: got ?? null, measured: null, why: "the index carries no such path" });
    } else if (typeof got !== "string") {
      out.push({ pin, subject, declared: null, measured: want, why: "the config declares no such pin" });
    } else if (got !== want) {
      out.push({ pin, subject, declared: got, measured: want, why: "the pin does not name the staged bytes" });
    }
  }
  return out;
}

/** `git show <spec>` as raw bytes, so the digest matches the CI alarm's. */
function gitShow(repo, spec) {
  return execFileSync("git", ["show", spec], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
}

/** Hash every subject out of the index. Throws if git itself cannot answer. */
export function readIndexSubjects(repo, pins = INDEX_PINS) {
  const measured = {};
  for (const { subject } of pins) {
    try {
      measured[subject] = sha256(gitShow(repo, `:${subject}`));
    } catch {
      // No index entry — staged deletion, or a path that was never added. Left
      // absent so `pinMismatches` reports it rather than this throwing past it.
    }
  }
  return measured;
}

/** The config AS STAGED, never as edited-but-unstaged. */
export function readIndexConfig(repo, rel = "b12-corpus/manifest-config.json") {
  return JSON.parse(gitShow(repo, `:${rel}`).toString("utf8"));
}

function main() {
  let measured;
  let config;
  let tree;
  try {
    measured = readIndexSubjects(REPO);
    config = readIndexConfig(REPO);
    tree = execFileSync("git", ["write-tree"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch (err) {
    // OPERATIONAL, NOT A VERDICT: an unaskable index is not a clean one, and it
    // is not a stale pin either. Exit 2 so a caller can tell the two apart.
    console.error(`b12-pins-check: the index could not be read — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const bad = pinMismatches(measured, config.pinned ?? {});
  if (bad.length > 0) {
    console.error("b12-pins-check: REFUSING — the staged pins do not name the staged bytes.\n");
    for (const m of bad) {
      console.error(`  pinned.${m.pin} (${m.subject}) — ${m.why}`);
      console.error(`    declared: ${m.declared ?? "(absent)"}`);
      console.error(`    staged:   ${m.measured ?? "(absent)"}\n`);
    }
    console.error("Re-pin IN THIS COMMIT. tests/b12-plan.test.ts compares against HEAD,");
    console.error("so this only goes red in CI once the commit already exists.");
    process.exit(1);
  }

  console.log(`b12-pins-check: ${INDEX_PINS.length} KNOWN-HERE pin(s) name the staged bytes.`);
  console.log(`index tree: ${tree}`);
  console.log("(equal to the prospective commit only at this instant — re-check if anything else stages)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
