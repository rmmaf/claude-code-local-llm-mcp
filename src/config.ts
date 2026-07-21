import { log } from "./logger.js";

export interface Config {
  /** Absolute path of the project root every relative path is resolved against. */
  root: string;
  /** OpenAI-compatible base URL, e.g. http://localhost:1234/v1 */
  baseUrl: string;
  modelSolo: string;
  modelIde: string;
  soloMinFreeGb: number;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  maxFileKb: number;
  maxContextKb: number;
}

export const DEFAULTS = {
  baseUrl: "http://localhost:1234/v1",
  modelSolo: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2",
  modelIde: "qwen2.5-coder-14b-instruct",
  soloMinFreeGb: 20,
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

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  root: string = process.cwd()
): Config {
  return {
    root,
    baseUrl: (env.LM_STUDIO_URL ?? DEFAULTS.baseUrl).replace(/\/+$/, ""),
    modelSolo: env.LOCAL_CODER_MODEL_SOLO ?? DEFAULTS.modelSolo,
    modelIde: env.LOCAL_CODER_MODEL_IDE ?? DEFAULTS.modelIde,
    soloMinFreeGb: numberFromEnv(env, "LOCAL_CODER_SOLO_MIN_FREE_GB", DEFAULTS.soloMinFreeGb),
    temperature: numberFromEnv(env, "LOCAL_CODER_TEMPERATURE", DEFAULTS.temperature, { allowZero: true }),
    maxOutputTokens: numberFromEnv(env, "LOCAL_CODER_MAX_OUTPUT_TOKENS", DEFAULTS.maxOutputTokens),
    timeoutMs: numberFromEnv(env, "LOCAL_CODER_TIMEOUT_MS", DEFAULTS.timeoutMs),
    maxFileKb: numberFromEnv(env, "LOCAL_CODER_MAX_FILE_KB", DEFAULTS.maxFileKb),
    maxContextKb: numberFromEnv(env, "LOCAL_CODER_MAX_CONTEXT_KB", DEFAULTS.maxContextKb),
  };
}
