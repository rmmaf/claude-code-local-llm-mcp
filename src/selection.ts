import type { Config } from "./config.js";
import type { CommandRunner } from "./exec.js";
import { getLmsModels, type LmsLoadedModel, type LmsModel } from "./lms.js";
import { log } from "./logger.js";
import { bytesToGb, getMemoryInfo, type MemoryInfo } from "./memory.js";
import { DEFAULT_MODEL_CATALOG, type ModelEntry } from "./models-csv.js";

export type MatchQuality = "exact" | "fuzzy" | "none";

/** Lowercase, trim, backslashes → forward slashes. */
export function normalizeId(s: string): string {
  return s.trim().toLowerCase().replace(/\\/g, "/");
}

// Quant/format/precision tokens that distinguish the same base model. Stripped
// only for fuzzy matching, never to pick which quant actually runs.
const QUANT_SUFFIX_RE = /(?:-(?:4bit|8bit|dwq|gguf|mlx|fp16|bf16|int4|int8|q\d+(?:_k(?:_[ms])?)?)|-v\d+)+$/gi;

/** Candidate forms for fuzzy comparison: full, basename, and quant-stripped variants. */
function fuzzyForms(id: string): Set<string> {
  const norm = normalizeId(id);
  const base = norm.split("/").pop() ?? norm;
  const forms = new Set<string>();
  for (const f of [norm, base, norm.replace(QUANT_SUFFIX_RE, ""), base.replace(QUANT_SUFFIX_RE, "")]) {
    if (f !== "") forms.add(f);
  }
  return forms;
}

/**
 * Match a CSV model name against candidate identifiers (from `/models` or
 * `lms ls`). Exact normalized match first; then a conservative fuzzy pass
 * (basename and quant/format-suffix-stripped equality). Returns the matched
 * candidate and how it matched, so fuzzy matches are surfaced, never trusted
 * silently.
 */
export function matchModel(
  csvName: string,
  candidates: string[]
): { value: string | null; quality: MatchQuality } {
  const target = normalizeId(csvName);
  for (const c of candidates) {
    if (normalizeId(c) === target) return { value: c, quality: "exact" };
  }
  const targetForms = fuzzyForms(csvName);
  for (const c of candidates) {
    for (const cf of fuzzyForms(c)) {
      if (targetForms.has(cf)) return { value: c, quality: "fuzzy" };
    }
  }
  return { value: null, quality: "none" };
}

export interface ModelReport {
  model: string;
  objective: string;
  /** Present in `/models`? null when the endpoint was unreachable. */
  available: boolean | null;
  availableMatch: MatchQuality;
  /** Size on disk; null when no `lms` match (or `lms` unavailable). */
  sizeBytes: number | null;
  sizeGb: number | null;
  sizeMatch: MatchQuality;
  /** Already loaded in LM Studio? null when `lms ps` was unavailable. */
  loaded: boolean | null;
  /** size ≤ usable free RAM; null when size or memory is unknown. */
  fits: boolean | null;
}

/** Serialized (snake_case) form of a ModelReport for tool output. */
export interface SerializedReport {
  model: string;
  objective: string;
  available: boolean | null;
  available_match: MatchQuality;
  size_gb: number | null;
  size_bytes: number | null;
  size_match: MatchQuality;
  loaded: boolean | null;
  fits: boolean | null;
}

export function serializeReport(r: ModelReport): SerializedReport {
  return {
    model: r.model,
    objective: r.objective,
    available: r.available,
    available_match: r.availableMatch,
    size_gb: r.sizeGb,
    size_bytes: r.sizeBytes,
    size_match: r.sizeMatch,
    loaded: r.loaded,
    fits: r.fits,
  };
}

/** Free RAM we're willing to commit to model weights: freeBytes × fitFraction. */
export function usableFree(memory: MemoryInfo | null, fitFraction: number): number | null {
  if (memory === null) return null;
  return memory.freeBytes * fitFraction;
}

/**
 * Join the catalog against the three live surfaces — `/models` availability,
 * `lms` sizes, `lms ps` loaded-state — and the memory budget, one row per
 * catalog model, preserving catalog order. Pure.
 */
export function buildCatalogReport(
  catalog: ModelEntry[],
  apiModelIds: string[] | null,
  lms: LmsModel[] | null,
  loaded: LmsLoadedModel[] | null,
  usableFreeBytes: number | null
): ModelReport[] {
  const lmsCandidates = lms === null ? [] : lms.flatMap((m) => m.ids);
  const loadedCandidates = loaded === null ? [] : loaded.flatMap((m) => m.ids);

  return catalog.map((entry) => {
    let available: boolean | null = null;
    let availableMatch: MatchQuality = "none";
    if (apiModelIds !== null) {
      const m = matchModel(entry.model, apiModelIds);
      available = m.value !== null;
      availableMatch = m.quality;
    }

    let sizeBytes: number | null = null;
    let sizeMatch: MatchQuality = "none";
    if (lms !== null) {
      const m = matchModel(entry.model, lmsCandidates);
      if (m.value !== null) {
        const hit = lms.find((x) => x.ids.includes(m.value as string));
        if (hit) {
          sizeBytes = hit.sizeBytes;
          sizeMatch = m.quality;
        }
      }
    }

    let loadedFlag: boolean | null = null;
    if (loaded !== null) {
      loadedFlag = matchModel(entry.model, loadedCandidates).value !== null;
    }

    const fits =
      sizeBytes !== null && usableFreeBytes !== null ? sizeBytes <= usableFreeBytes : null;

    return {
      model: entry.model,
      objective: entry.objective,
      available,
      availableMatch,
      sizeBytes,
      sizeGb: sizeBytes === null ? null : bytesToGb(sizeBytes),
      sizeMatch,
      loaded: loadedFlag,
      fits,
    };
  });
}

export interface SingleSelection {
  model: string;
  reason: string;
}

/**
 * Pick one model for the memory-only fallback (used when a tool call omits
 * `model`, and by `status.auto_selection`): the largest catalog model that
 * fits usable free RAM (more capable; tie-broken by catalog order). If none fit
 * or sizes are unknown, the first catalog entry, with a logged reason. Never
 * fails — sizing trouble must not block generation.
 */
export function selectModelForMemory(report: ModelReport[], catalog: ModelEntry[]): SingleSelection {
  const fitting = report.filter((r) => r.fits === true && r.sizeBytes !== null);
  if (fitting.length > 0) {
    let best = fitting[0]!;
    for (const r of fitting) {
      if ((r.sizeBytes ?? 0) > (best.sizeBytes ?? 0)) best = r;
    }
    return { model: best.model, reason: `largest catalog model fitting usable free RAM (${best.sizeGb} GB): ${best.model}` };
  }
  const first = catalog[0] ?? DEFAULT_MODEL_CATALOG[0]!;
  const anySize = report.some((r) => r.sizeBytes !== null);
  const reason = anySize
    ? `no catalog model fit usable free RAM; falling back to the first configured model: ${first.model}`
    : `no model sizes available (is \`lms\` installed and are the models downloaded?); falling back to the first configured model: ${first.model}`;
  return { model: first.model, reason };
}

export interface MultiSelection {
  models: string[];
  totalGb: number;
  fits: boolean;
  reason: string;
}

/**
 * Pack up to `maxCount` distinct models into usable free RAM for running that
 * many agents at once — greedy, largest-first. Advisory: it also reports each
 * model's individual size (via buildCatalogReport) so the caller can pack by
 * objective instead. LM Studio loads/unloads independently, and free RAM
 * shifts between probe and load, so a positive fit is not a guarantee.
 */
export function selectModelsForMemory(
  report: ModelReport[],
  usableFreeBytes: number | null,
  maxCount: number
): MultiSelection {
  const count = Math.max(1, Math.floor(maxCount));
  const sized = report.filter((r) => r.sizeBytes !== null);
  if (sized.length === 0) {
    return {
      models: [],
      totalGb: 0,
      fits: false,
      reason: "no model sizes available (is `lms` installed and are the models downloaded?)",
    };
  }
  const ordered = sized
    .map((r, idx) => ({ r, idx }))
    .sort((a, b) => (b.r.sizeBytes ?? 0) - (a.r.sizeBytes ?? 0) || a.idx - b.idx)
    .map((x) => x.r);

  if (usableFreeBytes === null) {
    const picked = ordered.slice(0, count);
    return {
      models: picked.map((r) => r.model),
      totalGb: bytesToGb(picked.reduce((s, r) => s + (r.sizeBytes ?? 0), 0)),
      fits: false,
      reason: `memory unknown; listing the ${picked.length} largest sized model(s) without a fit guarantee`,
    };
  }

  const picked: ModelReport[] = [];
  let sum = 0;
  for (const r of ordered) {
    if (picked.length >= count) break;
    const size = r.sizeBytes ?? 0;
    if (sum + size <= usableFreeBytes) {
      picked.push(r);
      sum += size;
    }
  }
  return {
    models: picked.map((r) => r.model),
    totalGb: bytesToGb(sum),
    fits: picked.length === count,
    reason:
      picked.length === count
        ? `${picked.length} model(s) fit within usable free RAM (${bytesToGb(sum)} GB total)`
        : `only ${picked.length} of ${count} requested model(s) fit within usable free RAM (${bytesToGb(sum)} GB)`,
  };
}

/** The subset of tool deps the resolver needs (structurally satisfied by ToolDeps). */
export interface SelectionDeps {
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
}

/**
 * Resolve which model a work tool (implement/fix/scaffold) should run. An
 * explicit model — chosen by Claude via the `models` tool — is used verbatim
 * (with a non-blocking warning if it isn't in the catalog). Otherwise this
 * probes memory + `lms` sizes and picks the largest configured model that fits
 * free RAM. Never throws: a total probe failure still returns a model.
 */
export async function resolveModel(
  explicit: string | undefined,
  config: Config,
  deps: SelectionDeps = {}
): Promise<SingleSelection> {
  if (explicit !== undefined && explicit.trim() !== "") {
    const model = explicit.trim();
    const known = config.models.some((m) => normalizeId(m.model) === normalizeId(model));
    if (!known) {
      log.warn(`selection: model ${JSON.stringify(model)} is not in the catalog; sending it to LM Studio anyway`);
    }
    return { model, reason: known ? `explicit model requested: ${model}` : `explicit model requested (not in catalog): ${model}` };
  }
  const catalog = config.models.length > 0 ? config.models : DEFAULT_MODEL_CATALOG;
  const memory = await getMemoryInfo(deps.runner, deps.platform);
  const lms = await getLmsModels(deps.runner);
  const report = buildCatalogReport(catalog, null, lms, null, usableFree(memory, config.memFitFraction));
  const selection = selectModelForMemory(report, catalog);
  log.info(`selection: auto-picked ${selection.model} (${selection.reason})`);
  return selection;
}
