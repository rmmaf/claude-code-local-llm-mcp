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
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { sha256 } from "./archive.js";
import { parseGitAudit } from "./emit.js";
import type { GitAudit } from "./types.js";

/** The commit the pre-registration froze at; its blob may never drift. */
export const PREREG_FROZEN_COMMIT = "c343976";
export const PREREG_PATH = "evidence/2026-08-05-b12-preregistration.json";

/**
 * Clause 5's pinned path set. The emission wrapper (`src/cost/emission.ts`)
 * is inside `src/cost/**` ON PURPOSE — "gate's or repair's telemetry emission"
 * is pinned by pinning the module that owns it, while the tool files stay
 * editable.
 */
export const PINNED_PATHS = ["src/cost/", "src/telemetry.ts", "scripts/b12-run.mjs"] as const;

/**
 * The six negative controls `voidConditions` 6 requires SHOWN FIRING, by the
 * exact vitest fullName the attestation records. Copied AFTER the tests
 * existed — a registry written first would have been a wish, not a pin.
 */
export const CONTROL_TESTS: readonly string[] = [
  // 1. a failed repair row crediting zero units — written the day this
  //    registry was (no prior test showed it; the near-miss at the
  //    turn-collapse control credits zero for a different reason).
  "telemetry and the counterfactual credits a failed repair row at zero units — clause 6's failed-repair control",
  // 2. a byte-negative row carried signed
  "telemetry and the counterfactual keeps a call that ADDED bytes as the negative it is",
  // 3. an unmatchable wouldHaveAdded returning null and not 0 — the null is
  //    observable through the `unsized` channel, never summed as zero.
  "telemetry and the counterfactual counts a refusal it cannot size instead of summing the unknown as zero",
  // 4. a two-worktree fixture where a resumed session returns inherited > 0
  "the B12 harness rejects a resumed session whose ids came from a sibling worktree — clause 6's two-worktree control",
  // 5. a per-session scoring invocation REFUSING where the full-set invocation credits
  "telemetry and the counterfactual refuses a call whose invocation id two sessions both carry, on both sides",
  // 6. a run whose snapshot covered fewer slugs than it wrote to being rejected
  "the B12 harness rejects a run whose snapshot covered fewer slugs than it wrote to — clause 6's slug-coverage control",
];

/** The two files the frozen clause NAMES as the conformance suite. */
export const CONFORMANCE_FILES = ["tests/cost-meter.test.ts", "tests/session-token-walk.test.ts"] as const;

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
  "clause5.anchor.taskId",
  "clause5.anchor.arm",
  "clause5.anchor.attempt",
  "clause5.anchor.started",
  "clause5.anchor.commit",
  "clause5.anchor.derivation",
  "clause5.commitsTouchingPinned",
  "clause5.offenders",
  "clause5.excusedByReemission",
  "clause6.attestationPath",
  "clause6.attestationSha256",
  "clause6.subjectCommit",
  "clause6.controls",
  "clause6.files",
  "tool.srcSha256",
];

// ---------------------------------------------------------------------------
// The facts — collected once, decided purely.
// ---------------------------------------------------------------------------

export interface AuditFacts {
  runId: string;
  head: string;
  /** The commit that INTRODUCED the manifest; null when it was never committed. */
  registrationCommit: string | null;
  prereg: {
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
    /** Every commit touching a pinned path: `{sha, committerDate}`. */
    commitsTouchingPinned: Array<{ sha: string; committerDate: string }>;
    /** The union of the two probes (ancestry + committer date), minus nothing. */
    offenders: string[];
    /** Offenders excused because EVERY run artifact was re-emitted after them. */
    excusedByReemission: string[];
  };
  clause6: {
    /** null when the attestation is absent from HEAD. */
    attestation: SuiteAttestation | null;
    attestationSha256: string | null;
    /** Is `subjectCommit` an ancestor of HEAD? null when it cannot be asked. */
    subjectIsAncestor: boolean | null;
    /** Paths in `subjectCommit..HEAD` that are NOT under `evidence/`. */
    nonEvidenceDrift: string[];
  };
  /** Content sha of this tool's own SOURCE at HEAD; null when absent. */
  toolSrcSha256: string | null;
}

/** `evidence/<runId>.b12.suite.json` — what `--attest-suite` writes. */
export interface SuiteAttestation {
  schema: "b12-suite/1";
  runId: string;
  /** HEAD when the suite ran — the multi-commit model's subject. */
  subjectCommit: string;
  generatedAt: string;
  files: Array<{ file: string; total: number; passed: number; failed: number; skipped: number }>;
  tests: Array<{ file: string; fullName: string; status: string }>;
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
    reasons.push(`clause 4: ${PREREG_PATH} is unreadable at the freeze commit ${PREREG_FROZEN_COMMIT} — the frozen text cannot be shown frozen`);
  }
  if (facts.prereg.headSha256 === null) {
    reasons.push(`clause 4: HEAD does not carry ${PREREG_PATH}`);
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
  // With no anchor and no anchor problem, the sources are FREE — the clause's
  // own text: "Before the first scored observation these are free".

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
      for (const title of CONTROL_TESTS) {
        const t = att.tests.find((x) => x?.fullName === title);
        if (t === undefined) reasons.push(`clause 6: required control absent from the attestation: ${title}`);
        else if (t.status !== "passed") reasons.push(`clause 6: required control not passing (${String(t.status)}): ${title}`);
      }
    }
    if (facts.clause6.subjectIsAncestor === null) {
      reasons.push("clause 6: the attestation's subjectCommit cannot be related to HEAD");
    } else if (facts.clause6.subjectIsAncestor === false) {
      reasons.push("clause 6: the attestation's subjectCommit is not an ancestor of HEAD — it attests some other history");
    }
    if (facts.clause6.nonEvidenceDrift.length > 0) {
      reasons.push(
        `clause 6: ${facts.clause6.nonEvidenceDrift.length} non-evidence path(s) changed after the attestation (${facts.clause6.nonEvidenceDrift.slice(0, 3).join(", ")}${facts.clause6.nonEvidenceDrift.length > 3 ? ", …" : ""}) — the multi-commit model allows evidence/** only`
      );
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
    "prereg.path": PREREG_PATH,
    "prereg.frozenCommit": PREREG_FROZEN_COMMIT,
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
    "clause5.pinnedPaths": joined(PINNED_PATHS),
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
    "clause6.attestationPath": `evidence/${facts.runId}.b12.suite.json`,
    "clause6.attestationSha256": orNone(facts.clause6.attestationSha256),
    "clause6.subjectCommit": orNone(att?.subjectCommit ?? null),
    // The `Array.isArray` guards are not defensive habit: these read
    // COMMITTED bytes, and a malformed attestation must still produce the
    // void artifact that reports it, never a crash instead of a verdict.
    "clause6.controls": joined(
      CONTROL_TESTS.map((title) => {
        const t = Array.isArray(att?.tests) ? att.tests.find((x) => x?.fullName === title) : undefined;
        return `${title}=${t === undefined ? "absent" : String(t.status)}`;
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

const blobSha = (git: Git, ref: string, rel: string): string | null => {
  const r = git(["show", `${ref}:${rel}`]);
  return r.ok ? sha256(r.out) : null;
};

/** The commit that INTRODUCED a path: the last line of `git log --diff-filter=A`. */
function introducingCommit(git: Git, rel: string): string | null {
  const r = git(["log", "--diff-filter=A", "--format=%H", "--", rel]);
  if (!r.ok) return null;
  const lines = r.out.trim().split("\n").filter(Boolean);
  return lines.length === 0 ? null : lines[lines.length - 1]!;
}

/** The most recent commit touching a path; null when none does. */
function lastCommit(git: Git, rel: string): string | null {
  const r = git(["log", "-1", "--format=%H", "--", rel]);
  if (!r.ok) return null;
  const line = r.out.trim();
  return line === "" ? null : line;
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
  const registrationCommit = introducingCommit(git, manifestRel);

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
    try {
      const cf = JSON.parse(cfShow.out) as {
        observations?: Array<{ taskId?: unknown; arm?: unknown; attempt?: unknown; aPlusSPositive?: unknown }>;
      };
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
      const joinedObs: Array<{ taskId: string; arm: string; attempt: number; rowIndex: number; sessionId: string; aPlusSPositive: unknown }> = [];
      for (const o of cf.observations ?? []) {
        if (typeof o.taskId !== "string" || typeof o.arm !== "string" || typeof o.attempt !== "number") continue;
        const dir = `evidence/${runId}/obs-${o.taskId}-${o.arm}${o.attempt === 1 ? "" : `-r${o.attempt}`}`;
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
          aPlusSPositive: o.aPlusSPositive,
        });
      }
      if (anchorProblems.length === 0) {
        joinedObs.sort((a, b) => a.rowIndex - b.rowIndex);
        const first = joinedObs.find((o) => o.aPlusSPositive !== null && o.aPlusSPositive !== undefined);
        if (first !== undefined) {
          const dir = `evidence/${runId}/obs-${first.taskId}-${first.arm}${first.attempt === 1 ? "" : `-r${first.attempt}`}`;
          const rec = JSON.parse(git(["show", `HEAD:${dir}/observation.json`]).out) as Record<string, unknown>;
          const commit = introducingCommit(git, dir);
          if (commit === null) {
            anchorProblems.push(`${dir} has no introducing commit — scored evidence that was never committed cannot anchor the freeze`);
          } else {
            anchor = {
              taskId: first.taskId,
              arm: first.arm,
              attempt: first.attempt,
              started: String(rec.started),
              commit,
            };
          }
        }
      }
    } catch {
      anchorProblems.push("the committed counterfactual does not parse — the anchor derivation has no observations to read");
    }
  }

  // ---- clause 5: the two probes, in union ---------------------------------
  const commitsTouchingPinned: Array<{ sha: string; committerDate: string }> = [];
  const offenders: string[] = [];
  const excusedByReemission: string[] = [];
  {
    // FAIL-CLOSED: a failed MANDATORY probe may never wear the same empty
    // list a clean answer wears — "no commits touch the pinned paths" and
    // "the history could not be inspected" fire different clauses.
    const log = git(["log", "--format=%H %cI", "--", ...pinnedPaths]);
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
      const artifacts = [
        `evidence/${runId}.b12.counterfactual.json`,
        `evidence/${runId}.b12.result.json`,
      ];
      for (const offender of offenders) {
        let excused = true;
        for (const rel of artifacts) {
          const last = lastCommit(git, rel);
          if (last === null || isAncestor(git, offender, last) !== true) {
            excused = false;
            break;
          }
        }
        if (excused) excusedByReemission.push(offender);
      }
    }
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

  return {
    runId,
    head: headSha,
    registrationCommit,
    prereg: {
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
    clause5: { anchor, anchorProblems, commitsTouchingPinned, offenders, excusedByReemission },
    clause6: { attestation, attestationSha256, subjectIsAncestor, nonEvidenceDrift },
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
  vitestJson: unknown
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
      const run = spawnSync(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["vitest", "run", ...CONFORMANCE_FILES, "--reporter=json"],
        { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: process.platform === "win32" }
      );
      // The COMMAND's verdict before the report's: only the two named files
      // run here, and the Windows baseline's four failures live in others —
      // so exit 0 is both required and reachable.
      const { refusal, jsonLine } = suiteRunRefusal(run);
      if (refusal !== null) throw new AuditRefused(refusal);
      const attestation = attestationFromVitest(
        runId,
        head.out.trim(),
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        JSON.parse(jsonLine)
      );
      const out = path.join(repoRoot, "evidence", `${runId}.b12.suite.json`);
      writeFileSync(out, JSON.stringify(attestation, null, 2) + "\n", "utf8");
      process.stdout.write(`${out}\n(commit it; the audit reads the COMMITTED bytes)\n`);
    } else {
      const facts = collectAuditFacts(repoRoot, runId);
      const { artifact } = buildAuditArtifact(facts);
      const out = path.join(repoRoot, "evidence", `${runId}.b12.audit.json`);
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
