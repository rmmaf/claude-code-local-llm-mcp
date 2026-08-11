/**
 * Declarations for `b12-firing.mjs`, the mutation harness's evaluator.
 *
 * Same bargain as `b12-run.d.mts`: the implementation stays plain `.mjs` so it
 * runs under `node` with no build step, `tsconfig.json` covers `tests/**`, and
 * an undeclared `.mjs` import under `strict` is an implicit `any`. This is the
 * hand-written type in the one place a reader would look for it.
 *
 * It is NOT a guarantee that the `.mjs` matches. Only `tests/b12-firing.test.ts`
 * is — and that file exists precisely because R38#5 showed a harness whose
 * verdict logic is only exercised by running the real thing cannot be tested for
 * an INVERTED verdict, which would certify six broken controls.
 */

/** A control as clause 6 identifies it: `{file, fullName}`, never title alone. */
export interface ControlRef {
  file: string;
  fullName: string;
}

/** One declaration in a test file and the line range it owns, `endLine` exclusive. */
export interface Boundary {
  kind: "it" | "test" | "describe" | "beforeEach" | "beforeAll" | "afterEach" | "afterAll";
  title: string | null;
  startLine: number;
  endLine: number;
}

export function testBoundaries(sourceText: string): Boundary[];
export function hookRanges(sourceText: string): Boundary[];

/**
 * A duplicated title returns `ok: false` rather than a winner. `audit.ts:672`
 * already decided that question, and the probe confirmed vitest really does
 * report two distinct tests under one identical fullName.
 */
export function rangeOfTest(
  sourceText: string,
  title: string
): { ok: true; startLine: number; endLine: number } | { ok: false; reason: string };

export interface IndexedTest {
  file: string;
  fullName: string;
  title: string | null;
  status: string;
  failureMessages: string[];
}

/**
 * Duplicates are kept as a LIST, never collapsed — collapsing silently picks a
 * winner, which is the one thing the duplicate case forbids.
 */
export function indexRun(vitestJson: unknown): { byKey: Map<string, IndexedTest[]>; total: number };

export function lookupControl(
  index: { byKey: Map<string, IndexedTest[]> },
  control: ControlRef
): { ok: true; entry: IndexedTest } | { ok: false; reason: string };

/**
 * MEASURED, not assumed: a `beforeEach` failure and an assertion failure come
 * back shape-identical from this project's vitest, with `location` null on both.
 * The prefix separates a judgement from a crash; the body range separates the
 * control's own assertion from a hook that failed an `expect`.
 */
export function classifyFailure(
  entry: IndexedTest,
  controlFile: string,
  range: { startLine: number; endLine: number },
  hooks: Boundary[]
): { outcome: "fired" | "refused"; detail: string };

/** One registered (control, mutation) pair. */
export interface RegistryEntry {
  id: string;
  control: ControlRef;
  subject?: { path: string; find: string; replace: string; occurrences: number };
  /** Off-diagonal reddening allowed only where declared IN ADVANCE, with why. */
  collateral?: Array<{ fullName: string; reason: string }>;
}

/**
 * What the runner records per mutation. `applied` is not decoration: R35 shipped
 * a mutant whose regex matched nothing, and "the control held" is
 * indistinguishable from "the mutation was never there" unless the runner says.
 */
export interface MutantRun {
  applied: boolean;
  notApplied?: string;
  report: unknown;
}

export interface PairVerdict {
  id: string;
  control: ControlRef;
  subject: string | null;
  fired: boolean;
  outcome: "fired" | "refused";
  detail: string;
  offDiagonal: Array<{
    fullName: string;
    status: string;
    declared: string | null;
    ok: boolean;
    note?: string;
  }>;
  problems: string[];
}

export interface FiringArtifact {
  schema: "b12-firing/1";
  baseCommit: string;
  generatedAt: string;
  baseline: { allGreen: boolean; problems: string[] };
  pairs: PairVerdict[];
  firedCount: number;
  registeredCount: number;
  problems: string[];
  allFired: boolean;
}

/**
 * `sources` maps a control file to its text AT THE BASE COMMIT — never the
 * mutant's, because a mutation that edited the control file would move the
 * ranges out from under the verdict. `generatedAt` is an argument and never a
 * clock, so the artifact is byte-stable across re-runs of the same inputs.
 */
export function evaluateMatrix(input: {
  registry: RegistryEntry[];
  controls: readonly ControlRef[];
  baseline: unknown;
  mutants: Record<string, MutantRun | null | undefined>;
  sources: Record<string, string>;
  baseCommit: string;
  generatedAt: string;
}): FiringArtifact;
