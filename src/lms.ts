import { type CommandRunner, defaultRunner } from "./exec.js";
import { log } from "./logger.js";

export interface LmsModel {
  /** Best identifier we could extract for this model. */
  id: string;
  /** Every identifier candidate seen on the row (path, modelKey, key, …), for matching. */
  ids: string[];
  /** Size on disk in bytes. */
  sizeBytes: number;
}

export interface LmsLoadedModel {
  id: string;
  ids: string[];
}

/**
 * `lms` JSON field names vary by version, so we probe several. Identifiers can
 * live under any of these; sizes under any of the size keys.
 */
const ID_KEYS = ["path", "modelKey", "key", "displayName", "identifier", "name"];
const SIZE_KEYS = ["sizeBytes", "size_bytes", "size"];

function idsOf(row: Record<string, unknown>): string[] {
  return ID_KEYS.map((k) => row[k]).filter(
    (v): v is string => typeof v === "string" && v.trim() !== ""
  );
}

function sizeOf(row: Record<string, unknown>): number | null {
  for (const key of SIZE_KEYS) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/** Pull the array of rows out of the several shapes `lms --json` can return. */
function rowsOf(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of ["models", "data", "downloaded"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return null;
}

/**
 * Parse `lms ls --json` into models that have a usable size. Defensive about
 * field names and wrapper shapes. Rows without any size are skipped — a
 * sizeless model cannot be fit-checked. Never throws: an unrecognized payload
 * yields [].
 */
export function parseLmsList(jsonText: string): LmsModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const rows = rowsOf(parsed);
  if (rows === null) return [];

  const out: LmsModel[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const obj = row as Record<string, unknown>;
    const size = sizeOf(obj);
    if (size === null) continue;
    const ids = idsOf(obj);
    if (ids.length === 0) continue;
    out.push({ id: ids[0]!, ids, sizeBytes: size });
  }
  return out;
}

/** Parse `lms ps --json` into the set of currently-loaded models. Never throws. */
export function parseLmsPs(jsonText: string): LmsLoadedModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const rows = rowsOf(parsed);
  if (rows === null) return [];

  const out: LmsLoadedModel[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const ids = idsOf(row as Record<string, unknown>);
    if (ids.length === 0) continue;
    out.push({ id: ids[0]!, ids });
  }
  return out;
}

/**
 * Shell `lms ls --json` for downloaded models and their sizes. Returns null on
 * any failure — the `lms` binary missing (ENOENT), a non-zero exit, or
 * non-JSON output — after logging. Never throws; callers degrade to "sizes
 * unknown".
 */
export async function getLmsModels(run: CommandRunner = defaultRunner): Promise<LmsModel[] | null> {
  try {
    return parseLmsList(await run("lms", ["ls", "--json"]));
  } catch (error) {
    log.warn(
      `lms: could not list models via \`lms ls --json\`: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/** Shell `lms ps --json` for loaded models. Returns null on any failure. Never throws. */
export async function getLoadedLmsModels(
  run: CommandRunner = defaultRunner
): Promise<LmsLoadedModel[] | null> {
  try {
    return parseLmsPs(await run("lms", ["ps", "--json"]));
  } catch (error) {
    log.warn(
      `lms: could not list loaded models via \`lms ps --json\`: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
