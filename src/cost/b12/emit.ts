/**
 * UNIT 5, the thin third — reads through `archive.ts`, calls `assemble`, and
 * WRITES BOTH ARTIFACTS EVEN WHEN THE RESULT IS A VOID. `admissionRule` 1 owes
 * `result.json` from registration onward whatever the run did, so the write
 * below is unconditional; a run that voids at any step still leaves both files
 * for the analysis session to commit (committing is the SESSION's act —
 * `runPlan` PHASE 6 — never this file's).
 *
 * WHY THIS LIVES IN `src/cost/b12/` — `voidConditions` 5 freezes `src/cost/**`
 * after the first scored observation; an emitter at any other path could be
 * edited afterwards without tripping the source-drift VOID (the capture's
 * argument, held again by the plan gate's R1).
 *
 * **THE PHASE-4 SCORING COMMAND MUST REGISTER BOTH FORMS OF THIS FILE** — the
 * compiled entrypoint (`dist/cost/b12/emit.js`) it invokes AND this source
 * counterpart — because `dist/**` is the registered F24 hole: a hand-edited
 * compiled file at an unpinned path defeats the frozen-set placement. The
 * command string the manifest pins is compared against the actual invocation
 * (`voidConditions` 19) in `assemble`, which receives it from here verbatim.
 *
 * The clause 4–6 audit is an INPUT (`--audit <path>`): a committed artifact
 * carrying verdict and inputs. Absent, `assemble` publishes clauses 4–6 as
 * UNCHECKED and the pre-declaration (`PREMISES.md § B12`) bars a final verdict
 * — absence is reported, never read as "clean".
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readRunArchive, runEvidenceDigest, sameCommittedText, sha256 } from "./archive.js";
import { assembleRun } from "./assemble.js";
import type { GitAudit } from "./types.js";

/**
 * Parse a committed audit artifact into the input `assemble` takes.
 *
 * `inputs` is REQUIRED and non-empty: the pre-declaration says "verdict AND
 * inputs, published on `result.json`'s face for artifact 11's replay", and a
 * verdict whose inputs cannot be replayed is exactly the shape the clause 4–6
 * seam exists to refuse. A malformed audit is NO audit — `{ran: false}` keeps
 * the clauses in `uncheckedClauses` rather than laundering a broken file into
 * "clean".
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
    if (Object.keys(inputs).length === 0) return { ran: false };
    return {
      ran: true,
      verdict: o.verdict,
      reasons: o.reasons.filter((r): r is string => typeof r === "string"),
      inputs,
    };
  }
  return { ran: false };
}

/**
 * The audit must be COMMITTED EVIDENCE at the run's own path — the probe trust
 * boundary's fix, applied to the audit the moment it existed as an input (the
 * diff review's first finding: an arbitrary working-tree JSON could otherwise
 * certify clauses 4–6 as clean). Repo-relative at
 * `evidence/<runId>.b12.audit.json` (fixed by the pre-declaration,
 * `PREMISES.md § B12`), present in HEAD, and byte-identical to HEAD's blob.
 */
export function committedAuditCheck(
  repoRoot: string,
  runId: string,
  auditPath: string
): { ok: boolean; bytes: string | null; why: string | null } {
  const expectedRel = `evidence/${runId}.b12.audit.json`;
  const givenRel = path.relative(repoRoot, path.resolve(repoRoot, auditPath)).split(path.sep).join("/");
  if (givenRel !== expectedRel) {
    return { ok: false, bytes: null, why: `the audit must live at ${expectedRel} (got ${givenRel})` };
  }
  let onDisk: string;
  try {
    onDisk = readFileSync(path.resolve(repoRoot, auditPath), "utf8");
  } catch {
    return { ok: false, bytes: null, why: `${expectedRel} is unreadable` };
  }
  const show = spawnSync("git", ["show", `HEAD:${expectedRel}`], { cwd: repoRoot, encoding: "utf8" });
  if (show.status !== 0) {
    return { ok: false, bytes: null, why: `HEAD does not carry ${expectedRel} — the audit is not committed evidence` };
  }
  // The comparison `git status` applies — autocrlf may materialise the LF blob
  // as CRLF on disk, and byte-identity would refuse every Windows checkout.
  if (sameCommittedText(show.stdout ?? "", onDisk) === false) {
    return { ok: false, bytes: null, why: `${expectedRel} differs from HEAD's blob — uncommitted edits are not evidence` };
  }
  return { ok: true, bytes: onDisk, why: null };
}

/**
 * THE AUDIT IS A JUDGEMENT ABOUT A COMMIT, AND EMISSION MUST BE ON THAT
 * COMMIT'S SIDE OF HISTORY.
 *
 * `committedAuditCheck` proves the artifact is committed evidence at the run's
 * path; it says nothing about WHAT the artifact judged. A clean audit could
 * therefore be committed and then kept — or cherry-picked — while the pinned
 * sources, the manifests or the suite attestation moved underneath it, and
 * clauses 4–6 would still publish as clean over facts nobody audited.
 *
 * The binding is the one the audit computer already uses for clause 6's
 * `subjectCommit`, turned on the audit itself:
 *
 *   (a) the audit's `runId` is THIS run — one identity, and the path pins
 *       only the file name;
 *   (b) `inputs.head` is a real commit and an ANCESTOR of HEAD — an audit
 *       computed on a history this emission is not on judges nothing here;
 *   (c) `inputs.head..HEAD` touches ONLY `evidence/**` — every input the
 *       audit reads from outside evidence (the clause-5 pinned paths, the
 *       tool's own source) is frozen by that one predicate, and the lawful
 *       gap is exactly the audit's own commit;
 *   (d) the inputs the audit read from INSIDE `evidence/**` — prereg,
 *       manifest A, manifest B, the suite attestation — are RE-HASHED at
 *       HEAD and must equal what the artifact recorded, because (c) cannot
 *       see a change there;
 *   (e) and so is the whole set clause 5 was COMPUTED FROM — the runlog, the
 *       counterfactual, every per-observation archive — through the digest
 *       the artifact records. R22 stopped at (d) and claimed completeness;
 *       R24 showed the claim was false, because an observation appended
 *       after a clean audit changes the anchor's population and the archive
 *       being scored while the verdict rides along unchanged.
 *
 * A refusal keeps clauses 4–6 UNCHECKED — never "clean", the same fail-closed
 * shape as an unparseable audit. Returns the reason, or null.
 */
export function auditBindingRefusal(repoRoot: string, runId: string, audit: GitAudit): string | null {
  if (audit.ran !== true) return null;
  const inputs = audit.inputs;
  const git = (args: string[]): { ok: boolean; out: string } => {
    const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28 });
    return { ok: r.status === 0, out: r.stdout ?? "" };
  };
  if (inputs["runId"] !== runId) {
    return `the audit judges run ${JSON.stringify(inputs["runId"] ?? null)}, not ${runId} — the path names the run, and so must the artifact`;
  }
  const audited = inputs["head"] ?? "";
  if (!/^[0-9a-f]{40}$/.test(audited)) return "the audit records no head commit — it cannot be bound to anything";
  if (!git(["cat-file", "-e", `${audited}^{commit}`]).ok) {
    return `the audit's head ${audited.slice(0, 12)} is not a commit in this repository`;
  }
  if (!git(["merge-base", "--is-ancestor", audited, "HEAD"]).ok) {
    return `the audit's head ${audited.slice(0, 12)} is not an ancestor of HEAD — it judged a history this emission is not on`;
  }
  const diff = git(["diff", "--name-only", audited, "HEAD"]);
  if (!diff.ok) return `git could not diff ${audited.slice(0, 12)}..HEAD — the audit cannot be bound to HEAD`;
  const moved = diff.out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .filter((p) => !p.startsWith("evidence/"));
  if (moved.length > 0) {
    return `${moved.length} path(s) outside evidence/ changed after the audit judged them (${moved.slice(0, 5).join(", ")}${moved.length > 5 ? ", …" : ""}) — clauses 4–6 would be clean about a tree that no longer exists`;
  }
  for (const [pathKey, shaKey] of [
    ["prereg.path", "prereg.headSha256"],
    ["manifestA.path", "manifestA.headSha256"],
    ["manifestB.path", "manifestB.headSha256"],
    ["clause6.attestationPath", "clause6.attestationSha256"],
  ] as const) {
    const rel = inputs[pathKey];
    const want = inputs[shaKey];
    if (rel === undefined || want === undefined) return `the audit records no ${pathKey}/${shaKey} — it cannot be re-checked`;
    // `(none)` is the artifact's literal for a lawful absence: the audit
    // decided about that absence, and clause 4 is where it is judged.
    if (rel === "(none)" || want === "(none)") continue;
    const show = git(["show", `HEAD:${rel}`]);
    if (!show.ok) return `HEAD no longer carries ${rel}, which the audit judged`;
    if (sha256(show.out) !== want) {
      return `${rel} changed after the audit judged it (${want.slice(0, 12)} → ${sha256(show.out).slice(0, 12)})`;
    }
  }
  // AND THE EVIDENCE CLAUSE 5 WAS COMPUTED FROM (R24). Naming four evidence
  // files was not the same as covering `evidence/**`: the anchor, the
  // offender set and the archive being scored all derive from the runlog, the
  // counterfactual and the per-observation archives. An observation appended
  // after a clean audit changes what is scored while the verdict rides along.
  const recordedDigest = inputs["clause5.evidenceDigest"];
  if (recordedDigest === undefined) return "the audit records no clause-5 evidence digest — it cannot say what archive it judged";
  const current = runEvidenceDigest(runId, git);
  if (current.digest === null) return "the clause-5 evidence could not be enumerated at HEAD — the audit cannot be bound to it";
  if (current.digest !== recordedDigest) {
    const before = new Set((inputs["clause5.evidencePaths"] ?? "").split("\n").filter((l) => l !== ""));
    const now = new Set(current.paths);
    const added = current.paths.filter((p) => !before.has(p));
    const removed = [...before].filter((p) => !now.has(p));
    const how =
      added.length > 0 || removed.length > 0
        ? `${added.length} added (${added.slice(0, 3).join(", ") || "—"}), ${removed.length} removed (${removed.slice(0, 3).join(", ") || "—"})`
        : "same files, different bytes";
    return `the clause-5 evidence changed after the audit judged it — ${how}; the archive being scored is not the archive that was audited`;
  }
  return null;
}

export interface EmitResult {
  counterfactualPath: string;
  resultPath: string;
  verdict: string;
  voidClause: string | null;
}

export async function emitRun(
  repoRoot: string,
  runId: string,
  options: { auditPath?: string | null; scoringCommandActual?: string | null } = {}
): Promise<EmitResult> {
  const archive = await readRunArchive(repoRoot, runId);

  let gitAudit: GitAudit = { ran: false };
  if (options.auditPath != null) {
    const committed = committedAuditCheck(repoRoot, runId, options.auditPath);
    if (!committed.ok) {
      archive.problems.push(`audit refused: ${committed.why ?? "unknown"} — clauses 4–6 stay UNCHECKED`);
    } else {
      try {
        gitAudit = parseGitAudit(JSON.parse(committed.bytes ?? ""));
      } catch {
        archive.problems.push("audit refused: the committed audit does not parse — clauses 4–6 stay UNCHECKED");
      }
      // COMMITTED IS NOT THE SAME AS CURRENT: the artifact must still be a
      // judgement about the tree being emitted.
      const unbound = auditBindingRefusal(repoRoot, runId, gitAudit);
      if (unbound !== null) {
        archive.problems.push(`audit refused: ${unbound} — clauses 4–6 stay UNCHECKED`);
        gitAudit = { ran: false };
      }
    }
  }

  const { counterfactual, result } = assembleRun({
    archive,
    gitAudit,
    scoringCommandActual: options.scoringCommandActual ?? null,
  });

  const counterfactualPath = path.join(repoRoot, "evidence", `${runId}.b12.counterfactual.json`);
  const resultPath = path.join(repoRoot, "evidence", `${runId}.b12.result.json`);
  writeFileSync(counterfactualPath, JSON.stringify(counterfactual, null, 2) + "\n", "utf8");
  writeFileSync(resultPath, JSON.stringify(result, serializeResult, 2) + "\n", "utf8");

  return { counterfactualPath, resultPath, verdict: result.verdict, voidClause: result.voidClause };
}

/** `RunTelemetryCoverage.ownedBy` is a Map; JSON needs it as an object. */
function serializeResult(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

/**
 * The invocation string `voidConditions` 19 compares — reconstructed the same
 * way every time so the pinned string has one spelling to match: the literal
 * `node`, the script path repo-relative with `/` separators, then the argv.
 */
export function invocationString(repoRoot: string, scriptPath: string, argv: readonly string[]): string {
  const rel = path.relative(repoRoot, scriptPath).split(path.sep).join("/");
  return ["node", rel, ...argv].join(" ");
}

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
    process.stderr.write("usage: node dist/cost/b12/emit.js <runId> [--audit <path>]\n");
    process.exit(2);
  }
  let auditPath: string | null = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--audit" && args[i + 1] !== undefined) auditPath = args[++i]!;
  }
  const repoRoot = process.cwd();
  emitRun(repoRoot, runId, {
    auditPath,
    scoringCommandActual: invocationString(repoRoot, process.argv[1]!, args),
  })
    .then((r) => {
      process.stdout.write(`${r.resultPath}\n${r.counterfactualPath}\nverdict: ${r.verdict}${r.voidClause === null ? "" : ` — ${r.voidClause}`}\n`);
    })
    .catch((error: unknown) => {
      // The one lawful throw is the unreadable manifest — a bug or tampering,
      // not a run outcome; it surfaces loudly instead of minting an artifact.
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
