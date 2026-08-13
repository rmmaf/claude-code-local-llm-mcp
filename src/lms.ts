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
  /**
   * Context length the model is CURRENTLY loaded with, shared between input and
   * output — null when `lms` does not report it.
   *
   * This is the constraint that actually bounds a whole-file answer, and nothing
   * in this codebase consulted it before `run 2026-08-04-mac-12-variance`:
   * `enforceOutputCap` compares an estimated OUTPUT size against
   * `maxOutputTokens` alone, so it approved `src/tools/repair.ts` at ~10.2k
   * estimated output tokens while the request needed ~9.9k input + ~9.0k output
   * in a 16384-token window. The model dropped 90 lines and returned a
   * well-formed block; every check the pipeline has passed.
   */
  contextLength: number | null;
  /** Largest context the model supports, i.e. how much room a reload could buy. */
  maxContextLength: number | null;
}

/**
 * `lms` JSON field names vary by version, so we probe several. Identifiers can
 * live under any of these; sizes under any of the size keys.
 */
const ID_KEYS = ["path", "modelKey", "key", "displayName", "identifier", "name"];
const SIZE_KEYS = ["sizeBytes", "size_bytes", "size"];
const CONTEXT_KEYS = ["contextLength", "contextSize"];
const MAX_CONTEXT_KEYS = ["maxContextLength", "max_context_length"];

function positiveNumberOf(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

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
    const obj = row as Record<string, unknown>;
    const ids = idsOf(obj);
    if (ids.length === 0) continue;
    out.push({
      id: ids[0]!,
      ids,
      contextLength: positiveNumberOf(obj, CONTEXT_KEYS),
      maxContextLength: positiveNumberOf(obj, MAX_CONTEXT_KEYS),
    });
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

/**
 * Pick the loaded context length that a request is about to be judged against.
 *
 * Returns null — meaning "do not check" — whenever the answer is not knowable,
 * and that is the whole design: the context pre-flight refuses requests, so a
 * GUESS here would refuse valid work. Null is the honest answer in four cases:
 * `lms` is unavailable; nothing is loaded (JIT will load on demand, at a context
 * we cannot see yet); `wanted` is named and no loaded id matches it — at ANY
 * count, including exactly one other model, because that one's window says
 * nothing about the window `wanted` will be loaded with; or `wanted` is absent
 * and more than one model is loaded, so nothing says which the request lands on.
 *
 * `wanted` is matched against every identifier spelling `lms` reports, the same
 * fuzzy set `selection.ts` matches on, because the served id and the catalog id
 * routinely differ.
 */
export function pickLoadedContextTokens(
  loaded: LmsLoadedModel[] | null,
  wanted: string | undefined
): number | null {
  if (loaded === null || loaded.length === 0) return null;
  if (wanted !== undefined && wanted.trim() !== "") {
    const needle = wanted.trim().toLowerCase();
    const hit = loaded.find((m) => m.ids.some((id) => id.toLowerCase() === needle));
    if (hit !== undefined) return hit.contextLength;
    // A named model that is not loaded tells us NOTHING about the context it
    // will be loaded with — and that stays true when exactly one other model
    // happens to be loaded. Returning that one's window borrows a number from an
    // unrelated model: a 32k model loaded while the request goes to a 16k one
    // admits a request that overflows, and the answer comes back as a closed,
    // well-formed, shorter file. The inverse spelling of the same mistake
    // refuses work that would have fit.
    return null;
  }
  if (loaded.length > 1) {
    log.warn(
      `lms: ${loaded.length} models are loaded and none was named; skipping the context pre-flight ` +
        `rather than guessing which context length applies`
    );
    return null;
  }
  return loaded[0]?.contextLength ?? null;
}
