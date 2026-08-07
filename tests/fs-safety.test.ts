import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  atomicWriteFile,
  enforceContextCaps,
  enforceOutputCap,
  readTextFileSafe,
  resolveSafePath,
  ToolError,
} from "../src/fs-safety.js";
import { runImplement } from "../src/tools/implement.js";
import {
  chatBody,
  fileBlock,
  makeTempRoot,
  queuedFetch,
  testConfig,
  writeFileTree,
} from "./helpers.js";

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

  it("enforceOutputCap names every editable file and reports the estimate", () => {
    // 14,000 bytes at 10 bytes/token is 1,400 tokens against a 1,000 budget.
    const files = [
      { rel: "a.ts", bytes: 7_000 },
      { rel: "b.ts", bytes: 7_000 },
    ];
    try {
      enforceOutputCap(files, 1_000, 10, 1);
      throw new Error("expected throw");
    } catch (error) {
      const toolError = error as ToolError;
      expect(toolError.code).toBe("output_would_truncate");
      expect(toolError.message).toContain("a.ts");
      expect(toolError.message).toContain("b.ts");
      expect(toolError.details.estimated_output_tokens).toBe(1_400);
      expect(toolError.details.usable_output_tokens).toBe(1_000);
    }
  });

  it("enforceOutputCap passes exactly at the bar and refuses one token over", () => {
    // floor(1000 * 0.9) = 900 usable tokens = 9,000 bytes at 10 bytes/token.
    // The boundary is where a cap is either honest or off by one, and this one
    // decides whether a request runs at all.
    expect(() => enforceOutputCap([{ rel: "a.ts", bytes: 9_000 }], 1_000, 10, 0.9)).not.toThrow();
    expect(() => enforceOutputCap([{ rel: "a.ts", bytes: 9_010 }], 1_000, 10, 0.9)).toThrow();
  });

  /**
   * The context pre-flight, reproducing the request that motivated it:
   * `src/tools/repair.ts` (35,656 B) passed the output cap at 16384/0.9 and then
   * came back missing 90 lines, because input and output share one 16384-token
   * window. See `enforceOutputCap`'s doc comment and
   * `evidence/2026-08-04-mac-12-variance`.
   */
  it("refuses the request that the output cap alone let through", () => {
    const editable = [{ rel: "src/tools/repair.ts", bytes: 35_656 }];
    // The output cap says yes: 35656/3.5 = 10,187 <= floor(16384*0.9) = 14,745.
    expect(() => enforceOutputCap(editable, 16_384, 3.5, 0.9)).not.toThrow();

    try {
      enforceOutputCap(editable, 16_384, 3.5, 0.9, {
        contextTokens: 16_384,
        inputBytes: 35_656,
        inputBytesPerToken: 3.9,
      });
      throw new Error("expected throw");
    } catch (error) {
      const toolError = error as ToolError;
      expect(toolError.code).toBe("context_would_overflow");
      // ~9,143 in (35,656/3.9) + 200 overhead, plus ~10,187 out (at 3.5) =
      // ~19,530, over the 14,745 usable. Measured input for this file was 8,756
      // tokens, so the estimate is 4% conservative — the safe direction.
      expect(toolError.details.estimated_total_tokens).toBe(19_530);
      expect(toolError.details.usable_context_tokens).toBe(14_745);
      expect(toolError.details.input_bytes_per_token).toBe(3.9);
      // Raising the output cap is the one remedy that cannot work here.
      expect(toolError.message).toContain("SHARE that window");
      expect(toolError.message).toContain("cannot help");
    }
  });

  it("allows the largest request that DID fit the window", () => {
    // src/cost/report.ts, 23,063 B: measured 6,073 in + 5,845 out = 11,918
    // actual tokens, and it returned every block complete three times over.
    expect(() =>
      enforceOutputCap([{ rel: "src/cost/report.ts", bytes: 23_063 }], 16_384, 3.5, 0.9, {
        contextTokens: 16_384,
        inputBytes: 23_063,
        inputBytesPerToken: 3.9,
      })
    ).not.toThrow();
  });

  /**
   * The over-refusal that reusing ONE divisor for both sides caused, pinned so
   * it cannot come back. `src/fs-safety.ts` + `src/cost/transcript.ts` at
   * 26,345 B measured 11,237 actual tokens and had returned complete 3/3, yet
   * `run 2026-08-04-mac-16-preflight` refused it: at 3.5 the pessimism applies
   * twice over a shared window.
   *
   * The byte counts are FROZEN at that run's values, deliberately. Both files
   * have since grown and the live pair now sits ~55 tokens over the bar — that
   * residual is the OUTPUT divisor's deliberate 12% pessimism (3.5 against a
   * measured ~3.95), which `outputBytesPerToken` documents as bought coverage
   * and B16 is what re-derives. This test isolates the input-side effect only.
   */
  it("does not refuse a request that measurement says fits", () => {
    const editable = [
      { rel: "src/fs-safety.ts", bytes: 14_216 },
      { rel: "src/cost/transcript.ts", bytes: 12_129 },
    ];
    const window = { contextTokens: 16_384, inputBytes: 26_345 + 400 };
    // Reusing the output divisor on the input side refuses it...
    expect(() => enforceOutputCap(editable, 16_384, 3.5, 0.9, window)).toThrow(
      /SHARE that window/
    );
    // ...and the measured input divisor does not.
    expect(() =>
      enforceOutputCap(editable, 16_384, 3.5, 0.9, { ...window, inputBytesPerToken: 3.9 })
    ).not.toThrow();
  });

  it("counts context files and the spec as input, since they share the window", () => {
    const editable = [{ rel: "a.ts", bytes: 10_000 }];
    const out = Math.round(10_000 / 3.5); // 2,857 output tokens either way
    // Editable file alone: 2,857 in + 200 + 2,857 out = 5,914, well under 14,745.
    expect(() =>
      enforceOutputCap(editable, 16_384, 3.5, 0.9, { contextTokens: 16_384, inputBytes: 10_000 })
    ).not.toThrow();
    // Same one editable file, now with 35 KB of read-only context alongside it:
    // 12,857 + 200 + 2,857 = 15,914 over 14,745. The output cap cannot see this
    // at all, because context files are never echoed back.
    expect(Math.round(45_000 / 3.5) + 200 + out).toBeGreaterThan(14_745);
    expect(() =>
      enforceOutputCap(editable, 16_384, 3.5, 0.9, { contextTokens: 16_384, inputBytes: 45_000 })
    ).toThrow(/SHARE that window/);
  });

  /**
   * An unknown window must FAIL OPEN. The asymmetry is the point: skipping the
   * check risks one bad response, while a NaN budget makes every `<=` false and
   * refuses every generation in the process. The undefined case is not
   * hypothetical: it came from a `Config` literal in this tree, back when
   * `tsconfig.json` covered `src/**` only and nothing here was type-checked. That
   * route is closed. A `Config` still arrives from JSON at runtime unchecked.
   */
  it("skips the check rather than refusing when the window is unknown", () => {
    const editable = [{ rel: "a.ts", bytes: 35_656 }];
    for (const contextTokens of [null, undefined, 0, -1, NaN] as unknown[]) {
      expect(() =>
        enforceOutputCap(editable, 16_384, 3.5, 0.9, {
          contextTokens: contextTokens as number | null,
          inputBytes: 35_656,
        })
      ).not.toThrow();
    }
    // And with no window argument at all — the pre-existing call shape.
    expect(() => enforceOutputCap(editable, 16_384, 3.5, 0.9)).not.toThrow();
  });

  it("reports the output cap first when both ceilings are breached", () => {
    // Output alone is over an 8192 cap, and the pair is over the window too.
    try {
      enforceOutputCap([{ rel: "a.ts", bytes: 40_000 }], 8_192, 3.5, 0.9, {
        contextTokens: 16_384,
        inputBytes: 40_000,
      });
      throw new Error("expected throw");
    } catch (error) {
      expect((error as ToolError).code).toBe("output_would_truncate");
    }
  });

  it("refuses a whole-file answer that would not fit, before any model call", async () => {
    // 40 KB of editable source is ~11,700 tokens at the defaults, over the
    // ~7,372 usable of 8,192. Under the 256 KB input cap the whole time, so
    // this is the output contract refusing and nothing else.
    const root = makeTempRoot();
    await writeFileTree(root, { "wide.ts": "x".repeat(40 * 1024) });
    const { fetchImpl, calls } = queuedFetch([]);
    const error = await expectToolError(
      runImplement({ spec: "x", files: ["wide.ts"] }, testConfig(root), {
        fetchImpl,
        platform: "linux",
      }),
      "output_would_truncate"
    );
    expect(error.message).toContain("wide.ts");
    expect(calls.length).toBe(0);
  });

  /**
   * The wiring, not just the arithmetic: a request that clears the output cap
   * must still be refused before any model call when it cannot fit the window.
   * 20 KB at a 16,384 cap is ~5,850 output tokens against ~14,745 usable — the
   * output cap says yes — but ~5,850 in + 200 + ~5,850 out = ~11,900 needs more
   * than the 0.9 × 8,192 = 7,372 usable of an 8,192-token context.
   */
  it("refuses a request that clears the output cap but not the context window", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "wide.ts": "x".repeat(20 * 1024) });
    const { fetchImpl, calls } = queuedFetch([]);
    const error = await expectToolError(
      runImplement(
        { spec: "x", files: ["wide.ts"] },
        testConfig(root, { maxOutputTokens: 16_384 }),
        { fetchImpl, platform: "linux", contextTokens: 8_192 }
      ),
      "context_would_overflow"
    );
    expect(error.message).toContain("wide.ts");
    expect(error.message).toContain("SHARE that window");
    expect(calls.length).toBe(0);
  });

  it("sends that same request when the window is large enough", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "wide.ts": "x".repeat(20 * 1024) });
    // One <file> block echoing the file back, so the generation completes.
    const { fetchImpl, calls } = queuedFetch([
      chatBody(fileBlock("wide.ts", `${"x".repeat(20 * 1024)}\n`)),
    ]);
    await runImplement(
      { spec: "x", files: ["wide.ts"] },
      testConfig(root, { maxOutputTokens: 16_384 }),
      { fetchImpl, platform: "linux", contextTokens: 32_768 }
    );
    expect(calls.length).toBe(1);
  });

  /**
   * The window must belong to the model this request actually runs on. A model
   * loaded at 4,096 while the work goes to a different one is not evidence about
   * the second model's window, and treating it as such refuses valid work here —
   * the same mistake pointing the other way admits a request that overflows and
   * comes back as a closed, well-formed, shorter file.
   *
   * 20 KB clears the output cap at 16,384/0.9 and would NOT clear a 4,096-token
   * window, so if the borrowed number were still in play this would throw.
   */
  it("does not judge a request against an unrelated loaded model's window", async () => {
    const root = makeTempRoot();
    await writeFileTree(root, { "wide.ts": "x".repeat(20 * 1024) });
    const { fetchImpl, calls } = queuedFetch([
      chatBody(fileBlock("wide.ts", `${"x".repeat(20 * 1024)}\n`)),
    ]);
    await runImplement(
      { spec: "x", files: ["wide.ts"], model: "the-model-we-will-use" },
      testConfig(root, { maxOutputTokens: 16_384 }),
      {
        fetchImpl,
        platform: "linux",
        // `lms ps` reports a DIFFERENT model, loaded small.
        runner: async (command, args) =>
          command === "lms" && args[0] === "ps"
            ? JSON.stringify([{ modelKey: "someone-elses-model", contextLength: 4_096 }])
            : "",
      }
    );
    expect(calls).toHaveLength(1);
  });

  it("refuses the exact request that truncated in run 2026-08-03-mac-05", async () => {
    // The calibration this constant rests on, pinned so it cannot drift away
    // from the observation that justified it. src/selection.ts (15,454 B) plus
    // tests/selection.test.ts (15,632 B) is 31,086 B, ~8,882 tokens at 3.5 —
    // over the raw 8,192 cap before any headroom, which is why that session
    // truncated repeatedly. A divisor that stopped refusing this request would
    // have stopped agreeing with the only truncation ever observed.
    const root = makeTempRoot();
    await writeFileTree(root, {
      "src/selection.ts": "x".repeat(15_454),
      "tests/selection.test.ts": "y".repeat(15_632),
    });
    const { fetchImpl, calls } = queuedFetch([]);
    const error = await expectToolError(
      runImplement(
        { spec: "x", files: ["src/selection.ts", "tests/selection.test.ts"] },
        testConfig(root),
        { fetchImpl, platform: "linux" }
      ),
      "output_would_truncate"
    );
    expect(error.message).toContain("src/selection.ts");
    expect(error.message).toContain("tests/selection.test.ts");
    expect(calls.length).toBe(0);
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
