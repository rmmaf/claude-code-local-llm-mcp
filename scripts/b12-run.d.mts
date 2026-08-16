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
export function takeSnapshot(
  rootOverride?: string,
  identity?: { runId: string; taskId: string; arm: string; sessionId: string; phase: string } | null
): {
  ts: string;
  /** Present exactly when the caller stamped one — see the scorer's checks. */
  identity?: { runId: string; taskId: string; arm: string; sessionId: string; phase: string };
  slugsWalked: number;
  slugs: string[];
  /**
   * WHICH slugs carry WHICH admitted ids — the populations of the
   * covered-vs-written predicate (`voidConditions` 6/14). By PRESENCE, before
   * the uuid dedup: a resumed session's copy in a second slug carries the same
   * id, and that presence is exactly what "the run wrote to it" means.
   */
  slugRequestIds: Record<string, string[]>;
  files: number;
  billableRecords: number;
  fileHashes: Array<{ path: string; sha256: string }>;
  requestIds: string[];
};

/**
 * admissionRule 7's grammar, the harness's copy — the scorer's twin is
 * `src/cost/b12/filescope.ts` and the conformance suite compares the two.
 */
export const PROTECTED_SCOPES: string[];
export function parseScopeEntry(
  raw: unknown
): { ok: true; kind: "file" | "dir" | "recursive"; segments: string[] } | { ok: false; error: string };
export function scopesIntersect(
  a: { kind: string; segments: string[] },
  b: { kind: string; segments: string[] }
): boolean;
export function fileScopeViolations(
  tasks: Array<{ id: string; fileScope: readonly unknown[] | null }>
): string[];

/**
 * Artifact 4's pilot pieces: the field→source→applicability table over the
 * frozen covariate list, the "No units, no bracket" shape guard (aggregates
 * and brackets refused at any depth; per-observation unit-valued covariates
 * pass — the registered reading, FINDINGS.md), and the one-file appender.
 */
export const PILOT_COVARIATE_TABLE: Array<{
  covariate: string;
  source: string;
  applicability: string;
}>;
export const PILOT_FORBIDDEN_KEYS: string[];
export function assertPilotShape(value: unknown): void;
export function buildPilotRecord(
  observation: Record<string, unknown>,
  archiveData: { telemetry: unknown[]; lineage: unknown[] }
): Record<string, unknown>;
export function appendPilotRecord(
  repoRoot: string,
  runId: string,
  record: Record<string, unknown>,
  opts?: {
    lockAttempts?: number;
    lockWaitMs?: number;
    /** Test seam: fires with the staged temp still on disk, before the re-read. */
    beforeWrite?: (info: { file: string; tmp: string; atRead: string | null }) => void;
  }
): Promise<string>;

/**
 * The registration guard: every reason `observe` may not spend a session —
 * the canonical manifest byte-identical across disk/HEAD/registration commit,
 * the same-act proof (one introducing commit for manifest AND row), and
 * MEASUREMENTS.jsonl held by BYTE PREFIX, never whole-file identity.
 */
export function registrationGuard(
  repoRoot: string,
  runId: string,
  manifestBytesOnDisk: string
): string[];

/**
 * The session id, unique per attempt by construction (nonce beside the
 * one-second stamp), and the cross-process claim that makes a same-task race
 * a refusal. The audit's clause-5 anchor requires the runlog join bijective.
 */
export function mintSessionId(manifestSha: string, runId: string, taskId: string, arm: string): string;
export function acquireSessionLock(
  evidenceDir: string,
  runId: string,
  taskId: string,
  arm: string
): { ok: boolean; lockDir: string; release: () => void };

/**
 * The closed classification of one arm's outcome. `scripts/b12-run.mjs`.
 *
 * `coveredSlugs`/`writtenSlugs` are the SETS of `voidConditions` 6/14's "a run
 * whose snapshot covered fewer slugs than it wrote to" — counts cannot express
 * it, and the shrink check is a different fact. REQUIRED: the rule fails
 * CLOSED with a named reason when either population is not handed to it.
 */
export function classifyRun(input: {
  exitCode: number | null;
  signal: string | null;
  errorCode: string | null;
  budgetMs: number;
  budgetEnforced?: boolean;
  originatedCount: number;
  slugsBefore: number;
  slugsAfter: number;
  coveredSlugs: string[];
  writtenSlugs: string[];
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
 * The observation directory name for attempt N — `obs-<taskId>-<arm>` for the
 * first, `obs-<taskId>-<arm>-r<N>` for `admissionRule` 12's re-run. The
 * scorer's `parseObsDirName` reads the same grammar back.
 */
export function obsDirName(taskId: string, arm: string, attempt: number): string;

/**
 * Claim the observation directory ATOMICALLY — a non-recursive `mkdirSync` is
 * the claim, `EEXIST` loses the race and tries the next attempt. Closes the
 * concurrent-observe overwrite the third adversarial round found.
 */
export function claimObsDir(
  runEvidenceDir: string,
  taskId: string,
  arm: string
): { dir: string; attempt: number };

/**
 * The per-arm policy blob resolved from GIT PROVENANCE: the manifest seals
 * `{repo, commit, path, sha256}` per arm and delivery reads the object store
 * (`git -C <repo> cat-file blob <commit>:<path>`) — no live file exists to
 * move mid-arm. Refusals name the failing leg: tuple shape, containment
 * (a repo inside the repository under test), transport (missing repo, shallow
 * clone, unreachable commit or path), non-UTF-8 bytes, or the sealed hash.
 */
export function findPolicyBlob(
  manifest: unknown,
  arm: "treatment" | "control"
): {
  blob: {
    /** The locator as sealed — relative locators resolve against the repo under test's root. */
    repo: string;
    /** The locator resolved to an absolute directory. */
    repoDir: string;
    commit: string;
    path: string;
    sha256: string;
    /** The delivered bytes, decoded — refused earlier unless the round-trip is exact. */
    content: string;
    /** `<repo>@<commit>:<path>` — the display form for records and refusals. */
    declaredPath: string;
  } | null;
  why: string | null;
};

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
 * Artifact 6's barrier at the next task's START: the disk runlog must be
 * byte-identical to HEAD's committed copy (null = absent). A row appended but
 * not yet committed is not an ordering predecessor; both directions refuse.
 * Pure.
 */
export function runlogBarrierViolation(diskText: string | null, headText: string | null): string | null;

/**
 * One RUN-WIDE `mkdir` claim, held only across [re-check, append, commit,
 * verify]. The session lock is keyed by (runId, taskId, arm) and so lets two
 * observations of different tasks interleave; this one does not.
 */
export function acquireRunlogLock(
  evidenceDir: string,
  runId: string
): { ok: boolean; lockDir: string; release: () => void };

/**
 * The runlog row and the evidence commit that carries it, as ONE act under
 * the run's commit lock: the barrier re-checked inside the mutex, byte
 * equality against what the barrier saw when this observation STARTED (a
 * different value means another observation ran inside this one, which
 * artifact 6 forbids), the sessionId bijection, the O_APPEND row, the CAS
 * install (`commit-tree` onto the tip this act read, `update-ref <ref> <new>
 * <expectedTip>`), and the blob-by-blob verify against THAT REF — the
 * artifacts AND the runlog, whose committed bytes must be exactly what the
 * barrier accepted plus this observation's single row.
 *
 * Returns its reason instead of refusing — a `process.exit` inside would
 * strand the lock for the whole run. `row` is written with a `ts` stamped at
 * the append, not at the call.
 */
export function commitObservationRow(
  repoRoot: string,
  input: {
    evidenceDir: string;
    runId: string;
    runLogRel: string;
    relDir: string;
    written: string[];
    row: Record<string, unknown>;
    sessionId: string;
    message: string;
    runlogAtBarrier: string | null;
    /**
     * The branch captured when the observation STARTED. Under the lock the
     * act refuses if HEAD no longer names it (or is detached), and every
     * post-commit verification reads THIS ref rather than HEAD — a commit
     * that landed elsewhere is a paid observation the run cannot find.
     */
    branchRef?: string;
    /** Test seam: fired between the append and the CAS install. */
    beforeInstall?: () => Promise<void> | void;
    /** Test seam: fired after the ref is installed, before the index refresh. */
    beforeIndexSync?: () => Promise<void> | void;
    lockAttempts?: number;
    lockWaitMs?: number;
  }
): Promise<
  | {
      ok: true;
      /**
       * Housekeeping the act declined to do, never a failure: the real index
       * is only refreshed while this worktree still holds the captured ref at
       * the installed commit. A checkout during the act leaves the index
       * alone and says so here.
       */
      note: string | null;
    }
  | { ok: false; why: string }
>;

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
 * Invalidity reasons for a repair call that did not run at the manifest's frozen
 * `repairMaxRounds` (artifact 1). Compares `detail.max_rounds` on every archived
 * `repair` telemetry row against the declared value; fail-closed when the field
 * is absent, empty when there are no repair rows at all. Pure.
 */
export function repairRoundsReasons(
  declared: number | null | undefined,
  telemetry: ReadonlyArray<Record<string, unknown>> | null | undefined,
  taskId: string
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
    /** DUAL — both arms deliver their own blob via --append-system-prompt,
     * so both blobs sit inside the measured delta. */
    policyBlobSha256s: { treatment: string | null; control: string | null };
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
    policyBlobSha256s: { treatment: string | null; control: string | null };
    extraArgs: readonly string[];
  }
): InstalledCharsRecord;

/** A normalised run toolchain identity — major.minor only, by amendment. */
export interface BarrierToolchain {
  platform: string;
  arch: string;
  node: string;
  vitest: string;
}

/** This machine's toolchain, in the producers' shape. */
export function runToolchainNow(): {
  platform: string;
  arch: string;
  nodeVersion: string;
  vitest: string | null;
};

/** Normalise either the producers' or the manifest's shape; null when unreadable. */
export function normaliseToolchainForBarrier(raw: unknown): BarrierToolchain | null;

/**
 * The barrier's verdict: a refusal message, or null when there is nothing to
 * refuse. An UNDECLARED `runToolchain` returns null — the amendment does not
 * reach a manifest that never declared one — while a DECLARED but unreadable
 * one refuses, because silence must not be mistaken for agreement.
 */
export function runToolchainRefusal(
  /** The manifest's whole `pinned` block — it carries many other keys, and the
   *  ABSENCE of `runToolchain` among them is what means "not governed". */
  pin: Readonly<Record<string, unknown>> | null | undefined,
  observedRaw: unknown
): string | null;
