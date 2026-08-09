/**
 * ORACLE FOR THE CLAUSE 4–6 AUDIT COMPUTER — `src/cost/b12/audit.ts`.
 *
 * The decider is pure and every clause is shown FIRING and NOT firing over
 * constructed facts; the collector runs over DETERMINISTIC scratch git
 * repositories (local user.name/email, `core.autocrlf false`, no signing);
 * the e2e drives the operator loop's real sequence — emit (unchecked) →
 * commit → attestation → commit → audit → commit → emit `--audit` — over the
 * committed replay fixture, and then flips one hostile bit at a time.
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AUDIT_INPUT_KEYS,
  AuditRefused,
  attestationFromVitest,
  auditInputs,
  buildAuditArtifact,
  collectAuditFacts,
  CONFORMANCE_FILES,
  CONTROL_TESTS,
  decideAudit,
  type AuditFacts,
  type SuiteAttestation,
} from "../src/cost/b12/audit.js";
import { parseGitAudit } from "../src/cost/b12/emit.js";
import { emitRun } from "../src/cost/b12/emit.js";
import { at } from "./b12-fixtures.js";
import { makeTempRoot } from "./helpers.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = makeTempRoot("b12-audit-test-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The deterministic scratch repository.
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr ?? ""}`);
  }
  return (r.stdout ?? "").trim();
}

function initRepo(root: string): void {
  git(root, ["init", "-q"]);
  // DETERMINISTIC, and hermetic: no identity from the developer's config, no
  // CRLF rewriting to make one OS's blobs hash differently, no signing hook
  // to hang a CI run on.
  git(root, ["config", "user.name", "b12-audit-oracle"]);
  git(root, ["config", "user.email", "b12@example.invalid"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "commit.gpgsign", "false"]);
}

function commitAll(root: string, message: string): string {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "b12-run");

// ---------------------------------------------------------------------------
// Facts fixtures for the pure decider.
// ---------------------------------------------------------------------------

function attestationOf(subjectCommit: string, over: Partial<SuiteAttestation> = {}): SuiteAttestation {
  return {
    schema: "b12-suite/1",
    runId: "replay-01",
    subjectCommit,
    generatedAt: at(0),
    files: CONFORMANCE_FILES.map((file) => ({ file, total: 10, passed: 10, failed: 0, skipped: 0 })),
    tests: CONTROL_TESTS.map((fullName) => ({ file: "tests/cost-meter.test.ts", fullName, status: "passed" })),
    ...over,
  };
}

function factsOf(over: Partial<AuditFacts> = {}): AuditFacts {
  return {
    runId: "replay-01",
    head: "h".repeat(40),
    registrationCommit: "r".repeat(40),
    prereg: { frozenSha256: "p".repeat(64), headSha256: "p".repeat(64) },
    manifestA: { registrationSha256: "a".repeat(64), headSha256: "a".repeat(64) },
    manifestB: { registrationSha256: "b".repeat(64), headSha256: "b".repeat(64) },
    clause5: {
      anchor: { taskId: "t1", arm: "treatment", attempt: 1, started: at(0), commit: "c".repeat(40) },
      anchorProblems: [],
      commitsTouchingPinned: [],
      offenders: [],
      excusedByReemission: [],
    },
    clause6: {
      attestation: attestationOf("s".repeat(40)),
      attestationSha256: "t".repeat(64),
      subjectIsAncestor: true,
      nonEvidenceDrift: [],
    },
    toolSrcSha256: "u".repeat(64),
    ...over,
  };
}

describe("the pure decider — every clause firing and not firing", () => {
  it("is clean on the coherent default, with zero reasons", () => {
    const { verdict, reasons } = decideAudit(factsOf());
    expect(reasons).toEqual([]);
    expect(verdict).toBe("clean");
  });

  it("clause 4 fires on a missing registration, a drifted prereg, and each manifest failure", () => {
    expect(decideAudit(factsOf({ registrationCommit: null })).reasons.join(" ")).toMatch(/never committed/);
    expect(
      decideAudit(factsOf({ prereg: { frozenSha256: "p".repeat(64), headSha256: "q".repeat(64) } })).reasons.join(" ")
    ).toMatch(/drifted from its freeze-commit blob/);
    expect(
      decideAudit(factsOf({ prereg: { frozenSha256: null, headSha256: "p".repeat(64) } })).reasons.join(" ")
    ).toMatch(/unreadable at the freeze commit/);
    expect(
      decideAudit(factsOf({ manifestA: { registrationSha256: null, headSha256: "a".repeat(64) } })).reasons.join(" ")
    ).toMatch(/manifest A is not in the registration commit/);
    expect(
      decideAudit(factsOf({ manifestA: { registrationSha256: "a".repeat(64), headSha256: "z".repeat(64) } })).reasons.join(" ")
    ).toMatch(/manifest A at HEAD differs/);
    // The B manifest must be sealed IN THE SAME ACT — absent there is a void
    // even when HEAD carries one now.
    expect(
      decideAudit(factsOf({ manifestB: { registrationSha256: null, headSha256: "b".repeat(64) } })).reasons.join(" ")
    ).toMatch(/manifest B is ABSENT from the registration commit/);
  });

  it("clause 5 fires on an unexcused offender, stays quiet on an excused one, and is FREE with no anchor", () => {
    const offender = "f".repeat(40);
    const withOffender = factsOf({
      clause5: {
        anchor: { taskId: "t1", arm: "treatment", attempt: 1, started: at(0), commit: "c".repeat(40) },
        anchorProblems: [],
        commitsTouchingPinned: [{ sha: offender, committerDate: at(10) }],
        offenders: [offender],
        excusedByReemission: [],
      },
    });
    expect(decideAudit(withOffender).verdict).toBe("void");
    expect(decideAudit(withOffender).reasons.join(" ")).toMatch(/touched a pinned path after the first scored observation/);

    const excused = factsOf({
      clause5: { ...withOffender.clause5, excusedByReemission: [offender] },
    });
    expect(decideAudit(excused).verdict).toBe("clean");

    // No scored observation yet: the clause's own text leaves the sources
    // free, so even a would-be offender decides nothing.
    const free = factsOf({
      clause5: { ...withOffender.clause5, anchor: null, offenders: [offender] },
    });
    expect(decideAudit(free).verdict).toBe("clean");

    // But an anchor that could not be DERIVED is a void, never a freedom.
    const broken = factsOf({
      clause5: { ...withOffender.clause5, anchor: null, offenders: [], anchorProblems: ["2 runlog rows match t1/treatment"] },
    });
    expect(decideAudit(broken).verdict).toBe("void");
    expect(decideAudit(broken).reasons.join(" ")).toMatch(/clause 5: 2 runlog rows match/);
  });

  it("clause 6 fires on absence, a failing file, a skipped file, a missing control, and foreign drift", () => {
    expect(
      decideAudit(factsOf({ clause6: { attestation: null, attestationSha256: null, subjectIsAncestor: null, nonEvidenceDrift: [] } }))
        .reasons.join(" ")
    ).toMatch(/no committed suite attestation/);

    const s = "s".repeat(40);
    const failingFile = attestationOf(s, {
      files: [
        { file: CONFORMANCE_FILES[0], total: 10, passed: 9, failed: 1, skipped: 0 },
        { file: CONFORMANCE_FILES[1], total: 5, passed: 5, failed: 0, skipped: 0 },
      ],
    });
    expect(
      decideAudit(factsOf({ clause6: { attestation: failingFile, attestationSha256: "t".repeat(64), subjectIsAncestor: true, nonEvidenceDrift: [] } }))
        .reasons.join(" ")
    ).toMatch(/not FULLY passing/);

    // A skip is not a pass — the clause wants the suite PASSING, and a skipped
    // control reads as covered while covering nothing.
    const skippedFile = attestationOf(s, {
      files: [
        { file: CONFORMANCE_FILES[0], total: 10, passed: 9, failed: 0, skipped: 1 },
        { file: CONFORMANCE_FILES[1], total: 5, passed: 5, failed: 0, skipped: 0 },
      ],
    });
    expect(
      decideAudit(factsOf({ clause6: { attestation: skippedFile, attestationSha256: "t".repeat(64), subjectIsAncestor: true, nonEvidenceDrift: [] } }))
        .verdict
    ).toBe("void");

    const missingControl = attestationOf(s, {
      tests: CONTROL_TESTS.slice(1).map((fullName) => ({ file: "tests/cost-meter.test.ts", fullName, status: "passed" })),
    });
    expect(
      decideAudit(factsOf({ clause6: { attestation: missingControl, attestationSha256: "t".repeat(64), subjectIsAncestor: true, nonEvidenceDrift: [] } }))
        .reasons.join(" ")
    ).toMatch(/required control absent/);

    const failedControl = attestationOf(s, {
      tests: CONTROL_TESTS.map((fullName, i) => ({
        file: "tests/cost-meter.test.ts",
        fullName,
        status: i === 0 ? "failed" : "passed",
      })),
    });
    expect(
      decideAudit(factsOf({ clause6: { attestation: failedControl, attestationSha256: "t".repeat(64), subjectIsAncestor: true, nonEvidenceDrift: [] } }))
        .reasons.join(" ")
    ).toMatch(/required control not passing/);

    expect(
      decideAudit(
        factsOf({ clause6: { attestation: attestationOf(s), attestationSha256: "t".repeat(64), subjectIsAncestor: false, nonEvidenceDrift: [] } })
      ).reasons.join(" ")
    ).toMatch(/not an ancestor of HEAD/);

    expect(
      decideAudit(
        factsOf({ clause6: { attestation: attestationOf(s), attestationSha256: "t".repeat(64), subjectIsAncestor: true, nonEvidenceDrift: ["src/cost/report.ts"] } })
      ).reasons.join(" ")
    ).toMatch(/evidence\/\*\* only/);
  });
});

describe("the canonical inputs and the producer's own round trip", () => {
  it("emits EXACTLY the literal key set, on the clean facts and on the anchorless ones alike", () => {
    for (const facts of [factsOf(), factsOf({ clause5: { ...factsOf().clause5, anchor: null } })]) {
      const inputs = auditInputs(facts);
      expect(Object.keys(inputs).sort()).toEqual([...AUDIT_INPUT_KEYS].sort());
      for (const v of Object.values(inputs)) expect(typeof v).toBe("string");
    }
    // The lawful absence is a SENTINEL, never a dropped key — `parseGitAudit`
    // drops non-string values silently, and a dropped key is a replay hole.
    const anchorless = auditInputs(factsOf({ clause5: { ...factsOf().clause5, anchor: null } }));
    expect(anchorless["clause5.anchor.taskId"]).toBe("(none)");
  });

  it("buildAuditArtifact survives the CONSUMER's parse with the full key set", () => {
    const { artifact, parsed } = buildAuditArtifact(factsOf());
    expect(artifact.verdict).toBe("clean");
    expect(parsed.ran).toBe(true);
    if (parsed.ran) {
      expect(Object.keys(parsed.inputs).sort()).toEqual([...AUDIT_INPUT_KEYS].sort());
    }
    // And the artifact's own JSON round-trips through the emitter's parser —
    // the same call `emit --audit` will make.
    const reparsed = parseGitAudit(JSON.parse(JSON.stringify(artifact)));
    expect(reparsed.ran).toBe(true);
  });
});

describe("attestationFromVitest — the reporter payload, narrowed", () => {
  it("keeps fullName and status per test and counts per file, with windows paths normalized", () => {
    const payload = {
      testResults: [
        {
          name: "C:\\repo\\tests\\cost-meter.test.ts",
          assertionResults: [
            { fullName: "a b", status: "passed" },
            { fullName: "a c", status: "failed" },
            { fullName: "a d", status: "skipped" },
          ],
        },
      ],
    };
    const att = attestationFromVitest("replay-01", "s".repeat(40), at(0), payload);
    expect(att.files).toEqual([{ file: "tests/cost-meter.test.ts", total: 3, passed: 1, failed: 1, skipped: 1 }]);
    expect(att.tests.map((t) => t.status)).toEqual(["passed", "failed", "skipped"]);
  });
});

describe("the collector over a deterministic scratch repository", () => {
  it("refuses OUTSIDE a repository — exit path, no facts, no artifact", async () => {
    const root = tempRoot();
    await fs.mkdir(path.join(root, "evidence"), { recursive: true });
    expect(() => collectAuditFacts(root, "replay-01")).toThrow(AuditRefused);
  });

  it("anchors the registration at the INTRODUCING commit and holds manifest B to the same act", async () => {
    const root = tempRoot();
    initRepo(root);
    await fs.mkdir(path.join(root, "evidence"), { recursive: true });
    await fs.writeFile(path.join(root, "prereg.json"), `{"frozen":true}\n`, "utf8");
    await fs.writeFile(path.join(root, "evidence", "r1.b12.tasks.json"), `{"runId":"r1"}\n`, "utf8");
    const first = commitAll(root, "registration WITHOUT manifest B");
    // B arrives one commit late — sealed in a DIFFERENT act, which is the void.
    await fs.writeFile(path.join(root, "evidence", "r1.b12.manifest-B.tasks.json"), `{"runId":"r1"}\n`, "utf8");
    commitAll(root, "manifest B, late");

    const facts = collectAuditFacts(root, "r1", { preregFrozenCommit: first, preregPath: "prereg.json" });
    expect(facts.registrationCommit).toBe(first);
    expect(facts.manifestA.registrationSha256).not.toBeNull();
    expect(facts.manifestA.headSha256).toBe(facts.manifestA.registrationSha256);
    expect(facts.manifestB.registrationSha256).toBeNull(); // absent from the act
    expect(facts.manifestB.headSha256).not.toBeNull(); // present NOW — not enough
    const { verdict, reasons } = decideAudit(facts);
    expect(verdict).toBe("void");
    expect(reasons.join(" ")).toMatch(/manifest B is ABSENT from the registration commit/);
  });
});

describe("the e2e — the operator loop over the committed replay fixture", () => {
  /** The full sequence once, returning the repo and its landmark commits. */
  async function operatorLoop(): Promise<{ root: string; registration: string; afterEmit: string }> {
    const root = tempRoot();
    await fs.cp(FIXTURE, root, { recursive: true });
    initRepo(root);
    // Manifest B sealed in the SAME act as A — byte-identical blob, which is
    // what `open-b` will hold the real register to.
    await fs.copyFile(
      path.join(root, "evidence", "replay-01.b12.tasks.json"),
      path.join(root, "evidence", "replay-01.b12.manifest-B.tasks.json")
    );
    const registration = commitAll(root, "registration: fixture + both manifests");

    // 1. emit, UNCHECKED — both artifacts, clauses 4–6 published as unchecked.
    const unchecked = await emitRun(root, "replay-01");
    expect(unchecked.verdict).toBe("void"); // 1 admitted of 20 — the arithmetic's own void
    const afterEmit = commitAll(root, "first emit, unchecked");

    // 2. the attestation, subject = the commit the suite would have run at.
    const attestation = attestationOf(afterEmit, { runId: "replay-01" });
    await fs.writeFile(
      path.join(root, "evidence", "replay-01.b12.suite.json"),
      JSON.stringify(attestation, null, 2) + "\n",
      "utf8"
    );
    commitAll(root, "suite attestation");
    return { root, registration, afterEmit };
  }

  it("audit → commit → emit --audit lands gitAudit.ran === true with the clause check NOT fired", async () => {
    const { root, registration } = await operatorLoop();

    // 3. the audit, over COMMITTED state only.
    const facts = collectAuditFacts(root, "replay-01", {
      preregFrozenCommit: registration,
      preregPath: "evidence/replay-01.b12.tasks.json",
    });
    expect(facts.registrationCommit).toBe(registration);
    expect(facts.clause5.anchor).not.toBeNull(); // the one scored observation anchors
    expect(facts.clause5.anchorProblems).toEqual([]);
    expect(facts.clause5.offenders).toEqual([]); // nothing touched a pinned path
    const { artifact } = buildAuditArtifact(facts);
    expect(artifact.reasons).toEqual([]);
    expect(artifact.verdict).toBe("clean");
    // The e2e feeds REAL lists and numbers into the canonical serialization.
    expect(artifact.inputs["clause5.anchor.taskId"]).toBe("t1");
    expect(artifact.inputs["clause5.anchor.attempt"]).toBe("1");
    expect(artifact.inputs["registrationCommit"]).toBe(registration);

    await fs.writeFile(
      path.join(root, "evidence", "replay-01.b12.audit.json"),
      JSON.stringify(artifact, null, 2) + "\n",
      "utf8"
    );
    commitAll(root, "the audit");

    // 4. the final emit, with the audit as input.
    const emitted = await emitRun(root, "replay-01", {
      auditPath: "evidence/replay-01.b12.audit.json",
      scoringCommandActual: "node dist/cost/b12/emit.js replay-01",
    });
    const result = JSON.parse(await fs.readFile(emitted.resultPath, "utf8")) as {
      gitAudit: { ran: boolean; verdict?: string };
      uncheckedClauses: string[];
      archiveChecks: Array<{ clause: string; fired: boolean }>;
    };
    expect(result.gitAudit.ran).toBe(true);
    expect(result.gitAudit.verdict).toBe("clean");
    expect(result.uncheckedClauses).toEqual([]);
    const auditCheck = result.archiveChecks.find((c) => c.clause.includes("the git audit"));
    expect(auditCheck?.fired).toBe(false);
  }, 60_000);

  it("a HOSTILE flip after the fact voids: a failed control, and a post-anchor pinned-path edit", async () => {
    const { root, registration } = await operatorLoop();

    // Flip one control to failed IN THE COMMITTED attestation.
    const suitePath = path.join(root, "evidence", "replay-01.b12.suite.json");
    const attestation = JSON.parse(await fs.readFile(suitePath, "utf8")) as SuiteAttestation;
    attestation.tests[0]!.status = "failed";
    await fs.writeFile(suitePath, JSON.stringify(attestation, null, 2) + "\n", "utf8");
    commitAll(root, "hostile: control flipped");

    const flipped = collectAuditFacts(root, "replay-01", {
      preregFrozenCommit: registration,
      preregPath: "evidence/replay-01.b12.tasks.json",
    });
    const flippedVerdict = decideAudit(flipped);
    expect(flippedVerdict.verdict).toBe("void");
    expect(flippedVerdict.reasons.join(" ")).toMatch(/required control not passing/);

    // And a pinned-path edit AFTER the anchor: both probes catch it — the
    // commit post-dates the anchor's start and is no ancestor of its commit.
    await fs.mkdir(path.join(root, "src", "cost"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "cost", "hostile.ts"), "export const x = 1;\n", "utf8");
    commitAll(root, "hostile: pinned path touched");

    const drifted = collectAuditFacts(root, "replay-01", {
      preregFrozenCommit: registration,
      preregPath: "evidence/replay-01.b12.tasks.json",
    });
    expect(drifted.clause5.offenders.length).toBeGreaterThan(0);
    expect(drifted.clause5.excusedByReemission).toEqual([]); // no re-emission happened
    const driftedVerdict = decideAudit(drifted);
    expect(driftedVerdict.verdict).toBe("void");
    expect(driftedVerdict.reasons.join(" ")).toMatch(/touched a pinned path/);
    // The non-evidence drift ALSO fires clause 6 — two clauses, two reasons,
    // neither masking the other.
    expect(driftedVerdict.reasons.join(" ")).toMatch(/evidence\/\*\* only/);
  }, 60_000);
});
