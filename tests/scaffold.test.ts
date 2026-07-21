import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ToolError } from "../src/fs-safety.js";
import { runScaffold } from "../src/tools/scaffold.js";
import {
  chatBody,
  fileBlock,
  makeTempRoot,
  queuedFetch,
  testConfig,
  writeFileTree,
} from "./helpers.js";

describe("scaffold", () => {
  it("refuses when the target already exists, before any model call", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "existing.ts": "old\n" });
    const { fetchImpl, calls } = queuedFetch([]);

    await expect(
      runScaffold({ spec: "New module.", target_path: "existing.ts" }, testConfig(root), { fetchImpl })
    ).rejects.toMatchObject({ code: "target_exists" });
    expect(calls.length).toBe(0);
  });

  it("creates a single new file at the exact target path", async () => {
    const root = makeTempRoot();
    const content = "export const answer = 42;\n";
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/answer.ts", content))]);

    const result = await runScaffold(
      { spec: "A module exporting the answer.", target_path: "src/answer.ts" },
      testConfig(root),
      { fetchImpl }
    );

    expect(result.created).toEqual(["src/answer.ts"]);
    expect(await fs.readFile(path.join(root, "src/answer.ts"), "utf8")).toBe(content);
  });

  it("creates multiple files under a directory target and drops strays outside it", async () => {
    const root = makeTempRoot();
    const output = [
      fileBlock("src/widget/index.ts", "export * from './widget.js';\n"),
      fileBlock("src/widget/widget.ts", "export class Widget {}\n"),
      fileBlock("stray.ts", "nope\n"),
    ].join("\n");
    const { fetchImpl } = queuedFetch([chatBody(output)]);

    const result = await runScaffold(
      { spec: "A widget module.", target_path: "src/widget" },
      testConfig(root),
      { fetchImpl }
    );

    expect(result.created.sort()).toEqual(["src/widget/index.ts", "src/widget/widget.ts"]);
    await expect(fs.access(path.join(root, "stray.ts"))).rejects.toThrow();
  });

  it("retries once when the model misses the target path, then errors", async () => {
    const root = makeTempRoot();
    const { fetchImpl, calls } = queuedFetch([
      chatBody(fileBlock("wrong/place.ts", "x\n")),
      chatBody("still not the right format"),
    ]);

    try {
      await runScaffold(
        { spec: "New module.", target_path: "src/right.ts" },
        testConfig(root),
        { fetchImpl }
      );
      throw new Error("expected ToolError");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("model_output_malformed");
    }
    expect(calls.length).toBe(2);
    await expect(fs.access(path.join(root, "wrong/place.ts"))).rejects.toThrow();
  });

  it("rejects traversal in target_path", async () => {
    const root = makeTempRoot();
    const { fetchImpl } = queuedFetch([]);
    await expect(
      runScaffold({ spec: "x", target_path: "../outside.ts" }, testConfig(root), { fetchImpl })
    ).rejects.toMatchObject({ code: "path_escape" });
  });
});
