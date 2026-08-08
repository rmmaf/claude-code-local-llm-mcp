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
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readRunArchive } from "./archive.js";
import { assembleRun } from "./assemble.js";
import type { GitAudit } from "./types.js";

/** Parse a committed audit artifact into the input `assemble` takes. */
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
    return {
      ran: true,
      verdict: o.verdict,
      reasons: o.reasons.filter((r): r is string => typeof r === "string"),
      inputs,
    };
  }
  // A malformed audit is NO audit — `{ran: false}` keeps clauses 4–6 in
  // `uncheckedClauses` rather than laundering a broken file into "clean".
  return { ran: false };
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
    try {
      gitAudit = parseGitAudit(JSON.parse(readFileSync(options.auditPath, "utf8")));
    } catch {
      gitAudit = { ran: false };
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
