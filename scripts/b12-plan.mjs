#!/usr/bin/env node
/**
 * THE 60-TASK CORPUS DESIGN, written as data so every constraint is CHECKABLE rather than
 * asserted. It refuses to emit if any of them fails.
 *
 *   node scripts/b12-plan.mjs check   # regenerate in memory and diff; refuses on drift
 *   node scripts/b12-plan.mjs write   # regenerate and install
 *
 * WHY IT IS IN THE REPOSITORY. It was not, for four commits. It lived in a session's temp
 * scratchpad with the repository path hardcoded in five places, while `corpus-plan.json`
 * carried the claim "generated and constraint-checked, not hand-listed" — a claim that one
 * `%TEMP%` sweep would have made unfalsifiable, taking `reaches()` with it. The spec writer
 * made the same journey in `6e95b4e`.
 *
 * `check` is the half that did not exist before, and it is the point: without it the plan is
 * generator output only until the first person edits the artifact, and nothing anywhere
 * notices. `tests/b12-plan.test.ts` runs it, so a hand-edit is a red suite rather than a
 * silent divergence.
 *
 * A SAFETY PROPERTY WORTH KEEPING, and the reason paths were the only thing wrong with the
 * scratch copy: no path feeds the OUTPUT. The plan's bytes come from four inputs — the two
 * tables below, `pilot-plan.json`'s ratesSha256, and the parent read off the pilot specs.
 * The repository root feeds only the constraint checks and the write target, so a path
 * mistake can make this script REFUSE but cannot make it emit different bytes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "b12-corpus", "corpus-plan.json");
const PILOT = ["pilot-normalizeid", "pilot-usablefree", "pilot-csvreturn", "pilot-csvcomment", "pilot-lmsguard"];

// TEST-RED: a src file paired with a FAST suite that goes red when the defect lands.
// The b12-* suites are excluded on purpose — they run 60-270 s and the author re-runs
// the predicate at every base.
const TEST_RED = [
  ["selmatchfuzzy", "src/selection.ts", "tests/selection.test.ts"],
  ["selsizefit", "src/selection.ts", "tests/selection.test.ts"],
  ["selobjective", "src/selection.ts", "tests/selection.test.ts"],
  ["csvheader", "src/models-csv.ts", "tests/models-csv.test.ts"],
  ["csvcols", "src/models-csv.ts", "tests/models-csv.test.ts"],
  ["csvempty", "src/models-csv.ts", "tests/models-csv.test.ts"],
  ["lmsps", "src/lms.ts", "tests/lms.test.ts"],
  ["lmssizes", "src/lms.ts", "tests/lms.test.ts"],
  ["parsefence", "src/parse.ts", "tests/parse.test.ts"],
  ["parsepath", "src/parse.ts", "tests/parse.test.ts"],
  ["parsetrail", "src/parse.ts", "tests/parse.test.ts"],
  ["memslug", "src/memory.ts", "tests/memory.test.ts"],
  ["memindex", "src/memory.ts", "tests/memory.test.ts"],
  // NOT tests/config.test.ts, the obvious pairing, and this is the one entry here whose
  // suite was chosen against its own file. That suite is RED AT THE GREEN PARENT on
  // Windows: it asserted the literal "/project/config/models.csv" and path.resolve is
  // drive-qualified on win32, so the author refuses both bases ("a defect authored onto a
  // red parent is two defects, one of them unowned") and the parent cannot move with 61
  // tags published against it.
  //
  // A -t filter narrowing the predicate to the one test each defect breaks was measured and
  // is DEAD five ways over: an unmatched -t exits 0, so the predicate could pass vacuously;
  // SHELL_UNSAFE forces shell:false on a spaced argv and npx with shell:false on Windows is
  // ENOENT; b12-manifest.mjs refuses whitespace in argv by name; the manifest joins argv on
  // spaces and the frozen b12-run.mjs splits it back; and a one-assertion oracle admits a
  // false FIXED. Underneath all of it, the premise is a Windows artifact and the run machine
  // is the Mac, where that suite is green — the fix would have routed around a defect that
  // does not exist where these execute.
  //
  // tests/claude-md.test.ts reaches src/config.ts through loadConfig and is MEASURED green
  // at the parent. What it costs is recorded in defect-sites.json: it reaches that file
  // through exactly one `it`, so these two are the corpus's first pair breaking the same
  // named assertion.
  ["cfgclamp", "src/config.ts", "tests/claude-md.test.ts"],
  ["cfgenv", "src/config.ts", "tests/claude-md.test.ts"],
  // NOT tests/config.test.ts either, for a different reason: it imports src/config.js and
  // never reaches src/checks/config.ts — a defect there would have left that suite green and
  // the author would have refused the base. Caught by the reachability check below.
  ["chkdetect", "src/checks/config.ts", "tests/gate.test.ts"],
  ["chkbudget", "src/checks/config.ts", "tests/gate.test.ts"],
  ["cmdheading", "src/claude-md.ts", "tests/claude-md.test.ts"],
  ["cmdidem", "src/claude-md.ts", "tests/claude-md.test.ts"],
  ["fsescape", "src/fs-safety.ts", "tests/fs-safety.test.ts"],
  ["fsoutcap", "src/fs-safety.ts", "tests/fs-safety.test.ts"],
  ["fsctxcap", "src/fs-safety.ts", "tests/fs-safety.test.ts"],
  ["probephrase", "src/contract-probe.ts", "tests/contract-probe.test.ts"],
  ["probetier", "src/contract-probe.ts", "tests/contract-probe.test.ts"],
  ["gatebudget", "src/tools/gate.ts", "tests/gate.test.ts"],
  ["gatededupe", "src/tools/gate.ts", "tests/gate.test.ts"],
  ["scafexists", "src/tools/scaffold.ts", "tests/scaffold.test.ts"],
  ["statusoffline", "src/tools/status.ts", "tests/status.test.ts"],
  ["modelspick", "src/tools/models.ts", "tests/models-tool.test.ts"],
  ["repairrounds", "src/tools/repair.ts", "tests/repair.test.ts"],
];

// TYPES-ONLY: a mechanical type error anywhere eligible. The predicate is the whole-repo
// tsc, so the file only has to be one tsc reaches — which `tsconfig.json` include makes
// true of every file below.
const TYPES_ONLY = [
  ["tyselret", "src/selection.ts"],
  ["tyselarg", "src/selection.ts"],
  ["tycsvrow", "src/models-csv.ts"],
  ["tylmsopt", "src/lms.ts"],
  ["tylmsnull", "src/lms.ts"],
  ["typarseblk", "src/parse.ts"],
  ["tymemrec", "src/memory.ts"],
  ["tycfgfield", "src/config.ts"],
  ["tycfgdefault", "src/config.ts"],
  ["tychkspec", "src/checks/config.ts"],
  ["tychkparse", "src/checks/parsers.ts"],
  ["tychkfail", "src/checks/parsers.ts"],
  ["tycmdblock", "src/claude-md.ts"],
  ["tyfspath", "src/fs-safety.ts"],
  ["tyfscap", "src/fs-safety.ts"],
  ["typrobetier", "src/contract-probe.ts"],
  ["tyclientbody", "src/llm-client.ts"],
  ["tyclientfetch", "src/llm-client.ts"],
  ["tycorpusrow", "src/corpus.ts"],
  ["tydiffstat", "src/diff.ts"],
  ["tyexecopts", "src/exec.ts"],
  ["tyserverreg", "src/server.ts"],
  ["tysharedres", "src/tools/shared.ts"],
  ["tysharedcap", "src/tools/shared.ts"],
  ["tygatereport", "src/tools/gate.ts"],
  ["tyrepairdiff", "src/tools/repair.ts"],
  ["tyscafspec", "src/tools/scaffold.ts"],
  ["tystatusout", "src/tools/status.ts"],
  ["tymodelsarg", "src/tools/models.ts"],
  ["tyfixarg", "src/tools/fix.ts"],
];

/**
 * Does `suite` reach `target` by following relative imports? BFS over the source text,
 * rewriting the `.js` specifier TypeScript writes back to the `.ts` on disk. Deliberately
 * static and deliberately shallow about dynamic imports: it can only produce a FALSE
 * NEGATIVE, which refuses a pairing that might have worked, and never a false positive,
 * which would ship one that cannot.
 */
function reaches(suite, target) {
  const seen = new Set();
  const queue = [suite];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (rel === target) return true;
    let text;
    try {
      text = fs.readFileSync(path.join(REPO, rel), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const spec = m[1].replace(/\.js$/, ".ts");
      const abs = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      queue.push(abs);
    }
  }
  return false;
}

/** Every constraint, as a list of problems. Empty means the design holds. */
function constraintProblems(tasks, manifestA, manifestB) {
  const problems = [];
  const ids = tasks.map((t) => t.id);
  if (new Set(ids).size !== ids.length) problems.push("duplicate task ids");
  if (tasks.length !== 60) problems.push(`${tasks.length} tasks, not 60`);
  if (manifestA.length !== 30) problems.push(`manifestA has ${manifestA.length}, not 30`);
  if (manifestB.length !== 30) problems.push(`manifestB has ${manifestB.length}, not 30`);
  const inter = manifestA.filter((id) => manifestB.includes(id));
  if (inter.length > 0) problems.push(`A n B is not empty: ${inter.join(", ")}`);
  for (const p of PILOT) if (ids.includes(p)) problems.push(`pilot id ${p} also in a sealed manifest`);
  const PROTECTED = ["src/cost/", "src/telemetry.ts", "scripts/b12-run.mjs", "evidence/", "PREMISES.md", "ROADMAP.md", "DECISIONS.md", "STATE.md", "scripts/session-token-walk.mjs"];
  for (const t of tasks) {
    for (const f of t.fileScope) {
      if (PROTECTED.some((p) => f === p || f.startsWith(p))) problems.push(`${t.id}: fileScope ${f} is protected`);
      if (!fs.existsSync(path.join(REPO, f))) problems.push(`${t.id}: ${f} does not exist`);
    }
    if (t.verificationStratum === "test-red") {
      const suite = t.predicateArgv[3];
      if (!fs.existsSync(path.join(REPO, suite))) problems.push(`${t.id}: suite ${suite} does not exist`);
      // THE CHECK THAT WAS MISSING, and adversarial review found two pairings it would
      // have caught: `src/checks/config.ts` was paired with `tests/config.test.ts`, which
      // imports `src/config.js` and never reaches it. A defect there leaves the suite
      // GREEN, so the base is not red at its own predicate and the author refuses it —
      // after the patch is written. Existence on disk was never the property that mattered.
      else if (!reaches(suite, t.fileScope[0])) {
        problems.push(`${t.id}: ${suite} does not import ${t.fileScope[0]}, transitively or otherwise — a defect there would leave it green`);
      }
    }
  }
  for (const [name, list] of [["A", manifestA], ["B", manifestB]]) {
    for (const stratum of ["test-red", "types-only"]) {
      const n = list.filter((id) => tasks.find((t) => t.id === id).verificationStratum === stratum).length;
      if (n < 5) problems.push(`manifest ${name} has ${n} ${stratum} DECLARED, under the floor of 5`);
      // The floor that actually decides is over ADMITTED observations, and admission walks
      // the committed order and stops at 20. Checking only the declared count is what let
      // the first draft ship an order with five types-only in the scored window.
      const inFirst20 = list.slice(0, 20).filter((id) => tasks.find((t) => t.id === id).verificationStratum === stratum).length;
      if (inFirst20 < 8) {
        problems.push(
          `manifest ${name}: only ${inFirst20} ${stratum} sit inside the first 20 of the committed order — admissionRule 2 scores that window and admissionRule 8 makes a stratum under 5 ADMITTED unevaluable, so this leaves ${inFirst20 - 5} drops of margin`
        );
      }
    }
  }
  return problems;
}

/** The plan object. Throws rather than exiting, so a test can run it. */
export function buildPlan() {
  const pilotPlan = JSON.parse(fs.readFileSync(path.join(REPO, "b12-corpus", "pilot-plan.json"), "utf8"));
  const ratesSha256 = pilotPlan.ratesSha256;
  if (typeof ratesSha256 !== "string" || ratesSha256.length !== 64) {
    throw new Error("REFUSING — pilot-plan.json carries no usable ratesSha256 to inherit");
  }
  // The green parent, read off an ALREADY AUTHORED pilot spec and cross-checked against the
  // rest of them: five specs disagreeing here is the one shape that would put two parents
  // into the corpus without any single file looking wrong.
  const pilotParents = new Set(
    pilotPlan.tasks.map((t) => JSON.parse(fs.readFileSync(path.join(REPO, t.specDir, "spec.json"), "utf8")).parent)
  );
  if (pilotParents.size !== 1) {
    throw new Error(`REFUSING — the pilot specs already name ${pilotParents.size} different parents: ${[...pilotParents].join(", ")}`);
  }
  const parent = [...pilotParents][0];

  const tasks = [];
  for (const [slug, file, suite] of TEST_RED) {
    tasks.push({
      id: slug,
      // `verify-corpus` reads {id, specDir} and nothing else off a plan
      // (b12-author.mjs:619, :642), so a plan without these is a design document the
      // verifier cannot open.
      specDir: `b12-corpus/${slug}`,
      fileScope: [file],
      verificationStratum: "test-red",
      predicateArgv: ["npx", "vitest", "run", suite],
      gateCategory: "test",
      verificationCommands: [`npx vitest run ${suite}`],
    });
  }
  for (const [slug, file] of TYPES_ONLY) {
    tasks.push({
      id: slug,
      specDir: `b12-corpus/${slug}`,
      fileScope: [file],
      verificationStratum: "types-only",
      predicateArgv: ["npx", "tsc", "-p", "tsconfig.json", "--noEmit"],
      gateCategory: "types",
      verificationCommands: ["npx tsc -p tsconfig.json --noEmit"],
    });
  }

  // Deal into A and B by alternating WITHIN each stratum, so both manifests get the same
  // stratum mix and the same file spread rather than one taking all the selection.ts work.
  const dealt = { manifestA: { "test-red": [], "types-only": [] }, manifestB: { "test-red": [], "types-only": [] } };
  for (const stratum of ["test-red", "types-only"]) {
    const of = tasks.filter((t) => t.verificationStratum === stratum);
    of.forEach((t, i) => dealt[i % 2 === 0 ? "manifestA" : "manifestB"][stratum].push(t.id));
  }

  // THE COMMITTED ORDER IS LOAD-BEARING AND THE FIRST DRAFT GOT IT WRONG. `admissionRule` 2
  // scores "the first 20 that admit, in that committed order", and `admissionRule` 8 makes a
  // stratum with fewer than 5 ADMITTED observations `unevaluable`. Listing all 15 test-red
  // before all 15 types-only put exactly 5 types-only inside the first 20 — one drop and that
  // stratum is unevaluable, from an ordering nobody chose for a reason. The assembler's own
  // floor could not catch it: it counts DECLARED tasks, 15 and 15, which passes.
  //
  // Interleaved, the first 20 hold 10 and 10, so the types-only stratum survives five drops
  // before it is in danger instead of none. Alternating is also the only order here that is
  // not a preference: any other would be a claim about which stratum deserves the headroom.
  const interleave = (a, b) => {
    const out = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i < a.length) out.push(a[i]);
      if (i < b.length) out.push(b[i]);
    }
    return out;
  };
  const manifestA = interleave(dealt.manifestA["test-red"], dealt.manifestA["types-only"]);
  const manifestB = interleave(dealt.manifestB["test-red"], dealt.manifestB["types-only"]);
  // Subagent stratum: declared, not observed. Every task here is a single-file mechanical
  // repair, so `solo` is the honest expectation; nothing in the design requires a `multi`
  // declaration and inventing one would be a claim about behaviour nobody has measured.
  for (const t of tasks) t.expectedSubagentStratum = "solo";

  const problems = constraintProblems(tasks, manifestA, manifestB);
  if (problems.length > 0) {
    throw new Error(`REFUSING — the plan violates its own constraints:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  return {
    _readme: [
      "THE 60 SEALED-MANIFEST TASKS. The five pilot ids are excluded by design.artifacts 4 and",
      "live in pilot-plan.json. Generated and constraint-checked, not hand-listed: A n B empty,",
      "30 each, >=5 per verificationStratum DECLARED per manifest AND >=8 inside the first 20",
      "of the committed order, no fileScope inside PROTECTED_SCOPES, one shared green parent,",
      "every named file present, and every test-red suite shown to REACH its scoped file by",
      "following imports — existence on disk was never the property that mattered.",
      "",
      "DEFECT KIND follows task-mix decision 1, the favourable-but-real set: mechanical type",
      "errors and failing assertions with bulky output, which is where delegation plausibly",
      "pays. Nothing subtle, nothing that needs judgement about intent.",
      "",
      "A and B get the same STRATUM mix, 15/15, and deliberately not the same file spread:",
      "dealing alternately within a stratum splits the files across the manifests rather than",
      "duplicating them, so A carries the src/corpus.ts and src/exec.ts work while B carries",
      "src/diff.ts, src/tools/status.ts and src/tools/fix.ts.",
    ],
    _multiCellGap: [
      "THE ONE THING IN THIS PLAN THAT ONLY MONEY CAN SETTLE, named rather than papered over.",
      "holdsIf 3 requires ALL FOUR declared strata evaluable at >=5 ADMITTED observations, and",
      "it names solo/multi among them. Those two cells are populated by OBSERVED sidechain",
      "requests — strata.ts:47, `sidechain === 0 ? solo : multi` — never by this file's",
      "expectedSubagentStratum, which is only validated against an enum.",
      "",
      "If fewer than five paid observations come back multi, that cell is unevaluable and the",
      "verdict is `open` however well the other three do.",
      "",
      "MEASURED 2026-08-13 (MEASUREMENTS.jsonl, sessions_carrying_any_sidechain_request): ZERO",
      "of 162 sessions on the authoring machine carry a sidechain record. Not a missing field —",
      "isSidechain is present on 144,711 of 174,041 records and true on none. That establishes",
      "the operator's own style produces no subagents; it does NOT bound the corpus, and a",
      "first draft of this note said it did.",
      "",
      "WHY IT DOES NOT: B12's treatment arm has a subagent source an interactive session does",
      "not. PREMISES.md records, from a real run, that THE ARM THAT CARRIES SUBAGENTS IS THE",
      "ARM THAT CALLS repair (n = 1, mac-01). So the lever is the TOOL PATH, not the task's",
      "shape, and an earlier version of this note had that backwards — it proposed authoring",
      "closed-unit tasks to raise the rate. That may still be worth doing for task-mix decision",
      "4, which declares two strata by task SIZE and of which this plan implements only the",
      "short-mechanical half, but it is not the lever on this cell.",
      "",
      "THE PILOT IS THE INSTRUMENT AND IT WILL ANSWER: PILOT_COVARIATE_TABLE[0] records",
      "'subagent share, continuous and solo/multi', derived from record.lineage's sidechain",
      "flags and published raw (b12-run.mjs:2212). Read it off the treatment arm before sealing",
      "these 60. Five observations cannot estimate a rate, but 0 of 5 and 5 of 5 are different",
      "answers and both are decisive enough to act on.",
    ],
    specRoot: "b12-corpus",
    // Taken from pilot-plan.json rather than recomputed: these 60 hang off the SAME green
    // parent as the five pilot bases, so the frozen rates blob is the same blob, and two
    // places computing it independently is two places that can disagree.
    ratesSha256,
    // ONE GREEN PARENT, RECORDED HERE BECAUSE THE ASSEMBLER REFUSES TWO. `assemblyRefusals`
    // rejects a corpus whose specs name more than one (`scripts/b12-manifest.mjs:539`), and
    // the first version of this plan did not carry the parent at all — the writer hardcoded
    // it, so the constraint lived in a scratch script instead of in the artifact the specs
    // are generated from. Read off an authored pilot spec, so it cannot drift from the five
    // bases already published.
    parent,
    manifestA,
    manifestB,
    tasks,
  };
}

/** The exact bytes the artifact should hold. */
export function planText() {
  return JSON.stringify(buildPlan(), null, 2) + "\n";
}

/** null when the committed artifact equals generator output, else why it does not. */
export function planDrift() {
  const want = planText();
  if (!fs.existsSync(OUT)) return `${path.relative(REPO, OUT)} does not exist`;
  const have = fs.readFileSync(OUT, "utf8");
  if (have === want) return null;
  const h = have.split("\n");
  const w = want.split("\n");
  const at = h.findIndex((line, i) => line !== w[i]);
  return (
    `b12-corpus/corpus-plan.json is NOT generator output — ${have.length} bytes on disk against ${want.length} generated, ` +
    `first difference at line ${at + 1}:\n  on disk:   ${JSON.stringify(h[at] ?? null)}\n  generated: ${JSON.stringify(w[at] ?? null)}`
  );
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === "check") {
    const drift = planDrift();
    if (drift !== null) {
      process.stderr.write(`b12-plan: ${drift}\n`);
      process.exit(1);
    }
    process.stdout.write("b12-plan: b12-corpus/corpus-plan.json is exactly what this generator emits\n");
    return;
  }
  if (cmd !== "write") {
    process.stderr.write(`b12-plan: unknown subcommand ${JSON.stringify(cmd ?? null)} — check | write\n`);
    process.exit(1);
  }
  const plan = buildPlan();
  fs.writeFileSync(OUT, JSON.stringify(plan, null, 2) + "\n", "utf8");
  process.stdout.write(`wrote ${path.relative(REPO, OUT)}\n`);
  process.stdout.write(`  ${plan.tasks.length} tasks: ${TEST_RED.length} test-red, ${TYPES_ONLY.length} types-only\n`);
  for (const name of ["manifestA", "manifestB"]) {
    const red = plan[name].filter((id) => plan.tasks.find((t) => t.id === id).verificationStratum === "test-red").length;
    process.stdout.write(`  ${name}: ${plan[name].length}  (${red} test-red)\n`);
  }
  process.stdout.write(`  distinct files touched: ${new Set(plan.tasks.flatMap((t) => t.fileScope)).size}\n`);
}

// The guard every sibling in this directory carries. Without it, importing this module to
// reuse `reaches()` or either table would rewrite a committed artifact as a side effect —
// and the scratch copy this replaces wrote the file at top level.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
