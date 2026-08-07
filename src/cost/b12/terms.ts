/**
 * UNIT 2 — one observation's terms: `A_o`, `S_o` at both horizons, and `O_o`.
 * Specified by `docs/b12-scorer/UNIT-2.md`; this header said "UNIT 1" until
 * 2026-08-07 and `strata.ts` said "UNIT 2", which is the wrong way round in both.
 *
 * THE WHOLE LINEAGE IS METERED AND THE SELECTION HAPPENS AFTERWARDS. B12's unit
 * is a task window, and the window cannot be scored by shortening the
 * transcript: `positionalMultiplier` reads `t` and `T` off the full segment, so
 * a shortened transcript shortens `T` and deflates the deciding number by
 * roughly an order of magnitude — in the direction that stops the project. So
 * this unit calls the meter over everything and then narrows.
 *
 * IT NARROWS THREE THINGS, NOT ONE. This header used to say "only the credit is
 * narrowed", which is wrong: `A_o` and `O_o` are computed over `owned` too
 * (`breakdownOfRequests` and `unitsAddedByInstallation` both take the id set).
 * The full lineage is what SEGMENT POSITIONING and the PROVENANCE JOIN are
 * computed against — `buildCounterfactual` reads it for local-vs-foreign
 * ownership, for a row's timestamp and thread, and for the request a row is
 * matched to, as well as for `t` and `T`.
 */

import {
  breakdownOfRequests,
  buildCounterfactual,
  buildSessionReport,
  unitsAddedByInstallation,
} from "../report.js";
import type { CreditedRow } from "../report.js";
import { rateKey } from "../rates.js";
import type { Rates } from "../rates.js";
import type { TelemetryRecord } from "../../telemetry.js";
import type { Transcript } from "../transcript.js";
import { subagentShare } from "./strata.js";
import type {
  B12Observation,
  DeliveryTerms,
  Disposition,
  ObservationTerms,
  RefusalLedger,
} from "./types.js";

export interface TermsInput {
  observation: B12Observation;
  /** The FULL lineage — continuation and fork children included, never one file. */
  transcript: Transcript;
  /** Rows already narrowed to this session by `scopeTelemetry`. */
  telemetry: TelemetryRecord[];
  /**
   * Carries the MEASURED `clientTruncationCap` for the build that ran. VOID 8
   * requires it measured per version; `.local-coder/rates.json` is frozen
   * byte-identical to commit `3541625` and cannot hold it, so the caller
   * overlays the manifest's value onto the loaded rates before calling here.
   */
  rates: Rates;
  /** Measured, never assumed: the wire JSON of `tools/list` plus the CLAUDE.md block. */
  installedChars: number;
  /** Ids more than one session's transcript carries. Empty means "checked and none". */
  ambiguousIds: ReadonlySet<string>;
  /** Decided by the admission rule at run time, not here. */
  disposition: Disposition;
}

/**
 * The invocation ids this observation OWNS.
 *
 * The join is four hops and none of them may be skipped: a telemetry row names
 * an `invocation_id`; the transcript's `toolResults` carry that id and a
 * `toolUseId`; the `BilledRequest` whose `toolUses` contains that id is the
 * request that made the call; and the observation owns the row exactly when that
 * request's `requestId` is one it originated.
 *
 * Exported because it is the subtlest step in the unit and a bug here is silent:
 * an over-wide window credits another task's savings, and an over-narrow one
 * returns a confident zero. It is tested directly rather than through the
 * arithmetic that consumes it.
 */
export function windowInvocationIds(
  observation: B12Observation,
  transcript: Transcript
): Set<string> {
  const owned = new Set(observation.originatedRequestIds);
  const ownedToolUseIds = new Set<string>();
  for (const request of transcript.requests) {
    if (!owned.has(request.requestId)) continue;
    for (const use of request.toolUses) ownedToolUseIds.add(use.id);
  }

  const mine = new Set<string>();
  for (const result of transcript.toolResults) {
    // BOTH ids required, and the membership test is the point of the hop. A
    // result whose `toolUseId` is null cannot be traced back to a request, so no
    // window can claim it — dropping it here is what stops one task's saving
    // from being credited to another.
    if (result.invocationId === null || result.toolUseId === null) continue;
    if (!ownedToolUseIds.has(result.toolUseId)) continue;
    mine.add(result.invocationId);
  }
  return mine;
}

/** A four-class ledger with every counter at zero. */
function emptyLedger(): RefusalLedger {
  return {
    ambiguous: { count: 0, units: 0, unsized: 0 },
    unverifiable: { count: 0, units: 0, unsized: 0 },
    excludedForeign: { count: 0, units: 0, unsized: 0 },
    unmatched: { count: 0, units: 0, unsized: 0 },
  };
}

/**
 * File one refused row into whichever ledger it belongs to.
 *
 * `units` is summed when it is a number and counted as `unsized` when it is
 * null — never summed as zero. That distinction is the reason `RefusedMagnitude`
 * has two fields instead of one, and `R_hi+` refuses outright on a non-zero
 * `unsized` rather than reporting a floor as a total.
 */
function addRefusal(into: RefusalLedger, row: CreditedRow): void {
  if (row.disposition === "credited") return;
  const cell = into[row.disposition];
  cell.count++;
  if (row.units === null) cell.unsized++;
  else cell.units += row.units;
}

/**
 * Everything one observation contributes, with no clamp anywhere.
 *
 * `sLo` credits every row at the write component alone (`T-1-t = 0`) — the
 * arithmetic floor of the model, which no argument about segment length can
 * dispute. `sHi` uses the observed segment. Turn collapse contributes NOTHING to
 * either: its count is a caller argument, and a term set by a string in a tool
 * call is not a measurement.
 */
export function computeTerms(input: TermsInput): ObservationTerms {
  const owned = new Set(input.observation.originatedRequestIds);
  const aO = breakdownOfRequests(input.transcript.requests, input.rates, owned).units.total;
  const oO = unitsAddedByInstallation(
    input.transcript,
    input.rates,
    input.installedChars,
    owned
  );
  const mine = windowInvocationIds(input.observation, input.transcript);

  // THE WHOLE TRANSCRIPT, never a filtered one. Filtering here would shorten `T`
  // and deflate every multiplier — see the header.
  const counterfactual = buildCounterfactual(
    input.transcript,
    input.telemetry,
    input.rates,
    buildSessionReport(input.transcript, input.rates),
    input.ambiguousIds
  );

  const rows: CreditedRow[] = [];
  const refusals = emptyLedger();
  const unattributedRefusals = emptyLedger();
  const perDelivery: Record<string, DeliveryTerms> = {};
  let sLo = 0;
  let sHi = 0;

  for (const row of counterfactual.rows) {
    // OWNERSHIP, and nothing else, decides which side a row falls on. Writing
    // the rule this way rather than as a list of dispositions is what keeps it
    // correct: `unverifiable` can never be owned (it has no invocation id by
    // definition) and `excludedForeign` is unowned on any normal input, but the
    // two sets are not exact complements (`FINDINGS.md` F10).
    const isMine = row.invocationId !== null && mine.has(row.invocationId);
    if (!isMine) {
      addRefusal(unattributedRefusals, row);
      continue;
    }

    rows.push(row);
    if (row.disposition !== "credited") {
      addRefusal(refusals, row);
      continue;
    }

    // Narrowed above, so both magnitudes are plain numbers here and no `?? 0` is
    // reachable. `turnsCollapsed` is on the row and in NEITHER sum.
    sHi += row.units;
    sLo += row.unitsLo;

    const bucket = (perDelivery[row.tool] ??= {
      sLo: 0,
      sHi: 0,
      rowCount: 0,
      closures: 0,
      closureUnknown: 0,
    });
    bucket.sHi += row.units;
    bucket.sLo += row.unitsLo;
    bucket.rowCount++;
    // THREE STATES, and `false` increments neither counter: a delivery that ran
    // and did not close is not a delivery whose rows could not answer.
    if (row.passed === true) bucket.closures++;
    else if (row.passed === null) bucket.closureUnknown++;
  }

  const ownRequests = input.transcript.requests.filter((r) => owned.has(r.requestId));

  return {
    taskId: input.observation.taskId,
    arm: input.observation.arm,
    disposition: input.disposition,
    aO,
    sLo,
    sHi,
    oO,
    rows,
    refusals,
    unattributedRefusals,
    subagentShare: subagentShare(input.observation, input.transcript),
    perDelivery,
    billedRequestCount: ownRequests.length,
    rateKeys: [...new Set(ownRequests.map((r) => rateKey(r.model, r.speed)))].sort(),
    verificationStratum: input.observation.verificationStratum,
  };
}
