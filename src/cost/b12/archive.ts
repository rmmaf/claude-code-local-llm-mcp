/**
 * UNIT 5, the impure third — paths in, a validated `RunArchive` value out.
 * Specified by `docs/b12-scorer/UNIT-5.md`; the boundary is the spec's own:
 * "every rule worth testing is a function of values", so THIS file is the whole
 * filesystem-and-git surface of scoring and `assemble.ts` never touches either.
 *
 * WHY IT LIVES IN `src/cost/b12/` — the capture's argument, verbatim.
 * `voidConditions` 5 freezes "`src/cost/**` … or `scripts/b12-run.mjs`" after
 * the first scored observation; a reader at any path the clause does not name
 * could be edited afterwards without tripping the source-drift VOID.
 *
 * NOTHING HERE REFUSES A RUN. Hostile-disk findings — a missing file, a
 * malformed line, a hash drift between two copies of one fact — are collected
 * into `problems` and judged by `assemble`, because `admissionRule` 1 makes the
 * result artifact owed from registration onward and a throw produces none. The
 * single exception is a manifest that cannot be parsed at all: with no task
 * list and no pins there is no run to describe, and that is the "parse error
 * with no possible result" the spec calls a bug rather than a run outcome.
 *
 * IDENTITY IS STAMPED HERE, ONCE. There is no run-level telemetry log — every
 * observation's worktree is destroyed after capture — so each observation's
 * archived `telemetry.jsonl` is identified with its own repo-relative path as
 * `source` (`identify`, UNIT 4), ordinals restarting per file, keys globally
 * unique because paths differ. Nothing downstream re-identifies a slice.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { TelemetryRecord } from "../../telemetry.js";
import { loadRates, RATES_REL_PATH } from "../rates.js";
import { transcriptFromRecords } from "../transcript.js";
import type { RawRecord, Transcript } from "../transcript.js";
import { identify } from "./coverage.js";
import type {
  ArchivedObservation,
  ManifestTask,
  ObservationRecord,
  PriorRun,
  RunArchive,
  RunGitFacts,
  RunManifest,
  RunRegister,
  RunlogRow,
  SnapshotFacts,
} from "./types.js";

const sha256 = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) ? v : null;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Parse one `obs-…` directory name. The grammar is the harness's: `obs-<taskId>-
 * <arm>` for a first attempt, `obs-<taskId>-<arm>-r<N>` for `admissionRule` 12's
 * re-run. Parsed from the END because `taskId` may itself contain `-` — the arm
 * names cannot, they are a two-value closed set.
 *
 * Exported pure so the hostile-name cases are testable without a directory.
 */
export function parseObsDirName(
  name: string
): { taskId: string; arm: "treatment" | "control"; attempt: number } | null {
  const match = /^obs-(.+)-(treatment|control)(?:-r([2-9]|[1-9]\d+))?$/.exec(name);
  if (match === null) return null;
  const taskId = match[1]!;
  const arm = match[2] as "treatment" | "control";
  const attempt = match[3] === undefined ? 1 : Number(match[3]);
  return { taskId, arm, attempt };
}

/** Parse a jsonl text into rows plus a corrupt-line count. Never throws. */
export function parseJsonl(text: string): { rows: unknown[]; corruptLines: number } {
  const rows: unknown[] = [];
  let corruptLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      corruptLines++;
    }
  }
  return { rows, corruptLines };
}

/**
 * Narrow a parsed `observation.json` to the scorer-read subset. Field by field,
 * nullable as-read: the harness would have refused to WRITE most of these
 * absent, but the scorer reads a committed archive that may be hostile, and a
 * wrong shape here must surface as a reported fact rather than a crash.
 */
export function narrowObservationRecord(raw: unknown): ObservationRecord | null {
  if (!isObject(raw)) return null;
  const binary = isObject(raw.binary) ? raw.binary : {};
  const memory = isObject(raw.memorySnapshot) ? raw.memorySnapshot : {};
  const mcp = isObject(raw.mcpConfig) ? raw.mcpConfig : {};
  const policy = isObject(raw.policyBlob) ? raw.policyBlob : {};
  const hashes = isObject(raw.instructionHashes) ? raw.instructionHashes : null;
  const narrowHashes = (side: unknown): Record<string, string | null> => {
    const out: Record<string, string | null> = {};
    if (!isObject(side)) return out;
    for (const [k, v] of Object.entries(side)) out[k] = typeof v === "string" ? v : null;
    return out;
  };

  let installedChars: ObservationRecord["installedChars"] = null;
  if (isObject(raw.installedChars)) {
    const v = raw.installedChars.value;
    if (typeof v === "number") {
      installedChars = {
        value: v,
        ...(typeof raw.installedChars.adapter === "string"
          ? { adapter: raw.installedChars.adapter }
          : {}),
        ...(typeof raw.installedChars.probeRunId === "string"
          ? { probeRunId: raw.installedChars.probeRunId }
          : {}),
      };
    } else if (v === null && typeof raw.installedChars.reason === "string") {
      installedChars = { value: null, reason: raw.installedChars.reason };
    }
  }

  return {
    taskId: str(raw.taskId) ?? "",
    arm: str(raw.arm) ?? "",
    sessionId: str(raw.sessionId) ?? "",
    runId: str(raw.runId),
    outcome: str(raw.outcome),
    valid: bool(raw.valid),
    invalidReasons: strings(raw.invalidReasons),
    censored: bool(raw.censored),
    originatedRequestIds: strings(raw.originatedRequestIds),
    accepted: bool(raw.accepted),
    acceptanceExpectedExit: int(raw.acceptanceExpectedExit),
    baseCommit: str(raw.baseCommit),
    endCommit: str(raw.endCommit),
    treeHashAtStart: str(raw.treeHashAtStart),
    binaryVersion: str(binary.version),
    binarySha256: str(binary.sha256),
    mcpConfigPassedSha256: str(mcp.sha256),
    mcpConfigPinned: str(raw.mcpConfigPinned),
    policyBlobSha256: str(policy.sha256),
    installedChars,
    memorySnapshotSha256: str(memory.sha256),
    instructionHashes:
      hashes === null ? null : { pre: narrowHashes(hashes.pre), post: narrowHashes(hashes.post) },
  };
}

/** Narrow a snapshot file. `requestIds` is the FULL list — origination replays over it. */
export function narrowSnapshot(raw: unknown): SnapshotFacts | null {
  if (!isObject(raw)) return null;
  return {
    ts: str(raw.ts),
    slugsWalked: int(raw.slugsWalked),
    files: int(raw.files),
    requestIds: strings(raw.requestIds),
  };
}

/** Narrow one manifest task. Nullable as-read — `FINDINGS.md` F25 owns the gaps. */
function narrowTask(raw: unknown): ManifestTask | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  const acceptance = Array.isArray(raw.acceptance)
    ? strings(raw.acceptance)
    : typeof raw.acceptance === "string"
      ? [raw.acceptance]
      : null;
  const commands = Array.isArray(raw.verificationCommands) ? strings(raw.verificationCommands) : null;
  return {
    id: raw.id,
    promptSha256: str(raw.promptSha256),
    baseCommit: str(raw.baseCommit),
    verificationStratum: str(raw.verificationStratum),
    expectedSubagentStratum: str(raw.expectedSubagentStratum),
    acceptance,
    acceptanceExpectedExit: int(raw.acceptanceExpectedExit),
    verificationCommands: commands,
    gateCategory: str(raw.gateCategory),
    repairMaxRounds: int(raw.repairMaxRounds),
    fileScope: Array.isArray(raw.fileScope) ? strings(raw.fileScope) : null,
  };
}

/**
 * Rebuild the lineage `Transcript` from the archived reduction — the parser's
 * own pure half (`transcriptFromRecords`), fed from `archive.json` instead of
 * from files. ONE rule, two feeders; a second implementation here is how the
 * meter and the oracle drifted apart four times.
 *
 * The metadata a `Transcript` carries beyond its records — file list, skipped
 * lines, session anchor — comes from the archive's own fields (`sourcePath`,
 * `droppedLines`, `sessionId`), never fabricated (`FINDINGS.md`, the UNIT-5
 * plan gate's R2).
 */
export function rebuildLineageTranscript(
  archiveJson: unknown
): { transcript: Transcript | null; records: unknown[]; files: string[]; problem: string | null } {
  if (!isObject(archiveJson) || !Array.isArray(archiveJson.lineage)) {
    return { transcript: null, records: [], files: [], problem: "archive.json carries no lineage array" };
  }
  const records: unknown[] = [];
  const files: string[] = [];
  let skippedLines = 0;
  for (const entry of archiveJson.lineage) {
    if (!isObject(entry)) return { transcript: null, records, files, problem: "a lineage entry is not an object" };
    files.push(str(entry.sourcePath) ?? "(unknown source)");
    skippedLines += int(entry.droppedLines) ?? 0;
    if (Array.isArray(entry.records)) records.push(...entry.records);
  }
  const sessionId = str(archiveJson.sessionId);
  if (files.length === 0) {
    // An empty lineage is a FACT, not a crash: `assemble` compares it against
    // the originated ids, which is the harness's own refusal replayed.
    return { transcript: null, records, files, problem: "the archived lineage is empty" };
  }
  const transcript = transcriptFromRecords(records as RawRecord[], {
    files,
    skippedLines,
    ...(sessionId !== null ? { sessionId } : {}),
  });
  return { transcript, records, files, problem: null };
}

/**
 * Cross-check the two copies of the telemetry window. `telemetry.jsonl` is the
 * IDENTITY SOURCE (ordinals are positions in it); `archive.json.telemetry` is
 * the same array inside the sealed value. They were written by one command from
 * one array, so any drift is tampering or corruption — reported, and `assemble`
 * treats the observation's telemetry as unusable rather than picking a copy.
 */
export function telemetryDrift(jsonlRows: readonly unknown[], archiveRows: unknown): string | null {
  if (!Array.isArray(archiveRows)) return "archive.json carries no telemetry array";
  if (archiveRows.length !== jsonlRows.length) {
    return `telemetry.jsonl holds ${jsonlRows.length} row(s) while archive.json holds ${archiveRows.length}`;
  }
  for (let i = 0; i < jsonlRows.length; i++) {
    if (JSON.stringify(jsonlRows[i]) !== JSON.stringify(archiveRows[i])) {
      return `telemetry row ${i} differs between telemetry.jsonl and archive.json`;
    }
  }
  return null;
}

/** Narrow one runlog row; null for anything that is not one. */
export function narrowRunlogRow(raw: unknown): RunlogRow | null {
  if (!isObject(raw)) return null;
  const ts = str(raw.ts);
  const runId = str(raw.runId);
  const taskId = str(raw.taskId);
  const arm = str(raw.arm);
  const sessionId = str(raw.sessionId);
  const outcome = str(raw.outcome);
  if (ts === null || runId === null || taskId === null || arm === null) return null;
  return {
    ts,
    runId,
    taskId,
    arm,
    sessionId: sessionId ?? "",
    outcome: outcome ?? "",
    valid: bool(raw.valid) ?? false,
    accepted: bool(raw.accepted),
    originated: int(raw.originated) ?? 0,
  };
}

function git(repoRoot: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

/** The commit `voidConditions` 4 freezes `rates.json` at. */
const RATES_FROZEN_COMMIT = "3541625";

/**
 * Facts only git can answer, collected once and handed to `assemble` as values —
 * the same boundary the spec draws for the clause 4–6 audit. Failures are
 * problems, not throws: scoring on a machine without the history still owes an
 * artifact, one that SAYS these facts were unavailable.
 */
export function collectGitFacts(repoRoot: string, runId: string, earliestStartTs: string | null): RunGitFacts {
  const problems: string[] = [];
  const manifestRel = `evidence/${runId}.b12.tasks.json`;

  const blob = git(repoRoot, ["rev-parse", `HEAD:${manifestRel}`]);
  if (!blob.ok) problems.push(`HEAD does not carry ${manifestRel} — the manifest is not committed evidence`);

  // Artifact 1: "any commit touching it dated after the earliest session start
  // is a VOID". Commit DATES compared against the run's own earliest start.
  let manifestCommitsAfterStart: string[] = [];
  if (earliestStartTs !== null) {
    const log = git(repoRoot, ["log", "--format=%H %cI", "--", manifestRel]);
    if (log.ok && log.out !== "") {
      const startMs = Date.parse(earliestStartTs);
      manifestCommitsAfterStart = log.out
        .split("\n")
        .map((line) => line.split(" "))
        .filter((parts) => parts.length === 2 && Date.parse(parts[1]!) > startMs)
        .map((parts) => parts[0]!);
    } else if (!log.ok) {
      problems.push(`git log over ${manifestRel} failed — the manifest-commit-date VOID cannot be checked`);
    }
  } else {
    problems.push("no earliest session start could be established, so the manifest-commit-date VOID cannot be checked");
  }

  // `voidConditions` 4: rates byte-identical to the frozen commit. The blob is
  // read out and hashed in the same domain as the on-disk bytes — a git OBJECT
  // hash is not a content sha256 and comparing the two would always fire.
  const frozen = spawnSync("git", ["cat-file", "-p", `${RATES_FROZEN_COMMIT}:.local-coder/rates.json`], {
    cwd: repoRoot,
    encoding: "buffer",
  });
  let ratesSha256AtFrozenCommit: string | null = null;
  if (frozen.status === 0 && frozen.stdout !== null) {
    ratesSha256AtFrozenCommit = sha256(frozen.stdout);
  } else {
    problems.push(`git cat-file ${RATES_FROZEN_COMMIT}:.local-coder/rates.json failed — voidConditions 4's byte-identity cannot be checked`);
  }

  return {
    manifestBlobSha256: blob.ok ? blob.out : null,
    manifestCommitsAfterStart,
    ratesSha256AtFrozenCommit,
    problems,
  };
}

/**
 * The register `voidConditions` 1 reads. Registration is CONJUNCTIVE — the
 * clause's own words: the manifest "committed AND its `run_id` written to
 * `MEASUREMENTS.jsonl` by the same command" — so a committed manifest with no
 * row and a row with no committed manifest are both DISCREPANCIES, and neither
 * alone is a registered run (the plan gate's R10 correction).
 */
export function collectRegister(repoRoot: string, selfRunId: string): RunRegister {
  const discrepancies: string[] = [];

  const tree = git(repoRoot, ["ls-tree", "--name-only", "HEAD", "evidence/"]);
  const manifestIds = new Set<string>();
  if (tree.ok) {
    for (const name of tree.out.split("\n")) {
      const match = /^evidence\/(.+)\.b12\.tasks\.json$/.exec(name.trim());
      if (match !== null) manifestIds.add(match[1]!);
    }
  } else {
    discrepancies.push("git ls-tree over evidence/ failed — committed manifests could not be enumerated");
  }

  const rowIds = new Set<string>();
  const measurementsPath = path.join(repoRoot, "MEASUREMENTS.jsonl");
  if (existsSync(measurementsPath)) {
    const { rows } = parseJsonl(readFileSync(measurementsPath, "utf8"));
    for (const row of rows) {
      if (isObject(row) && typeof row.run_id === "string") rowIds.add(row.run_id);
    }
  } else {
    discrepancies.push("MEASUREMENTS.jsonl is absent — registration rows could not be read");
  }

  const priorRuns: PriorRun[] = [];
  for (const id of [...manifestIds].sort()) {
    if (id === selfRunId) continue;
    if (!rowIds.has(id)) {
      discrepancies.push(`evidence/${id}.b12.tasks.json is committed but MEASUREMENTS.jsonl carries no ${id} row — registration is conjunctive and this is neither registered nor clean`);
      continue;
    }
    const resultRel = `evidence/${id}.b12.result.json`;
    const show = git(repoRoot, ["show", `HEAD:${resultRel}`]);
    if (!show.ok) {
      // Registered, no committed result: clause 1's abandoned state.
      priorRuns.push({ runId: id, result: null, attempt: { consumed: true } });
      continue;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(show.out);
    } catch {
      discrepancies.push(`${resultRel} is committed but does not parse — read as no committed result`);
      priorRuns.push({ runId: id, result: null, attempt: { consumed: true } });
      continue;
    }
    priorRuns.push(narrowPriorRun(id, parsed, discrepancies));
  }

  return { priorRuns, discrepancies };
}

/**
 * One prior result, as clause 1 demands it listed: `scored` or the void clause
 * BY NAME, and the partial bracket either way. `voidConditions` 23's attempt
 * state comes from the result's own `attemptExempt` field when it names one of
 * the three enumerated vendor-side causes — a bare exemption claim naming
 * anything else is a discrepancy and CONSUMES, because "every other void is an
 * attempt".
 */
export function narrowPriorRun(id: string, parsed: unknown, discrepancies: string[]): PriorRun {
  const attemptOf = (raw: unknown): PriorRun["attempt"] => {
    if (raw === "auto-update" || raw === "echo-layout-change" || raw === "vendor-outage") {
      return { consumed: false, exempt: raw };
    }
    if (raw !== undefined && raw !== null) {
      discrepancies.push(`${id}'s result claims an attempt exemption the closed list does not name (${String(raw)}) — consumed`);
    }
    return { consumed: true };
  };
  if (!isObject(parsed)) {
    discrepancies.push(`${id}'s result is not an object — read as no committed result`);
    return { runId: id, result: null, attempt: { consumed: true } };
  }
  const rLo = typeof parsed.rLo === "number" ? parsed.rLo : null;
  const rHi = typeof parsed.rHi === "number" ? parsed.rHi : null;
  if (rLo === null || rHi === null) {
    discrepancies.push(`${id}'s result carries no bracket — clause 1 requires one on every listed prior run`);
    return { runId: id, result: null, attempt: attemptOf(parsed.attemptExempt) };
  }
  const bracket = { rLo, rHi };
  if (parsed.verdict === "void") {
    const voidClause = str(parsed.voidClause) ?? "(void with no clause named)";
    return { runId: id, result: { scored: false, voidClause, bracket }, attempt: attemptOf(parsed.attemptExempt) };
  }
  return { runId: id, result: { scored: true, bracket }, attempt: attemptOf(parsed.attemptExempt) };
}

/** Repo-relative with `/` separators on every platform — the identity source's spelling. */
const rel = (repoRoot: string, abs: string): string =>
  path.relative(repoRoot, abs).split(path.sep).join("/");

/**
 * Read the whole committed run archive back as one value.
 *
 * The ONE throw: a manifest that cannot be read or parsed. With no task list
 * and no pins there is no run to describe — the spec's "parse error with no
 * possible result", a bug or tampering rather than a run outcome, and the
 * sealed bytes are still in history for a reader to recover.
 */
export async function readRunArchive(repoRoot: string, runId: string): Promise<RunArchive> {
  const problems: string[] = [];
  const manifestPath = path.join(repoRoot, "evidence", `${runId}.b12.tasks.json`);
  const manifestBytes = readFileSync(manifestPath, "utf8");
  const manifestRaw: unknown = JSON.parse(manifestBytes);
  if (!isObject(manifestRaw)) throw new Error(`${manifestPath} does not hold an object`);

  const tasks: ManifestTask[] = [];
  if (Array.isArray(manifestRaw.tasks)) {
    for (const raw of manifestRaw.tasks) {
      const task = narrowTask(raw);
      if (task === null) problems.push("a manifest task entry is malformed (no string id) and was reported rather than read");
      else tasks.push(task);
    }
  } else {
    problems.push("the manifest carries no tasks array");
  }
  const manifest: RunManifest = {
    runId: str(manifestRaw.runId) ?? runId,
    tasks,
    pinned: isObject(manifestRaw.pinned) ? manifestRaw.pinned : {},
    abPairs: manifestRaw.abPairs,
    raw: manifestRaw,
  };
  if (manifest.runId !== runId) {
    problems.push(`the manifest names runId ${manifest.runId} while the file is addressed as ${runId}`);
  }

  // ---- observation directories -------------------------------------------
  const runDir = path.join(repoRoot, "evidence", runId);
  const observations: ArchivedObservation[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(runDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    problems.push(`evidence/${runId}/ is absent — the run has no observation directories`);
  }
  for (const name of entries.sort()) {
    const parsedName = parseObsDirName(name);
    if (parsedName === null) {
      problems.push(`evidence/${runId}/${name} is not an observation directory the harness writes — extra material, reported`);
      continue;
    }
    observations.push(readObservationDir(repoRoot, path.join(runDir, name), parsedName));
  }
  // Committed task order first, attempts ascending — DERIVED from the manifest,
  // never from directory enumeration: the metamorphic pair in the oracle holds
  // the selection invariant under a shuffled listing.
  const order = new Map(manifest.tasks.map((t, i) => [t.id, i]));
  observations.sort((a, b) => {
    const oa = order.get(a.taskId) ?? Number.MAX_SAFE_INTEGER;
    const ob = order.get(b.taskId) ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
    if (a.arm !== b.arm) return a.arm < b.arm ? -1 : 1;
    return a.attempt - b.attempt;
  });

  // ---- runlog -------------------------------------------------------------
  const runlogPath = path.join(repoRoot, "evidence", `${runId}.b12.runlog.jsonl`);
  let runlog: RunArchive["runlog"] = { rows: [], corruptLines: 0 };
  if (existsSync(runlogPath)) {
    const { rows, corruptLines } = parseJsonl(readFileSync(runlogPath, "utf8"));
    const narrowed: RunlogRow[] = [];
    let corrupt = corruptLines;
    for (const raw of rows) {
      const row = narrowRunlogRow(raw);
      if (row === null) corrupt++;
      else narrowed.push(row);
    }
    runlog = { rows: narrowed, corruptLines: corrupt };
  } else {
    problems.push(`evidence/${runId}.b12.runlog.jsonl is absent — the committed order cannot be replayed`);
  }

  // ---- rates, with the measured cap overlaid ------------------------------
  const ratesPath = path.join(repoRoot, RATES_REL_PATH);
  const ratesBytes = existsSync(ratesPath) ? readFileSync(ratesPath) : null;
  if (ratesBytes === null) problems.push(`${RATES_REL_PATH} is absent — nothing prices the run`);
  const cap = manifest.pinned.clientTruncationCap;
  const earliestStart = runlog.rows.length > 0 ? (runlog.rows[0]?.ts ?? null) : null;

  return loadRates(repoRoot).then((loaded) => {
    const rates =
      typeof cap === "number" && Number.isFinite(cap) && cap > 0
        ? { ...loaded, clientTruncationCap: cap }
        : loaded;
    if (typeof cap !== "number") {
      problems.push("the manifest pins no measured clientTruncationCap — voidConditions 8's first half");
    }
    return {
      runId,
      manifest,
      manifestSha256: sha256(manifestBytes),
      observations,
      runlog,
      rates,
      ratesSha256: ratesBytes === null ? "" : sha256(ratesBytes),
      git: collectGitFacts(repoRoot, runId, earliestStart),
      register: collectRegister(repoRoot, runId),
      problems,
    };
  });
}

/** The six files the harness emits per observation, checked by name. */
const OBS_FILES = [
  "observation.json",
  "snapshot-before.json",
  "snapshot-after.json",
  "cli-stdout.json",
  "archive.json",
  "telemetry.jsonl",
] as const;

function readObservationDir(
  repoRoot: string,
  dir: string,
  id: { taskId: string; arm: "treatment" | "control"; attempt: number }
): ArchivedObservation {
  const problems: string[] = [];
  const readJson = (name: string): unknown => {
    const file = path.join(dir, name);
    if (!existsSync(file)) {
      problems.push(`${name} is missing`);
      return null;
    }
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      problems.push(`${name} does not parse`);
      return null;
    }
  };
  for (const name of OBS_FILES) {
    if (!existsSync(path.join(dir, name))) {
      if (name === "cli-stdout.json") problems.push("cli-stdout.json is missing");
    }
  }

  const observationRaw = readJson("observation.json");
  const record = narrowObservationRecord(observationRaw);
  if (observationRaw !== null && record === null) problems.push("observation.json is not an object");
  if (record !== null && (record.taskId !== id.taskId || record.arm !== id.arm)) {
    problems.push(
      `observation.json names ${record.taskId}/${record.arm} while the directory names ${id.taskId}/${id.arm}`
    );
  }

  const archiveJson = readJson("archive.json");
  const lineage = rebuildLineageTranscript(archiveJson);
  if (lineage.problem !== null) problems.push(lineage.problem);

  // THE IDENTITY SOURCE. Rows come from telemetry.jsonl and the key's `source`
  // is that file's repo-relative path — `identify` is called HERE and nowhere
  // else in scoring.
  const telemetryFile = path.join(dir, "telemetry.jsonl");
  const telemetrySource = rel(repoRoot, telemetryFile);
  let telemetryRows: unknown[] = [];
  if (existsSync(telemetryFile)) {
    const { rows, corruptLines } = parseJsonl(readFileSync(telemetryFile, "utf8"));
    telemetryRows = rows;
    if (corruptLines > 0) problems.push(`telemetry.jsonl carries ${corruptLines} corrupt line(s)`);
  } else {
    problems.push("telemetry.jsonl is missing");
  }
  if (archiveJson !== null) {
    const drift = telemetryDrift(telemetryRows, isObject(archiveJson) ? archiveJson.telemetry : null);
    if (drift !== null) problems.push(drift);
  }

  const invocationIds =
    isObject(archiveJson) && Array.isArray(archiveJson.invocationIds)
      ? strings(archiveJson.invocationIds)
      : [];

  return {
    taskId: id.taskId,
    arm: id.arm,
    attempt: id.attempt,
    dir: rel(repoRoot, dir),
    record,
    lineageRecords: lineage.records,
    lineageFiles: lineage.files,
    transcript: lineage.transcript,
    identified: identify(telemetrySource, telemetryRows as TelemetryRecord[]),
    telemetrySource,
    invocationIds,
    snapshotBefore: narrowSnapshot(readJson("snapshot-before.json")),
    snapshotAfter: narrowSnapshot(readJson("snapshot-after.json")),
    problems,
  };
}
