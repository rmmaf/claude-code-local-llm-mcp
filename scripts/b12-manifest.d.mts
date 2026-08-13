/**
 * Declarations for `scripts/b12-manifest.mjs`.
 *
 * `scripts/**` is outside `tsconfig.json`'s `include`, so the oracle's import
 * THROUGH this file is the only thing that typechecks the assembler's surface.
 * A drift between these signatures and the module is invisible to `tsc` unless
 * a test actually uses the shape — which is why the oracle destructures rather
 * than passing values straight through.
 */

export const DEFAULT_CONFIG_PATH: string;
export const TASK_KEY_ORDER: readonly string[];
export const DERIVED_TASK_FIELDS: readonly string[];

/** Every reason an argv would not survive the join/split round trip, or cmd.exe. */
export function argvGrammarReasons(taskId: string, argv: unknown): string[];

/** The scorer's enums and per-cell floor, PARSED out of `src/cost/b12/**`. */
export function frozenScoringFacts(
  repoRoot: string
):
  | { ok: true; verificationStrata: string[]; subagentStrata: string[]; minDeliveryObservations: number }
  | { ok: false; why: string };

export interface ManifestPair {
  id: string;
  taskId: string;
  order: "treatment-first" | "control-first";
}

export interface ManifestConfig {
  specRoot: string;
  manifestA: string[];
  manifestB: string[];
  pilot: string[];
  runIdA: string;
  runIdB: string;
  pilotRunId: string;
  abPairsA: ManifestPair[];
  abPairsB: ManifestPair[];
  pinned: Record<string, unknown>;
  configPath: string;
}

/** Run-level config only. Refuses an A n B intersection (PREMISES.md § B12, seventh decision). */
export function parseManifestConfig(
  repoRoot: string,
  configPath: string
): { ok: true; config: ManifestConfig } | { ok: false; why: string };

export interface ManifestTask {
  id: string;
  prompt: string;
  promptSha256: string;
  baseCommit: string;
  verificationStratum: string;
  expectedSubagentStratum: string;
  acceptance: string[];
  acceptanceExpectedExit: number;
  verificationCommands: string[];
  gateCategory: string;
  repairMaxRounds: number;
  fileScope: string[];
}

/** The spelling a run id enters `pinned.scoringCommand` through. */
export const RUN_ID_PLACEHOLDER: "<runId>";

export interface AssembledManifest {
  runId: string;
  /**
   * OPTIONAL BECAUSE IT IS ASYMMETRIC, not because it is unimportant. A and B
   * carry it so `b12-register.mjs:627` and `:740` stop resolving the pilot as
   * `manifestA?.pilotRunId ?? runId`; the five pilot manifests do not, because
   * nothing reads it there and it would only restate `runId`.
   */
  pilotRunId?: string;
  pinned: Record<string, unknown>;
  abPairs: ManifestPair[];
  tasks: ManifestTask[];
}

/**
 * One task's entry, DERIVED: `baseCommit` from the corpus tag, `acceptance`
 * from the spec's predicate, `promptSha256` from `prompt.md`. Never declared.
 */
export function deriveTask(
  repoRoot: string,
  specRoot: string,
  taskId: string,
  facts: { verificationStrata: string[]; subagentStrata: string[]; minDeliveryObservations: number }
): { ok: true; task: ManifestTask; parent: string } | { ok: false; reasons: string[] };

/** Deterministic bytes — two-space JSON, trailing newline, and it throws on a CR. */
export function manifestBytes(value: unknown): string;

export function assembleManifests(
  repoRoot: string,
  config: ManifestConfig
):
  | {
      ok: true;
      manifestA: AssembledManifest;
      manifestB: AssembledManifest;
      pilots: { taskId: string; manifest: AssembledManifest }[];
      facts: { verificationStrata: string[]; subagentStrata: string[]; minDeliveryObservations: number };
    }
  | { ok: false; reasons: string[] };

/** Everything `observe` would otherwise charge a paid session to discover. */
export function assemblyRefusals(
  repoRoot: string,
  config: ManifestConfig,
  built: {
    manifestA: AssembledManifest;
    manifestB: AssembledManifest;
    pilots: { taskId: string; manifest: AssembledManifest }[];
    facts: { verificationStrata: string[]; subagentStrata: string[]; minDeliveryObservations: number };
  }
): string[];

/** The reds that only RUNNING the pilot can satisfy — named, never dropped. */
export function deferredRefusals(): string[];

export function outputPaths(config: ManifestConfig): { manifestA: string; manifestB: string; pilots: string[] };
