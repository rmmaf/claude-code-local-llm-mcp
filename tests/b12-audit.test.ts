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
  AMENDMENT_CONFORMANCE_PATHS,
  AUDIT_INPUT_KEYS,
  AuditRefused,
  attestationFromVitest,
  attestationProblems,
  auditInputs,
  buildAuditArtifact,
  collectAuditFacts,
  CONFORMANCE_FILES,
  CONTROL_TESTS,
  decideAudit,
  evidenceArtifactPath,
  parseGitAudit,
  PINNED_PATHS,
  SAFE_RUN_ID,
  PREREG_FROZEN_COMMIT,
  PREREG_PATH,
  suiteRunRefusal,
  workingTreeDirtOutsideEvidence,
  type AuditFacts,
  type Git,
  type SuiteAttestation,
} from "../src/cost/b12/audit.js";
import { sha256 } from "../src/cost/b12/archive.js";
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

/** The scratch repositories' stand-in dependency tree — clause 6 hashes the
 * real thing at `subjectCommit`, so the oracle has to commit one. */
const LOCKFILE_TEXT = `{"name":"b12-scratch","lockfileVersion":3,"packages":{}}\n`;

// ---------------------------------------------------------------------------
// Facts fixtures for the pure decider.
// ---------------------------------------------------------------------------

function attestationOf(subjectCommit: string, over: Partial<SuiteAttestation> = {}): SuiteAttestation {
  return {
    schema: "b12-suite/1",
    runId: "replay-01",
    subjectCommit,
    generatedAt: at(0),
    lockfileSha256: "1".repeat(64),
    files: CONFORMANCE_FILES.map((file) => ({ file, total: 10, passed: 10, failed: 0, skipped: 0 })),
    tests: CONTROL_TESTS.map(({ file, fullName }) => ({ file, fullName, status: "passed" })),
    ...over,
  };
}

function factsOf(over: Partial<AuditFacts> = {}): AuditFacts {
  return {
    runId: "replay-01",
    head: "h".repeat(40),
    registrationCommit: "r".repeat(40),
    prereg: { path: PREREG_PATH, frozenCommit: PREREG_FROZEN_COMMIT, frozenSha256: "p".repeat(64), headSha256: "p".repeat(64) },
    manifestA: { registrationSha256: "a".repeat(64), headSha256: "a".repeat(64) },
    manifestB: { registrationSha256: "b".repeat(64), headSha256: "b".repeat(64) },
    clause5: {
      anchor: { taskId: "t1", arm: "treatment", attempt: 1, started: at(0), commit: "c".repeat(40) },
      anchorProblems: [],
      pinnedPaths: [...PINNED_PATHS],
      amendment: {
        path: AMENDMENT_CONFORMANCE_PATHS,
        commit: null,
        sha256: null,
        addedPaths: CONFORMANCE_FILES,
        governs: false,
      },
      commitsTouchingPinned: [],
      offenders: [],
      excusedByReemission: [],
      evidencePaths: ["evidence/replay-01.b12.runlog.jsonl"],
      evidenceDigest: "e".repeat(64),
    },
    clause6: {
      attestation: attestationOf("s".repeat(40)),
      attestationSha256: "t".repeat(64),
      subjectIsAncestor: true,
      nonEvidenceDrift: [],
      // The default facts describe an attestation whose claimed lockfile IS
      // the one its subject commit carries (R29).
      lockfileAtSubject: "1".repeat(64),
      conformance: CONFORMANCE_FILES.map((file) => ({
        file,
        atRegistration: "c".repeat(64),
        atSubject: "c".repeat(64),
      })),
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
      decideAudit(
        factsOf({ prereg: { path: PREREG_PATH, frozenCommit: PREREG_FROZEN_COMMIT, frozenSha256: "p".repeat(64), headSha256: "q".repeat(64) } })
      ).reasons.join(" ")
    ).toMatch(/drifted from its freeze-commit blob/);
    expect(
      decideAudit(
        factsOf({ prereg: { path: PREREG_PATH, frozenCommit: PREREG_FROZEN_COMMIT, frozenSha256: null, headSha256: "p".repeat(64) } })
      ).reasons.join(" ")
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
        ...factsOf().clause5,
        anchor: { taskId: "t1", arm: "treatment", attempt: 1, started: at(0), commit: "c".repeat(40) },
        anchorProblems: [],
        commitsTouchingPinned: [{ sha: offender, committerDate: at(10) }],
        offenders: [offender],
        excusedByReemission: [],
        evidencePaths: ["evidence/replay-01.b12.runlog.jsonl"],
        evidenceDigest: "e".repeat(64),
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

  it("clause 6 fires when the attested lockfile is not the subject commit's — R29", () => {
    // R24 recorded the producer's number; nobody ever checked it, so a copied
    // or hand-edited attestation could name any dependency tree and still
    // satisfy the clause. Only the recorded hash changes here.
    const drifted = decideAudit(
      factsOf({ clause6: { ...factsOf().clause6, lockfileAtSubject: "9".repeat(64) } })
    );
    expect(drifted.verdict).toBe("void");
    expect(drifted.reasons.join(" ")).toMatch(/did not run on the dependencies that commit pins/);
    // And a subject commit with no readable lockfile is not a free pass.
    const unreadable = decideAudit(factsOf({ clause6: { ...factsOf().clause6, lockfileAtSubject: null } }));
    expect(unreadable.verdict).toBe("void");
    expect(unreadable.reasons.join(" ")).toMatch(/no readable package-lock\.json/);
  });

  it("clause 6 fires on absence, a failing file, a skipped file, a missing control, and foreign drift", () => {
    expect(
      decideAudit(factsOf({ clause6: { ...factsOf().clause6, attestation: null, attestationSha256: null, subjectIsAncestor: null, nonEvidenceDrift: [] } }))
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
      decideAudit(factsOf({ clause6: { ...factsOf().clause6, attestation: failingFile, attestationSha256: "t".repeat(64), subjectIsAncestor: true, nonEvidenceDrift: [] } }))
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
      decideAudit(factsOf({ clause6: { ...factsOf().clause6, attestation: skippedFile, attestationSha256: "t".repeat(64), subjectIsAncestor: true, nonEvidenceDrift: [] } }))
        .verdict
    ).toBe("void");

    const missingControl = attestationOf(s, {
      tests: CONTROL_TESTS.slice(1).map(({ file, fullName }) => ({ file, fullName, status: "passed" })),
    });
    expect(
      decideAudit(factsOf({ clause6: { ...factsOf().clause6, attestation: missingControl, attestationSha256: "t".repeat(64), subjectIsAncestor: true, nonEvidenceDrift: [] } }))
        .reasons.join(" ")
    ).toMatch(/required control absent/);

    const failedControl = attestationOf(s, {
      tests: CONTROL_TESTS.map(({ file, fullName }, i) => ({
        file,
        fullName,
        status: i === 0 ? "failed" : "passed",
      })),
    });
    expect(
      decideAudit(factsOf({ clause6: { ...factsOf().clause6, attestation: failedControl, attestationSha256: "t".repeat(64), subjectIsAncestor: true, nonEvidenceDrift: [] } }))
        .reasons.join(" ")
    ).toMatch(/required control not passing/);

    // R23: THE TITLE IS NOT THE CONTROL. A vitest fullName is not unique
    // across files, so a control's NAME could satisfy the clause from a
    // trivial test in another file — or from two tests, neither identified.
    const movedControl = attestationOf(s, {
      tests: CONTROL_TESTS.map(({ file, fullName }, i) => ({
        file: i === 0 ? "tests/somewhere-else.test.ts" : file,
        fullName,
        status: "passed",
      })),
    });
    expect(
      decideAudit(factsOf({ clause6: { ...factsOf().clause6, attestation: movedControl, attestationSha256: "t".repeat(64), subjectIsAncestor: true, nonEvidenceDrift: [] } }))
        .reasons.join(" ")
    ).toMatch(/attested in tests\/somewhere-else\.test\.ts, not in tests\/cost-meter\.test\.ts/);

    const duplicatedControl = attestationOf(s, {
      tests: [
        ...CONTROL_TESTS.map(({ file, fullName }) => ({ file, fullName, status: "passed" })),
        { file: CONTROL_TESTS[0]!.file, fullName: CONTROL_TESTS[0]!.fullName, status: "passed" },
      ],
    });
    expect(
      decideAudit(
        factsOf({ clause6: { ...factsOf().clause6, attestation: duplicatedControl, attestationSha256: "t".repeat(64), subjectIsAncestor: true, nonEvidenceDrift: [] } })
      ).reasons.join(" ")
    ).toMatch(/2 tests in tests\/cost-meter\.test\.ts carry the control's fullName/);

    expect(
      decideAudit(
        factsOf({ clause6: { ...factsOf().clause6, attestation: attestationOf(s), attestationSha256: "t".repeat(64), subjectIsAncestor: false, nonEvidenceDrift: [] } })
      ).reasons.join(" ")
    ).toMatch(/not an ancestor of HEAD/);

    expect(
      decideAudit(
        factsOf({ clause6: { ...factsOf().clause6, attestation: attestationOf(s), attestationSha256: "t".repeat(64), subjectIsAncestor: true, nonEvidenceDrift: ["src/cost/report.ts"] } })
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
    const att = attestationFromVitest("replay-01", "s".repeat(40), at(0), payload, "9".repeat(64));
    expect(att.files).toEqual([{ file: "tests/cost-meter.test.ts", total: 3, passed: 1, failed: 1, skipped: 1 }]);
    expect(att.tests.map((t) => t.status)).toEqual(["passed", "failed", "skipped"]);
    // R24: the dependency tree the suite ran on, by the lockfile it installed
    // from — the attestation used to borrow the enclosing repo's node_modules
    // and record only subjectCommit, hiding the skew.
    expect(att.lockfileSha256).toBe("9".repeat(64));
    expect(attestationProblems({ ...att, lockfileSha256: "" }).join(" ")).toMatch(/records no lockfileSha256/);
    expect(attestationProblems(att).join(" ")).not.toMatch(/lockfileSha256/);
  });
});

// ---------------------------------------------------------------------------
// R12: the suite command's own verdict, and the attestation's runtime shape.
// A passing REPORT is not a passing RUN, and committed bytes are not what the
// types promise.
// ---------------------------------------------------------------------------

describe("the suite command's verdict — a passing report is not a passing run", () => {
  const payload = JSON.stringify({
    testResults: [
      { name: "C:\\repo\\tests\\cost-meter.test.ts", assertionResults: [{ fullName: "a b", status: "passed" }] },
    ],
  });

  it("REFUSES a non-zero exit even when every reported test passed", () => {
    const { refusal, jsonLine } = suiteRunRefusal({ status: 1, signal: null, stdout: payload });
    expect(jsonLine).toBeNull();
    expect(refusal).toMatch(/exited 1 .*may not produce a PASSING attestation/);
  });

  it("REFUSES a signalled run, a runner that never answered, and a report-less stdout", () => {
    expect(suiteRunRefusal({ status: null, signal: "SIGKILL", stdout: payload }).refusal).toMatch(/killed by SIGKILL/);
    expect(suiteRunRefusal({ error: new Error("ENOENT"), status: null, signal: null, stdout: "" }).refusal).toMatch(
      /did not answer/
    );
    expect(suiteRunRefusal({ status: 0, signal: null, stdout: "no json here\n" }).refusal).toMatch(/no JSON payload/);
  });

  it("passes the payload through on a clean exit — the only door to an attestation", () => {
    const { refusal, jsonLine } = suiteRunRefusal({ status: 0, signal: null, stdout: `noise\n${payload}\n` });
    expect(refusal).toBeNull();
    expect(jsonLine).toBe(payload);
  });
});

describe("the attestation's runtime shape — committed bytes are not the type", () => {
  it("VOIDS a counter-less file entry that once satisfied the full-suite check", () => {
    // `{file}` alone: `undefined > 0` twice false, `undefined !== undefined`
    // false — the exact bypass, with every control marked passed.
    const att = attestationOf("s".repeat(40), {
      files: CONFORMANCE_FILES.map((file) => ({ file })) as SuiteAttestation["files"],
    });
    expect(attestationProblems(att).join(" ")).toMatch(/counters are not all non-negative integers/);
    const { verdict, reasons } = decideAudit(factsOf({ clause6: { ...factsOf().clause6, attestation: att } }));
    expect(verdict).toBe("void");
    expect(reasons.join(" ")).toMatch(/clause 6: tests\/cost-meter\.test\.ts: the attestation's counters/);
  });

  it("VOIDS zero-test files, counters that do not add up, duplicates, and non-integers", () => {
    const withFiles = (files: unknown): SuiteAttestation =>
      attestationOf("s".repeat(40), { files: files as SuiteAttestation["files"] });
    const base = { total: 10, passed: 10, failed: 0, skipped: 0 };
    expect(
      attestationProblems(withFiles(CONFORMANCE_FILES.map((file) => ({ ...base, file, total: 0, passed: 0 })))).join(" ")
    ).toMatch(/counts ZERO tests/);
    expect(
      attestationProblems(withFiles(CONFORMANCE_FILES.map((file) => ({ ...base, file, passed: 9 })))).join(" ")
    ).toMatch(/do not add up \(9\+0\+0 != 10\)/);
    expect(
      attestationProblems(withFiles([...CONFORMANCE_FILES, CONFORMANCE_FILES[0]!].map((file) => ({ ...base, file })))).join(" ")
    ).toMatch(/appears 2 times/);
    expect(
      attestationProblems(withFiles(CONFORMANCE_FILES.map((file) => ({ ...base, file, passed: 9.5, total: 9.5 })))).join(" ")
    ).toMatch(/not all non-negative integers/);
    expect(
      attestationProblems(withFiles(CONFORMANCE_FILES.map((file) => ({ ...base, file, failed: -1, total: 9 })))).join(" ")
    ).toMatch(/not all non-negative integers/);
  });

  it("VOIDS a non-array files/tests instead of crashing — the artifact still reports", () => {
    const broken = attestationOf("s".repeat(40), {
      files: "not an array" as unknown as SuiteAttestation["files"],
      tests: "neither" as unknown as SuiteAttestation["tests"],
    });
    const facts = factsOf({ clause6: { ...factsOf().clause6, attestation: broken } });
    const { verdict, reasons } = decideAudit(facts);
    expect(verdict).toBe("void");
    expect(reasons.join(" ")).toMatch(/`files` is not an array/);
    expect(reasons.join(" ")).toMatch(/`tests` is not an array/);
    // And the canonical inputs still serialize — a void needs its artifact.
    const { artifact } = buildAuditArtifact(facts);
    expect(artifact.verdict).toBe("void");
    expect(artifact.inputs["clause6.files"]).toMatch(/absent/);
  });

  it("stays SILENT on the well-formed attestation the e2e writes", () => {
    expect(attestationProblems(attestationOf("s".repeat(40)))).toEqual([]);
  });
});

describe("the run id becomes a filename — the traversal boundary", () => {
  it("REFUSES an id that would escape evidence/, and takes the ordinary one", async () => {
    // R30: the CLI checked only that the argument existed and did not start
    // with `--`, then interpolated it into `evidence/<runId>.b12.audit.json`
    // and WROTE with overwrite semantics. `../../target` left the directory
    // and replaced whatever sat at the resolved path — a destructive boundary
    // failure reachable by a typo or a paste. The register already applied
    // this grammar at its own point of use; this file did not.
    const root = tempRoot();
    await fs.mkdir(path.join(root, "evidence"), { recursive: true });
    expect(evidenceArtifactPath(root, "replay-01", ".b12.audit.json")).toBe(
      path.resolve(root, "evidence", "replay-01.b12.audit.json")
    );
    for (const hostile of ["../../target", "..", "a/b", "a\\b", ".hidden", "-leading", "", "x".repeat(65)]) {
      expect(() => evidenceArtifactPath(root, hostile, ".b12.audit.json")).toThrow(AuditRefused);
    }
    // The grammar is the register's, verbatim.
    expect(SAFE_RUN_ID.source).toBe("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$");
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

// ---------------------------------------------------------------------------
// R9: fail-closed probes, and the attestation's dirty-tree guard. A failed
// MANDATORY git probe may never wear the same empty list a clean answer
// wears; a dirty tree may never be attested under subjectCommit's name.
// ---------------------------------------------------------------------------

describe("fail-closed probes and the dirty-tree guard", () => {
  async function minimalRepo(): Promise<{ root: string; first: string }> {
    const root = tempRoot();
    initRepo(root);
    await fs.mkdir(path.join(root, "evidence"), { recursive: true });
    await fs.writeFile(path.join(root, "prereg.json"), `{"frozen":true}\n`, "utf8");
    await fs.writeFile(path.join(root, "evidence", "r1.b12.tasks.json"), `{"runId":"r1"}\n`, "utf8");
    await fs.writeFile(path.join(root, "evidence", "r1.b12.manifest-B.tasks.json"), `{"runId":"r1"}\n`, "utf8");
    const first = commitAll(root, "registration");
    return { root, first };
  }

  /** A passthrough runner over the scratch repo, for wrapping. */
  const realGit = (root: string): Git => (args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    return { ok: r.status === 0, out: r.stdout ?? "" };
  };

  it("REFUSES when the clause-5 history log fails — an empty answer is not a clean one", async () => {
    const { root, first } = await minimalRepo();
    const base = realGit(root);
    const failing: Git = (args) => (args[0] === "log" && args.includes("--format=%H %cI") ? { ok: false, out: "" } : base(args));
    expect(() =>
      collectAuditFacts(root, "r1", { preregFrozenCommit: first, preregPath: "prereg.json", gitRunner: failing })
    ).toThrow(/clause 5's history cannot be inspected/);
  });

  it("REFUSES when the attestation drift diff fails — a failed diff may not impersonate 'no drift'", async () => {
    const { root, first } = await minimalRepo();
    await fs.writeFile(
      path.join(root, "evidence", "r1.b12.suite.json"),
      JSON.stringify(attestationOf(first, { runId: "r1" }), null, 2) + "\n",
      "utf8"
    );
    commitAll(root, "attestation");
    const base = realGit(root);
    const failing: Git = (args) => (args[0] === "diff" ? { ok: false, out: "" } : base(args));
    expect(() =>
      collectAuditFacts(root, "r1", { preregFrozenCommit: first, preregPath: "prereg.json", gitRunner: failing })
    ).toThrow(/drift cannot be inspected/);
  });

  it("names working-tree dirt outside evidence/ and stays quiet inside it", async () => {
    const { root } = await minimalRepo();
    expect(workingTreeDirtOutsideEvidence(root)).toEqual([]);
    // Dirt INSIDE evidence/ is lawful — the attestation itself is born there.
    await fs.writeFile(path.join(root, "evidence", "r1.b12.suite.json"), "{}\n", "utf8");
    expect(workingTreeDirtOutsideEvidence(root)).toEqual([]);
    // A tracked edit outside evidence/ is dirt…
    await fs.writeFile(path.join(root, "prereg.json"), `{"frozen":true,"edited":true}\n`, "utf8");
    expect(workingTreeDirtOutsideEvidence(root).join(" ")).toMatch(/prereg\.json/);
    // …and so is an untracked newcomer.
    git(root, ["checkout", "--", "prereg.json"]);
    await fs.writeFile(path.join(root, "loose.ts"), "export {};\n", "utf8");
    expect(workingTreeDirtOutsideEvidence(root).join(" ")).toMatch(/loose\.ts/);
  });
});

describe("the e2e — the operator loop over the committed replay fixture", () => {
  /**
   * The full sequence once, returning the repo and its landmark commits.
   *
   * `seed` runs before the registration commit — the only place an artifact
   * can be born EARLIER than the freeze anchor, which is what a prospective
   * amendment's clock turns on. `beforeAttestation` runs after the emit and
   * may return a new commit to attest, which is how the window between the
   * first scored observation and the attestation gets modelled at all.
   */
  async function operatorLoop(
    hooks: { seed?: (root: string) => Promise<void>; beforeAttestation?: (root: string) => Promise<string> } = {}
  ): Promise<{ root: string; registration: string; afterEmit: string; subject: string }> {
    const root = tempRoot();
    await fs.cp(FIXTURE, root, { recursive: true });
    initRepo(root);
    // The dependency tree clause 6 now checks against the subject commit
    // (R29): the scratch repo needs a real lockfile, and the attestation gets
    // its real hash.
    await fs.writeFile(path.join(root, "package-lock.json"), LOCKFILE_TEXT, "utf8");
    await hooks.seed?.(root);
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
    const subject = (await hooks.beforeAttestation?.(root)) ?? afterEmit;
    const attestation = attestationOf(subject, { runId: "replay-01", lockfileSha256: sha256(LOCKFILE_TEXT) });
    await fs.writeFile(
      path.join(root, "evidence", "replay-01.b12.suite.json"),
      JSON.stringify(attestation, null, 2) + "\n",
      "utf8"
    );
    commitAll(root, "suite attestation");
    return { root, registration, afterEmit, subject };
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
      // The emission RE-DERIVES the audit (R26); the scratch repo's stand-in
      // prereg has to reach both sides or they would be asking different
      // questions. The CLI passes nothing and re-derives with the constants.
      auditCollectorOptions: { preregFrozenCommit: registration, preregPath: "evidence/replay-01.b12.tasks.json" },
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

  it("a committed CLEAN audit stops counting the moment the tree it judged moves", async () => {
    // R22#2: `committedAuditCheck` proves the artifact is committed evidence
    // and says NOTHING about what it judged. A clean audit could therefore be
    // kept — or cherry-picked — while the pinned sources, the manifests or
    // the suite attestation moved underneath it, and clauses 4–6 would still
    // publish as clean over facts nobody audited.
    const { root, registration } = await operatorLoop();
    const facts = collectAuditFacts(root, "replay-01", {
      preregFrozenCommit: registration,
      preregPath: "evidence/replay-01.b12.tasks.json",
    });
    const { artifact } = buildAuditArtifact(facts);
    expect(artifact.verdict).toBe("clean");
    const auditRel = "evidence/replay-01.b12.audit.json";
    await fs.writeFile(path.join(root, auditRel), JSON.stringify(artifact, null, 2) + "\n", "utf8");
    commitAll(root, "the audit");
    const emit = async (): Promise<{ ran: boolean; problems: string[]; unchecked: string[] }> => {
      const out = await emitRun(root, "replay-01", {
        auditPath: auditRel,
        auditCollectorOptions: { preregFrozenCommit: registration, preregPath: "evidence/replay-01.b12.tasks.json" },
      });
      const result = JSON.parse(await fs.readFile(out.resultPath, "utf8")) as {
        gitAudit: { ran: boolean };
        uncheckedClauses: string[];
        problems?: string[];
        archiveProblems?: string[];
      };
      return {
        ran: result.gitAudit.ran,
        problems: [...(result.problems ?? []), ...(result.archiveProblems ?? [])],
        unchecked: result.uncheckedClauses,
      };
    };
    // The lawful gap: the audit's own commit, touching evidence/ only.
    expect((await emit()).ran).toBe(true);

    // (1) AN EVIDENCE-BORNE INPUT MOVES — invisible to any "only evidence/
    // changed" rule, so the artifact's own recorded hashes are re-checked.
    const suiteRel = "evidence/replay-01.b12.suite.json";
    const suiteBytes = await fs.readFile(path.join(root, suiteRel), "utf8");
    await fs.writeFile(path.join(root, suiteRel), suiteBytes.replace(/\n$/, "\n\n"), "utf8");
    commitAll(root, "the suite attestation, edited after the audit");
    const drifted = await emit();
    expect(drifted.ran).toBe(false);
    expect(drifted.problems.join(" ")).toMatch(/suite\.json changed after the audit judged it/);
    expect(drifted.unchecked.length).toBeGreaterThan(0);

    // …and the refusal is not STICKY: put the bytes back and the audit counts
    // again, which is what makes it a binding rather than a tripwire.
    await fs.writeFile(path.join(root, suiteRel), suiteBytes, "utf8");
    commitAll(root, "the attestation restored");
    expect((await emit()).ran).toBe(true);

    // (2) THE EVIDENCE CLAUSE 5 WAS COMPUTED FROM MOVES (R24). Naming four
    // evidence files was not the same as covering evidence/**: an observation
    // appended after a clean audit changes the anchor's population and the
    // archive being scored, while the verdict rides along unchanged.
    const obsRel = "evidence/replay-01/obs-t9-treatment/observation.json";
    await fs.mkdir(path.join(root, path.dirname(obsRel)), { recursive: true });
    await fs.writeFile(path.join(root, obsRel), `{"taskId":"t9","arm":"treatment"}\n`, "utf8");
    commitAll(root, "an observation appended after the audit");
    const appended = await emit();
    expect(appended.ran).toBe(false);
    expect(appended.problems.join(" ")).toMatch(/clause-5 evidence changed after the audit judged it/);
    expect(appended.problems.join(" ")).toMatch(/1 added/);
    await fs.rm(path.join(root, path.dirname(obsRel)), { recursive: true, force: true });
    commitAll(root, "the appended observation removed");
    expect((await emit()).ran).toBe(true);

    // (3) A PINNED PATH MOVES — outside evidence/, so the one confined-diff
    // predicate covers every input the audit read from outside evidence.
    await fs.mkdir(path.join(root, "src", "cost"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "cost", "report.ts"), "export const CHANGED = 1;\n", "utf8");
    commitAll(root, "a pinned path, edited after the audit");
    const moved = await emit();
    expect(moved.ran).toBe(false);
    expect(moved.problems.join(" ")).toMatch(/outside evidence\/ changed after the audit judged them/);
    expect(moved.problems.join(" ")).toMatch(/src\/cost\/report\.ts/);
  }, 90_000);

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

  // -------------------------------------------------------------------------
  // R23's residual, closed by a PRE-DATA AMENDMENT (2026-08-10).
  //
  // The window: a control emptied AFTER the first scored observation and
  // BEFORE the attestation. Clause 6's drift check cannot see it — the
  // attestation honestly describes the gutted tree and nothing moves after
  // it — and clause 5 did not name the conformance files. The two tests below
  // are the same repository twice: with the amendment born before the anchor,
  // and without it. The second IS the pre-amendment damage.
  // -------------------------------------------------------------------------
  const AMENDMENT_REL = "evidence/2026-08-10-b12-amendment-conformance-paths.json";
  const seedConformance = (withAmendment: boolean) => async (root: string): Promise<void> => {
    await fs.mkdir(path.join(root, "tests"), { recursive: true });
    for (const file of CONFORMANCE_FILES) {
      await fs.writeFile(path.join(root, file), "// the control, with its teeth\n", "utf8");
    }
    if (withAmendment) {
      await fs.writeFile(path.join(root, AMENDMENT_REL), `{"schema":"b12-amendment/1"}\n`, "utf8");
    }
  };
  const gutTheControl = async (root: string): Promise<string> => {
    await fs.writeFile(path.join(root, CONFORMANCE_FILES[0]!), "// the control, emptied\n", "utf8");
    return commitAll(root, "the control gutted — mid-run, BEFORE the attestation");
  };

  it("a STALE counterfactual cannot make a scored run look anchorless", async () => {
    // R29: the anchor walked `counterfactual.observations` and nothing ever
    // proved that list covers the committed evidence. The counterfactual is
    // written by the EMITTER, so an early unchecked emit followed by more
    // observations leaves a stale one committed — and the audit then read
    // "no observation scored yet, sources FREE" over a run that had scored.
    // A pinned-path change after the real first observation got a CLEAN
    // audit, and the emission re-derived the same stale state and agreed.
    // The drift lands BEFORE the attestation and the attestation names it, so
    // clause 6's own non-evidence check is silent: whatever fires here fires
    // because of clause 5, and nothing else.
    const cfRel = "evidence/replay-01.b12.counterfactual.json";
    const { root, registration } = await operatorLoop({
      beforeAttestation: async (r) => {
        const cf = JSON.parse(await fs.readFile(path.join(r, cfRel), "utf8")) as { observations: unknown[] };
        expect(cf.observations.length).toBeGreaterThan(0); // the run DID score
        await fs.writeFile(path.join(r, cfRel), JSON.stringify({ ...cf, observations: [] }, null, 2) + "\n", "utf8");
        await fs.mkdir(path.join(r, "src", "cost"), { recursive: true });
        await fs.writeFile(path.join(r, "src", "cost", "hostile.ts"), "export const x = 1;\n", "utf8");
        return commitAll(r, "a stale counterfactual, and a pinned path touched after the first score");
      },
    });

    const facts = collectAuditFacts(root, "replay-01", {
      preregFrozenCommit: registration,
      preregPath: "evidence/replay-01.b12.tasks.json",
    });
    expect(facts.clause5.anchor).toBeNull(); // the stale list yields no anchor…
    const { verdict, reasons } = decideAudit(facts);
    expect(verdict).toBe("void"); // …and that is a VOID, never a freedom
    expect(facts.clause5.anchorProblems.join(" ")).toMatch(/committed evidence the counterfactual does not declare/);
    expect(reasons.join(" ")).toMatch(/re-emit before auditing/);
  }, 60_000);

  it("a FORGED clean audit — committed, correctly hashed — is refused by re-derivation", async () => {
    // R26: every binding check asked what the artifact SAYS about a handful
    // of paths; none asked whether the verdict beside them is the verdict
    // those facts produce. So an operator could hand-write the artifact,
    // fill in the four hashes and the evidence digest by reading the repo,
    // commit it, and clauses 4–6 published as CHECKED with no audit ever
    // having run. The forgery below is BETTER than plausible: it is the real
    // artifact with one input rewritten and the verdict flipped.
    const { root, registration } = await operatorLoop();
    const collector = { preregFrozenCommit: registration, preregPath: "evidence/replay-01.b12.tasks.json" };
    const { artifact } = buildAuditArtifact(collectAuditFacts(root, "replay-01", collector));
    const auditRel = "evidence/replay-01.b12.audit.json";
    const forged = {
      ...artifact,
      verdict: "clean" as const,
      reasons: [] as string[],
      // A control that never ran, and a clause-5 anchor that never was.
      inputs: { ...artifact.inputs, "clause5.anchor.taskId": "a-task-that-never-ran" },
    };
    await fs.writeFile(path.join(root, auditRel), JSON.stringify(forged, null, 2) + "\n", "utf8");
    commitAll(root, "hostile: a hand-authored audit");
    const out = await emitRun(root, "replay-01", { auditPath: auditRel, auditCollectorOptions: collector });
    const result = JSON.parse(await fs.readFile(out.resultPath, "utf8")) as {
      gitAudit: { ran: boolean };
      uncheckedClauses: string[];
      archiveProblems?: string[];
    };
    expect(result.gitAudit).toEqual({ ran: false });
    expect(result.uncheckedClauses).toHaveLength(3);
    expect((result.archiveProblems ?? []).join(" ")).toMatch(/clause5\.anchor\.taskId does not survive re-derivation/);
  }, 60_000);

  it("a forged VERDICT is refused even when every input is the truth", async () => {
    // The other half: keep the real inputs, flip only the answer. Nothing
    // that re-hashes paths can see this — only re-deriving the decision can.
    const { root, registration } = await operatorLoop();
    const collector = { preregFrozenCommit: registration, preregPath: "evidence/replay-01.b12.tasks.json" };
    const auditRel = "evidence/replay-01.b12.audit.json";
    // Make the run genuinely void first (a control flipped to failed), then
    // publish "clean" over the true inputs.
    const suitePath = path.join(root, "evidence", "replay-01.b12.suite.json");
    const attestation = JSON.parse(await fs.readFile(suitePath, "utf8")) as SuiteAttestation;
    attestation.tests[0]!.status = "failed";
    await fs.writeFile(suitePath, JSON.stringify(attestation, null, 2) + "\n", "utf8");
    commitAll(root, "a control that did not pass");
    const { artifact } = buildAuditArtifact(collectAuditFacts(root, "replay-01", collector));
    expect(artifact.verdict).toBe("void");
    await fs.writeFile(
      path.join(root, auditRel),
      JSON.stringify({ ...artifact, verdict: "clean", reasons: [] }, null, 2) + "\n",
      "utf8"
    );
    commitAll(root, "hostile: the verdict rewritten");
    const out = await emitRun(root, "replay-01", { auditPath: auditRel, auditCollectorOptions: collector });
    const result = JSON.parse(await fs.readFile(out.resultPath, "utf8")) as {
      gitAudit: { ran: boolean };
      archiveProblems?: string[];
    };
    expect(result.gitAudit).toEqual({ ran: false });
    expect((result.archiveProblems ?? []).join(" ")).toMatch(
      /says clean and re-deriving it here says void — the verdict was not produced by these facts/
    );
  }, 60_000);

  it("the amendment, born BEFORE the anchor, puts the conformance files under clause 5", async () => {
    const { root, registration, subject } = await operatorLoop({
      seed: seedConformance(true),
      beforeAttestation: gutTheControl,
    });
    const facts = collectAuditFacts(root, "replay-01", {
      preregFrozenCommit: registration,
      preregPath: "evidence/replay-01.b12.tasks.json",
      amendmentPath: AMENDMENT_REL,
    });
    expect(facts.clause5.amendment.commit).toBe(registration); // born in the act itself
    expect(facts.clause5.amendment.governs).toBe(true);
    expect(facts.clause5.pinnedPaths).toContain(CONFORMANCE_FILES[0]);
    expect(facts.clause5.offenders).toContain(subject);
    const { verdict, reasons } = decideAudit(facts);
    expect(verdict).toBe("void");
    expect(reasons.join(" ")).toMatch(/touched a pinned path after the first scored observation/);
    // And clause 6 is NOT what caught it: the attestation's subject IS the
    // gutted commit, so nothing drifted after it. The amendment is the only
    // thing standing between this edit and a clean verdict.
    expect(reasons.join(" ")).not.toMatch(/evidence\/\*\* only/);
    // The artifact says which regime decided, and the effective set — never
    // the constant.
    const { artifact } = buildAuditArtifact(facts);
    expect(artifact.inputs["clause5.amendment.governs"]).toBe("yes");
    expect(artifact.inputs["clause5.pinnedPaths"]).toMatch(/tests\/cost-meter\.test\.ts/);
  }, 60_000);

  it("WITHOUT the amendment the same gutting is clean — and the reported hashes still show it", async () => {
    const { root, registration } = await operatorLoop({
      seed: seedConformance(false),
      beforeAttestation: gutTheControl,
    });
    const facts = collectAuditFacts(root, "replay-01", {
      preregFrozenCommit: registration,
      preregPath: "evidence/replay-01.b12.tasks.json",
      amendmentPath: AMENDMENT_REL,
    });
    expect(facts.clause5.amendment.commit).toBeNull();
    expect(facts.clause5.amendment.governs).toBe(false);
    expect(facts.clause5.pinnedPaths).not.toContain(CONFORMANCE_FILES[0]);
    expect(facts.clause5.offenders).toEqual([]);
    const { verdict, reasons } = decideAudit(facts);
    expect(verdict).toBe("clean");
    expect(reasons).toEqual([]);
    // THE POINT OF THE REPORTED HALF: the verdict is clean and the drift is
    // nonetheless on the artifact's face, for the file that moved and not for
    // the one that did not.
    const gutted = facts.clause6.conformance.find((c) => c.file === CONFORMANCE_FILES[0]);
    const untouched = facts.clause6.conformance.find((c) => c.file === CONFORMANCE_FILES[1]);
    expect(gutted?.atRegistration).not.toBe(gutted?.atSubject);
    expect(untouched?.atRegistration).toBe(untouched?.atSubject);
    const { artifact } = buildAuditArtifact(facts);
    expect(artifact.verdict).toBe("clean"); // reported, deciding nothing
    expect(artifact.inputs["clause6.conformanceHashes"]).toMatch(/tests\/cost-meter\.test\.ts .*DIFFERS/);
    expect(artifact.inputs["clause6.conformanceHashes"]).toMatch(/session-token-walk\.test\.ts .*same/);
  }, 60_000);
});
