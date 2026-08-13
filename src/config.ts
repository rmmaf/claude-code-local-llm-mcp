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
  /**
   * Bytes of prompt per INPUT token, for the context pre-flight. Separate from
   * `outputBytesPerToken` on purpose, and the asymmetry is the point: that one
   * predicts how many tokens the model will EMIT — a guess about behaviour, kept
   * pessimistic because under-guessing means a truncation. This one counts tokens
   * in text that already exists, which is arithmetic and measurable.
   *
   * Reusing 3.5 here cost real coverage: applied to both sides of a shared
   * window its 20% pessimism compounds, and `run 2026-08-04-mac-16-preflight`
   * refused `src/fs-safety.ts` + `src/cost/transcript.ts` (26,345 B) — a request
   * measured at 11,237 actual tokens against ~14,745 usable, which had returned
   * every block complete three times.
   */
  inputBytesPerToken: number;
  /** Fraction of `maxOutputTokens` the estimate is allowed to fill (0, 1]. */
  outputUsableFraction: number;
  /**
   * The loaded model's context length in tokens, shared between input and
   * output — the constraint that actually bounds a whole-file answer. Null means
   * "probe `lms ps`", and a probe that cannot answer skips the check rather than
   * guessing, because this pre-flight REFUSES requests.
   *
   * Set it explicitly (`LOCAL_CODER_CONTEXT_TOKENS`) when `lms` is unavailable
   * or when several models are loaded, which is the case the probe declines.
   */
  contextTokens: number | null;
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
   * B16 is what re-derives this from the corpus rather than leaving it here.
   * The re-derivation now HAS a number — 3.978 measured B per output token over
   * the 36 complete responses of `run 2026-08-04-mac-12-variance` — and 3.5
   * stays anyway: re-fitting a constant on the corpus that measured it is what
   * corpus #1 was already caught doing.
   */
  outputBytesPerToken: 3.5,
  /**
   * 3.9, and the choice is measured rather than picked. Prompt density over the
   * 13 requests recorded in `evidence/2026-08-04-mac-11`, `-mac-12-variance` and
   * `-mac-13-repair-diff` climbs from 2.31 B/token at 1 KB to 4.11 at 36 KB —
   * small prompts are dominated by the fixed system-prompt overhead, large ones
   * approach the true density. Against `bytes / d + 200`, 3.9 is the LARGEST
   * divisor that never under-predicts a single one of those 13 measurements
   * (worst case −1.5%), while cutting the worst over-estimate from 20.5% at 3.5
   * to 9.3%. Under-predicting input is the unsafe direction: it lets a request
   * through that cannot fit, which is the failure this whole check exists for.
   */
  inputBytesPerToken: 3.9,
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
 * A number from the environment with no default: unset, blank or invalid all
 * yield null. Distinct from `numberFromEnv` because null is MEANINGFUL for the
 * context pre-flight — it selects "probe, and skip the check if the probe cannot
 * answer" rather than any particular size.
 */
function optionalNumberFromEnv(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    log.warn(`ignoring invalid ${name}=${JSON.stringify(raw)}; falling back to probing lms`);
    return null;
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
  if (["0", "false", "no"].includes(value)) return false;
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
    inputBytesPerToken: numberFromEnv(
      env,
      "LOCAL_CODER_INPUT_BYTES_PER_TOKEN",
      DEFAULTS.inputBytesPerToken
    ),
    outputUsableFraction: fractionFromEnv(
      env,
      "LOCAL_CODER_OUTPUT_USABLE_FRACTION",
      DEFAULTS.outputUsableFraction
    ),
    // No default: null means "probe", and the probe is allowed to decline.
    contextTokens: optionalNumberFromEnv(env, "LOCAL_CODER_CONTEXT_TOKENS"),
    autoClaudeMd: booleanFromEnv(env, "LOCAL_CODER_AUTO_CLAUDE_MD", DEFAULTS.autoClaudeMd),
  };
}
