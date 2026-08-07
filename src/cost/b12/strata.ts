/**
 * UNIT 1 — the subagent share, and the partition the four strata cells are
 * computed over. Specified by `docs/b12-scorer/UNIT-1.md`; this header said
 * "UNIT 2" until 2026-08-07 and `terms.ts` said "UNIT 1", which is the wrong way
 * round in both files.
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
  /**
   * Observations whose `verificationStratum` is not one of the two declared
   * values. In NEITHER `testRed` nor `typesOnly`, for the same reason as above.
   *
   * NOT THE SAME KIND OF THING AS `unevaluableShare`, and the difference decides
   * what `aggregate.ts` does with each. An unevaluable share is a MEASURED
   * ABSENCE — the window originated no billed request, so it genuinely belongs
   * to neither cell, and `solo`/`multi` stay evaluable without it. An
   * unrecognised stratum is a CORRUPTED DECLARATION: the observation belongs to
   * one of the two cells and nobody can say which, so both declared cells are
   * unevaluable while this array is non-empty. Deflating a cell by an unknown
   * count is the failure `holdsIf` 3 cannot see, because it asks whether four
   * cells are evaluable and not whether they hold what they claim to.
   */
  unknownStratum: ObservationTerms[];
}

/**
 * Split the admitted terms into the four cells `holdsIf` 3 requires.
 *
 * The verification stratum is DECLARED per task in the manifest before the run
 * and is read off the observation; it is never inferred from what the gate did,
 * because inferring it after the fact lets the result choose its own cell.
 *
 * Declared is not the same as validated. Nothing in this repository checks that
 * field against its two legal values — the reader for `observation.json` has not
 * been written — so a typo arrives here as an ordinary string and leaves in
 * `unknownStratum` rather than nowhere at all.
 */
export function partitionByStrata(terms: readonly ObservationTerms[]): StrataPartition {
  const testRed: ObservationTerms[] = [];
  const typesOnly: ObservationTerms[] = [];
  const solo: ObservationTerms[] = [];
  const multi: ObservationTerms[] = [];
  const unevaluableShare: ObservationTerms[] = [];
  const unknownStratum: ObservationTerms[] = [];

  for (const t of terms) {
    // WIDENED ON PURPOSE, AND THE `else` IS THE POINT. `verificationStratum` is
    // typed as a two-value union, but it is READ from the manifest's
    // `observation.json` and nothing in this repository validates it, so the
    // union is a claim about the manifest rather than a guarantee from the
    // compiler. Without the widening `tsc` narrows the third branch to `never`
    // and the code cannot say what it does with a value the rule does not name.
    // This is not a redundant branch to be simplified away.
    const declared: string = t.verificationStratum;
    if (declared === "test-red") {
      testRed.push(t);
    } else if (declared === "types-only") {
      typesOnly.push(t);
    } else {
      unknownStratum.push(t);
    }

    if (t.subagentShare.evaluable === false) {
      unevaluableShare.push(t);
    } else if (t.subagentShare.value.stratum === "solo") {
      solo.push(t);
    } else if (t.subagentShare.value.stratum === "multi") {
      multi.push(t);
    }
  }

  return { testRed, typesOnly, solo, multi, unevaluableShare, unknownStratum };
}
