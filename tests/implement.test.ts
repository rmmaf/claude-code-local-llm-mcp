import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { runImplement } from "../src/tools/implement.js";
import {
  chatBody,
  fileBlock,
  lmsListBody,
  makeTempRoot,
  noLmsRunner,
  queuedFetch,
  testConfig,
  fakeRunner,
  writeFileTree,
} from "./helpers.js";

const execFileAsync = promisify(execFile);

const ORIGINAL = `export function greet(name: string): string {\n  return "Hello " + name;\n}\n`;
const UPDATED = `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`;

const README = `# demo\n\nA demo project.\n`;
const README_UPDATED = `# demo\n\nA demo project with greetings.\n`;

async function gitApply(root: string, diff: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  const patchPath = path.join(root, ".local-coder-test.patch");
  await fs.writeFile(patchPath, diff, "utf8");
  await execFileAsync("git", ["apply", "--check", ".local-coder-test.patch"], { cwd: root });
  await execFileAsync("git", ["apply", ".local-coder-test.patch"], { cwd: root });
  await fs.rm(patchPath);
}

describe("implement", () => {
  it("diff mode returns a git-apply-compatible unified diff and leaves disk untouched", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "src/greet.ts": ORIGINAL });
    const { fetchImpl, calls } = queuedFetch([chatBody(fileBlock("src/greet.ts", UPDATED))]);

    const result = await runImplement(
      { spec: "Use a template literal and add punctuation.", files: ["src/greet.ts"] },
      testConfig(root),
      { fetchImpl, platform: "linux", runner: noLmsRunner() }
    );

    expect(result.applied).toBe(false);
    expect(result.files_changed).toEqual(["src/greet.ts"]);
    expect(result.diff).toContain("diff --git a/src/greet.ts b/src/greet.ts");
    expect(result.diff).toContain("--- a/src/greet.ts");
    expect(result.diff).toContain("+++ b/src/greet.ts");
    expect(result.model).toBe("test-solo-model");
    expect(result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50 });
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.summary.split(/\s+/).length).toBeLessThanOrEqual(120);

    // Review gate: disk untouched in diff mode.
    expect(await fs.readFile(path.join(root, "src/greet.ts"), "utf8")).toBe(ORIGINAL);

    // The diff must actually apply with git.
    await gitApply(root, result.diff);
    expect(await fs.readFile(path.join(root, "src/greet.ts"), "utf8")).toBe(UPDATED);

    // The prompt carried the file content and spec; no sizes -> first catalog model.
    const request = calls[0]?.body as { model: string; messages: Array<{ content: string }> };
    expect(request.model).toBe("test-solo-model");
    expect(request.messages.some((m) => m.content.includes('Hello " + name'))).toBe(true);
  });

  it("multi-file diffs apply together; unchanged declared files are excluded", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, {
      "src/greet.ts": ORIGINAL,
      "README.md": README,
      "unchanged.txt": "same\n",
    });
    const output = [
      fileBlock("src/greet.ts", UPDATED),
      fileBlock("README.md", README_UPDATED),
      fileBlock("unchanged.txt", "same\n"),
    ].join("\n");
    const { fetchImpl } = queuedFetch([chatBody(output)]);

    const result = await runImplement(
      {
        spec: "Update greeting and README.",
        files: ["src/greet.ts", "README.md", "unchanged.txt"],
      },
      testConfig(root),
      { fetchImpl, platform: "linux", runner: noLmsRunner() }
    );

    expect(result.files_changed).toEqual(["src/greet.ts", "README.md"]);
    await gitApply(root, result.diff);
    expect(await fs.readFile(path.join(root, "src/greet.ts"), "utf8")).toBe(UPDATED);
    expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(README_UPDATED);
    expect(await fs.readFile(path.join(root, "unchanged.txt"), "utf8")).toBe("same\n");
  });

  it("apply mode writes changes to disk and reports applied: true", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "src/greet.ts": ORIGINAL });
    const { fetchImpl } = queuedFetch([chatBody(fileBlock("src/greet.ts", UPDATED))]);

    const result = await runImplement(
      { spec: "Use a template literal.", files: ["src/greet.ts"], mode: "apply" },
      testConfig(root),
      { fetchImpl, platform: "linux", runner: noLmsRunner() }
    );

    expect(result.applied).toBe(true);
    expect(await fs.readFile(path.join(root, "src/greet.ts"), "utf8")).toBe(UPDATED);
  });

  it("undeclared files in model output are dropped, never written", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "src/greet.ts": ORIGINAL });
    const output = [
      fileBlock("src/greet.ts", UPDATED),
      fileBlock("src/evil.ts", "export const pwned = true;\n"),
    ].join("\n");
    const { fetchImpl } = queuedFetch([chatBody(output)]);

    const result = await runImplement(
      { spec: "Change greeting.", files: ["src/greet.ts"], mode: "apply" },
      testConfig(root),
      { fetchImpl, platform: "linux", runner: noLmsRunner() }
    );

    expect(result.files_changed).toEqual(["src/greet.ts"]);
    await expect(fs.access(path.join(root, "src/evil.ts"))).rejects.toThrow();
  });

  it("context files are sent read-only and never modified", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, {
      "src/greet.ts": ORIGINAL,
      "src/types.ts": "export type Name = string;\n",
    });
    const { fetchImpl, calls } = queuedFetch([chatBody(fileBlock("src/greet.ts", UPDATED))]);

    await runImplement(
      {
        spec: "Change greeting.",
        files: ["src/greet.ts"],
        context_files: ["src/types.ts"],
        mode: "apply",
      },
      testConfig(root),
      { fetchImpl, platform: "linux", runner: noLmsRunner() }
    );

    const request = calls[0]?.body as { messages: Array<{ content: string }> };
    expect(request.messages.some((m) => m.content.includes('<context path="src/types.ts">'))).toBe(true);
    expect(await fs.readFile(path.join(root, "src/types.ts"), "utf8")).toBe("export type Name = string;\n");
  });

  it("sends an explicit model verbatim without probing", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "src/greet.ts": ORIGINAL });
    const { fetchImpl, calls } = queuedFetch([chatBody(fileBlock("src/greet.ts", UPDATED))]);

    const result = await runImplement(
      { spec: "Change greeting.", files: ["src/greet.ts"], model: "test-ide-model" },
      testConfig(root),
      { fetchImpl, platform: "linux", runner: noLmsRunner() }
    );

    expect(result.model).toBe("test-ide-model");
    expect(result.selection_reason).toContain("explicit model requested");
    expect((calls[0]?.body as { model: string }).model).toBe("test-ide-model");
  });

  it("auto-picks the largest catalog model that fits free RAM when model is omitted", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "src/greet.ts": ORIGINAL });
    const { fetchImpl, calls } = queuedFetch([chatBody(fileBlock("src/greet.ts", UPDATED))]);
    const GB = 1024 ** 3;
    const runner = fakeRunner({
      sysctl: () => `${32 * GB}\n`,
      memory_pressure: () => "System-wide memory free percentage: 50%\n", // ~16 GB free, ~13.6 usable
      lms: () =>
        lmsListBody([
          { id: "test-solo-model", sizeBytes: 18 * GB },
          { id: "test-ide-model", sizeBytes: 8 * GB },
        ]),
    });

    const result = await runImplement(
      { spec: "Change greeting.", files: ["src/greet.ts"] },
      testConfig(root),
      { fetchImpl, platform: "darwin", runner }
    );

    // 18 GB doesn't fit ~13.6 usable; 8 GB does.
    expect(result.model).toBe("test-ide-model");
    expect(result.selection_reason).toContain("fitting usable free RAM");
    expect((calls[0]?.body as { model: string }).model).toBe("test-ide-model");
  });
});
