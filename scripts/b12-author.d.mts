/**
 * Hand-written declarations for `scripts/b12-author.mjs`, in the one place a
 * reader would look — the same arrangement as `b12-run.d.mts`, and the same
 * caveat: this is NOT a guarantee the `.mjs` matches. Only the tests are.
 */

/** The spec, validated shape-first — every refusal named before git runs. */
export function parseAuthorSpec(
  specDir: string
):
  | {
      ok: true;
      spec: {
        taskId: string;
        parent: string;
        message: string;
        fileScope: string[];
        patchPath: string;
        predicate: { argv: string[]; expectedExit: number; timeoutMs: number };
      };
    }
  | { ok: false; why: string };

/**
 * One spec directory → one sibling commit, born DETACHED (no ref moves), held
 * to five named checks: declared-parent topology, green parent, defect
 * present (predicate fails at the patched tree), scope confinement on both
 * the working tree and the commit, and the committed tree equal to an
 * independent index-route recompute (catches checkout filters).
 *
 * PUBLISHING IS NOT PART OF IT. This function still moves no ref; it only
 * READS the corpus tag first, as a courtesy, so a taken id refuses before a
 * checkout rather than after five checks.
 *
 * `taskId` and `message` come back with the result so a caller never re-reads
 * the spec directory to learn them — a second read between authoring and
 * publishing can retarget a commit that already exists.
 */
export function authorSibling(
  repoRoot: string,
  specDir: string
):
  | { ok: true; commit: string; tree: string; parent: string; changed: string[]; taskId: string; message: string }
  | { ok: false; why: string };

/**
 * True siblings: every commit has exactly ONE parent and all parents are the
 * same commit. Returns [] or the reasons.
 */
export function verifySiblings(repoRoot: string, commits: readonly string[]): string[];

// ---------------------------------------------------------------------------
// The corpus's refs.
// ---------------------------------------------------------------------------

export const CORPUS_TAG_PREFIX: string;
export const RETIRED_TAG_PREFIX: string;
export const DEFAULT_SPEC_ROOT: string;

/** The tag and ref names for a task id, PURE — SAFE_ID held as a ref component. */
export function corpusTagFor(
  taskId: string
): { ok: true; tag: string; ref: string } | { ok: false; why: string };

/**
 * What the corpus tag names, or `commit: null` when it does not exist. A tag
 * that exists but does not peel to a commit is a REFUSAL, never "absent".
 */
export function readCorpusTag(
  repoRoot: string,
  taskId: string
): { ok: true; tag: string; ref: string; commit: string | null } | { ok: false; why: string };

/**
 * Create-only publication, by `git tag`'s own refusal. THE FAILURE ARM ALWAYS
 * CARRIES THE COMMIT — this runs after a real object exists, and dropping the
 * sha would strand it.
 */
export function publishSibling(
  repoRoot: string,
  taskId: string,
  commit: string,
  message?: string | null
):
  | { ok: true; tag: string; ref: string; commit: string }
  | { ok: false; why: string; commit: string };

/**
 * Free a task id without ever leaving its base unreferenced: the retired tag
 * is created and read back BEFORE the corpus tag is removed.
 */
export function retireCorpusTag(
  repoRoot: string,
  taskId: string
): { ok: true; retired: string; freed: string; commit: string } | { ok: false; why: string };

/** The exact push/fetch commands, exported so the oracle pins them. */
export function transportLines(remote?: string): { push: string; fetch: string };

/**
 * Every reason a published corpus would fail where failing costs money.
 * Returns [] or the reasons. `deep` re-runs each predicate at each base and
 * belongs on the RUN machine.
 */
export function corpusVerification(
  repoRoot: string,
  plan: {
    tasks: readonly { id: string; specDir: string }[];
    ratesSha256?: string;
    specRoot?: string;
    deep?: boolean;
  }
): string[];
