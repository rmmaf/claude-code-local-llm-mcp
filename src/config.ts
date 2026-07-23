import path from "node:path";

import { log } from "./logger.js";
import type { ModelEntry } from "./models-csv.js";

export interface Config {
  /** Absolute path of the project root every relative path is resolved against. */
  root: string;
  /** OpenAI-compatible base URL, e.g. http://localhost:1234/v1 */
  baseUrl: string;
  /** Path to the models catalog CSV, or null to use the built-in default catalog. */
  modelsCsvPath: string | null;
  /** Fraction of free RAM a model's on-disk size may occupy to count as "fits" (0–1). */
  memFitFraction: number;
  /** The model catalog (model + objective). Filled from the CSV after loadConfig. */
  models: ModelEntry[];
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  maxFileKb: number;
  maxContextKb: number;
}

export const DEFAULTS = {
  baseUrl: "http://localhost:1234/v1",
  memFitFraction: 0.85,
  temperature: 0.1,
  maxOutputTokens: 8192,
  timeoutMs: 300_000,
  maxFileKb: 256,
  maxContextKb: 512,
} as const;

function numberFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  options: { allowZero?: boolean } = {}
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  const min = options.allowZero ? 0 : Number.MIN_VALUE;
  if (!Number.isFinite(value) || value < min) {
    log.warn(`ignoring invalid ${name}=${JSON.stringify(raw)}; using default ${fallback}`);
    return fallback;
  }
  return value;
}

/**
 * Load configuration from the environment. `models` is left empty here — the
 * server (and smoke test) fill it via loadModelCatalog(config.modelsCsvPath)
 * after load, so loadConfig stays synchronous and file-free for unit tests.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  root: string = process.cwd()
): Config {
  const rawCsv = env.LOCAL_CODER_MODELS_CSV;
  const modelsCsvPath =
    rawCsv === undefined || rawCsv.trim() === ""
      ? null
      : path.isAbsolute(rawCsv)
        ? rawCsv
        : path.resolve(root, rawCsv);

  return {
    root,
    baseUrl: (env.LM_STUDIO_URL ?? DEFAULTS.baseUrl).replace(/\/+$/, ""),
    modelsCsvPath,
    memFitFraction: numberFromEnv(env, "LOCAL_CODER_MEM_FIT_FRACTION", DEFAULTS.memFitFraction),
    models: [],
    temperature: numberFromEnv(env, "LOCAL_CODER_TEMPERATURE", DEFAULTS.temperature, { allowZero: true }),
    maxOutputTokens: numberFromEnv(env, "LOCAL_CODER_MAX_OUTPUT_TOKENS", DEFAULTS.maxOutputTokens),
    timeoutMs: numberFromEnv(env, "LOCAL_CODER_TIMEOUT_MS", DEFAULTS.timeoutMs),
    maxFileKb: numberFromEnv(env, "LOCAL_CODER_MAX_FILE_KB", DEFAULTS.maxFileKb),
    maxContextKb: numberFromEnv(env, "LOCAL_CODER_MAX_CONTEXT_KB", DEFAULTS.maxContextKb),
  };
}
