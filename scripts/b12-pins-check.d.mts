/**
 * Declarations for `b12-pins-check.mjs`, the pre-commit half of the KNOWN-HERE
 * pin check.
 *
 * Same bargain as `b12-run.d.mts` and `b12-firing.d.mts`: the implementation
 * stays plain `.mjs` so it runs under `node` with no build step, `tsconfig.json`
 * covers `tests/**`, and an undeclared `.mjs` import under `strict` is an
 * implicit `any`. This is the hand-written type in the one place a reader would
 * look for it, and it is NOT a guarantee that the `.mjs` matches — only
 * `tests/b12-pins-check.test.ts` is.
 */

/** One KNOWN-HERE pin and the path whose staged bytes it must name. */
export interface IndexPin {
  readonly pin: string;
  readonly subject: string;
}

/**
 * A tree entry that is present but cannot carry a content pin — a symlink
 * (120000) or a gitlink (160000). Kept as its raw shape so the refusal can name
 * what it found instead of hashing the wrong object.
 */
export interface UnhashableEntry {
  readonly mode: string;
  readonly type: string;
}

/**
 * A pin that disagrees with the tree, with both sides kept for the message.
 * `declared` is the config's value rendered for display — the raw string when it
 * is one, its JSON otherwise, and `null` when the key is absent entirely.
 */
export interface PinMismatch {
  readonly pin: string;
  readonly subject: string;
  readonly declared: string | null;
  readonly measured: string | null;
  readonly why: string;
}

/** An unaskable git, as distinct from an answer about a pin. */
export declare class GitUnaskable extends Error {}

/**
 * The pins this guard covers. `ratesSha256` is deliberately absent: the CI alarm
 * compares it at `plan.parent`, a fixed commit, not at HEAD.
 */
export declare const INDEX_PINS: readonly IndexPin[];

/** sha256 of a byte buffer, hex. */
export declare function sha256(bytes: Uint8Array | string): string;

/**
 * PURE. One entry per pin that disagrees. An absent pin, an absent tree entry
 * and a non-regular-file entry are all mismatches, never skips. Tolerates a
 * `declared` that is not an object.
 */
export declare function pinMismatches(
  measured: Readonly<Record<string, string | UnhashableEntry>>,
  declared: unknown
): PinMismatch[];

/** Freeze what is staged into an immutable tree and return its id. */
export declare function writeTree(repo: string): string;

/**
 * sha256 of every subject as it stands in `tree`. Absent where the tree has no
 * such path; an `UnhashableEntry` where the path is not a regular file.
 * Throws `GitUnaskable` rather than returning, so an unreadable object can never
 * be reported as a stale pin.
 */
export declare function readTreeSubjects(
  repo: string,
  tree: string,
  pins?: readonly IndexPin[]
): Record<string, string | UnhashableEntry>;

/** The manifest config as it stands in `tree`. Throws unless it is an object. */
export declare function readTreeConfig(
  repo: string,
  tree: string,
  rel?: string
): { pinned?: unknown };
