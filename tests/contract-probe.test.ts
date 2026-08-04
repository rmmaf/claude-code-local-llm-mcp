import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyResponse,
  contextExhausted,
  findElisionMarkers,
  longestDeletedRun,
  PROBE_MARKER,
  type ProbeTarget,
} from "../src/contract-probe.js";

const ORIGINAL = [
  "import path from 'node:path';",
  "",
  "export function alpha(n: number): number {",
  "  const doubled = n * 2;",
  "  const tripled = n * 3;",
  "  return doubled + tripled;",
  "}",
  "",
  "export function beta(xs: string[]): string {",
  "  return xs.join(path.sep);",
  "}",
  "",
].join("\n");

function target(content: string): ReadonlyMap<string, ProbeTarget> {
  return new Map([["src/sample.ts", { bytes: Buffer.byteLength(content, "utf8"), content }]]);
}

function block(content: string, rel = "src/sample.ts"): string {
  return `<file path="${rel}">\n${content}</file>\n`;
}

/** The response a compliant model returns: whole file, plus the appended line. */
const compliant = `${ORIGINAL}${PROBE_MARKER}\n`;

describe("classifyResponse", () => {
  it("scores a whole-file echo with the appended probe as complete", () => {
    const verdict = classifyResponse(block(compliant), "stop", target(ORIGINAL));
    expect(verdict.category).toBe("complete");
    expect(verdict.files[0]?.probe_applied).toBe(true);
    expect(verdict.files[0]?.removed_lines).toBe(0);
    expect(verdict.files[0]?.verbatim_echo).toBe(false);
  });

  it("scores a verbatim echo as complete but flags that the task was ignored", () => {
    const verdict = classifyResponse(block(ORIGINAL), "stop", target(ORIGINAL));
    expect(verdict.category).toBe("complete");
    expect(verdict.files[0]?.verbatim_echo).toBe(true);
    expect(verdict.files[0]?.probe_applied).toBe(false);
  });

  it("scores an ellipsis standing in for a body as elided", () => {
    const elided = [
      "import path from 'node:path';",
      "",
      "export function alpha(n: number): number {",
      "  // ...",
      "}",
      "",
      "export function beta(xs: string[]): string {",
      "  return xs.join(path.sep);",
      "}",
      PROBE_MARKER,
      "",
    ].join("\n");
    const verdict = classifyResponse(block(elided), "stop", target(ORIGINAL));
    expect(verdict.category).toBe("elided");
    expect(verdict.files[0]?.elision_markers[0]?.tier).toBe("ellipsis");
  });

  it("scores a 'rest of the file unchanged' comment as elided", () => {
    const elided = [
      "import path from 'node:path';",
      "",
      "// ... rest of the file unchanged ...",
      PROBE_MARKER,
      "",
    ].join("\n");
    const verdict = classifyResponse(block(elided), "stop", target(ORIGINAL));
    expect(verdict.category).toBe("elided");
    expect(verdict.files[0]?.elision_markers.length).toBeGreaterThan(0);
  });

  it("scores a SILENT drop — content gone with no marker at all — as elided", () => {
    const dropped = [
      "import path from 'node:path';",
      "",
      "export function beta(xs: string[]): string {",
      "  return xs.join(path.sep);",
      "}",
      "",
      PROBE_MARKER,
      "",
    ].join("\n");
    const verdict = classifyResponse(block(dropped), "stop", target(ORIGINAL));
    expect(verdict.category).toBe("elided");
    expect(verdict.files[0]?.elision_markers).toEqual([]);
    expect(verdict.files[0]?.longest_deleted_run).toBeGreaterThanOrEqual(3);
  });

  it("does not call a one-line reflow an elision", () => {
    // One line rewritten: removed 1, added 1. Below SILENT_ELISION_MIN_RUN.
    const reflowed = `${ORIGINAL.replace(
      "  return xs.join(path.sep);",
      "  return xs.join(path.sep) as string;"
    )}${PROBE_MARKER}\n`;
    const verdict = classifyResponse(block(reflowed), "stop", target(ORIGINAL));
    expect(verdict.category).toBe("complete");
    expect(verdict.files[0]?.longest_deleted_run).toBe(1);
  });

  /**
   * "Complete" and "faithful" are different properties, and the artifact has to
   * be able to tell them apart: run 2026-08-04-mac-11 scored 12/12 complete
   * while rewriting 5 lines of src/parse.ts. A pure append carries no diff (that
   * is just the probe); a replacement carries the hunks that prove it.
   */
  it("records a diff only when the model replaced content, not for a pure append", () => {
    const appended = classifyResponse(block(compliant), "stop", target(ORIGINAL));
    expect(appended.files[0]?.removed_lines).toBe(0);
    expect(appended.files[0]?.replacement_diff).toBeNull();

    const rewritten = `${ORIGINAL.replace("  const doubled = n * 2;", "  const doubled = n + n;")}${PROBE_MARKER}\n`;
    const verdict = classifyResponse(block(rewritten), "stop", target(ORIGINAL));
    expect(verdict.category).toBe("complete");
    expect(verdict.files[0]?.replacement_diff).toContain("-  const doubled = n * 2;");
    expect(verdict.files[0]?.replacement_diff).toContain("+  const doubled = n + n;");
  });

  it("reports finish_reason=length as truncated even when every block parsed", () => {
    const verdict = classifyResponse(block(compliant), "length", target(ORIGINAL));
    expect(verdict.category).toBe("truncated");
    expect(verdict.reason).toContain("finish_reason=length");
  });

  it("reports an unclosed block as truncated, distinguishing it from a missing one", () => {
    const raw = `<file path="src/sample.ts">\n${ORIGINAL.slice(0, 60)}`;
    const verdict = classifyResponse(raw, "stop", target(ORIGINAL));
    expect(verdict.category).toBe("truncated");
    expect(verdict.files[0]?.absence).toBe("unclosed_block");
    expect(verdict.reason).toContain("unclosed");
  });

  it("reports a file the model never started as never_declared", () => {
    const verdict = classifyResponse("I will not do that.", "stop", target(ORIGINAL));
    expect(verdict.category).toBe("truncated");
    expect(verdict.files[0]?.absence).toBe("never_declared");
  });

  it("counts a multi-file response missing its second block as truncated", () => {
    const other = "export const x = 1;\n";
    const declared = new Map<string, ProbeTarget>([
      ["src/sample.ts", { bytes: Buffer.byteLength(ORIGINAL, "utf8"), content: ORIGINAL }],
      ["src/other.ts", { bytes: Buffer.byteLength(other, "utf8"), content: other }],
    ]);
    const verdict = classifyResponse(block(compliant), "stop", declared);
    expect(verdict.category).toBe("truncated");
    expect(verdict.reason).toContain("src/other.ts");
    expect(verdict.files.filter((f) => f.returned)).toHaveLength(1);
  });
});

describe("elision-marker false positives", () => {
  /**
   * The trap this diagnostic would most plausibly fall into. src/parse.ts ships
   * the literal `...entire final file content...` inside FILE_BLOCK_FORMAT, so a
   * PERFECT echo of that real file contains an ellipsis line. Scoring it as an
   * elision would report a compliant model as non-compliant, on the one file in
   * the ladder most likely to be affected.
   */
  it("does not flag a faithful echo of this repo's own src/parse.ts", () => {
    const parseSrc = readFileSync(path.resolve(__dirname, "../src/parse.ts"), "utf8");
    expect(parseSrc).toContain("...entire final file content...");
    expect(findElisionMarkers(parseSrc, parseSrc)).toEqual([]);

    const verdict = classifyResponse(
      block(`${parseSrc}${PROBE_MARKER}\n`, "src/parse.ts"),
      "stop",
      new Map([
        ["src/parse.ts", { bytes: Buffer.byteLength(parseSrc, "utf8"), content: parseSrc }],
      ])
    );
    expect(verdict.category).toBe("complete");
  });

  /**
   * Same shape, different file: src/tools/shared.ts genuinely instructs the
   * model to return "files you leave unchanged", and src/llm-client.ts talks
   * about timeouts. Echoing either must not trip the phrase tier.
   */
  it("does not flag faithful echoes of files whose prose mentions unchanged files", () => {
    for (const rel of ["src/tools/shared.ts", "src/llm-client.ts"]) {
      const src = readFileSync(path.resolve(__dirname, "..", rel), "utf8");
      expect(findElisionMarkers(src, src)).toEqual([]);
    }
  });

  it("does not flag TypeScript spread or rest syntax", () => {
    const spread = [
      "const merged = { ...base, ...override };",
      "function f(...args: number[]): void {}",
      "const [first, ...rest] = xs;",
      "type T = { ...never };",
    ].join("\n");
    expect(findElisionMarkers("", spread)).toEqual([]);
  });

  it("still flags an ellipsis line that the original did not contain", () => {
    const markers = findElisionMarkers("const a = 1;\n", "const a = 1;\n...\n");
    expect(markers).toHaveLength(1);
    expect(markers[0]?.tier).toBe("ellipsis");
  });
});

describe("contextExhausted", () => {
  it("fires when prompt and completion together reach the window", () => {
    // The measured case: src/tools/repair.ts, 8,756 prompt + 7,670 completion
    // against a model loaded at 16,384. It came back properly closed, with
    // finish_reason "stop", missing 90 lines.
    expect(contextExhausted(8_756, 7_670, 16_384)).toBe(true);
    // The largest request that DID return every block complete, three times.
    expect(contextExhausted(6_073, 5_845, 16_384)).toBe(false);
  });

  it("treats exactly filling the window as exhausted", () => {
    expect(contextExhausted(8_192, 8_192, 16_384)).toBe(true);
    expect(contextExhausted(8_192, 8_191, 16_384)).toBe(false);
  });

  /**
   * An unknown window must answer "cannot tell", not "fine" and not "broken" —
   * the same rule `pickLoadedContextTokens` follows. A guess here would label a
   * healthy response a failure, which is the direction that corrupts the count.
   */
  it("returns null whenever the window is not knowable", () => {
    for (const window of [null, undefined, 0, -1, NaN, Infinity] as unknown[]) {
      expect(contextExhausted(8_756, 7_670, window as number | null)).toBeNull();
    }
  });

  /**
   * The case that actually happens. `chatCompletion` zero-fills a response whose
   * body carries no `usage` — an older server, a proxy, a version skew — so
   * "unknown" would arrive here as 0 and read as `0 + 0 < window`, i.e. "fits".
   * That is a false negative on every request at once, and it would let B16
   * appear to hold on no token data at all. `null` has to survive this far.
   */
  it("returns null when a usage figure is unknown rather than counting it as zero", () => {
    expect(contextExhausted(null, null, 16_384)).toBeNull();
    expect(contextExhausted(null, 7_670, 16_384)).toBeNull();
    expect(contextExhausted(8_756, undefined, 16_384)).toBeNull();
    expect(contextExhausted(NaN, 7_670, 16_384)).toBeNull();
    // A genuine zero is still a measurement, and it fits.
    expect(contextExhausted(0, 0, 16_384)).toBe(false);
    // Negative counts are not measurements at all.
    expect(contextExhausted(-1, 7_670, 16_384)).toBeNull();
  });
});

/**
 * The evidentiary basis for B16, replayed through the SHIPPED rule rather than
 * through the throwaway script that first computed it. If this ever stops
 * separating cleanly, B16's method is what failed — and the premise says so
 * explicitly, which is the whole reason the outcome is stated as the harm and
 * the detector only as the method.
 *
 * The six files are named rather than globbed on purpose: a new artifact is a
 * new run that should be SCORED, not silently absorbed into a regression test.
 */
describe("contextExhausted over the recorded runs", () => {
  const RUNS = [
    "2026-08-04-mac-11",
    "2026-08-04-mac-12-variance",
    "2026-08-04-mac-13-repair-diff",
    "2026-08-04-mac-14-repair-diff",
    "2026-08-04-mac-16-preflight",
    "2026-08-04-mac-17-preflight",
  ];

  it("flags every failure and no success, with a wide margin", () => {
    const complete: number[] = [];
    const failed: number[] = [];
    for (const run of RUNS) {
      const artifact = JSON.parse(
        readFileSync(path.resolve(__dirname, "../evidence", `${run}.contract-stability.json`), "utf8")
      ) as {
        rows: Array<{
          first: { category: string; prompt_tokens: number; completion_tokens: number } | null;
          retry: { category: string; prompt_tokens: number; completion_tokens: number } | null;
        }>;
      };
      for (const row of artifact.rows) {
        for (const attempt of [row.first, row.retry]) {
          if (attempt === null) continue;
          const total = attempt.prompt_tokens + attempt.completion_tokens;
          (attempt.category === "complete" ? complete : failed).push(total);
          // 16,384 is the window every one of these runs recorded.
          expect(contextExhausted(attempt.prompt_tokens, attempt.completion_tokens, 16_384)).toBe(
            attempt.category !== "complete"
          );
        }
      }
    }
    expect(complete).toHaveLength(70);
    expect(failed).toHaveLength(10);
    // The separation is why no margin constant exists: there is no noise here
    // to tune against, and a fudge factor would be a knob nobody could justify.
    expect(Math.min(...failed) - Math.max(...complete)).toBeGreaterThan(4_000);
  });
});

describe("longestDeletedRun", () => {
  it("returns the longest consecutive run, not the total", () => {
    const diffText = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,8 +1,4 @@",
      " keep",
      "-gone1",
      "-gone2",
      " keep",
      "-alone",
      " keep",
      "-run1",
      "-run2",
      "-run3",
      " keep",
    ].join("\n");
    expect(longestDeletedRun(diffText)).toBe(3);
  });

  it("does not count the --- file header as a deletion", () => {
    const diffText = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", " keep"].join("\n");
    expect(longestDeletedRun(diffText)).toBe(0);
  });

  it("returns 0 for an empty diff", () => {
    expect(longestDeletedRun("")).toBe(0);
  });
});
