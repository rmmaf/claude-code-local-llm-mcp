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
 */
export function authorSibling(
  repoRoot: string,
  specDir: string
):
  | { ok: true; commit: string; tree: string; parent: string; changed: string[] }
  | { ok: false; why: string };

/**
 * True siblings: every commit has exactly ONE parent and all parents are the
 * same commit. Returns [] or the reasons.
 */
export function verifySiblings(repoRoot: string, commits: readonly string[]): string[];
