/**
 * UNIT 4 — the run-level exactly-once ledger. Specified by
 * `docs/b12-scorer/UNIT-4.md`.
 *
 * NOT PART OF THE PHASE-3 EXPOSURE. Units 1-3 were the task the local model was
 * measured on; this one was written afterwards, by the orchestrator, to close
 * `FINDINGS.md` F12 and F9.
 *
 * `R_hi⁺` is a sum over rows, and until this existed the sum ran over the wrong
 * multiset in two independent ways. A row two observations' slices both hold was
 * summed TWICE — `scopeTelemetry` admits on a ±60,000 ms window as well as on an
 * exact id match, and `wouldHaveAdded` is signed, so a duplicated negative
 * magnitude pushes the figure toward a fall. A credited row no window owns was
 * summed ZERO times, because it is in no `S_o` and in none of the four refusal
 * classes.
 *
 * EVERY FIELD IS A REPORT. Nothing here repairs anything: this unit says what the
 * run could not account for, and `rHiPlus` refuses rather than publishing a
 * figure over a set it cannot enumerate.
 */

import type { CreditedRow } from "../report.js";
import type { TelemetryRecord } from "../../telemetry.js";
import type {
  ClassLedger,
  CoveredRow,
  IdentifiedRow,
  ObservationTerms,
  RefusalLedger,
  RunTelemetryCoverage,
} from "./types.js";

/** Two magnitudes agree when they agree to here — the tolerance `identityHolds` uses. */
const EPSILON = 1e-9;

/** One sighting of a physical row inside one observation's slice. */
interface Occurrence {
  label: string;
  row: CreditedRow;
}

/**
 * Stamp a run identity onto the rows of one telemetry artifact.
 *
 * `TelemetryRecord` carries nothing usable as identity — `invocation_id` is
 * optional and absent on every row written before it existed, and two rows can
 * otherwise be byte-identical. So identity is (ARTIFACT, ORDINAL) and is a
 * property of the READ rather than of the row: read the log ONCE per run and
 * derive every slice from that one array.
 *
 * `JSON.stringify([source, ordinal])` and not `${source}#${ordinal}`: a path may
 * contain `#`, and two different rows sharing a key is the one thing an identity
 * may not do.
 */
export function identify(source: string, records: readonly TelemetryRecord[]): IdentifiedRow[] {
  return records.map((record, ordinal) => ({ key: JSON.stringify([source, ordinal]), record }));
}

const labelOf = (t: ObservationTerms): string => `${t.taskId}/${t.arm}`;

/** A four-class ledger with every counter at zero. */
function emptyLedger(): RefusalLedger {
  return {
    ambiguous: { count: 0, units: 0, unsized: 0 },
    unverifiable: { count: 0, units: 0, unsized: 0 },
    excludedForeign: { count: 0, units: 0, unsized: 0 },
    unmatched: { count: 0, units: 0, unsized: 0 },
  };
}

/** File one resolved row into a class ledger. `null` is counted, never summed as zero. */
function enter(cell: ClassLedger, units: number | null): void {
  cell.count++;
  if (units === null) cell.unsized++;
  else cell.units += units;
}

/** Append to a map of lists, creating the list on first sight. */
function push<T>(into: Map<string, T[]>, key: string, value: T): void {
  const list = into.get(key);
  if (list === undefined) into.set(key, [value]);
  else list.push(value);
}

/**
 * Resolve one unowned key from every occurrence of it across the run's slices.
 *
 * FIRST MATCH WINS, and the ORDER of the tests is the point. A single number
 * alongside a `null` is a CONFLICT, not an agreement: treating "one distinct
 * non-null value" as agreement discards the occurrence that could not be sized,
 * which is the unknown-summed-as-zero collapse under another name.
 *
 * The dispositions can genuinely differ. `unverifiable` and `ambiguous` are
 * transcript-independent — one is decided by `entry.invocation_id === undefined`
 * and the other by the run-level `ambiguousIds` set — but `credited`,
 * `excludedForeign` and `unmatched` are each decided against the transcript doing
 * the pricing, so one physical row can be credited in one session's slice and
 * foreign in another's.
 */
function resolve(key: string, seen: readonly Occurrence[]): CoveredRow {
  const ordered = [...seen].sort((a, b) => a.label.localeCompare(b.label));
  const first = ordered[0];
  if (first === undefined) {
    // Unreachable: a key exists in the map only because something was pushed
    // under it. Stated rather than defaulted — a fallback disposition here would
    // put a row in a class no evidence assigned it to.
    throw new Error(`runCoverage: ${key} was resolved with no occurrences`);
  }
  const slices = ordered.map((o) => o.label);
  // ARBITRARY, DETERMINISTIC, AND DECIDING NOTHING when `conflict` is non-null:
  // the row is unsized, so `rHiPlus` refuses whichever class it was filed under.
  const disposition = first.row.disposition;
  const conflicted = (conflict: string): CoveredRow => ({ key, disposition, units: null, conflict, slices });

  const dispositions = [...new Set(ordered.map((o) => o.row.disposition))].sort();
  if (dispositions.length > 1) {
    return conflicted(
      `slices disagree on disposition (${dispositions.join(", ")}), and no refusal class means "the transcripts disagree about what this row is"`
    );
  }
  const magnitudes = ordered.map((o) => o.row.units);
  if (magnitudes.some((u) => u === null)) {
    return conflicted("at least one slice could not size it, and an unknown may not be summed as zero");
  }
  const sized = magnitudes.filter((u): u is number => u !== null);
  const smallest = Math.min(...sized);
  const largest = Math.max(...sized);
  if (largest - smallest > EPSILON) {
    return conflicted(
      `slices priced it differently (${smallest} vs ${largest}), and nothing in the data says which transcript pays`
    );
  }
  return { key, disposition, units: smallest, conflict: null, slices };
}

/**
 * Account for every telemetry row of the run exactly once.
 *
 * `universe` IS EVERY ROW THE RUN PRODUCED, not the union of the slices. That
 * argument is load-bearing and the first draft of this design did not have it:
 * `computeTerms` receives a slice `scopeTelemetry` has already narrowed, so a row
 * outside every observation's window is absent from every `ObservationTerms` and
 * a coverage built from those alone cannot see that it exists.
 * `scripts/b12-scorer-mac.sh` already writes exactly this set — the telemetry
 * past a recorded byte baseline — to `telemetry-slice.jsonl`.
 */
export function runCoverage(
  universe: readonly IdentifiedRow[],
  all: readonly ObservationTerms[]
): RunTelemetryCoverage {
  // OWNERSHIP FIRST, and every non-owning slice's price for an owned key is then
  // discarded. Without that, two arms which merely ran within a minute of each
  // other would put ordinary single-owner rows through the conflict rules below
  // and refuse a run the design intends to score.
  const claims = new Map<string, string[]>();
  const occurrences = new Map<string, Occurrence[]>();
  for (const t of all) {
    const label = labelOf(t);
    for (const keyed of t.rows) {
      push(claims, keyed.key, label);
      push(occurrences, keyed.key, { label, row: keyed.row });
    }
    for (const keyed of t.unattributed) {
      push(occurrences, keyed.key, { label, row: keyed.row });
    }
  }

  const ownedBy = new Map<string, string>();
  const contested: Array<{ key: string; claimants: readonly string[] }> = [];
  for (const [key, claimants] of claims) {
    const distinct = [...new Set(claimants)].sort();
    const only = distinct.length === 1 ? distinct[0] : undefined;
    if (only !== undefined) ownedBy.set(key, only);
    else contested.push({ key, claimants: distinct });
  }
  contested.sort((a, b) => a.key.localeCompare(b.key));

  const unsliced = universe
    .map((r) => r.key)
    .filter((key) => !occurrences.has(key))
    .sort();

  const unownedRows: CoveredRow[] = [];
  for (const [key, seen] of occurrences) {
    // `claims` covers both the owned and the contested keys. A contested key is
    // deliberately absent from the ledger below AND from `ownedBy`: it is refused
    // through `reasons`, and filing it under a claimant would be picking one.
    if (claims.has(key)) continue;
    unownedRows.push(resolve(key, seen));
  }
  unownedRows.sort((a, b) => a.key.localeCompare(b.key));

  // DERIVED FROM THE LIST, never accumulated beside it. A total that cannot name
  // its rows cannot be checked against the exactly-once claim, and that claim is
  // the whole of the fix.
  const unowned = emptyLedger();
  const unattributedCredited: ClassLedger = { count: 0, units: 0, unsized: 0 };
  for (const row of unownedRows) {
    if (row.disposition === "credited") enter(unattributedCredited, row.units);
    else enter(unowned[row.disposition], row.units);
  }

  const reasons: string[] = [];
  for (const { key, claimants } of contested) {
    reasons.push(
      `${key} is claimed by ${claimants.length} observations (${claimants.join(", ")}), so it belongs to none of them`
    );
  }
  if (unsliced.length > 0) {
    reasons.push(
      `${unsliced.length} telemetry row(s) of this run fell inside no observation's slice, so they carry neither a disposition nor a magnitude`
    );
  }
  // F9, AND THE REFUSAL IS UNCONDITIONAL RATHER THAN SIGN-AWARE. Omitting a
  // credited magnitude `U` moves the figure by `U(A+O) / (D(D+U))` with
  // `D = A + S + refused`, so the argument that a negative `U` is the safe
  // direction needs `D > 0` and `D + U > 0` — and nothing here establishes
  // either; `rHiPlus` checks only `denominator === 0`. Not added to any figure:
  // `design.metric` defines `S_o` over "o's credited rows" and limits `R_hi⁺`'s
  // additions to the four refusal classes, so crediting one would amend the
  // estimand rather than repair the instrument.
  if (unattributedCredited.count > 0) {
    reasons.push(
      `${unattributedCredited.count} credited row(s) belong to no observation's window, so Σ S_o is short of the run's credited total by ${unattributedCredited.units} unit(s)`
    );
  }
  for (const name of ["ambiguous", "unverifiable", "excludedForeign", "unmatched"] as const) {
    const cell = unowned[name];
    if (cell.unsized > 0) {
      reasons.push(
        `${cell.unsized} unowned ${name} row(s) could not be sized, and an unknown may not be summed as zero`
      );
    }
  }
  if (unattributedCredited.unsized > 0) {
    reasons.push(
      `${unattributedCredited.unsized} unowned credited row(s) could not be sized, and an unknown may not be summed as zero`
    );
  }

  return {
    ownedBy,
    contested,
    unsliced,
    unownedRows,
    unowned,
    unattributedCredited,
    reasons,
    exactlyOnce: reasons.length === 0,
  };
}
