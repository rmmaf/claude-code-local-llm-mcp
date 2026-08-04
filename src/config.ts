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
  /**
   * Bytes of source per output token, for the pre-flight that refuses a request
   * whose whole-file answer would not fit in `maxOutputTokens`. An estimate, and
   * labelled as one — see `enforceOutputCap`.
   */
  outputBytesPerToken: number;
  /** Fraction of `maxOutputTokens` the estimate is allowed to fill (0, 1]. */
  outputUsableFraction: number;
  /**
   * Whether the server writes its delegation policy into the project's
   * `CLAUDE.md` at startup. On by default: `README.md` has told every user to
   * add that block by hand since the first release, and `run 2026-08-04-mac-10`
   * is what happens when nobody does — 36 Bash verifications, 0 `gate` calls,
   * against a routing rule that existed only in documentation.
   */
  autoClaudeMd: boolean;
}

export const DEFAULTS = {
  baseUrl: "http://localhost:1234/v1",
  memFitFraction: 0.85,
  temperature: 0.1,
  maxOutputTokens: 8192,
  timeoutMs: 300_000,
  maxFileKb: 256,
  maxContextKb: 512,
  /**
   * 3.5 is not a guess: it is the divisor at which the estimate reproduces the
   * only truncation this project has actually observed. `src/selection.ts` plus
   * `tests/selection.test.ts` — the request of `run 2026-08-03-mac-05` — comes
   * to 8882 tokens against a 8192 cap, so the pre-flight would have refused it.
   * B14 is what re-derives this from the corpus rather than leaving it here.
   */
  outputBytesPerToken: 3.5,
  /**
   * Headroom for the `<file>` wrapper and for the estimator's own error. It
   * costs coverage on purpose: at 0.9 the bar is 7372 tokens, which also refuses
   * `src/tools/gate.ts` + its test (8075). Letting a truncation through is the
   * more expensive mistake — it is the one that makes `model_failed` ambiguous
   * and B6 unmeasurable, which is the whole reason this cap exists.
   */
  outputUsableFraction: 0.9,
  autoClaudeMd: true,
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
 * A flag from the environment. Accepts the spellings people actually type —
 * `0/1`, `false/true`, `no/yes`, `off/on`, any case — and warns rather than
 * guessing on anything else, because a typo silently disabling a side effect
 * is worse than a typo that is ignored loudly.
 */
function booleanFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  log.warn(`ignoring invalid ${name}=${JSON.stringify(raw)}; using default ${fallback}`);
  return fallback;
}

/** A fraction in (0, 1]: reuses numberFromEnv (finite, > 0) then clamps anything above 1 down to 1. */
function fractionFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = numberFromEnv(env, name, fallback);
  if (value > 1) {
    log.warn(`clamping ${name}=${value} to 1 (must be in (0, 1])`);
    return 1;
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
    memFitFraction: fractionFromEnv(env, "LOCAL_CODER_MEM_FIT_FRACTION", DEFAULTS.memFitFraction),
    models: [],
    temperature: numberFromEnv(env, "LOCAL_CODER_TEMPERATURE", DEFAULTS.temperature, { allowZero: true }),
    maxOutputTokens: numberFromEnv(env, "LOCAL_CODER_MAX_OUTPUT_TOKENS", DEFAULTS.maxOutputTokens),
    timeoutMs: numberFromEnv(env, "LOCAL_CODER_TIMEOUT_MS", DEFAULTS.timeoutMs),
    maxFileKb: numberFromEnv(env, "LOCAL_CODER_MAX_FILE_KB", DEFAULTS.maxFileKb),
    maxContextKb: numberFromEnv(env, "LOCAL_CODER_MAX_CONTEXT_KB", DEFAULTS.maxContextKb),
    outputBytesPerToken: numberFromEnv(
      env,
      "LOCAL_CODER_OUTPUT_BYTES_PER_TOKEN",
      DEFAULTS.outputBytesPerToken
    ),
    outputUsableFraction: fractionFromEnv(
      env,
      "LOCAL_CODER_OUTPUT_USABLE_FRACTION",
      DEFAULTS.outputUsableFraction
    ),
    autoClaudeMd: booleanFromEnv(env, "LOCAL_CODER_AUTO_CLAUDE_MD", DEFAULTS.autoClaudeMd),
  };
}
