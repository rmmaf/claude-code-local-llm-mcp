import { getClaudeMdState, type ClaudeMdResult } from "../claude-md.js";
import type { Config } from "../config.js";
import { getLmsModels, getLoadedLmsModels, pickLoadedContextTokens } from "../lms.js";
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
  /**
   * The context window the pre-flight will judge requests against, and where the
   * number came from. Input and output SHARE it, so it — not
   * `max_output_tokens` — is what bounds a whole-file answer.
   *
   * Here because `context_would_overflow` is a refusal users have to be able to
   * explain, and `tokens: null` is the case worth surfacing loudest: the check
   * is switched off, silently, until `lms` can name one loaded model or
   * `LOCAL_CODER_CONTEXT_TOKENS` is set.
   */
  context_window: {
    /** The one the pre-flight will use: the smaller of the two below. */
    tokens: number | null;
    /**
     * `disagreement` is the case worth reading first: the configured value and
     * the loaded one differ, which is what a crashed-and-reloaded model looks
     * like. `unknown` means the check is off entirely.
     */
    source: "config" | "lms" | "disagreement" | "unknown";
    configured_tokens: number | null;
    probed_tokens: number | null;
    /** How much larger a reload could make it, when `lms` says. */
    max_tokens: number | null;
  };
  /**
   * What the startup install of the delegation policy did, or null when it has
   * not run in this process. Read-only: `status` reports the outcome, it never
   * writes. See `src/claude-md.ts`.
   */
  claude_md: ClaudeMdResult | null;
  config: {
    base_url: string;
    models_csv_path: string | null;
    mem_fit_fraction: number;
    temperature: number;
    max_output_tokens: number;
    timeout_ms: number;
    max_file_kb: number;
    max_context_kb: number;
    /**
     * The configured `LOCAL_CODER_CONTEXT_TOKENS`, or null when unset or
     * rejected as invalid. NOT an override: it is cross-checked against the
     * `lms ps` probe and the SMALLER of the two wins. The effective window is
     * `context_window.tokens`, and `context_window.source` says which side
     * supplied it.
     */
    context_tokens: number | null;
    root: string;
  };
}

const STATUS_PROBE_TIMEOUT_MS = 5_000;

/** Never throws: every probe failure degrades to a reported field. */
export async function runStatus(config: Config, deps: ToolDeps = {}): Promise<StatusResult> {
  let reachable = true;
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
    context_window: (() => {
      const probed = pickLoadedContextTokens(loaded, autoSelection.model);
      const configured = config.contextTokens;
      // The SMALLER of the two, matching `resolveContextTokens`. A crash reloads
      // a model at its default context, so a configured value can be stale while
      // nobody touched it.
      const tokens =
        configured === null ? probed : probed === null ? configured : Math.min(configured, probed);
      return {
        tokens,
        source:
          configured !== null && probed !== null && configured !== probed
            ? ("disagreement" as const)
            : configured !== null
              ? ("config" as const)
              : probed !== null
                ? ("lms" as const)
                : ("unknown" as const),
        /** Both sides, so a disagreement can be read rather than inferred. */
        configured_tokens: configured,
        probed_tokens: probed,
        max_tokens:
          loaded?.find((m) => m.ids.some((id) => id === autoSelection.model))?.maxContextLength ??
          null,
      };
    })(),
    claude_md: getClaudeMdState(),
    config: {
      base_url: config.baseUrl,
      models_csv_path: config.modelsCsvPath,
      mem_fit_fraction: config.memFitFraction,
      temperature: config.temperature,
      max_output_tokens: config.maxOutputTokens,
      timeout_ms: config.timeoutMs,
      max_file_kb: config.maxFileKb,
      max_context_kb: config.maxContextKb,
      context_tokens: config.contextTokens,
      root: config.root,
    },
  };
  if (hint !== undefined) result.hint = hint;
  return result;
}
