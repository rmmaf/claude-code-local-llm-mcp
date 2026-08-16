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

/**
 * One declaration and the EXACT line range of its callback body, inclusive.
 *
 * R39#2: this comes from a TypeScript parse, not a line scanner. The scanner it
 * replaced matched commented-out declarations on purpose and truncated the
 * enclosing test; a comment is not a CallExpression.
 */
export interface Boundary {
  kind: string;
  title: string | null;
  startLine: number;
  bodyStart: number;
  bodyEnd: number;
}

export function testBoundaries(sourceText: string, fileName?: string): Boundary[];
export function hookRanges(sourceText: string, fileName?: string): Boundary[];

/**
 * A duplicated title returns `ok: false` rather than a winner. `audit.ts:672`
 * already decided that question, and the probe confirmed vitest really does
 * report two distinct tests under one identical fullName.
 *
 * `endLine` is INCLUSIVE and is the body's last line.
 */
export function rangeOfTest(
  sourceText: string,
  title: string,
  fileName?: string
): { ok: true; startLine: number; endLine: number } | { ok: false; reason: string };

/**
 * A path — stack frame, `file://` URL, or reporter suite name — reduced to its
 * repo-relative form, or null when it lies outside the root.
 *
 * R39#3: suffix matching both missed real frames (Windows separators, file
 * URLs) and matched wrong ones, and this repository really does carry a
 * `tests/fixtures/` tree whose paths end in the same suffix.
 */
export function relativeTo(root: string, raw: string): string | null;

/** One `at …:line:col` stack frame. */
export function parseFrame(line: string): { path: string; line: number } | null;

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
export function indexRun(
  vitestJson: unknown,
  repoRoot?: string
): { byKey: Map<string, IndexedTest[]>; total: number };

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
  hooks: Boundary[],
  repoRoot: string
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
  /**
   * The RAW kill set outside the diagonal, whole. R43#2: annotations used to
   * WAIVE these, so "clean off-diagonal" meant "every red test was
   * whitelisted". They annotate now and waive nothing.
   */
  offDiagonalFailures: Array<{ file: string; fullName: string; annotation: string | null }>;
  specificityClean: boolean;
  problems: string[];
}

export interface FiringArtifact {
  schema: "b12-firing/1";
  baseCommit: string;
  generatedAt: string;
  /**
   * What the audit-side reader compares against `CONTROL_TESTS`. R39#1:
   * `allFired` quantifies over the controls it was HANDED, so on its own it
   * cannot say the six frozen controls fire — the set is published so the check
   * can live where the clause's own list lives.
   */
  controlsEvaluated: ControlRef[];
  baseline: { allGreen: boolean; problems: string[] };
  pairs: PairVerdict[];
  firedCount: number;
  registeredCount: number;
  problems: string[];
  /** SENSITIVITY — clause 6's frozen word FIRING, and all it ever meant. */
  allFired: boolean;
  /** SPECIFICITY — reported, deciding nothing. Requiring it would mint a condition. */
  specificityClean: boolean;
  offDiagonalKillCount: number;
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
  /** Frames and suite names are resolved against this, never suffix-matched. */
  repoRoot: string;
}): FiringArtifact;
