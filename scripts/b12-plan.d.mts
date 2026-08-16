/**
 * Declarations for `b12-plan.mjs`, the corpus design's generator.
 *
 * Same bargain as its siblings: the implementation stays plain `.mjs` so it runs
 * under `node` with no build step, `tsconfig.json` covers `tests/**`, and an
 * undeclared `.mjs` import under `strict` is an implicit `any`.
 */

/**
 * The plan object, with every constraint already checked. THROWS rather than
 * exiting on a violation, which is the only reason a test can call it — the
 * scratch copy this replaced called `process.exit(1)` at module scope.
 */
export function buildPlan(): {
  _readme: string[];
  _multiCellGap: string[];
  specRoot: string;
  ratesSha256: string;
  parent: string;
  manifestA: string[];
  manifestB: string[];
  tasks: Array<{
    id: string;
    specDir: string;
    fileScope: string[];
    verificationStratum: "test-red" | "types-only";
    predicateArgv: string[];
    gateCategory: "test" | "types";
    verificationCommands: string[];
    expectedSubagentStratum: string;
  }>;
};

/** The exact bytes `b12-corpus/corpus-plan.json` should hold, newline included. */
export function planText(): string;

/**
 * `null` when the committed artifact IS generator output, otherwise the first
 * line that differs. This is what makes "generated and constraint-checked, not
 * hand-listed" a checkable claim rather than a sentence in a `_readme`.
 */
export function planDrift(): string | null;
