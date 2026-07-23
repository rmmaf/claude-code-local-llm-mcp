/**
 * generate-models-csv — scan the models present in LM Studio and emit a
 * `model,objective` catalog CSV.
 *
 * Model names come byte-identical from `lms ls` (falling back to the `/models`
 * endpoint when `lms` isn't installed); objectives are looked up on Hugging
 * Face and, on any miss or with `--offline`, derived from the model name. This
 * runs as a subcommand of the server entry point
 * (`local-coder-mcp generate-models-csv`) and the `npm run generate-models-csv`
 * dev script — it is never part of the MCP transport, so it may write the CSV
 * to stdout; human progress goes to stderr.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { loadConfig } from "./config.js";
import type { CommandRunner } from "./exec.js";
import { getLmsModels } from "./lms.js";
import { type FetchLike, listModels } from "./llm-client.js";
import { log } from "./logger.js";
import { type ModelEntry, parseModelsCsv } from "./models-csv.js";
import { normalizeId } from "./selection.js";

const HF_API_BASE = "https://huggingface.co";
const HF_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 5_000;
// Size qualifiers for objectives (decimal GB, matching the README's "~17 GB").
const LARGE_MODEL_BYTES = 15_000_000_000;
const SMALL_MODEL_BYTES = 6_000_000_000;

// Quant/format/precision suffixes copied from selection.ts. Applied with
// `.replace()` on the original-case id (NOT normalizeId) so a derived Hugging
// Face repo id keeps its casing.
const QUANT_SUFFIX_RE =
  /(?:-(?:4bit|8bit|dwq|gguf|mlx|fp16|bf16|int4|int8|q\d+(?:_k(?:_[ms])?)?)|-v\d+)+$/gi;

export interface ScannedModel {
  /** Model name exactly as LM Studio references it. */
  model: string;
  /** Size on disk in bytes, or null when the scan source carries no sizes. */
  sizeBytes: number | null;
}

/** The pipeline_tag + tags pulled from the Hugging Face model API. */
export interface HfMeta {
  pipelineTag?: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Objective composition (pure)
// ---------------------------------------------------------------------------

/** Strip trailing quant/format tokens, preserving case (for a HF repo-id guess). */
export function huggingFaceRepoId(modelId: string): string {
  return modelId.replace(QUANT_SUFFIX_RE, "");
}

/** Map Hugging Face signals (and, secondarily, the name) to a use-case phrase. */
function coreDomain(tags: string[], pipelineTag: string, normId: string): string {
  const tagHas = (...ks: string[]): boolean => ks.some((k) => tags.includes(k));
  const idHas = (re: RegExp): boolean => re.test(normId);
  if (tagHas("code") || idHas(/coder|code-|(?:^|[-/])code(?:[-/]|$)/)) {
    return "code generation and refactoring";
  }
  if (
    pipelineTag === "feature-extraction" ||
    pipelineTag === "sentence-similarity" ||
    tagHas("sentence-transformers", "sentence-similarity") ||
    idHas(/embed|bge|gte|(?:^|[-/])e5|nomic/)
  ) {
    return "text embeddings and semantic search";
  }
  if (
    ["image-text-to-text", "image-to-text", "visual-question-answering"].includes(pipelineTag) ||
    tagHas("vision", "multimodal", "image-text-to-text") ||
    idHas(/vision|llava|(?:^|[-/])vlm?(?:[-/]|$)/)
  ) {
    return "vision-language multimodal tasks";
  }
  if (tagHas("math") || idHas(/math/)) {
    return "mathematical reasoning";
  }
  if (tagHas("reasoning") || idHas(/(?:^|[-/])(?:r1|qwq)(?:[-/]|$)|reason|thinking/)) {
    return "step-by-step reasoning";
  }
  if (
    pipelineTag === "text-generation" ||
    tagHas("conversational") ||
    idHas(/instruct|chat|(?:^|[-/])it(?:[-/]|$)/)
  ) {
    return "general instruction-following and chat";
  }
  return "general-purpose local model";
}

function withSizeQualifier(core: string, sizeBytes: number | null): string {
  if (sizeBytes !== null && sizeBytes >= LARGE_MODEL_BYTES) return `Large, capable — ${core}`;
  if (sizeBytes !== null && sizeBytes <= SMALL_MODEL_BYTES) return `Small, fast — ${core}`;
  return core.charAt(0).toUpperCase() + core.slice(1);
}

/** Objective derived purely from the model name + size (the HF-free fallback). */
export function deriveObjectiveFromName(modelId: string, sizeBytes: number | null): string {
  return withSizeQualifier(coreDomain([], "", normalizeId(modelId)), sizeBytes);
}

/** Objective composed from Hugging Face metadata (name used as a secondary hint). */
export function objectiveFromMeta(meta: HfMeta, modelId: string, sizeBytes: number | null): string {
  const tags = (meta.tags ?? []).map((t) => t.toLowerCase());
  const pipelineTag = (meta.pipelineTag ?? "").toLowerCase();
  return withSizeQualifier(coreDomain(tags, pipelineTag, normalizeId(modelId)), sizeBytes);
}

// ---------------------------------------------------------------------------
// CSV encoding (pure) — must round-trip through parseModelsCsv
// ---------------------------------------------------------------------------

/** RFC-4180 field: quote iff it contains a comma/quote/CR/LF; double internal quotes. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function encodeCatalog(entries: ModelEntry[]): string {
  return entries.map((e) => `${csvField(e.model)},${csvField(e.objective)}`).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Hugging Face lookup (network; injected fetch, always degrades — never throws)
// ---------------------------------------------------------------------------

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number
): Promise<{ ok: boolean; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!res.ok) return { ok: false, json: null };
    return { ok: true, json: await res.json().catch(() => null) };
  } catch {
    return { ok: false, json: null };
  } finally {
    clearTimeout(timer);
  }
}

function toMeta(json: unknown): HfMeta | null {
  if (json === null || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const pipelineTag = typeof o.pipeline_tag === "string" ? o.pipeline_tag : undefined;
  const tags = Array.isArray(o.tags)
    ? o.tags.filter((t): t is string => typeof t === "string")
    : undefined;
  if (pipelineTag === undefined && (tags === undefined || tags.length === 0)) return null;
  return { pipelineTag, tags };
}

/** Repo-id candidates for a direct API lookup (only ids shaped like owner/name). */
function repoIdCandidates(modelId: string): string[] {
  const out: string[] = [];
  for (const id of [modelId, huggingFaceRepoId(modelId)]) {
    if (id.includes("/") && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Best hit from a `?search=` response: prefer a basename match, then most downloads. */
function pickSearchHit(hits: unknown[], modelId: string): { id: string; meta: HfMeta | null } | null {
  const wantBase = normalizeId(huggingFaceRepoId(modelId).split("/").pop() ?? modelId);
  const parsed = hits
    .map((h) => {
      if (h === null || typeof h !== "object") return null;
      const o = h as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : typeof o.modelId === "string" ? o.modelId : null;
      if (id === null) return null;
      const downloads = typeof o.downloads === "number" ? o.downloads : 0;
      return { id, downloads, meta: toMeta(o) };
    })
    .filter((x): x is { id: string; downloads: number; meta: HfMeta | null } => x !== null);
  if (parsed.length === 0) return null;
  const exact = parsed.filter((p) => normalizeId(p.id.split("/").pop() ?? p.id) === wantBase);
  const pool = exact.length > 0 ? exact : parsed;
  pool.sort((a, b) => b.downloads - a.downloads);
  const best = pool[0]!;
  return { id: best.id, meta: best.meta };
}

/** Look up a model's HF metadata: direct repo-id GETs, then a search fallback. */
async function lookupHfMeta(
  modelId: string,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<HfMeta | null> {
  for (const repoId of repoIdCandidates(modelId)) {
    const { ok, json } = await fetchJson(fetchImpl, `${HF_API_BASE}/api/models/${repoId}`, timeoutMs);
    if (ok) {
      const meta = toMeta(json);
      if (meta) return meta;
    }
  }
  const basename = huggingFaceRepoId(modelId).split("/").pop() ?? modelId;
  const search = await fetchJson(
    fetchImpl,
    `${HF_API_BASE}/api/models?search=${encodeURIComponent(basename)}&limit=5`,
    timeoutMs
  );
  if (search.ok && Array.isArray(search.json)) {
    const hit = pickSearchHit(search.json, modelId);
    if (hit !== null) {
      if (hit.meta !== null) return hit.meta;
      const detail = await fetchJson(fetchImpl, `${HF_API_BASE}/api/models/${hit.id}`, timeoutMs);
      if (detail.ok) {
        const meta = toMeta(detail.json);
        if (meta) return meta;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scan + build (merge-aware)
// ---------------------------------------------------------------------------

/** Enumerate downloaded models via `lms ls`, falling back to the `/models` ids. */
async function scanLocalModels(
  runner: CommandRunner | undefined,
  endpoint: string,
  fetchImpl: FetchLike
): Promise<{ models: ScannedModel[]; source: "lms" | "models" } | null> {
  const lms = await getLmsModels(runner);
  if (lms !== null && lms.length > 0) {
    return { models: lms.map((m) => ({ model: m.id, sizeBytes: m.sizeBytes })), source: "lms" };
  }
  try {
    const ids = await listModels(endpoint, PROBE_TIMEOUT_MS, fetchImpl);
    if (ids.length > 0) {
      return { models: ids.map((id) => ({ model: id, sizeBytes: null })), source: "models" };
    }
  } catch (error) {
    log.warn(
      `generate-catalog: /models fallback failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return null;
}

export interface BuildCatalogResult {
  entries: ModelEntry[];
  /** Model names newly discovered by the scan (objectives freshly derived). */
  added: string[];
  /** Scanned model names already present in the existing CSV (objective kept). */
  preserved: string[];
}

/**
 * Merge scanned models into an existing catalog. Existing rows keep their order
 * and objectives (so user/Claude refinements survive a re-run, and their HF
 * lookup is skipped); newly-discovered models are appended with a looked-up or
 * heuristic objective. Rows for models no longer present locally are retained.
 */
export async function buildCatalog(
  scanned: ScannedModel[],
  existing: ModelEntry[],
  opts: { offline: boolean; fetchImpl: FetchLike; hfTimeoutMs: number }
): Promise<BuildCatalogResult> {
  const entries: ModelEntry[] = existing.map((e) => ({ ...e }));
  const seen = new Set(existing.map((e) => normalizeId(e.model)));
  const added: string[] = [];
  const preserved: string[] = [];

  for (const sm of scanned) {
    const key = normalizeId(sm.model);
    if (seen.has(key)) {
      preserved.push(sm.model);
      continue;
    }
    let objective: string;
    if (opts.offline) {
      objective = deriveObjectiveFromName(sm.model, sm.sizeBytes);
    } else {
      const meta = await lookupHfMeta(sm.model, opts.fetchImpl, opts.hfTimeoutMs);
      objective =
        meta !== null
          ? objectiveFromMeta(meta, sm.model, sm.sizeBytes)
          : deriveObjectiveFromName(sm.model, sm.sizeBytes);
    }
    entries.push({ model: sm.model, objective });
    seen.add(key);
    added.push(sm.model);
  }
  return { entries, added, preserved };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  out: string | null;
  offline: boolean;
  endpoint: string | null;
  help: boolean;
}

export function parseGenerateArgs(argv: string[]): GenerateOptions {
  const opts: GenerateOptions = { out: null, offline: false, endpoint: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--offline") opts.offline = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--out") opts.out = argv[++i] ?? null;
    else if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else if (arg === "--endpoint") opts.endpoint = argv[++i] ?? null;
    else if (arg.startsWith("--endpoint=")) opts.endpoint = arg.slice("--endpoint=".length);
    else log.warn(`generate-catalog: ignoring unknown argument ${JSON.stringify(arg)}`);
  }
  return opts;
}

const HELP = `Usage: local-coder-mcp generate-models-csv [--out <path>] [--offline] [--endpoint <url>]

Scan the models present in LM Studio and write a "model,objective" catalog CSV.
Model names are taken byte-identical from \`lms ls\`; objectives are looked up on
Hugging Face (name-based fallback on a miss, or with --offline).

  --out <path>      Write (and merge into) this CSV file. Omit to print to stdout.
  --offline         Skip Hugging Face; derive objectives from model names only.
  --endpoint <url>  LM Studio base URL for the /models fallback (default LM_STUDIO_URL).
  -h, --help        Show this help.

Re-running with --out preserves objectives already in the file and only looks up
newly-downloaded models.
`;

export interface GenerateDeps {
  runner?: CommandRunner;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  readFileImpl?: (p: string) => Promise<string>;
}

async function writeFileAtomic(outPath: string, content: string): Promise<void> {
  const dir = path.dirname(outPath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(outPath)}.${process.pid}.tmp`);
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, outPath);
}

/** Run the generator. Returns a process exit code (0 = success, 1 = nothing to scan). */
export async function runGenerateCatalog(argv: string[], deps: GenerateDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const write = deps.stdout ?? ((s: string): void => void process.stdout.write(s));
  const note = deps.stderr ?? ((s: string): void => void process.stderr.write(s));
  const fetchImpl = deps.fetchImpl ?? fetch;

  const opts = parseGenerateArgs(argv);
  if (opts.help) {
    note(HELP);
    return 0;
  }

  const config = loadConfig(env, cwd);
  const endpoint = opts.endpoint ?? config.baseUrl;

  note("Scanning models present in LM Studio…\n");
  const scan = await scanLocalModels(deps.runner, endpoint, fetchImpl);
  if (scan === null) {
    note(
      "No local models found. Make sure LM Studio is installed with at least one model downloaded " +
        "(`lms ls` should list them), or that its server is running for the /models fallback.\n"
    );
    return 1;
  }
  note(
    `Found ${scan.models.length} model(s) via ${scan.source === "lms" ? "`lms ls`" : "the /models endpoint (sizes unknown)"}.\n`
  );

  let existing: ModelEntry[] = [];
  if (opts.out !== null) {
    const readFileImpl = deps.readFileImpl ?? ((p: string) => fs.readFile(p, "utf8"));
    try {
      existing = parseModelsCsv(await readFileImpl(opts.out));
      if (existing.length > 0) {
        note(
          `Merging with ${existing.length} existing entr${existing.length === 1 ? "y" : "ies"} in ${opts.out}; their objectives are preserved.\n`
        );
      }
    } catch {
      // No existing file (or unreadable) — start fresh.
    }
  }

  if (!opts.offline) {
    const toLookUp = scan.models.filter(
      (m) => !existing.some((e) => normalizeId(e.model) === normalizeId(m.model))
    ).length;
    if (toLookUp > 0) note(`Looking up ${toLookUp} objective(s) on Hugging Face…\n`);
  }

  const { entries, added, preserved } = await buildCatalog(scan.models, existing, {
    offline: opts.offline,
    fetchImpl,
    hfTimeoutMs: HF_TIMEOUT_MS,
  });
  const csv = encodeCatalog(entries);

  if (opts.out !== null) {
    await writeFileAtomic(opts.out, csv);
    note(
      `Wrote ${entries.length} model(s) to ${opts.out} (${added.length} new, ${preserved.length} already present).\n`
    );
    note(`Point the server at it: set LOCAL_CODER_MODELS_CSV=${opts.out}\n`);
  } else {
    write(csv);
    note(
      `Generated a ${entries.length}-model catalog (${added.length} new). Redirect stdout to a file and set LOCAL_CODER_MODELS_CSV to it.\n`
    );
  }
  return 0;
}
