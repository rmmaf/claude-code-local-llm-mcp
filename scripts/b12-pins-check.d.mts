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

/** A pin that disagrees with the index, with both sides kept for the message. */
export interface PinMismatch {
  readonly pin: string;
  readonly subject: string;
  readonly declared: string | null;
  readonly measured: string | null;
  readonly why: string;
}

/**
 * The pins this guard covers. `ratesSha256` is deliberately absent: the CI alarm
 * compares it at `plan.parent`, a fixed commit, not at HEAD.
 */
export declare const INDEX_PINS: readonly IndexPin[];

/** sha256 of a byte buffer, hex. */
export declare function sha256(bytes: Uint8Array | string): string;

/**
 * PURE. One entry per pin that disagrees. An absent pin and an absent index
 * entry are both mismatches, never skips.
 */
export declare function pinMismatches(
  measured: Readonly<Record<string, string>>,
  declared: Readonly<Record<string, unknown>>
): PinMismatch[];

/** sha256 of every subject as it stands IN THE INDEX. Absent where unstaged. */
export declare function readIndexSubjects(
  repo: string,
  pins?: readonly IndexPin[]
): Record<string, string>;

/** The manifest config AS STAGED, so a partial staging cannot pass. */
export declare function readIndexConfig(repo: string, rel?: string): { pinned?: Record<string, unknown> };
