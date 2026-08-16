/**
 * `admissionRule` 7's file-scope predicate: "**No manifest task's file scope
 * may intersect `src/cost/**`, `scripts/session-token-walk.mjs`,
 * `evidence/**`, or the four governance documents** — declared at
 * pre-registration, not adjudicated during the run."
 *
 * THE POPULATION IS EVERY MANIFEST TASK — "no manifest task's" is the whole
 * pre-registered list, `not_started` and invalid declarations included, never
 * only the admitted twenty.
 *
 * THE GRAMMAR IS DEFINED, NOT ADJECTIVAL. Exactly three accepted forms: a
 * literal file, a directory prefix ending in `/`, and a recursive suffix
 * `/**`. Validation ORDER matters: the prohibited shapes (drive, UNC,
 * absolute) are rejected BEFORE `\` is normalized to `/`, and the terminal
 * marker is detached BEFORE the core segments are checked — otherwise the
 * lawful trailing `/` reads as the empty segment the grammar forbids.
 * Anything the grammar cannot place — `.`/`..`, empty segments, glob
 * characters outside a trailing `/**` — is a VIOLATION, never a guess.
 *
 * INTERSECTION IS SYMMETRIC ANCESTRY: a directory or recursive entry covers
 * everything under its segments; two entries intersect when either covers the
 * other, or when two literal files are the same file. `dir/` and `dir/**`
 * cover alike ON PURPOSE — a grammar where one of them quietly covered less
 * would be a hole spelled with a slash.
 *
 * SEGMENTS COMPARE CASE-FOLDED (ASCII lowercase): Windows and default macOS
 * filesystems alias case, so `SRC/COST/` names the same tree as `src/cost/**`
 * wearing different bytes — exact-equality comparison would admit it as
 * non-intersecting. The DECLARED form is preserved everywhere it is shown;
 * only the comparison folds. The protected set is ASCII, so ASCII folding is
 * exact for what the rule guards.
 *
 * THE OTHER WINDOWS ALIASES ARE REFUSED RATHER THAN FOLDED — trailing dots
 * and spaces (stripped by Win32, so `src/cost./**` opens `src/cost`), colons
 * (NTFS streams, drive-relative paths) and the `NAME~1` 8.3 shape. Case gets
 * folded because a case-shifted path is a lawful way to write it; these are
 * degenerate spellings no honest declaration uses, and a refusal is total
 * where a second folding rule would be one more thing for the two
 * implementations to agree about.
 *
 * The harness (`scripts/b12-run.mjs`) carries a SECOND implementation of this
 * rule because it must run before `dist/` exists; the two are compared
 * case-for-case by the conformance suite, which is this repository's answer
 * to every pair of copies that once drifted apart.
 */

/** The instrument set the frozen rule names. */
export const PROTECTED_SCOPES: readonly string[] = [
  "src/cost/**",
  "scripts/session-token-walk.mjs",
  "evidence/**",
  "PREMISES.md",
  "ROADMAP.md",
  "DECISIONS.md",
  "STATE.md",
  // ADDED 2026-08-12 — the harness twin carries the reasoning in full. In short:
  // this list is the gate a manifest passes through, and it did not enforce
  // task-mix decision 3, which names it. `PINNED_PATHS` and this list overlapped
  // in ONE item, and a task scoped to either of the two below was ACCEPTED
  // (measured). `src/tools/gate.ts` and `src/tools/repair.ts` are deliberately
  // NOT here: a scope entry intersects everything beneath it, so protecting them
  // would refuse `src/tools/` entirely — the product surface B12 measures.
  "src/telemetry.ts",
  "scripts/b12-run.mjs",
];

export type ParsedScope =
  | { ok: true; kind: "file" | "dir" | "recursive"; segments: string[] }
  | { ok: false; error: string };

export function parseScopeEntry(raw: unknown): ParsedScope {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "not a non-empty string" };
  }
  // Prohibited shapes BEFORE normalization — a drive letter or a UNC root is
  // refused as what it is, not laundered into a relative path by the `\` map.
  if (/^[A-Za-z]:/.test(raw)) return { ok: false, error: `drive-qualified path: ${raw}` };
  if (raw.startsWith("\\\\") || raw.startsWith("//")) return { ok: false, error: `UNC path: ${raw}` };
  if (raw.startsWith("/") || raw.startsWith("\\")) return { ok: false, error: `absolute path: ${raw}` };
  let s = raw.split("\\").join("/");
  // The terminal marker FIRST — the trailing `/` is grammar, not a segment.
  let kind: "file" | "dir" | "recursive" = "file";
  if (s.endsWith("/**")) {
    kind = "recursive";
    s = s.slice(0, -3);
  } else if (s.endsWith("/")) {
    kind = "dir";
    s = s.slice(0, -1);
  }
  if (s === "") return { ok: false, error: `no core segments: ${raw}` };
  const segments = s.split("/");
  for (const seg of segments) {
    if (seg === "") return { ok: false, error: `empty segment: ${raw}` };
    if (seg === "." || seg === "..") return { ok: false, error: `dot segment: ${raw}` };
    // WINDOWS ALIASES — REFUSED, not folded. Win32 strips TRAILING dots and
    // spaces from a path component, so `src/cost./**` opens `src/cost` while
    // comparing unequal to it; `:` names an NTFS data stream (`STATE.md::
    // $DATA`) or a drive-relative path; and `NAME~1.EXT` is the 8.3 short
    // name of a long one — `DECISIONS.md` and `session-token-walk.mjs` both
    // have one. Case is FOLDED because `SRC/COST/` is a lawful way to write
    // the path; these are not — no honest declaration ends a component in a
    // dot or a space — so refusing is total, and needs no second mechanism
    // in the comparison for the two implementations to keep agreeing.
    if (/[. ]$/.test(seg)) return { ok: false, error: `segment ends in a dot or space, which Windows strips: ${raw}` };
    if (seg.includes(":")) return { ok: false, error: `colon in a segment (NTFS stream or drive-relative): ${raw}` };
    if (/~[0-9]/.test(seg)) return { ok: false, error: `8.3 short-name alias shape: ${raw}` };
    if (/[*?[\]{}]/.test(seg)) return { ok: false, error: `glob outside a trailing /**: ${raw}` };
  }
  return { ok: true, kind, segments };
}

const isPrefix = (a: readonly string[], b: readonly string[]): boolean =>
  a.length <= b.length && a.every((seg, i) => seg.toLowerCase() === b[i]!.toLowerCase());

/** Either covers the other, or two literal files are one file. */
export function scopesIntersect(
  a: Extract<ParsedScope, { ok: true }>,
  b: Extract<ParsedScope, { ok: true }>
): boolean {
  const covers = (
    x: Extract<ParsedScope, { ok: true }>,
    y: Extract<ParsedScope, { ok: true }>
  ): boolean => x.kind !== "file" && isPrefix(x.segments, y.segments);
  if (covers(a, b) || covers(b, a)) return true;
  return (
    a.kind === "file" &&
    b.kind === "file" &&
    a.segments.length === b.segments.length &&
    isPrefix(a.segments, b.segments)
  );
}

/**
 * Every violation over EVERY task, one sentence each. Scope PRESENCE is the
 * declaration sweep's check, not this one's — a task with no `fileScope`
 * array contributes nothing here and fires there.
 */
export function fileScopeViolations(
  tasks: ReadonlyArray<{ id: string; fileScope: readonly unknown[] | null }>
): string[] {
  const out: string[] = [];
  const protectedParsed = PROTECTED_SCOPES.map((p) => {
    const parsed = parseScopeEntry(p);
    if (!parsed.ok) throw new Error(`the PROTECTED set does not parse itself: ${p}`);
    return { raw: p, parsed };
  });
  for (const task of tasks) {
    if (task.fileScope === null) continue;
    for (const raw of task.fileScope) {
      const parsed = parseScopeEntry(raw);
      if (!parsed.ok) {
        out.push(`task ${task.id}: file scope entry rejected by the grammar — ${parsed.error} (admissionRule 7)`);
        continue;
      }
      for (const p of protectedParsed) {
        if (scopesIntersect(parsed, p.parsed)) {
          out.push(`task ${task.id}: file scope ${String(raw)} intersects the instrument set at ${p.raw} (admissionRule 7)`);
        }
      }
    }
  }
  return out;
}
