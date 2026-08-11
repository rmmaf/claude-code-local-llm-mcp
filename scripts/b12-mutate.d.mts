/**
 * Declarations for `b12-mutate.mjs`, the mutation harness's runner.
 *
 * Same bargain as `b12-run.d.mts` and `b12-firing.d.mts`: the implementation
 * stays plain `.mjs`, `tsconfig.json` covers `tests/**`, and an undeclared
 * `.mjs` import under `strict` is an implicit `any`.
 */
import type { ControlRef } from "./b12-firing.mjs";

/**
 * One registered pair. `why` is on the artifact's face because a reader has to
 * be able to judge whether the mutation is the defect it claims to be.
 */
export interface MutationPair {
  id: string;
  control: ControlRef;
  why: string;
  subject: {
    path: string;
    /** EXACT literal. Never a regex — R35 shipped a mutant that matched nothing. */
    find: string;
    replace: string;
    /** Required count. A different count is `applied: false`, not a quiet edit. */
    occurrences: number;
  };
}

/**
 * The clause-6 set: six pairs, each mutation THE HISTORICAL BUG its control was
 * written against, so no mutant is derived from a fixture and every one is
 * production-reachable by construction.
 */
export const REGISTRY: MutationPair[];

/**
 * Return the tree to a PROVED-pristine state and rebuild `dist/` from scratch.
 * `git clean -xfd` is what removes the ignored `dist/`, which `checkout` alone
 * would leave holding the previous mutant; `status --porcelain` must be empty.
 */
export function makePristine(treeDir: string): { ok: boolean; why: string | null };

export function applyMutation(
  treeDir: string,
  subject: MutationPair["subject"]
): { applied: true; notApplied: null; beforeSha256: string } | { applied: false; notApplied: string };

export function runConformance(
  treeDir: string,
  controlFile: string,
  opts: { expectFailures: boolean }
): { ok: boolean; why: string | null; report: unknown };

/**
 * 1 + 2N runs: one baseline, then per pair a pristine bookend and a mutant.
 * `generatedAt` is REQUIRED and never defaulted to the clock — the artifact has
 * to be byte-stable across re-runs of the same inputs.
 */
export function runHarness(input: {
  repoRoot: string;
  commit?: string;
  runId: string;
  generatedAt: string;
  registry?: MutationPair[];
  keepTree?: boolean;
}): Promise<Record<string, unknown>>;
