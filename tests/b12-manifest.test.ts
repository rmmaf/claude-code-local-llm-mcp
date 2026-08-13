/**
 * ORACLE FOR THE MANIFEST ASSEMBLER.
 *
 * WHAT THIS FILE IS AND IS NOT ABOUT. It tests the ASSEMBLER — the derivations,
 * the refusals and the bytes. It does NOT re-test whether the published corpus
 * is sound: that is `corpusVerification`'s job and `b12-corpus-refs.test.ts`
 * already fires every one of its checks. So the bases here are minted cheaply
 * with `commit-tree` instead of authored, because what `deriveTask` reads is the
 * TAG and the SPEC, and paying 1.2 s per `authorSibling` sixty-five times would
 * buy this file nothing it does not already have. The CLI composes both.
 *
 * TWO TESTS DECIDE QUESTIONS RATHER THAN ASSERT BELIEFS, which is the reason
 * they exist at all:
 *
 *   - TWO-ROUTE ACCEPTANCE runs the emitted string through the exact call shape
 *     of `b12-run.mjs:2943-2947` and compares the exit code with the argv the
 *     author verified. That is the test that catches the measured always-accept.
 *   - THE STRATUM CONFORMANCE test reads the union out of `src/cost/b12/types.ts`
 *     and compares it with what the assembler enforces, so the enum cannot drift
 *     out from under a manifest the way a hand-copied list would.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  argvGrammarReasons,
  assembleManifests,
  assemblyRefusals,
  deriveTask,
  frozenScoringFacts,
  manifestBytes,
  outputPaths,
  parseManifestConfig,
  TASK_KEY_ORDER,
} from "../scripts/b12-manifest.mjs";
import { hashMemoryDir, manifestDeclarationGaps } from "../scripts/b12-run.mjs";
import { makeTempRoot, removeTempRoot } from "./helpers.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = makeTempRoot("b12-manifest-test-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    await removeTempRoot(root);
  }
});

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr ?? ""}`);
  return (r.stdout ?? "").trim();
}

function initRepo(root: string): void {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "manifest-oracle"]);
  git(root, ["config", "user.email", "manifest@example.invalid"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "tag.gpgSign", "false"]);
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** A predicate that survives the join/split round trip — space-free argv, no shell metacharacters. */
const GOOD_ARGV = ["node", "--test", "tests/example.test.js"];

interface TaskOver {
  argv?: string[];
  verificationStratum?: string;
  expectedSubagentStratum?: string;
  manifestExtra?: Record<string, unknown>;
  parent?: string;
  prompt?: string;
}

/**
 * One spec directory plus one tagged base. The base is minted with
 * `commit-tree` over the parent's own tree: distinct object, same content. This
 * oracle never asks whether it carries a defect — `corpusVerification` does, and
 * has its own tests.
 */
async function makeTask(root: string, parent: string, taskId: string, over: TaskOver = {}): Promise<void> {
  const dir = path.join(root, "b12-corpus", taskId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "defect.patch"), `--- a/src/${taskId}.js\n+++ b/src/${taskId}.js\n@@ -1 +1 @@\n-a\n+b\n`, "utf8");
  await fs.writeFile(path.join(dir, "prompt.md"), over.prompt ?? `Fix ${taskId}.\n`, "utf8");
  await fs.writeFile(
    path.join(dir, "spec.json"),
    JSON.stringify({
      taskId,
      parent: over.parent ?? parent,
      message: `task ${taskId}`,
      fileScope: [`src/${taskId}.js`],
      patch: "defect.patch",
      predicate: { argv: over.argv ?? GOOD_ARGV, expectedExit: 0, timeoutMs: 60_000 },
      manifest: {
        verificationStratum: over.verificationStratum ?? "test-red",
        expectedSubagentStratum: over.expectedSubagentStratum ?? "solo",
        verificationCommands: ["npx tsc --noEmit"],
        gateCategory: "types",
        repairMaxRounds: 3,
        ...(over.manifestExtra ?? {}),
      },
    }),
    "utf8"
  );
  const base = git(root, ["commit-tree", `${parent}^{tree}`, "-p", parent, "-m", `base ${taskId}`]);
  git(root, ["tag", "-a", "-m", `base for ${taskId}`, `b12/corpus/${taskId}`, base]);
}

/** The shared green parent. */
async function greenBase(root: string): Promise<string> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "example.js"), "exports.a = 1;\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "green base"]);
  return git(root, ["rev-parse", "HEAD"]);
}

/**
 * An out-of-repo policy repo, at an ABSOLUTE path. Absolute on purpose:
 * `findPolicyBlob` resolves a relative `repo` against `process.cwd()` rather
 * than against the root under test, so a relative one would answer about this
 * repository instead of the fixture.
 */
async function policyRepo(name: string): Promise<{ repo: string; commit: string; path: string; sha256: string }> {
  const root = tempRoot();
  initRepo(root);
  const body = `# ${name} policy\n`;
  await fs.writeFile(path.join(root, "POLICY.md"), body, "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "policy"]);
  return { repo: root, commit: git(root, ["rev-parse", "HEAD"]), path: "POLICY.md", sha256: sha256(body) };
}

/**
 * A REAL memory snapshot directory, with its REAL hash. Not a placeholder: the
 * assembler requires `memorySnapshotSha256` and compares it against
 * `hashMemoryDir(dir).sha256`, and both halves of that used to be wrong —
 * compared-if-present, and compared against the whole object. A fixture with a
 * null hash exercised neither.
 */
async function memorySnapshotIn(root: string): Promise<string> {
  const dir = path.join(root, ".b12-memory");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "MEMORY.md"), "# memory\n", "utf8");
  return hashMemoryDir(dir).sha256;
}

async function pinnedFor(memoryHash: string): Promise<Record<string, unknown>> {
  return {
    claudeCodeVersion: "2.1.221",
    claudeBinarySha256: "a".repeat(64),
    ratesSha256: "b".repeat(64),
    clientTruncationCap: 25_000,
    pacingCacheWriteShareCeiling: 0.5,
    perTaskDenominatorShareCap: 0.4,
    // A TEMPLATE. The assembler resolves `<runId>` per manifest, and refuses a
    // literal — which is what this fixture used to carry, naming a script that
    // has never existed.
    scoringCommand: "node dist/cost/b12/emit.js <runId> --audit evidence/<runId>.b12.audit.json",
    perArmTimeoutMs: 2_700_000,
    extraArgs: [],
    b12RunSha256: "c".repeat(64),
    claudeMdSha256: "d".repeat(64),
    settingsSha256s: { settings: "e".repeat(64), settingsLocal: null },
    installedCharsProbe: "evidence/probe.json",
    installedCharsProbeSha256: "f".repeat(64),
    mcpConfig: "/Users/x/.b12/mcp.json",
    mcpConfigSha256: "0".repeat(64),
    // These two are read by `observe` and required by NO frozen validator, so
    // the assembler is the only thing that asks for them. The fixture carries
    // them for the same reason the config does: a manifest without
    // `memorySnapshot` passes every build-time check and then refuses on the run
    // machine, and a manifest without `captureSha256` skips the dist comparison
    // in silence.
    memorySnapshot: ".b12-memory",
    memorySnapshotSha256: memoryHash,
    captureSha256: "9".repeat(64),
    policyBlobs: { treatment: await policyRepo("treatment"), control: await policyRepo("control") },
  };
}

const ids = (prefix: string, n: number, from = 1): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i + from).padStart(2, "0")}`);

interface ConfigOver {
  manifestA?: string[];
  manifestB?: string[];
  pilot?: string[];
  runIdB?: string;
  /** Omitted keeps the template; `null` deletes the key outright. */
  scoringCommand?: string | null;
}

/** A full 30/30/5 corpus and the config that assembles it. */
async function fullCorpus(root: string, over: ConfigOver = {}): Promise<{ configPath: string }> {
  initRepo(root);
  const parent = await greenBase(root);
  const A = over.manifestA ?? ids("a", 30);
  const B = over.manifestB ?? ids("b", 30);
  const P = over.pilot ?? ids("p", 5);
  for (const id of [...new Set([...A, ...B, ...P])]) await makeTask(root, parent, id);
  const configPath = path.join(root, "b12-corpus", "manifest-config.json");
  const pinned = await pinnedFor(await memorySnapshotIn(root));
  if (over.scoringCommand === null) delete pinned.scoringCommand;
  else if (over.scoringCommand !== undefined) pinned.scoringCommand = over.scoringCommand;
  await fs.writeFile(
    configPath,
    JSON.stringify({
      specRoot: "b12-corpus",
      runIdA: "run-a",
      runIdB: over.runIdB ?? "run-b",
      pilotRunId: "run-pilot",
      manifestA: A,
      manifestB: B,
      pilot: P,
      abPairsA: A.slice(0, 6).map((taskId, i) => ({ id: `pa${i}`, taskId, order: i % 2 === 0 ? "treatment-first" : "control-first" })),
      abPairsB: B.slice(0, 3).map((taskId, i) => ({ id: `pb${i}`, taskId, order: i % 2 === 0 ? "control-first" : "treatment-first" })),
      pinned,
    }),
    "utf8"
  );
  return { configPath };
}

function okOf<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}
/** `assembleManifests` refuses with `reasons`, not the `why` `whyOf` reads. */
function reasonsOf(r: { ok: boolean }): string {
  if (r.ok) throw new Error("expected a refusal; the call succeeded");
  return ((r as { reasons?: string[] }).reasons ?? []).join(" | ");
}
function whyOf<T extends { ok: boolean }>(r: T): string {
  if (r.ok) throw new Error("expected a refusal; the call succeeded");
  const bad = r as unknown as { why?: string; reasons?: string[] };
  return bad.why ?? (bad.reasons ?? []).join(" | ");
}

const FACTS = { verificationStrata: ["test-red", "types-only"], subagentStrata: ["solo", "multi"], minDeliveryObservations: 5 };

describe("b12 manifest — the assembler derives what a hand-written manifest would only claim", () => {
  it("REFUSES an A n B intersection, and the disjoint control assembles", async () => {
    const root = tempRoot();
    // The seventh owner decision, and the only rule this tool enforces that no
    // validator downstream would ever notice.
    const shared = await fullCorpus(root, { manifestA: ids("a", 30), manifestB: [...ids("a", 5), ...ids("b", 25)] });
    expect(whyOf(parseManifestConfig(root, shared.configPath))).toMatch(/SEVENTH owner decision/);

    const clean = tempRoot();
    const good = await fullCorpus(clean);
    expect(okOf(parseManifestConfig(clean, good.configPath)).config.manifestA).toHaveLength(30);
    // TWICE ITS SIBLINGS' BUDGET BECAUSE IT DOES TWICE THEIR WORK. Every other test here
    // builds ONE corpus; this one builds two — the overlapping pair above and the disjoint
    // control below it — at roughly 125 tasks and 250 git subprocesses between them. It
    // carried the copied 60 s anyway and was the only test still failing a full run after
    // the teardown and leak fixes, deterministically, in both of two consecutive runs
    // while passing in a three-file selection. The budget was inherited, not measured.
  }, 120_000);

  it("REFUSES a pilot id that also sits in a sealed manifest", async () => {
    const root = tempRoot();
    const c = await fullCorpus(root, { pilot: [...ids("a", 1), ...ids("p", 4)] });
    expect(whyOf(parseManifestConfig(root, c.configPath))).toMatch(/shares a01 with the pilot/);
  }, 60_000);

  it("REFUSES the two runs sharing one runId — run 2 is a registration, not a relabel", async () => {
    const root = tempRoot();
    const c = await fullCorpus(root, { runIdB: "run-a" });
    expect(whyOf(parseManifestConfig(root, c.configPath))).toMatch(/not a relabel/);
  }, 60_000);

  it("REFUSES a predicate that would silently always-accept, and the space-free control agrees on BOTH routes", async () => {
    // THE MEASURED HAZARD. `observe` runs `String(cmd).split(" ")` under
    // shell:true on Windows, so a quoted one-liner becomes a different command.
    expect(argvGrammarReasons("t1", ["node", "-e", '"process.exitCode=1"']).join(" ")).toMatch(/carries a quote/);
    expect(argvGrammarReasons("t1", ["node", "-e", "const a = 1; process.exitCode=a"]).join(" ")).toMatch(/whitespace/);
    expect(argvGrammarReasons("t1", [])).toHaveLength(1);
    expect(argvGrammarReasons("t1", GOOD_ARGV)).toEqual([]);

    // THE TWO ROUTES, RUN — the test that would have caught the always-accept.
    // `observe` executes an acceptance entry as
    // `Array.isArray(cmd) ? cmd : String(cmd).split(" ")` under
    // `shell: process.platform === "win32"` (b12-run.mjs:2943-2947).
    const asObserve = (entry: string, shell: boolean): number | null => {
      const [head = "", ...rest] = String(entry).split(" ");
      return spawnSync(head, rest, { encoding: "utf8", shell }).status;
    };
    const asAuthor = (argv: string[]): number | null => {
      const [head = "", ...rest] = argv;
      return spawnSync(head, rest, { encoding: "utf8" }).status;
    };

    // THE HAZARD IS WORSE THAN "IT RETURNS THE WRONG CODE": IT RETURNS A
    // DIFFERENT CODE ON EACH PLATFORM, and all three values below are measured
    // on this machine rather than argued. The shape is the one the repository's
    // own fixture carries — `replay-01.b12.tasks.json` holds
    // `node -e "process.exit(0)"`, quotes and all.
    //
    // Split on spaces the third argument is the LITERAL `"process.exit(3)"`.
    // With `shell:false` node evaluates it as a string expression and discards
    // it, exiting 0. With `shell:true` cmd.exe strips the quotes first, so node
    // runs the statement and exits 3. `observe` picks the mode by platform, so
    // ONE manifest scores two different ways — and the arm that decides is
    // macOS, which is where every session in this run happens.
    const quotedEntry = 'node -e "process.exit(3)"';
    expect(asAuthor(["node", "-e", "process.exit(3)"])).toBe(3);
    expect(asObserve(quotedEntry, false)).toBe(0); // macOS: a task nobody fixed, scored as fixed
    expect(asObserve(quotedEntry, true)).toBe(3); // Windows: right answer, wrong reason
    expect(argvGrammarReasons("t1", ["node", "-e", '"process.exit(3)"'])).not.toEqual([]);

    // THE CONFORMANT FORM, where all three routes are provably the same command:
    // no quotes, no metacharacters, no spaces inside any element, so join/split
    // is the identity. `process.exit(3)` would also work — measured — and is
    // still refused, because the parentheses tier is conservative rather than
    // measured and the refusal says so in those words.
    expect(argvGrammarReasons("t1", ["node", "-e", "process.exit(3)"]).join(" ")).toMatch(/CONSERVATIVE, not measured/);
    const conformant = ["node", "-e", "process.exitCode=3"];
    expect(argvGrammarReasons("t1", conformant)).toEqual([]);
    expect(asObserve(conformant.join(" "), false)).toBe(asAuthor(conformant));
    expect(asObserve(conformant.join(" "), true)).toBe(asAuthor(conformant));
  }, 30_000);

  it("takes baseCommit from the TAG, and an unpublished task cannot be assembled", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    await makeTask(root, parent, "t1");

    const derived = okOf(deriveTask(root, "b12-corpus", "t1", FACTS));
    expect(derived.task.baseCommit).toBe(git(root, ["rev-parse", "refs/tags/b12/corpus/t1^{commit}"]));
    expect(Object.keys(derived.task)).toEqual([...TASK_KEY_ORDER]);
    // promptSha256 is COMPUTED from prompt.md, never trusted.
    expect(derived.task.promptSha256).toBe(sha256(readFileSync(path.join(root, "b12-corpus", "t1", "prompt.md"), "utf8")));
    expect(derived.task.acceptance).toEqual([GOOD_ARGV.join(" ")]);

    // CONTROL: the same spec with its tag removed cannot be assembled at all.
    git(root, ["tag", "-d", "b12/corpus/t1"]);
    expect(whyOf(deriveTask(root, "b12-corpus", "t1", FACTS))).toMatch(/does not exist — the base commit is taken from the tag/);
  }, 30_000);

  it("REFUSES a spec that declares a DERIVED field rather than silently ignoring it", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    await makeTask(root, parent, "t1", { manifestExtra: { baseCommit: "f".repeat(40) } });
    expect(whyOf(deriveTask(root, "b12-corpus", "t1", FACTS))).toMatch(/declares baseCommit, which is DERIVED/);
  }, 30_000);

  it("holds verificationStratum to the union READ OUT of types.ts, and the union is what the scorer says", async () => {
    const repoRoot = process.cwd();
    const facts = okOf(frozenScoringFacts(repoRoot));
    // CONFORMANCE, not a restatement: the same anti-drift doctrine as the
    // filescope twin. If the scorer's union moves, this fails here rather than
    // after thirty paid sessions.
    const types = readFileSync(path.join(repoRoot, "src", "cost", "b12", "types.ts"), "utf8");
    expect(types).toContain(facts.verificationStrata.map((s) => `"${s}"`).join(" | "));
    expect(facts.minDeliveryObservations).toBeGreaterThanOrEqual(1);

    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    await makeTask(root, parent, "t1", { verificationStratum: "test_red" });
    expect(whyOf(deriveTask(root, "b12-corpus", "t1", facts))).toMatch(/non-evaluable/);

    // The subagent one is the assembler's OWN narrowing, and the refusal says so.
    const root2 = tempRoot();
    initRepo(root2);
    const parent2 = await greenBase(root2);
    await makeTask(root2, parent2, "t1", { expectedSubagentStratum: "single" });
    expect(whyOf(deriveTask(root2, "b12-corpus", "t1", facts))).toMatch(/FROZEN TEXT DOES NOT CLOSE THIS ONE/);
  }, 30_000);

  it("REFUSES a corpus hanging off two different green parents", async () => {
    const root = tempRoot();
    initRepo(root);
    const parent = await greenBase(root);
    await fs.writeFile(path.join(root, "src", "other.js"), "exports.b = 2;\n", "utf8");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "a second commit"]);
    const other = git(root, ["rev-parse", "HEAD"]);

    await makeTask(root, parent, "t1");
    await makeTask(root, parent, "t2", { parent: other });
    const config = {
      specRoot: "b12-corpus",
      manifestA: ["t1"],
      manifestB: ["t2"],
      pilot: ["t1"],
      runIdA: "x",
      runIdB: "y",
      pilotRunId: "z",
      abPairsA: [],
      abPairsB: [],
      pinned: {},
      configPath: "",
    };
    const built = assembleManifests(root, config as never);
    expect(whyOf(built)).toMatch(/different green parents/);
  }, 30_000);

  it("names the per-cell floor, and reads the number out of aggregate.ts", async () => {
    const root = tempRoot();
    const { configPath } = await fullCorpus(root);
    const config = okOf(parseManifestConfig(root, configPath)).config;
    // ONE task moved to the other stratum, by editing its spec in place — the
    // base and its tag are untouched, because the stratum is a manifest fact and
    // not a corpus one. 1 < MIN_DELIVERY_OBSERVATIONS, so that cell is void by
    // construction before a single session runs.
    const moved = config.manifestA[0];
    if (moved === undefined) throw new Error("the fixture built an empty manifest A");
    const specPath = path.join(root, "b12-corpus", moved, "spec.json");
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as { manifest: Record<string, unknown> };
    spec.manifest.verificationStratum = "types-only";
    await fs.writeFile(specPath, JSON.stringify(spec), "utf8");

    const built = okOf(assembleManifests(root, config));
    const red = assemblyRefusals(root, config, built);
    expect(red.join(" | ")).toMatch(/under the floor of 5/);
  }, 60_000);

  it("is GREEN end to end on 30/30/5 — checkCore empty, no declaration gaps, policy blobs reachable", async () => {
    const root = tempRoot();
    const { configPath } = await fullCorpus(root);
    const config = okOf(parseManifestConfig(root, configPath)).config;
    const built = okOf(assembleManifests(root, config));

    expect(built.manifestA.tasks).toHaveLength(30);
    expect(built.manifestB.tasks).toHaveLength(30);
    expect(built.pilots).toHaveLength(5);
    // Each pilot manifest carries ITS task at index 0: committedOrderViolation
    // runs unconditionally for treatment and the pilot writes no runlog row, so
    // nothing but index 0 can ever run.
    for (const p of built.pilots) {
      expect(p.manifest.tasks).toHaveLength(1);
      expect(p.manifest.tasks[0]?.id).toBe(p.taskId);
      // AND IT MUST SURVIVE THE FROZEN SWEEP ITSELF, not this tool's opinion of
      // it. `observe` runs `manifestDeclarationGaps` at b12-run.mjs:2540
      // UNCONDITIONALLY — before any pilotMode branch — so a pilot manifest that
      // fails it cannot run at all. An earlier draft emitted `abPairs: []` and
      // filtered the resulting gap inside the assembler: clean here, unrunnable
      // there. This assertion is against the frozen function, so the assembler
      // cannot talk its way past it again.
      expect(manifestDeclarationGaps(p.manifest)).toEqual([]);
      expect(p.manifest.abPairs.length).toBeGreaterThanOrEqual(3);
      expect(new Set(p.manifest.abPairs.map((q) => q.order)).size).toBe(2);
      for (const q of p.manifest.abPairs) expect(q.taskId).toBe(p.taskId);
    }

    // Joined rather than compared as an array: a failure here should print the
    // reasons, not "[ …(4) ] to deeply equal []".
    expect(assemblyRefusals(root, config, built).join("\n")).toBe("");
  }, 90_000);

  it("emits deterministic LF bytes, and the pilot names avoid the REGISTERED suffix", async () => {
    const one = tempRoot();
    const two = tempRoot();
    const a = await fullCorpus(one);
    const b = await fullCorpus(two);
    const builtA = okOf(assembleManifests(one, okOf(parseManifestConfig(one, a.configPath)).config));
    const builtB = okOf(assembleManifests(two, okOf(parseManifestConfig(two, b.configPath)).config));

    // Two scratch corpora carry different bases and different scratch policy
    // repo paths, so those two inputs are blanked and NOTHING ELSE is. What
    // remains is everything the assembler DERIVES, and it must be byte-equal.
    // Blanking more than that would make this a tautology.
    const blank = (m: { tasks: { baseCommit: string }[] }): string =>
      manifestBytes({ ...m, pinned: {}, tasks: m.tasks.map((t) => ({ ...t, baseCommit: "" })) });
    expect(blank(builtA.manifestA)).toBe(blank(builtB.manifestA));
    expect(manifestBytes(builtA.manifestA)).not.toMatch(/\r/);

    const paths = outputPaths(okOf(parseManifestConfig(one, a.configPath)).config);
    expect(paths.manifestA).toBe("evidence/run-a.b12.tasks.json");
    expect(paths.manifestB).toBe("evidence/run-a.b12.manifest-B.tasks.json");
    // NOT `.b12.tasks.json`: reconcileRegisterTraces reads that suffix as a
    // registered run, and five phantom registrations refuse every real one.
    for (const p of paths.pilots) expect(p.endsWith(".b12.tasks.json")).toBe(false);
    expect(paths.pilots).toHaveLength(5);
  }, 90_000);

  const scoringCommandFor = (runId: string): string =>
    `node dist/cost/b12/emit.js ${runId} --audit evidence/${runId}.b12.audit.json`;

  it("resolves pinned.scoringCommand per manifest — A from runIdA, B from runIdB, the pilots from pilotRunId", async () => {
    const root = tempRoot();
    const { configPath } = await fullCorpus(root);
    const config = okOf(parseManifestConfig(root, configPath)).config;
    const built = okOf(assembleManifests(root, config));

    // ASSERTED AFTER THE WHOLE ASSEMBLY, never one manifest at a time. All
    // seven are handed the SAME `config.pinned` object, so an implementation
    // that resolved by mutating it would satisfy a per-call check and leave
    // every earlier manifest carrying whichever id was resolved last — with
    // bytes that still look entirely plausible.
    expect(built.manifestA.pinned.scoringCommand).toBe(scoringCommandFor("run-a"));
    // runIdB, even though manifest B's sealed FILE is named from runIdA
    // (`outputPaths`): `open-b` copies those bytes to
    // evidence/<runIdB>.b12.tasks.json and run 2 is scored under runIdB, which
    // is the id `emit`'s argv will carry and clause 19 will compare.
    expect(built.manifestB.pinned.scoringCommand).toBe(scoringCommandFor("run-b"));
    for (const p of built.pilots) expect(p.manifest.pinned.scoringCommand).toBe(scoringCommandFor("run-pilot"));

    // Three distinct strings out of one declaration, and the declaration itself
    // unchanged — which is what makes the assembly repeatable.
    expect(config.pinned.scoringCommand).toBe(scoringCommandFor("<runId>"));
  }, 90_000);

  it("REFUSES a scoringCommand with no <runId> — the exact value that used to seal in silence", async () => {
    const root = tempRoot();
    // A literal that is RIGHT for the pilot and wrong for A and for B, which is
    // what the real config carried: `build` checks presence only
    // (b12-run.mjs:1065) and clause 19 does not fire until score time, after
    // every paid session has been spent.
    const { configPath } = await fullCorpus(root, { scoringCommand: scoringCommandFor("run-pilot") });
    const config = okOf(parseManifestConfig(root, configPath)).config;
    expect(reasonsOf(assembleManifests(root, config))).toMatch(/does not contain <runId>/);
  }, 90_000);

  it("REFUSES an absent scoringCommand rather than resolving nothing into six manifests", async () => {
    const root = tempRoot();
    const { configPath } = await fullCorpus(root, { scoringCommand: null });
    const config = okOf(parseManifestConfig(root, configPath)).config;
    expect(reasonsOf(assembleManifests(root, config))).toMatch(/absent, empty, or not a string/);
  }, 90_000);

  it("emits pilotRunId on A and B and on NEITHER of the five pilot manifests", async () => {
    const root = tempRoot();
    const { configPath } = await fullCorpus(root);
    const config = okOf(parseManifestConfig(root, configPath)).config;
    const built = okOf(assembleManifests(root, config));

    // The field exists so b12-register.mjs:627 and :740 stop resolving the
    // pilot as `manifestA?.pilotRunId ?? runId` — a fallback that fired for
    // every manifest this assembler had ever produced, sending the register to
    // look for the pilot record under the RUN's id.
    expect(built.manifestA.pilotRunId).toBe("run-pilot");
    expect(built.manifestB.pilotRunId).toBe("run-pilot");
    // Nothing reads it off a pilot manifest, where it would only restate runId.
    for (const p of built.pilots) expect("pilotRunId" in p.manifest).toBe(false);

    // AND THE FROZEN SWEEP MUST STILL ACCEPT THE EXTRA KEY. `observe` runs this
    // on the run machine (b12-run.mjs:2540) and a manifest it rejects cannot
    // run at all, so the assembler's opinion of the shape is not the one that
    // counts.
    expect(manifestDeclarationGaps(built.manifestA)).toEqual([]);
    expect(manifestDeclarationGaps(built.manifestB)).toEqual([]);
  }, 90_000);

  it("REFUSES a built manifest whose scoringCommand stopped matching its own runId", async () => {
    const root = tempRoot();
    const { configPath } = await fullCorpus(root);
    const config = okOf(parseManifestConfig(root, configPath)).config;
    const built = okOf(assembleManifests(root, config));
    expect(assemblyRefusals(root, config, built).join("\n")).toBe("");

    // THE FAILURE THIS EXISTS FOR, and it is one this change created. All seven
    // manifests used to share ONE pinned object and one string: they could be
    // wrong together, but they could not DISAGREE. They now carry independently
    // resolved strings, and nothing downstream tells a right difference from a
    // wrong one — manifestDeclarationGaps asks only for a non-empty string
    // (b12-run.mjs:1065) and registrationGuard proves byte identity, not that
    // the bytes are right. Clause 19 would, at score time, after the sessions.
    built.manifestA.pinned.scoringCommand = built.manifestB.pinned.scoringCommand;
    expect(assemblyRefusals(root, config, built).join("\n")).toMatch(
      /manifest A: pinned\.scoringCommand is .+ but its own runId resolves the template to/
    );
  }, 90_000);

  it("REFUSES manifests A and B naming different pilots", async () => {
    const root = tempRoot();
    const { configPath } = await fullCorpus(root);
    const config = okOf(parseManifestConfig(root, configPath)).config;
    const built = okOf(assembleManifests(root, config));

    // Only A's copy is ever read (b12-register.mjs:627, :740), so B's could
    // drift with nothing later noticing — and two manifests sealed in one act
    // disagreeing about which run preceded them is not a thing the record
    // should be able to say.
    built.manifestB.pilotRunId = "run-pilot-elsewhere";
    expect(assemblyRefusals(root, config, built).join("\n")).toMatch(/name different pilots/);
  }, 90_000);
});
