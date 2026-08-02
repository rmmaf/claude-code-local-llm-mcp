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
}

export const DEFAULT_RATES: Rates = {
  multipliers: DEFAULT_MULTIPLIERS,
  models: {},
  charsPerToken: 3.7,
};

export const RATES_REL_PATH = path.join(".local-coder", "rates.json");

/** Resolve the effective multipliers for one model (global defaults + overrides). */
export function multipliersFor(rates: Rates, model: string): RateMultipliers {
  const override = rates.models[model]?.multipliers;
  return override ? { ...rates.multipliers, ...override } : rates.multipliers;
}

/** USD per million input tokens for a model, or null when not configured. */
export function inputPriceFor(rates: Rates, model: string): number | null {
  return rates.models[model]?.inputPerMTok ?? null;
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
  return {
    multipliers: mergeMultipliers(raw.multipliers),
    models: parseModels(raw.models),
    charsPerToken:
      typeof chars === "number" && Number.isFinite(chars) && chars > 0
        ? chars
        : DEFAULT_RATES.charsPerToken,
  };
}
