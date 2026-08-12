/**
 * Tests for a component that is NOT IN USE.
 *
 * G2 is closed (dead) and `hooks/filter-tool-output.mjs` is unregistered from
 * `.claude/settings.json`. Nothing in the product depends on any of this.
 *
 * They are kept only because `ROADMAP.md` pre-registers one retest of G2, and
 * they cover the condensing logic that retest would reuse. Read them as
 * dormant, not as coverage: **every one of them passed while B2 was false.**
 * They spawn the script directly and assert on what it returns, which is
 * precisely the boundary that turned out not to matter — Claude Code ignored
 * the return value. A green suite here says nothing about whether the hook
 * works, and it never did.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { readTelemetry } from "../src/telemetry.js";
import { makeTempRoot, removeTempRoot } from "./helpers.js";

const execFileAsync = promisify(execFile);
const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "filter-tool-output.mjs"
);

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    await removeTempRoot(root);
  }
});

function tempRoot(): string {
  const root = makeTempRoot("hook-filter-test-");
  roots.push(root);
  return root;
}

interface HookOutput {
  hookSpecificOutput?: { hookEventName?: string; updatedToolOutput?: string };
  suppressOutput?: boolean;
}

/** Drive the hook exactly as Claude Code does: JSON in on stdin, JSON out. */
async function runHook(input: unknown): Promise<HookOutput> {
  const child = execFileAsync(process.execPath, [HOOK], { maxBuffer: 32 * 1024 * 1024 });
  child.child.stdin?.end(JSON.stringify(input));
  const { stdout } = await child;
  return JSON.parse(stdout) as HookOutput;
}

function bashEvent(
  cwd: string,
  command: string,
  stdout: string,
  stderr = ""
): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    session_id: "s1",
    cwd,
    tool_name: "Bash",
    tool_use_id: "tu-1",
    tool_input: { command },
    tool_response: { stdout, stderr, interrupted: false, isImage: false },
  };
}

const noisyInstall = [
  "npm warn deprecated left-pad@1.0.0: use String.prototype.padStart",
  ...Array.from({ length: 400 }, (_, i) => `Downloading package-${i} (${i * 3} KB) 12.4 MB/s`),
  ...Array.from({ length: 200 }, () => "node_modules/.package-lock.json"),
  "added 144 packages in 16s",
].join("\n");

describe("filter-tool-output hook", () => {
  it("returns updatedToolOutput and spills the full text for noisy install output", async () => {
    const root = tempRoot();
    const result = await runHook(bashEvent(root, "npm install", noisyInstall));

    expect(result.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    const updated = result.hookSpecificOutput?.updatedToolOutput;
    expect(updated).toBeDefined();
    expect((updated as string).length).toBeLessThan(noisyInstall.length / 2);

    const match = /(\.local-coder\/spill\/[0-9a-f]{12}\.txt)/.exec(updated as string);
    expect(match).not.toBeNull();
    const spilled = await fs.readFile(path.join(root, match?.[1] as string), "utf8");
    expect(spilled).toBe(noisyInstall);
  });

  it("keeps error lines and stack frames verbatim", async () => {
    const root = tempRoot();
    const failing = [
      ...Array.from({ length: 300 }, (_, i) => `PASS  tests/unit-${i}.test.ts`),
      "FAIL  tests/auth.test.ts > rejects an expired token",
      "TypeError: Cannot read properties of undefined (reading 'exp')",
      "    at validateToken (src/auth/service.ts:142:18)",
      "    at Object.<anonymous> (tests/auth.test.ts:31:5)",
      ...Array.from({ length: 300 }, (_, i) => `PASS  tests/other-${i}.test.ts`),
    ].join("\n");

    const result = await runHook(bashEvent(root, "npx vitest run", failing));
    const updated = result.hookSpecificOutput?.updatedToolOutput ?? "";

    expect(updated).toContain("FAIL  tests/auth.test.ts > rejects an expired token");
    expect(updated).toContain("TypeError: Cannot read properties of undefined (reading 'exp')");
    expect(updated).toContain("at validateToken (src/auth/service.ts:142:18)");
  });

  it("leaves git diff output completely untouched — those bytes are edit anchors", async () => {
    const root = tempRoot();
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1234567..89abcde 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,4 +1,4 @@",
      ...Array.from({ length: 600 }, (_, i) => ` context line ${i}`),
      "-const old = 1;",
      "+const next = 2;",
    ].join("\n");

    await expect(runHook(bashEvent(root, "git diff HEAD", diff))).resolves.toEqual({});
    // Also bail on diff content even when the command does not look diff-like.
    await expect(runHook(bashEvent(root, "cat patch.txt", diff))).resolves.toEqual({});
  });

  it("does nothing to output below the size floor", async () => {
    const root = tempRoot();
    await expect(runHook(bashEvent(root, "npm install", "short\n".repeat(50)))).resolves.toEqual({});
  });

  it("does nothing when the gain would be marginal", async () => {
    const root = tempRoot();
    // Dense, all-signal output: over the byte floor, under the head/tail cap,
    // and nothing matches a suppression rule — so MIN_GAIN must veto.
    const dense = Array.from({ length: 150 }, (_, i) => `result row ${i}: value=${i * 7} status=nominal`).join("\n");
    expect(dense.length).toBeGreaterThan(2048);
    await expect(runHook(bashEvent(root, "node report.js", dense))).resolves.toEqual({});
  });

  it("still caps genuinely huge dense output, reversibly", async () => {
    const root = tempRoot();
    const huge = Array.from({ length: 900 }, (_, i) => `result row ${i}: value=${i * 7} status=nominal`).join("\n");
    const result = await runHook(bashEvent(root, "node report.js", huge));
    const updated = result.hookSpecificOutput?.updatedToolOutput ?? "";

    expect(updated).toContain("middle line(s) elided");
    expect(updated).toContain("result row 0:");
    expect(updated).toContain("result row 899:");
    const match = /(\.local-coder\/spill\/[0-9a-f]{12}\.txt)/.exec(updated);
    expect(await fs.readFile(path.join(root, match?.[1] as string), "utf8")).toBe(huge);
  });

  it("ignores interrupted commands and non-Bash tools", async () => {
    const root = tempRoot();
    const interrupted = {
      ...bashEvent(root, "npm install", noisyInstall),
      tool_response: { stdout: noisyInstall, stderr: "", interrupted: true, isImage: false },
    };
    await expect(runHook(interrupted)).resolves.toEqual({});

    const other = { ...bashEvent(root, "npm install", noisyInstall), tool_name: "Read" };
    await expect(runHook(other)).resolves.toEqual({});
  });

  it("collapses runs of identical lines with a count", async () => {
    const root = tempRoot();
    const repeated = [
      "starting build",
      ...Array.from({ length: 500 }, () => "warning: unused variable 'x'"),
      "build complete",
    ].join("\n");

    const updated =
      (await runHook(bashEvent(root, "make", repeated))).hookSpecificOutput?.updatedToolOutput ?? "";
    expect(updated).toContain("[x500]");
    expect(updated).toContain("build complete");
  });

  it("records telemetry the cost meter can read", async () => {
    const root = tempRoot();
    await runHook(bashEvent(root, "npm install --verbose", noisyInstall));

    const entries = await readTelemetry(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tool).toBe("hook:Bash");
    expect(entries[0]?.bytes_raw).toBe(noisyInstall.length);
    expect(entries[0]?.bytes_returned).toBeLessThan(entries[0]?.bytes_raw ?? 0);
    expect(entries[0]?.turns_collapsed).toBe(0);
  });

  it("fails open on malformed input rather than breaking the session", async () => {
    const child = execFileAsync(process.execPath, [HOOK]);
    child.child.stdin?.end("{not json");
    const { stdout } = await child;
    expect(JSON.parse(stdout)).toEqual({});

    const empty = execFileAsync(process.execPath, [HOOK]);
    empty.child.stdin?.end("");
    expect(JSON.parse((await empty).stdout)).toEqual({});
  });
});
