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
}): { outcome: string; censored: boolean; valid: boolean; reasons: string[] };
