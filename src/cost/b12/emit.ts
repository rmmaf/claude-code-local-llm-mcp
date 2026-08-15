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
 * The clause 4–6 audit is a REQUIRED INPUT (`--audit <path>`): a committed
 * artifact carrying verdict and inputs. Absent — or uncommitted, unparseable,
 * or not bound to this tree — this file REFUSES and writes nothing (R50).
 *
 * It used to emit anyway and let `assemble` publish clauses 4–6 as UNCHECKED,
 * on the reading that absence is reported rather than read as "clean". The
 * reporting was real and nothing that DECIDED ever read it: a NOT-FINAL result
 * committed by that path was accepted by the registration gate and by `open-b`.
 * `PREMISES.md § B12` pre-declared that "the scoring invocation requires a
 * COMMITTED clause 4–6 audit artifact"; this is that rule enforced instead of
 * merely stated. `assemble` still publishes UNCHECKED for `{ran:false}` — it is
 * the lower layer and other callers exist — but no artifact leaves this file
 * under that condition, so every committed `result.json` is FINAL.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readRunArchive, runEvidenceDigest, sameCommittedText, sha256 } from "./archive.js";
import { assembleRun } from "./assemble.js";
import {
  AUDIT_INPUT_KEYS,
  auditInputs,
  collectAuditFacts,
  decideAudit,
  parseGitAudit,
  runEmittedArtifacts,
  type CollectorOptions,
} from "./audit.js";
import type { GitAudit } from "./types.js";

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
 *   (e) and so is the whole set clause 5 was COMPUTED FROM — the runlog and
 *       every per-observation archive — through the digest the artifact
 *       records. NOT the counterfactual: it left that set when the anchor
 *       stopped reading it (R50), because it is an OUTPUT of this emission and
 *       an output in the input digest would make the audit unbindable the
 *       moment its own run was committed. R22 stopped at (d) and claimed completeness;
 *       R24 showed the claim was false, because an observation appended
 *       after a clean audit changes the anchor's population and the archive
 *       being scored while the verdict rides along unchanged.
 *
 * A refusal keeps clauses 4–6 UNCHECKED — never "clean", the same fail-closed
 * shape as an unparseable audit. Returns the reason, or null.
 */
export async function auditBindingRefusal(
  repoRoot: string,
  runId: string,
  audit: GitAudit,
  /** Test seam ONLY — the CLI re-derives with the frozen constants, exactly
   * as the audit command did. An oracle whose scratch repository carries a
   * stand-in prereg has to hand the same stand-in to both sides or it would
   * be comparing two different questions. */
  collectorOptions: CollectorOptions = {}
): Promise<string | null> {
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
  // AND THE ARTIFACT IS NOT SELF-AUTHENTICATING (R26).
  //
  // Everything above re-checks what the artifact SAYS about a handful of
  // paths. Nothing above asks whether the verdict beside them is the verdict
  // those facts produce — so a hand-written `evidence/<runId>.b12.audit.json`
  // carrying `verdict: "clean"` and the few hashes named here was accepted,
  // and clauses 4–6 published as CHECKED without any audit ever having run.
  //
  // So the emission RE-DERIVES the whole judgement from the repository and
  // requires the artifact to agree with it: same verdict, and every canonical
  // input equal — except `head`, which MUST differ, because committing the
  // audit is what moved HEAD (the reason R22 refused a naive exact match).
  // Under the confinement proved just above, nothing else may legitimately
  // move between the audited commit and this one, so any other difference is
  // an artifact that is not a judgement of this tree.
  //
  // The committed artifact is still the evidence, and still required: this is
  // a cross-check on what it claims, never a substitute for it.
  let recomputed: Record<string, string>;
  let recomputedVerdict: "clean" | "void";
  try {
    const facts = await collectAuditFacts(repoRoot, runId, collectorOptions);
    recomputed = auditInputs(facts);
    recomputedVerdict = decideAudit(facts).verdict;
  } catch (error) {
    return `the audit could not be re-derived at HEAD (${error instanceof Error ? error.message : String(error)}) — an artifact this emission cannot recompute certifies nothing`;
  }
  if (recomputedVerdict !== audit.verdict) {
    return `the artifact says ${audit.verdict} and re-deriving it here says ${recomputedVerdict} — the verdict was not produced by these facts`;
  }
  for (const key of AUDIT_INPUT_KEYS) {
    // The ONE key that must differ, and the audit's binding to HEAD is what
    // already proved the difference is only the audit's own commit.
    if (key === "head") continue;
    if (inputs[key] !== recomputed[key]) {
      return `the audit's ${key} does not survive re-derivation (${JSON.stringify(inputs[key] ?? null).slice(0, 60)} vs ${JSON.stringify(recomputed[key] ?? null).slice(0, 60)})`;
    }
  }
  return null;
}

/**
 * The emission REFUSED — retryable, and it wrote nothing (R50).
 *
 * Distinct from a VOID on purpose, and the distinction is the point of the
 * class: a void is a committable verdict that spends one of three attempts,
 * while a refusal is a door that stayed shut. The operator fixes the
 * precondition and runs the same command again.
 */
export class EmitRefused extends Error {}

export interface EmitResult {
  counterfactualPath: string;
  resultPath: string;
  verdict: string;
  voidClause: string | null;
  /** `PREMISES.md`: a verdict emitted without a committed clause 4–6 audit is
   * NOT FINAL. Carried out of the emission so a caller cannot read `verdict`
   * without the qualification the pre-data rule attaches to it. */
  final: boolean;
}

export async function emitRun(
  repoRoot: string,
  runId: string,
  options: {
    auditPath?: string | null;
    scoringCommandActual?: string | null;
    /** Test seam ONLY — handed to the re-derivation so an oracle's scratch
     * repository asks the audit computer the same question its own audit
     * asked. The CLI never passes it. */
    auditCollectorOptions?: CollectorOptions;
  } = {}
): Promise<EmitResult> {
  const archive = await readRunArchive(repoRoot, runId);

  // THE SCORING INVOCATION REFUSES; IT DOES NOT PUBLISH A QUALIFIED VERDICT
  // (R50).
  //
  // This used to record the refusal on the artifact's face and emit anyway,
  // with `gitAudit.ran` false and `final` false. The rule was "the CLI permits
  // it and the qualification qualifies it" — and the qualification was read by
  // nothing that decided. Two hazards came out of that:
  //
  //   - the pinned command carries `--audit`, so under the OLD two-emit loop
  //     the first, bare invocation fired clause 19 and COMMITTED a
  //     `verdict:"void"` for a run that was not void;
  //   - and a correctly ordered invocation whose audit binding refused for any
  //     of the legitimate drift reasons above still wrote an ordinary `open`
  //     that was NOT FINAL, which `open-b` accepted — spending the second of
  //     two sealed manifests on a verdict no committed audit stood behind.
  //
  // Under the one-invocation regime the audit no longer needs a prior
  // emission, so there is no longer any lawful reason to score without one.
  // Refusing writes NOTHING and is retryable; it spends no attempt. The
  // invariant it buys is worth more than the diagnostic it removes: EVERY
  // committed `result.json` is FINAL by construction.
  const auditPath = options.auditPath;
  if (auditPath == null) {
    throw new EmitRefused(
      "no --audit was given: the scoring invocation is the one that carries a COMMITTED clause 4–6 audit, and an emission without one would publish a verdict nothing had audited"
    );
  }
  const committed = committedAuditCheck(repoRoot, runId, auditPath);
  if (!committed.ok) {
    throw new EmitRefused(`audit refused: ${committed.why ?? "unknown"} — nothing was written`);
  }
  let gitAudit: GitAudit;
  try {
    gitAudit = parseGitAudit(JSON.parse(committed.bytes ?? ""));
  } catch {
    throw new EmitRefused("audit refused: the committed audit does not parse — nothing was written");
  }
  if (gitAudit.ran !== true) {
    throw new EmitRefused(
      "audit refused: the committed audit does not survive parseGitAudit — a verdict whose inputs cannot be replayed is not an audit, and nothing was written"
    );
  }
  // COMMITTED IS NOT THE SAME AS CURRENT: the artifact must still be a
  // judgement about the tree being emitted.
  const unbound = await auditBindingRefusal(repoRoot, runId, gitAudit, options.auditCollectorOptions ?? {});
  if (unbound !== null) {
    throw new EmitRefused(`audit refused: ${unbound} — nothing was written`);
  }

  const { counterfactual, result } = assembleRun({
    archive,
    gitAudit,
    scoringCommandActual: options.scoringCommandActual ?? null,
  });

  // ONE LIST, not two spellings (R37#4). Clause 5's re-emission escape asks
  // about the artifacts re-emission PRODUCES; deriving the write paths from
  // the same function is what stops a third emitted artifact from existing
  // without the escape ever hearing about it.
  const [counterfactualRel, resultRel] = runEmittedArtifacts(runId);
  if (counterfactualRel === undefined || resultRel === undefined) {
    throw new Error("runEmittedArtifacts must name the counterfactual and the result, in that order");
  }
  const counterfactualPath = path.join(repoRoot, counterfactualRel);
  const resultPath = path.join(repoRoot, resultRel);
  writeFileSync(counterfactualPath, JSON.stringify(counterfactual, null, 2) + "\n", "utf8");
  writeFileSync(resultPath, JSON.stringify(result, serializeResult, 2) + "\n", "utf8");

  return {
    counterfactualPath,
    resultPath,
    verdict: result.verdict,
    voidClause: result.voidClause,
    final: result.final,
  };
}

/**
 * `RunTelemetryCoverage.ownedBy` is a Map; JSON needs it as an object.
 *
 * EXPORTED so the artifact's real bytes can be asserted without going through
 * the emission gate (R50). The gate now requires a committed, bound audit —
 * correctly — but the serializer is a separate contract, and a test that had
 * to stand up a whole operator loop to check that a Map survives the round
 * trip would be testing the gate instead of the thing it means to test.
 */
export function serializeResult(_key: string, value: unknown): unknown {
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
    // `--audit` IS NOT OPTIONAL any more (R50). The usage line said it was,
    // and an operator following the usage line would have taken the exact path
    // that committed a provisional void.
    process.stderr.write("usage: node dist/cost/b12/emit.js <runId> --audit evidence/<runId>.b12.audit.json\n");
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
      // NOT FINAL IS SAID BEFORE THE VERDICT, not after it (R37#1). Under the
      // one-invocation regime this branch is unreachable — the emission
      // refuses rather than publishing an unaudited verdict — but the line
      // stays, because a mark that only prints when the invariant has already
      // broken is worth more than one that was deleted for being unreachable.
      const mark = r.final ? "FINAL" : "NOT FINAL — clauses 4–6 UNCHECKED (this should be unreachable; report it)";
      process.stdout.write(
        `${r.resultPath}\n${r.counterfactualPath}\n${mark}\nverdict: ${r.verdict}${r.voidClause === null ? "" : ` — ${r.voidClause}`}\n`
      );
    })
    .catch((error: unknown) => {
      // A REFUSAL EXITS 2 AND A BUG EXITS 1, the same two-way split the audit
      // command uses: exit 2 says "precondition unmet, fix it and run the same
      // command again", exit 1 says "this tree is not what the tool assumes".
      // The one lawful throw of the second kind is the unreadable manifest.
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(error instanceof EmitRefused ? 2 : 1);
    });
}
