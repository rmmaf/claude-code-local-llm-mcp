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

/**
 * One machine's transcript corpus at an instant. `design.artifacts` 5.
 *
 * `fileHashes` is the clause's "per-file sha256", and it is what makes a
 * transcript rewritten between the pre- and post-snapshot visible: the artifact
 * previously carried a file COUNT and no list, and the frozen text says the
 * vendor rewrites these files.
 *
 * `rootOverride` exists so the same code that snapshots the machine can be
 * pointed at a fixture — the harness re-implements B20's admission rule because
 * it must run before `dist/` exists, and two implementations that are never
 * compared is how the meter and the oracle drifted apart four times.
 */
export function takeSnapshot(rootOverride?: string): {
  ts: string;
  slugsWalked: number;
  slugs: string[];
  files: number;
  billableRecords: number;
  fileHashes: Array<{ path: string; sha256: string }>;
  requestIds: string[];
};

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

/**
 * Every declaration `design.artifacts` 1 requires of the manifest that is
 * missing — the FULL inventory sweep (run-level pins, caps, scoring command,
 * per-task acceptance predicate with expected exit, verification commands,
 * strata, scopes). Two justification classes: F25's `verificationStratum`
 * route, and artifact-1 completeness for everything else. Pure; `observe`
 * refuses on a non-empty list, `preflight` reports it.
 */
export function manifestDeclarationGaps(manifest: unknown): string[];

/**
 * The probe artifact must be committed evidence: repo-relative under
 * `evidence/`, present in HEAD, and byte-identical to HEAD's blob. Closes the
 * reviewed trust boundary where a fabricated working-tree JSON could calibrate
 * `O_o`.
 */
export function committedEvidenceCheck(declaredPath: string): {
  ok: boolean;
  file: string | null;
  why: string | null;
};

/**
 * Whether running `taskId`'s treatment arm now would break the manifest's
 * committed order (`voidConditions` 3), judged against the persisted runlog
 * text. Returns the refusal reason, or null. Treatment-only by design —
 * control arms belong to the post-verdict A/B.
 */
export function committedOrderViolation(manifest: unknown, taskId: string, runlogText: string): string | null;

/**
 * Invalidity reasons for pre/post instruction-hash drift — every component
 * compared (CLAUDE.md, memory, settings, settings.local, passed MCP config,
 * policy blob), each with its frozen-text citation. Pure.
 */
export function instructionDriftReasons(
  pre: Record<string, string | null> | null | undefined,
  post: Record<string, string | null> | null | undefined
): string[];

/**
 * sha256 over sorted (relative path, content sha256) pairs, separators
 * normalised to "/". A missing or empty directory hashes as the empty list
 * with `files: 0`.
 */
export function hashMemoryDir(dir: string): { sha256: string; files: number };

/**
 * The treatment arm's calibrated installation term. ONE `O_o` — the control
 * arm never carries a value; see the implementation's header for why 0 would
 * be a second `O`.
 */
export interface InstalledCharsRecord {
  value: number;
  unit: "chars";
  adapter: string;
  deltaTokens: number;
  probeRunId: string;
  calibrationKey: {
    binarySha256: string;
    mcpConfigSha256: string | null;
    policyBlobSha256: string | null;
    extraArgs: string[];
    protocol: string;
  };
}

/**
 * Validates the committed probe artifact against the LIVE observation and
 * returns the provenance-carrying record, or THROWS with the failing
 * calibration-key component named. Pure — the negative controls fire on it
 * without spending a session.
 */
export function validateInstalledCharsProbe(
  probe: unknown,
  live: {
    binarySha256: string;
    mcpConfigSha256: string | null;
    policyBlobSha256: string | null;
    extraArgs: readonly string[];
  }
): InstalledCharsRecord;
