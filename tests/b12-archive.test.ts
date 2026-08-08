/**
 * ORACLE FOR UNIT 5's IMPURE THIRD — `src/cost/b12/archive.ts` over hostile
 * on-disk fixtures — plus the REPLAY over the committed fixture archive under
 * `tests/fixtures/b12-run/` (`design.artifacts` 11: the bracket, the
 * jackknives, `R_all`, `R_hi⁺`, the strata and every admission condition,
 * recomputed from the committed archive alone, through the REAL path
 * `readRunArchive → assembleRun → emitRun`).
 *
 * What the replay over a FIXTURE archive does not prove is recorded in
 * `FINDINGS.md` rather than claimed: no archive of a REAL run exists until one
 * runs, and this fixture is committed test material, never evidence.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectGitFacts,
  committedEvidenceState,
  earliestSessionStart,
  narrowObservationRecord,
  narrowRunlogRow,
  parseJsonl,
  parseObsDirName,
  parsePorcelain,
  readRunArchive,
  rebuildLineageTranscript,
  reconcileRegisterTraces,
  registrationRows,
  telemetryDrift,
} from "../src/cost/b12/archive.js";
import { assembleRun } from "../src/cost/b12/assemble.js";
import { committedAuditCheck, emitRun, invocationString, parseGitAudit } from "../src/cost/b12/emit.js";
import { reduceFile } from "../src/cost/b12/capture.js";
import { readTranscript } from "../src/cost/transcript.js";
import { makeScratch, req, at } from "./b12-fixtures.js";

const scratch = makeScratch();
afterEach(() => scratch.cleanup());

const FIXTURE = path.join(__dirname, "fixtures", "b12-run");

/** Copy the committed fixture archive into an isolated root, optionally break it. */
async function fixtureCopy(mutate?: (root: string) => Promise<void>): Promise<string> {
  const root = scratch.tempRoot();
  await fs.cp(FIXTURE, root, { recursive: true });
  if (mutate !== undefined) await mutate(root);
  return root;
}

const OBS = "evidence/replay-01/obs-t1-treatment";

describe("parseObsDirName — the harness's directory grammar, read back", () => {
  it("parses first attempts, re-runs, and taskIds that contain dashes", () => {
    expect(parseObsDirName("obs-t1-treatment")).toEqual({ taskId: "t1", arm: "treatment", attempt: 1 });
    expect(parseObsDirName("obs-fix-the-parser-control")).toEqual({
      taskId: "fix-the-parser",
      arm: "control",
      attempt: 1,
    });
    expect(parseObsDirName("obs-t1-treatment-r2")).toEqual({ taskId: "t1", arm: "treatment", attempt: 2 });
  });

  it("refuses what the harness never writes", () => {
    expect(parseObsDirName("obs-t1-treatment-r1")).toBeNull(); // a first attempt has no suffix
    expect(parseObsDirName("obs-t1-somethingelse")).toBeNull();
    expect(parseObsDirName("notes")).toBeNull();
    expect(parseObsDirName("obs--treatment")).toBeNull();
  });
});

describe("the pure readers", () => {
  it("parseJsonl counts corrupt lines instead of dying on them", () => {
    const { rows, corruptLines } = parseJsonl('{"a":1}\nnot json\n{"b":2}\n');
    expect(rows).toEqual([{ a: 1 }, { b: 2 }]);
    expect(corruptLines).toBe(1);
  });

  it("narrowObservationRecord keeps the control arm's NAMED absence as an absence", () => {
    const record = narrowObservationRecord({
      taskId: "t1",
      arm: "control",
      sessionId: "s",
      installedChars: { value: null, reason: "control arm — one O_o, never a defaulted number" },
    });
    expect(record?.installedChars).toEqual({ value: null, reason: "control arm — one O_o, never a defaulted number" });
    expect(narrowObservationRecord("not an object")).toBeNull();
  });

  it("narrowRunlogRow refuses a row missing its identity fields", () => {
    expect(narrowRunlogRow({ ts: at(0), runId: "r", taskId: "t", arm: "treatment" })).not.toBeNull();
    expect(narrowRunlogRow({ ts: at(0), runId: "r" })).toBeNull();
    expect(narrowRunlogRow(42)).toBeNull();
  });

  it("telemetryDrift catches a count mismatch and a content mismatch between the two copies", () => {
    expect(telemetryDrift([{ a: 1 }], [{ a: 1 }])).toBeNull();
    expect(telemetryDrift([{ a: 1 }], [])).toMatch(/1 row\(s\) while archive\.json holds 0/);
    expect(telemetryDrift([{ a: 1 }], [{ a: 2 }])).toMatch(/row 0 differs/);
    expect(telemetryDrift([], null)).toMatch(/no telemetry array/);
  });
});

describe("the register's pure core — the seventh adversarial round", () => {
  const entry = (type: "blob" | "tree", p: string): string =>
    `${type === "tree" ? "040000" : "100644"} ${type} ${"a".repeat(40)}\t${p}`;

  it("a run's surviving traces without a manifest are discrepancies, one per hidden run", () => {
    const { manifestIds, discrepancies } = reconcileRegisterTraces(
      [
        entry("blob", "evidence/reg-01.b12.tasks.json"),
        entry("blob", "evidence/reg-01.b12.runlog.jsonl"),
        entry("tree", "evidence/reg-01"),
        // a scrubbed manifest whose runlog and result survived the scrub
        entry("blob", "evidence/ghost-02.b12.runlog.jsonl"),
        entry("blob", "evidence/ghost-02.b12.result.json"),
        // a scrubbed manifest whose only survivor is the observation container
        entry("tree", "evidence/ghost-03"),
      ].join("\n"),
      "self-run"
    );
    expect([...manifestIds]).toEqual(["reg-01"]);
    expect(discrepancies).toHaveLength(2);
    expect(discrepancies[0]).toMatch(/ghost-02/);
    expect(discrepancies[0]).toMatch(/a committed runlog and a committed result/);
    expect(discrepancies[1]).toMatch(/ghost-03/);
    expect(discrepancies[1]).toMatch(/observation directory/);
    expect(discrepancies.join(" ")).toMatch(/cannot enumerate/);
  });

  it("another instrument's evidence and the current run's own traces are not ghosts", () => {
    // NEGATIVE CONTROL over the committed repository's real neighbours: the
    // preflight reports, scorer records, probes and telemetry that live in
    // evidence/ are decidedly not run containers, and the CURRENT run's
    // manifest committedness belongs to design.artifacts 1, not the register.
    const { manifestIds, discrepancies } = reconcileRegisterTraces(
      [
        entry("blob", "evidence/2026-08-06-mac-b12-2eab63d.preflight.json"),
        entry("blob", "evidence/2026-08-07-mac-b12-c40e9f4.scorer.json"),
        entry("blob", "evidence/2026-08-05-b12-preregistration.json"),
        entry("blob", "evidence/2026-08-03-mac-06.telemetry.jsonl"),
        entry("blob", "evidence/self-run.b12.runlog.jsonl"),
        entry("tree", "evidence/self-run"),
      ].join("\n"),
      "self-run"
    );
    expect(manifestIds.size).toBe(0);
    expect(discrepancies).toEqual([]);
  });

  it("row multiplicity is the log's lawful shape; only undecidable rows fire", () => {
    // The committed MEASUREMENTS.jsonl holds one row PER METRIC per measured
    // run — twenty-three under one id — so a repeated run_id must never fire:
    // registration is presence, not count.
    const lawful = registrationRows(
      [
        JSON.stringify({ run_id: "2026-08-02-win-01", metric: "a", value: 1 }),
        JSON.stringify({ run_id: "2026-08-02-win-01", metric: "b", value: 2 }),
        JSON.stringify({ premise: "a row of another shape, carrying no run_id at all" }),
      ].join("\n")
    );
    expect([...lawful.rowIds]).toEqual(["2026-08-02-win-01"]);
    expect(lawful.discrepancies).toEqual([]);

    const broken = registrationRows(
      ['{"run_id": "ok-1"}', '{"run_id": 42}', '"not an object"', '{"truncated'].join("\n")
    );
    expect([...broken.rowIds]).toEqual(["ok-1"]);
    expect(broken.discrepancies).toHaveLength(3);
    expect(broken.discrepancies.join(" ")).toMatch(/1 corrupt line/);
    expect(broken.discrepancies.join(" ")).toMatch(/not objects/);
    expect(broken.discrepancies.join(" ")).toMatch(/run_id is not a string/);
  });
});

describe("rebuildLineageTranscript — ONE parser rule, two feeders", () => {
  it("produces the SAME transcript the live parser reads from the same lines", async () => {
    const root = scratch.tempRoot();
    const lines = [
      // vendor noise the reduction strips — the meter's own fields survive it
      JSON.stringify({ ...JSON.parse(req("rq-1", 0, { write1h: 500 })), cwd: "/somewhere", version: "2.1.221" }),
      req("rq-2", 1_000, { write1h: 100, read: 50 }),
    ];
    const file = path.join(root, "sess.jsonl");
    await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");

    const live = await readTranscript(file, "sess-1");
    const { records, droppedLines } = reduceFile(lines.join("\n"));
    const rebuilt = rebuildLineageTranscript({
      sessionId: "sess-1",
      lineage: [{ sourcePath: file, sha256: "x", sessionId: "sess-1", requestIds: ["rq-1", "rq-2"], droppedLines, records }],
    });

    expect(rebuilt.problem).toBeNull();
    expect(rebuilt.transcript?.requests).toEqual(live.requests);
    expect(rebuilt.transcript?.toolResults).toEqual(live.toolResults);
    expect(rebuilt.transcript?.sessionId).toBe(live.sessionId);
  });

  it("an empty lineage is a reported fact, not a fabricated transcript", () => {
    const rebuilt = rebuildLineageTranscript({ sessionId: "s", lineage: [] });
    expect(rebuilt.transcript).toBeNull();
    expect(rebuilt.problem).toMatch(/empty/);
    expect(rebuildLineageTranscript({ lineage: "nope" }).problem).toMatch(/no lineage array/);
  });

  it("a JSON-valid non-object lineage record is dropped with a count, never a crash", () => {
    // The diff round's third finding: `null` is valid JSON, and dereferencing
    // it aborted the result artifact a registered run is owed. The parser's
    // own rule applies — an unparseable record is counted, never fatal.
    const rebuilt = rebuildLineageTranscript({
      sessionId: "sess-1",
      lineage: [
        {
          sourcePath: "/fake/sess-1.jsonl",
          sessionId: "sess-1",
          requestIds: ["rq-1"],
          droppedLines: 0,
          records: [null, 42, JSON.parse(req("rq-1", 0, { write1h: 100 }))],
        },
      ],
    });
    expect(rebuilt.problem).toMatch(/2 archived lineage record\(s\) are not objects/);
    expect(rebuilt.transcript?.requests).toHaveLength(1);
    expect(rebuilt.transcript?.skippedLines).toBe(2);
  });
});

describe("readRunArchive — the hostile disk", () => {
  it("reads the committed fixture whole: six files, identity keyed on the archive path", async () => {
    const root = await fixtureCopy();
    const archive = await readRunArchive(root, "replay-01");
    expect(archive.observations).toHaveLength(1);
    const obs = archive.observations[0]!;
    expect(obs.problems).toEqual([]);
    expect(obs.transcript?.requests).toHaveLength(1);
    expect(obs.identified).toEqual([]); // empty telemetry, no rows to identify
    expect(obs.telemetrySource.split(path.sep).join("/")).toBe(`${OBS}/telemetry.jsonl`);
    expect(archive.runlog.rows).toHaveLength(1);
    // git facts degrade to problems outside a repository — reported, not thrown
    expect(archive.git.manifestBlobSha256).toBeNull();
    expect(archive.git.problems.length).toBeGreaterThan(0);
  });

  it("a missing file, a malformed file, and a hash drift are each a named problem", async () => {
    const missing = await readRunArchive(
      await fixtureCopy((root) => fs.rm(path.join(root, OBS, "snapshot-after.json"))),
      "replay-01"
    );
    expect(missing.observations[0]!.problems.join(" ")).toMatch(/snapshot-after\.json is missing/);

    const malformed = await readRunArchive(
      await fixtureCopy((root) => fs.writeFile(path.join(root, OBS, "archive.json"), "{broken", "utf8")),
      "replay-01"
    );
    expect(malformed.observations[0]!.problems.join(" ")).toMatch(/archive\.json does not parse/);

    const drifted = await readRunArchive(
      await fixtureCopy((root) =>
        fs.writeFile(
          path.join(root, OBS, "telemetry.jsonl"),
          `${JSON.stringify({ ts: at(0), tool: "gate", bytes_raw: 1, bytes_returned: 1, turns_collapsed: 0, latency_ms: 1 })}\n`,
          "utf8"
        )
      ),
      "replay-01"
    );
    expect(drifted.observations[0]!.problems.join(" ")).toMatch(/telemetry\.jsonl holds 1 row/);
  });

  it("cross-wired identity is refused terms — copied evidence cannot borrow a directory's name", async () => {
    // The fifth diff round's first finding: the directory picks the manifest
    // task, so evidence naming another task, run or session must not price
    // anything under this directory's name.
    const crossTask = await readRunArchive(
      await fixtureCopy(async (root) => {
        const file = path.join(root, OBS, "observation.json");
        const parsed = JSON.parse(await fs.readFile(file, "utf8"));
        parsed.taskId = "t2";
        await fs.writeFile(file, JSON.stringify(parsed), "utf8");
      }),
      "replay-01"
    );
    expect(crossTask.observations[0]!.identityIntact).toBe(false);
    expect(crossTask.observations[0]!.problems.join(" ")).toMatch(
      /names t2\/treatment while the directory names t1\/treatment/
    );
    // end to end: an integrity failure with no terms, never a scored bracket
    const { result } = assembleRun({
      archive: crossTask,
      gitAudit: { ran: false },
      scoringCommandActual: "node dist/cost/b12/emit.js replay-01",
    });
    expect(result.integrityFailures).toHaveLength(1);
    expect(result.integrityFailures[0]!.reasons.join(" ")).toMatch(/cross-wired or unshowable/);
    expect(result.admitted).toBe(0);

    const crossRun = await readRunArchive(
      await fixtureCopy(async (root) => {
        const file = path.join(root, OBS, "observation.json");
        const parsed = JSON.parse(await fs.readFile(file, "utf8"));
        parsed.runId = "some-other-run";
        await fs.writeFile(file, JSON.stringify(parsed), "utf8");
      }),
      "replay-01"
    );
    expect(crossRun.observations[0]!.identityIntact).toBe(false);
    expect(crossRun.observations[0]!.problems.join(" ")).toMatch(
      /names run some-other-run while the archive is replay-01's/
    );

    const crossSession = await readRunArchive(
      await fixtureCopy(async (root) => {
        const file = path.join(root, OBS, "archive.json");
        const parsed = JSON.parse(await fs.readFile(file, "utf8"));
        parsed.sessionId = "sess-evil";
        await fs.writeFile(file, JSON.stringify(parsed), "utf8");
      }),
      "replay-01"
    );
    expect(crossSession.observations[0]!.identityIntact).toBe(false);
    expect(crossSession.observations[0]!.problems.join(" ")).toMatch(/seals session sess-evil/);
    // the negative control: the untouched fixture binds — asserted by the
    // committed-fixture test above via `problems: []`
  });

  it("an extra directory is reported and a missing runlog is reported", async () => {
    const extra = await readRunArchive(
      await fixtureCopy((root) => fs.mkdir(path.join(root, "evidence", "replay-01", "scratch-notes"))),
      "replay-01"
    );
    expect(extra.problems.join(" ")).toMatch(/scratch-notes is not an observation directory/);

    const noLog = await readRunArchive(
      await fixtureCopy((root) => fs.rm(path.join(root, "evidence", "replay-01.b12.runlog.jsonl"))),
      "replay-01"
    );
    expect(noLog.problems.join(" ")).toMatch(/runlog\.jsonl is absent/);
  });

  it("an unparseable manifest is the ONE throw — a bug, not a run outcome", async () => {
    const root = await fixtureCopy((r) =>
      fs.writeFile(path.join(r, "evidence", "replay-01.b12.tasks.json"), "{broken", "utf8")
    );
    await expect(readRunArchive(root, "replay-01")).rejects.toThrow();
  });

  it("collectGitFacts without a start timestamp FAILS CLOSED — null commits, not an empty list", () => {
    const facts = collectGitFacts(scratch.tempRoot(), "replay-01", null, null);
    expect(facts.problems.join(" ")).toMatch(/no earliest session start/);
    expect(facts.manifestCommitsAfterStart).toBeNull();
  });

  it("the freeze anchor is the earliest session START, never the runlog's end-of-observation ts", () => {
    // The fourth adversarial round: a manifest commit DURING a long session
    // carried a date before the runlog append and escaped the window. The
    // anchor must be the pre-execution minimum.
    const obs = {
      record: { started: "2023-11-14T22:13:20.000Z" },
      snapshotBefore: { ts: "2023-11-14T22:13:19.000Z" },
    } as never;
    const runlogRow = { ts: "2023-11-14T23:59:00.000Z" } as never; // appended an hour later
    expect(earliestSessionStart([obs], [runlogRow])).toBe("2023-11-14T22:13:19.000Z");
    // a commit at 22:30 is INSIDE this window; anchored on the runlog it was not
    expect(Date.parse("2023-11-14T22:30:00.000Z")).toBeGreaterThan(
      Date.parse(earliestSessionStart([obs], [runlogRow])!)
    );
    expect(earliestSessionStart([], [])).toBeNull();
    expect(earliestSessionStart([{ record: { started: "not a date" }, snapshotBefore: null } as never], [])).toBeNull();
  });

  it("committedness outside a repository is UNSHOWABLE — never clean — and porcelain parses every dirty shape", () => {
    expect(committedEvidenceState(scratch.tempRoot(), "replay-01").state).toBe("unshowable");
    expect(parsePorcelain("")).toEqual([]);
    expect(
      parsePorcelain(
        ' M evidence/r/obs-t1-treatment/telemetry.jsonl\n?? evidence/r/fabricated.json\nR  a.json -> evidence/r.b12.tasks.json\n'
      )
    ).toEqual([
      "evidence/r.b12.tasks.json",
      "evidence/r/fabricated.json",
      "evidence/r/obs-t1-treatment/telemetry.jsonl",
    ]);
  });

  it("a hostile null lineage record in the archive does not abort emission end to end", async () => {
    const root = await fixtureCopy(async (r) => {
      const file = path.join(r, OBS, "archive.json");
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      parsed.lineage[0].records.unshift(null);
      await fs.writeFile(file, JSON.stringify(parsed, null, 2), "utf8");
    });
    const emitted = await emitRun(root, "replay-01");
    expect(emitted.verdict).toBe("void"); // still a RESULT, never a crash
    const result = JSON.parse(await fs.readFile(emitted.resultPath, "utf8"));
    expect(result.archiveProblems.join(" ")).toMatch(/not objects/);
  });
});

describe("the replay — artifact 11 over the committed fixture archive, real path only", () => {
  it("recomputes the bracket, the jackknives, R_all, R_hi⁺, the strata and every admission condition", async () => {
    const root = await fixtureCopy();
    const archive = await readRunArchive(root, "replay-01");
    const { result, counterfactual } = assembleRun({
      archive,
      gitAudit: { ran: false },
      scoringCommandActual: "node dist/cost/b12/emit.js replay-01",
    });

    // Admission, replayed from the archive alone: one observation, scored,
    // admitted; the acceptance predicate, origination, pacing, version pin and
    // instruction hashes all hold — every predicate that fired is on the face.
    expect(counterfactual.observations).toHaveLength(1);
    const cf = counterfactual.observations[0]!;
    expect(cf.disposition).toBe("scored");
    expect(cf.firedPredicates).toEqual([]);
    expect(result.admitted).toBe(1);
    expect(result.declarationFailures).toEqual([]);
    expect(result.dispositions).toEqual([{ taskId: "t1", arm: "treatment", disposition: "scored" }]);

    // The bracket, BY HAND from the archived lineage: one 1,000-token 1h cache
    // write at 2.0x → A_o = 2,000; no telemetry → S = 0; O_o = 310.8 chars /
    // 3.7 × writeComponent(1h, T=1) = 84 × 2.0 = 168. R = (0−168)/2,000.
    expect(cf.aO).toBeCloseTo(2_000, 9);
    expect(cf.oO).toBeCloseTo(168, 9);
    expect(result.rLo).toBeCloseTo(-0.084, 12);
    expect(result.rHi).toBeCloseTo(-0.084, 12);
    expect(result.rHiPlus.evaluable).toBe(true);
    if (result.rHiPlus.evaluable) expect(result.rHiPlus.value).toBeCloseTo(-0.084, 12);
    expect(result.recomputations.rLoMinusTask).toBe(0); // the only task dropped → empty pool
    expect(result.recomputations.rAll).toBeCloseTo(-0.084, 12);
    expect(result.strata.testRed.evaluable).toBe(false); // 1 admitted < the floor of 5

    // The verdict machinery, on the face: the fixture is outside git, so
    // artifact 1's blob check fires FIRST and names the void; clause 8 fires
    // behind it until F23 lands; clauses 4–6 are UNCHECKED without an audit.
    expect(result.verdict).toBe("void");
    expect(result.voidClause).toMatch(/^design\.artifacts 1/);
    expect(result.archiveChecks.find((c) => c.clause.startsWith("voidConditions 8"))!.fired).toBe(true);
    // outside a repository committedness is UNSHOWABLE — fired, never clean —
    // while the terms above still published (the partial bracket is owed)
    const committed = result.archiveChecks.find((c) => c.clause.includes("committed evidence"))!;
    expect(committed.fired).toBe(true);
    expect(committed.detail).toMatch(/UNSHOWABLE/);
    // and the register cannot be enumerated outside a repository either —
    // fired for the same reason, with the discrepancies on the face
    expect(result.archiveChecks.find((c) => c.clause.includes("the register"))!.fired).toBe(true);
    expect(result.uncheckedClauses).toHaveLength(3);
    expect(result.scoringCommand).toEqual({
      pinned: "node dist/cost/b12/emit.js replay-01",
      actual: "node dist/cost/b12/emit.js replay-01",
    });
  });

  it("emitRun writes BOTH artifacts even though the run is a void", async () => {
    const root = await fixtureCopy();
    const emitted = await emitRun(root, "replay-01");
    expect(emitted.verdict).toBe("void");
    const result = JSON.parse(await fs.readFile(emitted.resultPath, "utf8"));
    const counterfactual = JSON.parse(await fs.readFile(emitted.counterfactualPath, "utf8"));
    expect(result.schema).toBe("b12-result/1");
    expect(counterfactual.schema).toBe("b12-counterfactual/1");
    // the Map serialises as an object, not as {}
    expect(typeof result.coverage.ownedBy).toBe("object");
  });
});

describe("the emitter's small pure pieces", () => {
  it("parseGitAudit refuses every shape that is not a replayable audit — inputs included", () => {
    expect(parseGitAudit({ ran: true, verdict: "clean", reasons: [], inputs: { head: "abc" } })).toEqual({
      ran: true,
      verdict: "clean",
      reasons: [],
      inputs: { head: "abc" },
    });
    expect(parseGitAudit({ ran: true, verdict: "maybe", reasons: [] })).toEqual({ ran: false });
    // a verdict whose inputs cannot be replayed is not an audit (artifact 11)
    expect(parseGitAudit({ ran: true, verdict: "clean", reasons: [] })).toEqual({ ran: false });
    expect(parseGitAudit({ ran: true, verdict: "clean", reasons: [], inputs: {} })).toEqual({ ran: false });
    expect(parseGitAudit({ verdict: "clean" })).toEqual({ ran: false });
    expect(parseGitAudit(null)).toEqual({ ran: false });
  });

  it("committedAuditCheck refuses the wrong path and the uncommitted file — a fabricated audit certifies nothing", async () => {
    const root = await fixtureCopy();
    const wrongPath = committedAuditCheck(root, "replay-01", path.join(root, "somewhere", "audit.json"));
    expect(wrongPath.ok).toBe(false);
    expect(wrongPath.why).toMatch(/must live at evidence\/replay-01\.b12\.audit\.json/);

    // the right path, but a working-tree fabrication — the fixture copy is
    // outside git, which is exactly what "not committed evidence" looks like
    const auditPath = path.join(root, "evidence", "replay-01.b12.audit.json");
    await fs.writeFile(auditPath, JSON.stringify({ ran: true, verdict: "clean", reasons: [], inputs: { head: "x" } }), "utf8");
    const fabricated = committedAuditCheck(root, "replay-01", auditPath);
    expect(fabricated.ok).toBe(false);
    expect(fabricated.why).toMatch(/not committed evidence/);

    // and end to end: emitRun with the fabricated audit still publishes
    // clauses 4–6 as UNCHECKED, with the refusal on the artifact's face
    const emitted = await emitRun(root, "replay-01", { auditPath });
    const result = JSON.parse(await fs.readFile(emitted.resultPath, "utf8"));
    expect(result.uncheckedClauses).toHaveLength(3);
    expect(result.gitAudit).toEqual({ ran: false });
    expect(result.archiveProblems.join(" ")).toMatch(/audit refused/);
  });

  it("invocationString spells the command one way on every platform", () => {
    const root = path.join("repo");
    const script = path.join("repo", "dist", "cost", "b12", "emit.js");
    expect(invocationString(root, script, ["replay-01"])).toBe("node dist/cost/b12/emit.js replay-01");
  });
});
