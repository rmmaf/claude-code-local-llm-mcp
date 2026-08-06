/**
 * UNIT 2 — the subagent share, and the partition the four strata cells are
 * computed over.
 *
 * NO RATIO IS COMPUTED HERE. This unit answers "which observations belong in
 * which cell"; `aggregate.ts` answers "what is the cell's number". Keeping the
 * two apart is what stops a stratum from being defined by the figure it
 * produces, and it keeps this unit free of any dependency on the pooling rule.
 *
 * `ROADMAP.md` § G-stop states the requirement in its own words — "Record the
 * subagent share as a covariate on every arm, or the comparison flatters
 * whichever side spawned fewer agents" — and the frozen design makes it the one
 * covariate that "GATES BOTH VERDICTS". `scripts/b12-run.mjs` writes no such
 * field; it is recovered here from `originatedRequestIds` and `isSidechain`.
 */

import type { Transcript } from "../transcript.js";
import type { B12Observation, Evaluable, ObservationTerms, SubagentShare } from "./types.js";

/**
 * The share of this window's own billed requests that a subagent made.
 *
 * A WINDOW WITH NO REQUESTS OF ITS OWN IS UNEVALUABLE, NOT ZERO. Zero is what a
 * genuinely single-threaded session measures; returning it for a window that
 * measured nothing would file an empty observation into the `solo` stratum and
 * let it vote on a cell it never contributed to. The distinction is the same one
 * the refusal ledger makes between a magnitude of zero and a magnitude nobody
 * could size, and it is enforced by the return type rather than by a comment.
 *
 * The threshold between `solo` and `multi` is the design's own: `solo` is ZERO
 * subagent-originated records, so any sidechain request at all makes it `multi`.
 * It is not a fraction and must not be turned into one.
 */
export function subagentShare(
  observation: B12Observation,
  transcript: Transcript
): Evaluable<SubagentShare> {
  const owned = new Set(observation.originatedRequestIds);
  const own = transcript.requests.filter(r => owned.has(r.requestId));
  if (own.length === 0) {
    return { evaluable: false, reason: "window originated no billed request" };
  }
  const sidechain = own.filter(r => r.isSidechain).length;
  const share = sidechain / own.length;
  const stratum = sidechain === 0 ? "solo" : "multi";
  return { evaluable: true, value: { own: own.length, sidechain, share, stratum } };
}

export interface StrataPartition {
  testRed: ObservationTerms[];
  typesOnly: ObservationTerms[];
  solo: ObservationTerms[];
  multi: ObservationTerms[];
  /**
   * Observations whose share could not be evaluated. They are in NEITHER `solo`
   * nor `multi` — a bucket that silently absorbed them would make the two cells
   * look complete while one of them carried the unknowns.
   */
  unevaluableShare: ObservationTerms[];
}

/**
 * Split the admitted terms into the four cells `holdsIf` 3 requires.
 *
 * The verification stratum is DECLARED per task in the manifest before the run
 * and is read off the observation; it is never inferred from what the gate did,
 * because inferring it after the fact lets the result choose its own cell.
 */
export function partitionByStrata(terms: readonly ObservationTerms[]): StrataPartition {
  const testRed: ObservationTerms[] = [];
  const typesOnly: ObservationTerms[] = [];
  const solo: ObservationTerms[] = [];
  const multi: ObservationTerms[] = [];
  const unevaluableShare: ObservationTerms[] = [];

  for (const t of terms) {
    if (t.verificationStratum === "test-red") {
      testRed.push(t);
    } else if (t.verificationStratum === "types-only") {
      typesOnly.push(t);
    }

    if (!t.subagentShare.evaluable) {
      unevaluableShare.push(t);
    } else if (t.subagentShare.value.stratum === "solo") {
      solo.push(t);
    } else {
      multi.push(t);
    }
  }

  return { testRed, typesOnly, solo, multi, unevaluableShare };
}
