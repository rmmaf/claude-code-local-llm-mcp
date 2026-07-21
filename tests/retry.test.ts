import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ToolError } from "../src/fs-safety.js";
import { runImplement } from "../src/tools/implement.js";
import {
  chatBody,
  fileBlock,
  makeTempRoot,
  queuedFetch,
  testConfig,
  writeFileTree,
} from "./helpers.js";

const ORIGINAL = "line one\n";
const UPDATED = "line one updated\n";

describe("malformed-output retry policy", () => {
  it("retries exactly once with a corrective message, then succeeds", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "a.txt": ORIGINAL });
    const { fetchImpl, calls } = queuedFetch([
      chatBody("Sorry, here is a description of what I would change instead of the format."),
      chatBody(fileBlock("a.txt", UPDATED)),
    ]);

    const result = await runImplement(
      { spec: "Update the line.", files: ["a.txt"] },
      testConfig(root),
      { fetchImpl }
    );

    expect(calls.length).toBe(2);
    expect(result.files_changed).toEqual(["a.txt"]);

    // The corrective turn continues the conversation: malformed assistant
    // reply echoed back, followed by a user message quoting the format.
    const second = calls[1]?.body as { messages: Array<{ role: string; content: string }> };
    expect(second.messages.length).toBe(4);
    expect(second.messages[2]?.role).toBe("assistant");
    const corrective = second.messages[3];
    expect(corrective?.role).toBe("user");
    expect(corrective?.content).toContain('<file path="relative/path.ts">');
    expect(corrective?.content).toContain("a.txt");

    // usage is summed across both attempts
    expect(result.usage).toEqual({ prompt_tokens: 200, completion_tokens: 100 });
  });

  it("fails with a structured error naming missing files after the second bad attempt", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "a.txt": ORIGINAL, "b.txt": ORIGINAL });
    const { fetchImpl, calls } = queuedFetch([
      chatBody(fileBlock("a.txt", UPDATED)), // b.txt missing
      chatBody(fileBlock("a.txt", UPDATED)), // still missing
    ]);

    try {
      await runImplement(
        { spec: "Update both files.", files: ["a.txt", "b.txt"] },
        testConfig(root),
        { fetchImpl }
      );
      throw new Error("expected ToolError");
    } catch (error) {
      const toolError = error as ToolError;
      expect(toolError).toBeInstanceOf(ToolError);
      expect(toolError.code).toBe("model_output_malformed");
      expect(toolError.details.missing_files).toEqual(["b.txt"]);
      expect(toolError.message).toContain("b.txt");
    }
    expect(calls.length).toBe(2); // exactly one retry, never a third call
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe(ORIGINAL);
  });

  it("treats truncation (finish_reason=length) as malformed and retries", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "a.txt": ORIGINAL });
    const { fetchImpl, calls } = queuedFetch([
      chatBody('<file path="a.txt">\ntrunca', { finishReason: "length" }),
      chatBody(fileBlock("a.txt", UPDATED)),
    ]);

    const result = await runImplement(
      { spec: "Update the line.", files: ["a.txt"] },
      testConfig(root),
      { fetchImpl }
    );

    expect(calls.length).toBe(2);
    const corrective = (calls[1]?.body as { messages: Array<{ content: string }> }).messages[3];
    expect(corrective?.content).toContain("truncated");
    expect(result.files_changed).toEqual(["a.txt"]);
  });

  it("errors mention truncation when both attempts hit the length cap", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "a.txt": ORIGINAL });
    const { fetchImpl } = queuedFetch([
      chatBody("partial", { finishReason: "length" }),
      chatBody("partial again", { finishReason: "length" }),
    ]);

    await expect(
      runImplement({ spec: "Update.", files: ["a.txt"] }, testConfig(root), { fetchImpl })
    ).rejects.toMatchObject({
      code: "model_output_malformed",
      message: expect.stringContaining("truncated"),
    });
  });

  it("strips <think> blocks before parsing (no retry needed)", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "a.txt": ORIGINAL });
    const { fetchImpl, calls } = queuedFetch([
      chatBody(`<think>\nLet me plan this change carefully...\n</think>\n${fileBlock("a.txt", UPDATED)}`),
    ]);

    const result = await runImplement(
      { spec: "Update the line.", files: ["a.txt"] },
      testConfig(root),
      { fetchImpl }
    );

    expect(calls.length).toBe(1);
    expect(result.files_changed).toEqual(["a.txt"]);
  });
});
