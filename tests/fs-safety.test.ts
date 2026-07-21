import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  atomicWriteFile,
  enforceContextCaps,
  readTextFileSafe,
  resolveSafePath,
  ToolError,
} from "../src/fs-safety.js";
import { runImplement } from "../src/tools/implement.js";
import { makeTempRoot, queuedFetch, testConfig, writeFileTree } from "./helpers.js";

async function expectToolError(
  promise: Promise<unknown>,
  code: string
): Promise<ToolError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe(code);
    return error as ToolError;
  }
  throw new Error(`expected ToolError ${code}, but nothing was thrown`);
}

describe("path safety", () => {
  it("rejects ../ escapes", async () => {
    const root = makeTempRoot();
    await expectToolError(
      resolveSafePath(root, "../outside.txt", { mustExist: false }),
      "path_escape"
    );
    await expectToolError(
      resolveSafePath(root, "src/../../outside.txt", { mustExist: false }),
      "path_escape"
    );
  });

  it("rejects absolute paths (posix and windows style)", async () => {
    const root = makeTempRoot();
    await expectToolError(
      resolveSafePath(root, "/etc/passwd", { mustExist: false }),
      "absolute_path"
    );
    await expectToolError(
      resolveSafePath(root, "C:\\Windows\\system32", { mustExist: false }),
      "absolute_path"
    );
  });

  it("rejects symlinks that resolve outside the root", async () => {
    const root = makeTempRoot();
    const outside = makeTempRoot("local-coder-outside-");
    await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    await expectToolError(
      resolveSafePath(root, "link.txt", { mustExist: true }),
      "symlink_escape"
    );
  });

  it("rejects symlinked directories that escape the root", async () => {
    const root = makeTempRoot();
    const outside = makeTempRoot("local-coder-outside-");
    await fs.symlink(outside, path.join(root, "sneaky"), "dir");
    await expectToolError(
      resolveSafePath(root, "sneaky/file.txt", { mustExist: false }),
      "symlink_escape"
    );
  });

  it("path traversal is rejected at the tool level with clear errors", async () => {
    const root = makeTempRoot();
    const { fetchImpl, calls } = queuedFetch([]);
    const error = await expectToolError(
      runImplement({ spec: "x", files: ["../../etc/passwd"] }, testConfig(root), { fetchImpl, platform: "linux" }),
      "path_escape"
    );
    expect(error.message).toContain("../../etc/passwd");
    expect(calls.length).toBe(0); // rejected before any model call
  });

  it("accepts normal nested paths and symlinks that stay inside the root", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "src/deep/file.ts": "ok\n" });
    await fs.symlink(path.join(root, "src/deep/file.ts"), path.join(root, "alias.ts"));
    const nested = await resolveSafePath(root, "src/deep/file.ts", { mustExist: true });
    expect(nested.rel).toBe("src/deep/file.ts");
    const alias = await resolveSafePath(root, "alias.ts", { mustExist: true });
    expect(alias.rel).toBe("alias.ts");
  });
});

describe("file content safety", () => {
  it("rejects binary files by null-byte sniff", async () => {
    const root = makeTempRoot();
    await fs.writeFile(path.join(root, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    const error = await expectToolError(readTextFileSafe(root, "blob.bin", 256), "binary_file");
    expect(error.message).toContain("blob.bin");
  });

  it("rejects oversized single files, naming file and size", async () => {
    const root = makeTempRoot();
    await fs.writeFile(path.join(root, "big.txt"), "x".repeat(2048));
    const error = await expectToolError(readTextFileSafe(root, "big.txt", 1), "file_too_large");
    expect(error.message).toContain("big.txt");
    expect(error.message).toContain("KB");
  });

  it("enforceContextCaps names every offending file at once", () => {
    const files = [
      { rel: "a.ts", bytes: 300 * 1024 },
      { rel: "b.ts", bytes: 10 * 1024 },
      { rel: "c.ts", bytes: 400 * 1024 },
    ];
    try {
      enforceContextCaps(files, 256, 512);
      throw new Error("expected throw");
    } catch (error) {
      expect((error as ToolError).code).toBe("file_too_large");
      expect((error as ToolError).message).toContain("a.ts");
      expect((error as ToolError).message).toContain("c.ts");
      expect((error as ToolError).message).not.toContain("b.ts");
    }
  });

  it("enforces the total context cap with the full file list", () => {
    const files = [
      { rel: "a.ts", bytes: 200 * 1024 },
      { rel: "b.ts", bytes: 200 * 1024 },
      { rel: "c.ts", bytes: 200 * 1024 },
    ];
    try {
      enforceContextCaps(files, 256, 512);
      throw new Error("expected throw");
    } catch (error) {
      const toolError = error as ToolError;
      expect(toolError.code).toBe("context_too_large");
      expect(toolError.message).toContain("a.ts");
      expect(toolError.message).toContain("b.ts");
      expect(toolError.message).toContain("c.ts");
      expect(toolError.details.total_kb).toBe(600);
    }
  });

  it("oversized context is refused at the tool level before any model call", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, {
      "big1.txt": "x".repeat(300 * 1024),
      "big2.txt": "y".repeat(300 * 1024),
    });
    const { fetchImpl, calls } = queuedFetch([]);
    const error = await expectToolError(
      runImplement(
        { spec: "x", files: ["big1.txt", "big2.txt"] },
        testConfig(root, { maxFileKb: 1024, maxContextKb: 512 }),
        { fetchImpl, platform: "linux" }
      ),
      "context_too_large"
    );
    expect(error.message).toContain("big1.txt");
    expect(error.message).toContain("big2.txt");
    expect(calls.length).toBe(0);
  });

  it("missing declared files are rejected with file_not_found", async () => {
    const root = makeTempRoot();
    const { fetchImpl } = queuedFetch([]);
    await expectToolError(
      runImplement({ spec: "x", files: ["nope.ts"] }, testConfig(root), { fetchImpl, platform: "linux" }),
      "file_not_found"
    );
  });
});

describe("atomic writes", () => {
  it("writes content and creates parent directories", async () => {
    const root = makeTempRoot();
    const target = path.join(root, "deep/nested/file.txt");
    await atomicWriteFile(target, "hello\n");
    expect(await fs.readFile(target, "utf8")).toBe("hello\n");
  });

  it("leaves no temp files behind", async () => {
    const root = makeTempRoot();
    const target = path.join(root, "file.txt");
    await atomicWriteFile(target, "one\n");
    await atomicWriteFile(target, "two\n");
    expect(await fs.readFile(target, "utf8")).toBe("two\n");
    const entries = await fs.readdir(root);
    expect(entries).toEqual(["file.txt"]);
  });

  it("cleans up the temp file when the final rename fails", async () => {
    const root = makeTempRoot();
    const target = path.join(root, "collision");
    await fs.mkdir(path.join(target, "occupied"), { recursive: true }); // rename onto a non-empty dir fails
    await expect(atomicWriteFile(target, "x\n")).rejects.toThrow();
    const entries = await fs.readdir(root);
    expect(entries).toEqual(["collision"]); // no orphaned .collision.*.tmp
  });
});
