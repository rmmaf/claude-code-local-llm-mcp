/**
 * Scoring for the whole-file output contract — the rules `scripts/contract-stability.ts`
 * applies to each response, kept here rather than in the script for two reasons:
 * `tsconfig.json` covers `src/**` only, so scripts are outside `tsc` and outside
 * `gate`; and a detector with false positives silently corrupts every number the
 * diagnostic reports, which makes it exactly the kind of thing that needs tests.
 *
 * The contract is IMPLEMENT_SYSTEM_PROMPT's: "Return the COMPLETE final content
 * of EVERY editable file listed in the request". A response either honours it,
 * elides part of a file, or stops early.
 */
import { diffStats, unifiedFileDiff } from "./diff.js";
import { normalizeRel, parseFileBlocks } from "./parse.js";

/** Distinctive enough that its presence in a response is never ambiguous. */
export const PROBE_MARKER = "// contract-probe: do-not-commit";

/**
 * The probe task. Appending one comment is the only edit a model cannot perform
 * without emitting the whole file first, so the marker's presence is itself
 * evidence the traversal finished — and because the spec adds exactly one line,
 * every DELETED line in a response is content the model chose to drop rather
 * than work the spec asked for.
 */
export const PROBE_SPEC =
  `Append the following comment as the last line of every editable file, exactly as written:\n\n` +
  `${PROBE_MARKER}\n\n` +
  `Change nothing else: no reformatting, no renaming, no reordering, no other edits of any kind. ` +
  `Every other line of every file must come back byte-for-byte identical to the input.`;

/**
 * A line that is nothing but an ellipsis, bare or wrapped in comment syntax:
 * `...`, `// ...`, `# …`, `/* ... *\/`, `<!-- ... -->`. This is the elision small
 * models emit most often, and as a whole line it has no reading as real code —
 * TypeScript's `...spread` never stands alone.
 */
const ELLIPSIS_ONLY = /^(?:\/\/+|#+|\*|\/\*+|<!--)?\s*(?:\.{3,}|…)\s*(?:\*\/|-->)?$/;

/** A line that opens as a comment — the only place tier-B phrasing counts. */
const COMMENT_ONLY = /^(?:\/\/|#|\*|\/\*|<!--)/;

/**
 * Phrasings that stand in for content the model declined to reproduce. Tested
 * only against comment-only lines, and only against lines the original does not
 * already contain: this repo's own source is full of legitimate prose about
 * leaving files "unchanged" (`src/tools/shared.ts`) and about truncation
 * (`src/llm-client.ts`), and matching those would score a faithful echo as an
 * elision.
 */
const ELISION_PHRASES: RegExp[] = [
  /(?:rest|remainder) of (?:the )?(?:file|code|content|function|method|class|implementation|module)/i,
  /(?:code|content|lines|body|implementation|imports?|functions?) (?:remains?|stays?|are|is)? ?(?:unchanged|the same|as before|omitted|identical)/i,
  /unchanged (?:from|as in) (?:the )?(?:original|above|before|input)/i,
  /\bomitted\b/i,
  /\bsnip+ed?\b/i,
  /same as (?:before|above|the original|input)/i,
  /existing (?:code|content|implementation)/i,
  /for brevity/i,
  /no changes? (?:here|below|above|needed|required)/i,
  /\(unchanged\)/i,
];

export interface ElisionMarker {
  line: number;
  text: string;
  tier: "ellipsis" | "phrase";
}

/**
 * Elision markers in `returned` that are NOT already lines of `original`.
 *
 * The novelty test is what makes this usable on a repo that discusses this very
 * format: `src/parse.ts` ships the line `...entire final file content...`, and a
 * faithful echo of that file must not score as an elision.
 */
export function findElisionMarkers(original: string, returned: string): ElisionMarker[] {
  const known = new Set(original.split(/\r?\n/).map((l) => l.trim()));
  const markers: ElisionMarker[] = [];
  const lines = returned.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed === "" || known.has(trimmed)) continue;
    if (ELLIPSIS_ONLY.test(trimmed)) {
      markers.push({ line: i + 1, text: trimmed, tier: "ellipsis" });
    } else if (COMMENT_ONLY.test(trimmed) && ELISION_PHRASES.some((re) => re.test(trimmed))) {
      markers.push({ line: i + 1, text: trimmed, tier: "phrase" });
    }
  }
  return markers;
}

/**
 * Longest run of consecutive deleted lines in a unified diff — the sharpest
 * signal of SILENT elision, content dropped with no comment admitting it, which
 * the marker detector cannot see at all.
 */
export function longestDeletedRun(diffText: string): number {
  let longest = 0;
  let run = 0;
  let inHunk = false;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git")) {
      inHunk = false;
      run = 0;
    } else if (line.startsWith("@@")) {
      inHunk = true;
      run = 0;
    } else if (inHunk && line.startsWith("-")) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/**
 * Deleted-line runs below this are read as reformatting, not elision. A model
 * that reflows a signature removes a line and adds it back; a model that drops
 * a function body removes many in a row. Three is the smallest run that cannot
 * be one line rewritten — and every row carries the raw counts, so a reader who
 * dislikes this number can re-score without re-running the model.
 */
export const SILENT_ELISION_MIN_RUN = 3;

/**
 * Did this request fill the model's context window? Null means the window is
 * unknown and the question cannot be answered — the same fail-open discipline
 * `pickLoadedContextTokens` applies, and for the same reason: a guess here would
 * label a healthy response a failure.
 *
 * WHY THIS AND NOT `finish_reason`. B14 asked for `finish_reason: "length"` and
 * got **0 across 5 real failures**. That is not one server behaving oddly. In
 * the OpenAI specification `length` means *`max_tokens` was reached*; running
 * out of context is a different event, and LM Studio has a separate native stop
 * reason for it (`contextLengthReached`) that the OpenAI-compatible layer does
 * not map to `length`. The string cannot see this failure. The arithmetic can.
 *
 * It is not a marginal test. Across `evidence/2026-08-04-mac-11` … `-mac-17`
 * this separates **70 complete responses (max 11,918 tokens)** from **10
 * failures (min 16,426)** against a 16,384-token window. There is no margin
 * constant on purpose: a 4,508-token gap holds no noise to tune against, and a
 * fudge factor would be a knob nobody could later justify.
 *
 * B16 states its outcome as the harm — content missing — and names this only as
 * the method, so if it is ever found blind the premise survives and this does
 * not. That separation is the whole lesson of B14.
 */
export function contextExhausted(
  promptTokens: number,
  completionTokens: number,
  contextTokens: number | null | undefined
): boolean | null {
  if (typeof contextTokens !== "number" || !Number.isFinite(contextTokens) || contextTokens <= 0) {
    return null;
  }
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) return null;
  return promptTokens + completionTokens >= contextTokens;
}

export type Category = "complete" | "elided" | "truncated";

export interface FileVerdict {
  path: string;
  returned: boolean;
  /** Only meaningful when returned=false: why the block is unusable. */
  absence: "unclosed_block" | "never_declared" | null;
  original_bytes: number;
  returned_bytes: number | null;
  original_lines: number;
  returned_lines: number | null;
  added_lines: number | null;
  removed_lines: number | null;
  longest_deleted_run: number | null;
  elision_markers: ElisionMarker[];
  /** The appended probe comment is the file's last non-empty line. */
  probe_applied: boolean | null;
  /** Byte-identical to disk — contract honoured, but the task ignored. */
  verbatim_echo: boolean | null;
  /**
   * The unified diff, present only when the model REPLACED or DROPPED something
   * (`removed_lines > 0`) rather than merely appending the probe. Honouring the
   * output contract and reproducing the file faithfully are different
   * properties: run 2026-08-04-mac-11 scored 12/12 `complete` while silently
   * rewriting 5 lines of `src/parse.ts`. A line count cannot say WHAT changed,
   * so the diff itself is kept — capped, because a whole-file rewrite would
   * otherwise put the file back in the artifact.
   */
  replacement_diff: string | null;
}

/**
 * Cap on `replacement_diff`. Sized to hold the largest real elision measured so
 * far — the 90 lines `src/tools/repair.ts` loses — without letting a whole-file
 * rewrite put the file back into the artifact.
 */
const MAX_DIFF_CHARS = 12000;

export interface Verdict {
  category: Category;
  /** Which rule fired, so a verdict is never a bare label. */
  reason: string;
  files: FileVerdict[];
  extras: string[];
}

/** What the classifier needs about each file it asked for. */
export interface ProbeTarget {
  bytes: number;
  content: string;
}

function lineCount(text: string): number {
  return text.split(/\r?\n/).length;
}

/**
 * Sort one response into exactly one category, priority-ordered so the more
 * severe rule wins: an incomplete response is `truncated` even when it also
 * carries an ellipsis, because the ellipsis may be merely the last thing we got
 * to see before the output stopped.
 */
export function classifyResponse(
  raw: string,
  finishReason: string | null,
  declared: ReadonlyMap<string, ProbeTarget>
): Verdict {
  const parsed = parseFileBlocks(raw, (p) => declared.has(normalizeRel(p)));
  const files: FileVerdict[] = [];
  const elisionReasons: string[] = [];
  const missing: string[] = [];

  for (const [rel, original] of declared) {
    const returned = parsed.files.get(rel);
    if (returned === undefined) {
      // An opening tag with no line-anchored close is a block that stopped
      // mid-file; no opening tag at all means the model never started it. Both
      // are unusable and both are retried, but only the first is evidence
      // about output length.
      const opened = new RegExp(
        `^<file\\s+path=["']\\.?/?${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*>`,
        "m"
      ).test(raw);
      missing.push(rel);
      files.push({
        path: rel,
        returned: false,
        absence: opened ? "unclosed_block" : "never_declared",
        original_bytes: original.bytes,
        returned_bytes: null,
        original_lines: lineCount(original.content),
        returned_lines: null,
        added_lines: null,
        removed_lines: null,
        longest_deleted_run: null,
        elision_markers: [],
        probe_applied: null,
        verbatim_echo: null,
        replacement_diff: null,
      });
      continue;
    }

    const markers = findElisionMarkers(original.content, returned);
    const diffText = unifiedFileDiff(rel, original.content, returned);
    const stats = diffText === "" ? { added: 0, removed: 0 } : diffStats(diffText);
    const run = diffText === "" ? 0 : longestDeletedRun(diffText);
    const tail = returned.split(/\r?\n/).filter((l) => l.trim() !== "").pop() ?? "";

    if (markers.length > 0) {
      const first = markers[0]!;
      elisionReasons.push(
        `${rel}: ${markers.length} novel elision marker(s), first at line ${first.line} (${JSON.stringify(first.text)})`
      );
    } else if (run >= SILENT_ELISION_MIN_RUN) {
      elisionReasons.push(
        `${rel}: no marker, but ${run} consecutive original lines are gone (${stats.removed} removed / ${stats.added} added)`
      );
    }

    files.push({
      path: rel,
      returned: true,
      absence: null,
      original_bytes: original.bytes,
      returned_bytes: Buffer.byteLength(returned, "utf8"),
      original_lines: lineCount(original.content),
      returned_lines: lineCount(returned),
      added_lines: stats.added,
      removed_lines: stats.removed,
      longest_deleted_run: run,
      elision_markers: markers,
      probe_applied: tail === PROBE_MARKER,
      verbatim_echo: returned === original.content || returned === `${original.content}\n`,
      replacement_diff:
        stats.removed === 0
          ? null
          : diffText.length > MAX_DIFF_CHARS
            ? `${diffText.slice(0, MAX_DIFF_CHARS)}\n… diff truncated at ${MAX_DIFF_CHARS} chars`
            : diffText,
    });
  }

  const extras = parsed.extras;

  // Priority 1: incompleteness the server or the parser can see.
  if (finishReason === "length") {
    return {
      category: "truncated",
      reason:
        "finish_reason=length — the model hit the output cap" +
        (missing.length > 0 ? `; missing ${missing.join(", ")}` : "; every block still parsed"),
      files,
      extras,
    };
  }
  if (missing.length > 0) {
    const unclosed = files.filter((f) => f.absence === "unclosed_block").map((f) => f.path);
    return {
      category: "truncated",
      reason:
        unclosed.length > 0
          ? `unclosed <file> block(s) for ${unclosed.join(", ")} — output stopped mid-file without finish_reason=length`
          : `${missing.length} declared file(s) never appeared: ${missing.join(", ")}`,
      files,
      extras,
    };
  }
  // Priority 2: complete envelope, incomplete contents.
  if (elisionReasons.length > 0) {
    return { category: "elided", reason: elisionReasons.join(" | "), files, extras };
  }
  return {
    category: "complete",
    reason: `all ${files.length} declared block(s) present and closed, no dropped content`,
    files,
    extras,
  };
}
