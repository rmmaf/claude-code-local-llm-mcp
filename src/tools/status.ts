import type { Config } from "../config.js";
import { getLmsModels, getLoadedLmsModels } from "../lms.js";
import { listModels } from "../llm-client.js";
import { log } from "../logger.js";
import { bytesToGb, getMemoryInfo, type MemoryInfo } from "../memory.js";
import {
  buildCatalogReport,
  selectModelForMemory,
  serializeReport,
  usableFree,
  type SerializedReport,
} from "../selection.js";
import type { ToolDeps } from "./shared.js";

export const statusToolName = "status";

export const statusToolDescription = `Health check for the local delegation setup. Reports: whether LM Studio's server is reachable, which model IDs it offers, whether the \`lms\` CLI is usable, the configured model catalog with each model's availability / size / whether it fits free RAM, total and free RAM, which model the memory-only fallback would auto-pick right now, and the effective configuration. Read-only and never fails — an unreachable endpoint or a missing \`lms\` CLI is reported as a field, not an error.

Use it: at the start of a session, or to diagnose why implement/fix/scaffold calls are erroring (endpoint down, model ID mismatch vs the CSV, memory pressure, missing \`lms\`).

Do NOT use it as a per-call precondition — implement/fix/scaffold surface their own errors. To choose a model by objective + memory, use the \`models\` tool instead. Takes no arguments.`;

export const statusInputSchema = {};

export interface StatusResult {
  reachable: boolean;
  hint?: string;
  models: string[];
  lms_available: boolean;
  catalog: SerializedReport[];
  memory: {
    total_gb: number;
    free_gb: number;
    usable_free_gb: number | null;
    source: string;
    fit_fraction: number;
  } | null;
  auto_selection: { model: string; reason: string };
  config: {
    base_url: string;
    models_csv_path: string | null;
    mem_fit_fraction: number;
    temperature: number;
    max_output_tokens: number;
    timeout_ms: number;
    max_file_kb: number;
    max_context_kb: number;
    root: string;
  };
}

const STATUS_PROBE_TIMEOUT_MS = 5_000;

/** Never throws: every probe failure degrades to a reported field. */
export async function runStatus(config: Config, deps: ToolDeps = {}): Promise<StatusResult> {
  let reachable = false;
  let models: string[] = [];
  let hint: string | undefined;
  try {
    models = await listModels(
      config.baseUrl,
      Math.min(config.timeoutMs, STATUS_PROBE_TIMEOUT_MS),
      deps.fetchImpl ?? fetch
    );
    reachable = true;
  } catch (error) {
    hint = "start LM Studio's server with `lms server start`";
    log.warn(
      `status: LM Studio unreachable at ${config.baseUrl}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let memory: MemoryInfo | null = null;
  try {
    memory = await getMemoryInfo(deps.runner, deps.platform);
  } catch (error) {
    log.warn(`status: memory probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const lms = await getLmsModels(deps.runner);
  const loaded = await getLoadedLmsModels(deps.runner);
  const usable = usableFree(memory, config.memFitFraction);
  const report = buildCatalogReport(config.models, reachable ? models : null, lms, loaded, usable);
  const autoSelection = selectModelForMemory(report, config.models);

  const result: StatusResult = {
    reachable,
    models,
    lms_available: lms !== null,
    catalog: report.map(serializeReport),
    memory: memory
      ? {
          total_gb: bytesToGb(memory.totalBytes),
          free_gb: bytesToGb(memory.freeBytes),
          usable_free_gb: usable === null ? null : bytesToGb(usable),
          source: memory.source,
          fit_fraction: config.memFitFraction,
        }
      : null,
    auto_selection: autoSelection,
    config: {
      base_url: config.baseUrl,
      models_csv_path: config.modelsCsvPath,
      mem_fit_fraction: config.memFitFraction,
      temperature: config.temperature,
      max_output_tokens: config.maxOutputTokens,
      timeout_ms: config.timeoutMs,
      max_file_kb: config.maxFileKb,
      max_context_kb: config.maxContextKb,
      root: config.root,
    },
  };
  if (hint !== undefined) result.hint = hint;
  return result;
}
