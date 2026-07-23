import { z } from "zod";

import type { Config } from "../config.js";
import { getLmsModels, getLoadedLmsModels } from "../lms.js";
import { listModels } from "../llm-client.js";
import { log } from "../logger.js";
import { bytesToGb, getMemoryInfo, type MemoryInfo } from "../memory.js";
import {
  buildCatalogReport,
  selectModelsForMemory,
  serializeReport,
  usableFree,
  type MultiSelection,
  type SerializedReport,
} from "../selection.js";
import type { ToolDeps } from "./shared.js";

export const modelsToolName = "models";

export const modelsToolDescription = `List the configured local model catalog with, for each model: its stated objective (what it's good for), whether LM Studio currently offers it, its size on disk, whether it fits the machine's free RAM right now, and whether it is already loaded — plus a recommended set of models for running one or more agents concurrently.

Call this BEFORE delegating with implement/fix/scaffold to choose a model by objective + memory: read each model's objective, match it to the task at hand, confirm it fits free RAM, then pass that exact model name as the "model" argument to the work tool. For several simultaneous agents, set concurrent_models to how many must co-reside and use the returned "recommended" set (or pack by size yourself from the per-model sizes — the packer is greedy largest-first and advisory).

Read-only and never fails — an unreachable endpoint or a missing \`lms\` CLI is reported as a field, not an error. Sizes come from \`lms ls\`; if \`lms\` isn't installed, sizes and fit are null and selection falls back to catalog order. Model names that don't match \`lms\`/\`/models\` exactly are still shown, with a match-quality flag ("exact"/"fuzzy"/"none") so you can spot a mistyped CSV entry.`;

export const modelsInputSchema = {
  concurrent_models: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "How many models must fit in free RAM at once, for running that many agents concurrently. Default 1."
    ),
};

const argsSchema = z.object(modelsInputSchema);
export type ModelsArgs = z.infer<typeof argsSchema>;

export interface ModelsResult {
  endpoint_reachable: boolean;
  lms_available: boolean;
  memory: {
    total_gb: number;
    free_gb: number;
    usable_free_gb: number | null;
    source: string;
    fit_fraction: number;
  } | null;
  models: SerializedReport[];
  recommended: MultiSelection;
  hint?: string;
}

const MODELS_PROBE_TIMEOUT_MS = 5_000;

/** Never throws: every probe failure degrades to a reported field. */
export async function runModels(
  config: Config,
  args: ModelsArgs = {},
  deps: ToolDeps = {}
): Promise<ModelsResult> {
  let reachable = false;
  let apiIds: string[] = [];
  let hint: string | undefined;
  try {
    apiIds = await listModels(
      config.baseUrl,
      Math.min(config.timeoutMs, MODELS_PROBE_TIMEOUT_MS),
      deps.fetchImpl ?? fetch
    );
    reachable = true;
  } catch (error) {
    hint = "start LM Studio's server with `lms server start`";
    log.warn(
      `models: LM Studio unreachable at ${config.baseUrl}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let memory: MemoryInfo | null = null;
  try {
    memory = await getMemoryInfo(deps.runner, deps.platform);
  } catch (error) {
    log.warn(`models: memory probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const lms = await getLmsModels(deps.runner);
  const loaded = await getLoadedLmsModels(deps.runner);
  const usable = usableFree(memory, config.memFitFraction);
  const report = buildCatalogReport(config.models, reachable ? apiIds : null, lms, loaded, usable);
  const recommended = selectModelsForMemory(report, usable, args.concurrent_models ?? 1);

  const result: ModelsResult = {
    endpoint_reachable: reachable,
    lms_available: lms !== null,
    memory: memory
      ? {
          total_gb: bytesToGb(memory.totalBytes),
          free_gb: bytesToGb(memory.freeBytes),
          usable_free_gb: usable === null ? null : bytesToGb(usable),
          source: memory.source,
          fit_fraction: config.memFitFraction,
        }
      : null,
    models: report.map(serializeReport),
    recommended,
  };
  if (hint !== undefined) result.hint = hint;
  return result;
}
