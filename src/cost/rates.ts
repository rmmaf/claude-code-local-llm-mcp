import { promises as fs } from "node:fs";
import path from "node:path";

import { log } from "../logger.js";

/**
 * Price of each token class as a multiple of the model's INPUT token price.
 *
 * These ratios are structural — they come from how prompt caching is billed,
 * not from any one model's price sheet — so the whole cost argument rests on
 * them and stays valid when absolute prices move. The one number that does
 * move is `inputPerMTok`, which lives in ModelRate and starts unset.
 */
export interface RateMultipliers {
  /** Fresh (uncached) input. The unit everything else is expressed in. */
  input: number;
  /** Writing a token into the 1-hour cache. */
  cacheWrite1h: number;
  /** Writing a token into the 5-minute cache. */
  cacheWrite5m: number;
  /** Re-reading a cached token on every subsequent request. */
  cacheRead: number;
  /** Generating an output token. */
  output: number;
}

export const DEFAULT_MULTIPLIERS: RateMultipliers = {
  input: 1.0,
  cacheWrite1h: 2.0,
  cacheWrite5m: 1.25,
  cacheRead: 0.1,
  output: 5.0,
};

export interface ModelRate {
  /**
   * USD per million input tokens, or null when unknown. Null is the default on
   * purpose: a wrong hardcoded price silently corrupts every dollar figure,
   * while a missing one makes the report fall back to input-equivalent units,
   * which are exact and are what the architecture decision actually needs.
   */
  inputPerMTok: number | null;
  /** Per-model overrides, for the rare model that prices a class differently. */
  multipliers?: Partial<RateMultipliers>;
}

export interface Rates {
  multipliers: RateMultipliers;
  models: Record<string, ModelRate>;
  /**
   * Characters per token, used ONLY to turn measured byte counts (tool output
   * we suppressed) into an estimated token count. Every figure derived from it
   * is labeled an estimate; nothing in the absolute accounting touches it.
   */
  charsPerToken: number;
  /**
   * Characters of a tool result Claude Code will put in the context before it
   * truncates. The counterfactual's "without the tool" world runs the same
   * command through Bash, and THAT result is truncated too -- so a row may not
   * claim more suppressed bytes than could ever have arrived. Measured at 30,000
   * (B2, `run 2026-08-02-win-03`: a 30,136-character result stored as 30,000).
   * Vendor-internal and version-specific: B12 requires it re-measured on the
   * pinned build and recorded per run.
   */
  clientTruncationCap: number;
}

export const DEFAULT_RATES: Rates = {
  multipliers: DEFAULT_MULTIPLIERS,
  models: {},
  charsPerToken: 3.7,
  clientTruncationCap: 30_000,
};

export const RATES_REL_PATH = path.join(".local-coder", "rates.json");

/**
 * The key a request is priced under. Speed is part of the price, not a detail
 * of it: Claude Code's fast mode bills Opus at twice the standard rate while
 * reporting the same model string, so pricing on the model alone would halve
 * the total of any fast-mode session and blame the meter for the gap.
 *
 * Non-standard speeds get their own key ON PURPOSE. An unknown key resolves to
 * a null price, which makes the whole session unpriced rather than wrongly
 * priced — the same fail-closed choice as leaving `inputPerMTok` null.
 */
export function rateKey(model: string, speed: string | null): string {
  return speed === null || speed === "standard" ? model : `${model}${SPEED_SEPARATOR}${speed}`;
}

const SPEED_SEPARATOR = "@";

/**
 * The model a rate key is a speed variant of, or null when the key is a bare
 * model. (A Vertex dated-snapshot id such as `claude-opus-4-5@20251101` splits
 * here too. That is harmless and arguably right: the snapshot inherits the base
 * model's ratios, and its price is still looked up under the exact full key.)
 */
function baseModelOf(key: string): string | null {
  const at = key.indexOf(SPEED_SEPARATOR);
  return at <= 0 ? null : key.slice(0, at);
}

/**
 * Resolve the effective multipliers for one rate key: global defaults, then the
 * base model's overrides, then the speed variant's.
 *
 * **Multipliers layer across the speed suffix and the price deliberately does
 * not.** The ratios are structural — fast mode's $50/$10 output is still 5x
 * input — so an override a user set for a model holds at every speed, and
 * dropping it because the request happened to run fast would silently change
 * their cost model. The base price is the opposite: it doubles in fast mode, so
 * it must be stated per speed or left unknown (see `inputPriceFor`).
 */
export function multipliersFor(rates: Rates, key: string): RateMultipliers {
  const base = baseModelOf(key);
  const baseOverride = base === null ? undefined : rates.models[base]?.multipliers;
  const keyOverride = rates.models[key]?.multipliers;
  if (baseOverride === undefined && keyOverride === undefined) return rates.multipliers;
  return { ...rates.multipliers, ...baseOverride, ...keyOverride };
}

/**
 * USD per million input tokens for a rate key, or null when not configured.
 * No fall-back to the base model: a speed variant that is not priced is
 * unknown, never the standard rate — see `rateKey`.
 */
export function inputPriceFor(rates: Rates, key: string): number | null {
  return rates.models[key]?.inputPerMTok ?? null;
}

function mergeMultipliers(raw: unknown): RateMultipliers {
  if (raw === null || typeof raw !== "object") return DEFAULT_MULTIPLIERS;
  const merged = { ...DEFAULT_MULTIPLIERS };
  for (const key of Object.keys(DEFAULT_MULTIPLIERS) as Array<keyof RateMultipliers>) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) merged[key] = value;
  }
  return merged;
}

function parseModels(raw: unknown): Record<string, ModelRate> {
  if (raw === null || typeof raw !== "object") return {};
  const out: Record<string, ModelRate> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const price = entry.inputPerMTok;
    out[model] = {
      inputPerMTok: typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null,
      ...(entry.multipliers !== undefined
        ? { multipliers: mergeMultipliers(entry.multipliers) }
        : {}),
    };
  }
  return out;
}

/**
 * Load rates from `<root>/.local-coder/rates.json`, falling back to defaults.
 * A malformed or missing file is never fatal — the report degrades to
 * input-equivalent units rather than refusing to run.
 */
export async function loadRates(root: string): Promise<Rates> {
  const file = path.join(root, RATES_REL_PATH);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return DEFAULT_RATES;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    log.warn(`ignoring malformed ${RATES_REL_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    return DEFAULT_RATES;
  }
  if (parsed === null || typeof parsed !== "object") return DEFAULT_RATES;

  const raw = parsed as Record<string, unknown>;
  const chars = raw.charsPerToken;
  const cap = raw.clientTruncationCap;
  return {
    clientTruncationCap:
      typeof cap === "number" && Number.isFinite(cap) && cap > 0
        ? cap
        : DEFAULT_RATES.clientTruncationCap,
    multipliers: mergeMultipliers(raw.multipliers),
    models: parseModels(raw.models),
    charsPerToken:
      typeof chars === "number" && Number.isFinite(chars) && chars > 0
        ? chars
        : DEFAULT_RATES.charsPerToken,
  };
}
