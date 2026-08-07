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

import type { TelemetryRecord } from "../../telemetry.js";
import type { Rates } from "../rates.js";
import type { Transcript } from "../transcript.js";
import type { B12Observation, Disposition, ObservationTerms } from "./types.js";

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
  void observation;
  void transcript;
  throw new Error("not implemented");
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
  void input;
  throw new Error("not implemented");
}
