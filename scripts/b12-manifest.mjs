/**
 * THE MANIFEST ASSEMBLER — turns a corpus of authored, published siblings into
 * the artifacts a registered B12 run reads.
 *
 * NEVER FROZEN, exactly like `b12-author.mjs`: this is tooling the operator
 * drives while BUILDING the corpus. No frozen clause names it, it runs before
 * the first billed request, and it is not part of the measured harness.
 *
 * WHY IT EXISTS AT ALL, since a manifest is "just JSON". Every task carries ten
 * fields the frozen validator requires and several more that only `observe`
 * dereferences, and two of them are not declarations but PROOFS:
 *
 *   - `baseCommit` must be the commit whose predicate was verified RED at
 *     authoring time. Written by hand it is a sha someone typed.
 *   - `acceptance` must be the same predicate that proof was about. Written by
 *     hand it is a string that resembles one.
 *
 * So nothing here is copied from a config field that names it. `baseCommit`
 * comes from `refs/tags/b12/corpus/<taskId>` and `acceptance` from the spec's
 * own `predicate.argv` — the two objects `b12-author.mjs` proved things about.
 * A config that declares either is REFUSED rather than overridden, because a
 * declaration that is silently ignored is worse than one that is wrong.
 *
 * THE OTHER HALF OF ITS JOB IS TO SPEND NOTHING. `observe` discovers a bad pin
 * after a session is paid for. Everything it would discover that this machine
 * can check — the stratum enum, the per-cell floor, the policy blobs, the
 * memory snapshot, the version prefix, every base commit's rates blob — is
 * checked here, where the discovery is free. What this machine CANNOT check is
 * said plainly rather than implied: the MCP config paths are machine-local to
 * the Mac, so presence is all that is asserted about them.
 *
 * THE ACCEPTANCE GRAMMAR IS THE SHARPEST THING IN THIS FILE, and it was
 * measured rather than reasoned about. `observe` runs a predicate as
 * `Array.isArray(cmd) ? cmd : String(cmd).split(" ")` with
 * `shell: process.platform === "win32"` (`b12-run.mjs:2943-2947`). Under that,
 * `node -e "process.exit(1)"` split on spaces EXITS 0 — a task nobody fixed
 * would score as fixed, silently, forever. So every argv element must be free of
 * whitespace and of the characters `cmd.exe` reads, and the refusal says which
 * element and why. That rules out the readable one-liner predicate shape
 * entirely; a predicate here is `npx vitest run tests/foo.test.ts`, not a
 * `node -e` script.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { corpusVerification, parseAuthorSpec, readCorpusTag, DEFAULT_SPEC_ROOT } from "./b12-author.mjs";
import { checkCore, priorIntroductionRefusals } from "./b12-register.mjs";
import { findPolicyBlob, hashMemoryDir, manifestDeclarationGaps } from "./b12-run.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * THE REPOSITORY THIS SCRIPT SHIPS IN, which is where the scorer's enums live.
 * Not the corpus root, and the distinction is not academic: the assembler must
 * agree with THE SCORER IT SHIPS WITH. Reading the enums from a caller-supplied
 * root would let a manifest be validated against some other checkout's idea of
 * `verificationStratum` — the exact drift the conformance doctrine exists to
 * stop. In production the two coincide; a caller may still override for tests.
 */
const SCRIPT_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Where the assembler looks when the operator names no config. */
export const DEFAULT_CONFIG_PATH = "b12-corpus/manifest-config.json";

/**
 * The key order every emitted task carries. NOT INVENTED: read off the only
 * manifest that exists in this repository,
 * `tests/fixtures/b12-run/evidence/replay-01.b12.tasks.json`. Emission walks
 * this list, so the bytes are deterministic without depending on the insertion
 * order of an object literal.
 */
export const TASK_KEY_ORDER = [
  "id",
  "prompt",
  "promptSha256",
  "baseCommit",
  "verificationStratum",
  "expectedSubagentStratum",
  "acceptance",
  "acceptanceExpectedExit",
  "verificationCommands",
  "gateCategory",
  "repairMaxRounds",
  "fileScope",
];

/**
 * Fields a config may NOT declare, because each is derived from something that
 * was proved rather than typed. Declaring one is a refusal and not an override:
 * an operator who writes `baseCommit` believes it is being used.
 */
export const DERIVED_TASK_FIELDS = ["baseCommit", "acceptance", "acceptanceExpectedExit", "promptSha256", "prompt", "fileScope", "id"];

// ---------------------------------------------------------------------------
// THE GRAMMAR THE FOUR READERS SHARE
// ---------------------------------------------------------------------------

/**
 * QUOTES, AND BOTH KINDS ARE MEASURED — separately, because review was right
 * that an earlier note measured only the double and labelled both. Split on
 * spaces, the quoted element reaches node as a string LITERAL, which it
 * evaluates and discards. Measured 2026-08-12, `process.exitCode=3` throughout:
 *
 *                     author argv   shell:false (macOS)   shell:true (Windows)
 *   no quotes              3                3                     3
 *   "double quoted"        3                0                     3
 *   'single quoted'        3                0                     0
 *
 * DOUBLE quotes are PLATFORM-DEPENDENT: `cmd.exe` strips them, so Windows gets
 * the right answer for the wrong reason while macOS silently accepts a task
 * nobody fixed. The platform that decides is the Mac.
 *
 * SINGLE quotes are WORSE, and this is where review's inference went the wrong
 * way. It is true that `cmd.exe` does not treat `'` as a quoting delimiter —
 * and the CONSEQUENCE is that nothing ever strips them, so node keeps seeing a
 * string literal and exits 0 on BOTH platforms. Not platform-dependent: a
 * uniform always-accept. The earlier label was incomplete, not overstated.
 */
const QUOTES = ['"', "'"];

/**
 * The rest of `cmd.exe`'s metacharacters. THIS TIER IS CONSERVATIVE RATHER THAN
 * MEASURED, and saying otherwise would be this file claiming evidence it does
 * not have: `node -e process.exit(3)` round-trips identically and returns 3
 * under both shell modes, parentheses and all. They are refused because their
 * meaning to `cmd.exe` is CONTEXT-DEPENDENT — grouping, redirection, variable
 * expansion, escape — so a predicate carrying them is one whose behaviour has
 * to be reasoned about per string instead of settled once. A real predicate
 * here is `npx vitest run tests/foo.test.ts`, which needs none of them, so the
 * corpus gives up nothing it wanted.
 */
const SHELL_META = ["&", "|", "^", "<", ">", "%", "(", ")", "`", "$"];

/**
 * Every reason an argv would not survive the round trip to `observe` and back.
 * Returns [] or the reasons, one per offending element.
 *
 * TWO INDEPENDENT REQUIREMENTS, and conflating them hides one of them:
 *
 *  1. ROUND TRIP. `join(" ")` then `split(" ")` recovers the argv if and only
 *     if no element contains whitespace and no element is empty. This is what
 *     makes the string form and the array form provably the same command.
 *  2. SHELL SAFETY. On Windows the joined string reaches `cmd.exe`, which acts
 *     on `& | < > ^ % ( )` and on quotes. An element carrying one of those is
 *     not the command that was verified red, whatever the round trip says.
 */
export function argvGrammarReasons(taskId, argv) {
  const reasons = [];
  if (!Array.isArray(argv) || argv.length === 0) {
    return [`task ${taskId}: predicate.argv is absent or empty — there is no command to score against`];
  }
  argv.forEach((element, i) => {
    if (typeof element !== "string" || element.length === 0) {
      reasons.push(`task ${taskId}: predicate.argv[${i}] is empty or not a string — it vanishes in the join/split round trip`);
      return;
    }
    if (/\s/.test(element)) {
      reasons.push(
        `task ${taskId}: predicate.argv[${i}] ${JSON.stringify(element)} contains whitespace — ` +
          "`observe` splits the acceptance string on spaces, so this element would arrive as two or more arguments"
      );
    }
    const quoted = QUOTES.filter((c) => element.includes(c));
    if (quoted.length > 0) {
      reasons.push(
        `task ${taskId}: predicate.argv[${i}] ${JSON.stringify(element)} carries a quote — ` +
          'MEASURED: split on spaces, a DOUBLE-quoted body exits 0 under shell:false (macOS, where the sessions run) ' +
          "and 3 under shell:true (Windows) — one manifest, two answers. A SINGLE-quoted body exits 0 on BOTH, " +
          "because nothing strips it and node evaluates a string literal. Either way a task nobody fixed can score as fixed"
      );
    }
    const meta = SHELL_META.filter((c) => element.includes(c));
    if (meta.length > 0) {
      reasons.push(
        `task ${taskId}: predicate.argv[${i}] ${JSON.stringify(element)} carries ${meta.join(" ")} — ` +
          "a cmd.exe metacharacter. This refusal is CONSERVATIVE, not measured: such an element may well round-trip, " +
          "but its meaning is context-dependent and a predicate should not need reasoning about. Write it without them"
      );
    }
  });
  return reasons;
}

// ---------------------------------------------------------------------------
// THE FROZEN VALUES, READ RATHER THAN COPIED
// ---------------------------------------------------------------------------

function quotedUnion(text) {
  return [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The scorer's own enums and floor, parsed OUT OF `src/cost/**` instead of
 * restated here. The same anti-drift doctrine as the filescope twin: a copy
 * that cannot notice the original moved is a copy that will disagree with it
 * after a paid run.
 *
 * `verificationStratum` is the one that matters most. It has a CLOSED union
 * (`types.ts`), `narrowTask` enforces it, and one typo sets `corrupted` and
 * makes BOTH declared cells `evaluable: false` — discovered, as things stand,
 * after thirty paid sessions.
 *
 * `expectedSubagentStratum` IS NOT CLOSED IN THE FROZEN TEXT, and saying
 * otherwise would be this file inventing a rule. `types.ts` types it
 * `string | null` and `archive.ts` takes it through a bare string narrowing.
 * The closed `"solo" | "multi"` union belongs to `SubagentShare.stratum` — the
 * OBSERVED stratum. This assembler holds the declared value to the observed
 * union anyway, and that is ITS OWN narrowing, stated as one: a declared
 * stratum no observation can ever equal is a declaration that can never be
 * compared, so refusing it costs nothing and catches a typo.
 */
export function frozenScoringFacts(repoRoot = SCRIPT_REPO) {
  const typesPath = path.join(repoRoot, "src", "cost", "b12", "types.ts");
  const aggPath = path.join(repoRoot, "src", "cost", "b12", "aggregate.ts");
  if (!existsSync(typesPath)) return { ok: false, why: `${typesPath} does not exist — the enums are read from the scorer, never restated here` };
  if (!existsSync(aggPath)) return { ok: false, why: `${aggPath} does not exist — MIN_DELIVERY_OBSERVATIONS is read from the scorer, never restated here` };
  const types = readFileSync(typesPath, "utf8");
  const agg = readFileSync(aggPath, "utf8");

  // THREE SOURCES, AND THEY MUST AGREE. `verificationStratum` is declared TWICE
  // in types.ts (once on the manifest task, once on the scored term), and a
  // first-match regex would silently pick one if they ever diverged — an
  // adversarial round's finding. So every declaration is read and they are
  // required to be identical, and then cross-checked against the partition that
  // actually DECIDES: `src/cost/b12/strata.ts`, whose `declared === "..."`
  // branches are what sorts a term into a cell or into `unknownStratum`.
  // A type annotation says what should arrive; the partition says what happens.
  const vMatches = [...types.matchAll(/verificationStratum:\s*((?:"[^"]+"\s*\|\s*)*"[^"]+")\s*;/g)].map((m) => quotedUnion(m[1]));
  if (vMatches.length === 0) {
    return { ok: false, why: "could not read the verificationStratum union out of types.ts — the shape moved, and guessing it is how a typo reaches a paid run" };
  }
  const asKey = (u) => [...u].sort().join("|");
  if (new Set(vMatches.map(asKey)).size > 1) {
    return {
      ok: false,
      why: `types.ts declares verificationStratum ${vMatches.length} times and they DISAGREE (${vMatches.map((u) => u.join("|")).join(" vs ")}) — one of them governs a manifest and the other a scored term, and a tool that picked either would be guessing`,
    };
  }
  const strataPath = path.join(repoRoot, "src", "cost", "b12", "strata.ts");
  if (existsSync(strataPath)) {
    const partition = [...readFileSync(strataPath, "utf8").matchAll(/declared === "([^"]+)"/g)].map((m) => m[1]);
    if (partition.length > 0 && asKey(partition) !== asKey(vMatches[0])) {
      return {
        ok: false,
        why: `types.ts declares verificationStratum as ${vMatches[0].join("|")} but strata.ts partitions on ${partition.join("|")} — the type and the code that sorts by it disagree, and the partition is the one that decides evaluability`,
      };
    }
  }
  const sBlock = types.slice(types.indexOf("interface SubagentShare"));
  const sMatch = /stratum:\s*((?:"[^"]+"\s*\|\s*)*"[^"]+")\s*;/.exec(sBlock);
  if (sMatch === null) {
    return { ok: false, why: "could not read SubagentShare.stratum's union out of types.ts — the shape moved" };
  }
  const mMatch = /export const MIN_DELIVERY_OBSERVATIONS\s*=\s*(\d+)/.exec(agg);
  if (mMatch === null) {
    return { ok: false, why: "could not read MIN_DELIVERY_OBSERVATIONS out of aggregate.ts — the per-cell floor is not a number this file may choose" };
  }
  return {
    ok: true,
    verificationStrata: vMatches[0],
    subagentStrata: quotedUnion(sMatch[1]),
    minDeliveryObservations: Number(mMatch[1]),
  };
}

// ---------------------------------------------------------------------------
// THE CONFIG
// ---------------------------------------------------------------------------

/**
 * One config, run-level only. What it may NOT carry is the point: no
 * `baseCommit`, no `acceptance`, no `prompt` — those live with the task, where
 * the author proved things about them.
 *
 * The three ordered id lists ARE ordered, and the order is load-bearing:
 * `committedOrderViolation` reads the manifest's task order to decide whether a
 * session ran the task it was owed, so a set here would silently become a
 * sequence somewhere else.
 */
export function parseManifestConfig(repoRoot, configPath, opts = {}) {
  const pilotOnly = opts.pilotOnly === true;
  const bad = (why) => ({ ok: false, why });
  if (!existsSync(configPath)) return bad(`${configPath} does not exist`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    return bad(`${configPath} is not JSON: ${error.message}`);
  }

  const idList = (name) => {
    const v = raw[name];
    if (!Array.isArray(v) || v.length === 0) return { ok: false, why: `config.${name} is absent or empty — it is an ORDERED list of task ids` };
    for (const id of v) {
      if (typeof id !== "string" || !SAFE_ID.test(id)) {
        return { ok: false, why: `config.${name} carries ${JSON.stringify(id)}, which is not a safe path segment — ids name evidence/<runId>/obs-<taskId>-<arm>/` };
      }
    }
    const dupes = v.filter((id, i) => v.indexOf(id) !== i);
    if (dupes.length > 0) return { ok: false, why: `config.${name} repeats ${[...new Set(dupes)].join(", ")} — one id, one declaration` };
    return { ok: true, value: v };
  };

  const lists = { manifestA: [], manifestB: [] };
  // PILOT-ONLY IS A REAL PHASE, NOT A CONVENIENCE. `runPlan` PHASE 2 precedes
  // PHASE 4: the pilot RUNS before the sealed manifests exist, and
  // `design.artifacts` 4 excludes its ids from BOTH of them. Requiring sixty
  // authored siblings before this tool will emit five pilot manifests would
  // invert that ordering — the first draft did exactly that, which is why the
  // pilot could not be assembled on the day its five bases were authored.
  for (const name of pilotOnly ? ["pilot"] : ["manifestA", "manifestB", "pilot"]) {
    const parsed = idList(name);
    if (!parsed.ok) return bad(parsed.why);
    lists[name] = parsed.value;
  }

  // THE SEVENTH OWNER DECISION, ENFORCED HERE AND NOWHERE ELSE IN THE REPO.
  // `checkCore` compares the pilot against each manifest and never A against B
  // — `manifestDeclarationGaps` takes ONE manifest, so it structurally cannot —
  // so an intersection would seal, register and score in silence. The decision
  // is recorded pre-data in PREMISES.md § B12 as the seventh, and this refusal
  // cites it rather than a STATE.md sentence, because that file is overwritten
  // every session and a diary is not design authority.
  const shared = lists.manifestA.filter((id) => lists.manifestB.includes(id));
  if (shared.length > 0) {
    return bad(
      `manifests A and B share ${shared.join(", ")} — the SEVENTH owner decision (PREMISES.md § B12, pre-data) ` +
        "makes the corpus 65 DISTINCT specifications, 30 + 30 + 5, with no task measured twice. " +
        "Nothing frozen forbids the overlap, which is exactly why it is refused here: no validator downstream would notice it"
    );
  }
  for (const [name, list] of [["manifest A", lists.manifestA], ["manifest B", lists.manifestB]]) {
    const withPilot = list.filter((id) => lists.pilot.includes(id));
    if (withPilot.length > 0) {
      return bad(`${name} shares ${withPilot.join(", ")} with the pilot — design.artifacts 4 excludes the pilot from BOTH sealed manifests (checkCore refuses this too, after a seal)`);
    }
  }

  for (const name of pilotOnly ? ["pilotRunId"] : ["runIdA", "runIdB", "pilotRunId"]) {
    if (typeof raw[name] !== "string" || !SAFE_ID.test(raw[name])) {
      return bad(`config.${name} is absent or not a safe path segment — it names evidence/<runId>… on disk`);
    }
  }
  if (!pilotOnly && raw.runIdA === raw.runIdB) return bad("config.runIdA and config.runIdB are the same string — run 2 is a distinct registered run, not a relabel (checkCore)");

  const pairSets = { abPairsA: [], abPairsB: [] };
  for (const [name, owner] of pilotOnly ? [] : [["abPairsA", lists.manifestA], ["abPairsB", lists.manifestB]]) {
    const v = raw[name];
    if (!Array.isArray(v)) return bad(`config.${name} is absent — manifest B needs its OWN pairs, because checkCore runs manifestDeclarationGaps over BOTH`);
    for (const p of v) {
      if (!p || typeof p !== "object" || typeof p.id !== "string" || typeof p.taskId !== "string") {
        return bad(`config.${name} carries an entry that is not {id, taskId, order}`);
      }
      if (!owner.includes(p.taskId)) return bad(`config.${name} names task ${p.taskId}, which is not in that manifest`);
      if (p.order !== "treatment-first" && p.order !== "control-first") {
        return bad(`config.${name} entry ${p.id} declares order ${JSON.stringify(p.order ?? null)} — the schema is treatment-first | control-first`);
      }
    }
    pairSets[name] = v.map((p) => ({ id: p.id, taskId: p.taskId, order: p.order }));
  }

  if (raw.pinned === null || typeof raw.pinned !== "object" || Array.isArray(raw.pinned)) {
    return bad("config.pinned is absent — every run-level pin artifact 1 requires lives there, declared once rather than in 65 places");
  }
  const specRoot = typeof raw.specRoot === "string" && raw.specRoot.length > 0 ? raw.specRoot : DEFAULT_SPEC_ROOT;
  if (path.isAbsolute(specRoot) || specRoot.split(/[\\/]/).includes("..")) {
    return bad(`config.specRoot ${JSON.stringify(specRoot)} must be a relative path inside the repository`);
  }
  // `evidence/` is the one place it may never be: `reconcileRegisterTraces` turns
  // every tree entry under `evidence/` into a trace id, so a committed spec root
  // there becomes a phantom run with no manifest and refuses EVERY registration.
  if (specRoot.split(/[\\/]/)[0] === "evidence") {
    return bad("config.specRoot lies under evidence/ — every tree entry there becomes a registered trace id, and a phantom run refuses every later registration");
  }

  return { ok: true, config: { specRoot, pilotOnly, ...lists, runIdA: raw.runIdA, runIdB: raw.runIdB, pilotRunId: raw.pilotRunId, ...pairSets, pinned: raw.pinned, configPath } };
}

// ---------------------------------------------------------------------------
// PER-TASK DERIVATION
// ---------------------------------------------------------------------------

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * One task's manifest entry, DERIVED. Reads three things from the spec
 * directory — `spec.json` for the authoring facts, its `manifest` block for the
 * fields only a manifest needs, and `prompt.md` for the prompt — and the base
 * commit from the tag. Returns the entry in `TASK_KEY_ORDER`, or the reasons.
 *
 * The `manifest` block lives inside `spec.json` under its own key so one task is
 * one directory of three files. `parseAuthorSpec` ignores it by construction,
 * which means a misspelled key is invisible to the author — so this function
 * refuses a missing or malformed block loudly rather than defaulting anything.
 */
export function deriveTask(repoRoot, specRoot, taskId, facts) {
  const reasons = [];
  const specDir = path.join(repoRoot, specRoot, taskId);
  const parsed = parseAuthorSpec(specDir);
  if (!parsed.ok) return { ok: false, reasons: [`task ${taskId}: ${parsed.why}`] };
  const spec = parsed.spec;
  if (spec.taskId !== taskId) {
    return { ok: false, reasons: [`${specDir}/spec.json declares taskId ${spec.taskId}, but the directory is named ${taskId} — the id is a path segment and the two must agree`] };
  }

  const tag = readCorpusTag(repoRoot, taskId);
  if (!tag.ok) return { ok: false, reasons: [`task ${taskId}: ${tag.why}`] };
  if (tag.commit === null) {
    return {
      ok: false,
      reasons: [`task ${taskId}: ${tag.tag} does not exist — the base commit is taken from the tag and never from a field, so an unpublished task cannot be assembled (author and publish it first)`],
    };
  }

  const promptPath = path.join(specDir, "prompt.md");
  if (!existsSync(promptPath)) reasons.push(`task ${taskId}: ${promptPath} does not exist — the prompt lives with the defect, not in the config`);
  const prompt = existsSync(promptPath) ? readFileSync(promptPath, "utf8") : "";
  if (existsSync(promptPath) && prompt.trim().length === 0) reasons.push(`task ${taskId}: prompt.md is empty`);

  const raw = JSON.parse(readFileSync(path.join(specDir, "spec.json"), "utf8"));
  const block = raw.manifest;
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    return { ok: false, reasons: [...reasons, `task ${taskId}: spec.json carries no "manifest" object — parseAuthorSpec ignores that key, so a misspelling is invisible until here`] };
  }
  for (const field of DERIVED_TASK_FIELDS) {
    if (field in block) {
      reasons.push(
        `task ${taskId}: spec.json's manifest block declares ${field}, which is DERIVED — ` +
          "baseCommit comes from the corpus tag, acceptance from predicate.argv, promptSha256 from prompt.md, fileScope and id from the spec. " +
          "A declaration that would be silently ignored is refused instead"
      );
    }
  }
  if (!facts.verificationStrata.includes(block.verificationStratum)) {
    reasons.push(
      `task ${taskId}: verificationStratum ${JSON.stringify(block.verificationStratum ?? null)} is not one of ${facts.verificationStrata.map((s) => JSON.stringify(s)).join(" | ")} ` +
        "(read out of src/cost/b12/types.ts) — an unknown value sets `corrupted` in the scorer and makes BOTH declared cells non-evaluable"
    );
  }
  if (!facts.subagentStrata.includes(block.expectedSubagentStratum)) {
    reasons.push(
      `task ${taskId}: expectedSubagentStratum ${JSON.stringify(block.expectedSubagentStratum ?? null)} is not one of ${facts.subagentStrata.map((s) => JSON.stringify(s)).join(" | ")}. ` +
        "THE FROZEN TEXT DOES NOT CLOSE THIS ONE — types.ts types it `string | null` — so this is the assembler narrowing it to the OBSERVED union, " +
        "on the ground that a declared stratum no observation can equal can never be compared"
    );
  }
  if (!Array.isArray(block.verificationCommands) || block.verificationCommands.length === 0 || block.verificationCommands.some((c) => typeof c !== "string" || c.trim() === "")) {
    reasons.push(`task ${taskId}: verificationCommands must be a non-empty array of non-empty strings (artifact 1: "the exact verification command string(s)"; voidConditions 4 freezes them)`);
  }
  if (typeof block.gateCategory !== "string" || block.gateCategory.length === 0) {
    reasons.push(`task ${taskId}: gateCategory is absent (artifact 1: "the frozen gate category")`);
  }
  if (!Number.isFinite(block.repairMaxRounds)) {
    reasons.push(`task ${taskId}: repairMaxRounds is absent or not a number (artifact 1: "repair's frozen max_rounds")`);
  }

  reasons.push(...argvGrammarReasons(taskId, spec.predicate.argv));
  if (reasons.length > 0) return { ok: false, reasons };

  const values = {
    id: taskId,
    prompt,
    promptSha256: sha256(prompt),
    baseCommit: tag.commit,
    verificationStratum: block.verificationStratum,
    expectedSubagentStratum: block.expectedSubagentStratum,
    // AN ARRAY WHOSE ELEMENTS ARE STRINGS, and both halves are load-bearing.
    // `manifestDeclarationGaps` requires Array.isArray, so a bare string is
    // refused at the manifest; `archive.ts`'s `strings()` keeps only
    // `typeof x === "string"`, so an array of argv ARRAYS narrows to [] in
    // silence. Under the grammar above the two forms are the same command.
    acceptance: [spec.predicate.argv.join(" ")],
    acceptanceExpectedExit: spec.predicate.expectedExit,
    verificationCommands: [...block.verificationCommands],
    gateCategory: block.gateCategory,
    repairMaxRounds: block.repairMaxRounds,
    fileScope: [...spec.fileScope],
  };
  const task = {};
  for (const key of TASK_KEY_ORDER) task[key] = values[key];
  return { ok: true, task, parent: spec.parent };
}

// ---------------------------------------------------------------------------
// ASSEMBLY
// ---------------------------------------------------------------------------

/** Deterministic bytes: two spaces, trailing newline, LF only. */
export function manifestBytes(value) {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (text.includes("\r")) throw new Error("a CR reached the manifest bytes — the corpus must be byte-stable across machines");
  return text;
}

/** The one spelling a run id enters `pinned.scoringCommand` through. */
export const RUN_ID_PLACEHOLDER = "<runId>";

/**
 * `voidConditions` 19 compares `pinned.scoringCommand` for EXACT equality
 * against the invocation `emit` rebuilds from its own argv (`assemble.ts:1172`,
 * `emit.ts:316`), and that argv carries the run id. So one literal string
 * cannot be right for A and for B, and the config declares a TEMPLATE that is
 * resolved here, per manifest, from that manifest's OWN runId — B's is runIdB,
 * even though B's sealed FILE is named from runIdA (`outputPaths`), because
 * `open-b` copies those bytes to `evidence/<runIdB>.b12.tasks.json` and run 2
 * is scored under runIdB.
 *
 * ON A COPY, which is the whole reason this is a function. `config.pinned` is
 * ONE object handed to all seven manifests; writing the resolved string onto it
 * would make the last call win for every earlier one, and the emitted bytes
 * would still look entirely plausible. Spreading also preserves key order,
 * because `scoringCommand` already exists — the manifest bytes do not move.
 */
function pinnedFor(pinned, runId) {
  return { ...pinned, scoringCommand: pinned.scoringCommand.split(RUN_ID_PLACEHOLDER).join(runId) };
}

/**
 * Top-level key order, taken from the same fixture as `TASK_KEY_ORDER` rather
 * than chosen: `runId, pinned, abPairs, tasks`. `pilotRunId` is the one
 * addition and it sits beside `runId`, being the same kind of thing — an
 * identity, not a pin.
 *
 * ON BOTH SEALED MANIFESTS AND ON NEITHER PILOT. `b12-register.mjs:627` and
 * `:740` resolve the pilot as `manifestA?.pilotRunId ?? runId`, and this
 * assembler never emitted the field — so for every manifest it produced the
 * fallback fired and the register looked for the pilot record under the RUN's
 * id, while `b12-run.mjs:2315` had written it under the pilot's.
 *
 * Only A's copy is read today. B carries it anyway for two reasons: `open-b`
 * installs B's bytes verbatim as run 2's manifest (`b12-register.mjs:878`), so
 * the field is there if run 2 ever needs it; and two sealed manifests that
 * could disagree about which pilot preceded them is a disagreement nothing
 * downstream would surface, so `assemblyRefusals` refuses one. The five pilot
 * manifests do not carry it, where it would only restate `runId`.
 */
function manifestObject(runId, tasks, abPairs, pinned, pilotRunId = null) {
  return pilotRunId === null ? { runId, pinned, abPairs, tasks } : { runId, pilotRunId, pinned, abPairs, tasks };
}

/**
 * Build all three artifacts in memory. Writes nothing; `build` writes, `plan`
 * does not, and both call this.
 */
export function assembleManifests(repoRoot, config) {
  // The SCRIPT's repo, not `repoRoot` — see `SCRIPT_REPO`.
  const facts = frozenScoringFacts();
  if (!facts.ok) return { ok: false, reasons: [facts.why] };

  const reasons = [];
  const tasks = {};
  const parents = new Set();
  const lists = config.pilotOnly
    ? [["pilot", config.pilot]]
    : [["manifestA", config.manifestA], ["manifestB", config.manifestB], ["pilot", config.pilot]];
  for (const [listName, ids] of lists) {
    tasks[listName] = [];
    for (const id of ids) {
      const derived = deriveTask(repoRoot, config.specRoot, id, facts);
      if (!derived.ok) {
        reasons.push(...derived.reasons);
        continue;
      }
      tasks[listName].push(derived.task);
      parents.add(derived.parent);
    }
  }
  if (reasons.length > 0) return { ok: false, reasons };

  // ONE GREEN PARENT FOR THE WHOLE CORPUS. `verifySiblings` proves it over the
  // authored commits; this catches the same thing at the declaration, where the
  // message can name the specs rather than two shas.
  if (parents.size > 1) {
    return { ok: false, reasons: [`the corpus declares ${parents.size} different green parents (${[...parents].map((p) => p.slice(0, 12)).join(", ")}) — every base must differ from ONE shared tree by exactly its own defect`] };
  }

  // THE TEMPLATE, CHECKED BEFORE IT IS USED, because the failure it replaces was
  // silent all the way to score time. `pinned.scoringCommand` named the PILOT
  // run; `build` asserts only that the field is a non-empty string
  // (`b12-run.mjs:1065`); and clause 19 does not fire until `emit`, which is
  // after every paid session has been spent.
  const template = config.pinned?.scoringCommand;
  if (typeof template !== "string" || template.length === 0) {
    return { ok: false, reasons: ["pinned.scoringCommand is absent, empty, or not a string — it is the template each manifest resolves from its own runId (voidConditions 19)"] };
  }
  if (!template.includes(RUN_ID_PLACEHOLDER)) {
    return {
      ok: false,
      reasons: [
        `pinned.scoringCommand does not contain ${RUN_ID_PLACEHOLDER} — a literal run id there is right for at most one of the seven manifests and clause 19 voids the rest, at score time and not here (got ${JSON.stringify(template)})`,
      ],
    };
  }

  const manifestA = config.pilotOnly ? null : manifestObject(config.runIdA, tasks.manifestA, config.abPairsA, pinnedFor(config.pinned, config.runIdA), config.pilotRunId);
  const manifestB = config.pilotOnly ? null : manifestObject(config.runIdB, tasks.manifestB, config.abPairsB, pinnedFor(config.pinned, config.runIdB), config.pilotRunId);
  // FIVE SINGLE-TASK PILOT MANIFESTS SHARING ONE runId, and BOTH halves of that
  // shape are forced by the frozen harness rather than chosen.
  //
  // ONE TASK EACH, because `committedOrderViolation` runs for every treatment
  // arm — it sits under `if (arm === "treatment")` and NOT under the
  // `if (!pilotMode)` exemption (`b12-run.mjs:2587-2594`, `:2615`) — and it
  // requires every predecessor to have run, reading that from the runlog. The
  // pilot writes no runlog row at all: `b12-run.mjs:3143` says so in those words
  // ("no obs-dir, no runlog row, no MEASUREMENTS line, no commit"). In a
  // five-task pilot manifest, only index 0 could ever run.
  //
  // THREE PAIRS EACH, and this is what an adversarial round caught. `observe`
  // runs `manifestDeclarationGaps` at `b12-run.mjs:2540` — UNCONDITIONALLY,
  // before any `pilotMode` branch — and that sweep refuses a manifest declaring
  // fewer than three A/B pairs (`:1106-1111`). An earlier draft emitted
  // `abPairs: []` and suppressed the resulting gap INSIDE THIS TOOL, which
  // produced five manifests that looked clean here and could not run at all.
  // Silencing a validator in a build tool does not persuade the harness.
  //
  // THE PILOT IS NOT AN A/B PASS AND THESE PAIRS ARE NOT AN A/B PLAN. Artifact
  // 1's six pairs live in manifest A. What the frozen sweep requires is a
  // well-formed pair DECLARATION on any manifest — at least three, both arm
  // orders present — so a pilot manifest carries the minimum well-formed one
  // naming its own single task, which is the only task it may name.
  const pilots = tasks.pilot.map((task) => ({
    taskId: task.id,
    manifest: manifestObject(
      config.pilotRunId,
      [task],
      [
        { id: `${task.id}-1`, taskId: task.id, order: "treatment-first" },
        { id: `${task.id}-2`, taskId: task.id, order: "control-first" },
        { id: `${task.id}-3`, taskId: task.id, order: "treatment-first" },
      ],
      pinnedFor(config.pinned, config.pilotRunId)
    ),
  }));

  return { ok: true, manifestA, manifestB, pilots, facts };
}

/**
 * Everything `observe` would otherwise charge a paid session to discover, plus
 * this assembler's own self-validation. Returns [] or the reasons.
 *
 * SELF-VALIDATION IS PARTITIONED ON PURPOSE. `checkCore`'s pilot-shaped reds
 * cannot be satisfied before the pilot has RUN — it wants a pilot RECORD, and
 * this tool emits pilot MANIFESTS. So a synthetic record built from the five
 * declared ids makes the count and both overlap reds fire for real, and only the
 * `pilot === null` red is deferred. Deferring it silently would be the
 * interesting failure, so it is returned as a named list instead.
 */
export function assemblyRefusals(repoRoot, config, built) {
  const red = [];
  const { manifestA, manifestB, pilots, facts } = built;

  // UNDER PILOT-ONLY THERE IS NO A AND NO B, so every check that compares them
  // is DEFERRED rather than silently skipped — `deferredRefusals` names each.
  const sealed = config.pilotOnly ? [] : [["manifest A", manifestA], ["manifest B", manifestB]];
  for (const [name, m] of sealed) {
    for (const gap of manifestDeclarationGaps(m)) red.push(`${name}: ${gap}`);
  }
  // NOTHING IS SUPPRESSED HERE, and an earlier draft suppressed one thing. The
  // pilot manifests now satisfy the frozen sweep outright, so every gap it
  // reports is a real one. A build tool that filters the validator's output is
  // a build tool that ships artifacts the harness will refuse.
  pilots.forEach(({ taskId, manifest }) => {
    for (const gap of manifestDeclarationGaps(manifest)) red.push(`pilot manifest ${taskId}: ${gap}`);
  });

  // THE RESOLVED COMMANDS, RE-DERIVED RATHER THAN TRUSTED — a check this file
  // did not need until this file created the need for it. All seven manifests
  // used to share ONE pinned object and one string, which could be wrong but
  // could not DISAGREE. They now hold seven independently built objects that are
  // supposed to differ, and nothing downstream can tell a right difference from
  // a wrong one: manifestDeclarationGaps asks only that the field is a non-empty
  // string (b12-run.mjs:1065), checkCore never recomputes it, and
  // registrationGuard proves byte identity rather than that the bytes are right.
  // Clause 19 would, at score time, after the sessions are spent.
  //
  // WHAT THIS DOES NOT CHECK, and the omission is deliberate: whether the
  // template names the right executable, carries --audit, or spells the audit
  // path correctly. Guessing at command SHAPE here would refuse lawful commands
  // this experiment has not thought of; the exact string that ships is pinned in
  // tests/b12-plan.test.ts instead, which is an equality and not a guess.
  const template = typeof config.pinned?.scoringCommand === "string" ? config.pinned.scoringCommand : null;
  if (template !== null) {
    const carriers = [
      ...(config.pilotOnly ? [] : [["manifest A", manifestA], ["manifest B", manifestB]]),
      ...pilots.map(({ taskId, manifest }) => [`pilot manifest ${taskId}`, manifest]),
    ];
    for (const [name, m] of carriers) {
      const want = template.split(RUN_ID_PLACEHOLDER).join(m.runId);
      if (m.pinned?.scoringCommand !== want) {
        red.push(
          `${name}: pinned.scoringCommand is ${JSON.stringify(m.pinned?.scoringCommand ?? null)} but its own runId resolves the template to ${JSON.stringify(want)} — clause 19 compares the manifest's string against an invocation carrying the manifest's runId, so this is a VOID at score time`
        );
      }
    }
  }

  // AND A AND B MUST NAME THE SAME PILOT. Only A's pilotRunId is read
  // (b12-register.mjs:627, :740), so B's could drift without any later check
  // noticing — and two manifests sealed in one act disagreeing about which run
  // preceded them is not a thing the record should be able to say.
  if (!config.pilotOnly && manifestA?.pilotRunId !== manifestB?.pilotRunId) {
    red.push(
      `manifests A and B name different pilots (${JSON.stringify(manifestA?.pilotRunId ?? null)} vs ${JSON.stringify(manifestB?.pilotRunId ?? null)}) — one pilot run precedes both, and only A's copy is ever read`
    );
  }

  if (!config.pilotOnly) {
    const syntheticPilot = { observations: config.pilot.map((taskId) => ({ taskId })) };
    for (const core of checkCore(manifestA, manifestB, syntheticPilot)) red.push(core);
  }

  // THE PER-CELL FLOOR, at the declaration. A stratum carrying fewer tasks than
  // MIN_DELIVERY_OBSERVATIONS can never reach that many observations, so the
  // cell is void by construction before a single session runs.
  for (const [name, m] of sealed) {
    const counts = new Map();
    for (const t of m.tasks) counts.set(t.verificationStratum, (counts.get(t.verificationStratum) ?? 0) + 1);
    for (const [stratum, n] of counts) {
      if (n < facts.minDeliveryObservations) {
        red.push(`${name}: only ${n} task(s) declare verificationStratum ${JSON.stringify(stratum)}, under the floor of ${facts.minDeliveryObservations} (MIN_DELIVERY_OBSERVATIONS, read from aggregate.ts) — that cell is void by construction`);
      }
    }
  }

  const pinned = config.pinned ?? {};

  // POLICY BLOBS, BOTH ARMS, REACHABLE. voidConditions 12 voids any observation
  // record without its arm's blob hash, so an unreachable blob is a run that
  // cannot produce a compliant record.
  //
  // `findPolicyBlob` RESOLVES A RELATIVE `repo` AGAINST `process.cwd()`, not
  // against this function's `repoRoot` — `b12-run.mjs` captures `REPO` at module
  // load (`:37`). In production the two coincide, because the CLI below uses
  // `process.cwd()` as `repoRoot`. Anywhere else they do not, so a caller
  // passing a different root gets an answer about the current directory. Named
  // here rather than papered over; an absolute `repo` is immune either way.
  for (const arm of ["treatment", "control"]) {
    const found = findPolicyBlob(manifestA ?? built.pilots[0]?.manifest ?? { pinned }, arm);
    if (found.blob === null) red.push(`policy blob (${arm}): ${found.why}`);
  }

  // THE MEMORY SNAPSHOT, HASHED HERE rather than trusted. TWO DEFECTS LIVED IN
  // THESE SIX LINES, one hiding the other, and both were found by an adversarial
  // round pulling on the first:
  //
  //  - THE HASH WAS COMPARED-IF-PRESENT while the harness requires it. Its own
  //    refusal says the words: "required, not compared-if-present"
  //    (`b12-run.mjs:1700`). A null sha passed assembly and refused at runtime,
  //    which is the whole failure mode this file exists to prevent.
  //  - AND THE COMPARISON WAS AGAINST THE WRONG THING. `hashMemoryDir` returns
  //    `{sha256, files}`, not a string, so `pinnedString !== object` was ALWAYS
  //    true: every correctly pinned snapshot would have been reported as a
  //    mismatch. It never fired only because the first defect stopped it running.
  if (typeof pinned.memorySnapshot === "string" && pinned.memorySnapshot.length > 0) {
    if (typeof pinned.memorySnapshotSha256 !== "string" || pinned.memorySnapshotSha256.length === 0) {
      red.push('pinned.memorySnapshotSha256 is absent — design.artifacts 1 lists "the memory snapshot" in the hashed inventory, and findMemorySnapshot refuses without it: required, not compared-if-present');
    }
    const dir = path.resolve(repoRoot, pinned.memorySnapshot);
    try {
      const { sha256: hash } = hashMemoryDir(dir);
      if (typeof pinned.memorySnapshotSha256 === "string" && pinned.memorySnapshotSha256 !== hash) {
        red.push(`pinned.memorySnapshotSha256 says ${pinned.memorySnapshotSha256.slice(0, 12)} but ${dir} hashes to ${hash.slice(0, 12)}`);
      }
    } catch (error) {
      red.push(`pinned.memorySnapshot ${dir} could not be hashed: ${error.message}`);
    }
  }

  // THE VERSION PIN IS COMPARED WITH `.includes()` BY THE HARNESS, so "2.1.2"
  // silently matches "2.1.221". A pin that is a PROPER PREFIX of another
  // plausible version is the trap, and it is free to refuse here.
  if (typeof pinned.claudeCodeVersion === "string" && !/^\d+\.\d+\.\d+$/.test(pinned.claudeCodeVersion)) {
    red.push(`pinned.claudeCodeVersion ${JSON.stringify(pinned.claudeCodeVersion)} is not a full x.y.z — assertPinned matches with .includes(), so a partial pin matches versions it did not mean`);
  }

  // THE PINS `observe` DEREFERENCES THAT NO FROZEN VALIDATOR REQUIRES. Found by
  // differencing every `pinned.*` the harness reads against every one
  // `manifestDeclarationGaps` demands; seven came out, and these are the ones
  // whose absence is not caught anywhere before a session is spent:
  //
  //  - `memorySnapshot` is REQUIRED AT RUNTIME and by nothing at build time.
  //    `b12-run.mjs:1685-1691` refuses without it, citing `voidConditions` 13,
  //    while the declaration sweep never mentions it. A manifest missing it
  //    passes every check this repository has and then refuses on the run
  //    machine.
  //  - `captureSha256` is worse, because its absence is SILENTLY PERMISSIVE:
  //    `b12-run.mjs:2040` reads `if (want && want !== sha256)`, so omitting the
  //    pin skips the comparison entirely and the built `dist/` goes unverified.
  //    The harness's own comment there calls it a hole the frozen text does not
  //    close. Requiring it here is the cheapest place to stop shipping unpinned.
  //  - `perArmTimeoutMs` and `extraArgs` ARE checked — by `checkCore`, which
  //    `--pilot-only` defers. Deferring a whole function to skip its A/B half
  //    quietly took these two with it, so they are re-checked here rather than
  //    left to a deferral that names them only by their container.
  if (typeof pinned.memorySnapshot !== "string" || pinned.memorySnapshot.length === 0) {
    red.push("pinned.memorySnapshot is absent — observe REQUIRES it (b12-run.mjs:1690, voidConditions 13) and manifestDeclarationGaps never asks for it, so a manifest without it passes every build-time check and refuses on the run machine");
  }
  if (typeof pinned.captureSha256 !== "string" || pinned.captureSha256.length === 0) {
    red.push("pinned.captureSha256 is absent — and its absence is SILENTLY PERMISSIVE: observe compares it only `if (want)` (b12-run.mjs:2040), so omitting it leaves the built dist/ unverified rather than refusing");
  }
  if (!Number.isFinite(pinned.perArmTimeoutMs)) {
    red.push("pinned.perArmTimeoutMs is absent — observe falls back to a silent 45-minute default (b12-run.mjs:2885). checkCore would refuse this, and --pilot-only defers checkCore");
  }
  if (!Array.isArray(pinned.extraArgs)) {
    red.push("pinned.extraArgs is absent — what the probe ran with is what the run must run with, declared. checkCore would refuse this, and --pilot-only defers checkCore");
  }

  // THE MCP CONFIG IS MACHINE-LOCAL TO THE MAC. `observe` requires both fields
  // and no validator checks them; this machine can only say whether they are
  // declared, and says exactly that rather than implying it verified a path.
  for (const field of ["mcpConfig", "mcpConfigSha256"]) {
    if (typeof pinned[field] !== "string" || pinned[field].length === 0) {
      red.push(`pinned.${field} is absent — observe dereferences it and NO validator checks it. Its path is machine-local to the run machine, so presence is all this machine can assert`);
    }
  }

  return red;
}

/** The reds that cannot be satisfied until the pilot has actually run. */
export function deferredRefusals(pilotOnly = false) {
  return [
    ...(pilotOnly
      ? [
          "checkCore over manifests A and B — the 30/30 cardinalities, the 6 A/B pairs, the distinct runIds, and BOTH pilot-overlap checks: not satisfiable while A and B are unauthored, and NOT skipped quietly",
          "the per-stratum floor of MIN_DELIVERY_OBSERVATIONS over the sealed manifests, for the same reason",
          // THESE TWO WERE SKIPPED WITHOUT BEING NAMED, which an adversarial
          // round caught, and the first was hiding behind a label that cannot
          // cover it: this file's own comment says checkCore NEVER compares A
          // against B, so deferring "checkCore" says nothing about the
          // intersection. A deferral that names the wrong container is a silent
          // skip wearing a citation.
          "the A n B DISJOINTNESS refusal — the seventh owner decision (PREMISES.md § B12). Under --pilot-only both lists are empty, so the intersection is vacuous rather than checked, and checkCore never compares A against B in any case: nothing else in this repository would notice an overlap",
          "corpusVerification over the SEALED bases — it receives only the pilot's ids here, so the shared green parent, the rates blob at the pin, and the confinement of each published diff go unverified for every task outside the pilot",
        ]
      : []),
    "no pilot file — PHASE 2 precedes PHASE 4, and a register with no pilot is a phase skipped in silence: satisfied by RUNNING the five pilot manifests, not by assembling them",
  ];
}

export function outputPaths(config) {
  if (config.pilotOnly) {
    return { manifestA: null, manifestB: null, pilots: config.pilot.map((t) => `evidence/${config.pilotRunId}.b12.pilot-${t}.manifest.json`) };
  }
  return {
    manifestA: `evidence/${config.runIdA}.b12.tasks.json`,
    manifestB: `evidence/${config.runIdA}.b12.manifest-B.tasks.json`,
    // NOT `.b12.tasks.json`: `reconcileRegisterTraces` reads that suffix as a
    // REGISTERED run, and five phantom registrations would refuse every real one.
    pilots: config.pilot.map((taskId) => `evidence/${config.pilotRunId}.b12.pilot-${taskId}.manifest.json`),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fail(why) {
  process.stderr.write(`b12-manifest: REFUSED — ${why}\n`);
  process.exit(1);
}

function report(lines, heading) {
  process.stderr.write(`b12-manifest: ${heading}\n`);
  for (const line of lines) process.stderr.write(`  - ${line}\n`);
}

function run(write, pilotOnly) {
  const repoRoot = process.cwd();
  const positional = process.argv.slice(3).filter((a) => !a.startsWith("--"));
  const configPath = path.resolve(repoRoot, positional[0] ?? DEFAULT_CONFIG_PATH);
  const parsed = parseManifestConfig(repoRoot, configPath, { pilotOnly });
  if (!parsed.ok) fail(parsed.why);
  const config = parsed.config;

  const built = assembleManifests(repoRoot, config);
  if (!built.ok) {
    report(built.reasons, `${built.reasons.length} reason(s) the corpus cannot be assembled:`);
    process.exit(1);
  }

  // THE CORPUS ITSELF, through the author's own verifier — same parent, rates
  // blob at the pin, published diff confined to the declared scope.
  const corpus = corpusVerification(repoRoot, {
    tasks: [...config.manifestA, ...config.manifestB, ...config.pilot].map((id) => ({ id, specDir: path.join(config.specRoot, id) })),
    ratesSha256: config.pinned?.ratesSha256,
    specRoot: config.specRoot,
  });
  if (corpus.length > 0) {
    report(corpus, `${corpus.length} reason(s) the published corpus is not sound:`);
    process.exit(1);
  }

  const red = assemblyRefusals(repoRoot, config, built);
  if (red.length > 0) {
    report(red, `${red.length} reason(s) the manifests would not register:`);
    // THE DEFERRED LIST PRINTS ON THIS PATH TOO, and it did not at first. A
    // check that is deferred rather than run is only honest while it is VISIBLE;
    // showing it solely on the success path means the operator meets it last,
    // after every other refusal is cleared, which is precisely when a deferral
    // is easiest to mistake for a pass.
    report(deferredRefusals(config.pilotOnly), "and these are DEFERRED, not skipped:");
    process.exit(1);
  }

  const paths = outputPaths(config);
  const artifacts = [
    ...(config.pilotOnly ? [] : [
      { rel: paths.manifestA, bytes: manifestBytes(built.manifestA) },
      { rel: paths.manifestB, bytes: manifestBytes(built.manifestB) },
    ]),
    ...built.pilots.map((p, i) => ({ rel: paths.pilots[i], bytes: manifestBytes(p.manifest) })),
  ];

  // A REGISTERED PATH IS NEVER OVERWRITTEN. `registrationGuard` enforces byte
  // identity across three copies of manifest A, so rewriting one that HEAD
  // already introduced breaks every later `observe` — and the repair is a new
  // run id, because history cannot be un-committed.
  const introduced = priorIntroductionRefusals(repoRoot, "HEAD", artifacts.map((a) => a.rel));
  // TRACKED-AT-HEAD IS A SEPARATE QUESTION FROM INTRODUCED-AT-HEAD, and an
  // adversarial round was right that the second does not imply the first.
  // `priorIntroductionRefusals` asks `git log --diff-filter=A`, so a path that
  // arrived by a RENAME git recorded as such has no `A` record under its
  // current name and would slip through while being fully tracked. Asking the
  // tree directly is the complete question and costs one command per output.
  for (const a of artifacts) {
    const tracked = spawnSync("git", ["-C", repoRoot, "cat-file", "-e", `HEAD:${a.rel}`], { encoding: "utf8" });
    if (tracked.status === 0) {
      introduced.push(`${a.rel} is already TRACKED at HEAD — registrationGuard enforces byte identity across three copies of a registered manifest, so rewriting one breaks every later observe; use a run id whose evidence paths are unborn`);
    }
  }
  if (introduced.length > 0) {
    report(introduced, `${introduced.length} output path(s) already exist in history:`);
    process.exit(1);
  }
  // NOT `flag: "wx"`, and the omission is deliberate. Re-running `build` while
  // the corpus is being assembled is the ordinary case — iteration is the whole
  // point of a build tool — so an exclusive-create flag would refuse the second
  // run of every day. What must never be overwritten is a REGISTERED path, and
  // that is what the two checks above establish. The residual is a registration
  // committed between those checks and these writes, by another process, on a
  // single-operator tool: named, and not defended against.

  const deferred = deferredRefusals(config.pilotOnly);
  process.stdout.write(`b12-manifest: ${write ? "WROTE" : "PLANNED"} ${artifacts.length} artifact(s)\n`);
  for (const a of artifacts) {
    if (write) {
      mkdirSync(path.dirname(path.resolve(repoRoot, a.rel)), { recursive: true });
      writeFileSync(path.resolve(repoRoot, a.rel), a.bytes, "utf8");
    }
    process.stdout.write(`  ${sha256(a.bytes).slice(0, 12)}  ${a.rel}\n`);
  }
  report(deferred, "NOT YET SATISFIABLE, and deferred rather than dropped:");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cmd = process.argv[2];
  const pilotOnly = process.argv.includes("--pilot-only");
  if (cmd === "build") run(true, pilotOnly);
  else if (cmd === "plan") run(false, pilotOnly);
  else fail("usage: node scripts/b12-manifest.mjs <build|plan> [configPath] [--pilot-only]");
}
