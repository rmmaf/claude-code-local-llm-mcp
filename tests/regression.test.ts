/**
 * Regression tests for defects found in the pre-ship adversarial review:
 *  - literal </file> or <think> inside file content must survive parsing
 *  - files without a trailing newline (and empty files) must round-trip as
 *    "unchanged" instead of producing phantom diffs/writes
 *  - diffStats must not misclassify content lines starting with -- or ++
 *  - scaffold must collapse duplicate path spellings instead of erroring
 *    after a partial write
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { diffStats, unifiedFileDiff } from "../src/diff.js";
import { parseFileBlocks } from "../src/parse.js";
import { runImplement } from "../src/tools/implement.js";
import { runScaffold } from "../src/tools/scaffold.js";
import {
  chatBody,
  fileBlock,
  makeTempRoot,
  queuedFetch,
  testConfig,
  writeFileTree,
} from "./helpers.js";

const execFileAsync = promisify(execFile);

describe("parser robustness against tag literals in content", () => {
  it("preserves a literal </file> inside content when the block is properly closed", () => {
    const content = 'const FORMAT = "...</file> ends the block";\nconst more = 1;\n';
    const parsed = parseFileBlocks(`<file path="a.ts">\n${content}</file>`, () => true);
    expect(parsed.files.get("a.ts")).toBe(content);
  });

  it("preserves literal <think>...</think> lines inside content", () => {
    const content = 'it("strips think", () => {\n  strip("<think>a</think>");\n});\n';
    const parsed = parseFileBlocks(`<file path="a.ts">\n${content}</file>`, () => true);
    expect(parsed.files.get("a.ts")).toBe(content);
  });

  it("drops an unclosed block (truncation) so the retry path fires", () => {
    const parsed = parseFileBlocks('<file path="a.ts">\nno closing tag here', () => true);
    expect(parsed.files.size).toBe(0);
  });

  it("collapses duplicate spellings of the same path to one normalized entry", () => {
    const raw = '<file path="a.ts">\nfirst\n</file>\n<file path="./a.ts">\nsecond\n</file>';
    const parsed = parseFileBlocks(raw, () => true);
    expect([...parsed.files.keys()]).toEqual(["a.ts"]);
    expect(parsed.files.get("a.ts")).toBe("second\n");
  });

  it("ignores reasoning between blocks without corrupting either block", () => {
    const raw =
      '<file path="a.ts">\nconst a = 1;\n</file>\nNow I will update b.\n<file path="b.ts">\nconst b = 2;\n</file>';
    const parsed = parseFileBlocks(raw, () => true);
    expect(parsed.files.get("a.ts")).toBe("const a = 1;\n");
    expect(parsed.files.get("b.ts")).toBe("const b = 2;\n");
  });
});

describe("trailing-newline and empty-file round-trips", () => {
  it("a no-trailing-newline file echoed back unchanged produces no diff and no write", async () => {
    const root = makeTempRoot();
    await fs.writeFile(path.join(root, "a.txt"), "const a = 1;"); // no trailing newline
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("a.txt", "const a = 1;\n"))]);

    const result = await runImplement(
      { spec: "No change needed.", files: ["a.txt"], mode: "apply" },
      testConfig(root),
      { fetchImpl, platform: "linux" }
    );

    expect(result.files_changed).toEqual([]);
    expect(result.diff).toBe("");
    expect(result.applied).toBe(false);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("const a = 1;");
  });

  it("an empty file echoed back unchanged produces no diff", async () => {
    const root = makeTempRoot();
    await fs.writeFile(path.join(root, "empty.txt"), "");
    const { fetchImpl } = queuedFetch([chatBody('<file path="empty.txt">\n</file>')]);

    const result = await runImplement(
      { spec: "No change needed.", files: ["empty.txt"] },
      testConfig(root),
      { fetchImpl, platform: "linux" }
    );

    expect(result.files_changed).toEqual([]);
    expect(result.diff).toBe("");
  });

  it("real edits to a file containing a literal </file> produce a git-appliable diff", async () => {
    const root = makeTempRoot();
    const original = 'const FORMAT = "</file>";\nexport const OLD = true;\n';
    const updated = 'const FORMAT = "</file>";\nexport const OLD = false;\n';
    await writeFileTree(root, { "fmt.ts": original });
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("fmt.ts", updated))]);

    const result = await runImplement(
      { spec: "Flip OLD to false.", files: ["fmt.ts"] },
      testConfig(root),
      { fetchImpl, platform: "linux" }
    );

    expect(result.files_changed).toEqual(["fmt.ts"]);
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await fs.writeFile(path.join(root, "r.patch"), result.diff);
    await execFileAsync("git", ["apply", "r.patch"], { cwd: root });
    expect(await fs.readFile(path.join(root, "fmt.ts"), "utf8")).toBe(updated);
  });
});

describe("diffStats counts content lines that resemble headers", () => {
  it("counts removed lines starting with -- and added lines starting with ++", () => {
    const removal = unifiedFileDiff("q.sql", "-- comment\nSELECT 1;\n", "SELECT 1;\n");
    expect(diffStats(removal)).toEqual({ added: 0, removed: 1 });

    const addition = unifiedFileDiff("i.c", "i;\n", "i;\n++i;\n");
    expect(diffStats(addition)).toEqual({ added: 1, removed: 0 });
  });

  it("still excludes the header lines themselves", () => {
    const diff = unifiedFileDiff("a.txt", "one\n", "two\n");
    expect(diffStats(diff)).toEqual({ added: 1, removed: 1 });
  });
});

describe("scaffold duplicate-spelling handling", () => {
  it("writes one file when the model emits the same path in two spellings", async () => {
    const root = makeTempRoot();
    const output = [
      fileBlock("newmod/a.ts", "export const first = 1;\n"),
      fileBlock("./newmod/a.ts", "export const second = 2;\n"),
    ].join("\n");
    const { fetchImpl } = queuedFetch([chatBody(output)]);

    const result = await runScaffold(
      { spec: "A module.", target_path: "newmod" },
      testConfig(root),
      { fetchImpl, platform: "linux" }
    );

    expect(result.created).toEqual(["newmod/a.ts"]);
    expect(await fs.readFile(path.join(root, "newmod/a.ts"), "utf8")).toBe(
      "export const second = 2;\n"
    );
  });
});
