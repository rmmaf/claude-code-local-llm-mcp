/**
 * Declarations for the parts of `b12-run.mjs` that `tests/cost-meter.test.ts`
 * exercises directly.
 *
 * The harness is plain `.mjs` and stays that way — it runs under `node` with no
 * build step, which is the point of it. But `tsconfig.json` now covers `tests/**`,
 * and importing an undeclared `.mjs` under `strict` is an implicit `any`: the
 * test was casting the module object to the shape it wanted, which is a
 * hand-written type that nothing checks against the implementation. This is the
 * same hand-written type, in the one place a reader would look for it, and
 * `tsc` at least holds the call sites to it.
 *
 * It is NOT a guarantee that the `.mjs` matches. Only the tests are.
 */

/**
 * The outcomes `classifyRun` can return, and there are exactly five.
 *
 * A CLOSED LIST, not `string`. The implementation decides by case over the
 * triple `spawnSync` returns "with no fall-through and every branch named",
 * after six defects landed in it while it was a chain of `&&`-ed predicates. A
 * `string` return here would let a test assert against a spelling that no branch
 * produces and pass — the exact shape of the `wallMs` argument this file was
 * written to kill.
 *
 * NOTE the absent `wallMs`: it is not a parameter. `b12-run.mjs` says so by
 * name — "nothing here is entitled to reason from duration" — after `wallMs`
 * standing in as evidence of who ended the process was repaired twice.
 */
export type ClassifiedOutcome =
  | "spawn_failed"
  | "censored"
  | "killed_by_signal"
  | "exited_nonzero"
  | "completed";

/** The closed classification of one arm's outcome. `scripts/b12-run.mjs`. */
export function classifyRun(input: {
  exitCode: number | null;
  signal: string | null;
  errorCode: string | null;
  budgetMs: number;
  budgetEnforced?: boolean;
  originatedCount: number;
  slugsBefore: number;
  slugsAfter: number;
}): { outcome: ClassifiedOutcome; censored: boolean; valid: boolean; reasons: string[] };
