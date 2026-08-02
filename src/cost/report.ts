import { inputPriceFor, multipliersFor, type RateMultipliers, type Rates } from "./rates.js";
import type { BilledRequest, TokenUsage, ToolResultRecord, Transcript } from "./transcript.js";
import type { TelemetryRecord } from "../telemetry.js";

/** Cost of one token class, expressed as a multiple of the input token price. */
export interface CostUnits {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  total: number;
}

export interface CostBreakdown {
  tokens: TokenUsage;
  units: CostUnits;
  /** Fraction of `units.total` per class, 0–1. Sums to 1 (or all-zero). */
  share: Omit<CostUnits, "total">;
  /** USD, or null when no input price is configured for the model. */
  usd: number | null;
}

export interface GrowthPoint {
  index: number;
  /** Tokens re-read from cache on this request: the resident context size. */
  cacheRead: number;
  cumulativeUnits: number;
}

export interface ToolResultStats {
  calls: number;
  bytes: number;
}

export interface SessionReport {
  file: string;
  sessionId: string;
  models: string[];
  requests: number;
  mainThreadRequests: number;
  sidechainRequests: number;
  segments: number;
  breakdown: CostBreakdown;
  /** Per-request context size on the main thread — the quadratic term, plotted. */
  growth: GrowthPoint[];
  toolResultBytes: { total: number; byTool: Record<string, ToolResultStats> };
  skippedLines: number;
}

function zeroUsage(): TokenUsage {
  return { input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0 };
}

function addUsage(target: TokenUsage, source: TokenUsage): void {
  target.input += source.input;
  target.cacheWrite1h += source.cacheWrite1h;
  target.cacheWrite5m += source.cacheWrite5m;
  target.cacheRead += source.cacheRead;
  target.output += source.output;
}

/** Price one request's usage in input-equivalent units, per its model's rates. */
export function priceUsage(usage: TokenUsage, m: RateMultipliers): CostUnits {
  const input = usage.input * m.input;
  const cacheWrite = usage.cacheWrite1h * m.cacheWrite1h + usage.cacheWrite5m * m.cacheWrite5m;
  const cacheRead = usage.cacheRead * m.cacheRead;
  const output = usage.output * m.output;
  return { input, cacheWrite, cacheRead, output, total: input + cacheWrite + cacheRead + output };
}

function shareOf(units: CostUnits): Omit<CostUnits, "total"> {
  const t = units.total;
  if (t === 0) return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  return {
    input: units.input / t,
    cacheWrite: units.cacheWrite / t,
    cacheRead: units.cacheRead / t,
    output: units.output / t,
  };
}

/**
 * Aggregate a transcript into an absolute cost report.
 *
 * Requests are already deduplicated by requestId upstream; every figure here
 * is a direct sum of billed quantities, with no estimation anywhere.
 */
export function buildSessionReport(transcript: Transcript, rates: Rates): SessionReport {
  const tokens = zeroUsage();
  const units: CostUnits = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 };
  const models = new Set<string>();
  const segments = new Set<string>();
  let usd: number | null = null;
  let allPriced = true;

  for (const request of transcript.requests) {
    models.add(request.model);
    segments.add(`${request.thread}#${request.segment}`);
    addUsage(tokens, request.usage);

    const priced = priceUsage(request.usage, multipliersFor(rates, request.model));
    units.input += priced.input;
    units.cacheWrite += priced.cacheWrite;
    units.cacheRead += priced.cacheRead;
    units.output += priced.output;
    units.total += priced.total;

    // EVERY request must be priced, not any. A session that mixes a priced main
    // model with an unpriced subagent model would otherwise silently drop the
    // subagent's cost and present the remainder as the session total.
    const price = inputPriceFor(rates, request.model);
    if (price === null) allPriced = false;
    else usd = (usd ?? 0) + (priced.total * price) / 1_000_000;
  }
  if (!allPriced) usd = null;

  const growth: GrowthPoint[] = [];
  let cumulative = 0;
  for (const request of transcript.requests) {
    if (request.isSidechain) continue;
    cumulative += priceUsage(request.usage, multipliersFor(rates, request.model)).total;
    growth.push({ index: request.index, cacheRead: request.usage.cacheRead, cumulativeUnits: cumulative });
  }

  const byTool: Record<string, ToolResultStats> = {};
  let totalBytes = 0;
  for (const result of transcript.toolResults) {
    const key = result.name ?? "(unknown)";
    const entry = (byTool[key] ??= { calls: 0, bytes: 0 });
    entry.calls++;
    entry.bytes += result.bytes;
    totalBytes += result.bytes;
  }

  return {
    file: transcript.file,
    sessionId: transcript.sessionId,
    models: [...models].sort(),
    requests: transcript.requests.length,
    mainThreadRequests: transcript.requests.filter((r) => !r.isSidechain).length,
    sidechainRequests: transcript.requests.filter((r) => r.isSidechain).length,
    segments: segments.size,
    breakdown: { tokens, units, share: shareOf(units), usd },
    growth,
    toolResultBytes: { total: totalBytes, byTool },
    skippedLines: transcript.skippedLines,
  };
}

/**
 * What one token costs in total when it first enters the context at request `t`
 * of a segment that runs to `T`: paid once as a cache write, then re-read on
 * every later request in the same segment.
 *
 *   multiplier(t) = cacheWrite + cacheRead * (T - 1 - t)
 *
 * This is the whole architecture argument in one line. With T-t = 40 and 1h
 * caching it is 6.0x the input rate, which is why keeping a token OUT of the
 * context is worth far more than shortening the reply that mentions it.
 */
export function positionalMultiplier(t: number, T: number, m: RateMultipliers, ttl: "1h" | "5m" = "1h"): number {
  const write = ttl === "1h" ? m.cacheWrite1h : m.cacheWrite5m;
  return write + m.cacheRead * Math.max(0, T - 1 - t);
}

export interface ToolSaving {
  tool: string;
  calls: number;
  bytesSuppressed: number;
  turnsCollapsed: number;
  /** ESTIMATE — depends on rates.charsPerToken. */
  unitsFromSuppression: number;
  /** LOWER BOUND — counts only the re-read a collapsed turn would have caused. */
  unitsFromTurnCollapse: number;
  unitsTotal: number;
  usd: number | null;
  /** Telemetry entries that no billed request could be matched to. */
  unmatched: number;
}

export interface CounterfactualReport {
  byTool: ToolSaving[];
  unitsTotal: number;
  usdTotal: number | null;
  /** Session cost as billed, for the ratio that answers "did this pay?". */
  sessionUnits: number;
  /** Estimated fraction saved: saved / (billed + saved). */
  savedFraction: number;
  /** Telemetry rows whose invocation never appears in this transcript — another session's. */
  excludedForeign: number;
  /**
   * Rows carrying no invocation id. They are NOT counted: a tool that cannot
   * point at the transcript entry it produced cannot show its output ever
   * reached the context. The hook is the reason this rule exists — it claimed
   * 21,674 suppressed bytes on a replacement Claude Code discarded.
   */
  unverifiable: number;
  /** What those rows WOULD have added, so the exclusion is visible rather than silent. */
  unverifiableUnits: number;
  /**
   * True when this transcript DOES contain calls to our tools but none of their
   * results carry an `invocation_id`. That means the echo did not survive into
   * `toolUseResult`, not that every row belongs to someone else — so the exact
   * join is unavailable and everything here fell back to timestamps.
   */
  provenanceUnavailable: boolean;
}

/**
 * Was this result produced by one of THIS server's tools?
 *
 * The id is recovered by scanning the serialized tool result, so it can be found
 * in payloads that merely *quote* one: `.local-coder/telemetry.jsonl` carries an
 * `invocation_id` on every line, and a single `Read`, `Grep` or `cat` of that file
 * would otherwise mark every id in the project's whole history as belonging to
 * this session. Trusting an id only from a `gate`/`repair` result is what keeps
 * an echo distinguishable from a quotation.
 */
function isLocalToolResult(record: ToolResultRecord): boolean {
  return record.name !== null && /(^|__)(gate|repair)$/.test(record.name);
}

/**
 * Narrow the telemetry log to rows this session could plausibly own.
 *
 * The rule that matters: a row is admitted past the time window ONLY when this
 * transcript actually recorded its `invocation_id`. Admitting every id-bearing
 * row on the assumption that the join would drop the foreign ones is unsafe,
 * because the join can be unavailable (`provenanceUnavailable`) — and then the
 * entire telemetry history, every past session of this project, falls through to
 * the timestamp branch and gets attributed here. That inflates `savedFraction`,
 * which is B12, which is `G-stop`: the exact direction of error this meter
 * exists to prevent.
 *
 * Ids this transcript knows skip the window on purpose: the join is exact for
 * them, and a long-running `repair` can finish well after the last billed
 * request through no fault of its own.
 */
export function scopeTelemetry(
  transcript: Transcript,
  telemetry: TelemetryRecord[],
  windowMs = 60_000
): TelemetryRecord[] {
  const first = transcript.requests[0]?.timestampMs ?? 0;
  const last = transcript.requests[transcript.requests.length - 1]?.timestampMs ?? 0;
  const known = new Set(
    transcript.toolResults
      .filter(isLocalToolResult)
      .map((r) => r.invocationId)
      .filter((id): id is string => id !== null)
  );
  return telemetry.filter((entry) => {
    if (entry.invocation_id !== undefined && known.has(entry.invocation_id)) return true;
    const ts = Date.parse(entry.ts);
    return ts >= first - windowMs && ts <= last + windowMs;
  });
}

/**
 * Nearest billed request at or after `ts` **in the same thread** — the one that
 * pays to cache the result.
 *
 * The thread filter is load-bearing. A tool called by a subagent is cached into
 * that subagent's context, which has its own `T`; charging it to the next main
 * request applies the wrong positional multiplier to a saving that fed a
 * different conversation entirely.
 */
function requestAtOrAfter(requests: BilledRequest[], ts: number, thread: string): BilledRequest | null {
  let best: BilledRequest | null = null;
  for (const request of requests) {
    if (request.thread !== thread) continue;
    if (request.timestampMs < ts) continue;
    if (best === null || request.timestampMs < best.timestampMs) best = request;
  }
  return best;
}

/**
 * Join telemetry against the transcript to estimate what each tool saved.
 *
 * Deliberately conservative on both terms — an inflated saving here is exactly
 * the failure mode this whole meter exists to prevent.
 */
export function buildCounterfactual(
  transcript: Transcript,
  telemetry: TelemetryRecord[],
  rates: Rates,
  session: SessionReport
): CounterfactualReport {
  const byTool = new Map<string, ToolSaving>();

  // Exact provenance where we have it: our tools echo `invocation_id` in the
  // payload Claude Code stores as `toolUseResult`, so a row either belongs to
  // this transcript or it does not. Rows for a different session are dropped
  // rather than counted, which is what a timestamp window could never do.
  // Only OUR tools' results, for the same reason scopeTelemetry filters: a
  // payload that quotes an invocation id is not a payload that produced one.
  const localResults = transcript.toolResults.filter(isLocalToolResult);
  const byInvocation = new Map<string, ToolResultRecord>();
  for (const result of localResults) {
    if (result.invocationId !== null) byInvocation.set(result.invocationId, result);
  }

  // Guard against the join silently swallowing everything. That our tools'
  // `invocation_id` reaches the transcript inside `toolUseResult` is an
  // ASSUMPTION about how the client stores MCP results — see DECISIONS.md § v3.
  // If it is wrong, every row looks foreign and `savedFraction` collapses to 0
  // with no error: a confident, wrong number, which is the one outcome this
  // meter exists to prevent. So distinguish "no calls to our tools here" (rows
  // really are another session's) from "calls are here but carry no id" (the
  // echo is broken) and degrade loudly instead.
  const provenanceUnavailable = localResults.length > 0 && byInvocation.size === 0;

  let excludedForeign = 0;
  let unverifiable = 0;
  let unverifiableUnits = 0;
  /** Tools that matched at least one request whose model has no configured price. */
  const unpriced = new Set<string>();

  for (const entry of telemetry) {
    let ts: number;
    let thread: string;

    // No invocation id at all: this row cannot point at the transcript entry it
    // produced, so there is no way to show its output ever reached the context.
    // Such a saving is NOT counted. The hook is exactly why: it recorded 21,674
    // suppressed bytes for a replacement Claude Code discarded, and that phantom
    // went straight into savedFraction — the number behind B12 and G-stop.
    // Reported, with its magnitude, so the exclusion is visible and not silent.
    if (entry.invocation_id === undefined) {
      unverifiable++;
      const would = requestAtOrAfter(transcript.requests, Date.parse(entry.ts), "main");
      if (would !== null) {
        const wm = multipliersFor(rates, would.model);
        const wttl = would.usage.cacheWrite5m > would.usage.cacheWrite1h ? "5m" : "1h";
        const wmult = positionalMultiplier(would.index, would.segmentSize, wm, wttl);
        unverifiableUnits +=
          (Math.max(0, entry.bytes_raw - entry.bytes_returned) / rates.charsPerToken) * wmult +
          entry.turns_collapsed * would.usage.cacheRead * wm.cacheRead;
      }
      continue;
    }

    if (!provenanceUnavailable) {
      const source = byInvocation.get(entry.invocation_id);
      if (source === undefined) {
        // Another session on the same project. Counting it here would inflate
        // this session's saving and double-count it across reports.
        excludedForeign++;
        continue;
      }
      ts = source.timestampMs;
      thread = source.thread;
    } else {
      // The row HAS an id but no result in this transcript carries one, so the
      // echo itself is broken. Excluding everything here would collapse
      // savedFraction to a confident 0; `provenanceUnavailable` degrades loudly
      // instead, and the time join stands in.
      ts = Date.parse(entry.ts);
      thread = "main";
    }

    const saving = byTool.get(entry.tool) ?? {
      tool: entry.tool,
      calls: 0,
      bytesSuppressed: 0,
      turnsCollapsed: 0,
      unitsFromSuppression: 0,
      unitsFromTurnCollapse: 0,
      unitsTotal: 0,
      usd: null,
      unmatched: 0,
    };
    byTool.set(entry.tool, saving);
    saving.calls++;

    const request = requestAtOrAfter(transcript.requests, ts, thread);
    if (request === null) {
      saving.unmatched++;
      continue;
    }

    const m = multipliersFor(rates, request.model);
    const ttl = request.usage.cacheWrite5m > request.usage.cacheWrite1h ? "5m" : "1h";
    const multiplier = positionalMultiplier(request.index, request.segmentSize, m, ttl);

    const suppressed = Math.max(0, entry.bytes_raw - entry.bytes_returned);
    saving.bytesSuppressed += suppressed;
    saving.unitsFromSuppression += (suppressed / rates.charsPerToken) * multiplier;

    // A turn that did not happen is a whole context re-read that did not happen.
    // Counting only the re-read (not the output, nor the context the turn would
    // itself have added) keeps this a floor.
    saving.turnsCollapsed += entry.turns_collapsed;
    saving.unitsFromTurnCollapse += entry.turns_collapsed * request.usage.cacheRead * m.cacheRead;

    // Priced against the model of the request this saving was matched to, not
    // against whichever model in the session happened to have a price. A
    // subagent's call is worth its own model's rate, and if that model has no
    // price the tool's dollar figure is unknown rather than approximated.
    const entryUnits =
      (suppressed / rates.charsPerToken) * multiplier +
      entry.turns_collapsed * request.usage.cacheRead * m.cacheRead;
    const price = inputPriceFor(rates, request.model);
    if (price === null) unpriced.add(entry.tool);
    else saving.usd = (saving.usd ?? 0) + (entryUnits * price) / 1_000_000;
  }

  let unitsTotal = 0;
  for (const saving of byTool.values()) {
    saving.unitsTotal = saving.unitsFromSuppression + saving.unitsFromTurnCollapse;
    // One unpriced match makes the whole tool's dollar figure unknown; a partial
    // sum presented as a total is the same lie as a missing one.
    if (unpriced.has(saving.tool)) saving.usd = null;
    unitsTotal += saving.unitsTotal;
  }
  const savings = [...byTool.values()];
  const usdTotal =
    savings.length > 0 && savings.every((s) => s.usd !== null)
      ? savings.reduce((sum, s) => sum + (s.usd ?? 0), 0)
      : null;

  const sessionUnits = session.breakdown.units.total;
  const denominator = sessionUnits + unitsTotal;
  return {
    byTool: [...byTool.values()].sort((a, b) => b.unitsTotal - a.unitsTotal),
    unitsTotal,
    usdTotal,
    sessionUnits,
    savedFraction: denominator === 0 ? 0 : unitsTotal / denominator,
    excludedForeign,
    unverifiable,
    unverifiableUnits,
    provenanceUnavailable,
  };
}
