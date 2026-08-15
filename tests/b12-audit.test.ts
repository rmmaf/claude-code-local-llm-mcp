/**
 * ORACLE FOR THE CLAUSE 4–6 AUDIT COMPUTER — `src/cost/b12/audit.ts`.
 *
 * The decider is pure and every clause is shown FIRING and NOT firing over
 * constructed facts; the collector runs over DETERMINISTIC scratch git
 * repositories (local user.name/email, `core.autocrlf false`, no signing);
 * the e2e drives the operator loop's real sequence — attestation → commit →
 * audit → commit → ONE `emit --audit` → commit — over the committed replay
 * fixture, and then flips one hostile bit at a time. There is no first,
 * unchecked emit: it was what forced two scoring invocations against a frozen
 * text that says one, and it is gone (R50).
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AMENDMENT_CONFORMANCE_PATHS,
  AMENDMENT_REPAIR_MAX_ROUNDS,
  AUDIT_INPUT_KEYS,
  AuditRefused,
  attestationFromVitest,
  attestationProblems,
  auditInputs,
  buildAuditArtifact,
  collectAuditFacts,
  CONFORMANCE_FILES,
  normaliseToolchain,
  toolchainAgreement,
  toolchainLabel,
  agreementLabel,
  CONTROL_TESTS,
  decideAudit,
  evidenceArtifactPath,
  parseGitAudit,
  EMISSION_FENCED_FILES,
  runEmittedArtifacts,
  PINNED_PATHS,
  SAFE_RUN_ID,
  PREREG_FROZEN_COMMIT,
  PREREG_PATH,
  suiteRunRefusal,
  workingTreeDirtOutsideEvidence,
  type AuditFacts,
  type FiringEvidence,
  isFiringEvidence,
  type Git,
  type SuiteAttestation,
} from "../src/cost/b12/audit.js";
import { sha256 } from "../src/cost/b12/archive.js";
// The BARRIER lives in the harness, not the scorer; imported here so the two
// normalisers are compared against each other in one place.
import { normaliseToolchainForBarrier, runToolchainRefusal } from "../scripts/b12-run.mjs";
import { EmitRefused, emitRun } from "../src/cost/b12/emit.js";
import { at } from "./b12-fixtures.js";
import { makeTempRoot, removeTempRoot } from "./helpers.js";

/** One normalised identity, reused so a disagreement in a test is deliberate. */
const DEFAULT_TOOLCHAIN = { platform: "darwin", arch: "arm64", node: "24.16", vitest: "4.1" } as const;

const roots: string[] = [];
function tempRoot(): string {
  const root = makeTempRoot("b12-audit-test-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    await removeTempRoot(root);
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

/**
 * The scratch repositories' stand-in for clause 5's FOURTH item (R37): the
 * emission fence is read out of `src/tools/**`, and a repository without those
 * files has a pin with nothing to pin — which the collector reports rather
 * than passing over. Only the fence has to be real here; what the audit
 * compares is the canonical digest of what lies between the markers.
 */
/**
 * Stand-ins for the mutation harness's six subjects. The scratch repo has no
 * `src/**` of its own — it is a copy of `tests/fixtures/b12-run/` — so the
 * bytes clause 6's firing evidence binds to have to be created here, before the
 * registration commit, exactly as the emission fences are.
 *
 * They are deliberately NOT the real subjects' paths: those are `src/cost/**`
 * and `scripts/b12-run.mjs`, which are exactly `PINNED_PATHS`, and creating
 * them here put the scratch repo's own commits under clause 5's pinned-path
 * machinery — fifteen tests went red on offenders that were fixture scaffolding.
 * The audit only requires the paths be READABLE at the base commit.
 */
const FIRING_SUBJECTS = [1, 2, 3, 4, 5, 6].map((n) => `harness-subjects/s${n}.ts`);

const FENCED_TOOL_TEXT = [
  "export const standIn = 1;",
  "// b12:emission-begin",
  "// PROSE, inside the fence — this repository rewrites its comments constantly",
  "await emission.emit({ turns_collapsed: 0 });",
  "// b12:emission-end",
  "",
].join("\n");

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

function firingOf(baseCommit: string, over: Partial<FiringEvidence> = {}): FiringEvidence {
  return {
    schema: "b12-firing/1",
    baseCommit,
    controlsEvaluated: CONTROL_TESTS.map(({ file, fullName }) => ({ file, fullName })),
    baseline: { allGreen: true, problems: [] },
    pairs: CONTROL_TESTS.map((control, i) => ({
      id: `m${i + 1}`,
      control: { file: control.file, fullName: control.fullName },
      fired: true,
      detail: "assertion failed inside the control's own body",
    })),
    // One subject per pair: the audit REQUIRES it, because an artifact that
    // omits `subjects` would otherwise bind to no bytes at all.
    subjects: CONTROL_TESTS.map((_, i) => ({
      id: `m${i + 1}`,
      path: `src/cost/subject-${i + 1}.ts`,
      sha256AtBase: "j".repeat(64),
    })),
    problems: [],
    allFired: true,
    ...over,
  };
}

/** The recomputation the audit performs over `firingOf`'s subjects, agreeing. */
function firingSubjectsAgreeing(): Array<{ path: string; claimed: string | null; recomputed: string | null }> {
  return CONTROL_TESTS.map((_, i) => ({
    path: `src/cost/subject-${i + 1}.ts`,
    claimed: "j".repeat(64),
    recomputed: "j".repeat(64),
  }));
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
      // Default OFF, like its sibling: a fixture that governed by default would
      // make every oracle here run the post-amendment regime by accident.
      repairRoundsAmendment: {
        path: AMENDMENT_REPAIR_MAX_ROUNDS,
        commit: null,
        sha256: null,
        governs: false,
      },
      commitsTouchingPinned: [],
      offenders: [],
      excusedByReemission: [],
      emission: {
        files: [...EMISSION_FENCED_FILES],
        atAnchor: EMISSION_FENCED_FILES.map((file) => ({ file, sha256: "f".repeat(64) })),
        atHead: EMISSION_FENCED_FILES.map((file) => ({ file, sha256: "f".repeat(64) })),
        drifted: [],
        excused: [],
        problems: [],
      },
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
      // The default facts describe a run under the run-toolchain amendment with
      // all three surfaces agreeing. It decides nothing either way — these
      // fields cannot change a verdict, which is the amendment's whole point —
      // so the default is the uninteresting case and the tests that care about
      // disagreement build it explicitly.
      toolchainAmendment: {
        path: "evidence/2026-08-14-b12-amendment-run-toolchain.json",
        commit: "a".repeat(40),
        sha256: "b".repeat(64),
        governs: true,
      },
      runToolchain: {
        declared: { known: true, id: DEFAULT_TOOLCHAIN },
        firing: { known: true, id: DEFAULT_TOOLCHAIN },
        suite: { known: true, id: DEFAULT_TOOLCHAIN },
        firingAgreement: { verdict: "match" },
        suiteAgreement: { verdict: "match" },
      },
      // The default facts describe a harness matrix in which every one of the
      // six controls was shown FIRING on the very tree the attestation names.
      // Clause 6's frozen word is FIRING; passing is strictly weaker, since a
      // gutted control keeps its title and passes.
      firing: firingOf("s".repeat(40)),
      firingSha256: "g".repeat(64),
      firingSubjectsAtBase: firingSubjectsAgreeing(),
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
    await expect(collectAuditFacts(root, "replay-01")).rejects.toThrow(AuditRefused);
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

    const facts = await collectAuditFacts(root, "r1", { preregFrozenCommit: first, preregPath: "prereg.json" });
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
    await expect(
      collectAuditFacts(root, "r1", { preregFrozenCommit: first, preregPath: "prereg.json", gitRunner: failing })
    ).rejects.toThrow(/clause 5's history cannot be inspected/);
  });

  it("blobSha's THREE states: absent is a verdict, unreadable is a refusal", async () => {
    // A `git show <ref>:<path>` failure used to collapse to `null`, and `null`
    // is a VERDICT here — clause 4 reads it as "the pre-registration is
    // unreadable at its freeze commit" and VOIDS. So a transient git failure
    // could spend one of only three attempts, which is the exact inversion R32
    // caught in the anchor derivation: a refusal is retryable and writes
    // nothing; a VOID is committable and kills a paid run.
    const { root, first } = await minimalRepo();
    const base = realGit(root);
    const collector = { preregFrozenCommit: first, preregPath: "prereg.json" };

    // STATE 1 — the ref resolves and the path is genuinely absent from its
    // tree. A real answer, and clause 4 is RIGHT to void on it.
    const absent = await collectAuditFacts(root, "r1", { ...collector, preregPath: "no-such-file.json" });
    expect(absent.prereg.frozenSha256).toBeNull();
    expect(absent.prereg.headSha256).toBeNull();
    const { verdict, reasons } = decideAudit(absent);
    expect(verdict).toBe("void");
    expect(reasons.join(" ")).toMatch(/cannot be shown frozen/);

    // STATE 2 — the REF does not resolve. Not a statement about the file at
    // all, so it must REFUSE rather than void.
    await expect(
      collectAuditFacts(root, "r1", { ...collector, preregFrozenCommit: "0".repeat(40) })
    ).rejects.toThrow(AuditRefused);
    await expect(
      collectAuditFacts(root, "r1", { ...collector, preregFrozenCommit: "0".repeat(40) })
    ).rejects.toThrow(/does not resolve to a commit/);

    // STATE 3 — the ref resolves, the object EXISTS, and `show` fails anyway:
    // git failing on an object it has just confirmed. Also a refusal, and this
    // is the state the old two-way collapse could not express at all.
    const showBlind: Git = (args) =>
      args[0] === "show" && args[1]?.includes("prereg.json") === true ? { ok: false, out: "" } : base(args);
    await expect(
      collectAuditFacts(root, "r1", { ...collector, gitRunner: showBlind })
    ).rejects.toThrow(/exists as an object but could not be read/);

    // AND THE CONTROL THAT MAKES THE THREE MEAN SOMETHING: unwrapped, this
    // repository audits without refusing at all, so the refusals above are the
    // blinding and not the fixture.
    await expect(collectAuditFacts(root, "r1", collector)).resolves.toBeDefined();
  });

  it("REFUSES when the introducing-commit log FAILS — an unaskable history is not 'does not govern'", async () => {
    // `introducingCommit` mapped a FAILED `git log` and a path with NO
    // introducing commit to the same `null`, and both then read as
    // `governs = false`. A repository the audit could not interrogate therefore
    // ran the PRE-AMENDMENT regime in silence and published a verdict naming the
    // wrong one — while the comment four lines above the ancestry test already
    // declared this exact case fail-closed. Against the previous code this test
    // does not throw at all.
    const { root, first } = await minimalRepo();
    const base = realGit(root);
    const failing: Git = (args) => (args[0] === "log" && args.includes("--diff-filter=A") ? { ok: false, out: "" } : base(args));
    await expect(
      collectAuditFacts(root, "r1", { preregFrozenCommit: first, preregPath: "prereg.json", gitRunner: failing })
    ).rejects.toThrow(/cannot be asked of this repository/);
  });

  it("does NOT refuse when that log succeeds EMPTY — a path with no introducing commit IS an answer", async () => {
    // The control that keeps the refusal from swallowing the lawful case. This
    // scratch repo carries neither amendment, so their `--diff-filter=A` logs
    // succeed with no lines, and that must stay "does not govern" — which is
    // what the prospective-governance tests below depend on.
    const { root, first } = await minimalRepo();
    await expect(
      collectAuditFacts(root, "r1", { preregFrozenCommit: first, preregPath: "prereg.json", gitRunner: realGit(root) })
    ).resolves.toBeDefined();
  });

  // `lastCommit`'s REFUSAL IS UNEXERCISED, and that is measured rather than
  // assumed. A test was written for it and asserted first that the fixture
  // reached the call at all; it reported `expected 0 to be greater than 0`. Both
  // of `lastCommit`'s call sites sit inside loops that need clause-5 offenders
  // or emission drift, and both are gated on an anchor derived from committed
  // observations — of which there are none pre-data, so `minimalRepo` cannot
  // reach them. The guard is in place and shares `orRefuse` with the
  // introducing-commit path proven above; what is missing is a fixture with
  // committed observations, and inventing one here would be a bigger change than
  // the guard it certifies. Recorded instead of dressed up: the first draft of
  // that test wrapped its assertion in `if (threw !== null)`, which passes
  // whether or not the path is reached and would have certified nothing.

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
    await expect(
      collectAuditFacts(root, "r1", { preregFrozenCommit: first, preregPath: "prereg.json", gitRunner: failing })
    ).rejects.toThrow(/drift cannot be inspected/);
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
   * amendment's clock turns on. `beforeAttestation` runs after the registration
   * commit and before the attestation, and may return a new commit to attest —
   * which is how the window between the first scored observation and the
   * attestation gets modelled at all. It used to be described as running "after
   * the emit"; there is no emit in this helper any more (R50).
   */
  async function operatorLoop(
    hooks: { seed?: (root: string) => Promise<void>; beforeAttestation?: (root: string) => Promise<string> } = {}
  ): Promise<{ root: string; registration: string; subject: string }> {
    const root = tempRoot();
    await fs.cp(FIXTURE, root, { recursive: true });
    initRepo(root);
    // The dependency tree clause 6 now checks against the subject commit
    // (R29): the scratch repo needs a real lockfile, and the attestation gets
    // its real hash.
    await fs.writeFile(path.join(root, "package-lock.json"), LOCKFILE_TEXT, "utf8");
    // Clause 5's emission item needs somewhere to be (R37): the fenced tool
    // files, born BEFORE the registration commit so they exist at the anchor.
    for (const rel of EMISSION_FENCED_FILES) {
      await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), FENCED_TOOL_TEXT, "utf8");
    }
    // Clause 6's FIRING item needs subject bytes to bind to, born BEFORE the
    // registration commit for the same reason the fences are: the artifact
    // claims a digest at its base commit, and the audit recomputes it there.
    for (const rel of FIRING_SUBJECTS) {
      await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), `export const subject = ${JSON.stringify(rel)};\n`, "utf8");
    }
    await hooks.seed?.(root);
    // Manifest B sealed in the SAME act as A — byte-identical blob, which is
    // what `open-b` will hold the real register to.
    await fs.copyFile(
      path.join(root, "evidence", "replay-01.b12.tasks.json"),
      path.join(root, "evidence", "replay-01.b12.manifest-B.tasks.json")
    );
    const registration = commitAll(root, "registration: fixture + both manifests");

    // 1. NOTHING. There is no first emit any more (R50).
    //
    // The old loop opened with a bare `emit` because the audit's freeze anchor
    // was read out of a COMMITTED counterfactual, which only `emit` writes.
    // That step is what forced TWO scoring invocations against a frozen PHASE 6
    // text that says ONE — and, because the pinned command carries `--audit`,
    // it also COMMITTED a `verdict:"void"` for a run that was not void.
    //
    // The anchor is now derived from the committed archive, so the audit needs
    // no prior emission and the loop is: attest -> commit -> audit -> commit ->
    // ONE pinned emit -> commit.
    const subject = (await hooks.beforeAttestation?.(root)) ?? registration;
    const attestation = attestationOf(subject, { runId: "replay-01", lockfileSha256: sha256(LOCKFILE_TEXT) });
    await fs.writeFile(
      path.join(root, "evidence", "replay-01.b12.suite.json"),
      JSON.stringify(attestation, null, 2) + "\n",
      "utf8"
    );
    // 2b. the firing matrix, on the SAME subject the attestation names. Clause
    // 6's frozen word is SHOWN FIRING, and the checks above it only establish
    // PASSING — a gutted control keeps its title and passes.
    const showAt = (rel: string): string => {
      const r = spawnSync("git", ["show", `${subject}:${rel}`], { cwd: root, encoding: "utf8" });
      return sha256(r.stdout ?? "");
    };
    const firing = {
      schema: "b12-firing/1" as const,
      baseCommit: subject,
      controlsEvaluated: CONTROL_TESTS.map(({ file, fullName }) => ({ file, fullName })),
      baseline: { allGreen: true, problems: [] },
      pairs: CONTROL_TESTS.map((control, i) => ({
        id: `m${i + 1}`,
        control: { file: control.file, fullName: control.fullName },
        fired: true,
        detail: "assertion failed inside the control's own body",
      })),
      subjects: FIRING_SUBJECTS.map((rel, i) => ({ id: `m${i + 1}`, path: rel, sha256AtBase: showAt(rel) })),
      problems: [],
      allFired: true,
    };
    await fs.writeFile(
      path.join(root, "evidence", "replay-01.b12.firing.json"),
      JSON.stringify(firing, null, 2) + "\n",
      "utf8"
    );
    commitAll(root, "suite attestation and firing matrix");
    return { root, registration, subject };
  }

  it("audit → commit → emit --audit lands gitAudit.ran === true with the clause check NOT fired", async () => {
    const { root, registration } = await operatorLoop();

    // 3. the audit, over COMMITTED state only.
    const facts = await collectAuditFacts(root, "replay-01", {
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
      final: boolean;
      archiveChecks: Array<{ clause: string; fired: boolean }>;
    };
    // R37#1 — the pre-data rule in PREMISES.md, now on the face: a verdict
    // emitted WITHOUT a committed clause 4-6 audit is not final. The
    // unchecked emit inside operatorLoop published one; this one is bound.
    expect(emitted.final).toBe(true);
    expect(result.final).toBe(true);
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
    const facts = await collectAuditFacts(root, "replay-01", {
      preregFrozenCommit: registration,
      preregPath: "evidence/replay-01.b12.tasks.json",
    });
    const { artifact } = buildAuditArtifact(facts);
    expect(artifact.verdict).toBe("clean");
    const auditRel = "evidence/replay-01.b12.audit.json";
    await fs.writeFile(path.join(root, auditRel), JSON.stringify(artifact, null, 2) + "\n", "utf8");
    commitAll(root, "the audit");
    // R50: a binding failure REFUSES now instead of publishing a downgraded
    // run, so the probe reports the refusal's reason rather than reading it off
    // an artifact that is no longer written. `ran` stays in the shape so the
    // clean case below still asserts the positive.
    const emit = async (): Promise<{ ran: boolean; problems: string[]; unchecked: string[] }> => {
      let out;
      try {
        out = await emitRun(root, "replay-01", {
          auditPath: auditRel,
          auditCollectorOptions: { preregFrozenCommit: registration, preregPath: "evidence/replay-01.b12.tasks.json" },
        });
      } catch (error) {
        if (!(error instanceof EmitRefused)) throw error;
        // No "nothing was written" assertion HERE on purpose: this probe runs
        // several times and the FIRST call succeeds, so the artifacts of that
        // clean emission are legitimately still on disk. The write-nothing
        // property is asserted where it can be asserted cleanly — in the
        // dedicated refusal tests, against a root that never emitted.
        return { ran: false, problems: [error.message], unchecked: ["clause 4", "clause 5", "clause 6"] };
      }
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

    const flipped = await collectAuditFacts(root, "replay-01", {
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

    const drifted = await collectAuditFacts(root, "replay-01", {
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
  // R37: clause 5's FOURTH item — "gate's or repair's telemetry emission" —
  // which `PINNED_PATHS` structurally could not reach. `src/cost/**` pins the
  // emission LIFECYCLE; the ROW is built in `src/tools/**`.
  // -------------------------------------------------------------------------

  it("clause 5 sees gate's telemetry emission MOVE, and the pinned paths never could", async () => {
    const rel = "src/tools/gate.ts";
    // The edit lands BEFORE the attestation and IS the commit attested, so
    // clause 6's non-evidence drift cannot stand in for the reason under test.
    const { root, registration } = await operatorLoop({
      beforeAttestation: async (r) => {
        const before = await fs.readFile(path.join(r, rel), "utf8");
        // WHAT THE ROW MEANS, not where it lives: `turns_collapsed` IS the
        // credited saving's definition. Nothing under `evidence/`,
        // `src/cost/**`, `src/telemetry.ts` or `scripts/b12-run.mjs` moves.
        await fs.writeFile(
          path.join(r, rel),
          before.replace("turns_collapsed: 0", "turns_collapsed: 99"),
          "utf8"
        );
        return commitAll(r, "the emission's MEANING, edited after the first scored observation");
      },
    });
    const opts = { preregFrozenCommit: registration, preregPath: "evidence/replay-01.b12.tasks.json" };

    // THE DAMAGE, on these same bytes. With the fence unread — which is what
    // this audit did until R37 — the path probe has nothing to say and the run
    // audits CLEAN, while every scored observation's saving was redefined
    // underneath it.
    const blind = await collectAuditFacts(root, "replay-01", { ...opts, emissionFencedFiles: [] });
    expect(blind.clause5.offenders).toEqual([]);
    expect(decideAudit(blind).verdict).toBe("clean");

    // With the fence: an offender no PATH can name, and a void that says so.
    const seen = await collectAuditFacts(root, "replay-01", opts);
    expect(seen.clause5.offenders).toEqual([]); // still none — that IS the finding
    expect(seen.clause5.emission.drifted).toHaveLength(1);
    expect(seen.clause5.emission.drifted[0]).toMatch(/src\/tools\/gate\.ts$/);
    expect(seen.clause5.emission.excused).toEqual([]); // nothing was re-emitted
    const verdict = decideAudit(seen);
    expect(verdict.verdict).toBe("void");
    expect(verdict.reasons.join(" ")).toMatch(/moved gate's or repair's telemetry emission/);
  }, 60_000);

  it("the same file edited OUTSIDE the fence stays clean — the tools are the subject, not the instrument", async () => {
    const rel = "src/tools/repair.ts";
    const { root, registration } = await operatorLoop({
      beforeAttestation: async (r) => {
        const before = await fs.readFile(path.join(r, rel), "utf8");
        await fs.writeFile(
          path.join(r, rel),
          before
            .replace("export const standIn = 1;", "export const standIn = 2;")
            // AND a comment rewritten INSIDE the fence. The canonical digest
            // drops whole-line comments on purpose: hashing prose would void a
            // paid run over a typo fix, and prose is not the measurement.
            .replace("// PROSE, inside the fence", "// PROSE, rewritten in place"),
          "utf8"
        );
        return commitAll(r, "the tool edited outside its emission, and prose rewritten inside it");
      },
    });
    const facts = await collectAuditFacts(root, "replay-01", {
      preregFrozenCommit: registration,
      preregPath: "evidence/replay-01.b12.tasks.json",
    });
    // THE BOUNDARY, pinned in the other direction so nobody later "simplifies"
    // the fence into a whole-file pin: freezing the tools would freeze what the
    // experiment measures, and clause 5 does not ask for that.
    expect(facts.clause5.emission.drifted).toEqual([]);
    expect(decideAudit(facts).verdict).toBe("clean");
    // Reported either way, so a reader can see the fence held rather than
    // infer it from silence.
    expect(facts.clause5.emission.atHead).toHaveLength(EMISSION_FENCED_FILES.length);
    expect(facts.clause5.emission.atHead.every((e) => e.sha256 !== null)).toBe(true);
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

  it("the committed counterfactual no longer touches the anchor — emptied OR corrupt, clause 5 still fires (R50)", async () => {
    // WHAT R29 WAS ABOUT, CARRIED FORWARD. The anchor used to walk
    // `counterfactual.observations`, a list written by the EMITTER that nothing
    // proved covered the committed evidence — so an early unchecked emit
    // followed by more observations left a stale one committed, the audit read
    // "nothing scored yet, sources FREE" over a run that HAD scored, and a
    // pinned-path change after the real first observation got a CLEAN audit.
    //
    // Under the one-invocation regime the anchor comes from the committed
    // ARCHIVE, scored in a detached checkout of HEAD. So the whole class is
    // gone rather than guarded: this test now proves the counterfactual is
    // INERT. It is destroyed twice over — emptied of observations AND left
    // unparseable — and the audit must still find the anchor and still void on
    // the pinned path touched after the first score.
    //
    // The old assertion was `anchor === null`. That the SAME repository now
    // yields a real anchor from bytes that used to erase it is the measurement.
    const cfRel = "evidence/replay-01.b12.counterfactual.json";
    const { root, registration } = await operatorLoop({
      beforeAttestation: async (r) => {
        // A counterfactual that is pure garbage — and, under the one-invocation
        // loop, one that was never emitted in the first place. Either way the
        // anchor must not care.
        await fs.writeFile(path.join(r, cfRel), "{not json — and it does not matter\n", "utf8");
        await fs.mkdir(path.join(r, "src", "cost"), { recursive: true });
        await fs.writeFile(path.join(r, "src", "cost", "hostile.ts"), "export const x = 1;\n", "utf8");
        return commitAll(r, "a garbage counterfactual, and a pinned path touched after the first score");
      },
    });

    const facts = await collectAuditFacts(root, "replay-01", {
      preregFrozenCommit: registration,
      preregPath: "evidence/replay-01.b12.tasks.json",
    });
    expect(facts.clause5.anchorProblems).toEqual([]);
    expect(facts.clause5.anchor).not.toBeNull(); // derived from the ARCHIVE, not from those bytes
    const { verdict, reasons } = decideAudit(facts);
    expect(verdict).toBe("void"); // and the real defect — the pinned path — still fires
    expect(reasons.join(" ")).toMatch(/clause 5/);
    expect(facts.clause5.offenders.length).toBeGreaterThan(0);
    // The old failure mode must not come back under any spelling.
    expect(facts.clause5.anchorProblems.join(" ")).not.toMatch(/counterfactual/);
  }, 120_000);

  it("a failing MANDATORY probe REFUSES — a checkout that cannot be made is not an anchorless run", async () => {
    // R32, carried forward to the probe that is now mandatory. The rule is the
    // one that must never invert: a refusal writes NO artifact and is
    // retryable; a VOID is a committable verdict that kills a paid run.
    // Transient git may not spend the run.
    //
    // The old mandatory probe was `ls-tree -d` over the observation
    // directories. The new one is the detached checkout itself — if it cannot
    // be created, the audit has no committed archive to score and must say so
    // rather than report an absent anchor.
    const { root, registration } = await operatorLoop();
    const collector = { preregFrozenCommit: registration, preregPath: "evidence/replay-01.b12.tasks.json" };
    const base: Git = (args) => {
      const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      return { ok: r.status === 0, out: r.stdout ?? "" };
    };
    // ONLY the worktree creation. Blinding more would let some other refusal
    // stand in for this one and the control would pass against the defect.
    const failing: Git = (args) =>
      args[0] === "worktree" && args[1] === "add" ? { ok: false, out: "" } : base(args);

    // Unwrapped, this repository audits without refusing at all…
    await expect(collectAuditFacts(root, "replay-01", collector)).resolves.toBeDefined();
    // …and with the mandatory probe blinded it REFUSES, by its own name.
    let thrown: unknown = null;
    try {
      await collectAuditFacts(root, "replay-01", { ...collector, gitRunner: failing });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AuditRefused);
    expect(String(thrown)).toMatch(/detached worktree/);
    // A refusal, never a verdict about the run.
    expect(String(thrown)).not.toMatch(/does not parse/);
  }, 120_000);

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
    const { artifact } = buildAuditArtifact(await collectAuditFacts(root, "replay-01", collector));
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
    // R50: this used to DOWNGRADE — publish the run with gitAudit.ran false
    // and the refusal in archiveProblems. A forged audit therefore still
    // produced a committed result.json. It now refuses and writes nothing.
    const attempt = emitRun(root, "replay-01", { auditPath: auditRel, auditCollectorOptions: collector });
    await expect(attempt).rejects.toThrow(EmitRefused);
    await expect(
      emitRun(root, "replay-01", { auditPath: auditRel, auditCollectorOptions: collector })
    ).rejects.toThrow(/clause5\.anchor\.taskId does not survive re-derivation/);
    for (const rel of runEmittedArtifacts("replay-01")) {
      await expect(fs.access(path.join(root, rel))).rejects.toThrow();
    }
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
    const { artifact } = buildAuditArtifact(await collectAuditFacts(root, "replay-01", collector));
    expect(artifact.verdict).toBe("void");
    await fs.writeFile(
      path.join(root, auditRel),
      JSON.stringify({ ...artifact, verdict: "clean", reasons: [] }, null, 2) + "\n",
      "utf8"
    );
    commitAll(root, "hostile: the verdict rewritten");
    await expect(
      emitRun(root, "replay-01", { auditPath: auditRel, auditCollectorOptions: collector })
    ).rejects.toThrow(
      /says clean and re-deriving it here says void — the verdict was not produced by these facts/
    );
    for (const rel of runEmittedArtifacts("replay-01")) {
      await expect(fs.access(path.join(root, rel))).rejects.toThrow();
    }
  }, 60_000);

  it("the amendment, born BEFORE the anchor, puts the conformance files under clause 5", async () => {
    const { root, registration, subject } = await operatorLoop({
      seed: seedConformance(true),
      beforeAttestation: gutTheControl,
    });
    const facts = await collectAuditFacts(root, "replay-01", {
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
    const facts = await collectAuditFacts(root, "replay-01", {
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

  it("a committed observation the scorer produces NO TERMS for is an anchor problem, not an invisible one", async () => {
    // THE REGRESSION CONTROL FOR R50's OWN REPAIR, and it is here because the
    // review found the defect rather than because I predicted it.
    //
    // R29's old guard compared the counterfactual's declared directories
    // against the committed ones in BOTH directions. Deriving the anchor from
    // the archive deleted that comparison, and `assembleRun` emits a
    // counterfactual observation only where TERMS exist — so a committed
    // `obs-*` directory that decodes but yields no terms (a declaration
    // failure) simply vanished from the population the anchor walks. The
    // anchor would then be the first observation that DID score, which can be
    // LATER than the run's real first execution, and a pinned-path edit in
    // between would escape clause 5 entirely.
    //
    // The fixture gets a SECOND observation directory whose `observation.json`
    // is unreadable — `record === null` is one of the declared no-terms paths.
    // Against the unrepaired derivation this test passes silently with a clean
    // anchor on t1; the guard is what makes it fail.
    const { root, registration } = await operatorLoop({
      seed: async (r) => {
        const from = path.join(r, "evidence", "replay-01", "obs-t1-treatment");
        const to = path.join(r, "evidence", "replay-01", "obs-t2-treatment");
        await fs.cp(from, to, { recursive: true });
        await fs.writeFile(path.join(to, "observation.json"), "{ this does not parse", "utf8");
      },
    });

    const facts = await collectAuditFacts(root, "replay-01", {
      preregFrozenCommit: registration,
      preregPath: "evidence/replay-01.b12.tasks.json",
    });
    expect(facts.clause5.anchorProblems.join(" ")).toMatch(/obs-t2-treatment/);
    expect(facts.clause5.anchorProblems.join(" ")).toMatch(/the scorer produced no terms for/);
    // Fail-closed: no anchor, and that is a VOID rather than a freedom.
    expect(facts.clause5.anchor).toBeNull();
    expect(decideAudit(facts).verdict).toBe("void");
  }, 120_000);

  // MOVED HERE FROM ITS OWN describe (R50). It needs a real emission, and an
  // emission now needs a committed audit — which is what `operatorLoop` and the
  // three steps below build. The control itself is unchanged in substance: the
  // re-emission escape's population must be EXACTLY the emission's write list.
  it("the re-emission escape's population is EXACTLY what the emission creates", async () => {
    const { root, registration } = await operatorLoop();
    const collector = { preregFrozenCommit: registration, preregPath: "evidence/replay-01.b12.tasks.json" };
    const { artifact } = buildAuditArtifact(await collectAuditFacts(root, "replay-01", collector));
    await fs.writeFile(
      path.join(root, "evidence", "replay-01.b12.audit.json"),
      JSON.stringify(artifact, null, 2) + "\n",
      "utf8"
    );
    commitAll(root, "the audit");

    const evidenceDir = path.join(root, "evidence");
    const listing = async (): Promise<Set<string>> => new Set(await fs.readdir(evidenceDir));
    const before = await listing();
    const emitted = await emitRun(root, "replay-01", {
      auditPath: "evidence/replay-01.b12.audit.json",
      scoringCommandActual: "node dist/cost/b12/emit.js replay-01",
      auditCollectorOptions: collector,
    });
    const created = [...(await listing())].filter((f) => !before.has(f)).sort();

    // AND BOTH ARTIFACTS ARE WRITTEN EVEN THOUGH THE RUN IS A VOID. That
    // pairing used to be asserted in b12-archive.test.ts through a bare
    // `emitRun`; when the emission gate closed, that test dropped to
    // `assembleRun` and stopped proving anything about the WRITE. The review
    // called that a real loss of coverage, and this is where it belongs now —
    // the fixture is 1 admitted of 20, the arithmetic's own void.
    expect(emitted.verdict).toBe("void");
    expect(emitted.final).toBe(true); // void, and audited: a verdict, not an intermediate
    for (const p of [emitted.resultPath, emitted.counterfactualPath]) {
      await expect(fs.access(p)).resolves.toBeUndefined();
    }

    // A third emitted artifact, or one that stopped being written, breaks this
    // — which is the whole point. R24 already paid for naming files by hand.
    expect(created).toEqual(runEmittedArtifacts("replay-01").map((r) => path.basename(r)).sort());
  }, 120_000);
});

// ---------------------------------------------------------------------------
// R37#4 — clause 5's re-emission escape asked about TWO HARD-CODED PATHS. The
// frozen quantifier is "every existing evidence/ artifact for the run being
// re-emitted from the archive"; read literally over the frozen inventory it is
// unsatisfiable (the two manifests are sealed create-only, and a commit
// touching manifest A is its own VOID), so the reading applied is "what
// re-emission PRODUCES". What is fixed here is the disconnection: the escape's
// population is now the emission's own write list, and this control fires the
// moment those two drift apart.
// ---------------------------------------------------------------------------

describe("the re-emission escape's population", () => {
  // The population control itself moved into the e2e describe, where a real
  // emission can be produced — an emission now requires a committed audit.
  it("and the READING is on the artifact's face, not only in a comment", () => {
    // A rule a replayer cannot see is a rule only its author can check.
    expect(AUDIT_INPUT_KEYS).toContain("clause5.reemission.population");
    expect(AUDIT_INPUT_KEYS).toContain("clause5.reemission.reading");
  });
});

// ---------------------------------------------------------------------------
// R37#1 said a verdict emitted without a committed audit is NOT FINAL, and made
// the emission SAY so. R50 goes further and stops it happening: the pre-data
// rule in PREMISES.md is that "the scoring invocation requires a COMMITTED
// clause 4–6 audit artifact", and an invocation that cannot satisfy its own
// precondition should not produce a verdict to qualify.
//
// This describe used to assert the opposite — that the CLI permits the bare
// form and the rule qualifies it. That permission is what committed a
// provisional void under the old two-emit loop, and what let a NOT-FINAL
// open verdict reach open-b.
// ---------------------------------------------------------------------------

describe("an emission without a committed audit", () => {
  it("REFUSES, and writes nothing at all", async () => {
    const root = tempRoot();
    await fs.cp(FIXTURE, root, { recursive: true });
    initRepo(root);

    await expect(emitRun(root, "replay-01")).rejects.toThrow(EmitRefused);
    await expect(emitRun(root, "replay-01")).rejects.toThrow(/no --audit was given/);

    // NOTHING WAS WRITTEN. The refusal is only worth having if it is silent on
    // disk — a half-written artifact would be the same hazard under a new name.
    for (const rel of runEmittedArtifacts("replay-01")) {
      await expect(fs.access(path.join(root, rel))).rejects.toThrow();
    }
  }, 60_000);

  it("REFUSES an audit that is named but not committed", async () => {
    const root = tempRoot();
    await fs.cp(FIXTURE, root, { recursive: true });
    initRepo(root);
    const auditPath = "evidence/replay-01.b12.audit.json";

    // Named, absent.
    await expect(emitRun(root, "replay-01", { auditPath })).rejects.toThrow(EmitRefused);

    // Present in the working tree, never committed — a fabrication.
    await fs.writeFile(
      path.join(root, auditPath),
      JSON.stringify({ ran: true, verdict: "clean", reasons: [], inputs: { head: "x" } }),
      "utf8"
    );
    await expect(emitRun(root, "replay-01", { auditPath })).rejects.toThrow(/not committed evidence/);

    for (const rel of runEmittedArtifacts("replay-01")) {
      await expect(fs.access(path.join(root, rel))).rejects.toThrow();
    }
  }, 60_000);
});

/**
 * Clause 6's frozen word is SHOWN FIRING. Every check that predates these is
 * about the six controls PASSING, which is strictly weaker: a control gutted to
 * assert nothing keeps its title and passes. R38#2 — implementing the word the
 * clause already uses is a correction, so none of these is a seventh condition
 * and `voidConditions` gains no entry.
 */
describe("clause 6 — the word FIRING", () => {
  const firingReason = (facts: AuditFacts): string[] =>
    decideAudit(facts).reasons.filter((r) => r.startsWith("clause 6:"));

  it("is CLEAN when every control was shown firing on the attested tree", () => {
    expect(decideAudit(factsOf()).verdict).toBe("clean");
  });

  it("VOIDS when there is no committed firing evidence at all", () => {
    const facts = factsOf();
    const out = decideAudit({ ...facts, clause6: { ...facts.clause6, firing: null, firingSubjectsAtBase: [] } });
    expect(out.verdict).toBe("void");
    expect(out.reasons.join(" ")).toContain("PASSING but not FIRING");
    expect(out.reasons.join(" ")).toContain("a gutted control passes");
  });

  it("VOIDS, naming the pair, when one control did not fire", () => {
    const facts = factsOf();
    const pairs = firingOf("s".repeat(40)).pairs.map((p, i) =>
      i === 2 ? { ...p, fired: false, detail: "the control is passed under its own mutation — it did not fire" } : p
    );
    const out = decideAudit({
      ...facts,
      clause6: { ...facts.clause6, firing: firingOf("s".repeat(40), { pairs, allFired: false }) },
    });
    expect(out.verdict).toBe("void");
    expect(firingReason(facts).length).toBe(0); // the DEFAULT facts carry no clause-6 reason
    expect(out.reasons.join(" ")).toContain("NOT shown firing under m3");
  });

  it("VOIDS when the matrix ran on a tree the attestation does not name", () => {
    const facts = factsOf();
    const out = decideAudit({
      ...facts,
      clause6: { ...facts.clause6, firing: firingOf("z".repeat(40)) },
    });
    expect(out.verdict).toBe("void");
    expect(out.reasons.join(" ")).toContain("not the one attested");
  });

  it("VOIDS when the matrix skipped a control the clause requires", () => {
    // R39#1: `allFired` quantifies over the control list the HARNESS was
    // handed, so a five-control matrix is still allFired:true. The six-ness is
    // decided here, where CONTROL_TESTS lives.
    const facts = factsOf();
    const short = firingOf("s".repeat(40));
    const out = decideAudit({
      ...facts,
      clause6: {
        ...facts.clause6,
        firing: { ...short, controlsEvaluated: short.controlsEvaluated.slice(1), pairs: short.pairs.slice(1) },
      },
    });
    expect(out.verdict).toBe("void");
    expect(out.reasons.join(" ")).toContain("never evaluated a required control");
  });

  it("VOIDS when the matrix evaluated something the clause does not list", () => {
    const facts = factsOf();
    const base = firingOf("s".repeat(40));
    const out = decideAudit({
      ...facts,
      clause6: {
        ...facts.clause6,
        firing: {
          ...base,
          controlsEvaluated: [...base.controlsEvaluated, { file: "tests/cost-meter.test.ts", fullName: "a stranger" }],
        },
      },
    });
    expect(out.verdict).toBe("void");
    expect(out.reasons.join(" ")).toContain("a control the clause does not list");
  });

  it("VOIDS when the evidence's claimed subject bytes are not the bytes its base commit carries", () => {
    // R29's question asked of the second producer: an artifact nobody
    // recomputes can name any tree it likes.
    const facts = factsOf();
    const out = decideAudit({
      ...facts,
      clause6: {
        ...facts.clause6,
        firingSubjectsAtBase: firingSubjectsAgreeing().map((s, i) =>
          i === 0 ? { ...s, recomputed: "k".repeat(64) } : s
        ),
      },
    });
    expect(out.verdict).toBe("void");
    expect(out.reasons.join(" ")).toContain("did not run against the bytes it names");
  });

  it("VOIDS an artifact that names no subject bytes at all — it binds to nothing", () => {
    const facts = factsOf();
    const out = decideAudit({
      ...facts,
      clause6: {
        ...facts.clause6,
        firing: firingOf("s".repeat(40), { subjects: [] }),
        firingSubjectsAtBase: [],
      },
    });
    expect(out.verdict).toBe("void");
    expect(out.reasons.join(" ")).toContain("cannot say WHICH tree the controls fired on");
  });

  it("VOIDS when the unmutated baseline was not green", () => {
    const facts = factsOf();
    const out = decideAudit({
      ...facts,
      clause6: {
        ...facts.clause6,
        firing: firingOf("s".repeat(40), { baseline: { allGreen: false, problems: ["baseline: x is failed"] } }),
      },
    });
    expect(out.verdict).toBe("void");
    expect(out.reasons.join(" ")).toContain("proves nothing by going red");
  });

  it("VOIDS on a problem the harness itself reported", () => {
    const facts = factsOf();
    const out = decideAudit({
      ...facts,
      clause6: {
        ...facts.clause6,
        firing: firingOf("s".repeat(40), { problems: ["duplicate mutation id \"m1\""] }),
      },
    });
    expect(out.verdict).toBe("void");
    expect(out.reasons.join(" ")).toContain("duplicate mutation id");
  });

  it("publishes the firing pairs and both subject digests as canonical inputs", () => {
    const inputs = auditInputs(factsOf());
    expect(inputs["clause6.firingPath"]).toBe("evidence/replay-01.b12.firing.json");
    expect(inputs["clause6.firingPairs"]).toContain("m1=fired");
    expect(inputs["clause6.firingSubjects"]).toContain("src/cost/subject-1.ts");
    // REPORTED, DECIDING NOTHING: absent in the default facts, and its absence
    // is not a reason — an artifact written before the field existed is not
    // thereby void, and WHICH platform is entitled is the owed amendment.
    expect(inputs["clause6.firingToolchain"]).toBe("(none)");
    expect(decideAudit(factsOf()).verdict).toBe("clean");
    const withTool = factsOf();
    const shown = auditInputs({
      ...withTool,
      clause6: {
        ...withTool.clause6,
        firing: firingOf("s".repeat(40), { toolchain: { platform: "darwin", arch: "arm64", nodeVersion: "v22.0.0", vitest: "4.1.10" } }),
      },
    });
    expect(shown["clause6.firingToolchain"]).toBe("darwin arm64 v22.0.0 4.1.10");
  });

  it("VOIDS a forged matrix that lists the six and reports on NONE of them", () => {
    // R41#1: `controlsEvaluated` full, `pairs: []` — every loop stays quiet and
    // allFired:true survives, so a matrix that ran nothing read CLEAN.
    const facts = factsOf();
    const out = decideAudit({
      ...facts,
      clause6: {
        ...facts.clause6,
        firing: firingOf("s".repeat(40), { pairs: [], subjects: [] }),
        firingSubjectsAtBase: [],
      },
    });
    expect(out.verdict).toBe("void");
    expect(out.reasons.join(" ")).toContain("no pair reports on a required control");
  });

  it("VOIDS when one control is judged twice, or a pair id repeats", () => {
    const facts = factsOf();
    const base = firingOf("s".repeat(40));
    const first = base.pairs[0];
    if (first === undefined) throw new Error("the fixture must carry pairs");
    const twice = decideAudit({
      ...facts,
      clause6: { ...facts.clause6, firing: { ...base, pairs: [...base.pairs, { ...first, id: "m7" }] } },
    });
    expect(twice.reasons.join(" ")).toContain("cannot be judged twice");
    const dupId = decideAudit({
      ...facts,
      clause6: { ...facts.clause6, firing: { ...base, pairs: [...base.pairs, first] } },
    });
    expect(dupId.reasons.join(" ")).toContain("repeats a pair id");
  });

  it("treats MALFORMED committed evidence as no evidence, and never throws on it", () => {
    // R41#2: shallow validation let a missing `baseline` or a null row reach the
    // decider, where it threw. An audit that throws on hostile input is an audit
    // hostile input can silence.
    expect(isFiringEvidence(null)).toBe(false);
    expect(isFiringEvidence({ schema: "b12-firing/1", baseCommit: "x", controlsEvaluated: [], pairs: [], subjects: [] })).toBe(false);
    const good = firingOf("s".repeat(40));
    expect(isFiringEvidence(good)).toBe(true);
    for (const broken of [
      { ...good, baseline: undefined },
      { ...good, pairs: [null] },
      { ...good, subjects: [{ id: "m1" }] },
      { ...good, controlsEvaluated: [{ file: "x" }] },
      { ...good, allFired: "yes" },
    ]) {
      expect(isFiringEvidence(broken)).toBe(false);
      const facts = factsOf();
      expect(() =>
        decideAudit({ ...facts, clause6: { ...facts.clause6, firing: broken as never } })
      ).not.toThrow();
    }
  });
});

describe("the run toolchain identity — the pre-data amendment's reader", () => {
  it("reads the PRODUCERS' shape, including vitest's display string", () => {
    // The firing artifact stores vitest as "vitest/4.1.10 win32-x64 node-v24.16.0",
    // which embeds the platform and the node version a SECOND time. A reader that
    // grabbed the first number it saw would make one field disagree with itself.
    const r = normaliseToolchain({
      platform: "win32",
      arch: "x64",
      nodeVersion: "v24.16.0",
      vitest: "vitest/4.1.10 win32-x64 node-v24.16.0",
    });
    expect(r.known).toBe(true);
    if (!r.known) throw new Error("unreachable");
    expect(r.id).toEqual({ platform: "win32", arch: "x64", node: "24.16", vitest: "4.1" });
  });

  it("reads the MANIFEST's declared shape too, so one comparison spans both", () => {
    const r = normaliseToolchain({ platform: "darwin", arch: "arm64", node: "24.16", vitest: "4.1" });
    expect(r.known).toBe(true);
    if (!r.known) throw new Error("unreachable");
    expect(r.id).toEqual({ platform: "darwin", arch: "arm64", node: "24.16", vitest: "4.1" });
  });

  it("IGNORES patch versions, which is the amendment's reasoning and not a shortcut", () => {
    // Including the patch would let a node bump block a run at the barrier —
    // reintroducing exactly the irrelevant-difference problem that made VOIDING
    // on mismatch unattractive. If this test ever goes red, read the amendment
    // before "fixing" it.
    const a = normaliseToolchain({ platform: "darwin", arch: "arm64", nodeVersion: "v24.16.0", vitest: "vitest/4.1.10" });
    const b = normaliseToolchain({ platform: "darwin", arch: "arm64", nodeVersion: "v24.16.9", vitest: "vitest/4.1.99" });
    expect(toolchainAgreement(a, b)).toEqual({ verdict: "match" });
  });

  it("an absent or malformed identity is UNKNOWN and is NEVER a match", () => {
    for (const bad of [undefined, null, {}, "darwin", 42, [], { platform: "darwin" }, { platform: "", arch: "arm64", node: "24.16", vitest: "4.1" }]) {
      const r = normaliseToolchain(bad);
      expect(r.known, `${JSON.stringify(bad)} must not read as known`).toBe(false);
      const known = normaliseToolchain({ platform: "darwin", arch: "arm64", node: "24.16", vitest: "4.1" });
      // Unknown on EITHER side, and in BOTH directions.
      expect(toolchainAgreement(known, r).verdict).toBe("unknown");
      expect(toolchainAgreement(r, known).verdict).toBe("unknown");
    }
  });

  it("names WHICH field disagreed, because 'something disagreed' is not actionable", () => {
    const declared = normaliseToolchain({ platform: "darwin", arch: "arm64", node: "24.16", vitest: "4.1" });
    const observed = normaliseToolchain({ platform: "win32", arch: "x64", node: "24.16", vitest: "4.1" });
    const a = toolchainAgreement(declared, observed);
    expect(a.verdict).toBe("mismatch");
    if (a.verdict !== "mismatch") throw new Error("unreachable");
    expect(a.differences.join(" ")).toMatch(/platform: declared darwin, observed win32/);
    expect(a.differences.join(" ")).toMatch(/arch: declared arm64, observed x64/);
    expect(a.differences).toHaveLength(2);
    expect(agreementLabel(a)).toMatch(/^MISMATCH \[/);
  });

  it("THE CASE THE AMENDMENT EXISTS FOR: win32 firing against a darwin run", () => {
    // Two proofs from one wrong machine agree with EACH OTHER perfectly, which
    // is why the reference is the run's DECLARED identity and not a relation
    // between the two artifacts.
    const declared = normaliseToolchain({ platform: "darwin", arch: "arm64", node: "24.16", vitest: "4.1" });
    const winFiring = normaliseToolchain({ platform: "win32", arch: "x64", nodeVersion: "v24.16.0", vitest: "vitest/4.1.10" });
    const winSuite = normaliseToolchain({ platform: "win32", arch: "x64", nodeVersion: "v24.16.0", vitest: "vitest/4.1.10" });
    expect(toolchainAgreement(winFiring, winSuite)).toEqual({ verdict: "match" });
    expect(toolchainAgreement(declared, winFiring).verdict).toBe("mismatch");
    expect(toolchainAgreement(declared, winSuite).verdict).toBe("mismatch");
  });

  it("the unknown label carries its REASON onto the audit's face", () => {
    // A reader who cannot tell whether a run was checked will assume it was.
    expect(toolchainLabel(normaliseToolchain(undefined))).toBe("(unknown: no toolchain object)");
    expect(agreementLabel({ verdict: "unknown", why: "no firing artifact" })).toBe("unknown (no firing artifact)");
    expect(toolchainLabel({ known: true, id: { platform: "darwin", arch: "arm64", node: "24.16", vitest: "4.1" } })).toBe(
      "darwin-arm64 node-24.16 vitest-4.1"
    );
  });

  it("the amendment's keys REACH THE ARTIFACT — the trap clause5's rule fell into", () => {
    // clause5.repairRoundsAmendment was computed, stored, and never serialized,
    // so every consumer read an absent key and the rule could not fire on any
    // real run. auditInputs' key-set equality is what makes that impossible here.
    const inputs = auditInputs(factsOf());
    expect(inputs["clause6.toolchainAmendment.governs"]).toBe("yes");
    expect(inputs["clause6.runToolchain.declared"]).toBe("darwin-arm64 node-24.16 vitest-4.1");
    expect(inputs["clause6.runToolchain.agreement"]).toBe("firing=match; suite=match");
  });

  it("a MISMATCH is published and still decides NOTHING — the amendment adds no void", () => {
    const declared = { known: true as const, id: DEFAULT_TOOLCHAIN };
    const win = normaliseToolchain({ platform: "win32", arch: "x64", nodeVersion: "v24.16.0", vitest: "vitest/4.1.10" });
    const base = factsOf();
    const facts = factsOf({
      clause6: {
        ...base.clause6,
        runToolchain: {
          declared,
          firing: win,
          suite: win,
          firingAgreement: toolchainAgreement(declared, win),
          suiteAgreement: toolchainAgreement(declared, win),
        },
      },
    });
    const inputs = auditInputs(facts);
    expect(inputs["clause6.runToolchain.agreement"]).toMatch(/firing=MISMATCH/);
    expect(inputs["clause6.runToolchain.agreement"]).toMatch(/suite=MISMATCH/);
    // The verdict is UNMOVED. If this ever goes red, someone has turned the
    // report into a rule, which is precisely what the owner declined.
    expect(decideAudit(facts).verdict).toBe(decideAudit(base).verdict);
  });
});

describe("the run-toolchain BARRIER — refuses, never voids", () => {
  const declared = { platform: "darwin", arch: "arm64", node: "24.16", vitest: "4.1" };
  const macNow = { platform: "darwin", arch: "arm64", nodeVersion: "v24.16.0", vitest: "vitest/4.1.10 darwin-arm64 node-v24.16.0" };
  const winNow = { platform: "win32", arch: "x64", nodeVersion: "v24.16.0", vitest: "vitest/4.1.10 win32-x64 node-v24.16.0" };

  it("an UNDECLARED runToolchain is not a violation — the amendment does not reach it", () => {
    // Pre-amendment manifests exist and are not thereby unusable.
    expect(runToolchainRefusal({}, winNow)).toBeNull();
    expect(runToolchainRefusal({ runToolchain: undefined }, winNow)).toBeNull();
    expect(runToolchainRefusal(null, winNow)).toBeNull();
  });

  it("a DECLARED but unreadable identity REFUSES — silence is not agreement", () => {
    for (const bad of ["darwin", 42, {}, { platform: "darwin" }, []]) {
      const why = runToolchainRefusal({ runToolchain: bad }, macNow);
      expect(why, `${JSON.stringify(bad)} must refuse`).not.toBeNull();
      expect(why!).toMatch(/not readable|never a match/);
    }
  });

  it("matching toolchain passes; a mismatched one refuses and NAMES the fields", () => {
    expect(runToolchainRefusal({ runToolchain: declared }, macNow)).toBeNull();
    const why = runToolchainRefusal({ runToolchain: declared }, winNow);
    expect(why).not.toBeNull();
    expect(why!).toMatch(/toolchain mismatch on platform, arch/);
    // The operator must be told this costs no attempt, or they will treat a
    // refusal like a void and burn one of three attempts avoiding it.
    expect(why!).toMatch(/REFUSING BEFORE SPENDING/);
    expect(why!).toMatch(/not a VOID and costs no attempt/);
  });

  it("an UNREADABLE machine refuses rather than spending a session it cannot name", () => {
    const why = runToolchainRefusal({ runToolchain: declared }, { platform: "darwin", arch: "arm64" });
    expect(why).not.toBeNull();
    expect(why!).toMatch(/could not be read/);
  });

  it("THE BARRIER AND THE AUDIT MUST NORMALISE IDENTICALLY", () => {
    // Two readers, two files, one rule. If they drift, the barrier passes runs
    // the audit then reports as mismatched — the worst of both, and silent.
    for (const raw of [macNow, winNow, declared, { platform: "linux", arch: "x64", node: "22.9", vitest: "3.2.1" }]) {
      const fromBarrier = normaliseToolchainForBarrier(raw);
      const fromAudit = normaliseToolchain(raw);
      expect(fromAudit.known, `${JSON.stringify(raw)}`).toBe(true);
      if (!fromAudit.known) throw new Error("unreachable");
      expect(fromBarrier).toEqual(fromAudit.id);
    }
    // ...and they must agree on what is UNREADABLE, too.
    for (const bad of [undefined, null, {}, "x", { platform: "darwin" }]) {
      expect(normaliseToolchainForBarrier(bad)).toBeNull();
      expect(normaliseToolchain(bad).known).toBe(false);
    }
  });

  it("a patch bump does NOT refuse — the reason the barrier was chosen over a void", () => {
    const patched = { platform: "darwin", arch: "arm64", nodeVersion: "v24.16.99", vitest: "vitest/4.1.99" };
    expect(runToolchainRefusal({ runToolchain: declared }, patched)).toBeNull();
  });
});

describe("the toolchain readers, after adversarial review of dd9b2d9", () => {
  it("a MALFORMED vitest must not borrow the NODE version out of the same string", () => {
    // Found by review. The display string embeds node, so the old unanchored
    // fallback read "vitest/not-a-version win32-x64 node-v24.16.0" as vitest
    // 24.16 — a malformed field passing as a valid identity, and matching a
    // declaration of 24.16. This is the self-disagreement the reader exists to
    // prevent, so it is a control, not a preference.
    const poisoned = { platform: "win32", arch: "x64", nodeVersion: "v24.16.0", vitest: "vitest/not-a-version win32-x64 node-v24.16.0" };
    expect(normaliseToolchain(poisoned).known).toBe(false);
    expect(normaliseToolchainForBarrier(poisoned)).toBeNull();
    // ...and it must therefore REFUSE rather than match a 24.16 declaration.
    const why = runToolchainRefusal(
      { runToolchain: { platform: "win32", arch: "x64", node: "24.16", vitest: "24.16" } },
      poisoned
    );
    expect(why).not.toBeNull();
  });

  it("a bare version still reads, and junk still does not", () => {
    expect(normaliseToolchain({ platform: "p", arch: "a", node: "24.16", vitest: "4.1.10" }).known).toBe(true);
    expect(normaliseToolchain({ platform: "p", arch: "a", node: "24.16", vitest: "v4.1" }).known).toBe(true);
    for (const junk of ["not-a-version", "vitest/x", "node-v24.16.0", ""]) {
      const r = normaliseToolchain({ platform: "p", arch: "a", node: "24.16", vitest: junk });
      expect(r.known, `vitest ${JSON.stringify(junk)} must not read`).toBe(false);
      expect(normaliseToolchainForBarrier({ platform: "p", arch: "a", node: "24.16", vitest: junk })).toBeNull();
    }
  });

  it("an explicit runToolchain:null is DECLARED-and-unreadable, not undeclared", () => {
    // Found by review. Treating it as undeclared let a manifest opt out of the
    // barrier by declaring nothing — the one shape an opt-in barrier must
    // refuse. Key ABSENCE remains "not governed".
    const now = { platform: "darwin", arch: "arm64", nodeVersion: "v24.16.0", vitest: "vitest/4.1.10" };
    expect(runToolchainRefusal({ runToolchain: null }, now)).not.toBeNull();
    expect(runToolchainRefusal({}, now)).toBeNull();
    expect(runToolchainRefusal({ claudeCodeVersion: "1.2.3" }, now)).toBeNull();
  });

  it("A MISMATCH STILL BINDS — the report changes no verdict and no final flag", () => {
    // Review noted the eight keys join AUDIT_INPUT_KEYS and so participate in
    // the artifact's binding check, which can make an audit {ran:false} and a
    // result not-final. That is TRUE OF EVERY KEY and is the anti-forgery
    // property; an unbound reported field would be forgeable. What matters for
    // the amendment's promise is narrower and is asserted here: a MISMATCH is
    // not a binding difference, so it moves neither the verdict nor final.
    const declared = { known: true as const, id: DEFAULT_TOOLCHAIN };
    const win = normaliseToolchain({ platform: "win32", arch: "x64", nodeVersion: "v24.16.0", vitest: "vitest/4.1.10" });
    const base = factsOf();
    const mismatched = factsOf({
      clause6: {
        ...base.clause6,
        runToolchain: {
          declared,
          firing: win,
          suite: win,
          firingAgreement: toolchainAgreement(declared, win),
          suiteAgreement: toolchainAgreement(declared, win),
        },
      },
    });
    // Same verdict, and the artifact re-derives to its own inputs either way.
    expect(decideAudit(mismatched).verdict).toBe(decideAudit(base).verdict);
    expect(Object.keys(auditInputs(mismatched)).sort()).toEqual(Object.keys(auditInputs(base)).sort());
    expect(auditInputs(mismatched)["clause6.runToolchain.agreement"]).toMatch(/MISMATCH/);
  });
});
