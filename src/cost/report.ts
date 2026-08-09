import { inputPriceFor, multipliersFor, rateKey, type RateMultipliers, type Rates } from "./rates.js";
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
  /**
   * The rate keys that had no `inputPerMTok` — exactly why `usd` is null, and
   * exactly what to add to `rates.json`. A key may carry a speed suffix
   * (`model@fast`), so naming the bare model here would send the reader to a
   * line that is already filled in.
   */
  unpricedKeys: string[];
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
  /**
   * EVERY file the session was read from. A session is the main transcript plus
   * whatever sits under `<sessionId>/`, so one path can no longer describe what
   * was counted -- and `B20` requires the evidence artifact to say which files a
   * number came from, because "44 main, 0 subagent" read as a measurement for
   * four days while it was a gap.
   */
  files: string[];
  /**
   * RECORDS admitted carrying no uuid, so nothing could de-duplicate them. The
   * unit is records; `requests` are `requestId` groups. **Neither bounds the
   * other** — 3 against 1 request on one fixture, 2 against 4 on another — so
   * the two are not comparable. See `Transcript` for why it counts records.
   */
  admittedWithoutUuid: number;
  /** What the admission rule threw away. A zero here is never ambiguous. */
  excluded: { duplicateUuid: number; apiError: number; foreignSession: number; noSessionId: number };
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
 * The billed cost of a SUBSET of a transcript's requests, named by `requestId`.
 *
 * `SessionReport.breakdown` is whole-session, and B12's unit of observation is a
 * task window inside one. A window's own cost cannot be read off a session
 * total: 28.1% of this project's billed requests live in two or more session
 * files, and per session the inherited share runs 1% to 100%, so a session total
 * is partly another conversation's cost (`ROADMAP.md` G1, narrowed 2026-08-05).
 *
 * Pass `requestIds` to restrict; omit it for the whole session. `buildSessionReport`
 * calls this with nothing so that the subset and the whole are priced by ONE
 * implementation -- pricing a window by a second copy of this arithmetic is how
 * the two sides of B20 drifted apart four times.
 */
export function breakdownOfRequests(
  requests: readonly BilledRequest[],
  rates: Rates,
  requestIds?: ReadonlySet<string>
): CostBreakdown {
  const tokens = zeroUsage();
  const units: CostUnits = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 };
  let usd: number | null = null;
  let allPriced = true;
  const unpricedKeys = new Set<string>();

  for (const request of requests) {
    if (requestIds !== undefined && !requestIds.has(request.requestId)) continue;
    addUsage(tokens, request.usage);
    const key = rateKey(request.model, request.speed);
    const priced = priceUsage(request.usage, multipliersFor(rates, key));
    units.input += priced.input;
    units.cacheWrite += priced.cacheWrite;
    units.cacheRead += priced.cacheRead;
    units.output += priced.output;
    units.total += priced.total;
    const price = inputPriceFor(rates, key);
    if (price === null) {
      allPriced = false;
      unpricedKeys.add(key);
    } else usd = (usd ?? 0) + (priced.total * price) / 1_000_000;
  }
  if (!allPriced) usd = null;
  return { tokens, units, share: shareOf(units), usd, unpricedKeys: [...unpricedKeys].sort() };
}

/**
 * Aggregate a transcript into an absolute cost report.
 *
 * Requests are already deduplicated by requestId upstream; every figure here
 * is a direct sum of billed quantities, with no estimation anywhere.
 */
export function buildSessionReport(transcript: Transcript, rates: Rates): SessionReport {
  const models = new Set<string>();
  const segments = new Set<string>();

  for (const request of transcript.requests) {
    models.add(request.model);
    segments.add(`${request.thread}#${request.segment}`);
  }
  // EVERY request must be priced, not any -- a session mixing a priced main
  // model with an unpriced subagent model would otherwise drop the subagent's
  // cost and present the remainder as the total. That rule lives in
  // `breakdownOfRequests` and is applied here by calling it, not by repeating it.
  const breakdown = breakdownOfRequests(transcript.requests, rates);

  const growth: GrowthPoint[] = [];
  let cumulative = 0;
  for (const request of transcript.requests) {
    if (request.isSidechain) continue;
    cumulative += priceUsage(request.usage, multipliersFor(rates, rateKey(request.model, request.speed))).total;
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
    files: transcript.files,
    admittedWithoutUuid: transcript.admittedWithoutUuid,
    excluded: transcript.excluded,
    sessionId: transcript.sessionId,
    models: [...models].sort(),
    requests: transcript.requests.length,
    mainThreadRequests: transcript.requests.filter((r) => !r.isSidechain).length,
    sidechainRequests: transcript.requests.filter((r) => r.isSidechain).length,
    segments: segments.size,
    breakdown,
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
 * This is the whole architecture argument in one line. With t = 0, T = 41 and 1h
 * caching it is 6.0x the input rate — 2.0 + 0.1 x 40, the case `cost-meter.test.ts`
 * pins — which is why keeping a token OUT of the context is worth far more than
 * shortening the reply that mentions it.
 */
export function positionalMultiplier(t: number, T: number, m: RateMultipliers, ttl: "1h" | "5m" = "1h"): number {
  return writeComponent(m, ttl) + m.cacheRead * Math.max(0, T - 1 - t);
}

/**
 * The write half of the multiplier alone — B12's low horizon, `T-1-t = 0`.
 *
 * Its own function rather than `positionalMultiplier(0, 1, m, ttl)`, which is
 * the same number for every rate table this project will load and NOT the same
 * expression: that spelling reaches the low horizon through `cacheRead * 0`, so
 * a `cacheRead` of `NaN` or `Infinity` makes the write component `NaN` while
 * this returns the rate. One spelling, in one place, and no arithmetic between
 * the caller and the answer.
 */
export function writeComponent(m: RateMultipliers, ttl: "1h" | "5m"): number {
  return ttl === "1h" ? m.cacheWrite1h : m.cacheWrite5m;
}

export interface EntryCost {
  /**
   * Total multiple of THE input rate — null when the segment does not have one.
   * Every multiplier is a ratio to its own key's input price, so summing across
   * keys priced differently adds quantities with different bases. Two keys that
   * happen to share a price are fine; two keys at $1 and $2 are not.
   */
  multiplier: number | null;
  /** The write component at turn 0's rate. Null when `multiplier` is. */
  write: number | null;
  /** Sum of the later requests' cache-read multipliers. Null when `multiplier` is. */
  reread: number | null;
  /**
   * USD per million tokens entering at turn 0 — dimensionally sound whatever
   * the segment mixes, because each term is multiplied by its own key's price
   * before being summed. Null when any key in the segment has no price.
   */
  usdPerMTok: number | null;
  ttl: "1h" | "5m";
  requests: number;
  /** Distinct rate keys in the segment, sorted. More than one means mixed. */
  keys: string[];
  /** The subset of `keys` with no `inputPerMTok`. */
  unpricedKeys: string[];
  /**
   * Whether the segment has one input rate for a multiplier to be a multiple
   * of. Three states, and the third is not the second:
   *
   * - `true`  — one key, or every price known and equal. `multiplier` is set.
   * - `false` — two known prices differ. Settled by the prices we DO have, so
   *             a missing third price cannot overturn it.
   * - `null`  — genuinely unknown: the known prices do not settle it and at
   *             least one key is unpriced. Two unpriced keys may share a price.
   *
   * Callers must not print `null` as "priced differently"; that asserts a fact
   * the rates file does not contain.
   */
  sharesOneInputRate: boolean | null;
}

/**
 * The exact cost of a token entering at turn 0 of one segment: the cache write
 * at that first request's own rate and TTL, plus **each later request's own**
 * cache-read rate.
 *
 * `positionalMultiplier` assumes a single rate for the whole segment. That is
 * right for stating the model and wrong for measuring a real session: `/model`
 * and `/fast` are both togglable mid-segment, and once either is, every re-read
 * after the switch was being priced at the pre-switch rate — with the TTL taken
 * from turn 0 alone. Summing per request costs nothing and cannot drift.
 */
export function entryCostOfSegment(segment: readonly BilledRequest[], rates: Rates): EntryCost | null {
  const ordered = [...segment].sort((a, b) => a.index - b.index);
  const first = ordered[0];
  if (first === undefined) return null;

  const firstKey = rateKey(first.model, first.speed);
  const firstM = multipliersFor(rates, firstKey);
  const ttl: "1h" | "5m" = first.usage.cacheWrite5m > first.usage.cacheWrite1h ? "5m" : "1h";
  const writeRatio = ttl === "1h" ? firstM.cacheWrite1h : firstM.cacheWrite5m;
  const firstPrice = inputPriceFor(rates, firstKey);

  const keys = new Set<string>([firstKey]);
  const prices = new Set<number | null>([firstPrice]);
  const unpricedKeys = new Set<string>(firstPrice === null ? [firstKey] : []);
  let rereadRatio = 0;
  let usd = firstPrice === null ? null : (writeRatio * firstPrice) / 1_000_000;
  for (const request of ordered) {
    if (request.index === first.index) continue; // turn 0 pays the write, not a re-read of itself
    const key = rateKey(request.model, request.speed);
    keys.add(key);
    const price = inputPriceFor(rates, key);
    prices.add(price);
    const cacheRead = multipliersFor(rates, key).cacheRead;
    rereadRatio += cacheRead;
    // Each term meets its own key's price BEFORE being summed. That is what
    // makes this figure valid across a mixed segment and the ratio not.
    if (price === null) {
      usd = null;
      unpricedKeys.add(key);
    } else if (usd !== null) usd += (cacheRead * price) / 1_000_000;
  }

  // A ratio needs one base. One key is trivially one base even when unpriced;
  // several keys need identical, known prices before their ratios can be added.
  // Two KNOWN prices that differ settle the question on their own — a further
  // missing price cannot make unequal prices equal, so that case is `false`,
  // not `null`.
  const known = new Set([...prices].filter((p): p is number => p !== null));
  const oneBase = keys.size === 1 || (!prices.has(null) && prices.size === 1);
  const sharesOneInputRate = oneBase ? true : known.size > 1 ? false : null;
  return {
    multiplier: oneBase ? writeRatio + rereadRatio : null,
    write: oneBase ? writeRatio : null,
    reread: oneBase ? rereadRatio : null,
    sharesOneInputRate,
    usdPerMTok: usd === null ? null : usd * 1_000_000,
    ttl,
    requests: ordered.length,
    keys: [...keys].sort(),
    unpricedKeys: [...unpricedKeys].sort(),
  };
}

/**
 * One quantity in the three forms a reader needs to tell a measurement from a
 * modelling choice.
 *
 * `clampedUncapped` is what shipped: `max(0, raw - returned)` with no ceiling.
 * It is kept for display and **B12 may not consume it**, because both of its
 * adjustments push the same way. `signedUncapped` keeps a call that ADDED bytes
 * as the negative it is — measured here: a `gate` returning 1,205 bytes against
 * 431 raw, and `run 2026-08-04-mac-09` where tsc-gated `repair` was net negative
 * 12 of 12. `signedCapped` also refuses to credit bytes that could never have
 * entered a context in the counterfactual world, since Claude Code truncates a
 * tool result at `clientTruncationCap` characters (B2, `run 2026-08-02-win-03`:
 * 30,136 raw arrived as 30,000).
 */
export interface SuppressionVariants {
  clampedUncapped: number;
  signedUncapped: number;
  signedCapped: number;
}

export interface ToolSaving {
  tool: string;
  calls: number;
  /** Bytes, in all three forms. `clampedUncapped` is the shipped display figure. */
  bytes: SuppressionVariants;
  /** ESTIMATE — depends on rates.charsPerToken. Same three forms. */
  unitsFromSuppression: SuppressionVariants;
  turnsCollapsed: number;
  /**
   * REPORTED, AND IN NO SCORED NUMBER. `turns_collapsed` is a caller argument --
   * `gate` writes `selected.length - 1` where `selected` depends on the
   * `category` the caller passed, and `repair` writes `rounds.length` whether or
   * not it closed the failure. Worse, this term multiplies that self-declared
   * count by the accumulated context while the denominator counts that same
   * cache read once, so padding the context before a collapsing call raises the
   * numerator faster than the denominator. A term set by a string in a tool call
   * is not a measurement, so it sits beside the total rather than inside it.
   */
  unitsFromTurnCollapse: number;
  /** SCORED: `unitsFromSuppression.signedCapped`. Turn collapse is not in here. */
  unitsTotal: number;
  usd: number | null;
  /** Telemetry entries that no billed request could be matched to. */
  unmatched: number;
  /** Calls that returned MORE bytes than the operation produced. */
  rowsNetNegative: number;
}

/**
 * A refused class's magnitude, in the only shape that cannot lie about itself.
 *
 * `units` is the sum of the refusals that COULD be sized, and never contains a
 * zero standing in for one that could not. `unsized` counts those, so `units` is
 * a FLOOR whenever it is non-zero. A single scalar cannot express "about 500k,
 * plus some unknown amount", and this file already learned one level up that a
 * number which cannot say it is incomplete gets read as if it were complete.
 */
export interface RefusedMagnitude {
  units: number;
  unsized: number;
}

/** Why a row is in the ledger. The four refusal names are the ones B12 scores by. */
export type RowDisposition =
  | "credited"
  | "ambiguous"
  | "unverifiable"
  | "excludedForeign"
  | "unmatched";

/**
 * One telemetry row as the join saw it, credited or refused. **A UNION
 * DISCRIMINATED ON `disposition`**, and the name is legacy: it holds refused
 * rows too, as the two arms below say.
 *
 * ONE ARRAY RATHER THAN TWO DERIVATIONS. The aggregates above answer "how much,
 * per tool"; this answers "which rows, and what happened to each". A consumer
 * that has to re-derive the second from the first is the shape this file has
 * already been burned by — two numbers from one rule drift apart.
 *
 * THE UNION IS AN ENFORCEMENT, NOT A TIDY-UP. Flat, with every field nullable,
 * the contract below lived in this comment: `disposition === "credited"` narrowed
 * nothing, so `row.units ?? 0` compiled, passed every oracle in the repository,
 * and summed an unknown as zero — the one collapse this scorer forbids
 * everywhere else. Do not flatten it back to make a literal easier to write.
 *
 * The positional fields are populated for `credited` rows and are `null` on a
 * refusal, because a refused row was not credited AGAINST a request — it has no
 * position of its own. This is not the same as there being no request anywhere:
 * `wouldHaveAdded` ATTEMPTS to select a counterfactual one for three of the four
 * classes in order to size them, and when it succeeds those fields are discarded
 * rather than absent. It can also fail — any of the three can lack a later
 * same-thread request and come back `null`. Only `unmatched` is unsized BY
 * CONSTRUCTION, because there the missing request is the definition of the class.
 *
 * `units` carries the scored contribution of a credited row and the would-have
 * magnitude of a refused one, and it is `null` when nothing could size it —
 * which is not zero and may not be summed as one.
 *
 * `units` and `unitsLo` are the same row at B12's two horizons, and they are
 * `null` TOGETHER. Both live here rather than being recomputed downstream
 * because the scorer's `aggregate.ts` receives no `rates` and could not derive
 * the second — and because two derivations of one number is the shape this file
 * has already been burned by.
 */
interface LedgerRowCommon {
  invocationId: string | null;
  tool: string;
  ts: string;
  bytesRaw: number;
  bytesReturned: number;
  /** `raw - returned`, unclamped and uncapped. */
  signed: number;
  /** `min(raw, clientTruncationCap) - returned`. THE SCORED FORM. */
  capped: number;
  /** Reported here, in no scored total — see `ToolSaving.unitsFromTurnCollapse`. */
  turnsCollapsed: number;
  /**
   * The tool's own verdict, from `detail.passed`, or `null` when the row does
   * not carry a boolean one. **`null` is not `false`** — see `verdictOf`.
   * B12's `MIN_REPAIR_CLOSURES` is counted off this, because `turnsCollapsed` is
   * `rounds.length` whether or not the failure closed.
   *
   * On BOTH arms, because a refused row's tool still ran and still reported.
   */
  passed: boolean | null;
}

/**
 * A row the join credited. Every positional field and both magnitudes are
 * NON-NULL here, and that is the whole point of the split: `disposition ===
 * "credited"` narrows them, so a consumer summing `row.units` cannot reach for
 * `?? 0` and cannot be tempted to.
 */
export interface CreditedLedgerRow extends LedgerRowCommon {
  disposition: "credited";
  thread: string;
  /** `t` in `positionalMultiplier(t, T)`. */
  index: number;
  /** `T` in `positionalMultiplier(t, T)`. */
  segmentSize: number;
  ttl: "1h" | "5m";
  multiplier: number;
  rateKey: string;
  /** The scored contribution at the observed segment. */
  units: number;
  /**
   * The same row at `T-1-t = 0` — the write component alone, B12's `S_lo`.
   *
   * Separate from `units` because the two horizons rank rows DIFFERENTLY, and
   * B12's `R_lo⁻ʳ` drops the low figure's own biggest row rather than the high
   * figure's. One field for both would have made the low-side concentration
   * guard a statement about the high side.
   */
  unitsLo: number;
  /**
   * `units` with NO `clientTruncationCap` — the signed magnitude priced whole.
   *
   * B12's voidConditions 8 requires the artifact to carry an uncapped bracket
   * BESIDE the capped one, and the bracket has to be summed from rows priced
   * without the cap — not reconstructed from byte totals after the fact. Same
   * `signed`, same multiplier; only the `Math.min(bytes_raw, cap)` is absent.
   */
  unitsUncapped: number;
  /** `unitsLo` without the cap — the uncapped row at `T-1-t = 0`. */
  unitsLoUncapped: number;
}

/**
 * A row the join refused, in one of the four classes. The positional fields are
 * `null` because the row was not credited against a request, and the two
 * magnitudes are `null` TOGETHER when nothing could size it.
 */
export interface RefusedLedgerRow extends LedgerRowCommon {
  disposition: Exclude<RowDisposition, "credited">;
  thread: null;
  index: null;
  segmentSize: null;
  ttl: null;
  multiplier: null;
  rateKey: null;
  /** The would-have magnitude, or `null` when nothing could size it. */
  units: number | null;
  /** The same, at `T-1-t = 0`. `null` exactly when `units` is. */
  unitsLo: number | null;
}

export type CreditedRow = CreditedLedgerRow | RefusedLedgerRow;

/** `Assert<false>` does not satisfy the constraint, so it is a `tsc` error. */
type Assert<T extends true> = T;

/**
 * THE CONTROL FOR THE UNION, BESIDE THE UNION.
 *
 * Widen either magnitude on the credited arm and these two stop compiling. That
 * is the whole of the enforcement: the invariant used to live in a doc comment,
 * where `row.units ?? 0` could ignore it silently.
 *
 * It was written here because when the union landed, `tsconfig.json` covered
 * `src/**` alone and an assertion in `tests/` would have been read by no
 * compiler — the hole is closed now (`tests/**` is in the config), but the
 * assertion still belongs next to the type it constrains rather than in a file
 * that happens to import it.
 */
type _CreditedUnitsNonNull = Assert<null extends CreditedLedgerRow["units"] ? false : true>;
type _CreditedUnitsLoNonNull = Assert<null extends CreditedLedgerRow["unitsLo"] ? false : true>;

export interface CounterfactualReport {
  byTool: ToolSaving[];
  unitsTotal: number;
  usdTotal: number | null;
  /** Session cost as billed, for the ratio that answers "did this pay?". */
  sessionUnits: number;
  /**
   * Estimated fraction saved: saved / (billed + saved).
   *
   * **`null` means WITHHELD, not zero.** It is withheld whenever the exact join
   * is unavailable and the timestamp fallback is doing the work, on the same
   * principle as session USD being withheld unless every model is priced: a
   * confident number below `G-stop`'s 15% would read as a decision to stop the
   * project, and this is the one direction of error the meter exists to prevent.
   */
  savedFraction: number | null;
  /**
   * Telemetry rows whose invocation is absent from `byInvocation` — usually
   * another session's.
   *
   * "Absent from this transcript" is the shorthand and it is not exact:
   * `byInvocation` is built from `toolResults.filter(isLocalToolResult)`, so a
   * row whose id appears ONLY inside some other tool's serialised output lands
   * here too. The distinction matters to B12, whose window join reads every
   * `toolResult` and not just the local ones.
   */
  excludedForeign: number;
  /**
   * What those rows WOULD have added. This class shipped as a bare counter while
   * the other three carried magnitudes, which made `R_hi+` — the doubt-credited
   * figure on B12's FALL side, defined over ALL FOUR classes — uncomputable as
   * written. Sized by the timestamp fallback, exactly as the `provenance`
   * degraded path is, and `unsized` when no request follows.
   */
  excludedForeignUnits: RefusedMagnitude;
  /**
   * Rows whose invocation id appears in MORE THAN ONE session, so no session can
   * claim them. An `invocation_id` is call identity; it was being used as
   * session ownership, and those are not the same thing. Claude Code writes a
   * resumed or forked conversation's inherited records into the new session
   * file, so one `gate` result physically exists in every descendant — measured
   * here: one id in four transcripts, its saving credited four times, 21 rows on
   * disk against 24 calls attributed.
   *
   * The server cannot stamp a session id at write time (it is never told one),
   * so ownership is resolved on the read side by whoever can see the whole
   * session set. When nobody can, these rows are refused rather than guessed.
   */
  ambiguous: number;
  /** What those rows WOULD have added, so the refusal is visible rather than silent. */
  ambiguousUnits: RefusedMagnitude;
  /**
   * Rows whose id IS this transcript's but which no billed request follows in
   * the calling thread. They deflate the numerator exactly like a refusal, so
   * they belong in the ledger with the other three rather than only inside a
   * per-tool counter. Their magnitude is `unsized` by construction: the missing
   * request is precisely what a magnitude would have been computed from.
   */
  unmatched: number;
  unmatchedUnits: RefusedMagnitude;

  /**
   * EVERY row the join refused, in one number. It exists because `ambiguous` was
   * added as a third refusal class and wired into only one of the three places
   * that reason about refusals: the line that prints it. The gate deciding
   * whether to print anything still summed the original two, so a session whose
   * only telemetry was refused as ambiguous printed NOTHING, and the fraction
   * still summarised as a confident 0.
   *
   * Counting a set in each consumer is how a fourth class will be missed too.
   * Consumers ask this, never the parts.
   */
  refusedRows: number;
  /**
   * EVERY row the join saw, credited and refused alike, in read order.
   *
   * The aggregates above answer "how much, per tool". This answers "which rows,
   * and what happened to each" — which B12 needs because its unit is a TASK
   * WINDOW, not a session, and a window cannot be scored by shortening the
   * transcript: `positionalMultiplier` reads `t` and `T` off the full segment,
   * so a shortened one deflates the deciding number by about an order of
   * magnitude in the direction that stops the project. Meter the whole lineage,
   * then select rows.
   */
  rows: CreditedRow[];
  /**
   * Rows carrying no invocation id. They are NOT counted: a tool that cannot
   * point at the transcript entry it produced cannot show its output ever
   * reached the context. The hook is the reason this rule exists — it claimed
   * 21,674 suppressed bytes on a replacement Claude Code discarded.
   */
  unverifiable: number;
  /** What those rows WOULD have added, so the exclusion is visible rather than silent. */
  unverifiableUnits: RefusedMagnitude;
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
 * would otherwise mark an id from the project's history as belonging to this
 * session. Trusting an id only from a `gate`/`repair` result is what keeps an
 * echo distinguishable from a quotation. (One id, not every id: `readInvocationId`
 * runs a single non-global `exec` and returns the FIRST match, so a quotation
 * injects one id per result — which is enough to misattribute a saving.)
 *
 * EXPORTED FOR `b12/terms.ts`, which was not applying it and had to. `mine` was
 * built from every tool result while `byInvocation` was built from these, so the
 * window join was strictly wider than the crediting join and a window could claim
 * an id that is not this server's at all (`FINDINGS.md` F10). One predicate in one
 * place is the only version of this that stays true.
 */
export function isLocalToolResult(record: ToolResultRecord): boolean {
  return record.name !== null && /(^|__)(gate|repair)$/.test(record.name);
}

/**
 * Invocation ids carried by more than one session, which therefore belong to
 * none of them.
 *
 * This exists at all because an `invocation_id` is CALL identity and the join
 * was using it as SESSION OWNERSHIP. Claude Code writes a resumed or forked
 * conversation's inherited records into the new session file, so one `gate`
 * result is physically present in every descendant and every descendant's join
 * matches it. Measured on this project: one id in four transcripts, credited
 * four times — 21 rows on disk against 24 calls attributed, 1.076x on bytes.
 *
 * It cannot be fixed at write time: the MCP server is never told which Claude
 * Code session is calling it, so it has nothing to stamp. It cannot be fixed
 * inside a single session's read either, since one transcript cannot know what
 * another contains. So it is resolved here, by the caller that enumerates the
 * whole set, and refused where the set is unknown.
 *
 * Takes the transcripts already read rather than re-reading: the extraction has
 * to be the SAME rule the join uses, and a second implementation of it is how
 * two consumers of one rule drift apart.
 */
export function lineagesOf(transcripts: readonly Transcript[]): number[] {
  // A `requestId` names ONE API call, so it can appear in two files only when
  // one inherited from the other. Sharing any admitted request is therefore
  // proof of common descent, and a lineage is the connected component under
  // that relation. No vendor field is needed, and none would serve: inherited
  // records are rewritten to claim whichever session they sit in.
  const parent = transcripts.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      const grand = parent[parent[i]!]!;
      parent[i] = grand;
      i = grand;
    }
    return i;
  };
  const seenIn = new Map<string, number>();
  for (let i = 0; i < transcripts.length; i++) {
    for (const request of transcripts[i]!.requests) {
      const first = seenIn.get(request.requestId);
      if (first === undefined) seenIn.set(request.requestId, i);
      else {
        const ra = find(first);
        const rb = find(i);
        if (ra !== rb) parent[rb] = ra;
      }
    }
  }
  return transcripts.map((_, i) => find(i));
}

/**
 * Invocation ids carried by more than one OBSERVATION, which therefore belong to
 * none of them.
 *
 * This exists because an `invocation_id` is CALL identity and the join was using
 * it as ownership. Claude Code writes a resumed or forked conversation's
 * inherited records into the new session file, so one `gate` result is present
 * in every descendant and every descendant's join matches it. Measured: one id
 * in four transcripts, credited four times -- 21 rows on disk against 24 calls
 * attributed, 1.076x on bytes.
 *
 * **`grouping` IS THE UNIT THE CALLER WILL REPORT AT, and it must be, because
 * ambiguity is relative to that unit.** Defaulting to one group per transcript
 * is right for a per-session report: four sessions that each print a total may
 * not each print the same call. Passing `lineagesOf(...)` is right for B12,
 * whose observation is a task window inside a lineage -- there, refusing a call
 * because a compaction continuation also carries it would make every task long
 * enough to auto-compact refuse its own tool use. Session `8da10c80` shares 97
 * admitted billed requests with the session it continues, so this is the common
 * case rather than a corner.
 *
 * Getting this backwards re-creates the defect it repairs: group by lineage
 * while still reporting per session and all four sessions credit the call again.
 */
export function invocationOwners(
  transcripts: Iterable<Transcript>,
  grouping?: readonly number[]
): Set<string> {
  const all = [...transcripts];
  const group = grouping ?? all.map((_, i) => i);
  const owners = new Map<string, Set<number>>();
  for (let i = 0; i < all.length; i++) {
    const here = new Set<string>();
    for (const result of all[i]!.toolResults) {
      if (!isLocalToolResult(result)) continue;
      if (result.invocationId !== null) here.add(result.invocationId);
    }
    for (const id of here) {
      const set = owners.get(id) ?? new Set<number>();
      set.add(group[i] ?? i);
      owners.set(id, set);
    }
  }
  const ambiguous = new Set<string>();
  for (const [id, groups] of owners) if (groups.size > 1) ambiguous.add(id);
  return ambiguous;
}

/**
 * What INSTALLING the server costs a session, whether or not a tool is called.
 *
 * B12's harm is stated over tasks with the server **installed**, not invoked,
 * and this is why: the seven tool schemas sit in the system prompt of every
 * thread, are written once per context segment and re-read on every request in
 * that segment. A task that never calls a tool still pays it, and on a one-sided
 * model that cost lands in the denominator of both arms and cancels — which is
 * exactly the accounting that lets an unused tool look free.
 *
 * `installedChars` is MEASURED, never assumed: the wire JSON of the server's own
 * `tools/list` response plus the policy block it writes into `CLAUDE.md`. On
 * this build, 15,227 + 900 = 16,127 characters (`run 2026-08-05-win-16-b12-repairs`).
 * It is passed in rather than hardcoded because it moves whenever a description
 * is edited — B15 measured 114 tokens for one 422-character edit.
 *
 * Priced per thread+segment at entry position 0, since the system prompt is the
 * first thing in a context and the last thing to leave it.
 */
export function unitsAddedByInstallation(
  transcript: Transcript,
  rates: Rates,
  installedChars: number,
  /**
   * Restrict to the requests named here — the same subset seam
   * `breakdownOfRequests` carries, and for the same reason. B12's unit is a task
   * window inside a lineage that is usually much longer, and the whole-transcript
   * form charges an observation for every `thread#segment` in the file, including
   * the ones another task originated. Omit it for the whole transcript.
   *
   * The SEGMENT is still sized from the full transcript: only which segments are
   * charged is narrowed, never how long they are. Narrowing `segmentSize` would
   * shorten `T` and change the multiplier, which is the error this file spends a
   * paragraph warning about elsewhere.
   */
  requestIds?: ReadonlySet<string>
): number {
  const tokens = installedChars / rates.charsPerToken;
  const firstOfSegment = new Map<string, BilledRequest>();
  for (const request of transcript.requests) {
    if (requestIds !== undefined && !requestIds.has(request.requestId)) continue;
    const key = `${request.thread}#${request.segment}`;
    const seen = firstOfSegment.get(key);
    if (seen === undefined || request.index < seen.index) firstOfSegment.set(key, request);
  }
  let units = 0;
  for (const request of firstOfSegment.values()) {
    const m = multipliersFor(rates, rateKey(request.model, request.speed));
    const ttl = request.usage.cacheWrite5m > request.usage.cacheWrite1h ? "5m" : "1h";
    units += tokens * positionalMultiplier(0, request.segmentSize, m, ttl);
  }
  return units;
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
  session: SessionReport,
  /**
   * Invocation ids that more than one session's transcript carries, so this one
   * cannot claim them. Built by the caller, which is the only layer that sees
   * the whole session set — see `invocationOwners`. Empty means "checked and
   * none", which is why the caller passes it explicitly rather than omitting it.
   */
  ambiguousIds: ReadonlySet<string> = new Set()
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
  const excludedForeignUnits: RefusedMagnitude = { units: 0, unsized: 0 };
  let unverifiable = 0;
  const unverifiableUnits: RefusedMagnitude = { units: 0, unsized: 0 };
  let ambiguous = 0;
  let unmatched = 0;
  const unmatchedUnits: RefusedMagnitude = { units: 0, unsized: 0 };
  const ambiguousUnits: RefusedMagnitude = { units: 0, unsized: 0 };
  /**
   * Every row the join saw, credited or refused, in the order it was read.
   *
   * **EXACTLY ONE ROW PER TELEMETRY ENTRY.** The order was already stated here;
   * the cardinality was not, and B12's run-level coverage ledger PAIRS THESE BY
   * INDEX with the `telemetry` argument to recover a row identity that survives a
   * null `invocation_id`. Every branch of the loop below pushes one row and then
   * `continue`s, and the credited path reaches no second push, so
   * `rows.length === telemetry.length` holds on every input. Nothing sorts or
   * splices this array — `byTool` is sorted on the way out, `rows` is not.
   * `tests/cost-meter.test.ts` proves it over a fixture carrying all five
   * dispositions, because an invariant relied on across a module boundary and
   * checked by nobody is a comment, not a guarantee.
   *
   * B12 needs this for two independent reasons and neither is display. Its unit
   * of observation is a TASK WINDOW, not a session, and a window cannot be scored
   * by restricting the transcript: `positionalMultiplier` reads `index` and
   * `segmentSize` off the FULL segment, so a shortened transcript shortens `T`
   * and deflates the deciding number by roughly an order of magnitude, in the
   * direction that stops the project. The only correct scoping is to meter the
   * whole lineage and select which ROWS count, which needs the rows. Separately,
   * the frozen design requires exactly this vector on the artifact's face, per
   * row: `(invocation_id, tool, ts, thread, t, T, ttl, multiplier, bytes_raw,
   * bytes_returned, capped, uncapped, signed)`.
   */
  const rows: CreditedRow[] = [];

  /**
   * What a row WOULD have added had it been creditable. THREE of the four
   * classes are sized here — `unverifiable`, `ambiguous` and `excludedForeign`,
   * all through `addRefused` — and they must report it the same way, because
   * computing it twice is how two numbers derived from one rule drift apart.
   * `unmatched` never reaches this function: it is entered separately below and
   * is unsized by construction, since the request a magnitude would be priced
   * against is exactly the one that is missing.
   *
   * **`null` is not 0.** No matchable request means the magnitude is UNKNOWN, and
   * summing an unknown as zero is the same error as printing a withheld fraction
   * as a low one — the thing this file was just repaired to stop doing.
   *
   * THE THREAD IS RESOLVED, NOT ASSUMED. This first shipped hardcoding `"main"`,
   * which is the crediting path's own bug inverted: a tool called by a subagent
   * is cached into that subagent's context, so on a subagent-heavy session no
   * main-thread request matches and the refused magnitude came back 0. A refusal
   * that reports "nothing was refused" is exactly the silent exclusion the
   * counter exists to make visible. Sessions here run to 78% subagent.
   */
  const wouldHaveAdded = (entry: TelemetryRecord): { hi: number; lo: number } | null => {
    const source =
      entry.invocation_id !== undefined ? byInvocation.get(entry.invocation_id) : undefined;
    const at = source?.timestampMs ?? Date.parse(entry.ts);
    const thread = source?.thread ?? "main";
    // THE ROW'S OWN THREAD OR NOTHING. This first shipped falling back to main
    // when a subagent's thread had no later request, which does not compute an
    // approximate answer -- it computes a DIFFERENT one, against a thread that
    // never paid for the call, and returns it as known. Measured on a fixture:
    // 283,176 units reported with the unknown counter reading 0, of which
    // 270,000 came from a main-thread `cacheRead` of 900,000 the subagent never
    // touched. Unknown is the honest answer and it has somewhere to go now.
    const would = requestAtOrAfter(transcript.requests, at, thread);
    if (would === null) return null;
    const wm = multipliersFor(rates, rateKey(would.model, would.speed));
    const wttl = would.usage.cacheWrite5m > would.usage.cacheWrite1h ? "5m" : "1h";
    const wmult = positionalMultiplier(would.index, would.segmentSize, wm, wttl);
    // PRICED BY THE SCORED RULE, BECAUSE IT IS CONSUMED AS A SCORED QUANTITY.
    // This returned a different quantity from the crediting path below in three
    // ways at once -- clamped where the scored numerator is signed, uncapped
    // where it is capped, and carrying a turn-collapse term the scored numerator
    // excludes BY NAME. Its only consumers are the refusal magnitudes, and those
    // feed `R_hi+`, which is the number on B12's FALL side. So a refused row was
    // being granted more per row than an identical credited row would earn, and
    // the excess included a term set by a tool-call argument: `turns_collapsed`
    // is `rounds.length` whether or not `repair` closed anything, so padding it
    // inflated the doubt-credited figure that decides whether the project stops.
    // One quantity, one rule -- the same principle the comment above states and
    // this expression was breaking.
    //
    // BOTH HORIZONS, so `units` and `unitsLo` are null together or neither. Only
    // `hi` has a consumer today -- the refusal magnitudes feed `R_hi+`, which is
    // a high-horizon figure -- but returning `lo` as null on a row that WAS
    // sizeable would give `null` two meanings on the same field, and the ledger
    // is built on `null` meaning exactly one thing: nobody could size it.
    const tokens =
      (Math.min(entry.bytes_raw, rates.clientTruncationCap) - entry.bytes_returned) /
      rates.charsPerToken;
    return { hi: tokens * wmult, lo: tokens * writeComponent(wm, wttl) };
  };
  /**
   * The tool's OWN verdict for this call, off an untyped optional bag.
   *
   * `detail` is `Record<string, unknown> | undefined` and nothing validates it,
   * so this enumerates the good values and refuses the rest: only an actual
   * boolean is a verdict. **Absent is `null`, never `false`.** Three different
   * things produce no `passed` key and none of them is a call that ran and
   * failed — `repair`'s abort path writes a detail without one, rows predating
   * the field exist on disk, and a tool that never wrote a detail at all. B12's
   * `MIN_REPAIR_CLOSURES` counts closures, and a floor fed by absences read as
   * failures would report `unexercised` for a delivery that was exercised.
   */
  const verdictOf = (entry: TelemetryRecord): boolean | null =>
    typeof entry.detail?.passed === "boolean" ? entry.detail.passed : null;
  /**
   * A refused row's ledger entry. Positional fields are null by construction: a
   * refused row has no request to be positioned against, and that is usually why
   * it was refused. The bytes are recorded anyway, because "we refused something
   * this big" is the fact the ledger exists to carry.
   */
  const refusedRow = (
    entry: TelemetryRecord,
    disposition: Exclude<RowDisposition, "credited">,
    magnitude: { hi: number; lo: number } | null
  ): RefusedLedgerRow => ({
    invocationId: entry.invocation_id ?? null,
    tool: entry.tool,
    ts: entry.ts,
    disposition,
    thread: null,
    index: null,
    segmentSize: null,
    ttl: null,
    multiplier: null,
    rateKey: null,
    bytesRaw: entry.bytes_raw,
    bytesReturned: entry.bytes_returned,
    signed: entry.bytes_raw - entry.bytes_returned,
    capped: Math.min(entry.bytes_raw, rates.clientTruncationCap) - entry.bytes_returned,
    turnsCollapsed: entry.turns_collapsed,
    units: magnitude?.hi ?? null,
    unitsLo: magnitude?.lo ?? null,
    passed: verdictOf(entry),
  });
  const addRefused = (
    into: RefusedMagnitude,
    entry: TelemetryRecord,
    disposition: Exclude<RowDisposition, "credited">
  ): void => {
    const magnitude = wouldHaveAdded(entry);
    if (magnitude === null) into.unsized++;
    else into.units += magnitude.hi;
    // The counter and the ledger row are written HERE, together, so a class can
    // never be counted without being listed or listed without being counted.
    rows.push(refusedRow(entry, disposition, magnitude));
  };
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
      addRefused(unverifiableUnits, entry, "unverifiable");
      continue;
    }

    // The id exists in this transcript AND in someone else's. A resumed or
    // forked conversation carries the original records forward, so the same
    // `gate` result is physically present in every descendant session and each
    // one's join matches it. Crediting it to all of them counted one call four
    // times. There is no rule that recovers the owner from the files alone, so
    // it is refused here rather than guessed, and its magnitude is reported.
    if (ambiguousIds.has(entry.invocation_id)) {
      ambiguous++;
      addRefused(ambiguousUnits, entry, "ambiguous");
      continue;
    }

    if (!provenanceUnavailable) {
      const source = byInvocation.get(entry.invocation_id);
      if (source === undefined) {
        // Another session on the same project. Counting it here would inflate
        // this session's saving and double-count it across reports.
        //
        // ITS MAGNITUDE IS RECORDED, and it was not. This class shipped as a
        // bare counter while the other three carried magnitudes, so `R_hi+` --
        // which grants every refused row its would-have magnitude across ALL
        // FOUR classes -- could not be computed as the frozen design defines it,
        // and the design's own Phase-0 repair list named `unmatched` and missed
        // this one. A refusal reported without its size is the silent exclusion
        // the other three counters exist to prevent.
        excludedForeign++;
        addRefused(excludedForeignUnits, entry, "excludedForeign");
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
      bytes: { clampedUncapped: 0, signedUncapped: 0, signedCapped: 0 },
      unitsFromSuppression: { clampedUncapped: 0, signedUncapped: 0, signedCapped: 0 },
      turnsCollapsed: 0,
      unitsFromTurnCollapse: 0,
      unitsTotal: 0,
      usd: null,
      unmatched: 0,
      rowsNetNegative: 0,
    };
    byTool.set(entry.tool, saving);
    saving.calls++;

    const request = requestAtOrAfter(transcript.requests, ts, thread);
    if (request === null) {
      // Deflates the numerator exactly like a refusal, so it is counted as one.
      // Its magnitude is unsized BY CONSTRUCTION: the request that is missing is
      // the one a magnitude would have been priced against.
      saving.unmatched++;
      unmatched++;
      unmatchedUnits.unsized++;
      rows.push(refusedRow(entry, "unmatched", null));
      continue;
    }

    const requestKey = rateKey(request.model, request.speed);
    const m = multipliersFor(rates, requestKey);
    const ttl = request.usage.cacheWrite5m > request.usage.cacheWrite1h ? "5m" : "1h";
    const multiplier = positionalMultiplier(request.index, request.segmentSize, m, ttl);

    // THREE FORMS, BECAUSE THE SHIPPED ONE ADJUSTS TWICE IN THE SAME DIRECTION.
    // The clamp turns a call that ADDED bytes into a call that saved nothing,
    // and no ceiling lets a row claim bytes that could not have reached a
    // context in the counterfactual world -- Claude Code truncates a tool result
    // at `clientTruncationCap`, so a 1.9 MB command arrives as 30,000 characters
    // whether or not the tool summarised it.
    const signed = entry.bytes_raw - entry.bytes_returned;
    const capped = Math.min(entry.bytes_raw, rates.clientTruncationCap) - entry.bytes_returned;
    if (signed < 0) saving.rowsNetNegative++;
    saving.bytes.clampedUncapped += Math.max(0, signed);
    saving.bytes.signedUncapped += signed;
    saving.bytes.signedCapped += capped;
    saving.unitsFromSuppression.clampedUncapped += (Math.max(0, signed) / rates.charsPerToken) * multiplier;
    saving.unitsFromSuppression.signedUncapped += (signed / rates.charsPerToken) * multiplier;
    saving.unitsFromSuppression.signedCapped += (capped / rates.charsPerToken) * multiplier;

    // A turn that did not happen is a whole context re-read that did not happen
    // -- but the COUNT is a caller argument, so this is reported and never
    // scored. See `ToolSaving.unitsFromTurnCollapse`.
    saving.turnsCollapsed += entry.turns_collapsed;
    saving.unitsFromTurnCollapse += entry.turns_collapsed * request.usage.cacheRead * m.cacheRead;

    // The ledger row, carrying the SCORED contribution and nothing else -- the
    // same `signedCapped x multiplier` that `unitsTotal` sums, so a reader can
    // add these up and land on the aggregate rather than on a near miss.
    rows.push({
      invocationId: entry.invocation_id ?? null,
      tool: entry.tool,
      ts: entry.ts,
      disposition: "credited",
      thread: request.thread,
      index: request.index,
      segmentSize: request.segmentSize,
      ttl,
      multiplier,
      rateKey: requestKey,
      bytesRaw: entry.bytes_raw,
      bytesReturned: entry.bytes_returned,
      signed,
      capped,
      turnsCollapsed: entry.turns_collapsed,
      units: (capped / rates.charsPerToken) * multiplier,
      // The SAME row at `T-1-t = 0`, which is B12's low horizon. Through the
      // shared `writeComponent` rather than by branching on `ttl` here, so the
      // write half is spelled in one place and cannot drift from the one the
      // high horizon is built on.
      unitsLo: (capped / rates.charsPerToken) * writeComponent(m, ttl),
      // The uncapped pair prices `signed` whole — the only difference from the
      // scored pair is the absent `Math.min(bytes_raw, cap)`, so a capped row
      // under the cap carries identical figures in both pairs.
      unitsUncapped: (signed / rates.charsPerToken) * multiplier,
      unitsLoUncapped: (signed / rates.charsPerToken) * writeComponent(m, ttl),
      passed: verdictOf(entry),
    });

    // Priced against the model of the request this saving was matched to, not
    // against whichever model in the session happened to have a price. A
    // subagent's call is worth its own model's rate, and if that model has no
    // price the tool's dollar figure is unknown rather than approximated.
    // Priced on the SCORED quantity, so the dollar figure and the unit figure
    // describe the same thing. Turn collapse is excluded from both.
    const entryUnits = (capped / rates.charsPerToken) * multiplier;
    const price = inputPriceFor(rates, requestKey);
    if (price === null) unpriced.add(entry.tool);
    else saving.usd = (saving.usd ?? 0) + (entryUnits * price) / 1_000_000;
  }

  let unitsTotal = 0;
  for (const saving of byTool.values()) {
    // SCORED = signed and capped suppression, and NOTHING ELSE. Turn collapse is
    // reported beside it because its count comes from a tool-call argument.
    saving.unitsTotal = saving.unitsFromSuppression.signedCapped;
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
    // WITHHELD, not zero, in two cases.
    //
    // The exact join being unavailable: everything counted then came from the
    // timestamp fallback, which cannot tell two overlapping sessions apart.
    //
    // And any AMBIGUOUS row, which is the subtler one. That saving is real --
    // the call happened and its output reached a context -- and only its OWNER
    // is unknown. Crediting it here would double-count; reporting 0 asserts the
    // session saved nothing, which is a different false claim and the dangerous
    // one, since `G-stop` stops this project on a low number. The honest value
    // is a lower bound, and a bound published as a point value is how a bound
    // gets compared to a threshold. `unverifiable` does NOT withhold: those rows
    // cannot be shown to have reached the context at all, so excluding them is a
    // finding rather than an unknown.
    savedFraction:
      provenanceUnavailable || ambiguous > 0 ? null : denominator === 0 ? 0 : unitsTotal / denominator,
    excludedForeign,
    excludedForeignUnits,
    ambiguous,
    ambiguousUnits,
    unverifiable,
    unverifiableUnits,
    unmatched,
    unmatchedUnits,
    rows,
    // FOUR CLASSES, ONE CONSUMER, COUNTED IN ONE PLACE. `unmatched` was the
    // fourth and it was missing -- the same defect as one class earlier, which
    // is why the classes are now summed here rather than at each reader.
    refusedRows: excludedForeign + ambiguous + unverifiable + unmatched,
    provenanceUnavailable,
  };
}
