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

import { readRunArchive, sameCommittedText } from "./archive.js";
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
