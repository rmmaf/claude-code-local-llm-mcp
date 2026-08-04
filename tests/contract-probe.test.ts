import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyResponse,
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
