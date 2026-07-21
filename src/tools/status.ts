import type { Config } from "../config.js";
import { listModels } from "../llm-client.js";
import { log } from "../logger.js";
import { autoSelectProfile, bytesToGb, type Profile } from "../profile.js";
import type { ToolDeps } from "./shared.js";

export const statusToolName = "status";

export const statusToolDescription = `Health check for the local delegation setup. Reports: whether LM Studio's server is reachable, which model IDs it offers, whether the two configured profile models are present, total and free RAM, which profile auto-selection would pick right now, and the effective configuration. Read-only and never fails — an unreachable endpoint is reported as reachable: false with a hint, not an error.

Use it: at the start of a session before the first delegation, or to diagnose why implement/fix/scaffold calls are erroring (endpoint down, model ID mismatch, memory pressure).

Do NOT use it as a per-call precondition — implement/fix/scaffold surface their own errors. Takes no arguments.`;

export const statusInputSchema = {};

export interface StatusResult {
  reachable: boolean;
  hint?: string;
  models: string[];
  profile_models: {
    solo: { id: string; available: boolean | null };
    ide: { id: string; available: boolean | null };
  };
  memory: { total_gb: number; free_gb: number; source: string } | null;
  auto_profile: { profile: Profile; reason: string };
  config: {
    base_url: string;
    solo_min_free_gb: number;
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

  const modelAvailable = (id: string): boolean | null => {
    if (!reachable) return null;
    const lower = id.toLowerCase();
    return models.some((m) => m.toLowerCase() === lower);
  };

  let selection: { profile: Profile; reason: string; memory: { totalBytes: number; freeBytes: number; source: string } | null };
  try {
    selection = await autoSelectProfile(config, deps.runner, deps.platform);
  } catch (error) {
    log.warn(`status: profile probe failed: ${error instanceof Error ? error.message : String(error)}`);
    selection = { profile: "solo", reason: "profile probe failed; defaulting to solo", memory: null };
  }

  const result: StatusResult = {
    reachable,
    models,
    profile_models: {
      solo: { id: config.modelSolo, available: modelAvailable(config.modelSolo) },
      ide: { id: config.modelIde, available: modelAvailable(config.modelIde) },
    },
    memory: selection.memory
      ? {
          total_gb: bytesToGb(selection.memory.totalBytes),
          free_gb: bytesToGb(selection.memory.freeBytes),
          source: selection.memory.source,
        }
      : null,
    auto_profile: { profile: selection.profile, reason: selection.reason },
    config: {
      base_url: config.baseUrl,
      solo_min_free_gb: config.soloMinFreeGb,
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
