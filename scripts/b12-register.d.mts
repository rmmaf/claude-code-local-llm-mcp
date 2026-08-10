/**
 * Hand-written declarations for `scripts/b12-register.mjs`, in the one place
 * a reader would look — the same arrangement as `b12-run.d.mts`, and the same
 * caveat: this is NOT a guarantee the `.mjs` matches. Only the tests are.
 */

/** The pure half of `check`: every red reason over the loaded artifacts. */
export function checkCore(
  manifestA: unknown,
  manifestB: unknown,
  pilot: unknown | null
): string[];

/**
 * The registration act as a compare-and-swap at the branch ref. New bytes
 * become blobs, lie into a TEMPORARY index over expectedHead's tree, commit
 * with `-p expectedHead`, and install only if the ref still points there.
 * After a successful swap the act is DONE — `postFailure` reports a later
 * sync problem without unsaying the registration. The post-swap sync is
 * CONDITIONAL: a path whose disk bytes moved past `diskBefore` (the caller's
 * capture snapshot; entry-time here when omitted) is preserved and reported,
 * never checked out over.
 */
export function casCommit(
  repoRoot: string,
  input: {
    candidates: Array<{ path: string; bytes: string; diskBefore?: string | null }>;
    message: string;
    expectedHeadOverride?: string | null;
    /** The full symbolic ref captured before validation; a mismatch at swap
     * time refuses — two branches can share one commit. */
    refOverride?: string | null;
  }
):
  | { ok: true; commit: string; postFailure?: string }
  | { ok: false; why: string };

/**
 * The seal — `evidence/b12-harness-seal.json`, CREATE-ONLY on disk AND in
 * history, refusing a manifest without explicit `perArmTimeoutMs`/`extraArgs`
 * and a harness whose disk bytes differ from HEAD's.
 */
export function sealHarness(
  repoRoot: string,
  manifestPath: string
):
  | {
      ok: true;
      path: string;
      seal: {
        schema: string;
        sealedAt: string;
        b12RunSha256: string;
        perArmTimeoutMs: number;
        extraArgs: unknown[];
      };
    }
  | { ok: false; why: string };

/** The anti-stale-dist gate: a fresh build, or a thrown refusal. */
export function freshBuild(repoRoot: string, command?: string | null): void;

/**
 * The act: capture `expectedHead` and the candidate bytes FIRST, validate
 * exactly those (old inputs from `<expectedHead>:<path>`), CAS-commit the
 * same buffers. `gate` and `afterCapture` are the oracle's seams — the CLI
 * passes neither; `afterCapture` runs between validation and the CAS.
 */
export function registerRun(
  repoRoot: string,
  runId: string,
  opts?: {
    gate?: (repoRoot: string, runId: string) => Promise<string[]>;
    afterCapture?: () => void | Promise<void>;
  }
): Promise<
  | { ok: true; commit: string; postFailure?: string }
  | { ok: false; red?: string[]; why?: string }
>;
