/**
 * THE CLAUSE 4–6 AUDIT COMPUTER — the tool nobody had written. It computes the
 * three `voidConditions` only git can answer and emits the committed artifact
 * `emit.ts` takes as `--audit`: 4 (the absolutely-frozen items), 5 (source
 * drift after the first scored observation), 6 (the conformance suite and its
 * six firing negative controls).
 *
 * WHY IT LIVES IN `src/cost/b12/` — the same argument as `emit.ts`: clause 5
 * freezes `src/cost/**` after the first scored observation, so the auditor
 * cannot be edited afterwards without tripping the very clause it computes.
 * **THE SCORING COMMAND MUST REGISTER BOTH FORMS OF THIS FILE** — the compiled
 * entrypoint (`dist/cost/b12/audit.js`) AND this source counterpart — because
 * `dist/**` is the registered F24 hole.
 *
 * THE OPERATOR LOOP (each commit is the SESSION's act, never this file's):
 *   1. `emit` with no audit — both artifacts written, clauses 4–6 UNCHECKED;
 *   2. commit; 3. `audit <runId> --attest-suite` — writes ONLY the suite
 *   attestation and exits; 4. commit; 5. `audit <runId>` — reads COMMITTED
 *   state, writes `evidence/<runId>.b12.audit.json`; 6. commit;
 *   7. `emit <runId> --audit evidence/<runId>.b12.audit.json` — the final
 *   artifacts carry `gitAudit.ran === true`; 8. commit.
 *
 * FAIL-CLOSED, IN TWO DIFFERENT WAYS. Git NOT ANSWERING — no repository, no
 * binary — is a REFUSAL: exit 2, no artifact, because an audit that could not
 * look is not an audit. Git answering BADLY — a missing blob, a drifted hash,
 * an offender commit — is a VERDICT: `"void"`, exit 0, artifact written,
 * because that is the run's real state and the artifact owes it.
 *
 * The DECIDER is pure and the COLLECTOR is impure, `emit.ts`-style: every
 * clause's predicate runs over collected VALUES so the oracle can fire and
 * not-fire each one without a repository.
 */
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runEvidenceDigest, sha256 } from "./archive.js";
import type { GitAudit } from "./types.js";

/** The commit the pre-registration froze at; its blob may never drift. */
export const PREREG_FROZEN_COMMIT = "c343976";
export const PREREG_PATH = "evidence/2026-08-05-b12-preregistration.json";

/**
 * Clause 5's pinned path set. The emission wrapper (`src/cost/emission.ts`)
 * is inside `src/cost/**` ON PURPOSE — the emission LIFECYCLE is pinned by
 * pinning the module that owns it, while the tool files stay editable.
 *
 * IT DOES NOT COVER THE WHOLE OF "gate's or repair's telemetry emission", and
 * this constant used to claim it did (R37). Clause 5 lists the emission as a
 * FOURTH item beside `src/cost/**`; if the path pin reached it, the frozen
 * text would not name it separately. It does not reach it: the wrapper selects
 * writers and forwards a caller-built row, while `bytes_raw`, `bytes_returned`
 * and `turns_collapsed` — the credited saving's own definition — are built in
 * `src/tools/gate.ts` and `src/tools/repair.ts`. `EMISSION_FENCED_FILES`
 * below is the rest of the clause, and it is a CORRECTION, not a widening: an
 * amendment is for text the frozen sentence does not carry, and this sentence
 * carries it.
 */
export const PINNED_PATHS = ["src/cost/", "src/telemetry.ts", "scripts/b12-run.mjs"] as const;

/**
 * The files carrying the OTHER half of clause 5's emission item, and the
 * markers that bound it. Pinning these files WHOLE would freeze what the
 * experiment measures — the tools are the subject, not the instrument — so
 * what is pinned is the FENCED REGION, and a commit touching the file offends
 * only when the bytes inside the fence actually moved.
 */
export const EMISSION_FENCED_FILES = ["src/tools/gate.ts", "src/tools/repair.ts"] as const;
export const EMISSION_FENCE_BEGIN = "// b12:emission-begin";
export const EMISSION_FENCE_END = "// b12:emission-end";

/**
 * The fenced bytes of one file, CANONICAL: every fenced region in source
 * order, whole-line comments and blank lines dropped, each surviving line
 * trimmed. Null when the file carries no usable fence at all — an absent
 * marker, an unclosed region, or a stray END. Null is never "clean": the
 * caller reports it, because a fence the audit cannot find is a pin that
 * stopped pinning.
 *
 * COMMENTS ARE DROPPED ON PURPOSE. This repository comments heavily and
 * rewrites those comments constantly; hashing prose would VOID a paid run for
 * a typo fix. What clause 5 protects is the CODE that defines the measurement,
 * and commenting a field out still removes its line.
 */
export function fencedEmission(text: string): string | null {
  const regions: string[] = [];
  let from = 0;
  for (;;) {
    const begin = text.indexOf(EMISSION_FENCE_BEGIN, from);
    if (begin === -1) break;
    const end = text.indexOf(EMISSION_FENCE_END, begin);
    if (end === -1) return null; // an OPEN fence is not a fence
    regions.push(text.slice(begin + EMISSION_FENCE_BEGIN.length, end));
    from = end + EMISSION_FENCE_END.length;
  }
  if (regions.length === 0) return null;
  if (text.indexOf(EMISSION_FENCE_END, from) !== -1) return null; // a stray END
  const canonical = regions
    // A separator that SURVIVES the filter below, so moving a line out of one
    // fenced region and into another still reads as drift.
    .join("\n@@\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"))
    .join("\n");
  return canonical === "" ? null : canonical;
}

/**
 * The six negative controls `voidConditions` 6 requires SHOWN FIRING, by the
 * exact vitest fullName the attestation records. Copied AFTER the tests
 * existed — a registry written first would have been a wish, not a pin.
 *
 * A CONTROL IS IDENTIFIED BY (file, fullName), never by title alone (R23).
 * A vitest fullName is not unique across files, and this repository already
 * decided that question once: the gate oracle keys its four Windows failures
 * by `{file, fullName}` for exactly this reason. Matching on the title alone
 * let a control's NAME satisfy the clause from anywhere — including a
 * trivial test in another file — while the control itself was gone. The
 * clause names the suite as two files; a test outside them is not in the
 * conformance suite at all, and a duplicated title cannot say which one
 * passed. All six live in `tests/cost-meter.test.ts` today; the pair is a
 * pin of what IS, like the titles beside it.
 */
export const CONTROL_TESTS: readonly { file: string; fullName: string }[] = [
  // 1. a failed repair row crediting zero units — written the day this
  //    registry was (no prior test showed it; the near-miss at the
  //    turn-collapse control credits zero for a different reason).
  {
    file: "tests/cost-meter.test.ts",
    fullName: "telemetry and the counterfactual credits a failed repair row at zero units — clause 6's failed-repair control",
  },
  // 2. a byte-negative row carried signed
  {
    file: "tests/cost-meter.test.ts",
    fullName: "telemetry and the counterfactual keeps a call that ADDED bytes as the negative it is",
  },
  // 3. an unmatchable wouldHaveAdded returning null and not 0 — the null is
  //    observable through the `unsized` channel, never summed as zero.
  {
    file: "tests/cost-meter.test.ts",
    fullName: "telemetry and the counterfactual counts a refusal it cannot size instead of summing the unknown as zero",
  },
  // 4. a two-worktree fixture where a resumed session returns inherited > 0
  {
    file: "tests/cost-meter.test.ts",
    fullName: "the B12 harness rejects a resumed session whose ids came from a sibling worktree — clause 6's two-worktree control",
  },
  // 5. a per-session scoring invocation REFUSING where the full-set invocation credits
  {
    file: "tests/cost-meter.test.ts",
    fullName: "telemetry and the counterfactual refuses a call whose invocation id two sessions both carry, on both sides",
  },
  // 6. a run whose snapshot covered fewer slugs than it wrote to being rejected
  {
    file: "tests/cost-meter.test.ts",
    fullName: "the B12 harness rejects a run whose snapshot covered fewer slugs than it wrote to — clause 6's slug-coverage control",
  },
];

/** The two files the frozen clause NAMES as the conformance suite. */
export const CONFORMANCE_FILES = ["tests/cost-meter.test.ts", "tests/session-token-walk.test.ts"] as const;

/**
 * THE PRE-DATA AMENDMENT that puts the two conformance files under clause 5.
 *
 * Clause 6 already forbids counting a GUTTED control — a test that keeps its
 * name and loses its assertions is not "shown FIRING", however green it
 * reports. What was missing was never the rule but the PROOF: this computer
 * verifies present-and-passing by (file, fullName), which is identity and
 * runner status, not firing. A control emptied AFTER the first scored
 * observation and BEFORE the attestation passes every check — the attestation
 * honestly describes the gutted tree, and no drift exists after it.
 *
 * The amendment is PROSPECTIVE and it is read that way: it governs a run only
 * when its own INTRODUCING commit is an ancestor of that run's freeze-anchor
 * commit. Nothing here edits the frozen pre-registration, and nothing here
 * moves clause 5's clock — before the first scored observation these paths
 * are free, exactly as the frozen text says of the paths it names.
 *
 * Byte identity is a FENCE, not a proof of firing: an edit may strengthen a
 * control, and unchanged bytes may stop proving anything if a fixture beside
 * them moved. That is why it took an amendment and not a reading.
 */
export const AMENDMENT_CONFORMANCE_PATHS = "evidence/2026-08-10-b12-amendment-conformance-paths.json";

/**
 * THE PRE-DATA AMENDMENT that makes repair's frozen `max_rounds` violable.
 *
 * `design.artifacts` 1 requires the manifest to CARRY the value. No frozen
 * clause required an observation to RUN under it, and clause 4 does not reach
 * the case: 4 fires when a frozen item CHANGES, and a session calling `repair`
 * at another value changes nothing — the manifest still declares what it
 * declared. A frozen item nothing can violate is not frozen.
 *
 * Read exactly like the conformance-paths amendment beside it: PROSPECTIVE,
 * governing a run only when its own INTRODUCING commit is an ancestor of that
 * run's freeze-anchor commit. Nothing here edits the frozen pre-registration.
 *
 * It is RUN-LEVEL by the frozen text's own reasoning, not by preference:
 * clause 9 settled the trade and stated the ground — "run-level, so triggering
 * it costs the run rather than buying an exclusion". `repair` is treatment-only,
 * so a per-observation exclusion would drop treatment attempts alone and hand
 * the vacated admission slot to the next task in committed order, a selection
 * channel whose SIGN cannot be established before the run. This computes only
 * WHETHER the amendment governs; `assemble.ts` owns the clause itself.
 */
export const AMENDMENT_REPAIR_MAX_ROUNDS = "evidence/2026-08-14-b12-amendment-repair-max-rounds.json";

/**
 * THE PRE-DATA AMENDMENT that gives a run a declared toolchain identity.
 *
 * IT ADDS NO VOID CONDITION, and that is not a detail — it is what the owner
 * chose on 2026-08-14 over R43#3's proposal to void on mismatch. There are three
 * attempts and a VOID ordinarily consumes one, so exact version equality would
 * let a node patch bump spend one. The enforcement is a PRE-RUN BARRIER in the
 * harness, at the same seam as the manifest's `claudeCodeVersion` pin, which
 * REFUSES an arm rather than voiding a run.
 *
 * WHAT THIS FILE DOES WITH IT IS THEREFORE REPORTING ONLY. The audit runs after
 * the data exists, where refusing is no longer available and voiding is the very
 * thing the amendment declines to do. It records the declared identity, what each
 * surface observed, whether they agree, and whether the amendment governed — so a
 * disagreement is CONSPICUOUS and still decides nothing.
 */
export const AMENDMENT_RUN_TOOLCHAIN = "evidence/2026-08-14-b12-amendment-run-toolchain.json";

/**
 * The only spellings a run id may take when it becomes a FILENAME — the same
 * grammar `b12-register.mjs` applies at its own point of use, written here
 * because this file interpolates the id into paths it then WRITES.
 */
export const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The artifact path for a run, refusing anything that would not land DIRECTLY
 * under `evidence/`. The grammar above already forbids separators and dots;
 * this resolves and checks anyway, because the property that matters is about
 * the path and is cheapest to state about the path.
 */
export function evidenceArtifactPath(repoRoot: string, runId: string, suffix: string): string {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new AuditRefused(`refusing runId ${JSON.stringify(runId)} — it becomes a filename under evidence/`);
  }
  const dir = path.resolve(repoRoot, "evidence");
  const out = path.resolve(dir, `${runId}${suffix}`);
  if (path.dirname(out) !== dir) {
    throw new AuditRefused(`refusing to write ${out} — the run's artifacts live directly under evidence/`);
  }
  return out;
}

/**
 * THE LITERAL KEY SET of the audit artifact's `inputs` — never "about 25".
 * `parseGitAudit` drops non-string values in silence (emit.ts), so without
 * this constant the producer and its own round-trip check would agree on
 * whatever incomplete set the producer happened to invent. The producer
 * asserts key-set EQUALITY against this list before any write.
 *
 * Canonical serialization: every value is a string; lists newline-joined in a
 * stated order; numbers as decimal strings; a lawful absence is the literal
 * `"(none)"` so the key is still present and the artifact still replays.
 */
export const AUDIT_INPUT_KEYS: readonly string[] = [
  "runId",
  "head",
  "registrationCommit",
  "prereg.path",
  "prereg.frozenCommit",
  "prereg.frozenSha256",
  "prereg.headSha256",
  "manifestA.path",
  "manifestA.registrationSha256",
  "manifestA.headSha256",
  "manifestB.path",
  "manifestB.registrationSha256",
  "manifestB.headSha256",
  "rates.deferral",
  "clause5.pinnedPaths",
  "clause5.amendment.path",
  "clause5.amendment.commit",
  "clause5.amendment.sha256",
  "clause5.amendment.addedPaths",
  "clause5.amendment.governs",
  "clause5.repairRoundsAmendment.path",
  "clause5.repairRoundsAmendment.commit",
  "clause5.repairRoundsAmendment.sha256",
  "clause5.repairRoundsAmendment.governs",
  "clause5.anchor.taskId",
  "clause5.anchor.arm",
  "clause5.anchor.attempt",
  "clause5.anchor.started",
  "clause5.anchor.commit",
  "clause5.anchor.derivation",
  "clause5.commitsTouchingPinned",
  "clause5.offenders",
  "clause5.excusedByReemission",
  "clause5.reemission.population",
  "clause5.reemission.reading",
  "clause5.emission.files",
  "clause5.emission.atAnchor",
  "clause5.emission.atHead",
  "clause5.emission.drifted",
  "clause5.emission.excused",
  "clause5.emission.problems",
  "clause5.evidencePaths",
  "clause5.evidenceDigest",
  "clause6.attestationPath",
  "clause6.attestationSha256",
  "clause6.subjectCommit",
  "clause6.controls",
  "clause6.files",
  "clause6.conformanceHashes",
  "clause6.lockfileClaimed",
  "clause6.lockfileAtSubject",
  "clause6.firingPath",
  "clause6.firingSha256",
  "clause6.firingBaseCommit",
  "clause6.firingPairs",
  "clause6.firingSubjects",
  "clause6.firingToolchain",
  // The run-toolchain amendment. REPORTED, DECIDING NOTHING — see
  // AMENDMENT_RUN_TOOLCHAIN. `governs` is a three-way reading, not a boolean:
  // an unaskable ancestry refuses before it reaches here, but a run with no
  // declared identity must not be spelled the same way as one that agrees.
  "clause6.toolchainAmendment.path",
  "clause6.toolchainAmendment.commit",
  "clause6.toolchainAmendment.sha256",
  "clause6.toolchainAmendment.governs",
  "clause6.runToolchain.declared",
  "clause6.runToolchain.firing",
  "clause6.runToolchain.suite",
  "clause6.runToolchain.agreement",
  "tool.srcSha256",
];

/**
 * Parse a committed audit artifact into the input `assemble` takes.
 *
 * `inputs` must be EXACTLY `AUDIT_INPUT_KEYS` (R26). It used to require only
 * that ONE string input survive — so an artifact carrying three keys of forty,
 * or a hand-written file with `verdict: "clean"` and a single plausible pair,
 * parsed as a real audit and let clauses 4–6 publish as CHECKED. The producer
 * has always asserted key-set equality against this constant before writing;
 * the consumer asserting the same constant is what makes that assertion mean
 * anything on the reading end. A partial artifact is NO audit — `{ran: false}`
 * keeps the clauses in `uncheckedClauses` rather than laundering a broken or
 * invented file into "clean".
 *
 * It lives HERE, beside the constant it enforces, and not in `emit.ts`: the
 * emitter must be able to import the audit computer to re-derive what the
 * artifact claims, and a parse living on the consumer's side made that a
 * module cycle.
 */
export function parseGitAudit(raw: unknown): GitAudit {
  if (
    typeof raw === "object" &&
    raw !== null &&
    (raw as Record<string, unknown>).ran === true &&
    ((raw as Record<string, unknown>).verdict === "clean" ||
      (raw as Record<string, unknown>).verdict === "void") &&
    Array.isArray((raw as Record<string, unknown>).reasons)
  ) {
    const o = raw as { verdict: "clean" | "void"; reasons: unknown[]; inputs?: unknown };
    const inputs: Record<string, string> = {};
    if (typeof o.inputs === "object" && o.inputs !== null) {
      for (const [k, v] of Object.entries(o.inputs)) if (typeof v === "string") inputs[k] = v;
    }
    // EXACT, both directions: a missing key cannot be replayed, and an extra
    // one is an artifact this tool did not write.
    const got = Object.keys(inputs).sort();
    const want = [...AUDIT_INPUT_KEYS].sort();
    if (got.length !== want.length || got.some((k, i) => k !== want[i])) return { ran: false };
    return {
      ran: true,
      verdict: o.verdict,
      reasons: o.reasons.filter((r): r is string => typeof r === "string"),
      inputs,
    };
  }
  return { ran: false };
}

// ---------------------------------------------------------------------------
// The facts — collected once, decided purely.
// ---------------------------------------------------------------------------

export interface AuditFacts {
  runId: string;
  head: string;
  /** The commit that INTRODUCED the manifest; null when it was never committed. */
  registrationCommit: string | null;
  prereg: {
    /**
     * The path and freeze commit ACTUALLY read — the constants unless a test
     * seam overrode them. `CollectorOptions` promises "the artifact records
     * what was used, so a divergence is on its face"; recording the constants
     * instead made that promise false, and made the artifact's own
     * `headSha256` unreplayable from the path beside it (R22).
     */
    path: string;
    frozenCommit: string;
    /** Content sha at the freeze commit; null when the blob is unreadable there. */
    frozenSha256: string | null;
    /** Content sha at HEAD; null when HEAD does not carry it. */
    headSha256: string | null;
  };
  manifestA: { registrationSha256: string | null; headSha256: string | null };
  /** B must exist AT THE REGISTRATION COMMIT — sealed in the same act. */
  manifestB: { registrationSha256: string | null; headSha256: string | null };
  clause5: {
    /**
     * The freeze anchor: the FIRST observation, in REAL runlog order, whose
     * `aPlusSPositive` is non-null. Null when no observation is scored yet —
     * clause 5's own text leaves the sources free until then.
     */
    anchor: { taskId: string; arm: string; attempt: number; started: string; commit: string } | null;
    /** Why the anchor could not be derived — a VOID, distinct from "none yet". */
    anchorProblems: string[];
    /**
     * The pinned set ACTUALLY probed — the frozen paths, plus whatever a
     * governing amendment added. Recorded rather than assumed: an artifact
     * that names the constant while the probe used something else is the
     * exact defect R22 found in the prereg fields.
     */
    pinnedPaths: string[];
    /**
     * The conformance-path amendment: where it is, when it was born, its
     * bytes, and whether it governs THIS run. `governs` is false when the
     * amendment is absent, when it was born after the freeze anchor, and
     * when there is no anchor at all — with no anchor clause 5 is free by
     * its own text, so there is nothing yet for an amendment to govern.
     */
    amendment: {
      path: string;
      commit: string | null;
      sha256: string | null;
      addedPaths: readonly string[];
      governs: boolean;
    };
    /**
     * The repair-max-rounds amendment's identity and whether it governs. No
     * `addedPaths`: it widens no path set. `assemble.ts` reads `governs` and
     * owns the clause; nothing here fires on it.
     */
    repairRoundsAmendment: {
      path: string;
      commit: string | null;
      sha256: string | null;
      governs: boolean;
    };
    /** Every commit touching a pinned path: `{sha, committerDate}`. */
    commitsTouchingPinned: Array<{ sha: string; committerDate: string }>;
    /** The union of the two probes (ancestry + committer date), minus nothing. */
    offenders: string[];
    /** Offenders excused because EVERY run artifact was re-emitted after them. */
    excusedByReemission: string[];
    /**
     * Clause 5's FOURTH item — "gate's or repair's telemetry emission" — which
     * `pinnedPaths` structurally cannot reach (R37). `atHead` is recorded
     * always, so a broken fence is visible before the first score; the rest is
     * populated only once an anchor exists, because until then the clause's
     * own text leaves the sources free. `drifted` and `excused` are
     * `"<sha> <file>"`; `problems` carries a fence the audit could not read,
     * which is a VOID and not an absence.
     */
    emission: {
      files: readonly string[];
      atAnchor: Array<{ file: string; sha256: string | null }>;
      atHead: Array<{ file: string; sha256: string | null }>;
      drifted: string[];
      excused: string[];
      problems: string[];
    };
    /**
     * The committed files these facts were DERIVED from — the runlog, the
     * counterfactual, every per-observation archive — and their canonical
     * digest. Recorded so the emission-time binding can prove the archive it
     * is scoring is the archive that was audited (R24).
     */
    evidencePaths: string[];
    evidenceDigest: string;
  };
  clause6: {
    /** null when the attestation is absent from HEAD. */
    attestation: SuiteAttestation | null;
    attestationSha256: string | null;
    /** Is `subjectCommit` an ancestor of HEAD? null when it cannot be asked. */
    subjectIsAncestor: boolean | null;
    /** Paths in `subjectCommit..HEAD` that are NOT under `evidence/`. */
    nonEvidenceDrift: string[];
    /**
     * REPORTED, DECIDING NOTHING: each conformance file's blob at the
     * registration commit and at the attestation's `subjectCommit`. It makes
     * drift between the two conspicuous — including drift the amendment's
     * clock does not reach — WITHOUT minting a rule: a difference here may
     * never void or rescue a run. A change is not evidence of a gutting (it
     * may be a strengthening), which is precisely why it decides nothing.
     * `null` where the blob is unreadable at that commit; an unreadable
     * decoration is not a refusal, because nothing depends on it.
     */
    conformance: Array<{ file: string; atRegistration: string | null; atSubject: string | null }>;
    /**
     * sha256 of `package-lock.json` AT the attestation's `subjectCommit` —
     * the dependency tree the suite CLAIMS it installed from, recomputed from
     * the commit itself. Null when there is no attestation, or when that
     * commit carries no readable lockfile: R24 recorded the producer's number
     * and R29 found that nobody ever checked it, so a copied or hand-edited
     * attestation could name any tree it liked and still satisfy clause 6.
     */
    lockfileAtSubject: string | null;
    /**
     * The run-toolchain amendment's identity and whether it governs THIS run,
     * decided by the same prospective ancestry test as the other two.
     */
    toolchainAmendment: { path: string; commit: string | null; sha256: string | null; governs: boolean };
    /**
     * REPORTED, DECIDING NOTHING: the run's DECLARED toolchain identity and what
     * each evidentiary surface actually ran on.
     *
     * The declared identity is the reference, never a relation between the two
     * proofs: comparing the firing artifact against the attestation would make
     * those two agree with each other and bind NEITHER to the scored sessions,
     * so two artifacts from one wrong machine would agree perfectly.
     */
    runToolchain: {
      declared: ToolchainReading;
      firing: ToolchainReading;
      suite: ToolchainReading;
      firingAgreement: ToolchainAgreement;
      suiteAgreement: ToolchainAgreement;
    };
    /**
     * `evidence/<runId>.b12.firing.json` at HEAD — the mutation harness's
     * matrix. Null when absent or unparseable.
     *
     * THIS IS NOT A SEVENTH CONDITION. The frozen clause says the six controls
     * must be shown **FIRING**; everything above this line checks that they are
     * **PASSING**, which is strictly weaker, because a gutted control that keeps
     * its title and asserts nothing passes. Reading firing evidence implements
     * the word the clause already uses. Widening past it would owe a pre-data
     * amendment; closing the gap between the code and the sentence the code
     * claims to implement is a correction, and corrections owe none.
     *
     * That the evidence must be MACHINE-produced does narrow how "shown" may be
     * satisfied — a hand demonstration in `FINDINGS.md` is also a showing. That
     * narrowing is declared pre-data in `PREMISES.md`, ordered by `git log -p`,
     * exactly as the two owner decisions of 2026-08-11 were.
     */
    firing: FiringEvidence | null;
    firingSha256: string | null;
    /**
     * Each firing subject's blob sha256 RECOMPUTED at the evidence's own
     * `baseCommit`, beside the digest the artifact claims. R29's lesson applied
     * to a second producer: the attestation recorded a lockfile hash nobody ever
     * checked, so a copied artifact could name any tree it liked. These are the
     * same question asked of the harness.
     */
    firingSubjectsAtBase: Array<{ path: string; claimed: string | null; recomputed: string | null }>;
  };
  /** Content sha of this tool's own SOURCE at HEAD; null when absent. */
  toolSrcSha256: string | null;
}

/**
 * `evidence/<runId>.b12.firing.json` — what `scripts/b12-mutate.mjs` writes.
 *
 * Only the fields clause 6 reads are typed here. The artifact carries more (the
 * off-diagonal matrix, the bookends, the run budget) and a reader is meant to
 * have it; the audit deliberately reads the narrow set it can decide on.
 */
export interface FiringEvidence {
  schema: "b12-firing/1";
  baseCommit: string;
  controlsEvaluated: Array<{ file: string; fullName: string }>;
  baseline: { allGreen: boolean; problems: string[] };
  pairs: Array<{ id: string; control: { file: string; fullName: string }; fired: boolean; detail: string }>;
  subjects: Array<{ id: string; path: string; sha256AtBase: string | null }>;
  problems: string[];
  allFired: boolean;
  /**
   * REPORTED, DECIDING NOTHING: the toolchain the matrix ran on. A control can
   * fire on one platform and not another, and evidence produced on a different
   * machine than the scored sessions would hide that. Turning a difference into
   * a void would mint a condition, and WHICH platform the run is entitled to is
   * the separate pre-data platform amendment that is still owed. Optional,
   * because an artifact written before this field existed is not thereby void.
   */
  toolchain?: { platform?: string; arch?: string; nodeVersion?: string; vitest?: string | null };
}

/** `evidence/<runId>.b12.suite.json` — what `--attest-suite` writes. */
export interface SuiteAttestation {
  schema: "b12-suite/1";
  runId: string;
  /** HEAD when the suite ran — the multi-commit model's subject. */
  subjectCommit: string;
  generatedAt: string;
  /**
   * Content sha of `package-lock.json` AT `subjectCommit` — the tree the
   * suite was installed from. The attestation used to borrow the enclosing
   * repository's `node_modules`, so a newer, staler or hand-modified
   * installation could carry the suite past a commit that a clean install
   * cannot even build (R24). The producer now installs from this lockfile;
   * recording it is what lets a reader see WHICH one.
   */
  lockfileSha256: string;
  files: Array<{ file: string; total: number; passed: number; failed: number; skipped: number }>;
  tests: Array<{ file: string; fullName: string; status: string }>;
  /**
   * The runtime the suite ran on, under the run-toolchain amendment. Optional
   * for the same reason the firing artifact's is: an attestation written before
   * this field existed is not thereby void.
   */
  toolchain?: { platform?: string; arch?: string; nodeVersion?: string; vitest?: string | null };
}

// ---------------------------------------------------------------------------
// The run toolchain identity (pre-data amendment, 2026-08-14).
// ---------------------------------------------------------------------------

/**
 * A run's toolchain identity, NORMALISED. Compared for equality, never ordered.
 *
 * PATCH VERSIONS ARE ABSENT BY DESIGN, and this is the amendment's own reasoning
 * rather than a shortcut: including them would let a node patch bump — which is
 * irrelevant to whether a negative control fires — block a run at the barrier,
 * reintroducing exactly the irrelevant-difference problem that made VOIDING on
 * mismatch unattractive in the first place.
 */
export interface RunToolchain {
  platform: string;
  arch: string;
  /** MAJOR.MINOR of the node that ran it. */
  node: string;
  /** MAJOR.MINOR of vitest. */
  vitest: string;
}

/**
 * A toolchain that could be read, or the reason it could not.
 *
 * THERE IS NO THIRD STATE THAT SILENTLY PASSES. An absent or malformed identity
 * is `known: false`, and the amendment says such a reading is never a match —
 * the same fail-closed shape as the regime-key reader in `assemble.ts`, and for
 * the same reason: "cannot tell" must not be spelled the same way as "agrees".
 */
export type ToolchainReading =
  | { readonly known: true; readonly id: RunToolchain }
  | { readonly known: false; readonly why: string };

/** Local, because this file has no shared object guard and importing one for
 *  four call sites would couple the audit to a module it does not otherwise use. */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const majorMinor = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const m = /(\d+)\.(\d+)/.exec(raw);
  return m === null ? null : `${m[1]}.${m[2]}`;
};

/**
 * Read a toolchain identity out of whatever shape carries it.
 *
 * Accepts the producers' shape (`nodeVersion`, and `vitest` as the DISPLAY
 * STRING `"vitest/4.1.10 win32-x64 node-v24.16.0"`) and the manifest's declared
 * shape (`node`, `vitest` as a bare version). The display string is why vitest
 * is not simply regexed for the first number it contains: that string embeds
 * the node version AND the platform a second time, so a naive read would make
 * one field silently disagree with itself.
 */
export function normaliseToolchain(raw: unknown): ToolchainReading {
  if (!isPlainObject(raw)) return { known: false, why: "no toolchain object" };
  const platform = typeof raw.platform === "string" && raw.platform !== "" ? raw.platform : null;
  const arch = typeof raw.arch === "string" && raw.arch !== "" ? raw.arch : null;
  const node = majorMinor(raw.nodeVersion) ?? majorMinor(raw.node);
  const vitestRaw = raw.vitest;
  let vitest: string | null = null;
  if (typeof vitestRaw === "string") {
    const tagged = /vitest\/(\d+)\.(\d+)/.exec(vitestRaw);
    vitest = tagged !== null ? `${tagged[1]}.${tagged[2]}` : majorMinor(vitestRaw);
  }
  const missing: string[] = [];
  if (platform === null) missing.push("platform");
  if (arch === null) missing.push("arch");
  if (node === null) missing.push("node");
  if (vitest === null) missing.push("vitest");
  if (missing.length > 0) return { known: false, why: `missing or unreadable: ${missing.join(", ")}` };
  return { known: true, id: { platform: platform!, arch: arch!, node: node!, vitest: vitest! } };
}

export type ToolchainAgreement =
  | { readonly verdict: "match" }
  | { readonly verdict: "mismatch"; readonly differences: readonly string[] }
  | { readonly verdict: "unknown"; readonly why: string };

/**
 * Compare an observed identity against the run's DECLARED one.
 *
 * The declared identity is the reference on purpose. Comparing the firing
 * artifact against the suite attestation instead would make those two agree
 * with each other and bind NEITHER to the sessions that were scored — two
 * artifacts from one wrong machine would agree perfectly.
 */
export function toolchainAgreement(declared: ToolchainReading, observed: ToolchainReading): ToolchainAgreement {
  if (!declared.known) return { verdict: "unknown", why: `declared identity ${declared.why}` };
  if (!observed.known) return { verdict: "unknown", why: `observed identity ${observed.why}` };
  const differences: string[] = [];
  for (const k of ["platform", "arch", "node", "vitest"] as const) {
    if (declared.id[k] !== observed.id[k]) differences.push(`${k}: declared ${declared.id[k]}, observed ${observed.id[k]}`);
  }
  return differences.length === 0 ? { verdict: "match" } : { verdict: "mismatch", differences };
}

/** The stable one-line spelling used on the audit's face. */
export function toolchainLabel(r: ToolchainReading): string {
  return r.known ? `${r.id.platform}-${r.id.arch} node-${r.id.node} vitest-${r.id.vitest}` : `(unknown: ${r.why})`;
}

/**
 * The agreement, spelled so the THREE readings stay three. "unknown" carries its
 * reason because a reader who cannot tell whether a run was checked will assume
 * it was, and that assumption is the one this amendment exists to prevent.
 */
export function agreementLabel(a: ToolchainAgreement): string {
  if (a.verdict === "match") return "match";
  if (a.verdict === "unknown") return `unknown (${a.why})`;
  return `MISMATCH [${a.differences.join("; ")}]`;
}

// ---------------------------------------------------------------------------
// The pure decider.
// ---------------------------------------------------------------------------

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * THE ATTESTATION'S SHAPE, VALIDATED AT RUNTIME. The committed JSON is
 * evidence written by an earlier invocation and re-read here; the collector
 * checks only that it is the schema at all, and TypeScript's types say
 * nothing about bytes on disk. Without this, `{ "file": "tests/…" }` with no
 * counters SATISFIED the full-suite check: `undefined > 0` is false twice,
 * and `undefined !== undefined` is false — a malformed or schema-drifted
 * attestation certified a suite that was never shown to run.
 *
 * A malformed attestation is a VOID, not a refusal: git answered, the bytes
 * are committed, and their inadequacy is the run's real state.
 */
export function attestationProblems(att: SuiteAttestation): string[] {
  const problems: string[] = [];
  // The dependency tree the suite ran on, by the lockfile it was installed
  // from (R24). An attestation that cannot say which one ran is incomplete
  // evidence about the only question clause 6 asks.
  if (typeof att.lockfileSha256 !== "string" || !/^[0-9a-f]{64}$/.test(att.lockfileSha256)) {
    problems.push(
      "the attestation records no lockfileSha256 — it cannot say which dependency tree the conformance suite ran on"
    );
  }
  if (!Array.isArray(att.files)) {
    problems.push("the attestation's `files` is not an array — no per-file counter can be read");
  } else {
    for (const file of CONFORMANCE_FILES) {
      const n = att.files.filter((f) => f?.file === file).length;
      if (n > 1) problems.push(`${file} appears ${n} times in the attestation — one entry per named file, or the counters are ambiguous`);
    }
    for (const f of att.files) {
      const name = typeof f?.file === "string" ? f.file : JSON.stringify(f?.file);
      if (typeof f?.file !== "string" || f.file === "") {
        problems.push("an attestation file entry carries no file name");
        continue;
      }
      if (!isCount(f.total) || !isCount(f.passed) || !isCount(f.failed) || !isCount(f.skipped)) {
        problems.push(`${name}: the attestation's counters are not all non-negative integers (total/passed/failed/skipped)`);
        continue;
      }
      if (f.total === 0) problems.push(`${name}: the attestation counts ZERO tests — an empty file proves nothing about the suite`);
      if (f.passed + f.failed + f.skipped !== f.total) {
        problems.push(`${name}: the attestation's counters do not add up (${f.passed}+${f.failed}+${f.skipped} != ${f.total})`);
      }
    }
  }
  if (!Array.isArray(att.tests)) {
    problems.push("the attestation's `tests` is not an array — no control can be shown passing");
  } else {
    for (const t of att.tests) {
      if (typeof t?.fullName !== "string" || typeof t?.status !== "string" || typeof t?.file !== "string") {
        problems.push("an attestation test row is not {file, fullName, status} strings");
        break; // One sentence is enough; the shape is wrong wholesale.
      }
    }
  }
  return problems;
}

/**
 * THE SUITE COMMAND'S OWN VERDICT, before any report is believed. A report
 * saying every test passed does NOT make the run a pass: vitest exits
 * non-zero on unhandled rejections, teardown failures and runner-level
 * errors, and a signalled process may have died mid-file. Pure so the oracle
 * can hand it a perfect payload beside a failing exit.
 */
export function suiteRunRefusal(run: {
  error?: unknown;
  status: number | null;
  signal: string | null;
  stdout: string | null;
}): { refusal: string; jsonLine: null } | { refusal: null; jsonLine: string } {
  if (run.error !== undefined && run.error !== null) {
    return { refusal: `vitest did not answer: ${String(run.error)}`, jsonLine: null };
  }
  if (run.signal !== null && run.signal !== undefined) {
    return { refusal: `vitest was killed by ${run.signal} — a signalled suite attests nothing, whatever it printed first`, jsonLine: null };
  }
  if (run.status !== 0) {
    return {
      refusal: `vitest exited ${String(run.status)} — a non-zero suite command may not produce a PASSING attestation, whatever its report says`,
      jsonLine: null,
    };
  }
  const jsonLine = (run.stdout ?? "").split("\n").find((l) => l.trimStart().startsWith("{"));
  if (jsonLine === undefined) {
    return { refusal: "vitest produced no JSON payload — the suite cannot be attested", jsonLine: null };
  }
  return { refusal: null, jsonLine };
}

export function decideAudit(facts: AuditFacts): { verdict: "clean" | "void"; reasons: string[] } {
  const reasons: string[] = [];

  // ---- clause 4 — the absolutely-frozen items -----------------------------
  if (facts.registrationCommit === null) {
    reasons.push("clause 4: the manifest was never committed — there is no registration commit to anchor the frozen set");
  }
  if (facts.prereg.frozenSha256 === null) {
    reasons.push(
      `clause 4: ${facts.prereg.path} is unreadable at the freeze commit ${facts.prereg.frozenCommit} — the frozen text cannot be shown frozen`
    );
  }
  if (facts.prereg.headSha256 === null) {
    reasons.push(`clause 4: HEAD does not carry ${facts.prereg.path}`);
  }
  if (
    facts.prereg.frozenSha256 !== null &&
    facts.prereg.headSha256 !== null &&
    facts.prereg.frozenSha256 !== facts.prereg.headSha256
  ) {
    reasons.push("clause 4: the pre-registration drifted from its freeze-commit blob");
  }
  if (facts.registrationCommit !== null) {
    if (facts.manifestA.registrationSha256 === null) {
      reasons.push("clause 4: manifest A is not in the registration commit's tree");
    } else if (facts.manifestA.headSha256 !== facts.manifestA.registrationSha256) {
      reasons.push("clause 4: manifest A at HEAD differs from the registration commit's blob");
    }
    if (facts.manifestB.registrationSha256 === null) {
      reasons.push("clause 4: manifest B is ABSENT from the registration commit — the second manifest must be sealed in the same act (design.artifacts 2)");
    } else if (facts.manifestB.headSha256 !== facts.manifestB.registrationSha256) {
      reasons.push("clause 4: manifest B at HEAD differs from the registration commit's blob");
    }
  }
  // rates.json is DEFERRED to assemble's own byte-identity check, on the
  // artifact's face (`rates.deferral` input) — auditing it here TOO would be
  // two derivations of one rule.

  // ---- clause 5 — source drift after the first scored observation ---------
  for (const p of facts.clause5.anchorProblems) reasons.push(`clause 5: ${p}`);
  if (facts.clause5.anchor !== null) {
    const excused = new Set(facts.clause5.excusedByReemission);
    for (const offender of facts.clause5.offenders) {
      if (!excused.has(offender)) {
        reasons.push(
          `clause 5: commit ${offender} touched a pinned path after the first scored observation and not every run artifact was re-emitted after it`
        );
      }
    }
  }
  // The emission item (R37). `problems` fires whatever the escape says: a
  // fence the audit cannot read is not an offender re-emission could excuse,
  // it is an instrument that stopped working.
  for (const p of facts.clause5.emission.problems) reasons.push(`clause 5: ${p}`);
  {
    const excusedEmission = new Set(facts.clause5.emission.excused);
    for (const drift of facts.clause5.emission.drifted) {
      if (!excusedEmission.has(drift)) {
        reasons.push(
          `clause 5: ${drift} moved gate's or repair's telemetry emission after the first scored observation and not every run artifact was re-emitted after it`
        );
      }
    }
  }
  // With no anchor and no anchor problem, the sources are FREE — the clause's
  // own text: "Before the first scored observation these are free". Which
  // paths counted is `facts.clause5.pinnedPaths`, and whether the amendment
  // widened them is on the artifact's face; neither is re-derived here.

  // ---- clause 6 — the conformance suite and its six controls --------------
  const att = facts.clause6.attestation;
  if (att === null) {
    reasons.push("clause 6: no committed suite attestation — the conformance suite cannot be shown passing");
  } else {
    if (att.runId !== facts.runId) {
      reasons.push(`clause 6: the attestation names run ${att.runId}, not ${facts.runId}`);
    }
    // THE SHAPE FIRST — committed bytes are not what the types promise, and a
    // counter-less entry once satisfied the full-suite check by comparing
    // undefined to undefined.
    for (const p of attestationProblems(att)) reasons.push(`clause 6: ${p}`);
    if (Array.isArray(att.files)) {
      for (const file of CONFORMANCE_FILES) {
        const f = att.files.find((x) => x?.file === file);
        if (f === undefined) {
          reasons.push(`clause 6: the attestation does not cover ${file} — the clause names it as the conformance suite`);
        } else if (isCount(f.total) && isCount(f.passed) && isCount(f.failed) && isCount(f.skipped)) {
          if (f.failed > 0 || f.skipped > 0 || f.passed !== f.total) {
            reasons.push(
              `clause 6: ${file} is not FULLY passing (${f.passed}/${f.total} passed, ${f.failed} failed, ${f.skipped} skipped) — per-control results alone are not the clause`
            );
          }
        }
        // Non-numeric counters already spoke through attestationProblems —
        // one defect, one sentence.
      }
    }
    if (Array.isArray(att.tests)) {
      for (const control of CONTROL_TESTS) {
        // (file, fullName) — a title is not an identity, and the clause names
        // the files it means (R23).
        const matches = att.tests.filter((x) => x?.fullName === control.fullName && x?.file === control.file);
        if (matches.length === 0) {
          const elsewhere = att.tests.filter((x) => x?.fullName === control.fullName);
          reasons.push(
            elsewhere.length > 0
              ? `clause 6: the control's title is attested in ${elsewhere.map((x) => String(x.file)).join(", ")}, not in ${control.file} — a control that moved is a different test: ${control.fullName}`
              : `clause 6: required control absent from the attestation: ${control.fullName}`
          );
        } else if (matches.length > 1) {
          reasons.push(
            `clause 6: ${matches.length} tests in ${control.file} carry the control's fullName — a duplicated title cannot say which one passed: ${control.fullName}`
          );
        } else if (matches[0]!.status !== "passed") {
          reasons.push(`clause 6: required control not passing (${String(matches[0]!.status)}): ${control.fullName}`);
        }
      }
    }
    // THE DEPENDENCY TREE, CHECKED AND NOT JUST CLAIMED (R29). The shape rule
    // above only asks for 64 hex digits; the number has to be the LOCKFILE AT
    // THE SUBJECT COMMIT, or `--attest-suite`'s whole guarantee — that the
    // suite ran on dependencies the attested commit pins — is a sentence the
    // artifact says about itself.
    if (typeof att.lockfileSha256 === "string" && /^[0-9a-f]{64}$/.test(att.lockfileSha256)) {
      if (facts.clause6.lockfileAtSubject === null) {
        reasons.push(
          "clause 6: the attestation's subjectCommit carries no readable package-lock.json — the dependency tree it names cannot be checked"
        );
      } else if (facts.clause6.lockfileAtSubject !== att.lockfileSha256) {
        reasons.push(
          `clause 6: the attestation claims lockfile ${att.lockfileSha256.slice(0, 12)} and subjectCommit carries ${facts.clause6.lockfileAtSubject.slice(0, 12)} — the suite did not run on the dependencies that commit pins`
        );
      }
    }
    if (facts.clause6.subjectIsAncestor === null) {
      reasons.push("clause 6: the attestation's subjectCommit cannot be related to HEAD");
    } else if (facts.clause6.subjectIsAncestor === false) {
      reasons.push("clause 6: the attestation's subjectCommit is not an ancestor of HEAD — it attests some other history");
    }
    // `facts.clause6.conformance` is NOT read here, and that is deliberate:
    // the conformance hashes are reported so drift is visible, and a
    // difference between them is not a defect — a control may have been
    // strengthened. Turning them into a reason would mint a voiding
    // condition the frozen text does not carry.
    if (facts.clause6.nonEvidenceDrift.length > 0) {
      reasons.push(
        `clause 6: ${facts.clause6.nonEvidenceDrift.length} non-evidence path(s) changed after the attestation (${facts.clause6.nonEvidenceDrift.slice(0, 3).join(", ")}${facts.clause6.nonEvidenceDrift.length > 3 ? ", …" : ""}) — the multi-commit model allows evidence/** only`
      );
    }
  }

  // ---- clause 6, the word FIRING ------------------------------------------
  // Everything above checks the six controls are PASSING. Passing is strictly
  // weaker: a control gutted to `expect(true).toBe(true)` keeps its title and
  // passes. The frozen text says SHOWN FIRING, so the gap being closed here is
  // between the code and the sentence the code already claims to implement —
  // a correction, not a seventh condition. Every reason below is reported as a
  // failure of that existing phrase, and `voidConditions` gains no entry.
  const fire = facts.clause6.firing;
  if (fire === null) {
    reasons.push(
      `clause 6: no committed firing evidence (evidence/${facts.runId}.b12.firing.json) — the six controls can be shown PASSING but not FIRING, and a gutted control passes`
    );
  } else if (!isFiringEvidence(fire)) {
    // The collector validates what it reads, but this is a PURE function and
    // can be handed anything. R41#2's control proved the point: injecting a
    // malformed artifact straight into the facts threw a TypeError here, and an
    // audit that throws on hostile input is one hostile input can silence.
    reasons.push(
      "clause 6: the firing evidence is malformed — bytes that cannot be read as evidence are not evidence, and a shape this cannot parse decides VOID rather than throwing"
    );
  } else {
    if (att !== null && fire.baseCommit !== att.subjectCommit) {
      reasons.push(
        `clause 6: the firing evidence names base ${fire.baseCommit.slice(0, 12)} and the attestation names subject ${att.subjectCommit.slice(0, 12)} — the controls were shown firing on a tree that is not the one attested`
      );
    }
    // Coverage is compared against CONTROL_TESTS here rather than inside the
    // harness, because `allFired` quantifies over whatever control list the
    // harness was handed (R39#1). This is where the clause's own list lives.
    const key = (c: { file: string; fullName: string }): string => JSON.stringify([c.file, c.fullName]);
    const evaluated = new Set(fire.controlsEvaluated.map(key));
    for (const control of CONTROL_TESTS) {
      if (!evaluated.has(key(control))) {
        reasons.push(`clause 6: the firing evidence never evaluated a required control: ${control.fullName}`);
      }
    }
    for (const c of fire.controlsEvaluated) {
      if (!CONTROL_TESTS.some((k) => key(k) === key(c))) {
        reasons.push(`clause 6: the firing evidence evaluated a control the clause does not list: ${c.fullName}`);
      }
    }
    // R41#1: EXACTLY one pair per listed control, one-to-one. Without this the
    // artifact could list all six in `controlsEvaluated` and carry `pairs: []`
    // — every loop below stays quiet, `allFired: true` survives, and a matrix
    // that ran nothing reads CLEAN. Same species as the empty-`subjects` hole.
    for (const control of CONTROL_TESTS) {
      const owning = fire.pairs.filter((p) => key(p.control) === key(control));
      if (owning.length === 0) {
        reasons.push(`clause 6: no pair reports on a required control: ${control.fullName}`);
      } else if (owning.length > 1) {
        reasons.push(`clause 6: ${owning.length} pairs report on ${control.fullName} — a control cannot be judged twice`);
      }
    }
    if (new Set(fire.pairs.map((p) => p.id)).size !== fire.pairs.length) {
      reasons.push("clause 6: the firing evidence repeats a pair id — two pairs cannot be the same act");
    }
    if (!fire.baseline.allGreen) {
      reasons.push(
        `clause 6: the firing evidence's unmutated baseline was not green (${fire.baseline.problems.slice(0, 2).join("; ")}) — a control already red proves nothing by going red`
      );
    }
    for (const pair of fire.pairs) {
      if (pair.fired !== true) {
        reasons.push(`clause 6: control NOT shown firing under ${pair.id}: ${pair.detail}`);
      }
    }
    for (const p of fire.problems) reasons.push(`clause 6: the firing evidence reports a problem: ${p}`);
    if (fire.allFired !== true && fire.pairs.every((p) => p.fired)) {
      // Belt and braces: the summary disagreeing with the pairs is itself a
      // reason, because an artifact that contradicts itself decides nothing.
      reasons.push("clause 6: the firing evidence says allFired is false while every pair reads fired — it contradicts itself");
    }
    // R29's question, asked of the second producer: a copied artifact could
    // name any tree it liked unless the digests it claims are recomputed. And
    // the digests must be REQUIRED, not merely checked when present: an
    // artifact that simply omits `subjects` would otherwise skip this whole
    // section and bind to nothing at all.
    for (const pair of fire.pairs) {
      if (!fire.subjects.some((s) => s.id === pair.id)) {
        reasons.push(
          `clause 6: the firing evidence names no subject bytes for ${pair.id} — a matrix that binds to no bytes cannot say WHICH tree the controls fired on`
        );
      }
    }
    for (const s of facts.clause6.firingSubjectsAtBase) {
      if (s.recomputed === null) {
        reasons.push(`clause 6: the firing evidence's base commit carries no readable ${s.path} — the bytes it names cannot be checked`);
      } else if (s.claimed !== s.recomputed) {
        reasons.push(
          `clause 6: the firing evidence claims ${s.path} at ${String(s.claimed).slice(0, 12)} and its base commit carries ${s.recomputed.slice(0, 12)} — the matrix did not run against the bytes it names`
        );
      }
    }
  }

  return { verdict: reasons.length === 0 ? "clean" : "void", reasons };
}

// ---------------------------------------------------------------------------
// The canonical inputs — one spelling, asserted against the constant.
// ---------------------------------------------------------------------------

const joined = (xs: readonly string[]): string => (xs.length === 0 ? "(none)" : xs.join("\n"));
const orNone = (x: string | null): string => x ?? "(none)";

export function auditInputs(facts: AuditFacts): Record<string, string> {
  const a = facts.clause5.anchor;
  const att = facts.clause6.attestation;
  return {
    runId: facts.runId,
    head: facts.head,
    registrationCommit: orNone(facts.registrationCommit),
    // WHAT WAS READ, not what the constant says — `CollectorOptions` already
    // promised the artifact would show a divergence on its face, and a
    // recorded path that does not name the file the sha beside it describes
    // cannot be replayed by anyone, including the emission-time binding.
    "prereg.path": facts.prereg.path,
    "prereg.frozenCommit": facts.prereg.frozenCommit,
    "prereg.frozenSha256": orNone(facts.prereg.frozenSha256),
    "prereg.headSha256": orNone(facts.prereg.headSha256),
    "manifestA.path": `evidence/${facts.runId}.b12.tasks.json`,
    "manifestA.registrationSha256": orNone(facts.manifestA.registrationSha256),
    "manifestA.headSha256": orNone(facts.manifestA.headSha256),
    "manifestB.path": `evidence/${facts.runId}.b12.manifest-B.tasks.json`,
    "manifestB.registrationSha256": orNone(facts.manifestB.registrationSha256),
    "manifestB.headSha256": orNone(facts.manifestB.headSha256),
    "rates.deferral":
      "deferred-to-assemble: voidConditions 4's rates.json byte-identity is assemble's own check; two derivations of one rule is how figures drift",
    // THE SET THAT WAS PROBED, not the constant beside it — the amendment can
    // widen it, and an artifact naming the constant would be unreplayable in
    // exactly the way R22's prereg fields were.
    "clause5.pinnedPaths": joined(facts.clause5.pinnedPaths),
    "clause5.amendment.path": facts.clause5.amendment.path,
    "clause5.amendment.commit": orNone(facts.clause5.amendment.commit),
    "clause5.amendment.sha256": orNone(facts.clause5.amendment.sha256),
    "clause5.amendment.addedPaths": joined(facts.clause5.amendment.addedPaths),
    "clause5.amendment.governs": facts.clause5.amendment.governs ? "yes" : "no",
    // PUBLISHED, and the first attempt at this commit FAILED TO PUBLISH IT: the
    // facts were computed and stored and never serialized, so `assemble.ts` read
    // an absent key, chose UNKNOWN, and the rule could not fire on any real run.
    // The test did not catch it because it supplies `inputs` by hand — it
    // certified a path production cannot reach. Named 2026-08-14 by review.
    "clause5.repairRoundsAmendment.path": facts.clause5.repairRoundsAmendment.path,
    "clause5.repairRoundsAmendment.commit": orNone(facts.clause5.repairRoundsAmendment.commit),
    "clause5.repairRoundsAmendment.sha256": orNone(facts.clause5.repairRoundsAmendment.sha256),
    "clause5.repairRoundsAmendment.governs": facts.clause5.repairRoundsAmendment.governs ? "yes" : "no",
    "clause5.anchor.taskId": orNone(a?.taskId ?? null),
    "clause5.anchor.arm": orNone(a?.arm ?? null),
    "clause5.anchor.attempt": a === null ? "(none)" : String(a.attempt),
    "clause5.anchor.started": orNone(a?.started ?? null),
    "clause5.anchor.commit": orNone(a?.commit ?? null),
    "clause5.anchor.derivation":
      "first observation with aPlusSPositive !== null in REAL runlog-row order; each attempt joined to its unique runlog row by sessionId + (runId, taskId, arm); anchored at its record.started and at the commit introducing its evidence directory",
    "clause5.commitsTouchingPinned": joined(
      facts.clause5.commitsTouchingPinned.map((c) => `${c.sha} ${c.committerDate}`)
    ),
    "clause5.offenders": joined(facts.clause5.offenders),
    "clause5.excusedByReemission": joined(facts.clause5.excusedByReemission),
    // WHICH ARTIFACTS THE ESCAPE ASKED ABOUT, and under which reading of the
    // frozen quantifier (R37#4). Two hard-coded strings could not be replayed
    // or argued with; a named population and a stated reading can be.
    "clause5.reemission.population": joined(runEmittedArtifacts(facts.runId)),
    "clause5.reemission.reading": REEMISSION_READING,
    // The emission item, on the artifact's face. `atHead` appears even with no
    // anchor — a fence that stopped being readable is worth seeing while it is
    // still free to fix, and it decides nothing until the first score.
    "clause5.emission.files": joined(facts.clause5.emission.files),
    "clause5.emission.atAnchor": joined(
      facts.clause5.emission.atAnchor.map((e) => `${e.file} ${orNone(e.sha256)}`)
    ),
    "clause5.emission.atHead": joined(
      facts.clause5.emission.atHead.map((e) => `${e.file} ${orNone(e.sha256)}`)
    ),
    "clause5.emission.drifted": joined(facts.clause5.emission.drifted),
    "clause5.emission.excused": joined(facts.clause5.emission.excused),
    "clause5.emission.problems": joined(facts.clause5.emission.problems),
    "clause5.evidencePaths": joined(facts.clause5.evidencePaths),
    "clause5.evidenceDigest": facts.clause5.evidenceDigest,
    "clause6.attestationPath": `evidence/${facts.runId}.b12.suite.json`,
    "clause6.attestationSha256": orNone(facts.clause6.attestationSha256),
    "clause6.subjectCommit": orNone(att?.subjectCommit ?? null),
    // The `Array.isArray` guards are not defensive habit: these read
    // COMMITTED bytes, and a malformed attestation must still produce the
    // void artifact that reports it, never a crash instead of a verdict.
    "clause6.controls": joined(
      CONTROL_TESTS.map((control) => {
        const matches = Array.isArray(att?.tests)
          ? att.tests.filter((x) => x?.fullName === control.fullName && x?.file === control.file)
          : [];
        const status = matches.length === 0 ? "absent" : matches.length > 1 ? `ambiguous(${matches.length})` : String(matches[0]!.status);
        return `${control.file}::${control.fullName}=${status}`;
      })
    ),
    "clause6.files": joined(
      CONFORMANCE_FILES.map((file) => {
        const f = Array.isArray(att?.files) ? att.files.find((x) => x?.file === file) : undefined;
        return f === undefined
          ? `${file} absent`
          : `${file} total=${String(f.total)} passed=${String(f.passed)} failed=${String(f.failed)} skipped=${String(f.skipped)}`;
      })
    ),
    // REPORTED, DECIDING NOTHING — the same standing this project gives the
    // capped/uncapped pair and the per-task denominator share. It exists so a
    // reader can SEE whether the conformance suite moved between the act and
    // the attestation, including in the window the amendment's clock does not
    // reach. Reading it as a void later would be a void wearing a disguise.
    "clause6.conformanceHashes": joined(
      facts.clause6.conformance.map((c) => {
        const verdictless =
          c.atRegistration === null || c.atSubject === null
            ? "(unknown)"
            : c.atRegistration === c.atSubject
              ? "same"
              : "DIFFERS";
        return `${c.file} registration=${orNone(c.atRegistration)} subject=${orNone(c.atSubject)} ${verdictless}`;
      })
    ),
    "clause6.lockfileClaimed": orNone(typeof att?.lockfileSha256 === "string" ? att.lockfileSha256 : null),
    "clause6.lockfileAtSubject": orNone(facts.clause6.lockfileAtSubject),
    "clause6.firingPath": `evidence/${facts.runId}.b12.firing.json`,
    "clause6.firingSha256": orNone(facts.clause6.firingSha256),
    "clause6.firingBaseCommit": orNone(facts.clause6.firing?.baseCommit ?? null),
    // SORTED, both of them. R41#5: these were rendered in the artifact's own
    // array order, so two artifacts asserting identical facts in different
    // orders produced different canonical inputs — and the whole point of this
    // serialization is that identical facts have ONE spelling.
    "clause6.firingPairs": joined(
      (facts.clause6.firing?.pairs ?? [])
        .map((p) => `${p.id}=${p.fired ? "fired" : "NOT-FIRED"}`)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    ),
    // REPORTED, DECIDING NOTHING — see FiringEvidence.toolchain. It is on the
    // artifact's face so a reader can ask which machine the controls fired on
    // without asking a person, and it voids nothing.
    "clause6.firingToolchain": orNone(
      facts.clause6.firing?.toolchain === undefined
        ? null
        : [
            facts.clause6.firing.toolchain.platform ?? "?",
            facts.clause6.firing.toolchain.arch ?? "?",
            facts.clause6.firing.toolchain.nodeVersion ?? "?",
            facts.clause6.firing.toolchain.vitest ?? "?",
          ].join(" ")
    ),
    // SERIALIZED HERE, and the comment above `clause5.repairRoundsAmendment` is
    // why this line exists at all: that rule's facts were computed, stored and
    // never written out, so every consumer read an absent key and the clause
    // could not fire on any real run. The unit test missed it because it hands
    // `inputs` in by hand — it certified a path production cannot reach. The
    // producer path is exercised deliberately in tests/b12-audit.test.ts.
    "clause6.toolchainAmendment.path": facts.clause6.toolchainAmendment.path,
    "clause6.toolchainAmendment.commit": orNone(facts.clause6.toolchainAmendment.commit),
    "clause6.toolchainAmendment.sha256": orNone(facts.clause6.toolchainAmendment.sha256),
    "clause6.toolchainAmendment.governs": facts.clause6.toolchainAmendment.governs ? "yes" : "no",
    "clause6.runToolchain.declared": toolchainLabel(facts.clause6.runToolchain.declared),
    "clause6.runToolchain.firing": toolchainLabel(facts.clause6.runToolchain.firing),
    "clause6.runToolchain.suite": toolchainLabel(facts.clause6.runToolchain.suite),
    // One line carrying BOTH comparisons, because a reader who sees only that
    // "something disagreed" cannot tell which surface to go and look at.
    "clause6.runToolchain.agreement": [
      `firing=${agreementLabel(facts.clause6.runToolchain.firingAgreement)}`,
      `suite=${agreementLabel(facts.clause6.runToolchain.suiteAgreement)}`,
    ].join("; "),
    "clause6.firingSubjects": joined(
      facts.clause6.firingSubjectsAtBase
        .map((s) => `${s.path}=${String(s.claimed).slice(0, 12)}/${String(s.recomputed).slice(0, 12)}`)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    ),
    "tool.srcSha256": orNone(facts.toolSrcSha256),
  };
}

/**
 * Build the artifact and PROVE it replays: serialized, re-parsed through the
 * consumer's own `parseGitAudit`, and its key set asserted EQUAL to
 * `AUDIT_INPUT_KEYS` — before any write. `parseGitAudit` drops non-string
 * values silently, so without this assertion the producer could agree with
 * itself about an incomplete set it invented.
 */
export function buildAuditArtifact(facts: AuditFacts): {
  artifact: { ran: true; verdict: "clean" | "void"; reasons: string[]; inputs: Record<string, string> };
  parsed: GitAudit;
} {
  const { verdict, reasons } = decideAudit(facts);
  const artifact = { ran: true as const, verdict, reasons, inputs: auditInputs(facts) };
  const parsed = parseGitAudit(JSON.parse(JSON.stringify(artifact)));
  if (!parsed.ran) {
    throw new Error("the audit artifact does not survive parseGitAudit — refusing to write an artifact the consumer would discard");
  }
  const got = Object.keys(parsed.inputs).sort();
  const want = [...AUDIT_INPUT_KEYS].sort();
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
    const missing = want.filter((k) => !got.includes(k));
    const extra = got.filter((k) => !want.includes(k));
    throw new Error(
      `the audit inputs do not match AUDIT_INPUT_KEYS (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}) — refusing to write`
    );
  }
  return { artifact, parsed };
}

// ---------------------------------------------------------------------------
// The impure collector.
// ---------------------------------------------------------------------------

/** Git did not ANSWER — a refusal, never an artifact. */
export class AuditRefused extends Error {}

export interface CollectorOptions {
  /** Test seams only; the CLI always runs the frozen constants. The artifact
   * records what was used, so a divergence is on its face. */
  preregFrozenCommit?: string;
  preregPath?: string;
  pinnedPaths?: readonly string[];
  /** Test seam: the files clause 5's emission fence is read from. */
  emissionFencedFiles?: readonly string[];
  /** Test seam: where the conformance-path amendment lives. */
  amendmentPath?: string;
  /** Test seam: where the repair-max-rounds amendment lives. */
  repairRoundsAmendmentPath?: string;
  runToolchainAmendmentPath?: string;
  /** Test seam: wrap or replace the git runner — how the oracle makes a
   * MANDATORY probe fail without corrupting a repository. */
  gitRunner?: Git;
}

export interface Git {
  (args: string[]): { ok: boolean; out: string };
}

function gitIn(repoRoot: string): Git {
  return (args) => {
    const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error !== undefined) {
      throw new AuditRefused(`git did not answer (${String(r.error)}) — an audit that could not look is not an audit`);
    }
    return { ok: r.status === 0, out: r.stdout ?? "" };
  };
}

/**
 * Every nested field of a committed firing artifact, checked.
 *
 * R41#2. Shallow validation let malformed bytes through to the decider, where
 * `fire.baseline.allGreen` on an absent `baseline` throws — and an audit that
 * throws on hostile input is an audit that can be silenced by hostile input.
 * Failing here yields `null`, which decides the same VOID as an absent
 * artifact, because bytes that cannot be read as evidence are not evidence.
 */
export function isFiringEvidence(v: unknown): v is FiringEvidence {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.schema !== "b12-firing/1") return false;
  if (typeof o.baseCommit !== "string" || o.baseCommit === "") return false;
  if (typeof o.allFired !== "boolean") return false;
  const strings = (x: unknown): boolean => Array.isArray(x) && x.every((s) => typeof s === "string");
  if (!strings(o.problems)) return false;
  const base = o.baseline as Record<string, unknown> | undefined;
  if (typeof base !== "object" || base === null) return false;
  if (typeof base.allGreen !== "boolean" || !strings(base.problems)) return false;
  const ref = (x: unknown): boolean => {
    if (typeof x !== "object" || x === null) return false;
    const c = x as Record<string, unknown>;
    return typeof c.file === "string" && c.file !== "" && typeof c.fullName === "string" && c.fullName !== "";
  };
  if (!Array.isArray(o.controlsEvaluated) || !o.controlsEvaluated.every(ref)) return false;
  if (!Array.isArray(o.pairs)) return false;
  for (const p of o.pairs) {
    if (typeof p !== "object" || p === null) return false;
    const pair = p as Record<string, unknown>;
    if (typeof pair.id !== "string" || pair.id === "") return false;
    if (typeof pair.fired !== "boolean" || typeof pair.detail !== "string") return false;
    if (!ref(pair.control)) return false;
  }
  if (!Array.isArray(o.subjects)) return false;
  for (const s of o.subjects) {
    if (typeof s !== "object" || s === null) return false;
    const sub = s as Record<string, unknown>;
    if (typeof sub.id !== "string" || sub.id === "") return false;
    if (typeof sub.path !== "string" || sub.path === "") return false;
    if (sub.sha256AtBase !== null && typeof sub.sha256AtBase !== "string") return false;
  }
  return true;
}

const blobSha = (git: Git, ref: string, rel: string): string | null => {
  const r = git(["show", `${ref}:${rel}`]);
  return r.ok ? sha256(r.out) : null;
};

/**
 * THE ARTIFACTS THE EMISSION WRITES, and therefore the ones clause 5's
 * re-emission escape can ask about. `emitRun` derives its own two write paths
 * from this function, so the escape's population and the emission's output are
 * ONE list. A third emitted artifact cannot appear without landing here, which
 * is the defect R24 already paid for once: naming files by hand is not the
 * same as covering the population.
 *
 * WHICH READING OF THE FROZEN QUANTIFIER THIS IS, said out loud (R37#4). The
 * text is "without every existing evidence/ artifact for the run being
 * RE-EMITTED FROM THE ARCHIVE". Read literally over the frozen inventory it is
 * unsatisfiable: that inventory contains the two sealed manifests, and the
 * register seals them create-only (`wx`) with a commit touching manifest A
 * being its own VOID — so "re-emit every artifact" cannot be done, the escape
 * can never be obtained, and half the sentence becomes dead letter. The
 * reading applied here is the only one under which the escape has content:
 * the population is what re-emission PRODUCES. It is recorded on the
 * artifact's face so a replayer can see it and disagree, rather than having to
 * infer it from two hard-coded strings.
 *
 * STILL OPEN, and it is the project owner's call, not this function's:
 * narrowing the frozen quantifier to "every DERIVED artifact" is a pre-data
 * amendment. Until one exists, the sentence and the code disagree in wording
 * and agree in effect.
 */
export function runEmittedArtifacts(runId: string): readonly string[] {
  return [`evidence/${runId}.b12.counterfactual.json`, `evidence/${runId}.b12.result.json`];
}

/** The reading above, verbatim on the artifact, because a rule a replayer
 * cannot see is a rule only the author can check. */
export const REEMISSION_READING =
  "population = what re-emission PRODUCES (emitRun's own write paths). The frozen quantifier says every existing evidence/ artifact for the run; read over the frozen inventory that is unsatisfiable, because the two manifests are sealed create-only and a commit touching manifest A is itself a VOID. Narrowing the quantifier is a pre-data amendment and none exists.";

/**
 * A git question that WAS ASKED, kept distinct from one that could not be.
 *
 * `{ok: true, commit: null}` is an ANSWER — the history carries no such commit.
 * `{ok: false}` is the absence of one. Both used to be `null`, and both then
 * read as "the amendment does not govern": a repository the audit could not
 * interrogate silently ran the PRE-AMENDMENT regime and published a verdict
 * naming the wrong one. That is the exact shape the comment above the ancestry
 * test already refused for `isAncestor`, applied one call earlier. Named
 * 2026-08-14 by adversarial review, which also confirmed no test or production
 * path depends on a command FAILURE meaning false.
 */
type CommitAnswer = { readonly ok: true; readonly commit: string | null } | { readonly ok: false };

/** Force the answer, refusing where there is none. A refusal writes no artifact and is retryable. */
function orRefuse(answer: CommitAnswer, question: string): string | null {
  if (!answer.ok) {
    throw new AuditRefused(`${question} cannot be asked of this repository — git did not answer, and guessing would publish a verdict under a regime nobody established`);
  }
  return answer.commit;
}

/** The commit that INTRODUCED a path: the last line of `git log --diff-filter=A`. */
function introducingCommit(git: Git, rel: string): CommitAnswer {
  const r = git(["log", "--diff-filter=A", "--format=%H", "--", rel]);
  if (!r.ok) return { ok: false };
  const lines = r.out.trim().split("\n").filter(Boolean);
  return { ok: true, commit: lines.length === 0 ? null : lines[lines.length - 1]! };
}

/** The most recent commit touching a path; `commit: null` when none does. */
function lastCommit(git: Git, rel: string): CommitAnswer {
  const r = git(["log", "-1", "--format=%H", "--", rel]);
  if (!r.ok) return { ok: false };
  const line = r.out.trim();
  return { ok: true, commit: line === "" ? null : line };
}

/**
 * `merge-base --is-ancestor` answers with its EXIT CODE: 0 yes, non-zero no —
 * but non-zero is ALSO what an unknown commit returns, and "no" and "cannot
 * ask" fire different clauses. Both endpoints are existence-checked before a
 * failure is read as a real "no".
 */
function isAncestor(git: Git, a: string, b: string): boolean | null {
  const probe = git(["merge-base", "--is-ancestor", a, b]);
  if (probe.ok) return true;
  if (!git(["cat-file", "-e", `${a}^{commit}`]).ok) return null;
  if (!git(["cat-file", "-e", `${b}^{commit}`]).ok) return null;
  return false;
}

export function collectAuditFacts(repoRoot: string, runId: string, options: CollectorOptions = {}): AuditFacts {
  const git = options.gitRunner ?? gitIn(repoRoot);
  const head = git(["rev-parse", "HEAD"]);
  if (!head.ok) {
    throw new AuditRefused("git answered but HEAD does not resolve — not a repository this audit can read");
  }
  const headSha = head.out.trim();
  const preregCommit = options.preregFrozenCommit ?? PREREG_FROZEN_COMMIT;
  const preregPath = options.preregPath ?? PREREG_PATH;
  const pinnedPaths = options.pinnedPaths ?? PINNED_PATHS;

  const manifestRel = `evidence/${runId}.b12.tasks.json`;
  const manifestBRel = `evidence/${runId}.b12.manifest-B.tasks.json`;
  const registrationCommit = orRefuse(introducingCommit(git, manifestRel), `the commit introducing ${manifestRel}`);

  // ---- clause 5: the anchor, from COMMITTED artifacts only ----------------
  const anchorProblems: string[] = [];
  let anchor: AuditFacts["clause5"]["anchor"] = null;
  const cfShow = git(["show", `HEAD:evidence/${runId}.b12.counterfactual.json`]);
  const runlogShow = git(["show", `HEAD:evidence/${runId}.b12.runlog.jsonl`]);
  if (!cfShow.ok) {
    anchorProblems.push(`HEAD carries no evidence/${runId}.b12.counterfactual.json — the anchor derivation needs the committed observations`);
  } else if (!runlogShow.ok) {
    anchorProblems.push(`HEAD carries no evidence/${runId}.b12.runlog.jsonl — real row order is the anchor's clock`);
  } else {
    // THE CATCH COVERS THE COUNTERFACTUAL'S PARSE AND NOTHING ELSE (R32).
    //
    // It used to wrap the whole derivation below, including the MANDATORY
    // directory probe that throws `AuditRefused` by design. A git that could
    // not answer was therefore caught here, relabelled "the counterfactual
    // does not parse" — a claim about a file that parsed perfectly — and
    // `decideAudit` turned that fabricated anchor problem into a VOID. That
    // inverts the whole doctrine: a refusal is retryable and writes no
    // artifact; a VOID is a committable verdict that kills a paid run. A
    // transient git failure may not spend the run.
    type Counterfactual = {
      observations?: Array<{ taskId?: unknown; arm?: unknown; attempt?: unknown; aPlusSPositive?: unknown }>;
    };
    let cf: Counterfactual | null = null;
    try {
      const parsed: unknown = JSON.parse(cfShow.out);
      // `null` and scalars parse without throwing and carry no observations —
      // the same nothing a broken file carries, said out loud rather than
      // read as an empty population.
      if (parsed === null || typeof parsed !== "object") throw new SyntaxError("not an object");
      cf = parsed as Counterfactual;
    } catch {
      anchorProblems.push("the committed counterfactual does not parse — the anchor derivation has no observations to read");
    }
    if (cf !== null) {
      const rows = runlogShow.out
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l, i) => {
          try {
            return { i, row: JSON.parse(l) as Record<string, unknown> };
          } catch {
            return null;
          }
        })
        .filter((x): x is { i: number; row: Record<string, unknown> } => x !== null);
      const joinedObs: Array<{ taskId: string; arm: string; attempt: number; rowIndex: number; sessionId: string; started: string; aPlusSPositive: unknown }> = [];
      // THE POPULATION THE COUNTERFACTUAL CLAIMS, held against the population
      // that is COMMITTED (R29).
      //
      // The anchor used to be derived from `counterfactual.observations`
      // alone, and that list was never shown to cover anything. The
      // counterfactual is written by the EMITTER, so an early unchecked emit
      // followed by more observations leaves a STALE one committed: the loop
      // below finds nothing to join, no anchor problem is raised, and clause 5
      // reads "before the first scored observation — free". A pinned-path
      // change made after the real first observation then gets a CLEAN audit,
      // and the emission re-derives the same stale state and agrees with it.
      //
      // So the committed observation directories are enumerated and every one
      // of them must be declared. Fail-closed: a probe that cannot answer may
      // not wear the empty list a clean answer wears.
      const declaredDirs = new Set<string>();
      const dirProbe = git(["ls-tree", "-d", "--name-only", "HEAD", `evidence/${runId}/`]);
      if (!dirProbe.ok) {
        throw new AuditRefused(
          `the committed observation directories under evidence/${runId}/ could not be enumerated — the anchor's population cannot be checked, and an empty answer is not a clean one`
        );
      }
      const committedDirs = dirProbe.out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && l.includes("/obs-"));
      for (const o of cf.observations ?? []) {
        if (typeof o.taskId !== "string" || typeof o.arm !== "string" || typeof o.attempt !== "number") {
          // Silently skipped until R29. A malformed entry is a counterfactual
          // that cannot be checked against anything, not a free pass.
          anchorProblems.push(
            `a counterfactual observation carries no (taskId, arm, attempt) — the anchor's population cannot be joined to committed evidence`
          );
          continue;
        }
        const dir = `evidence/${runId}/obs-${o.taskId}-${o.arm}${o.attempt === 1 ? "" : `-r${o.attempt}`}`;
        declaredDirs.add(dir);
        const recShow = git(["show", `HEAD:${dir}/observation.json`]);
        if (!recShow.ok) {
          anchorProblems.push(`${dir}/observation.json is not committed — the attempt cannot be joined to its runlog row`);
          continue;
        }
        let rec: Record<string, unknown>;
        try {
          rec = JSON.parse(recShow.out) as Record<string, unknown>;
        } catch {
          anchorProblems.push(`${dir}/observation.json does not parse`);
          continue;
        }
        const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : null;
        const started = typeof rec.started === "string" ? rec.started : null;
        if (sessionId === null || started === null) {
          anchorProblems.push(`${dir}/observation.json carries no sessionId/started — the join has nothing to hold`);
          continue;
        }
        // The UNIQUE row: sessionId + (runId, taskId, arm). Zero rows cannot
        // anchor; two rows is the collision R7 named, and it may not be
        // silently resolved by picking one.
        const matches = rows.filter(
          ({ row }) =>
            row.sessionId === sessionId && row.runId === runId && row.taskId === o.taskId && row.arm === o.arm
        );
        if (matches.length !== 1) {
          anchorProblems.push(
            `${matches.length} runlog rows match ${o.taskId}/${o.arm} attempt ${o.attempt} by sessionId + (runId, taskId, arm) — the bijection the anchor requires does not hold`
          );
          continue;
        }
        joinedObs.push({
          taskId: o.taskId,
          arm: o.arm,
          attempt: o.attempt,
          rowIndex: matches[0]!.i,
          sessionId,
          started,
          aPlusSPositive: o.aPlusSPositive,
        });
      }
      // THE OTHER DIRECTION, and the one that was missing: committed evidence
      // the counterfactual does not know about. One undeclared directory is
      // enough — the list the anchor walks is not the run.
      for (const dir of committedDirs) {
        if (!declaredDirs.has(dir)) {
          anchorProblems.push(
            `${dir} is committed evidence the counterfactual does not declare — the anchor would be derived from a STALE population (re-emit before auditing)`
          );
        }
      }
      if (anchorProblems.length === 0) {
        joinedObs.sort((a, b) => a.rowIndex - b.rowIndex);
        const first = joinedObs.find((o) => o.aPlusSPositive !== null && o.aPlusSPositive !== undefined);
        if (first !== undefined) {
          const dir = `evidence/${runId}/obs-${first.taskId}-${first.arm}${first.attempt === 1 ? "" : `-r${first.attempt}`}`;
          // `started` is CARRIED from the join, not shown and parsed a second
          // time: the re-read was an unguarded `JSON.parse` over whatever a
          // second `git show` returned, which is a SyntaxError wearing the
          // counterfactual's name if HEAD moved underneath the audit.
          const commit = orRefuse(introducingCommit(git, dir), `the commit introducing ${dir}`);
          if (commit === null) {
            anchorProblems.push(`${dir} has no introducing commit — scored evidence that was never committed cannot anchor the freeze`);
          } else {
            anchor = {
              taskId: first.taskId,
              arm: first.arm,
              attempt: first.attempt,
              started: first.started,
              commit,
            };
          }
        }
      }
    }
  }

  // ---- clause 5: does the conformance-path amendment govern THIS run? -----
  // PROSPECTIVE by construction: the amendment governs only when its own
  // introducing commit is an ancestor of the anchor's commit — "every run
  // whose first scored observation is committed after this artifact". An
  // amendment born later governs nothing, and saying so is the whole point.
  const amendmentPath = options.amendmentPath ?? AMENDMENT_CONFORMANCE_PATHS;
  const amendmentCommit = orRefuse(introducingCommit(git, amendmentPath), `the commit introducing ${amendmentPath}`);
  let amendmentGoverns = false;
  if (amendmentCommit !== null && anchor !== null) {
    const anc = isAncestor(git, amendmentCommit, anchor.commit);
    if (anc === null) {
      throw new AuditRefused(
        `ancestry of the amendment ${amendmentCommit} against the anchor commit cannot be asked — which regime governs this run cannot be decided`
      );
    }
    amendmentGoverns = anc;
  }
  const effectivePinned = amendmentGoverns ? [...pinnedPaths, ...CONFORMANCE_FILES] : [...pinnedPaths];

  // The repair-max-rounds amendment, decided by the SAME prospective test and
  // computed here because this is the only place that holds both a git runner
  // and the anchor. `assemble.ts` cannot ask git anything, so the answer travels
  // to it as a fact rather than being re-derived where it is used.
  //
  // FAIL-CLOSED ON AN UNASKABLE ANCESTRY, exactly as above: a refusal is
  // retryable and writes no artifact, while guessing `false` would silently run
  // the pre-amendment regime and publish a verdict that names the wrong one.
  const rmrPath = options.repairRoundsAmendmentPath ?? AMENDMENT_REPAIR_MAX_ROUNDS;
  const rmrCommit = orRefuse(introducingCommit(git, rmrPath), `the commit introducing ${rmrPath}`);
  let rmrGoverns = false;
  if (rmrCommit !== null && anchor !== null) {
    const anc = isAncestor(git, rmrCommit, anchor.commit);
    if (anc === null) {
      throw new AuditRefused(
        `ancestry of the repair-max-rounds amendment ${rmrCommit} against the anchor commit cannot be asked — which regime governs this run cannot be decided`
      );
    }
    rmrGoverns = anc;
  }

  // The run-toolchain amendment, by the SAME prospective test and with the SAME
  // fail-closed refusal on an unaskable ancestry. What differs is what governance
  // BUYS: this one decides nothing about the verdict. It selects whether the
  // comparison below is published as a governed regime's finding or as a bare
  // observation, and nothing else — the amendment adds no void condition, so
  // there is no branch here that can make a run void.
  const toolchainAmendmentPath = options.runToolchainAmendmentPath ?? AMENDMENT_RUN_TOOLCHAIN;
  const toolchainAmendmentCommit = orRefuse(
    introducingCommit(git, toolchainAmendmentPath),
    `the commit introducing ${toolchainAmendmentPath}`
  );
  let toolchainGoverns = false;
  if (toolchainAmendmentCommit !== null && anchor !== null) {
    const anc = isAncestor(git, toolchainAmendmentCommit, anchor.commit);
    if (anc === null) {
      throw new AuditRefused(
        `ancestry of the run-toolchain amendment ${toolchainAmendmentCommit} against the anchor commit cannot be asked — which regime governs this run cannot be decided`
      );
    }
    toolchainGoverns = anc;
  }

  // ---- clause 5: the two probes, in union ---------------------------------
  const commitsTouchingPinned: Array<{ sha: string; committerDate: string }> = [];
  const offenders: string[] = [];
  const excusedByReemission: string[] = [];
  {
    // FAIL-CLOSED: a failed MANDATORY probe may never wear the same empty
    // list a clean answer wears — "no commits touch the pinned paths" and
    // "the history could not be inspected" fire different clauses.
    const log = git(["log", "--format=%H %cI", "--", ...effectivePinned]);
    if (!log.ok) {
      throw new AuditRefused(
        "git log over the pinned paths failed — clause 5's history cannot be inspected, and an empty answer is not a clean one"
      );
    }
    for (const line of log.out.trim().split("\n").filter(Boolean)) {
      const [sha, committerDate] = line.split(" ");
      if (sha !== undefined && committerDate !== undefined) commitsTouchingPinned.push({ sha, committerDate });
    }
    if (anchor !== null) {
      const anchorMs = Date.parse(anchor.started);
      for (const c of commitsTouchingPinned) {
        const byDate = Date.parse(c.committerDate) > anchorMs;
        const anc = isAncestor(git, c.sha, anchor.commit);
        if (anc === null) {
          throw new AuditRefused(
            `ancestry of ${c.sha} against the anchor commit cannot be asked — clause 5's probe union cannot be computed`
          );
        }
        const byAncestry = anc === false; // NOT an ancestor of the anchor commit
        if (byDate || byAncestry) offenders.push(c.sha);
      }
      // The re-emission escape, PER ARTIFACT: an offender is excused only if
      // EVERY artifact of the run was re-committed with the offender already
      // in its history — merge-base(offender, artifactCommit) == offender.
      const artifacts = runEmittedArtifacts(runId);
      for (const offender of offenders) {
        let excused = true;
        for (const rel of artifacts) {
          const last = orRefuse(lastCommit(git, rel), `the last commit touching ${rel}`);
          if (last === null || isAncestor(git, offender, last) !== true) {
            excused = false;
            break;
          }
        }
        if (excused) excusedByReemission.push(offender);
      }
    }
  }

  // ---- clause 5: the emission fence — the item `pinnedPaths` cannot reach --
  // R37. `src/cost/**` pins the emission LIFECYCLE; the ROW is built in the
  // tool files, and `turns_collapsed` there IS the credited saving's
  // definition. Pinning those files WHOLE would freeze the subject of the
  // experiment, so the comparison is the FENCED REGION at the freeze anchor
  // against the same region at the head being audited: editing `gate.ts`
  // anywhere else is lawful, moving the emission is not.
  const emissionFencedFiles = options.emissionFencedFiles ?? EMISSION_FENCED_FILES;
  const emissionAtAnchor: Array<{ file: string; sha256: string | null }> = [];
  const emissionAtHead: Array<{ file: string; sha256: string | null }> = [];
  const emissionDrifted: string[] = [];
  const emissionExcused: string[] = [];
  const emissionProblems: string[] = [];
  {
    /** `file: false` is "not at that ref"; `sha256: null` is "there, unfenced". */
    const fenceAt = (ref: string, rel: string): { file: boolean; sha256: string | null } => {
      const show = git(["show", `${ref}:${rel}`]);
      if (!show.ok) return { file: false, sha256: null };
      const fence = fencedEmission(show.out);
      return { file: true, sha256: fence === null ? null : sha256(fence) };
    };
    const artifacts = runEmittedArtifacts(runId);
    for (const rel of emissionFencedFiles) {
      // Recorded ALWAYS — a reader can see the fence on the artifact's face
      // before any observation is scored, which is when a broken pin is still
      // cheap to fix.
      const atHead = fenceAt(headSha, rel);
      emissionAtHead.push({ file: rel, sha256: atHead.sha256 });
      if (anchor === null) continue; // clause 5's own text: free until the first score
      const atAnchor = fenceAt(anchor.commit, rel);
      emissionAtAnchor.push({ file: rel, sha256: atAnchor.sha256 });

      if (!atAnchor.file) {
        emissionProblems.push(
          `${rel} does not exist at the freeze anchor ${anchor.commit.slice(0, 12)} — the emission item has nothing to pin`
        );
        continue;
      }
      if (atAnchor.sha256 === null) {
        emissionProblems.push(
          `${rel} carries no readable ${EMISSION_FENCE_BEGIN} fence at the freeze anchor — a pin that cannot be read is not a pin`
        );
        continue;
      }
      if (!atHead.file || atHead.sha256 === null) {
        emissionProblems.push(
          `${rel} carries no readable ${EMISSION_FENCE_BEGIN} fence at the audited head — the emission left the fence after the first scored observation`
        );
        continue;
      }
      if (atHead.sha256 === atAnchor.sha256) continue;

      // The emission MOVED. Name the commits that moved it, so the SAME
      // re-emission escape can be asked of them on the same terms.
      const log = git(["log", "--format=%H %cI", "--", rel]);
      if (!log.ok) {
        throw new AuditRefused(
          `git log over ${rel} failed — clause 5's emission fence cannot be attributed, and an empty answer is not a clean one`
        );
      }
      let named = 0;
      for (const line of log.out.trim().split(/\r?\n/).filter(Boolean)) {
        const [sha, committerDate] = line.split(" ");
        if (sha === undefined || committerDate === undefined) continue;
        const byDate = Date.parse(committerDate) > Date.parse(anchor.started);
        const anc = isAncestor(git, sha, anchor.commit);
        if (anc === null) {
          throw new AuditRefused(
            `ancestry of ${sha} against the anchor commit cannot be asked — clause 5's emission fence cannot be attributed`
          );
        }
        if (!(byDate || anc === false)) continue;
        if (fenceAt(sha, rel).sha256 === atAnchor.sha256) continue;
        named += 1;
        emissionDrifted.push(`${sha} ${rel}`);
        let excused = true;
        for (const relArtifact of artifacts) {
          const last = orRefuse(lastCommit(git, relArtifact), `the last commit touching ${relArtifact}`);
          if (last === null || isAncestor(git, sha, last) !== true) {
            excused = false;
            break;
          }
        }
        if (excused) emissionExcused.push(`${sha} ${rel}`);
      }
      // FAIL-CLOSED: the digests disagree and nothing in the history owns the
      // difference. That is not a clean fence, it is an unexplained one.
      if (named === 0) {
        emissionProblems.push(
          `${rel}'s emission fence differs between the freeze anchor and the audited head, and no commit touching it after the anchor accounts for the difference`
        );
      }
    }
  }

  // The evidence clause 5 was COMPUTED FROM, digested so the emission-time
  // binding can prove it is scoring the archive that was audited (R24). A
  // failed enumeration is git not answering — a refusal, never "no evidence".
  const evidence = runEvidenceDigest(runId, git);
  if (evidence.digest === null) {
    throw new AuditRefused(
      `the clause-5 evidence under evidence/${runId}/ could not be enumerated or read — an audit that cannot name what it judged cannot be replayed`
    );
  }

  // ---- clause 6: the committed attestation --------------------------------
  const suiteRel = `evidence/${runId}.b12.suite.json`;
  const suiteShow = git(["show", `HEAD:${suiteRel}`]);
  let attestation: SuiteAttestation | null = null;
  let attestationSha256: string | null = null;
  let subjectIsAncestor: boolean | null = null;
  let nonEvidenceDrift: string[] = [];
  if (suiteShow.ok) {
    attestationSha256 = sha256(suiteShow.out);
    // The catch is the PARSE'S alone — a wider one would swallow the
    // fail-closed refusals below and turn them back into "no attestation".
    let parsed: SuiteAttestation | null = null;
    try {
      const candidate = JSON.parse(suiteShow.out) as SuiteAttestation;
      if (candidate.schema === "b12-suite/1" && typeof candidate.subjectCommit === "string" && Array.isArray(candidate.tests)) {
        parsed = candidate;
      }
    } catch {
      parsed = null;
    }
    if (parsed !== null) {
      attestation = parsed;
      subjectIsAncestor = isAncestor(git, parsed.subjectCommit, headSha);
      if (subjectIsAncestor === true) {
        // FAIL-CLOSED, same doctrine as the clause-5 log: a failed diff may
        // not impersonate "no drift".
        const diff = git(["diff", "--name-only", `${parsed.subjectCommit}..HEAD`]);
        if (!diff.ok) {
          throw new AuditRefused(
            "git diff subjectCommit..HEAD failed — the attestation's non-evidence drift cannot be inspected"
          );
        }
        nonEvidenceDrift = diff.out
          .trim()
          .split("\n")
          .filter(Boolean)
          .filter((p) => !p.startsWith("evidence/"));
      }
    }
  }

  // ---- clause 6: the committed FIRING evidence ----------------------------
  // Same shape as the attestation above, and read the same way: from HEAD, by
  // its own name, parsed narrowly, fail-closed on anything it cannot answer.
  const firingRel = `evidence/${runId}.b12.firing.json`;
  const firingShow = git(["show", `HEAD:${firingRel}`]);
  let firing: FiringEvidence | null = null;
  let firingSha256: string | null = null;
  if (firingShow.ok) {
    firingSha256 = sha256(firingShow.out);
    try {
      const candidate = JSON.parse(firingShow.out) as FiringEvidence;
      // R41#2: the guard used to stop at the top level, so a committed artifact
      // with a missing `baseline` or a null row reached the decider and THREW —
      // an exception where a deterministic VOID belongs. Every nested field is
      // checked here, and anything that fails becomes `null`, which is the same
      // VOID as "no evidence": malformed committed bytes are not evidence.
      if (isFiringEvidence(candidate)) firing = candidate;
    } catch {
      firing = null;
    }
  }
  // THE DECLARED IDENTITY, read from manifest A at HEAD. It is the reference the
  // other two are compared against, so it is read from the run's own declaration
  // rather than inferred from either proof — a proof cannot be its own reference.
  // Unreadable, unparseable or undeclared all arrive as `known: false`, which the
  // amendment says is never a match.
  const manifestAShow = git(["show", `HEAD:evidence/${runId}.b12.tasks.json`]);
  let declaredToolchain: ToolchainReading = { known: false, why: "manifest A is unreadable at HEAD" };
  if (manifestAShow.ok) {
    try {
      const parsed = JSON.parse(manifestAShow.out) as unknown;
      const pinned = isPlainObject(parsed) ? parsed.pinned : undefined;
      declaredToolchain = isPlainObject(pinned)
        ? normaliseToolchain(pinned.runToolchain)
        : { known: false, why: "manifest A carries no pinned block" };
    } catch {
      declaredToolchain = { known: false, why: "manifest A does not parse" };
    }
  }
  const firingToolchain: ToolchainReading =
    firing === null ? { known: false, why: "no firing artifact" } : normaliseToolchain(firing.toolchain);
  const suiteToolchain: ToolchainReading =
    attestation === null ? { known: false, why: "no suite attestation" } : normaliseToolchain(attestation.toolchain);

  const firingSubjectsAtBase =
    firing === null
      ? []
      : firing.subjects.map((s) => ({
          path: s.path,
          claimed: s.sha256AtBase,
          recomputed: blobSha(git, firing.baseCommit, s.path),
        }));

  return {
    runId,
    head: headSha,
    registrationCommit,
    prereg: {
      path: preregPath,
      frozenCommit: preregCommit,
      frozenSha256: blobSha(git, preregCommit, preregPath),
      headSha256: blobSha(git, "HEAD", preregPath),
    },
    manifestA: {
      registrationSha256: registrationCommit === null ? null : blobSha(git, registrationCommit, manifestRel),
      headSha256: blobSha(git, "HEAD", manifestRel),
    },
    manifestB: {
      registrationSha256: registrationCommit === null ? null : blobSha(git, registrationCommit, manifestBRel),
      headSha256: blobSha(git, "HEAD", manifestBRel),
    },
    clause5: {
      anchor,
      anchorProblems,
      pinnedPaths: effectivePinned,
      amendment: {
        path: amendmentPath,
        commit: amendmentCommit,
        sha256: blobSha(git, "HEAD", amendmentPath),
        addedPaths: CONFORMANCE_FILES,
        governs: amendmentGoverns,
      },
      // A SIBLING, NOT A MEMBER of clause 5's amendment above: this one widens
      // no path set and moves no clock. It sits inside `clause5` only because
      // that is where the anchor and the git runner already are, and its own
      // clause lives in `assemble.ts`.
      repairRoundsAmendment: {
        path: rmrPath,
        commit: rmrCommit,
        sha256: blobSha(git, "HEAD", rmrPath),
        governs: rmrGoverns,
      },
      commitsTouchingPinned,
      offenders,
      excusedByReemission,
      emission: {
        files: emissionFencedFiles,
        atAnchor: emissionAtAnchor,
        atHead: emissionAtHead,
        drifted: emissionDrifted,
        excused: emissionExcused,
        problems: emissionProblems,
      },
      evidencePaths: evidence.paths,
      evidenceDigest: evidence.digest,
    },
    clause6: {
      attestation,
      attestationSha256,
      subjectIsAncestor,
      nonEvidenceDrift,
      lockfileAtSubject: attestation === null ? null : blobSha(git, attestation.subjectCommit, "package-lock.json"),
      firing,
      firingSha256,
      firingSubjectsAtBase,
      toolchainAmendment: {
        path: toolchainAmendmentPath,
        commit: toolchainAmendmentCommit,
        sha256: blobSha(git, "HEAD", toolchainAmendmentPath),
        governs: toolchainGoverns,
      },
      runToolchain: {
        declared: declaredToolchain,
        firing: firingToolchain,
        suite: suiteToolchain,
        firingAgreement: toolchainAgreement(declaredToolchain, firingToolchain),
        suiteAgreement: toolchainAgreement(declaredToolchain, suiteToolchain),
      },
      // Reported beside the verdict, never inside it.
      conformance: CONFORMANCE_FILES.map((file) => ({
        file,
        atRegistration: registrationCommit === null ? null : blobSha(git, registrationCommit, file),
        atSubject: attestation === null ? null : blobSha(git, attestation.subjectCommit, file),
      })),
    },
    toolSrcSha256: blobSha(git, "HEAD", "src/cost/b12/audit.ts"),
  };
}

/**
 * Working-tree entries OUTSIDE `evidence/**` — the attestation REFUSES them:
 * the suite executes DISK code while `subjectCommit` names HEAD, so a dirty
 * edit could pass the suite, be attested under an untouched commit's name,
 * and be discarded before anything lands. The audit's own drift check
 * (`subjectCommit..HEAD`) sees COMMITS only and cannot catch this.
 * `evidence/**` stays writable because the attestation itself is born there.
 */
export function workingTreeDirtOutsideEvidence(repoRoot: string, gitRunner?: Git): string[] {
  const status = (gitRunner ?? gitIn(repoRoot))(["status", "--porcelain"]);
  if (!status.ok) {
    throw new AuditRefused("git status failed — the tree's cleanliness cannot be inspected");
  }
  const dirt: string[] = [];
  for (const line of status.out.split("\n")) {
    if (line.trim() === "") continue;
    const entry = line.slice(3);
    // Renames carry both halves; quoted paths carry quotes. Either half
    // escaping evidence/ makes the entry dirt.
    const parts = entry.split(" -> ").map((p) => p.replace(/^"|"$/g, ""));
    if (parts.some((p) => !p.startsWith("evidence/"))) dirt.push(entry.trim());
  }
  return dirt;
}

// ---------------------------------------------------------------------------
// The attestation producer (`--attest-suite`).
// ---------------------------------------------------------------------------

/** Parse a vitest JSON-reporter payload into the attestation's rows. */
export function attestationFromVitest(
  runId: string,
  subjectCommit: string,
  generatedAt: string,
  vitestJson: unknown,
  lockfileSha256: string
): SuiteAttestation {
  const results =
    typeof vitestJson === "object" && vitestJson !== null
      ? ((vitestJson as Record<string, unknown>).testResults as Array<Record<string, unknown>> | undefined) ?? []
      : [];
  const tests: SuiteAttestation["tests"] = [];
  const perFile = new Map<string, { total: number; passed: number; failed: number; skipped: number }>();
  for (const suite of results) {
    const abs = typeof suite.name === "string" ? suite.name : "";
    const file = abs.split("\\").join("/").replace(/^.*\/(tests\/[^/]+)$/, "$1");
    const bucket = perFile.get(file) ?? { total: 0, passed: 0, failed: 0, skipped: 0 };
    for (const t of (suite.assertionResults as Array<Record<string, unknown>> | undefined) ?? []) {
      const fullName = typeof t.fullName === "string" ? t.fullName : "";
      const status = typeof t.status === "string" ? t.status : "unknown";
      tests.push({ file, fullName, status });
      bucket.total++;
      if (status === "passed") bucket.passed++;
      else if (status === "failed") bucket.failed++;
      else bucket.skipped++;
    }
    perFile.set(file, bucket);
  }
  return {
    schema: "b12-suite/1",
    runId,
    subjectCommit,
    generatedAt,
    lockfileSha256,
    files: [...perFile.entries()].map(([file, b]) => ({ file, ...b })),
    tests,
  };
}

// ---------------------------------------------------------------------------
// CLI: `node dist/cost/b12/audit.js <runId> [--attest-suite]`
// ---------------------------------------------------------------------------

const isMain = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const runId = args[0];
  if (runId === undefined || runId.startsWith("--")) {
    process.stderr.write("usage: node dist/cost/b12/audit.js <runId> [--attest-suite]\n");
    process.exit(2);
  }
  // THE RUN ID BECOMES A PATH HERE (R30), so it is held to the grammar the
  // register already applies at ITS point of use — the same rule, in the
  // second place that interpolates an id into a filename. Without it
  // `../../something` escaped `evidence/` and OVERWROTE whatever sat at the
  // resolved path: a destructive boundary failure reachable by a typo.
  if (!SAFE_RUN_ID.test(runId)) {
    process.stderr.write(
      `refusing runId ${JSON.stringify(runId)} — it becomes a filename under evidence/, and only ${SAFE_RUN_ID.source} may\n`
    );
    process.exit(2);
  }
  const repoRoot = process.cwd();
  try {
    if (args.includes("--attest-suite")) {
      // Writes ONLY the attestation, then stops: the operator commits it, and
      // the audit proper reads the COMMITTED bytes on its next invocation.
      const git = gitIn(repoRoot);
      const head = git(["rev-parse", "HEAD"]);
      if (!head.ok) throw new AuditRefused("git answered but HEAD does not resolve");
      const dirt = workingTreeDirtOutsideEvidence(repoRoot);
      if (dirt.length > 0) {
        throw new AuditRefused(
          `the working tree is dirty outside evidence/ (${dirt.slice(0, 5).join(", ")}${dirt.length > 5 ? ", …" : ""}) — the suite would attest DISK code under subjectCommit's name; commit or revert first`
        );
      }
      // THE SUITE RUNS FROM AN IMMUTABLE CHECKOUT OF `subjectCommit`, not
      // from the working tree. The cleanliness check above is a courtesy that
      // fails fast; it cannot be the guarantee, because the suite runs for
      // minutes and an edit made after the check and reverted before the
      // commit would leave NO drift for the audit to find (R15). A detached
      // worktree cannot be edited into the run: vitest loads committed bytes
      // or nothing. It lives under `.b12/` — ignored, inside the repo, so
      // node_modules resolves upward exactly as the arm worktrees already
      // rely on.
      const subjectCommit = head.out.trim();
      const treeDir = path.join(repoRoot, ".b12", `attest-${process.pid}`);
      rmSync(treeDir, { recursive: true, force: true });
      const added = git(["worktree", "add", "--detach", treeDir, subjectCommit]);
      if (!added.ok) {
        throw new AuditRefused(`could not create the attestation worktree at ${treeDir} — the suite may not run over mutable bytes`);
      }
      // THE DEPENDENCIES COME FROM THE SUBJECT COMMIT'S LOCKFILE (R24). The
      // worktree lives under `.b12/`, so node resolution walks UP into the
      // enclosing repository's `node_modules` — a newer, staler or
      // hand-modified installation could carry the suite past a commit whose
      // own lockfile does not even build, and the attestation would record
      // only `subjectCommit`, hiding the skew. `npm ci` installs INTO the
      // worktree from the checked-out `package-lock.json`, and the nearer
      // `node_modules` wins every resolution afterwards.
      const lockShow = git(["show", `${subjectCommit}:package-lock.json`]);
      if (!lockShow.ok) {
        rmSync(treeDir, { recursive: true, force: true });
        git(["worktree", "prune"]);
        throw new AuditRefused(
          `${subjectCommit.slice(0, 12)} carries no package-lock.json — the suite cannot be installed from the commit it would attest`
        );
      }
      const lockfileSha256 = sha256(lockShow.out);
      // Exactly `suiteRunRefusal`'s contract — the encoding: "utf8" overload
      // returns strings, but the generic signature does not say so.
      let run: { error?: unknown; status: number | null; signal: string | null; stdout: string | null };
      try {
        const installed = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], {
          cwd: treeDir,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          shell: process.platform === "win32",
        });
        if (installed.status !== 0) {
          throw new AuditRefused(
            `the attestation worktree does not install (exit ${String(installed.status)}) — the suite may not run on dependencies the subject commit does not pin:\n${(installed.stderr || installed.stdout || "").slice(0, 2000)}`
          );
        }
        // THE BUILD HAPPENS IN THE WORKTREE. `dist/` is derived and ignored,
        // so a fresh checkout has none — and six conformance tests invoke the
        // built CLI. Compiling here is not a workaround: it makes the
        // attested `dist/` the compilation OF THE ATTESTED COMMIT, which is
        // the registered `dist/` hole (F24) closed for this path.
        const built = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
          cwd: treeDir,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          shell: process.platform === "win32",
        });
        if (built.status !== 0) {
          throw new AuditRefused(
            `the attestation worktree does not build (exit ${String(built.status)}) — the suite cannot attest a commit that does not compile:\n${(built.stderr || built.stdout || "").slice(0, 2000)}`
          );
        }
        run = spawnSync(
          process.platform === "win32" ? "npx.cmd" : "npx",
          ["vitest", "run", "--root", treeDir, ...CONFORMANCE_FILES, "--reporter=json"],
          { cwd: treeDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: process.platform === "win32" }
        );
      } finally {
        rmSync(treeDir, { recursive: true, force: true });
        git(["worktree", "prune"]);
      }
      // The COMMAND's verdict before the report's: only the two named files
      // run here, and the Windows baseline's four failures live in others —
      // so exit 0 is both required and reachable.
      const { refusal, jsonLine } = suiteRunRefusal(run);
      if (refusal !== null) throw new AuditRefused(refusal);
      const attestation = attestationFromVitest(
        runId,
        subjectCommit,
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        JSON.parse(jsonLine),
        lockfileSha256
      );
      const out = evidenceArtifactPath(repoRoot, runId, ".b12.suite.json");
      writeFileSync(out, JSON.stringify(attestation, null, 2) + "\n", "utf8");
      process.stdout.write(`${out}\n(commit it; the audit reads the COMMITTED bytes)\n`);
    } else {
      const facts = collectAuditFacts(repoRoot, runId);
      const { artifact } = buildAuditArtifact(facts);
      const out = evidenceArtifactPath(repoRoot, runId, ".b12.audit.json");
      writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n", "utf8");
      process.stdout.write(
        `${out}\nverdict: ${artifact.verdict}${artifact.reasons.length > 0 ? `\n${artifact.reasons.map((r) => `  - ${r}`).join("\n")}` : ""}\n(commit it; emit takes it as --audit)\n`
      );
    }
  } catch (error) {
    if (error instanceof AuditRefused) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
