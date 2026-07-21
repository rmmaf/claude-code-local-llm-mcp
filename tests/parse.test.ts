import { describe, expect, it } from "vitest";

import { parseFileBlocks, stripOuterCodeFence, stripThinkBlocks } from "../src/parse.js";

describe("stripThinkBlocks", () => {
  it("removes closed think blocks", () => {
    const input = "<think>\nLet me reason...\n</think>\n<file path=\"a.ts\">\nx\n</file>";
    expect(stripThinkBlocks(input)).toBe('\n<file path="a.ts">\nx\n</file>');
  });

  it("removes multiple think blocks", () => {
    expect(stripThinkBlocks("<think>a</think>keep<think>b</think>also")).toBe("keepalso");
  });

  it("truncates from an unclosed think block to the end", () => {
    expect(stripThinkBlocks("before<think>never closed because truncated")).toBe("before");
  });
});

describe("stripOuterCodeFence", () => {
  it("removes a fence wrapping the whole output", () => {
    const inner = '<file path="a.ts">\ncode\n</file>';
    expect(stripOuterCodeFence("```\n" + inner + "\n```")).toBe(inner);
    expect(stripOuterCodeFence("```typescript\n" + inner + "\n```")).toBe(inner);
  });

  it("keeps fences that are inside content", () => {
    const text = '<file path="a.md">\n```js\ncode\n```\n</file>';
    expect(stripOuterCodeFence(text)).toBe(text);
  });
});

describe("parseFileBlocks", () => {
  it("parses multiple blocks and keeps content verbatim", () => {
    const raw = '<file path="a.ts">\nconst a = 1;\n</file>\n<file path="b.ts">\nconst b = 2;\n</file>';
    const parsed = parseFileBlocks(raw, () => true);
    expect(parsed.files.get("a.ts")).toBe("const a = 1;\n");
    expect(parsed.files.get("b.ts")).toBe("const b = 2;\n");
    expect(parsed.extras).toEqual([]);
  });

  it("collects rejected paths as extras", () => {
    const raw = '<file path="ok.ts">\nx\n</file>\n<file path="bad.ts">\ny\n</file>';
    const parsed = parseFileBlocks(raw, (p) => p === "ok.ts");
    expect([...parsed.files.keys()]).toEqual(["ok.ts"]);
    expect(parsed.extras).toEqual(["bad.ts"]);
  });

  it("accepts single-quoted paths and keeps the last duplicate block", () => {
    const raw = "<file path='a.ts'>\nfirst\n</file>\n<file path='a.ts'>\nsecond\n</file>";
    const parsed = parseFileBlocks(raw, () => true);
    expect(parsed.files.get("a.ts")).toBe("second\n");
  });

  it("handles think blocks and an outer fence around real output", () => {
    const raw = '<think>plan plan</think>\n```\n<file path="a.ts">\nreal\n</file>\n```';
    const parsed = parseFileBlocks(raw, () => true);
    expect(parsed.files.get("a.ts")).toBe("real\n");
  });

  it("preserves markdown fences inside file content", () => {
    const raw = '<file path="doc.md">\n# Title\n\n```js\ncode();\n```\n</file>';
    const parsed = parseFileBlocks(raw, () => true);
    expect(parsed.files.get("doc.md")).toBe("# Title\n\n```js\ncode();\n```\n");
  });

  it("returns empty on prose-only output", () => {
    const parsed = parseFileBlocks("Sure! Here is what I would do: ...", () => true);
    expect(parsed.files.size).toBe(0);
  });
});
